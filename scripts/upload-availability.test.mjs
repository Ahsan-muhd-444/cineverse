/**
 * Unit tests for hosted-upload availability (server/upload-availability.js).
 *
 * The gap this pins down: before `getUploadAvailability`, a production deploy with
 * NO object storage silently accepted single-shot uploads through the dev
 * filesystem adapter — writing real user videos onto an ephemeral container disk
 * while advertising nothing was wrong. These tests fix the deploy-safety contract:
 *   - production without a real bucket (or its guardrails) => uploads DISABLED,
 *   - production never degrades to the local filesystem adapter for real videos,
 *   - development keeps the local dev-upload path with no setup.
 *
 * Run:  node --test --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/upload-availability.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getUploadAvailability, isMaxUploadBytesConfigured } = require('../server/upload-availability.js');
const { createUploadRuntimeConfig } = require('../server/uploads-multipart.js');
const { createUploadIntent } = require('../server/uploads-intent.js');

/** A storage adapter that records calls and performs none. */
function spyStorage() {
  const calls = { createUploadTarget: 0, createMultipartUpload: 0 };
  return {
    calls,
    total: () => Object.values(calls).reduce((a, b) => a + b, 0),
    name: 'spy',
    async createUploadTarget() {
      calls.createUploadTarget += 1;
      return { method: 'POST', url: 'https://spy/upload', fields: {}, direct: true };
    },
    async createMultipartUpload() {
      calls.createMultipartUpload += 1;
      return { uploadId: 'spy-upload' };
    },
  };
}

/** A COMPLETE S3 configuration (all four keys, valid endpoint). */
const S3_FULL = {
  S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
  S3_BUCKET: 'cineverse',
  S3_ACCESS_KEY_ID: 'key',
  S3_SECRET_ACCESS_KEY: 'secret',
};
const STRONG_SECRET = 'x'.repeat(40); // > 32 bytes
const MAX_3GIB = '3221225472';

/** Everything a production deploy needs for uploads to be enabled. */
const PROD_READY = { NODE_ENV: 'production', ...S3_FULL, UPLOAD_SECRET: STRONG_SECRET, MAX_UPLOAD_BYTES: MAX_3GIB };

/* ---------------- production requires a real bucket ---------------- */

test('production with NOTHING configured disables uploads', () => {
  const a = getUploadAvailability({ NODE_ENV: 'production' });
  assert.equal(a.enabled, false);
  assert.equal(a.mode, 'disabled');
  assert.match(a.reason, /object storage/i);
});

test('production without S3 does NOT fall back to the local filesystem adapter', () => {
  // The whole point: real user videos must never land on an ephemeral disk.
  const a = getUploadAvailability({ NODE_ENV: 'production', UPLOAD_SECRET: STRONG_SECRET, MAX_UPLOAD_BYTES: MAX_3GIB });
  assert.equal(a.enabled, false);
  assert.notEqual(a.mode, 'local-dev');
  assert.equal(a.mode, 'disabled');
});

test('production with a COMPLETE bucket + strong secret + max enables S3 uploads', () => {
  const a = getUploadAvailability(PROD_READY);
  assert.equal(a.enabled, true);
  assert.equal(a.mode, 's3');
  assert.equal(a.reason, undefined);
});

test('production with a bucket but NO MAX_UPLOAD_BYTES stays disabled', () => {
  const { MAX_UPLOAD_BYTES, ...noMax } = PROD_READY;
  void MAX_UPLOAD_BYTES;
  const a = getUploadAvailability(noMax);
  assert.equal(a.enabled, false);
  assert.match(a.reason, /MAX_UPLOAD_BYTES/);
});

test('production with a bucket but a WEAK/absent secret stays disabled', () => {
  const a = getUploadAvailability({ NODE_ENV: 'production', ...S3_FULL, MAX_UPLOAD_BYTES: MAX_3GIB });
  assert.equal(a.enabled, false);
  assert.match(a.reason, /UPLOAD_SECRET/);
});

test('production with a PARTIAL bucket (one key missing) stays disabled', () => {
  const { S3_SECRET_ACCESS_KEY, ...partial } = S3_FULL;
  void S3_SECRET_ACCESS_KEY;
  const a = getUploadAvailability({ NODE_ENV: 'production', ...partial, UPLOAD_SECRET: STRONG_SECRET, MAX_UPLOAD_BYTES: MAX_3GIB });
  assert.equal(a.enabled, false);
  assert.equal(a.mode, 'disabled');
});

test('a disabled reason never echoes the secret value', () => {
  // Missing max, but the secret IS set — the reason must not leak it.
  const a = getUploadAvailability({ NODE_ENV: 'production', ...S3_FULL, UPLOAD_SECRET: STRONG_SECRET });
  assert.equal(a.enabled, false);
  assert.ok(!a.reason.includes(STRONG_SECRET), 'reason must not contain the secret');
});

/* ---------------- development keeps working with no setup ---------------- */

test('development with no S3 keeps the local dev-upload path enabled', () => {
  const a = getUploadAvailability({ NODE_ENV: 'development' });
  assert.equal(a.enabled, true);
  assert.equal(a.mode, 'local-dev');
});

test('an unset NODE_ENV is treated as development (uploads enabled, local-dev)', () => {
  const a = getUploadAvailability({});
  assert.equal(a.enabled, true);
  assert.equal(a.mode, 'local-dev');
});

test('development with a complete bucket + strong secret uses S3', () => {
  const a = getUploadAvailability({ NODE_ENV: 'development', ...S3_FULL, UPLOAD_SECRET: STRONG_SECRET });
  assert.equal(a.enabled, true);
  assert.equal(a.mode, 's3');
});

test('the test harness (NODE_ENV=test, no S3) keeps uploads enabled', () => {
  // The browser/e2e harness runs NODE_ENV=test with a mock bucket; availability
  // must never disable uploads there or the whole upload matrix goes dark.
  const a = getUploadAvailability({ NODE_ENV: 'test' });
  assert.equal(a.enabled, true);
  assert.notEqual(a.mode, 'disabled');
});

/* ---------------- MAX_UPLOAD_BYTES parsing ---------------- */

test('isMaxUploadBytesConfigured accepts only explicit positive integers', () => {
  assert.equal(isMaxUploadBytesConfigured({ MAX_UPLOAD_BYTES: '3221225472' }), true);
  assert.equal(isMaxUploadBytesConfigured({ MAX_UPLOAD_BYTES: '1' }), true);
  assert.equal(isMaxUploadBytesConfigured({}), false, 'unset');
  assert.equal(isMaxUploadBytesConfigured({ MAX_UPLOAD_BYTES: '' }), false, 'blank');
  assert.equal(isMaxUploadBytesConfigured({ MAX_UPLOAD_BYTES: '   ' }), false, 'whitespace');
  assert.equal(isMaxUploadBytesConfigured({ MAX_UPLOAD_BYTES: '0' }), false, 'zero');
  assert.equal(isMaxUploadBytesConfigured({ MAX_UPLOAD_BYTES: '-5' }), false, 'negative');
  assert.equal(isMaxUploadBytesConfigured({ MAX_UPLOAD_BYTES: 'abc' }), false, 'non-numeric');
  assert.equal(isMaxUploadBytesConfigured({ MAX_UPLOAD_BYTES: '1.5' }), false, 'non-integer');
});

/* ---------------- the intent handler enforces the switch ---------------- */

const baseConfig = (env) => createUploadRuntimeConfig(env, { objectStorage: false }).config;

test('createUploadIntent refuses every intent when uploadsEnabled is false', async () => {
  // A small, well-formed file that would normally succeed on the single-shot path.
  const storage = spyStorage();
  const uploadConfig = { ...baseConfig({}), uploadsEnabled: false };
  const result = await createUploadIntent({
    payload: { fileName: 'movie.mp4', mimeType: 'video/mp4', size: 5 * 1024 * 1024 },
    uploadConfig,
    storage,
    secret: 'x'.repeat(32),
    roomCode: 'ABC123',
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'UPLOADS_DISABLED');
  assert.equal(storage.total(), 0, 'a disabled deployment must never touch storage');
});

test('a config WITHOUT the flag is unaffected (older configs still upload)', async () => {
  // Explicit-false only: an undefined uploadsEnabled must not block uploads, so
  // tests and the staging preflight that predate the flag keep working.
  const storage = spyStorage();
  const uploadConfig = baseConfig({}); // no uploadsEnabled field at all
  const result = await createUploadIntent({
    payload: { fileName: 'movie.mp4', mimeType: 'video/mp4', size: 5 * 1024 * 1024 },
    uploadConfig,
    storage,
    secret: 'x'.repeat(32),
    roomCode: 'ABC123',
  });
  assert.equal(result.ok, true, 'a small file still uploads when the flag is absent');
  assert.equal(storage.calls.createUploadTarget, 1);
});
