/**
 * S3 multipart operations, built on the official AWS SDK.
 *
 * Deliberately separate from `s3.js`. That module hand-rolls SigV4 for the
 * single-shot presigned POST and is well tested; multipart needs things a hand
 * rolled signer gets wrong quietly:
 *
 *   - signed QUERY parameters (`?uploads`, `?uploadId=`, `?partNumber=`);
 *   - XML request/response bodies for Complete and ListParts;
 *   - ListParts pagination past 1000 parts;
 *   - CompleteMultipartUpload's infamous "HTTP 200 with an <Error> body", which
 *     a naive `res.ok` check reads as success and then attaches a corrupt object
 *     to the room.
 *
 * SERVER ONLY. This file is reached from server.js (CommonJS, outside the Next
 * build), so the SDK never enters the browser bundle: the browser only ever
 * receives opaque presigned URLs.
 *
 * Reachability, stated accurately: constructing the S3 adapter DOES load the
 * AWS SDK (createS3Storage requires this module eagerly). What has not run yet
 * is any multipart NETWORK operation - no CreateMultipartUpload, UploadPart,
 * ListParts, Complete or Abort has been issued against a real bucket, because
 * no socket handler calls them.
 *
 * Movie bytes never pass through here: the browser PUTs each part straight to
 * the bucket. This module signs URLs and exchanges small XML control messages.
 */

const { S3Client, CreateMultipartUploadCommand, UploadPartCommand, ListPartsCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
// ONE definition of what a valid ETag / part number / size is, shared with
// the multipart core. A second copy here would drift.
const {
  normalizeEtag,
  isValidPartNumber,
  isValidPartSize,
  isValidKey,
  isAllowedMime,
  isBoundedString,
  S3_MAX_PART_COUNT,
} = require('../upload-limits');

/**
 * Validate an operation's inputs BEFORE building an SDK command.
 *
 * Not defensive noise: these values reach a real bucket, and a malformed one
 * fails in whichever way the provider chooses — a 400 with an XML body, a signed
 * URL for an object that does not exist, or worse, a successful operation on the
 * wrong key. Every call in this file is reached only from a verified session
 * token, so a violation here means a bug on our side and should say so plainly
 * rather than becoming a provider error someone has to decode.
 */
function requireOperand(condition, message) {
  if (!condition) throw new Error(`s3-multipart: ${message}`);
}

const MAX_UPLOAD_ID = 512;

/**
 * Build the SDK client from the same env the hand-rolled adapter reads, so a
 * working single-shot configuration keeps working with no new variables.
 *
 * `forcePathStyle` defaults to true because that is the URL shape the existing
 * adapter already produces (`<endpoint>/<bucket>/<key>`), and it is what R2 and
 * MinIO expect. AWS S3 accepts it too.
 */
function createClient(config, env = process.env) {
  const forcePathStyle = String(env.S3_FORCE_PATH_STYLE ?? '1').trim() !== '0';
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region || 'auto',
    forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

/**
 * Validate one provider-listed part.
 *
 * No coercion: `Number(raw.PartNumber)` would turn the string "1" into a valid
 * part number, so a provider (or a proxy rewriting XML) could hand us types we
 * never verified. The SDK already parses these into numbers, so a string here
 * means something is wrong upstream and we should say so rather than paper
 * over it.
 */
function coercePart(raw) {
  const partNumber = raw?.PartNumber;
  const size = raw?.Size;
  const etag = normalizeEtag(raw?.ETag);

  if (!isValidPartNumber(partNumber)) {
    throw new Error(`provider returned a malformed part number: ${JSON.stringify(raw?.PartNumber)}`);
  }
  if (etag === null) {
    throw new Error(`provider returned a malformed etag for part ${partNumber}`);
  }
  if (!isValidPartSize(size)) {
    throw new Error(`provider returned a malformed size for part ${partNumber}: ${JSON.stringify(raw?.Size)}`);
  }
  return { partNumber, etag, size };
}

/**
 * Upper bound on ListParts round-trips.
 *
 * S3 returns at most 1000 parts per page and allows at most 10,000 parts, so a
 * well-behaved provider needs 10. The allowance is generous; the point is that
 * the loop terminates even against a provider that always claims truncation.
 */
const MAX_LIST_PAGES = 32;

/**
 * @param {object} config  bucket/endpoint/credentials
 * @param {object} env
 * @param {object} [deps]  test seam: { client, getSignedUrl }. Production passes
 *                         nothing and gets the real SDK client + presigner, so
 *                         injecting cannot weaken the default path.
 */
function createS3Multipart(config, env = process.env, deps = {}) {
  const sign = deps.getSignedUrl || getSignedUrl;
  let client = deps.client || null;
  // Lazily constructed: importing the SDK is cheap, but a process that never
  // uploads should not build a client (and never needs to hold credentials).
  const c = () => (client ||= createClient(config, env));

  return {
    async createMultipartUpload({ key, mimeType }) {
      requireOperand(isValidKey(key), `createMultipartUpload needs a valid key, got ${JSON.stringify(key)}`);
      requireOperand(isAllowedMime(mimeType), `createMultipartUpload needs an allowed MIME, got ${JSON.stringify(mimeType)}`);
      const res = await c().send(
        new CreateMultipartUploadCommand({ Bucket: config.bucket, Key: key, ContentType: mimeType }),
      );
      // An empty upload id would be signed into a six-hour capability addressing
      // nothing, and every part PUT would fail with an opaque provider error.
      if (!isBoundedString(res.UploadId, MAX_UPLOAD_ID)) {
        throw new Error('multipart initiation returned no usable upload id');
      }
      return { uploadId: res.UploadId };
    },

    /**
     * A presigned PUT for exactly one part.
     *
     * Note the deliberate asymmetry with the single-shot path: that one uses a
     * presigned POST so the bucket enforces the size cap itself. A part upload
     * cannot do that — S3 has no per-part content-length-range — so the size
     * guarantee for multipart comes from the signed plan plus the complete-time
     * HEAD, which checks the assembled object against the exact expected bytes.
     */
    async createPartUploadTarget({ key, uploadId, partNumber, expiresIn }) {
      requireOperand(isValidKey(key), `createPartUploadTarget needs a valid key, got ${JSON.stringify(key)}`);
      requireOperand(isBoundedString(uploadId, MAX_UPLOAD_ID), 'createPartUploadTarget needs an upload id');
      requireOperand(isValidPartNumber(partNumber), `createPartUploadTarget needs a part number 1..${S3_MAX_PART_COUNT}, got ${JSON.stringify(partNumber)}`);
      requireOperand(
        Number.isSafeInteger(expiresIn) && expiresIn > 0 && expiresIn <= 7 * 24 * 60 * 60,
        `createPartUploadTarget needs a positive expiry within SigV4's 7-day limit, got ${JSON.stringify(expiresIn)}`,
      );
      const url = await sign(
        c(),
        new UploadPartCommand({ Bucket: config.bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }),
        { expiresIn },
      );
      return { method: 'PUT', url };
    },

    /**
     * Every part the provider has actually stored. Paginated and PLAN-AWARE.
     *
     * `expectedPartCount` comes from the signed session token, so the provider
     * can never report more parts than this server planned. Without it the only
     * bounds were generic (page cap, 10,000 parts); with it the listing is
     * bounded by the specific upload, and a provider returning parts we never
     * planned is a hard error rather than data we would then hand to complete.
     */
    async listMultipartParts({ key, uploadId, expectedPartCount }) {
      requireOperand(isValidKey(key), `listMultipartParts needs a valid key, got ${JSON.stringify(key)}`);
      requireOperand(isBoundedString(uploadId, MAX_UPLOAD_ID), 'listMultipartParts needs an upload id');
      const planned =
        expectedPartCount === undefined || expectedPartCount === null ? null : expectedPartCount;
      if (planned !== null && (!Number.isSafeInteger(planned) || planned < 1 || planned > S3_MAX_PART_COUNT)) {
        throw new Error(`expectedPartCount must be a planned part count, got ${JSON.stringify(expectedPartCount)}`);
      }
      // One request per 1000 parts, plus slack for a provider that returns
      // short pages. Still bounded when no plan is supplied.
      /*
       * MaxParts is a REQUESTED page size, not a guarantee: a provider may
       * legitimately return short pages. Bounding by `ceil(planned/1000)+2`
       * therefore rejected valid listings - 384 parts arriving in five short
       * pages would have failed. The marker must strictly advance and part
       * numbers are unique, so at most `planned` pages can each carry at least
       * one new part; +1 covers the final non-truncated response.
       */
      const pageCap = planned === null ? MAX_LIST_PAGES : planned + 1;
      const partCap = planned === null ? S3_MAX_PART_COUNT : planned;
      const parts = [];
      const seen = new Set();
      const markersUsed = new Set();
      let marker;
      let pages = 0;

      for (;;) {
        pages += 1;
        if (pages > pageCap) {
          throw new Error(`provider listing exceeded ${pageCap} pages — refusing to loop`);
        }

        const res = await c().send(
          new ListPartsCommand({
            Bucket: config.bucket,
            Key: key,
            UploadId: uploadId,
            PartNumberMarker: marker,
            // Ask for full pages explicitly rather than relying on a provider
            // default, so the page bound above means what it says.
            MaxParts: 1000,
          }),
        );

        for (const raw of res.Parts || []) {
          const part = coercePart(raw);
          // Duplicates within a page or across pages would inflate a resume's
          // idea of what is already stored.
          if (seen.has(part.partNumber)) {
            throw new Error(`provider listed part ${part.partNumber} more than once`);
          }
          seen.add(part.partNumber);
          parts.push(part);
          if (planned !== null && part.partNumber > planned) {
            throw new Error(`provider listed part ${part.partNumber} beyond the planned ${planned}`);
          }
          if (parts.length > partCap) {
            throw new Error(`provider listed more than ${partCap} parts`);
          }
        }

        if (!res.IsTruncated) break;

        const next = res.NextPartNumberMarker;
        // Truncated with no continuation token means we cannot enumerate the
        // rest. Silently breaking would report a SHORT part list, and a resume
        // built on it would re-upload existing parts — or complete against an
        // incomplete manifest.
        if (next === undefined || next === null || next === '') {
          throw new Error('provider reported more parts but returned no continuation marker');
        }
        // A repeated marker is an infinite loop; a backwards marker re-reads
        // parts we already have. Both are provider bugs we must not absorb.
        const nextKey = String(next);
        if (markersUsed.has(nextKey)) {
          throw new Error(`provider repeated continuation marker ${nextKey}`);
        }
        const previousNumeric = Number(marker ?? 0);
        const nextNumeric = Number(nextKey);
        if (Number.isFinite(previousNumeric) && Number.isFinite(nextNumeric) && nextNumeric <= previousNumeric) {
          throw new Error(`provider continuation marker moved backwards (${marker} -> ${nextKey})`);
        }
        markersUsed.add(nextKey);
        marker = nextKey;
      }
      return parts.sort((a, b) => a.partNumber - b.partNumber);
    },

    async completeMultipartUpload({ key, uploadId, parts }) {
      requireOperand(isValidKey(key), `completeMultipartUpload needs a valid key, got ${JSON.stringify(key)}`);
      requireOperand(isBoundedString(uploadId, MAX_UPLOAD_ID), 'completeMultipartUpload needs an upload id');
      requireOperand(Array.isArray(parts) && parts.length > 0, 'completeMultipartUpload needs at least one part');
      requireOperand(parts.length <= S3_MAX_PART_COUNT, `completeMultipartUpload got ${parts.length} parts, above the provider limit`);
      for (const part of parts) {
        requireOperand(isValidPartNumber(part?.partNumber), `completeMultipartUpload got a bad part number: ${JSON.stringify(part?.partNumber)}`);
        // An assembled object is only as correct as its ETags; an empty or
        // control-character-bearing one must never reach the provider.
        requireOperand(normalizeEtag(part?.etag) !== null, `completeMultipartUpload got a bad etag for part ${part?.partNumber}`);
      }
      // The SDK turns a 200-with-<Error>-body into a thrown error, which is the
      // whole reason this path is not hand-rolled.
      await c().send(
        new CompleteMultipartUploadCommand({
          Bucket: config.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            // S3 requires ascending part numbers; a wrong order assembles a
            // corrupt object rather than failing loudly.
            Parts: [...parts]
              .sort((a, b) => a.partNumber - b.partNumber)
              .map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
          },
        }),
      );
    },

    async abortMultipartUpload({ key, uploadId }) {
      requireOperand(isValidKey(key), `abortMultipartUpload needs a valid key, got ${JSON.stringify(key)}`);
      requireOperand(isBoundedString(uploadId, MAX_UPLOAD_ID), 'abortMultipartUpload needs an upload id');
      try {
        await c().send(new AbortMultipartUploadCommand({ Bucket: config.bucket, Key: key, UploadId: uploadId }));
        return true;
      } catch (err) {
        // Already aborted / already completed / gone: abort must be idempotent,
        // so "there is nothing to abort" is success from the caller's side.
        const code = err?.name || err?.Code || '';
        if (code === 'NoSuchUpload' || err?.$metadata?.httpStatusCode === 404) return true;
        throw err;
      }
    },
  };
}

module.exports = { createS3Multipart, createClient };
