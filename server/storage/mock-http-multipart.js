/**
 * A storage adapter backed by the mock bucket over HTTP — TESTS ONLY.
 *
 * This is what makes a REAL browser multipart flow possible without S3
 * credentials: the browser PUTs each part directly to the mock bucket's origin
 * (cross-origin, with a CORS preflight and an ETag response header), while these
 * server-side control operations reach the same bucket over its private control
 * API. Movie bytes never pass through the Node process — exactly as with a real
 * bucket.
 *
 * NEVER selected in normal development or production. `server/storage/index.js`
 * only builds this under an explicit `NODE_ENV=test` + `UPLOAD_TEST_MODE=1` gate,
 * and production refuses that flag outright.
 */

const { isValidKey, isAllowedMime, isBoundedString, normalizeEtag } = require('../upload-limits');

async function control(origin, path, body) {
  const res = await fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

/**
 * @param {object} config
 * @param {string} config.origin   the mock bucket origin (browser-facing)
 * @param {string} config.readTtl  unused; present for shape parity
 */
function createMockHttpMultipartStorage(config) {
  const origin = config.origin;
  if (!origin) throw new Error('mock-http-multipart: a bucket origin is required');

  return {
    name: 'mock-http',
    // The browser uploads straight to the bucket, so bytes skip this process.
    direct: true,
    multipart: true,

    async createMultipartUpload({ key, mimeType }) {
      if (!isValidKey(key)) throw new Error('createMultipartUpload: invalid key');
      if (!isAllowedMime(mimeType)) throw new Error('createMultipartUpload: unsupported mime');
      const { status, json } = await control(origin, '/_control/create', { key, mimeType });
      if (status !== 200 || !isBoundedString(json.uploadId, 512)) {
        throw new Error('createMultipartUpload: no usable upload id');
      }
      return { uploadId: json.uploadId };
    },

    async createPartUploadTarget({ key, uploadId, partNumber }) {
      // The presigned-style URL the BROWSER will PUT to, cross-origin.
      return {
        method: 'PUT',
        url: `${origin}/part/${encodeURIComponent(uploadId)}/${partNumber}`,
      };
    },

    // The SINGLE-SHOT presigned-style PUT: the browser sends the whole (small)
    // file cross-origin in one request, exactly as it would to a real bucket.
    async createUploadTarget({ key, mimeType }) {
      if (!isValidKey(key)) throw new Error('createUploadTarget: invalid key');
      if (!isAllowedMime(mimeType)) throw new Error('createUploadTarget: unsupported mime');
      return {
        method: 'PUT',
        url: `${origin}/single/${key}`,
        headers: { 'Content-Type': mimeType },
        direct: true,
      };
    },

    async listMultipartParts({ key, uploadId, expectedPartCount }) {
      if (expectedPartCount === undefined || expectedPartCount === null) {
        throw new Error('listMultipartParts: expectedPartCount is required');
      }
      const { status, json } = await control(origin, '/_control/list', { key, uploadId });
      if (status === 404) throw Object.assign(new Error('NoSuchUpload'), { name: 'NoSuchUpload' });
      if (status !== 200 || !Array.isArray(json.parts)) throw new Error('listMultipartParts: bad response');
      // Normalise like the real adapter: opaque, validated ETags.
      return json.parts.map((p) => {
        const etag = normalizeEtag(p.etag);
        if (etag === null) throw new Error(`listMultipartParts: bad etag for part ${p.partNumber}`);
        return { partNumber: p.partNumber, etag, size: p.size };
      });
    },

    async completeMultipartUpload({ key, uploadId, parts }) {
      const { status, json } = await control(origin, '/_control/complete', { key, uploadId, parts });
      if (status === 404) throw Object.assign(new Error('NoSuchUpload'), { name: 'NoSuchUpload' });
      if (status !== 200) throw new Error(`completeMultipartUpload failed: ${json.error || status}`);
    },

    async abortMultipartUpload({ key, uploadId }) {
      const { status } = await control(origin, '/_control/abort', { key, uploadId });
      return status === 200 || status === 404;
    },

    async statObject(key) {
      const { status, json } = await control(origin, '/_control/stat', { key });
      if (status !== 200) return null;
      return { size: json.size, contentType: json.contentType };
    },

    async createReadUrl(key) {
      // The browser reads the finished object cross-origin, Range-aware.
      return `${origin}/object/${key}`;
    },

    async deleteObject(key) {
      // A real deletion through the bucket's control API, so a completion that
      // fails final verification actually removes the assembled object (a
      // wrong-sized/wrong-type object must never survive as a room source).
      const { status } = await control(origin, '/_control/delete', { key });
      return status === 200;
    },
  };
}

module.exports = { createMockHttpMultipartStorage };
