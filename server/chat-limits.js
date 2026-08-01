/**
 * Chat attachment validation + room history memory bounds.
 *
 * Attachments travel as data URLs through the socket and are held in the room's
 * in-memory history. Capping the history at 200 MESSAGES was not enough: 200
 * messages carrying 11MB data URLs is gigabytes in one Node process. So the
 * room also carries a BYTE budget, and attachments are sized from the payload
 * itself — never from the client-declared `size`, which is trivially forged.
 *
 * Pure and dependency-free; unit-tested in scripts/rate-limit.test.mjs.
 */

const DEFAULT_ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024; // 8 MiB decoded
const DEFAULT_HISTORY_MAX_BYTES = 24 * 1024 * 1024; // 24 MiB per room
// Base64 inflates by ~4/3; allow headroom plus the data-URL prefix, so the
// encoded ceiling is defence in depth rather than the primary limit.
const ENCODED_OVERHEAD = 1.4;
const MIN_HISTORY_MAX_BYTES = 256 * 1024;
const MAX_HISTORY_MAX_BYTES = 512 * 1024 * 1024;
/**
 * Hard ceiling on a single attachment, independent of CHAT_ATTACHMENT_MAX_BYTES.
 *
 * This is not just a chat concern: the Socket.IO frame allowance is DERIVED from
 * the attachment limit (see `realtimeMaxBufferBytes`), so an over-generous env
 * value would translate directly into an over-generous transport buffer that a
 * flooder could exploit. 64 MiB decoded is far beyond any real voice note or
 * image — anything larger belongs in the upload pipeline, not a data URL.
 */
const MAX_ATTACHMENT_MAX_BYTES = 64 * 1024 * 1024;
/**
 * Slack between the largest legal attachment and the transport frame limit:
 * the `data:<mime>;base64,` prefix, the message's other fields (id, author,
 * name, timestamps, reply target) and the Socket.IO event envelope.
 */
const REALTIME_ENVELOPE_BYTES = 256 * 1024;
/**
 * Absolute backstop on `maxHttpBufferSize`. With the attachment clamp above the
 * derived value can never reach this, so it only fires if that clamp is ever
 * loosened — a deliberate belt-and-braces guard against a config change quietly
 * granting multi-gigabyte frames.
 */
const MAX_REALTIME_BUFFER_BYTES = 96 * 1024 * 1024;

/** Read a byte-count env var, clamped to a sane range. */
function readByteLimit(raw, fallback, min, max) {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function attachmentMaxBytes(env = process.env) {
  return readByteLimit(env.CHAT_ATTACHMENT_MAX_BYTES, DEFAULT_ATTACHMENT_MAX_BYTES, 1024, MAX_ATTACHMENT_MAX_BYTES);
}

function historyMaxBytes(env = process.env) {
  return readByteLimit(
    env.CHAT_HISTORY_MAX_BYTES,
    DEFAULT_HISTORY_MAX_BYTES,
    MIN_HISTORY_MAX_BYTES,
    MAX_HISTORY_MAX_BYTES,
  );
}

/**
 * Decoded byte length of a base64 string, computed from length + padding.
 * Deliberately does NOT decode: decoding to measure would let a caller force a
 * multi-megabyte allocation just to be told the value is too large.
 */
function decodedBase64Bytes(b64) {
  const len = b64.length;
  if (len < 4) return 0;
  let padding = 0;
  if (b64.endsWith('==')) padding = 2;
  else if (b64.endsWith('=')) padding = 1;
  return Math.max(0, Math.floor(len / 4) * 3 - padding);
}

/** Split a `data:<mime>;base64,<payload>` URL without decoding the payload. */
function parseDataUrl(value) {
  const data = String(value || '');
  if (!data.startsWith('data:')) return null;
  const comma = data.indexOf(',');
  if (comma < 0) return null;
  const header = data.slice(5, comma);
  if (!/;base64$/i.test(header)) return null;
  return { mimeType: header.replace(/;base64$/i, '').toLowerCase(), payload: data.slice(comma + 1) };
}

/**
 * The encoded ceiling for a given decoded limit. Single source of truth: both
 * `validateAttachment` and the rate-limit capacity derive from this, so the
 * two can never drift apart.
 */
function maxEncodedAttachmentBytes(maxDecodedBytes) {
  return Math.ceil(maxDecodedBytes * ENCODED_OVERHEAD) + 1024;
}

/**
 * The smallest Socket.IO `maxHttpBufferSize` that can carry every attachment the
 * application is willing to accept.
 *
 * The transport limit and the application limit MUST be derived from one
 * another, never written down twice. If the frame allowance is below the encoded
 * ceiling, a perfectly valid attachment is dropped by Socket.IO before any
 * handler runs — the client sees a silent failure or a disconnect with no
 * explanation. Adding the envelope headroom on top also means a payload
 * SLIGHTLY over the application limit still reaches the handler and comes back
 * as a clean `TOO_LARGE`, which is the error the user deserves.
 */
function realtimeMaxBufferBytes(maxDecodedAttachmentBytes) {
  const encoded = maxEncodedAttachmentBytes(maxDecodedAttachmentBytes);
  // Data URL prefix, message metadata fields, Socket.IO envelope, safety margin.
  return Math.min(MAX_REALTIME_BUFFER_BYTES, encoded + REALTIME_ENVELOPE_BYTES);
}

/**
 * The largest token cost any VALID attachment can incur.
 *
 * The attachment bucket must be at least this large, or an attachment could
 * pass validation and then be rejected by the limiter forever — `cost >
 * capacity` is unsatisfiable no matter how long you wait. That mismatch is
 * exactly the bug this exists to prevent.
 */
function maxAttachmentCost(maxDecodedBytes) {
  return attachmentCost(maxEncodedAttachmentBytes(maxDecodedBytes));
}

/**
 * Validate an attachment payload.
 * @returns {{ok:true, decodedBytes:number, encodedBytes:number, mimeType:string}
 *          | {ok:false, error:'BAD_DATA'|'TOO_LARGE'}}
 */
function validateAttachment(data, options = {}) {
  const maxDecoded = options.maxDecodedBytes ?? DEFAULT_ATTACHMENT_MAX_BYTES;
  const maxEncoded = options.maxEncodedBytes ?? maxEncodedAttachmentBytes(maxDecoded);

  const encodedBytes = String(data || '').length;
  if (!encodedBytes) return { ok: false, error: 'BAD_DATA' };
  // Cheap ceiling first, so a huge string is rejected before any parsing.
  if (encodedBytes > maxEncoded) return { ok: false, error: 'TOO_LARGE' };

  const parsed = parseDataUrl(data);
  if (!parsed || !parsed.payload) return { ok: false, error: 'BAD_DATA' };

  const decodedBytes = decodedBase64Bytes(parsed.payload);
  if (decodedBytes <= 0) return { ok: false, error: 'BAD_DATA' };
  if (decodedBytes > maxDecoded) return { ok: false, error: 'TOO_LARGE' };

  return { ok: true, decodedBytes, encodedBytes, mimeType: parsed.mimeType };
}

/**
 * Rate-limit cost of an attachment: 1 token per 256 KiB of encoded data.
 * A voice note or small image costs 1–2; an 8MB video costs ~44, so a flood of
 * large attachments drains the bucket far faster than chatter does.
 */
function attachmentCost(dataLength) {
  const len = Number(dataLength);
  if (!Number.isFinite(len) || len <= 0) return 1;
  return Math.max(1, Math.ceil(len / (256 * 1024)));
}

/** Approximate in-memory footprint of a stored message. */
function estimateMessageBytes(message) {
  try {
    return Buffer.byteLength(JSON.stringify(message), 'utf8');
  } catch {
    return 0;
  }
}

/**
 * Append a message and evict oldest entries until BOTH the count and byte
 * budgets hold. Byte accounting is kept incrementally (each message's size is
 * stored on it) so eviction never has to re-measure the whole history.
 */
function pushMessageBounded(room, message, options = {}) {
  const maxMessages = options.maxMessages ?? 200;
  const maxBytes = options.maxBytes ?? DEFAULT_HISTORY_MAX_BYTES;

  const bytes = estimateMessageBytes(message);
  // Non-enumerable so the size never leaks into broadcasts or the snapshot.
  Object.defineProperty(message, '__bytes', { value: bytes, enumerable: false, writable: true });

  room.messages.push(message);
  room.messageBytes = (room.messageBytes || 0) + bytes;

  let evicted = 0;
  while (
    room.messages.length > 0 &&
    (room.messages.length > maxMessages || room.messageBytes > maxBytes) &&
    // Never evict the message just added, or the room would drop what it is
    // about to broadcast — a single oversized message is caught by the
    // per-attachment cap instead.
    room.messages.length > 1
  ) {
    const oldest = room.messages.shift();
    room.messageBytes -= oldest?.__bytes ?? estimateMessageBytes(oldest);
    evicted += 1;
  }
  if (room.messageBytes < 0) room.messageBytes = 0;

  return { bytes, evicted };
}

module.exports = {
  DEFAULT_ATTACHMENT_MAX_BYTES,
  DEFAULT_HISTORY_MAX_BYTES,
  MAX_ATTACHMENT_MAX_BYTES,
  MAX_REALTIME_BUFFER_BYTES,
  REALTIME_ENVELOPE_BYTES,
  realtimeMaxBufferBytes,
  attachmentMaxBytes,
  historyMaxBytes,
  decodedBase64Bytes,
  parseDataUrl,
  validateAttachment,
  attachmentCost,
  maxEncodedAttachmentBytes,
  maxAttachmentCost,
  estimateMessageBytes,
  pushMessageBounded,
};
