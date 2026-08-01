/**
 * Storage provider selection.
 *
 * The rest of the server talks only to the MediaStorage shape below, so
 * swapping providers never reaches into route or socket code:
 *
 *   createUploadTarget({ key, mimeType, size, token }) -> UploadTarget
 *   createReadUrl(key)                                 -> string
 *   deleteObject?(key)                                 -> boolean
 *
 * S3-compatible storage is used whenever it is configured; otherwise the
 * dev-only filesystem adapter keeps a fresh clone working with no setup.
 */

const local = require('./local');
const { createS3Storage } = require('./s3');
const { describeS3Config, isS3Configured } = require('./s3-config');

/**
 * The TEST-ONLY mock HTTP bucket adapter.
 *
 * Selected ONLY when NODE_ENV is exactly 'test' AND an explicit `UPLOAD_TEST_MODE`
 * flag is set AND a bucket origin is supplied. Production refuses the flag
 * outright — a mock storage in production would silently drop every upload — and
 * normal development never sets it. This is what lets a real browser exercise the
 * multipart byte path without S3 credentials (see scripts/mock-bucket.mjs).
 */
function testModeRequested(env) {
  return env.UPLOAD_TEST_MODE === '1' || env.UPLOAD_TEST_MODE === 'true';
}

function createTestStorage(env) {
  if (env.NODE_ENV === 'production') {
    throw new Error('UPLOAD_TEST_MODE must never be set in production — it selects a mock bucket that loses uploads.');
  }
  if (env.NODE_ENV !== 'test') {
    throw new Error(`UPLOAD_TEST_MODE requires NODE_ENV=test, got ${JSON.stringify(env.NODE_ENV)}.`);
  }
  const origin = env.UPLOAD_TEST_BUCKET_ORIGIN;
  if (!origin) throw new Error('UPLOAD_TEST_MODE requires UPLOAD_TEST_BUCKET_ORIGIN (the mock bucket origin).');
  const { createMockHttpMultipartStorage } = require('./mock-http-multipart');
  return createMockHttpMultipartStorage({ origin });
}

/**
 * Pick the adapter.
 *
 * ONLY a `complete` configuration selects S3. `partial` and `invalid` fall back
 * to the dev adapter — and `validateConfig` turns both into startup errors, so
 * this fallback is never reached silently in production. Building the S3
 * adapter from a half-set or malformed config is the one outcome that must not
 * happen: it fails later, at upload time, against a bucket that cannot work.
 */
function createStorage(env = process.env) {
  if (testModeRequested(env)) return createTestStorage(env);
  return describeS3Config(env).state === 'complete' ? createS3Storage(env) : local;
}

module.exports = { createStorage, isS3Configured, describeS3Config };
