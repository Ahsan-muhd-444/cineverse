/**
 * Complete-time verification of an uploaded object.
 *
 * Bytes may have gone straight to object storage (presigned POST) or through
 * our own endpoint (dev filesystem). Either way, before a source is attached to
 * a room this confirms the object actually exists and is within the token's
 * byte cap — a client must never be able to `upload:complete` with no upload,
 * a failed upload, or an oversized/wrong-type object.
 *
 * The POST policy already bounds the size at the bucket, so for S3 this is
 * defence in depth; for any adapter it is the existence gate. Kept as a small
 * pure-ish function (storage is injected) so it can be unit-tested with a mock
 * adapter — see scripts/uploads-storage.test.mjs.
 */

const { validateSingleUploadGrant } = require('./upload-limits');

const passthroughClean = (v) => String(v ?? '').trim().slice(0, 120);

async function tryDelete(storage, key) {
  if (typeof storage.deleteObject !== 'function') return;
  try {
    await storage.deleteObject(key);
  } catch {
    /* best effort — a lifecycle rule / sweeper will still reap it */
  }
}

/**
 * @param {object}   args
 * @param {object}   args.storage  MediaStorage adapter
 * @param {object}   args.claims   verified grant { transport, key, mimeType, roomCode, expectedBytes, maxBytes }
 * @param {string}   args.label
 * @param {Function} [args.clean]  server input sanitiser
 * @returns {Promise<{ok:true, source:object} | {ok:false, error:string}>}
 */
async function finalizeUpload({ storage, claims, label, clean = passthroughClean }) {
  /*
   * FAIL CLOSED, in this order.
   *
   * 1. The grant must be valid AS GIVEN.
   *
   * Verified claims normally arrive here, but this function is also reachable
   * with hand-built claims, and a grant missing `expectedBytes` used to skip the
   * exact-size check silently. Nothing is defaulted either: an earlier version
   * substituted `transport: 'single'` when it was absent, which meant this
   * function invented the very claim it was supposed to be checking — a claim
   * set that could not say what it authorized was quietly upgraded into one
   * that could.
   */
  const verdict = validateSingleUploadGrant(claims);
  if (!verdict.ok) return { ok: false, error: 'BAD_GRANT' };

  /*
   * 2. The adapter must be able to PROVE the object landed. Previously the
   *    whole verification block was conditional on `statObject` existing, so an
   *    adapter without it attached a source having checked nothing at all.
   */
  // A missing or non-object adapter is unverifiable, not a crash.
  if (!storage || typeof storage !== 'object' || typeof storage.statObject !== 'function') {
    return { ok: false, error: 'STORAGE_UNVERIFIABLE' };
  }

  {
    const stat = await storage.statObject(claims.key);
    if (!stat) return { ok: false, error: 'NOT_UPLOADED' };

    // A landed object must have a positive size — same rule as intent
    // validation and the POST policy. An empty PUT body (dev adapter) would
    // otherwise attach a broken 0-byte "video" to the room.
    const size = Number(stat.size);
    if (!Number.isFinite(size) || size <= 0) {
      await tryDelete(storage, claims.key);
      return { ok: false, error: 'BAD_SIZE' };
    }

    if (Number.isFinite(claims.maxBytes) && size > claims.maxBytes) {
      await tryDelete(storage, claims.key);
      return { ok: false, error: 'TOO_LARGE' };
    }

    /*
     * EXACT size, not merely "within the cap".
     *
     * The grant pinned a declared size, so the stored object must BE that size.
     * This is the last gate for both adapters and it catches what neither the
     * POST policy nor the local stream can: a client that declared 100 MiB and
     * uploaded 99 MiB. Every "<= maxBytes" check accepts that happily, and it
     * would attach a truncated, unplayable film to the room.
     */
    if (size !== claims.expectedBytes) {
      await tryDelete(storage, claims.key);
      return { ok: false, error: 'SIZE_MISMATCH' };
    }

    // If the adapter reports a content type, it must still be the approved one.
    if (stat.contentType && claims.mimeType) {
      const actual = String(stat.contentType).split(';')[0].trim().toLowerCase();
      if (actual !== String(claims.mimeType).toLowerCase()) {
        await tryDelete(storage, claims.key);
        return { ok: false, error: 'BAD_CONTENT' };
      }
    }
  }

  const value = await storage.createReadUrl(claims.key);
  return {
    ok: true,
    source: {
      type: 'url',
      value,
      label: clean(label, 120) || 'Uploaded video',
      quality: 'Uploaded',
    },
  };
}

module.exports = { finalizeUpload };
