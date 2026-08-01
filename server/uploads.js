/**
 * Upload validation + capability tokens for shared local-file playback.
 *
 * Pure and dependency-free (only node:crypto) so it can be unit-tested without
 * booting the server — see scripts/uploads.test.mjs.
 *
 * The security model in one line: the CLIENT never decides what is allowed.
 * A socket that is already an approved room member asks for an upload intent;
 * this module validates the metadata, mints a random object key and a
 * short-lived HMAC token that pins {key, mime, byte cap, room}. The HTTP upload
 * endpoint trusts only that token — never anything else the request carries.
 */

const crypto = require('crypto');
// Constants only — a dependency-neutral module, so this stays free of any
// import cycle with uploads-multipart.js.
const {
  HARD_MAX_BYTES,
  DEFAULT_MAX_BYTES,
  ALLOWED_MIME,
  extensionFor,
  isAllowedMime,
  isValidKey,
  validateSingleUploadGrant,
} = require('./upload-limits');

const TOKEN_TTL_MS = 15 * 60 * 1000; // long enough to upload 500MB on a slow line

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f]', 'g');

/*
 * There is deliberately NO maxUploadBytes() here any more.
 *
 * This module used to parse MAX_UPLOAD_BYTES itself, independently of
 * server/uploads-multipart.js. The two disagreed: this one accepted anything
 * `Number()` could coerce and floored it, while the multipart validator rejects
 * fractions, exponent notation and any value above 3 GiB. So a value could be
 * fatal at startup yet honoured at runtime — or accepted here and never
 * enforced anywhere.
 *
 * The single source of truth is now `createUploadRuntimeConfig()`. Callers pass
 * `opts.maxBytes` into `validateUploadIntent`; DEFAULT_MAX_BYTES below is only
 * the shared fallback constant, not an env parser.
 */

/**
 * Reduce a client-supplied file name to something safe to put on a disk or in
 * an object key. Takes the BASENAME only — a client may send
 * "../../etc/passwd" or "C:\\windows\\system32\\x" and neither may escape.
 */
function sanitizeFileName(name, mimeType) {
  const base = String(name || '').split(/[\\/]/).pop() || '';
  const cleaned = base
    .replace(CONTROL_CHARS, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    // A leading dot would make a hidden file; leading dashes confuse CLIs.
    .replace(/^[.\-]+/, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 120);
  const ext = extensionFor(mimeType);
  if (!cleaned) return `video${ext}`;
  // Force the extension to match the validated MIME type, so the stored object
  // can never claim to be something the allowlist did not approve.
  return cleaned.toLowerCase().endsWith(ext) ? cleaned : `${cleaned}${ext}`;
}

/**
 * Validate an upload intent. Returns `{ ok: true, fileName }` or
 * `{ ok: false, error }` with a machine-readable code the UI maps to copy.
 */
function validateUploadIntent(input = {}, opts = {}) {
  // The caller supplies the effective ceiling (see createUploadRuntimeConfig).
  // Validate the INTERNAL limit too: a fractional, negative, absent or
  // oversized ceiling must never silently become an unlimited boundary.
  /*
   * MANDATORY. There is no default here any more.
   *
   * This is an authorization boundary: the ceiling decides what a client is
   * allowed to upload. A silent fallback meant a caller who forgot to pass the
   * runtime limit still got a working-looking validator enforcing some other
   * number. Every production caller now passes an explicitly validated limit,
   * and forgetting is a loud BAD_LIMIT rather than a quiet wrong answer.
   */
  const supplied = opts.maxBytes;
  const limitOk = Number.isSafeInteger(supplied) && supplied > 0 && supplied <= HARD_MAX_BYTES;
  if (!limitOk) return { ok: false, error: 'BAD_LIMIT' };
  const maxBytes = supplied;

  const mimeType = String(input.mimeType || '').toLowerCase().split(';')[0].trim();
  if (!isAllowedMime(mimeType)) return { ok: false, error: 'UNSUPPORTED_TYPE' };

  // NO coercion. `Number("1048576")` used to turn a string into an accepted
  // size, and `Number.isFinite` let 1.5 through — a fractional byte count that
  // then drives part planning. The client sends a real number or nothing.
  const size = input.size;
  if (!Number.isSafeInteger(size) || size <= 0) return { ok: false, error: 'BAD_SIZE' };
  // Belt and braces: even a mis-derived ceiling can never admit > 3 GiB.
  if (size > HARD_MAX_BYTES) return { ok: false, error: 'TOO_LARGE' };
  if (size > maxBytes) return { ok: false, error: 'TOO_LARGE' };

  return { ok: true, fileName: sanitizeFileName(input.fileName, mimeType), mimeType, size, maxBytes };
}

/**
 * Build the object key. Room-scoped so a lifecycle rule (or the dev sweeper)
 * can expire a whole room's media, and carrying a random segment so a key is
 * unguessable — the key IS the capability for the dev filesystem adapter.
 *
 * Shape: rooms/<roomCode>/<randomId>/<sanitizedFileName>
 */
function buildObjectKey(roomCode, fileName, mimeType, randomId) {
  const code = String(roomCode || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 12).toUpperCase() || 'UNKNOWN';
  const id = randomId || crypto.randomBytes(12).toString('hex');
  return `rooms/${code}/${id}/${sanitizeFileName(fileName, mimeType)}`;
}

/* -------------------------------------------------------------------------- */
/*  Capability tokens                                                         */
/* -------------------------------------------------------------------------- */

const SINGLE_TOKEN_VERSION = 2;
/** Ample for a real grant (~250 bytes); refuses a payload bomb outright. */
const MAX_TOKEN_LENGTH = 2048;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const b64url = (buf) => Buffer.from(buf).toString('base64url');

/**
 * Version 2 single-shot grant.
 *
 * v1 pinned only a byte CAP, and the handler passed the deployment-wide
 * `effectiveMaxBytes` as that cap - so a client declaring 100 MiB received a
 * grant authorizing 3 GiB. v2 pins the declared size itself, plus the transport
 * the grant is valid for.
 *
 * v1 tokens are deliberately NOT accepted. They live 15 minutes, this is a
 * pre-release foundation phase with no rolling-deployment requirement, and the
 * point of the bump is that a v1 claim set cannot express the constraint we now
 * depend on. An in-flight v1 upload fails closed and the client retries.
 */
function issueUploadToken(payload, secret, ttlMs = TOKEN_TTL_MS, now = Date.now()) {
  /*
   * Validate BEFORE signing. A signature turns a claim set into a capability,
   * so the issuer must never mint one nobody checked. Tests that need a
   * deliberately malformed-but-correctly-signed token use a test-only signer
   * rather than weakening this.
   */
  const verdict = validateSingleUploadGrant(payload);
  if (!verdict.ok) {
    throw new Error(`issueUploadToken: refusing to sign an invalid grant (${verdict.error})`);
  }
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new Error(`issueUploadToken: ttlMs must be a positive safe integer, got ${JSON.stringify(ttlMs)}`);
  }
  const expiresAt = now + ttlMs;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) {
    throw new Error('issueUploadToken: computed expiry is not a usable timestamp');
  }
  const body = {
    v: SINGLE_TOKEN_VERSION,
    t: 'single',
    k: payload.key,
    m: payload.mimeType,
    // The DECLARED size, pinned. Everything downstream compares against this
    // exact number: the POST policy, the local stream, the completion HEAD.
    n: payload.expectedBytes,
    b: payload.maxBytes,
    r: payload.roomCode,
    e: expiresAt,
  };
  const encoded = b64url(JSON.stringify(body));
  const sig = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

/**
 * Verify a token and return its payload, or null. Constant-time signature
 * comparison; expiry is enforced here so a leaked token dies on its own.
 */
function verifyUploadToken(token, secret, now = Date.now()) {
  /*
   * Structural checks BEFORE any hashing or parsing. A 50 MB "token" should
   * cost a length comparison, not an HMAC over 50 MB followed by a JSON.parse
   * of whatever it decodes to.
   */
  if (typeof token !== 'string') return null;
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encoded, sig] = parts;
  if (!encoded || !sig) return null;
  if (!BASE64URL.test(encoded) || !BASE64URL.test(sig)) return null;

  const expected = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let body;
  try {
    body = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object') return null;
  // v1 is refused outright: it cannot carry an expectedBytes claim, and reading
  // a missing one as "the maximum" is exactly the hole this version closes.
  if (body.v !== SINGLE_TOKEN_VERSION) return null;
  // Expiry: a positive safe integer, strictly in the future.
  if (!Number.isSafeInteger(body.e) || body.e <= 0 || body.e <= now) return null;

  /*
   * A valid signature proves ORIGIN, not sanity. The same validator that gates
   * issuance gates verification - including the room/key agreement check - so
   * a leaked secret still cannot produce a grant the rest of the system honours.
   */
  const grant = {
    transport: body.t,
    key: body.k,
    mimeType: body.m,
    roomCode: body.r,
    expectedBytes: body.n,
    maxBytes: body.b,
  };
  if (!validateSingleUploadGrant(grant).ok) return null;

  return {
    version: body.v,
    transport: 'single',
    key: grant.key,
    mimeType: grant.mimeType,
    expectedBytes: grant.expectedBytes,
    maxBytes: grant.maxBytes,
    roomCode: grant.roomCode,
    expiresAt: body.e,
  };
}

module.exports = {
  ALLOWED_MIME,
  DEFAULT_MAX_BYTES,
  TOKEN_TTL_MS,
  SINGLE_TOKEN_VERSION,
  MAX_TOKEN_LENGTH,
  extensionFor,
  isAllowedMime,
  sanitizeFileName,
  validateUploadIntent,
  buildObjectKey,
  isValidKey,
  issueUploadToken,
  verifyUploadToken,
};
