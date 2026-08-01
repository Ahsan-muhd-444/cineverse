/**
 * Real-provider PREFLIGHT — server-side, before the browser matrix.
 *
 * The full staging matrix drives a real browser and takes minutes per gigabyte.
 * This runs first, in seconds, and catches the provider-specific failures that do
 * NOT need a browser: bad credentials, wrong endpoint/region, a missing bucket,
 * path-style vs virtual-host addressing, and whether the app resolves to the S3
 * adapter at all (vs. silently falling back to the dev filesystem).
 *
 * It reads the SAME env the app reads and uses the SAME storage adapter, so a pass
 * here means the server half of the pipeline works against your real bucket. It
 * does NOT prove browser CORS or ETag exposure — those are browser-side and are
 * what the direct staging matrix exercises next.
 *
 *   node scripts/staging-preflight.mjs
 *
 * Exits 0 on pass, non-zero on the first hard failure. Secrets are never printed.
 */

import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { describeS3Config } = require('../server/storage/s3-config.js');
const { createStorage } = require('../server/storage/index.js');
const { createUploadRuntimeConfig } = require('../server/uploads-multipart.js');

const HARD_3GIB = 3_221_225_472;
const log = (m) => console.log(`[preflight] ${m}`);
const fail = (m) => {
  console.error(`[preflight] FAIL: ${m}`);
  process.exit(1);
};

const env = process.env;

/* -------------------------------------------------------------------------- */
/*  1. Config resolution (no network)                                         */
/* -------------------------------------------------------------------------- */

const s3 = describeS3Config(env);
const redacted = {
  S3_ENDPOINT: env.S3_ENDPOINT || '(unset)',
  S3_BUCKET: env.S3_BUCKET || '(unset)',
  S3_REGION: env.S3_REGION || 'auto',
  S3_FORCE_PATH_STYLE: env.S3_FORCE_PATH_STYLE ?? '(default 1 / path-style)',
  S3_ACCESS_KEY_ID: env.S3_ACCESS_KEY_ID ? '(set)' : '(unset)',
  S3_SECRET_ACCESS_KEY: env.S3_SECRET_ACCESS_KEY ? '(set)' : '(unset)',
  UPLOAD_SECRET: env.UPLOAD_SECRET ? `(set, ${Buffer.byteLength(String(env.UPLOAD_SECRET), 'utf8')} bytes)` : '(unset)',
  MAX_UPLOAD_BYTES: env.MAX_UPLOAD_BYTES || '(unset)',
  UPLOAD_PART_SIZE_BYTES: env.UPLOAD_PART_SIZE_BYTES || '(default)',
  UPLOAD_PART_CONCURRENCY: env.UPLOAD_PART_CONCURRENCY || '(default 3)',
};
log('environment (secrets redacted):');
for (const [k, v] of Object.entries(redacted)) log(`  ${k.padEnd(24)} ${v}`);

if (s3.state !== 'complete') {
  fail(
    `object storage is "${s3.state}", not "complete" — the app would use the dev filesystem adapter. ` +
      `Set all four of S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY.` +
      (s3.errors && s3.errors.length ? ` (${s3.errors.join('; ')})` : ''),
  );
}
log('object storage config: COMPLETE');

// The runtime config the app would derive, with the REAL adapter.
const storage = createStorage(env);
const { config, errors } = createUploadRuntimeConfig(env, {
  objectStorage: true,
  storage,
  // The app mounts the full contract; assume it here so readiness reflects the
  // storage + secret, which is what a bucket misconfig actually affects.
  contract: {
    mounted: true,
    events: [
      'upload:intent',
      'upload:part-targets',
      'upload:status',
      'upload:renew',
      'upload:complete',
      'upload:abort',
      'upload:room-progress',
    ],
  },
});
if (errors && errors.length) fail(`upload config errors: ${errors.join('; ')}`);

log(`effective max: ${config.effectiveMaxBytes} bytes (${(config.effectiveMaxBytes / 2 ** 30).toFixed(2)} GiB)`);
log(`multipart max: ${config.multipartMaxBytes} bytes · single-shot max: ${config.singleShotMaxBytes} bytes`);
log(`part size: ${config.partSizeBytes} · concurrency: ${config.partConcurrency} · session TTL: ${config.sessionTtlSeconds}s · absolute: ${config.sessionMaxLifetimeSeconds}s`);
log(`multipart enabled: ${config.multipartEnabled}${config.multipartReadiness?.reason ? ` (${config.multipartReadiness.reason})` : ''}`);

if (config.effectiveMaxBytes < HARD_3GIB) {
  fail(`effective max ${config.effectiveMaxBytes} < 3 GiB (${HARD_3GIB}). Set MAX_UPLOAD_BYTES=${HARD_3GIB}.`);
}
if (!config.multipartEnabled) {
  fail(`multipart is NOT enabled: ${config.multipartReadiness?.reason || 'unknown'}. A 3 GiB upload cannot proceed.`);
}
if (config.singleShotMaxBytes >= HARD_3GIB) {
  fail('single-shot ceiling is not clamped below the hard local limit — a large file would take the wrong transport.');
}
if (typeof storage !== 'object' || storage.direct !== true || storage.multipart !== true) {
  fail('the resolved adapter is not the S3 (direct, multipart) adapter.');
}
log('config resolution: PASS — the app will use the S3 provider for a 3 GiB multipart upload.');

/* -------------------------------------------------------------------------- */
/*  2. Live provider round-trip (server-side)                                 */
/* -------------------------------------------------------------------------- */

const key = `rooms/PREFLIGHT/${crypto.randomBytes(8).toString('hex')}/preflight.mp4`;
log(`live smoke against the real bucket, key=${key}`);

let uploadId;
try {
  const created = await storage.createMultipartUpload({ key, mimeType: 'video/mp4' });
  uploadId = created?.uploadId;
  if (!uploadId) fail('createMultipartUpload returned no uploadId.');
  log(`  createMultipartUpload OK — uploadId=${String(uploadId).slice(0, 16)}…`);
} catch (err) {
  fail(`createMultipartUpload threw — check endpoint/region/credentials/bucket: ${err?.message || err}`);
}

try {
  const target = await storage.createPartUploadTarget({
    key,
    uploadId,
    partNumber: 1,
    expiresIn: 900,
    expectedBytes: 16 * 1024 * 1024,
  });
  if (!target || typeof target.url !== 'string' || !target.url.startsWith('http')) {
    fail('createPartUploadTarget did not return a usable presigned URL.');
  }
  // The browser must receive ONLY a presigned URL — never the secret.
  if (target.url.includes(String(env.S3_SECRET_ACCESS_KEY))) fail('SECURITY: the secret key leaked into the presigned URL.');
  log(`  createPartUploadTarget OK — presigned PUT URL host=${new URL(target.url).host}`);
} catch (err) {
  // Abort before failing so we do not leave an open multipart upload behind.
  await storage.abortMultipartUpload({ key, uploadId }).catch(() => {});
  fail(`createPartUploadTarget threw: ${err?.message || err}`);
}

try {
  await storage.abortMultipartUpload({ key, uploadId });
  log('  abortMultipartUpload OK — no multipart upload left open by the preflight');
} catch (err) {
  fail(`abortMultipartUpload threw — provider cleanup is broken: ${err?.message || err}`);
}

try {
  const stat = await storage.statObject(`rooms/PREFLIGHT/${crypto.randomBytes(8).toString('hex')}/absent.mp4`);
  if (stat !== null) fail('statObject on a missing key did not return null.');
  log('  statObject(missing) OK — HEAD path returns null for an absent object');
} catch (err) {
  fail(`statObject threw on a missing key (should be null): ${err?.message || err}`);
}

log('LIVE SMOKE: PASS');
log('');
log('Preflight PASSED. The server half works against your real bucket.');
log('Next: browser CORS + ETag + real byte transfer are proven by the staging matrix');
log('(run against a browser origin your bucket CORS allows).');
process.exit(0);
