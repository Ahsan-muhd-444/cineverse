/**
 * The single answer to "is object storage configured?".
 *
 * Dependency-neutral: requires nothing, so `validateConfig`, `createStorage`,
 * `createUploadRuntimeConfig` and startup reporting can all consult it without
 * import cycles.
 *
 * The bug it closes: `config.js` treated a whitespace-only value as UNSET (its
 * `isSet` trims), while `s3.js` treated it as SET (`Boolean(' ')` is true). So
 * `S3_BUCKET="   "` made startup report `storage: local-fs` while the runtime
 * built the S3 adapter and every upload failed against a bucket named " ".
 * Reporting and selection must agree by construction, not by coincidence.
 *
 * Four distinguishable states:
 *   absent    — nothing meaningful set; the dev filesystem adapter is correct
 *   partial   — some set, some not; always an operator mistake
 *   invalid   — all set but a value cannot work (bad endpoint, padded secret)
 *   complete  — usable
 */

const S3_KEYS = Object.freeze(['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']);

/** Meaningful presence. Trimming decides BLANKNESS only — never the value. */
const isPresent = (value) => value !== undefined && value !== null && String(value).trim() !== '';

function parseHttpUrl(raw) {
  try {
    const url = new URL(String(raw));
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * Classify the object-storage configuration in `env`.
 *
 * @returns {{
 *   state: 'absent'|'partial'|'invalid'|'complete',
 *   configured: boolean,
 *   present: string[], missing: string[], errors: string[],
 *   config: object|null,
 * }}
 */
function describeS3Config(env = process.env) {
  const present = S3_KEYS.filter((key) => isPresent(env[key]));
  const missing = S3_KEYS.filter((key) => !isPresent(env[key]));
  const errors = [];

  if (present.length === 0) {
    return { state: 'absent', configured: false, present, missing, errors, config: null };
  }
  if (missing.length > 0) {
    errors.push(
      `Object storage is partially configured: ${present.join(', ')} set but ${missing.join(', ')} missing. ` +
        'Set all four or none — a partial config silently falls back to the dev filesystem adapter.',
    );
    return { state: 'partial', configured: false, present, missing, errors, config: null };
  }

  // All four present. Now: are they usable?
  const endpointRaw = String(env.S3_ENDPOINT);
  const endpointUrl = parseHttpUrl(endpointRaw.trim());
  if (!endpointUrl) {
    errors.push(`S3_ENDPOINT must be an http(s) URL (got "${endpointRaw}")`);
  }

  if (isPresent(env.S3_PUBLIC_BASE_URL) && !parseHttpUrl(String(env.S3_PUBLIC_BASE_URL).trim())) {
    errors.push(`S3_PUBLIC_BASE_URL must be an http(s) URL (got "${env.S3_PUBLIC_BASE_URL}")`);
  }

  /*
   * Credentials are used VERBATIM — silently trimming would change a secret
   * that legitimately contains padding, and the operator would see an opaque
   * SignatureDoesNotMatch instead of a configuration error. So surrounding
   * whitespace is rejected explicitly rather than repaired.
   */
  for (const key of ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) {
    const raw = String(env[key]);
    if (raw !== raw.trim()) {
      errors.push(`${key} has leading or trailing whitespace — remove it rather than relying on it being trimmed`);
    }
  }

  if (errors.length > 0) {
    return { state: 'invalid', configured: false, present, missing, errors, config: null };
  }

  const readTtl = Number(env.UPLOAD_READ_TTL_SECONDS);
  return {
    state: 'complete',
    configured: true,
    present,
    missing,
    errors,
    config: {
      // Only the endpoint is normalised (trailing slashes are meaningless in a
      // URL base); credentials pass through untouched.
      endpoint: endpointRaw.trim().replace(/\/+$/, ''),
      bucket: String(env.S3_BUCKET),
      accessKeyId: String(env.S3_ACCESS_KEY_ID),
      secretAccessKey: String(env.S3_SECRET_ACCESS_KEY),
      region: isPresent(env.S3_REGION) ? String(env.S3_REGION).trim() : 'auto',
      publicBaseUrl: isPresent(env.S3_PUBLIC_BASE_URL)
        ? String(env.S3_PUBLIC_BASE_URL).trim().replace(/\/+$/, '')
        : '',
      readTtl: Number.isFinite(readTtl) && readTtl > 0 ? readTtl : 21600,
    },
  };
}

/** The one predicate. True only for a complete, valid configuration. */
function isS3Configured(env = process.env) {
  return describeS3Config(env).state === 'complete';
}

module.exports = { S3_KEYS, describeS3Config, isS3Configured, isPresent };
