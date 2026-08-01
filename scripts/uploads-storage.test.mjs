/**
 * Tests for the production storage path: the S3 presigned-POST policy
 * (server/storage/s3.js) and complete-time verification
 * (server/uploads-finalize.js).
 *
 * No real S3 — the POST policy is pure crypto, and finalize is tested with a
 * mock adapter so existence/size/type verification is proven without a bucket.
 *
 * Run:  node --test --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/uploads-storage.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createS3Storage, buildPostPolicy, isConfigured } = require('../server/storage/s3.js');
const { finalizeUpload } = require('../server/uploads-finalize.js');

const MB = 1024 * 1024;
const S3_ENV = {
  S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
  S3_BUCKET: 'cineverse-uploads',
  S3_ACCESS_KEY_ID: 'AKIAEXAMPLE',
  S3_SECRET_ACCESS_KEY: 'secretkeyexample',
  S3_REGION: 'auto',
};

const KEY = 'rooms/ABC123/aaaaaaaaaaaaaaaaaaaaaaaa/movie.mp4';
const WEBM_KEY = 'rooms/ABC123/aaaaaaaaaaaaaaaaaaaaaaaa/movie.webm';

/**
 * Signing now takes the COMPLETE grant, validated by the shared validator, so
 * these fixtures carry transport and room as well as the byte fields. A partial
 * grant is refused outright — which is the point.
 */
const grant = (over = {}) => ({
  transport: 'single',
  key: KEY,
  mimeType: 'video/mp4',
  roomCode: 'ABC123',
  expectedBytes: 100 * MB,
  maxBytes: 500 * MB,
  ...over,
});
const POLICY_CONFIG = {
  endpoint: S3_ENV.S3_ENDPOINT,
  bucket: S3_ENV.S3_BUCKET,
  accessKeyId: S3_ENV.S3_ACCESS_KEY_ID,
  secretAccessKey: S3_ENV.S3_SECRET_ACCESS_KEY,
  region: 'auto',
};

/** Decode the base64 policy document a presigned POST carries. */
function decodePolicy(fields) {
  return JSON.parse(Buffer.from(fields.Policy, 'base64').toString('utf8'));
}

/* ---------------- presigned POST size enforcement ---------------- */

test('S3 is selected only when fully configured', () => {
  assert.equal(isConfigured(S3_ENV), true);
  assert.equal(isConfigured({ S3_ENDPOINT: 'x' }), false);
  assert.equal(isConfigured({}), false);
});

test('the S3 upload target is a POST with policy fields, not a bare PUT', async () => {
  const storage = createS3Storage(S3_ENV);
  const target = await storage.createUploadTarget(grant());
  assert.equal(target.method, 'POST');
  assert.equal(target.direct, true);
  assert.ok(target.fields && target.fields.Policy && target.fields['X-Amz-Signature']);
  assert.ok(target.url.endsWith('/cineverse-uploads'));
});

test('the POST policy enforces the byte range with content-length-range', () => {
  const { fields } = buildPostPolicy(grant(), POLICY_CONFIG, 900, 0);

  const policy = decodePolicy(fields);
  const range = policy.conditions.find((c) => Array.isArray(c) && c[0] === 'content-length-range');
  // EXACT, not a range: both ends are the declared size, so the bucket
  // rejects any body that is not the one that was authorized. This used to
  // be [1, maxBytes], which let a small declaration authorize a huge body.
  assert.deepEqual(range, ['content-length-range', 100 * MB, 100 * MB], 'the bucket pins the exact size');
});

test('the POST policy pins the exact key and content-type', () => {
  // The key extension must agree with the MIME, so a webm policy needs a webm key.
  const { fields } = buildPostPolicy(
    grant({ key: WEBM_KEY, mimeType: 'video/webm', expectedBytes: 5 * MB, maxBytes: 10 * MB }),
    POLICY_CONFIG,
    900,
    0,
  );

  const policy = decodePolicy(fields);
  assert.ok(policy.conditions.some((c) => Array.isArray(c) && c[0] === 'eq' && c[1] === '$key' && c[2] === WEBM_KEY));
  assert.ok(
    policy.conditions.some((c) => Array.isArray(c) && c[0] === 'eq' && c[1] === '$Content-Type' && c[2] === 'video/webm'),
  );
  // The key/content-type fields the browser echoes must match the policy.
  assert.equal(fields.key, WEBM_KEY);
  assert.equal(fields['Content-Type'], 'video/webm');
});

test('a different max size changes the signature (the cap is signed, not cosmetic)', () => {
  const a = buildPostPolicy(grant({ expectedBytes: 100 * MB }), POLICY_CONFIG, 900, 0);
  const b = buildPostPolicy(grant({ expectedBytes: 200 * MB }), POLICY_CONFIG, 900, 0);
  assert.notEqual(a.fields['X-Amz-Signature'], b.fields['X-Amz-Signature']);
});

/* ---------------- complete-time verification (mock adapter) ---------------- */

// A COMPLETE grant: nothing is defaulted downstream, so the fixture must be whole.
const claims = {
  transport: 'single',
  key: KEY,
  mimeType: 'video/mp4',
  expectedBytes: 100 * MB,
  maxBytes: 500 * MB,
  roomCode: 'ABC123',
};

function mockStorage(overrides = {}) {
  const deleted = [];
  return {
    deleted,
    createReadUrl: async (k) => `https://cdn.example/${k}`,
    deleteObject: async (k) => {
      deleted.push(k);
      return true;
    },
    ...overrides,
  };
}

test('complete FAILS when no object was uploaded', async () => {
  const storage = mockStorage({ statObject: async () => null });
  const result = await finalizeUpload({ storage, claims, label: 'movie.mp4' });
  assert.deepEqual(result, { ok: false, error: 'NOT_UPLOADED' });
});

test('complete FAILS and deletes when the object is oversized', async () => {
  // 600 MB against a 500 MB cap: the TOO_LARGE gate fires before the exact-size
  // check, so this still asserts the cap and not SIZE_MISMATCH.
  const storage = mockStorage({ statObject: async () => ({ size: 600 * MB, contentType: 'video/mp4' }) });
  const result = await finalizeUpload({ storage, claims, label: 'movie.mp4' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'TOO_LARGE');
  assert.deepEqual(storage.deleted, [KEY], 'the oversized object is cleaned up');
});

test('complete FAILS and deletes when the object is zero bytes', async () => {
  const storage = mockStorage({ statObject: async () => ({ size: 0, contentType: 'video/mp4' }) });
  const result = await finalizeUpload({ storage, claims, label: 'empty.mp4' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'BAD_SIZE');
  assert.deepEqual(storage.deleted, [KEY], 'the empty object is cleaned up');
});

test('complete FAILS and deletes when the object size is not finite', async () => {
  const storage = mockStorage({ statObject: async () => ({ size: Number.NaN, contentType: 'video/mp4' }) });
  const result = await finalizeUpload({ storage, claims, label: 'weird.mp4' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'BAD_SIZE');
  assert.deepEqual(storage.deleted, [KEY]);
});

test('complete FAILS and deletes when the content type is wrong', async () => {
  const storage = mockStorage({ statObject: async () => ({ size: 100 * MB, contentType: 'application/zip' }) });
  const result = await finalizeUpload({ storage, claims, label: 'movie.mp4' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'BAD_CONTENT');
  assert.deepEqual(storage.deleted, [KEY]);
});

test('complete SUCCEEDS for a valid object and returns a playable Uploaded source', async () => {
  const storage = mockStorage({ statObject: async () => ({ size: 100 * MB, contentType: 'video/mp4' }) });
  const result = await finalizeUpload({ storage, claims, label: 'My Movie.mp4' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.source, {
    type: 'url',
    value: `https://cdn.example/${KEY}`,
    label: 'My Movie.mp4',
    quality: 'Uploaded',
  });
  assert.deepEqual(storage.deleted, [], 'a valid object is never deleted');
});

test('complete tolerates an adapter that reports size without a content type', async () => {
  const storage = mockStorage({ statObject: async () => ({ size: 100 * MB }) });
  const result = await finalizeUpload({ storage, claims, label: 'clip.mp4' });
  assert.equal(result.ok, true);
  assert.equal(result.source.quality, 'Uploaded');
});

/* ---------------- fail closed ----------------
   Completion must never attach a source it could not verify. The old behavior
   here was the opposite: an adapter WITHOUT statObject skipped every check and
   built a read URL anyway. */

/** A storage double that records whether a read URL was ever built. */
function verifyingStorage(overrides = {}) {
  const deleted = [];
  let readUrlCalls = 0;
  return {
    deleted,
    readUrlCalls: () => readUrlCalls,
    statObject: async () => ({ size: 100 * MB, contentType: 'video/mp4' }),
    createReadUrl: async (k) => {
      readUrlCalls += 1;
      return `https://cdn.example/${k}`;
    },
    deleteObject: async (k) => {
      deleted.push(k);
      return true;
    },
    ...overrides,
  };
}

test('an adapter that cannot prove existence is refused, and no source is built', async () => {
  // The replaced test asserted this case SUCCEEDS. It must fail closed: an
  // adapter with no statObject cannot prove the object landed or matches its
  // grant, so no read URL may be handed out.
  const storage = verifyingStorage({ statObject: undefined });
  const result = await finalizeUpload({ storage, claims, label: 'x.mp4' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'STORAGE_UNVERIFIABLE');
  assert.equal(storage.readUrlCalls(), 0, 'createReadUrl must never be called');
});

test('an invalid grant fails before any storage call', async () => {
  const bad = [
    ['missing expectedBytes', { ...claims, expectedBytes: undefined }],
    ['fractional expectedBytes', { ...claims, expectedBytes: 100.5 }],
    ['zero expectedBytes', { ...claims, expectedBytes: 0 }],
    ['missing maxBytes', { ...claims, maxBytes: undefined }],
    ['expectedBytes > maxBytes', { ...claims, expectedBytes: 600 * MB, maxBytes: 500 * MB }],
    ['over-ceiling maxBytes', { ...claims, maxBytes: 3 * 1024 * MB }],
    ['invalid key', { ...claims, key: '../../etc/passwd' }],
    ['invalid MIME', { ...claims, mimeType: 'application/zip' }],
    ['room/key mismatch', { ...claims, roomCode: 'ZZZ999' }],
  ];
  for (const [label, badClaims] of bad) {
    let statCalls = 0;
    const storage = verifyingStorage({
      statObject: async () => {
        statCalls += 1;
        return { size: 100 * MB, contentType: 'video/mp4' };
      },
    });
    const result = await finalizeUpload({ storage, claims: badClaims, label: 'x.mp4' });
    assert.equal(result.ok, false, label);
    assert.equal(result.error, 'BAD_GRANT', `${label}: ${result.error}`);
    assert.equal(statCalls, 0, `${label}: storage must not be consulted`);
    assert.equal(storage.readUrlCalls(), 0, `${label}: no source may be built`);
  }
});

test('a null or non-object claims value fails closed', async () => {
  const storage = verifyingStorage();
  for (const bad of [null, undefined, 'string', 42, []]) {
    const result = await finalizeUpload({ storage, claims: bad, label: 'x.mp4' });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'BAD_GRANT');
  }
  assert.equal(storage.readUrlCalls(), 0);
});

test('a size mismatch fails closed and never builds a source', async () => {
  const storage = verifyingStorage({ statObject: async () => ({ size: 99 * MB, contentType: 'video/mp4' }) });
  const result = await finalizeUpload({ storage, claims, label: 'x.mp4' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'SIZE_MISMATCH');
  assert.deepEqual(storage.deleted, [KEY]);
  assert.equal(storage.readUrlCalls(), 0, 'a mismatched object must not yield a read URL');
});

test('an empty label falls back to a sensible default', async () => {
  const storage = mockStorage({ statObject: async () => ({ size: 100 * MB, contentType: 'video/mp4' }) });
  const result = await finalizeUpload({ storage, claims, label: '   ' });
  assert.equal(result.source.label, 'Uploaded video');
});


/* ---------------- the transport claim is never synthesized (item 4) ---------------- */

test('a missing, empty or non-single transport fails before ANY storage call', async () => {
  /*
   * finalizeUpload used to default an absent `transport` to 'single', which
   * meant it invented the claim it was supposed to be verifying. A claim set
   * that cannot say what it authorizes must be refused, not upgraded.
   */
  for (const [label, transport] of [
    ['missing', undefined],
    ['empty', ''],
    ['null', null],
    ['multipart', 'multipart'],
    ['wrong case', 'Single'],
    ['numeric', 1],
  ]) {
    const seen = [];
    const storage = {
      statObject: async () => {
        seen.push('statObject');
        return { size: 100 * MB, contentType: 'video/mp4' };
      },
      createReadUrl: async () => {
        seen.push('createReadUrl');
        return 'https://cdn/x';
      },
      deleteObject: async () => {
        seen.push('deleteObject');
        return true;
      },
    };
    const result = await finalizeUpload({ storage, claims: { ...claims, transport }, label: 'x.mp4' });
    assert.equal(result.ok, false, label);
    assert.equal(result.error, 'BAD_GRANT', `${label}: got ${result.error}`);
    assert.deepEqual(seen, [], `${label}: storage must not be touched, saw ${seen.join()}`);
  }
});

test('an explicit single transport with an otherwise valid grant still succeeds', async () => {
  const storage = mockStorage({ statObject: async () => ({ size: 100 * MB, contentType: 'video/mp4' }) });
  const result = await finalizeUpload({ storage, claims: { ...claims, transport: 'single' }, label: 'ok.mp4' });
  assert.equal(result.ok, true);
});

test('a missing or non-object storage is STORAGE_UNVERIFIABLE, not a crash', async () => {
  for (const bad of [undefined, null, 'nope', 42, []]) {
    const result = await finalizeUpload({ storage: bad, claims: { ...claims, transport: 'single' }, label: 'x' });
    assert.equal(result.ok, false, String(bad));
    assert.equal(result.error, 'STORAGE_UNVERIFIABLE', String(bad));
  }
});

test('a verified-but-invalid stored object is still deleted', async () => {
  // The one case where deleteObject IS expected: the grant is valid, the object
  // landed, and it does not match what was authorized.
  const storage = mockStorage({ statObject: async () => ({ size: 99 * MB, contentType: 'video/mp4' }) });
  const result = await finalizeUpload({ storage, claims: { ...claims, transport: 'single' }, label: 'x' });
  assert.equal(result.error, 'SIZE_MISMATCH');
  assert.deepEqual(storage.deleted, [KEY], 'the mismatched object must be removed');
});
