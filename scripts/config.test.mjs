/**
 * Unit tests for startup configuration validation (server/config.js).
 *
 * The bug class being pinned down: configuration that is WRONG but not
 * obviously wrong, so the server boots and misbehaves quietly. Partial object
 * storage is the archetype — it looks configured, and silently isn't.
 *
 * Run:  node --test --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/config.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { validateConfig, S3_KEYS } = require('../server/config.js');

const S3_FULL = {
  S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
  S3_BUCKET: 'cineverse',
  S3_ACCESS_KEY_ID: 'key',
  S3_SECRET_ACCESS_KEY: 'secret',
};

const errorsOf = (env, options) => validateConfig(env, options).errors.join(' | ');

/* ---------------- an empty environment is valid ---------------- */

test('a fresh clone with no configuration at all still boots', () => {
  const report = validateConfig({}, { production: false });
  assert.equal(report.ok, true, report.errors.join(' | '));
  assert.equal(report.summary.port, 3000, 'documented default');
  assert.equal(report.summary.storage, 'local-fs');
});

test('production with nothing set is valid but says what it is falling back to', () => {
  const report = validateConfig({}, { production: true });
  assert.equal(report.ok, true, 'missing OPTIONAL config is not a failure');
  const warnings = report.warnings.join(' | ');
  assert.match(warnings, /object storage/i, 'uploads will not survive a redeploy');
  assert.match(warnings, /UPLOAD_SECRET/, 'tokens will not survive a restart');
  assert.match(warnings, /STUN/i, 'calls may fail behind NAT');
});

/* ---------------- meaningless values fail ---------------- */

test('a nonsensical PORT is rejected with the value that was given', () => {
  const message = errorsOf({ PORT: 'banana' });
  assert.match(message, /PORT/);
  assert.match(message, /banana/, 'the operator must see what they typed');
});

test('out-of-range ports are rejected', () => {
  for (const port of ['0', '70000', '-1', '3000.5']) {
    assert.equal(validateConfig({ PORT: port }).ok, false, `PORT=${port}`);
  }
  assert.equal(validateConfig({ PORT: '8080' }).ok, true);
});

test('byte limits must be positive numbers', () => {
  for (const key of ['CHAT_ATTACHMENT_MAX_BYTES', 'CHAT_HISTORY_MAX_BYTES', 'MAX_UPLOAD_BYTES']) {
    assert.equal(validateConfig({ [key]: 'lots' }).ok, false, `${key}=lots`);
    assert.equal(validateConfig({ [key]: '-5' }).ok, false, `${key}=-5`);
    assert.equal(validateConfig({ [key]: '1048576' }).ok, true, `${key}=1MiB`);
  }
});

test('a negative reconnect grace is rejected, but zero is legitimate', () => {
  assert.equal(validateConfig({ ROOM_RECONNECT_GRACE_MS: '-1' }).ok, false);
  assert.equal(validateConfig({ ROOM_RECONNECT_GRACE_MS: 'soon' }).ok, false);
  assert.equal(validateConfig({ ROOM_RECONNECT_GRACE_MS: '0' }).ok, true, 'grace disabled on purpose');
});

test('the trusted-proxy switch only accepts 0 or 1', () => {
  assert.equal(validateConfig({ RATE_LIMIT_TRUST_PROXY: 'true' }).ok, false);
  assert.equal(validateConfig({ RATE_LIMIT_TRUST_PROXY: 'yes' }).ok, false);
  for (const value of ['0', '1']) assert.equal(validateConfig({ RATE_LIMIT_TRUST_PROXY: value }).ok, true);
});

test('trusting a proxy in production is called out, because it grants capacity', () => {
  const report = validateConfig({ RATE_LIMIT_TRUST_PROXY: '1' }, { production: true });
  assert.equal(report.ok, true, 'a valid choice…');
  assert.match(report.warnings.join(' '), /trusted proxy/i, '…but one that must be deliberate');
});

test('UPLOAD_TTL_HOURS must be a positive number', () => {
  assert.equal(validateConfig({ UPLOAD_TTL_HOURS: '0' }).ok, false);
  assert.equal(validateConfig({ UPLOAD_TTL_HOURS: 'six' }).ok, false);
  assert.equal(validateConfig({ UPLOAD_TTL_HOURS: '6' }).ok, true);
});

/* ---------------- partial object storage is always fatal ---------------- */

test('a fully configured bucket is accepted', () => {
  const report = validateConfig({ ...S3_FULL }, { production: true });
  assert.equal(report.ok, true, report.errors.join(' | '));
  assert.equal(report.summary.storage, 's3');
});

test('EVERY partial combination of the storage keys is an error', () => {
  for (const missing of S3_KEYS) {
    const env = { ...S3_FULL };
    delete env[missing];
    const report = validateConfig(env, { production: false });
    assert.equal(report.ok, false, `missing ${missing} must not boot`);
    assert.match(report.errors.join(' '), new RegExp(missing), 'and must name the missing key');
  }
});

test('the partial-storage error explains the silent fallback it prevents', () => {
  const env = { ...S3_FULL };
  delete env.S3_SECRET_ACCESS_KEY;
  assert.match(errorsOf(env), /filesystem|fallback|falls back/i);
});

test('an empty string counts as unset, not as configured', () => {
  const report = validateConfig({ ...S3_FULL, S3_BUCKET: '   ' });
  assert.equal(report.ok, false, 'whitespace is not a bucket name');
});

test('storage URLs are validated with URL, not a regex guess', () => {
  assert.equal(validateConfig({ ...S3_FULL, S3_ENDPOINT: 'acct.r2.cloudflarestorage.com' }).ok, false, 'no scheme');
  assert.equal(validateConfig({ ...S3_FULL, S3_ENDPOINT: 'ftp://acct/bucket' }).ok, false, 'wrong scheme');
  assert.equal(validateConfig({ ...S3_FULL, S3_PUBLIC_BASE_URL: 'not a url' }).ok, false);
  assert.equal(validateConfig({ ...S3_FULL, S3_PUBLIC_BASE_URL: 'https://cdn.example.com' }).ok, true);
});

/* ---------------- ICE servers degrade, never crash ---------------- */

test('a malformed ICE list warns and falls back rather than failing the boot', () => {
  for (const raw of ['{oops', '[]', '{"urls":"stun:x"}', '[{"nope":1}]']) {
    const report = validateConfig({ NEXT_PUBLIC_RTC_ICE_SERVERS: raw });
    assert.equal(report.ok, true, `${raw} must not be fatal — the client already falls back`);
    assert.match(report.warnings.join(' '), /ICE/i, `${raw} must be reported`);
  }
});

test('a valid TURN configuration passes without noise', () => {
  const report = validateConfig(
    { NEXT_PUBLIC_RTC_ICE_SERVERS: '[{"urls":"turn:turn.example.com:3478","username":"u","credential":"c"}]' },
    { production: true },
  );
  assert.equal(report.ok, true);
  assert.equal(report.summary.iceServers, 1);
  assert.equal(report.warnings.some((w) => /TURN/.test(w)), false, 'no complaint when TURN is present');
});

test('STUN-only in production is flagged, since NAT will break calls', () => {
  const report = validateConfig(
    { NEXT_PUBLIC_RTC_ICE_SERVERS: '[{"urls":"stun:stun.l.google.com:19302"}]' },
    { production: true },
  );
  assert.equal(report.ok, true);
  assert.match(report.warnings.join(' '), /TURN/);
});

/* ---------------- never leak a secret ---------------- */

test('no secret value is ever echoed back in the report', () => {
  const report = validateConfig(
    {
      ...S3_FULL,
      S3_SECRET_ACCESS_KEY: 'super-secret-value',
      UPLOAD_SECRET: 'another-secret',
      PORT: 'banana',
    },
    { production: true },
  );
  const text = JSON.stringify(report);
  assert.equal(text.includes('super-secret-value'), false, 'storage secret leaked');
  assert.equal(text.includes('another-secret'), false, 'upload secret leaked');
  assert.match(text, /banana/, 'but a bad NON-secret value is still shown');
});

/* ==========================================================================
   Large-upload startup matrix.

   These pin the six documented runtime behaviours AND the property that makes
   them trustworthy: the number reported at startup is the same number
   `upload:intent` enforces at runtime. Before this, uploads.js parsed
   MAX_UPLOAD_BYTES independently, so the two could disagree.
   ========================================================================== */

const { createUploadRuntimeConfig, HARD_MAX_BYTES } = require('../server/uploads-multipart.js');
const { validateUploadIntent } = require('../server/uploads.js');

const GIB = 1024 * 1024 * 1024;
const THREE_GIB = '3221225472';
const SECRET = { UPLOAD_SECRET: 'a'.repeat(32) };

/** Exactly what server.js does at startup. */
const runtime = (env) => createUploadRuntimeConfig(env, { objectStorage: S3_KEYS.every((k) => env[k]) }).config;

/** Exactly what the upload:intent handler does with it. */
const intent = (env, size) =>
  validateUploadIntent({ fileName: 'movie.mp4', mimeType: 'video/mp4', size }, { maxBytes: runtime(env).effectiveMaxBytes });

test('matrix 1: production, no storage, defaults — boots with the existing local limit', () => {
  const env = { NODE_ENV: 'production' };
  const report = validateConfig(env);
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.equal(runtime(env).effectiveMaxBytes, 500 * 1024 * 1024, 'historical default preserved');
  assert.equal(report.summary.effectiveMaxUploadBytes, runtime(env).effectiveMaxBytes);
});

test('matrix 2: production, 3 GiB, no storage — refuses startup', () => {
  const report = validateConfig({ NODE_ENV: 'production', MAX_UPLOAD_BYTES: THREE_GIB, ...SECRET });
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((e) => /object storage is not configured/.test(e)), JSON.stringify(report.errors));
});

test('matrix 3: production, 3 GiB, storage, no stable secret — refuses startup', () => {
  const report = validateConfig({ NODE_ENV: 'production', MAX_UPLOAD_BYTES: THREE_GIB, ...S3_FULL });
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((e) => /UPLOAD_SECRET/.test(e)), JSON.stringify(report.errors));
});

test('matrix 4: production, 3 GiB, storage, stable secret — boots at exactly 3 GiB', () => {
  const env = { NODE_ENV: 'production', MAX_UPLOAD_BYTES: THREE_GIB, ...S3_FULL, ...SECRET };
  const report = validateConfig(env);
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.equal(runtime(env).effectiveMaxBytes, 3_221_225_472);
  assert.equal(report.summary.effectiveMaxUploadBytes, 3_221_225_472);
  // And the runtime honours it, to the byte.
  assert.equal(intent(env, 3 * GIB).ok, true, 'exactly 3 GiB accepted');
  assert.equal(intent(env, 3 * GIB + 1).error, 'TOO_LARGE', 'one byte over rejected');
});

test('matrix 5: development, 3 GiB, no storage — boots, warns, and enforces the local ceiling', () => {
  const env = { MAX_UPLOAD_BYTES: THREE_GIB };
  const report = validateConfig(env);
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.ok(report.warnings.some((w) => /object storage is not configured/.test(w)));

  const config = runtime(env);
  assert.equal(config.maxUploadBytes, 3 * GIB, 'the request is still reported');
  assert.equal(config.effectiveMaxBytes, config.localMaxUploadBytes, 'but the local ceiling is what runs');
  assert.ok(config.effectiveMaxBytes < 3 * GIB);

  // The runtime rejects anything above the LOCAL ceiling, not the requested one.
  assert.equal(intent(env, config.localMaxUploadBytes).ok, true);
  assert.equal(intent(env, config.localMaxUploadBytes + 1).error, 'TOO_LARGE');
  assert.equal(intent(env, 2 * GIB).error, 'TOO_LARGE', 'development never accepts 2 GiB without storage');
});

test('matrix 6: 3 GiB + 1 byte is rejected as configuration, and unreachable at runtime', () => {
  const env = { MAX_UPLOAD_BYTES: String(3 * GIB + 1) };
  const report = validateConfig(env);
  assert.equal(report.ok, false, 'configuration is rejected in every environment');
  assert.ok(report.errors.some((e) => /must not exceed/.test(e)));

  // Development continues on the previous/default value; the oversized request
  // is never adopted, so no runtime path can accept it.
  const config = runtime(env);
  assert.ok(config.effectiveMaxBytes <= HARD_MAX_BYTES);
  assert.equal(intent(env, 3 * GIB + 1).error, 'TOO_LARGE');
});

test('no environment can make a runtime path accept more than the hard ceiling', () => {
  const envs = [
    {},
    { NODE_ENV: 'production', ...S3_FULL, ...SECRET },
    { MAX_UPLOAD_BYTES: String(Number.MAX_SAFE_INTEGER), ...S3_FULL, ...SECRET },
    { MAX_UPLOAD_BYTES: '99999999999999', LOCAL_UPLOAD_MAX_BYTES: '99999999999999', ...S3_FULL, ...SECRET },
    { MAX_UPLOAD_BYTES: THREE_GIB, ...S3_FULL, ...SECRET },
  ];
  for (const env of envs) {
    const config = runtime(env);
    assert.ok(config.effectiveMaxBytes <= HARD_MAX_BYTES, `effective ${config.effectiveMaxBytes}`);
    assert.equal(intent(env, HARD_MAX_BYTES + 1).error, 'TOO_LARGE', `env ${JSON.stringify(Object.keys(env))}`);
  }
});

test('startup reporting and upload:intent agree on the effective maximum', () => {
  // The property that makes the whole matrix meaningful. Exercised through the
  // function upload:intent actually calls, not readMultipartConfig in isolation.
  const envs = [
    {},
    { MAX_UPLOAD_BYTES: THREE_GIB },
    { MAX_UPLOAD_BYTES: THREE_GIB, ...S3_FULL, ...SECRET },
    { MAX_UPLOAD_BYTES: '1048576' },
    { MAX_UPLOAD_BYTES: '1048576', LOCAL_UPLOAD_MAX_BYTES: '1048576' },
  ];
  for (const env of envs) {
    const reported = validateConfig(env).summary.effectiveMaxUploadBytes;
    const enforced = runtime(env).effectiveMaxBytes;
    assert.equal(reported, enforced, `env ${JSON.stringify(env)}`);
    // At the boundary: accepted at the limit, refused one byte over.
    assert.equal(intent(env, enforced).ok, true, `accept ${enforced}`);
    assert.equal(intent(env, enforced + 1).error, 'TOO_LARGE', `refuse ${enforced + 1}`);
  }
});


/* ==========================================================================
   Hard local ceiling + production secret strength.
   ========================================================================== */

const { HARD_LOCAL_UPLOAD_BYTES } = require('../server/uploads-multipart.js');
const MIB = 1024 * 1024;

test('local ceiling: the documented bypass is closed', () => {
  // Raising BOTH values in lockstep used to make requiresObjectStorage false,
  // so the process booted on local-fs and then accepted a 3 GiB intent.
  const env = {
    NODE_ENV: 'production',
    MAX_UPLOAD_BYTES: THREE_GIB,
    LOCAL_UPLOAD_MAX_BYTES: THREE_GIB,
    UPLOAD_SECRET: 'x'.repeat(32),
  };
  const report = validateConfig(env);
  assert.equal(report.ok, false, 'must refuse startup');
  assert.ok(
    report.errors.some((e) => /hard local ceiling/.test(e) || /object storage is not configured/.test(e)),
    JSON.stringify(report.errors),
  );
});

test('local ceiling: development with the same configuration keeps the hard ceiling', () => {
  const env = { MAX_UPLOAD_BYTES: THREE_GIB, LOCAL_UPLOAD_MAX_BYTES: THREE_GIB };
  const report = validateConfig(env);
  // The oversized LOCAL value is itself rejected, so it is never adopted.
  assert.ok(report.errors.some((e) => /hard local ceiling/.test(e)));
  const config = runtime(env);
  assert.equal(config.effectiveMaxBytes, HARD_LOCAL_UPLOAD_BYTES);
  assert.equal(intent(env, HARD_LOCAL_UPLOAD_BYTES + 1).error, 'TOO_LARGE');
  assert.equal(intent(env, 3 * GIB).error, 'TOO_LARGE');
});

test('local ceiling: 500 MiB + 1 byte is rejected', () => {
  const env = { LOCAL_UPLOAD_MAX_BYTES: String(HARD_LOCAL_UPLOAD_BYTES + 1), MAX_UPLOAD_BYTES: THREE_GIB };
  const { errors } = createUploadRuntimeConfig(env, { objectStorage: false });
  assert.ok(errors.some((e) => /hard local ceiling/.test(e)), JSON.stringify(errors));
});

test('local ceiling: an explicit smaller maximum is honoured exactly', () => {
  const hundred = String(100 * MIB);
  for (const env of [{ MAX_UPLOAD_BYTES: hundred }, { MAX_UPLOAD_BYTES: hundred, LOCAL_UPLOAD_MAX_BYTES: hundred }]) {
    const config = runtime(env);
    assert.equal(config.effectiveMaxBytes, 100 * MIB, JSON.stringify(env));
    assert.equal(intent(env, 100 * MIB).ok, true);
    assert.equal(intent(env, 100 * MIB + 1).error, 'TOO_LARGE');
  }
});

test('local ceiling: no environment lets the local adapter accept 3 GiB', () => {
  const hostile = [
    { MAX_UPLOAD_BYTES: THREE_GIB, LOCAL_UPLOAD_MAX_BYTES: THREE_GIB },
    { MAX_UPLOAD_BYTES: THREE_GIB },
    { MAX_UPLOAD_BYTES: THREE_GIB, LOCAL_UPLOAD_MAX_BYTES: String(2 * GIB) },
    { LOCAL_UPLOAD_MAX_BYTES: THREE_GIB },
  ];
  for (const env of hostile) {
    const config = createUploadRuntimeConfig(env, { objectStorage: false }).config;
    assert.ok(
      config.effectiveMaxBytes <= HARD_LOCAL_UPLOAD_BYTES,
      `${JSON.stringify(env)} gave ${config.effectiveMaxBytes}`,
    );
    assert.equal(intent(env, 3 * GIB).error, 'TOO_LARGE', JSON.stringify(env));
  }
});

/* ---------------------------------------------------- secret strength */

const largeUpload = (secret) => ({
  NODE_ENV: 'production',
  MAX_UPLOAD_BYTES: THREE_GIB,
  ...S3_FULL,
  ...(secret === undefined ? {} : { UPLOAD_SECRET: secret }),
});

test('secret: unset, empty, short and whitespace-only are rejected for large uploads', () => {
  for (const [label, secret] of [
    ['unset', undefined],
    ['empty', ''],
    ['one character', 'x'],
    ['31 bytes', 'x'.repeat(31)],
    ['whitespace only', ' '.repeat(64)],
  ]) {
    const report = validateConfig(largeUpload(secret));
    assert.equal(report.ok, false, `${label} must be rejected`);
    assert.ok(report.errors.some((e) => /UPLOAD_SECRET/.test(e)), `${label}: ${JSON.stringify(report.errors)}`);
  }
});

test('secret: exactly 32 bytes is accepted, and a long random secret is accepted', () => {
  for (const secret of ['x'.repeat(32), 'k7$Rq2!zP9wLm4Xn8vB6tY1uA3sD5fG0hJ'.repeat(3)]) {
    const report = validateConfig(largeUpload(secret));
    assert.equal(report.ok, true, JSON.stringify(report.errors));
  }
});

test('secret: strength is measured in UTF-8 bytes, not characters', () => {
  // 16 characters, but 32 bytes once encoded: byte length is what HMAC sees.
  const twoByteChars = 'e'.repeat(31);
  assert.ok(Buffer.byteLength(twoByteChars, 'utf8') < 32);
  assert.equal(validateConfig(largeUpload(twoByteChars)).ok, false, '31 bytes must fail');
});

test('secret: the value never appears in any report field', () => {
  const secret = 'SUPER-SECRET-VALUE-THAT-MUST-NEVER-BE-PRINTED-0123456789';
  const report = validateConfig(largeUpload(secret));
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes(secret), 'the secret leaked into the report');
  assert.ok(!serialized.includes(secret.slice(0, 16)), 'a prefix of the secret leaked');
  assert.equal(report.summary.uploadSecret, 'set (strong)');
  // And a weak one is reported as weak, still without the value. The probe
  // value is deliberately distinctive: 'short' would have matched the word
  // "shorter" in the warning copy and failed for the wrong reason.
  const weakValue = 'Zq7Wv';
  const weak = validateConfig({ NODE_ENV: 'production', UPLOAD_SECRET: weakValue });
  assert.ok(!JSON.stringify(weak).includes(weakValue));
  assert.equal(weak.summary.uploadSecret, 'set (weak)');
});

/* ------------------------------------------------ strict intent sizes */

test('intent sizes are validated strictly, with no coercion', () => {
  const env = { MAX_UPLOAD_BYTES: THREE_GIB, ...S3_FULL, UPLOAD_SECRET: 'x'.repeat(32) };
  for (const bad of ['1048576', 1.5, NaN, Infinity, -Infinity, 0, -1, null, undefined, {}, []]) {
    assert.equal(intent(env, bad).error, 'BAD_SIZE', `size ${JSON.stringify(String(bad))}`);
  }
  assert.equal(intent(env, 3 * GIB + 1).error, 'TOO_LARGE');
  assert.equal(intent(env, 3 * GIB).ok, true);
});

test('an invalid internal limit is refused rather than becoming unlimited', () => {
  const call = (maxBytes) =>
    validateUploadIntent({ fileName: 'm.mp4', mimeType: 'video/mp4', size: 1000 }, { maxBytes });
  for (const bad of [1.5, -1, 0, NaN, Infinity, '1048576', HARD_MAX_BYTES + 1]) {
    assert.equal(call(bad).error, 'BAD_LIMIT', `limit ${String(bad)}`);
  }
  assert.equal(call(2048).ok, true);
});
