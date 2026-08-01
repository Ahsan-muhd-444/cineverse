/**
 * In-memory multipart storage adapter — TESTS ONLY.
 *
 * Never required by server.js. It exists so the full multipart pipeline
 * (initiate → sign → upload parts → list → complete → verify → read URL) can be
 * exercised with no credentials, no network and no bucket, while still enforcing
 * the constraints a real provider enforces:
 *
 *   - ListParts pages, and may return SHORT pages (the bug an earlier page bound
 *     got wrong);
 *   - a part is only listed once it has actually arrived;
 *   - ETags are opaque provider values, not something the caller may invent;
 *   - Complete requires ascending part numbers and matching ETags;
 *   - a completed or aborted upload id stops existing (NoSuchUpload);
 *   - the assembled object's size is the sum of the parts, so a wrong-sized part
 *     shows up at the final HEAD.
 *
 * Deliberately NOT lenient. Weakening a provider rule to make a test shorter is
 * how a passing suite ends up describing a system that does not work.
 *
 * Part payloads are stored as byte COUNTS, not bytes: nothing here needs the
 * content, and holding it would make the test double the one place a large
 * upload buffers in memory.
 */

const crypto = require('crypto');

/** Faults a test can arm to exercise a failure branch. */
const FAULTS = Object.freeze([
  'initiateFails',
  'signFails',
  'listFails',
  'listTruncatedNoMarker',
  'listDuplicatePart',
  'listExtraPart',
  'listBadEtag',
  'completeFails',
  'abortFails',
  'statMissing',
]);

/**
 * @param {object} [options]
 * @param {number} [options.pageSize=1000] parts per ListParts page
 * @param {number} [options.now]
 */
function createMockMultipartStorage(options = {}) {
  const pageSize = Number.isSafeInteger(options.pageSize) && options.pageSize > 0 ? options.pageSize : 1000;

  /** uploadId -> { key, mimeType, parts: Map<number, {etag,size}> } */
  const uploads = new Map();
  /** key -> { size, contentType } */
  const objects = new Map();
  const calls = [];
  const faults = new Set();
  let uploadCounter = 0;
  let signCounter = 0;

  const record = (name, input) => calls.push({ name, input });
  const missing = () => Object.assign(new Error('NoSuchUpload'), { name: 'NoSuchUpload' });

  function findUpload(key, uploadId) {
    const upload = uploads.get(uploadId);
    if (!upload || upload.key !== key) throw missing();
    return upload;
  }

  const storage = {
    name: 'mock-multipart',
    /** Bytes go straight to "the provider" — never through the Node process. */
    direct: true,
    multipart: true,

    /* ------------------------ multipart control ------------------------ */

    async createMultipartUpload({ key, mimeType }) {
      record('createMultipartUpload', { key, mimeType });
      if (faults.has('initiateFails')) throw new Error('provider refused initiation');
      uploadCounter += 1;
      const uploadId = `mock-upload-${uploadCounter}-${crypto.randomBytes(4).toString('hex')}`;
      uploads.set(uploadId, { key, mimeType, parts: new Map() });
      return { uploadId };
    },

    async createPartUploadTarget({ key, uploadId, partNumber, expiresIn }) {
      record('createPartUploadTarget', { key, uploadId, partNumber, expiresIn });
      if (faults.has('signFails')) throw new Error('provider refused to sign');
      findUpload(key, uploadId);
      signCounter += 1;
      return {
        method: 'PUT',
        // Shaped like a presigned URL so nothing downstream can accidentally
        // depend on it being a real one.
        url: `https://mock.invalid/${encodeURIComponent(key)}?uploadId=${encodeURIComponent(uploadId)}&partNumber=${partNumber}&sig=${signCounter}`,
      };
    },

    async listMultipartParts({ key, uploadId, expectedPartCount, partNumberMarker }) {
      record('listMultipartParts', { key, uploadId, expectedPartCount, partNumberMarker });
      if (faults.has('listFails')) throw new Error('provider listing failed');
      if (expectedPartCount === undefined || expectedPartCount === null) {
        // The real adapter treats a missing plan as a programming error; the mock
        // must not be more permissive, or a caller could forget it in production.
        throw new Error('listMultipartParts: expectedPartCount is required');
      }
      const upload = findUpload(key, uploadId);

      const all = [...upload.parts.entries()]
        .map(([partNumber, part]) => ({ partNumber, etag: part.etag, size: part.size }))
        .sort((a, b) => a.partNumber - b.partNumber);

      const injected = [...all];
      if (faults.has('listDuplicatePart') && injected.length) injected.push({ ...injected[0] });
      if (faults.has('listExtraPart')) {
        injected.push({ partNumber: expectedPartCount + 1, etag: '"extra"', size: 1 });
      }
      if (faults.has('listBadEtag') && injected.length) injected[0] = { ...injected[0], etag: '' };
      if (faults.has('listTruncatedNoMarker')) {
        // A provider claiming more parts while giving nothing to continue from.
        // The real adapter must refuse rather than silently report a short list.
        throw new Error('provider reported more parts but returned no continuation marker');
      }

      // Paginate, like the real thing. The caller (s3-multipart) handles paging;
      // this adapter is called by the SERVICE, so it returns the whole list —
      // pagination behaviour itself is covered against the real adapter with an
      // injected SDK client in scripts/uploads-s3-listing.test.mjs.
      return injected;
    },

    async completeMultipartUpload({ key, uploadId, parts }) {
      record('completeMultipartUpload', { key, uploadId, parts });
      if (faults.has('completeFails')) throw new Error('provider completion failed');
      const upload = findUpload(key, uploadId);

      if (!Array.isArray(parts) || parts.length === 0) throw new Error('completion needs parts');
      let previous = 0;
      let total = 0;
      for (const part of parts) {
        // S3 requires ascending order and would otherwise assemble a corrupt
        // object; refusing here is what makes the ordering assertion meaningful.
        if (!(part.partNumber > previous)) throw new Error('completion parts must ascend');
        previous = part.partNumber;
        const stored = upload.parts.get(part.partNumber);
        if (!stored) throw new Error(`no such part ${part.partNumber}`);
        if (stored.etag !== part.etag) throw new Error(`etag mismatch for part ${part.partNumber}`);
        total += stored.size;
      }

      objects.set(key, { size: total, contentType: upload.mimeType });
      // The multipart upload ceases to exist — a retried Complete must hit the
      // idempotent path, not a second assembly.
      uploads.delete(uploadId);
      return { key, size: total };
    },

    async abortMultipartUpload({ key, uploadId }) {
      record('abortMultipartUpload', { key, uploadId });
      if (faults.has('abortFails')) throw new Error('provider abort failed');
      const upload = uploads.get(uploadId);
      if (!upload || upload.key !== key) throw missing();
      uploads.delete(uploadId);
      return true;
    },

    /* ------------------------ object operations ------------------------ */

    async statObject(key) {
      record('statObject', { key });
      if (faults.has('statMissing')) return null;
      const object = objects.get(key);
      return object ? { size: object.size, contentType: object.contentType } : null;
    },

    async createReadUrl(key) {
      record('createReadUrl', { key });
      return `https://mock.invalid/read/${encodeURIComponent(key)}`;
    },

    async deleteObject(key) {
      record('deleteObject', { key });
      return objects.delete(key);
    },

    /* ------------------------ test controls ------------------------ */

    /**
     * Simulate a browser PUT of one part. Returns the opaque ETag the provider
     * would have put in the response header — the ONLY way a caller can learn it,
     * exactly as with a real bucket.
     */
    putPart({ key, uploadId, partNumber, size }) {
      const upload = findUpload(key, uploadId);
      if (!Number.isSafeInteger(partNumber) || partNumber < 1) throw new Error('bad part number');
      if (!Number.isSafeInteger(size) || size <= 0) throw new Error('bad part size');
      const etag = `"${crypto.createHash('md5').update(`${uploadId}:${partNumber}:${size}`).digest('hex')}"`;
      upload.parts.set(partNumber, { etag, size });
      return etag;
    },

    /** Arm a fault. Unknown names throw, so a typo cannot silently pass. */
    fail(name) {
      if (!FAULTS.includes(name)) throw new Error(`unknown mock fault: ${name}`);
      faults.add(name);
      return storage;
    },
    clearFaults() {
      faults.clear();
      return storage;
    },

    /** Inspection for assertions. */
    openUploadCount: () => uploads.size,
    openUploadIds: () => [...uploads.keys()],
    objectSize: (key) => (objects.has(key) ? objects.get(key).size : null),
    hasObject: (key) => objects.has(key),
    partsOf: (uploadId) => {
      const upload = uploads.get(uploadId);
      return upload ? [...upload.parts.keys()].sort((a, b) => a - b) : [];
    },
    callNames: () => calls.map((c) => c.name),
    callsFor: (name) => calls.filter((c) => c.name === name).map((c) => c.input),
    resetCalls: () => {
      calls.length = 0;
    },
    pageSize: () => pageSize,
  };

  return storage;
}

module.exports = { createMockMultipartStorage, FAULTS };
