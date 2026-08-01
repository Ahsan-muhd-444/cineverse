/**
 * Transport-ceiling safety: the legacy single-request path must never be handed
 * a file it cannot carry, and storage configuration must be detected the same
 * way everywhere.
 *
 * The upload:intent handler is not exported, so these tests reproduce its exact
 * sequence — validateUploadIntent, then selectUploadMode, then (only if the
 * mode is 'single') storage.createUploadTarget — against a SPY adapter. The
 * assertion that matters is a call count of zero.
 *
 * Run: node --test --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/uploads-transport.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createUploadRuntimeConfig, selectUploadMode, HARD_LOCAL_UPLOAD_BYTES, HARD_MAX_BYTES } = require('../server/uploads-multipart.js');
const { validateUploadIntent, verifyUploadToken } = require('../server/uploads.js');
const { createUploadIntent } = require('../server/uploads-intent.js');
const { DEFAULT_MAX_BYTES } = require('../server/upload-limits.js');
const { validateConfig } = require('../server/config.js');
const { createStorage } = require('../server/storage/index.js');
const { describeS3Config } = require('../server/storage/s3-config.js');

const SECRET = 'x'.repeat(32);
const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;
const S3_FULL = {
  S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
  S3_BUCKET: 'cineverse',
  S3_ACCESS_KEY_ID: 'AKIAEXAMPLE',
  S3_SECRET_ACCESS_KEY: 'secret',
};

/** A storage adapter that records every method call and performs none. */
function spyStorage() {
  const calls = { createUploadTarget: 0, createReadUrl: 0, statObject: 0, deleteObject: 0 };
  const grants = [];
  return {
    calls,
    grants,
    total: () => Object.values(calls).reduce((a, b) => a + b, 0),
    name: 'spy',
    async createUploadTarget(args) {
      calls.createUploadTarget += 1;
      grants.push(args);
      return { method: 'POST', url: 'https://spy/upload', fields: {}, direct: true };
    },
    async createReadUrl() {
      calls.createReadUrl += 1;
      return 'https://spy/read';
    },
    async statObject() {
      calls.statObject += 1;
      return { size: 1, contentType: 'video/mp4' };
    },
    async deleteObject() {
      calls.deleteObject += 1;
      return true;
    },
  };
}

/**
 * Drive the REAL service, not a copy of it.
 *
 * An earlier version of this file re-implemented the handler sequence. That is
 * exactly how the grant defect survived review: the copy passed a different
 * argument to createUploadTarget than server.js did, so the test proved a
 * property the product did not have.
 */
async function runIntent({ env, size, storage }) {
  const uploadConfig = createUploadRuntimeConfig(env, {
    objectStorage: describeS3Config(env).state === 'complete',
  }).config;
  const result = await createUploadIntent({
    payload: { fileName: 'movie.mp4', mimeType: 'video/mp4', size },
    uploadConfig,
    storage,
    secret: SECRET,
    roomCode: 'ABC123',
  });
  return { ...result, config: uploadConfig };
}

/* ============================================ 1-3: legacy path safety */

test('1. a 3 GiB file never reaches createUploadTarget while multipart is disabled', async () => {
  const env = { MAX_UPLOAD_BYTES: String(3 * GIB), ...S3_FULL };
  const storage = spyStorage();
  const result = await runIntent({ env, size: 3 * GIB, storage });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'MULTIPART_REQUIRED');
  assert.equal(storage.calls.createUploadTarget, 0, 'the legacy target must not be created');
  assert.equal(storage.total(), 0, 'no storage method may be called at all');
  // The capability is still reported honestly.
  assert.equal(result.config.effectiveMaxBytes, 3 * GIB);
  assert.equal(result.config.singleShotMaxBytes, HARD_LOCAL_UPLOAD_BYTES);
  assert.equal(result.config.multipartEnabled, false);
});

test('2. a small file still uses the existing single-shot target', async () => {
  const env = { MAX_UPLOAD_BYTES: String(3 * GIB), ...S3_FULL };
  const storage = spyStorage();
  const result = await runIntent({ env, size: 100 * MIB, storage });

  assert.equal(result.ok, true);
  assert.equal(storage.calls.createUploadTarget, 1, 'called exactly once');
  assert.equal(result.method, 'POST');

  // The grant handed to storage is bound to the SINGLE-SHOT ceiling.
  const grant = storage.grants[0];
  assert.equal(grant.expectedBytes, 100 * MIB, 'exact declared size');
  assert.ok(grant.maxBytes <= HARD_LOCAL_UPLOAD_BYTES, `grant maxBytes ${grant.maxBytes}`);
  assert.notEqual(grant.maxBytes, result.config.effectiveMaxBytes, 'must not be the deployment maximum');
});

test('3. one byte above the configured maximum is rejected before storage', async () => {
  const env = { MAX_UPLOAD_BYTES: String(3 * GIB), ...S3_FULL };
  const storage = spyStorage();
  const result = await runIntent({ env, size: 3 * GIB + 1, storage });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'TOO_LARGE');
  assert.equal(storage.total(), 0, 'no storage method may be called');
});

test('the single-shot boundary is exact', async () => {
  const env = { MAX_UPLOAD_BYTES: String(3 * GIB), ...S3_FULL };
  const at = spyStorage();
  assert.equal((await runIntent({ env, size: HARD_LOCAL_UPLOAD_BYTES, storage: at })).ok, true);
  assert.equal(at.calls.createUploadTarget, 1);
  assert.equal(at.grants[0].expectedBytes, HARD_LOCAL_UPLOAD_BYTES);

  const over = spyStorage();
  const result = await runIntent({ env, size: HARD_LOCAL_UPLOAD_BYTES + 1, storage: over });
  assert.equal(result.error, 'MULTIPART_REQUIRED');
  assert.equal(over.calls.createUploadTarget, 0);
});

test('without object storage a large file is TOO_LARGE, not MULTIPART_REQUIRED', async () => {
  // No bucket means no multipart capacity, so the honest answer is that the
  // file exceeds what this deployment can accept at all.
  const storage = spyStorage();
  const result = await runIntent({ env: {}, size: 3 * GIB, storage });
  assert.equal(result.error, 'TOO_LARGE');
  assert.equal(storage.total(), 0);
});

/* ============================================= 4: mandatory limit */

test('4. a missing maxBytes returns BAD_LIMIT rather than defaulting', () => {
  const input = { fileName: 'm.mp4', mimeType: 'video/mp4', size: 1000 };
  assert.equal(validateUploadIntent(input, {}).error, 'BAD_LIMIT');
  assert.equal(validateUploadIntent(input).error, 'BAD_LIMIT');
  assert.equal(validateUploadIntent(input, { maxBytes: undefined }).error, 'BAD_LIMIT');
  assert.equal(validateUploadIntent(input, { maxBytes: null }).error, 'BAD_LIMIT');
  // And a valid one still works.
  assert.equal(validateUploadIntent(input, { maxBytes: 2048 }).ok, true);
});

/* ================================ 5-9: unified storage detection */

const STORAGE_MATRIX = [
  ['absent', {}, false],
  ['all whitespace', { S3_ENDPOINT: '   ', S3_BUCKET: '\t', S3_ACCESS_KEY_ID: ' ', S3_SECRET_ACCESS_KEY: '\n' }, false],
  ['empty strings', { S3_ENDPOINT: '', S3_BUCKET: '', S3_ACCESS_KEY_ID: '', S3_SECRET_ACCESS_KEY: '' }, false],
  ['partial: endpoint only', { S3_ENDPOINT: 'https://a.b' }, false],
  ['partial: three of four', { S3_ENDPOINT: 'https://a.b', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'k' }, false],
  ['partial via whitespace', { ...S3_FULL, S3_BUCKET: '   ' }, false],
  ['malformed endpoint', { ...S3_FULL, S3_ENDPOINT: 'not-a-url' }, false],
  ['ftp endpoint', { ...S3_FULL, S3_ENDPOINT: 'ftp://a.b' }, false],
  ['padded secret', { ...S3_FULL, S3_SECRET_ACCESS_KEY: '  secret  ' }, false],
  ['malformed public base url', { ...S3_FULL, S3_PUBLIC_BASE_URL: 'nope' }, false],
  ['complete', { ...S3_FULL }, true],
  ['complete with region', { ...S3_FULL, S3_REGION: 'eu-west-1' }, true],
];

test('5. all-whitespace S3 variables select local storage everywhere', () => {
  const env = { S3_ENDPOINT: '   ', S3_BUCKET: '\t', S3_ACCESS_KEY_ID: ' ', S3_SECRET_ACCESS_KEY: '\n' };
  assert.equal(validateConfig(env).summary.storage, 'local-fs');
  assert.equal(createStorage(env).name, 'local-fs');
  assert.equal(describeS3Config(env).state, 'absent');
});

test('6. partial S3 variables fail consistently', () => {
  for (const env of [{ S3_ENDPOINT: 'https://a.b' }, { ...S3_FULL, S3_BUCKET: '   ' }]) {
    const report = validateConfig(env);
    assert.equal(report.ok, false, 'partial configuration must be a startup error');
    assert.ok(report.errors.some((e) => /partially configured/.test(e)));
    assert.equal(report.summary.storage, 'local-fs');
    assert.equal(createStorage(env).name, 'local-fs');
  }
});

test('7. an invalid S3 endpoint never instantiates the S3 adapter', () => {
  for (const bad of ['not-a-url', 'ftp://a.b', 'javascript:alert(1)', '   ']) {
    const env = { ...S3_FULL, S3_ENDPOINT: bad };
    assert.notEqual(createStorage(env).name, 's3', `endpoint ${JSON.stringify(bad)} must not build S3`);
    assert.equal(validateConfig(env).summary.storage, 'local-fs');
  }
});

test('8. a valid S3 configuration selects S3 everywhere', () => {
  assert.equal(validateConfig(S3_FULL).summary.storage, 's3');
  assert.equal(createStorage(S3_FULL).name, 's3');
  assert.equal(describeS3Config(S3_FULL).state, 'complete');
});

test('9. startup reporting and actual storage selection always agree', () => {
  // The property: summary.storage === 's3'  <=>  createStorage().name === 's3'
  for (const [label, env, expectS3] of STORAGE_MATRIX) {
    const reported = validateConfig(env).summary.storage === 's3';
    const selected = createStorage(env).name === 's3';
    assert.equal(reported, selected, `${label}: reported=${reported} selected=${selected}`);
    assert.equal(selected, expectS3, `${label}: expected s3=${expectS3}`);
  }
});

test('credentials are never silently trimmed', () => {
  // Padding is rejected rather than repaired: trimming would change a secret
  // that legitimately contains it, producing an opaque signature failure.
  const env = { ...S3_FULL, S3_SECRET_ACCESS_KEY: '  secret  ' };
  const described = describeS3Config(env);
  assert.equal(described.state, 'invalid');
  assert.ok(described.errors.some((e) => /whitespace/.test(e)));
  // A complete config passes the secret through verbatim.
  const ok = describeS3Config({ ...S3_FULL, S3_SECRET_ACCESS_KEY: 'sec/ret+value=' });
  assert.equal(ok.config.secretAccessKey, 'sec/ret+value=');
});

/* ============================ 10: ceiling independent of the default */

test('10. the hard local ceiling is independent of the product default', () => {
  // They are equal today, but must be separate literals: raising the product
  // default later must not silently raise the Node/filesystem safety ceiling.
  assert.equal(HARD_LOCAL_UPLOAD_BYTES, 500 * 1024 * 1024);
  assert.equal(DEFAULT_MAX_BYTES, 500 * 1024 * 1024);

  const source = require('node:fs').readFileSync(new URL('../server/upload-limits.js', import.meta.url), 'utf8');
  assert.ok(
    !/HARD_LOCAL_UPLOAD_BYTES\s*=\s*DEFAULT_MAX_BYTES/.test(source),
    'HARD_LOCAL_UPLOAD_BYTES must not be an alias of DEFAULT_MAX_BYTES',
  );
  assert.ok(/const HARD_LOCAL_UPLOAD_BYTES = 500 \* 1024 \* 1024/.test(source), 'it must be its own literal');
});

test('the transport ceilings never exceed their bounds', () => {
  const envs = [
    {},
    { MAX_UPLOAD_BYTES: String(3 * GIB) },
    { MAX_UPLOAD_BYTES: String(3 * GIB), ...S3_FULL },
    { MAX_UPLOAD_BYTES: String(100 * MIB), ...S3_FULL },
  ];
  for (const env of envs) {
    const c = createUploadRuntimeConfig(env, { objectStorage: describeS3Config(env).state === 'complete' }).config;
    assert.ok(c.singleShotMaxBytes <= HARD_LOCAL_UPLOAD_BYTES, `single ${c.singleShotMaxBytes}`);
    assert.ok(c.singleShotMaxBytes <= c.effectiveMaxBytes);
    assert.ok(c.multipartMaxBytes <= HARD_MAX_BYTES);
    assert.equal(c.multipartEnabled, false, 'multipart must stay disabled in this phase');
    if (!c.objectStorage) assert.equal(c.multipartMaxBytes, 0);
  }
});

/* ------------------------------------------- upload-mode helper rules */

test('selectUploadMode covers the four documented outcomes', () => {
  const single = 500 * MIB;
  assert.deepEqual(
    selectUploadMode({ size: 1000, singleShotMaxBytes: single, multipartMaxBytes: 3 * GIB, multipartEnabled: false }),
    { mode: 'single' },
  );
  assert.deepEqual(
    selectUploadMode({ size: 3 * GIB, singleShotMaxBytes: single, multipartMaxBytes: 3 * GIB, multipartEnabled: false }),
    { error: 'MULTIPART_REQUIRED' },
  );
  assert.deepEqual(
    selectUploadMode({ size: 4 * GIB, singleShotMaxBytes: single, multipartMaxBytes: 3 * GIB, multipartEnabled: true }),
    { error: 'TOO_LARGE' },
  );
  assert.deepEqual(
    selectUploadMode({ size: 1000, singleShotMaxBytes: single, multipartMaxBytes: 0, multipartEnabled: true }),
    { error: 'CONFIGURATION_ERROR' },
  );
  assert.deepEqual(
    selectUploadMode({ size: 3 * GIB, singleShotMaxBytes: single, multipartMaxBytes: 3 * GIB, multipartEnabled: true }),
    { mode: 'multipart' },
  );
  for (const bad of [0, -1, 1.5, NaN, '1000', null]) {
    assert.deepEqual(
      selectUploadMode({ size: bad, singleShotMaxBytes: single, multipartMaxBytes: 0, multipartEnabled: false }),
      { error: 'BAD_SIZE' },
      `size ${String(bad)}`,
    );
  }
});


/* ============ the regression this patch exists for ============ */

test('effectiveMaxBytes is NEVER the single-shot grant when it exceeds the transport ceiling', async () => {
  const env = { MAX_UPLOAD_BYTES: String(3 * GIB), ...S3_FULL };
  const storage = spyStorage();
  const result = await runIntent({ env, size: 100 * MIB, storage });

  assert.equal(result.ok, true);
  const grant = storage.grants[0];
  const config = result.config;

  assert.equal(config.effectiveMaxBytes, 3 * GIB, 'the deployment really is configured for 3 GiB');
  assert.ok(config.effectiveMaxBytes > config.singleShotMaxBytes, 'and it exceeds the transport ceiling');

  // The actual assertions: neither the grant nor the token may carry it.
  assert.equal(grant.maxBytes, config.singleShotMaxBytes);
  assert.ok(grant.maxBytes < config.effectiveMaxBytes);

  const claims = verifyUploadToken(result.token, SECRET);
  assert.ok(claims, 'token must verify');
  assert.equal(claims.expectedBytes, 100 * MIB);
  assert.equal(claims.maxBytes, config.singleShotMaxBytes);
  assert.ok(claims.maxBytes <= HARD_LOCAL_UPLOAD_BYTES);
  assert.notEqual(claims.maxBytes, config.effectiveMaxBytes);
});

test('MULTIPART_REQUIRED yields no token and no target', async () => {
  const env = { MAX_UPLOAD_BYTES: String(3 * GIB), ...S3_FULL };
  const storage = spyStorage();
  const result = await runIntent({ env, size: 3 * GIB, storage });

  assert.equal(result.error, 'MULTIPART_REQUIRED');
  assert.equal(result.token, undefined, 'no token may be minted');
  assert.equal(result.uploadUrl, undefined, 'no target may be returned');
  assert.equal(storage.total(), 0);
});

test('every accepted size produces a grant bound to the transport ceiling', async () => {
  const env = { MAX_UPLOAD_BYTES: String(3 * GIB), ...S3_FULL };
  for (const size of [1, 1024, 50 * MIB, 100 * MIB, HARD_LOCAL_UPLOAD_BYTES]) {
    const storage = spyStorage();
    const result = await runIntent({ env, size, storage });
    assert.equal(result.ok, true, `size ${size}`);
    const grant = storage.grants[0];
    assert.equal(grant.expectedBytes, size);
    assert.ok(grant.maxBytes <= HARD_LOCAL_UPLOAD_BYTES);
    assert.ok(grant.expectedBytes <= grant.maxBytes);
  }
});
