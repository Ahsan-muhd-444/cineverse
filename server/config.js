/**
 * Startup validation of operational configuration.
 *
 * The failure this exists to prevent is the quiet one: a deploy with three of
 * the four S3 variables set boots perfectly happily, silently picks the dev
 * filesystem adapter, and then loses every uploaded film on the next restart.
 * Nobody finds out until someone asks where their video went.
 *
 * So the rules are:
 *   - a value that is MEANINGLESS (a port of "banana") is an error;
 *   - a value that is merely out of range, where the code already clamps by
 *     design, is a warning that reports what will actually be used;
 *   - a PARTIAL group of related variables is always an error, in every
 *     environment — it is unambiguously a mistake, and the fallback is worse
 *     than not booting;
 *   - secrets are never printed back, only their presence.
 *
 * Pure: takes an env object, returns a report. Deciding what to do about a bad
 * report (exit, or warn and carry on in development) belongs to server.js.
 */

const { createUploadRuntimeConfig, requiresObjectStorage } = require('./uploads-multipart');
const { describeS3Config, S3_KEYS: SHARED_S3_KEYS } = require('./storage/s3-config');

const S3_KEYS = SHARED_S3_KEYS;

/** A value the operator actually set — empty string counts as unset. */
function isSet(value) {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function parseUrl(raw) {
  try {
    const url = new URL(String(raw));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url;
  } catch {
    return null;
  }
}

/**
 * Validate the environment.
 *
 * @param {Record<string,string|undefined>} env
 * @param {{production?: boolean}} [options]
 * @returns {{ok:boolean, errors:string[], warnings:string[], summary:Record<string,unknown>}}
 */
function validateConfig(env = process.env, options = {}) {
  const production = options.production ?? env.NODE_ENV === 'production';
  const errors = [];
  const warnings = [];
  const summary = {};

  /* ---------------- network ---------------- */

  if (isSet(env.PORT)) {
    const port = Number(env.PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      errors.push(`PORT must be an integer between 1 and 65535 (got "${env.PORT}")`);
    } else {
      summary.port = port;
    }
  } else {
    summary.port = 3000;
  }

  if (isSet(env.HOST) && /\s/.test(String(env.HOST))) {
    errors.push(`HOST must not contain whitespace (got "${env.HOST}")`);
  }
  summary.host = isSet(env.HOST) ? String(env.HOST) : '0.0.0.0';

  /* ---------------- rooms ---------------- */

  if (isSet(env.ROOM_RECONNECT_GRACE_MS)) {
    const grace = Number(env.ROOM_RECONNECT_GRACE_MS);
    if (!Number.isFinite(grace) || grace < 0) {
      errors.push(`ROOM_RECONNECT_GRACE_MS must be a non-negative number (got "${env.ROOM_RECONNECT_GRACE_MS}")`);
    } else {
      // A very long grace holds seats — and their WebRTC routing — for people
      // who are never coming back.
      if (grace > 10 * 60_000) warnings.push(`ROOM_RECONNECT_GRACE_MS is ${grace}ms — seats will be held for a long time`);
      summary.reconnectGraceMs = Math.floor(grace);
    }
  }

  /* ---------------- abuse limits ---------------- */

  if (isSet(env.RATE_LIMIT_TRUST_PROXY) && !['0', '1'].includes(String(env.RATE_LIMIT_TRUST_PROXY).trim())) {
    errors.push(`RATE_LIMIT_TRUST_PROXY must be "0" or "1" (got "${env.RATE_LIMIT_TRUST_PROXY}")`);
  }
  const trustProxy = String(env.RATE_LIMIT_TRUST_PROXY || '0').trim() === '1';
  summary.trustProxy = trustProxy;
  if (production && trustProxy) {
    // Worth saying out loud: with this on, x-forwarded-for decides someone's
    // rate-limit identity, so an untrusted hop upstream hands out free capacity.
    warnings.push('RATE_LIMIT_TRUST_PROXY=1 — only correct when a trusted proxy sets x-forwarded-for');
  }

  for (const key of ['CHAT_ATTACHMENT_MAX_BYTES', 'CHAT_HISTORY_MAX_BYTES']) {
    if (!isSet(env[key])) continue;
    const value = Number(env[key]);
    if (!Number.isFinite(value) || value <= 0) {
      errors.push(`${key} must be a positive number of bytes (got "${env[key]}")`);
    } else {
      summary[key] = Math.floor(value);
    }
  }

  if (isSet(env.UPLOAD_TTL_HOURS)) {
    const hours = Number(env.UPLOAD_TTL_HOURS);
    if (!Number.isFinite(hours) || hours <= 0) {
      errors.push(`UPLOAD_TTL_HOURS must be a positive number (got "${env.UPLOAD_TTL_HOURS}")`);
    } else {
      summary.uploadTtlHours = hours;
    }
  }

  /* ---------------- shared multipart uploads ---------------- */

  // Built through the SAME factory the runtime uses, with the same storage
  // signal, so the reported ceiling is by construction the enforced ceiling.
  const storage = describeS3Config(env);
  const storageConfigured = storage.state === 'complete';
  const multipart = createUploadRuntimeConfig(env, { objectStorage: storageConfigured });
  errors.push(...multipart.errors);
  warnings.push(...multipart.warnings);
  summary.maxUploadBytes = multipart.config.maxUploadBytes;
  summary.effectiveMaxUploadBytes = multipart.config.effectiveMaxBytes;
  summary.localUploadMaxBytes = multipart.config.localMaxUploadBytes;
  summary.uploadPartSizeBytes = multipart.config.partSizeBytes;
  summary.uploadPartConcurrency = multipart.config.partConcurrency;

  const needsObjectStorage = requiresObjectStorage(multipart.config);

  if (needsObjectStorage && !storageConfigured) {
    // Above the local ceiling the dev filesystem adapter is not a degraded
    // option, it is the wrong architecture: it would stream gigabytes through
    // this process. Refuse rather than advertise a size we cannot honour.
    const message =
      `MAX_UPLOAD_BYTES (${multipart.config.maxUploadBytes}) exceeds LOCAL_UPLOAD_MAX_BYTES ` +
      `(${multipart.config.localMaxUploadBytes}) but object storage is not configured. ` +
      `Large shared uploads require ${S3_KEYS.join(', ')}.`;
    if (production) errors.push(message);
    else warnings.push(`${message} Local development will cap uploads at the local limit.`);
  }

  /*
   * Production large-upload operation needs a STRONG, stable secret.
   *
   * A per-boot random secret is survivable for single-shot uploads, but a
   * multipart session must outlive a deploy: a 3 GB upload can still be in
   * flight, and its token is the only thing that can resume it. A weak secret
   * is worse than none — it looks durable while being guessable, and the token
   * it signs is the entire authorization for writing parts.
   *
   * Measured in UTF-8 BYTES, not characters: 32 emoji is not 32 bytes of
   * entropy in the sense that matters to HMAC. The value itself is never
   * printed, only its adequacy.
   */
  const secretRaw = env.UPLOAD_SECRET;
  const secretSet = isSet(secretRaw);
  const secretBytes = secretSet ? Buffer.byteLength(String(secretRaw), 'utf8') : 0;
  const secretStrong = secretSet && String(secretRaw).trim() !== '' && secretBytes >= 32;

  if (production && needsObjectStorage) {
    if (!secretSet) {
      errors.push(
        'UPLOAD_SECRET is unset — multipart upload sessions cannot survive a restart, so an in-flight large upload would be unresumable',
      );
    } else if (!secretStrong) {
      errors.push(
        `UPLOAD_SECRET is too weak for large uploads: it must be at least 32 bytes of non-whitespace (got ${secretBytes} bytes)`,
      );
    }
  } else if (production && !secretSet) {
    warnings.push('UPLOAD_SECRET is unset — upload tokens are random per boot and will not survive a restart');
  } else if (production && !secretStrong) {
    warnings.push(`UPLOAD_SECRET is shorter than the recommended 32 bytes (got ${secretBytes} bytes)`);
  }
  // Presence and adequacy only — never the value.
  summary.uploadSecret = secretSet ? (secretStrong ? 'set (strong)' : 'set (weak)') : 'unset';

  /* ---------------- object storage ---------------- */

  // One verdict, shared with createStorage — see storage/s3-config.js.
  errors.push(...storage.errors);
  summary.storage = storageConfigured ? 's3' : 'local-fs';
  summary.storageState = storage.state;
  if (production && summary.storage === 'local-fs') {
    warnings.push('No object storage configured — uploads use the dev filesystem adapter and are lost on redeploy');
  }

  /* ---------------- WebRTC ---------------- */

  if (isSet(env.NEXT_PUBLIC_RTC_ICE_SERVERS)) {
    let parsed = null;
    try {
      parsed = JSON.parse(env.NEXT_PUBLIC_RTC_ICE_SERVERS);
    } catch {
      parsed = null;
    }
    const usable =
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every((s) => s && typeof s === 'object' && (typeof s.urls === 'string' ? s.urls : Array.isArray(s.urls) && s.urls.length));
    if (!usable) {
      // The client already falls back to public STUN, so this cannot break the
      // app — but silently losing a TURN server means calls fail behind NAT.
      warnings.push('NEXT_PUBLIC_RTC_ICE_SERVERS is not a usable JSON array of ICE servers — falling back to public STUN');
    } else {
      summary.iceServers = parsed.length;
      const hasTurn = parsed.some((s) => [].concat(s.urls).some((u) => String(u).startsWith('turn')));
      if (production && !hasTurn) warnings.push('No TURN server configured — calls will fail on restrictive networks');
    }
  } else if (production) {
    warnings.push('NEXT_PUBLIC_RTC_ICE_SERVERS is unset — public STUN only, so calls may fail behind symmetric NAT');
  }

  return { ok: errors.length === 0, errors, warnings, summary };
}

/**
 * Print a report. Secrets are never echoed — only the fact that they were set,
 * which is what an operator actually needs to debug a boot.
 */
function reportConfig(report, logger = console) {
  for (const warning of report.warnings) logger.warn(`  ! ${warning}`);
  for (const error of report.errors) logger.error(`  ✗ ${error}`);
  return report.ok;
}

module.exports = { validateConfig, reportConfig, S3_KEYS };
