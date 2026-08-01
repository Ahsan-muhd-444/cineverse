/**
 * Shared upload limits and primitive validators.
 *
 * Dependency-neutral on purpose: it requires nothing. `uploads.js`,
 * `uploads-multipart.js` and `storage/s3-multipart.js` all need the same
 * ceilings and the same ETag rule, and routing those through each other would
 * create an import cycle (uploads-multipart -> uploads, s3-multipart ->
 * uploads-multipart -> storage -> s3 -> s3-multipart).
 *
 * Everything here is a constant or a pure predicate. One definition each, so a
 * limit can never be enforced differently in two places.
 */

/**
 * The absolute product ceiling. Not configurable upward: a larger requested
 * value is a configuration error, not a bigger product.
 */
const HARD_MAX_BYTES = 3 * 1024 * 1024 * 1024; // 3 GiB

/** Historical single-upload default, retained so this change moves no limit. */
const DEFAULT_MAX_BYTES = 500 * 1024 * 1024; // 500 MiB

/**
 * The ceiling for the dev filesystem adapter, which NO environment variable can
 * raise.
 *
 * The bypass this closes: setting MAX_UPLOAD_BYTES and LOCAL_UPLOAD_MAX_BYTES
 * both to 3 GiB made `requiresObjectStorage` false (max was not above local),
 * so startup succeeded with local-fs and the runtime then accepted a 3 GiB
 * intent — streaming gigabytes through Node, which is the exact architecture
 * this work exists to avoid. `LOCAL_UPLOAD_MAX_BYTES` can now only ever lower
 * the local limit, never raise it.
 */
const HARD_LOCAL_UPLOAD_BYTES = 500 * 1024 * 1024; // 500 MiB

/*
 * DELIBERATELY a separate literal from DEFAULT_MAX_BYTES, not an alias.
 *
 * They happen to be equal today. Writing `= DEFAULT_MAX_BYTES` would mean that
 * raising the product default later — a routine product decision — silently
 * raises the Node/filesystem safety ceiling too, which is a security decision
 * nobody would be making on purpose. The invariant is pinned by a test.
 */

/** S3 hard cap on parts in one multipart upload. */
const S3_MAX_PART_COUNT = 10_000;

/** Largest ETag we will carry. Real ones are ~34 chars; this is pure defence. */
const MAX_ETAG_LENGTH = 1024;

/**
 * C0 (0x00-0x1F) and C1 (0x80-0x9F) control ranges, plus DEL (0x7F).
 * C1 matters because a raw 0x85 (NEL) is a line break to some parsers, so an
 * ETag containing one could still smuggle a newline into a log or a header.
 */
// eslint-disable-next-line no-control-regex
const ETAG_FORBIDDEN = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f]');

/**
 * Validate an ETag as an OPAQUE provider token.
 *
 * Not a shape check: an ETag is opaque by contract. S3 returns MD5-shaped
 * values for plaintext uploads, but SSE-KMS objects, R2, MinIO and Ceph return
 * other shapes, and a shape check silently rejects valid providers. Quoting is
 * never manufactured either — a provider that compares byte-for-byte would
 * reject a value we rewrote.
 *
 * @returns {string|null} the value EXACTLY as received, or null
 */
function normalizeEtag(value) {
  if (typeof value !== 'string') return null;
  if (value.length === 0 || value.length > MAX_ETAG_LENGTH) return null;
  if (ETAG_FORBIDDEN.test(value)) return null;
  return value;
}

const isPositiveSafeInteger = (value) => Number.isSafeInteger(value) && value > 0;

/** A non-empty string within a length bound. Used for opaque provider ids. */
function isBoundedString(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

/**
 * Minimum UPLOAD_SECRET strength for large uploads, in UTF-8 BYTES.
 *
 * Bytes, not characters: 32 emoji is not 32 bytes of entropy in the sense that
 * matters to HMAC. A multipart session must outlive a deploy — its token is the
 * only thing that can resume a 3 GB upload — so the secret has to be both stable
 * and strong. A weak one is worse than none: it looks durable while being
 * guessable, and it signs the entire authorization for writing parts.
 */
const MIN_UPLOAD_SECRET_BYTES = 32;

/**
 * Is this a secret strong enough to sign resumable sessions with?
 *
 * ONE definition, shared by startup validation (server/config.js) and multipart
 * readiness (uploads-multipart.js). Two copies of "strong enough" would let the
 * process refuse to boot on a secret the runtime would have accepted, or worse
 * boot happily and then enable a feature startup thought it had blocked.
 */
function isStrongUploadSecret(raw) {
  if (typeof raw !== 'string' && typeof raw !== 'number') return false;
  const text = String(raw);
  if (text.trim() === '') return false;
  return Buffer.byteLength(text, 'utf8') >= MIN_UPLOAD_SECRET_BYTES;
}

/** A provider part number: already a number, integral, and within S3's range. */
function isValidPartNumber(value) {
  return Number.isSafeInteger(value) && value >= 1 && value <= S3_MAX_PART_COUNT;
}

/** A provider part size: already a number, integral, non-negative. */
function isValidPartSize(value) {
  return Number.isSafeInteger(value) && value >= 0;
}


/* -------------------------------------------------------------------------- */
/*  Object-key and MIME primitives                                            */
/* -------------------------------------------------------------------------- */

/**
 * Browser-playable containers only. No transcoding phase, so what we accept is
 * exactly what a <video> element can stream back.
 *
 * These live here rather than in uploads.js because the grant validator below
 * needs them, and uploads.js needs the grant validator. One home, no cycle.
 */
const ALLOWED_MIME = Object.freeze({
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/ogg': '.ogv',
});

/** Canonical extension for an accepted MIME type. */
function extensionFor(mimeType) {
  return ALLOWED_MIME[String(mimeType || '').toLowerCase()] || '';
}

function isAllowedMime(mimeType) {
  return Boolean(extensionFor(mimeType));
}

/** The only key shape the read/write endpoints will ever accept back. */
const KEY_PATTERN = /^rooms\/[A-Z0-9]{1,12}\/[a-f0-9]{16,64}\/[A-Za-z0-9._-]{1,120}$/;

function isValidKey(key) {
  return KEY_PATTERN.test(String(key || ''));
}

/**
 * The CANONICAL room code: uppercase alphanumeric, 1-12 characters.
 *
 * Uppercase-only on purpose. It used to accept `[A-Za-z0-9]` and the room/key
 * check compared `keyRoom !== roomCode.toUpperCase()`, so a grant claiming
 * `abc123` against a key under `rooms/ABC123/` validated — and then the token
 * PRESERVED `abc123`, while `upload:complete` compares the claim byte-for-byte
 * with the room's own (always uppercase) code. The result was a signed,
 * "valid" token that could never be redeemed.
 *
 * One representation, validated and stored. Every room code the server produces
 * is already uppercased at creation and at join (server.js), so nothing
 * reachable changes; a non-canonical claim now fails loudly at issuance instead
 * of quietly at completion.
 */
const ROOM_CODE_PATTERN = /^[A-Z0-9]{1,12}$/;

/** The room segment encoded in an object key, or null. */
function roomFromKey(key) {
  const match = /^rooms\/([A-Z0-9]{1,12})\//.exec(String(key || ''));
  return match ? match[1] : null;
}

/* -------------------------------------------------------------------------- */
/*  The single-shot grant contract                                            */
/* -------------------------------------------------------------------------- */

/**
 * ONE definition of a valid single-shot upload grant.
 *
 * Issuance, verification, the storage policy and completion all had their own
 * partial version of these rules, and the whole class of bug in this work has
 * been those copies disagreeing: the issuer minting a deployment-wide cap, the
 * policy trusting whatever it was handed, completion accepting an object whose
 * size nobody had pinned. A grant is either valid here or it does not exist.
 *
 * @returns {{ok:true} | {ok:false, error:string}}
 */
function validateSingleUploadGrant(grant) {
  if (!grant || typeof grant !== 'object') return { ok: false, error: 'BAD_GRANT' };

  if (grant.transport !== 'single') return { ok: false, error: 'BAD_TRANSPORT' };
  if (!isValidKey(grant.key)) return { ok: false, error: 'BAD_KEY' };
  if (!isAllowedMime(grant.mimeType)) return { ok: false, error: 'UNSUPPORTED_TYPE' };
  /*
   * The key's extension must match the MIME it is signed for. buildObjectKey
   * already guarantees this, so preserving the invariant here costs nothing for
   * real keys and stops a hand-built internal grant from signing an object
   * whose stored name disagrees with its declared type.
   */
  if (!String(grant.key).toLowerCase().endsWith(extensionFor(grant.mimeType))) {
    return { ok: false, error: 'KEY_TYPE_MISMATCH' };
  }

  const roomCode = grant.roomCode;
  if (typeof roomCode !== 'string' || !ROOM_CODE_PATTERN.test(roomCode)) return { ok: false, error: 'BAD_ROOM' };
  /*
   * The room in the key and the room in the grant must be the SAME STRING, or a
   * member of room A could complete an object minted under room B's prefix.
   *
   * Compared exactly, with no case folding: both sides are canonical by
   * contract, so folding here would only re-open the accept-one-shape /
   * store-another gap that made unredeemable tokens possible.
   */
  const keyRoom = roomFromKey(grant.key);
  if (keyRoom === null || keyRoom !== roomCode) return { ok: false, error: 'ROOM_KEY_MISMATCH' };

  const { expectedBytes, maxBytes } = grant;
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0) return { ok: false, error: 'BAD_SIZE' };
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return { ok: false, error: 'BAD_LIMIT' };
  if (expectedBytes > maxBytes) return { ok: false, error: 'SIZE_EXCEEDS_LIMIT' };
  // A single-shot grant may never authorize more than the local transport
  // ceiling, whatever the deployment's configured maximum happens to be.
  if (maxBytes > HARD_LOCAL_UPLOAD_BYTES) return { ok: false, error: 'LIMIT_TOO_HIGH' };
  if (maxBytes > HARD_MAX_BYTES) return { ok: false, error: 'LIMIT_TOO_HIGH' };

  return { ok: true };
}

module.exports = {
  HARD_MAX_BYTES,
  ALLOWED_MIME,
  KEY_PATTERN,
  ROOM_CODE_PATTERN,
  extensionFor,
  isAllowedMime,
  isValidKey,
  roomFromKey,
  validateSingleUploadGrant,
  DEFAULT_MAX_BYTES,
  HARD_LOCAL_UPLOAD_BYTES,
  S3_MAX_PART_COUNT,
  MAX_ETAG_LENGTH,
  MIN_UPLOAD_SECRET_BYTES,
  normalizeEtag,
  isPositiveSafeInteger,
  isBoundedString,
  isStrongUploadSecret,
  isValidPartNumber,
  isValidPartSize,
};
