/**
 * Whether hosted (shared) uploads are available on THIS deployment.
 *
 * The large-upload pipeline (multipart to object storage, single-shot to the dev
 * filesystem) is fully built and tested, but a deployment without an S3-compatible
 * bucket must not pretend it can host a 3 GiB film. Before this helper the only
 * refusal happened reactively, at `upload:intent` time, and single-shot uploads
 * through the dev filesystem adapter were accepted even in production — which would
 * quietly write real user videos onto an ephemeral container disk.
 *
 * This is the ONE place that answers "can this deployment accept an upload?", so
 * the server (socket enforcement + the room snapshot the client reads) and any
 * documentation all agree.
 *
 *   getUploadAvailability(env) -> { enabled, mode, reason? }
 *     mode 's3'        real object storage — hosted uploads work
 *     mode 'local-dev' dev-only filesystem adapter — fine for local testing only
 *     mode 'disabled'  production with no bucket — uploads are turned off
 *
 * Rules:
 *   - Production requires a COMPLETE S3 config AND a strong UPLOAD_SECRET AND an
 *     explicit MAX_UPLOAD_BYTES; anything missing => disabled. The dev filesystem
 *     adapter is NEVER used for real user videos in production.
 *   - Development/test keeps working with no setup: a real bucket is used when
 *     fully configured, otherwise the local filesystem adapter (mode 'local-dev').
 *
 * Secrets are never echoed — `reason` names which categories are missing, never a
 * value.
 */

const { describeS3Config } = require('./storage/s3-config');
const { isStrongUploadSecret } = require('./upload-limits');

/**
 * MAX_UPLOAD_BYTES counts as "configured" only when it is an explicit positive
 * whole number. An unset value falls back to a built-in default elsewhere, but for
 * the production gate the operator must have set it deliberately.
 */
function isMaxUploadBytesConfigured(env) {
  const raw = env.MAX_UPLOAD_BYTES;
  if (raw === undefined || raw === null || String(raw).trim() === '') return false;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0;
}

function getUploadAvailability(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const s3Complete = describeS3Config(env).state === 'complete';
  const secretConfigured = isStrongUploadSecret(env.UPLOAD_SECRET);
  const maxConfigured = isMaxUploadBytesConfigured(env);

  if (production) {
    if (s3Complete && secretConfigured && maxConfigured) {
      return { enabled: true, mode: 's3' };
    }
    // Production without a real bucket (or its guardrails) turns uploads OFF rather
    // than silently degrading to the dev filesystem adapter.
    const missing = [];
    if (!s3Complete) missing.push('S3-compatible object storage');
    if (!secretConfigured) missing.push('a strong UPLOAD_SECRET (32+ bytes)');
    if (!maxConfigured) missing.push('MAX_UPLOAD_BYTES');
    return {
      enabled: false,
      mode: 'disabled',
      reason: `Hosted uploads need ${missing.join(', ')} in production.`,
    };
  }

  // Development / test. A real bucket wins when fully configured; otherwise the
  // local filesystem adapter keeps a fresh clone working with no setup.
  if (s3Complete && secretConfigured) {
    return { enabled: true, mode: 's3' };
  }
  return {
    enabled: true,
    mode: 'local-dev',
    reason: 'Development uses the local filesystem adapter — configure S3 for production hosting.',
  };
}

module.exports = { getUploadAvailability, isMaxUploadBytesConfigured };
