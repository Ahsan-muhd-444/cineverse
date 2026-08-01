/**
 * S3 multipart command tests with an injected client and presigner.
 *
 * No bucket, no credentials, no network. We assert on the COMMAND OBJECTS the
 * adapter hands to the SDK, which is the part we actually own — the SDK's own
 * serialization is not ours to re-test.
 *
 * Run: node --test --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/uploads-s3-multipart.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createS3Multipart } = require('../server/storage/s3-multipart.js');

const CONFIG = {
  endpoint: 'https://example.r2.cloudflarestorage.com',
  bucket: 'cineverse-uploads',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 'secret',
  region: 'auto',
};
const KEY = 'rooms/ABC123/0123456789abcdef/movie.mp4';
const UPLOAD_ID = 'upload-abc';

/** Records every command the adapter sends, and replies from a queue. */
function harness({ replies = [], signedUrl = 'https://signed.example/part' } = {}) {
  const sent = [];
  const signCalls = [];
  const queue = [...replies];
  const client = {
    async send(command) {
      sent.push(command);
      const next = queue.shift();
      if (typeof next === 'function') return next(command);
      if (next instanceof Error) throw next;
      return next ?? {};
    },
  };
  const getSignedUrl = async (_client, command, options) => {
    signCalls.push({ command, options });
    return signedUrl;
  };
  const api = createS3Multipart(CONFIG, {}, { client, getSignedUrl });
  return { api, sent, signCalls };
}

const nameOf = (command) => command.constructor.name;

/* --------------------------------------------------------------- initiate */

test('1. initiation sends the correct bucket, key and content type', async () => {
  const { api, sent } = harness({ replies: [{ UploadId: UPLOAD_ID }] });
  const result = await api.createMultipartUpload({ key: KEY, mimeType: 'video/mp4' });

  assert.equal(result.uploadId, UPLOAD_ID);
  assert.equal(sent.length, 1);
  assert.equal(nameOf(sent[0]), 'CreateMultipartUploadCommand');
  assert.equal(sent[0].input.Bucket, CONFIG.bucket);
  assert.equal(sent[0].input.Key, KEY);
  assert.equal(sent[0].input.ContentType, 'video/mp4');
});

test('2. a missing or unusable UploadId is rejected rather than returned as undefined', async () => {
  // An unusable id would be signed into a six-hour capability addressing nothing,
  // and every part PUT would then fail with an opaque provider error.
  for (const reply of [{}, { UploadId: '' }, { UploadId: null }, { UploadId: 42 }, { UploadId: 'u'.repeat(513) }]) {
    const { api } = harness({ replies: [reply] });
    await assert.rejects(
      () => api.createMultipartUpload({ key: KEY, mimeType: 'video/mp4' }),
      /no usable upload id/,
      JSON.stringify(reply),
    );
  }
});

test('2b. operands are validated before any SDK command is built', async () => {
  // These are reached only from a verified session token, so a violation is a bug
  // on our side and should say so plainly rather than becoming a provider error.
  const { api, sent } = harness();
  await assert.rejects(() => api.createMultipartUpload({ key: '../escape', mimeType: 'video/mp4' }), /valid key/);
  await assert.rejects(() => api.createMultipartUpload({ key: KEY, mimeType: 'application/zip' }), /allowed MIME/);
  await assert.rejects(() => api.createPartUploadTarget({ key: KEY, uploadId: '', partNumber: 1, expiresIn: 900 }), /upload id/);
  await assert.rejects(() => api.createPartUploadTarget({ key: KEY, uploadId: UPLOAD_ID, partNumber: 0, expiresIn: 900 }), /part number/);
  await assert.rejects(
    () => api.createPartUploadTarget({ key: KEY, uploadId: UPLOAD_ID, partNumber: 1, expiresIn: 0 }),
    /positive expiry/,
  );
  await assert.rejects(() => api.listMultipartParts({ key: 'bad', uploadId: UPLOAD_ID, expectedPartCount: 1 }), /valid key/);
  await assert.rejects(() => api.completeMultipartUpload({ key: KEY, uploadId: UPLOAD_ID, parts: [] }), /at least one part/);
  await assert.rejects(
    () => api.completeMultipartUpload({ key: KEY, uploadId: UPLOAD_ID, parts: [{ partNumber: 1, etag: '' }] }),
    /bad etag/,
  );
  await assert.rejects(() => api.abortMultipartUpload({ key: KEY, uploadId: '' }), /upload id/);
  // Not one command reached the client.
  assert.deepEqual(sent, []);
});

/* ----------------------------------------------------------- part targets */

test('3. a part target signs the requested part number and upload id', async () => {
  const { api, signCalls, sent } = harness();
  const target = await api.createPartUploadTarget({ key: KEY, uploadId: UPLOAD_ID, partNumber: 7, expiresIn: 900 });

  assert.equal(target.method, 'PUT');
  assert.equal(target.url, 'https://signed.example/part');
  assert.equal(sent.length, 0, 'signing must not send a request');
  assert.equal(signCalls.length, 1);
  const { command } = signCalls[0];
  assert.equal(nameOf(command), 'UploadPartCommand');
  assert.equal(command.input.PartNumber, 7);
  assert.equal(command.input.UploadId, UPLOAD_ID);
  assert.equal(command.input.Key, KEY);
  assert.equal(command.input.Bucket, CONFIG.bucket);
});

test('4. the requested expiry is passed through to the presigner', async () => {
  const { api, signCalls } = harness();
  await api.createPartUploadTarget({ key: KEY, uploadId: UPLOAD_ID, partNumber: 1, expiresIn: 1234 });
  assert.equal(signCalls[0].options.expiresIn, 1234);
});

/* ----------------------------------------------------------------- listing */

const part = (n, size = 8 * 1024 * 1024) => ({ PartNumber: n, ETag: `"etag-${n}"`, Size: size });

test('5. listing handles a single page', async () => {
  const { api, sent } = harness({ replies: [{ Parts: [part(1), part(2)], IsTruncated: false }] });
  const parts = await api.listMultipartParts({ key: KEY, uploadId: UPLOAD_ID });

  assert.deepEqual(parts, [
    { partNumber: 1, etag: '"etag-1"', size: 8 * 1024 * 1024 },
    { partNumber: 2, etag: '"etag-2"', size: 8 * 1024 * 1024 },
  ]);
  assert.equal(sent.length, 1);
  assert.equal(nameOf(sent[0]), 'ListPartsCommand');
  assert.equal(sent[0].input.UploadId, UPLOAD_ID);
});

test('6. listing follows the continuation marker across pages', async () => {
  const { api, sent } = harness({
    replies: [
      { Parts: [part(1), part(2)], IsTruncated: true, NextPartNumberMarker: '2' },
      { Parts: [part(3)], IsTruncated: true, NextPartNumberMarker: '3' },
      { Parts: [part(4)], IsTruncated: false },
    ],
  });
  const parts = await api.listMultipartParts({ key: KEY, uploadId: UPLOAD_ID });

  assert.deepEqual(parts.map((p) => p.partNumber), [1, 2, 3, 4]);
  assert.equal(sent.length, 3);
  assert.equal(sent[0].input.PartNumberMarker, undefined);
  assert.equal(sent[1].input.PartNumberMarker, '2');
  assert.equal(sent[2].input.PartNumberMarker, '3');
});

test('7. a truncated page with no next marker is an error, not a short list', async () => {
  for (const marker of [undefined, null, '']) {
    const { api } = harness({ replies: [{ Parts: [part(1)], IsTruncated: true, NextPartNumberMarker: marker }] });
    await assert.rejects(
      () => api.listMultipartParts({ key: KEY, uploadId: UPLOAD_ID }),
      /no continuation marker/,
      `marker ${JSON.stringify(marker)} must not silently truncate`,
    );
  }
});

test('8. a malformed part number is rejected', async () => {
  for (const bad of [{ PartNumber: 0 }, { PartNumber: -1 }, { PartNumber: 1.5 }, { PartNumber: 'x' }, {}]) {
    const { api } = harness({ replies: [{ Parts: [{ ETag: '"e"', Size: 1, ...bad }], IsTruncated: false }] });
    await assert.rejects(() => api.listMultipartParts({ key: KEY, uploadId: UPLOAD_ID }), /malformed part number/);
  }
});

test('9. a missing or invalid ETag is rejected', async () => {
  for (const bad of [{ ETag: undefined }, { ETag: '' }, { ETag: 42 }, { ETag: 'x'.repeat(1025) }]) {
    const { api } = harness({ replies: [{ Parts: [{ PartNumber: 1, Size: 1, ...bad }], IsTruncated: false }] });
    await assert.rejects(() => api.listMultipartParts({ key: KEY, uploadId: UPLOAD_ID }), /malformed etag/);
  }
});

test('10. an invalid part size is rejected', async () => {
  for (const bad of [{ Size: -1 }, { Size: 1.5 }, { Size: 'big' }, { Size: undefined }]) {
    const { api } = harness({ replies: [{ Parts: [{ PartNumber: 1, ETag: '"e"', ...bad }], IsTruncated: false }] });
    await assert.rejects(() => api.listMultipartParts({ key: KEY, uploadId: UPLOAD_ID }), /malformed size/);
  }
  // Zero is legal: a provider may report an empty part.
  const { api } = harness({ replies: [{ Parts: [{ PartNumber: 1, ETag: '"e"', Size: 0 }], IsTruncated: false }] });
  assert.equal((await api.listMultipartParts({ key: KEY, uploadId: UPLOAD_ID }))[0].size, 0);
});

/* -------------------------------------------------------------- completion */

test('11. completion sends parts in ascending order', async () => {
  const { api, sent } = harness({ replies: [{}] });
  await api.completeMultipartUpload({
    key: KEY,
    uploadId: UPLOAD_ID,
    parts: [
      { partNumber: 3, etag: '"c"' },
      { partNumber: 1, etag: '"a"' },
      { partNumber: 2, etag: '"b"' },
    ],
  });

  assert.equal(nameOf(sent[0]), 'CompleteMultipartUploadCommand');
  assert.deepEqual(sent[0].input.MultipartUpload.Parts, [
    { PartNumber: 1, ETag: '"a"' },
    { PartNumber: 2, ETag: '"b"' },
    { PartNumber: 3, ETag: '"c"' },
  ]);
  assert.equal(sent[0].input.UploadId, UPLOAD_ID);
});

test('12. a completion error propagates', async () => {
  // The SDK converts "HTTP 200 with an <Error> body" into a thrown error; the
  // adapter must not swallow it and report a completed upload.
  const boom = Object.assign(new Error('InternalError'), { name: 'InternalError' });
  const { api } = harness({ replies: [boom] });
  await assert.rejects(
    () => api.completeMultipartUpload({ key: KEY, uploadId: UPLOAD_ID, parts: [{ partNumber: 1, etag: '"a"' }] }),
    /InternalError/,
  );
});

/* ------------------------------------------------------------------- abort */

test('13. abort succeeds normally', async () => {
  const { api, sent } = harness({ replies: [{}] });
  assert.equal(await api.abortMultipartUpload({ key: KEY, uploadId: UPLOAD_ID }), true);
  assert.equal(nameOf(sent[0]), 'AbortMultipartUploadCommand');
  assert.equal(sent[0].input.UploadId, UPLOAD_ID);
});

test('14. NoSuchUpload makes abort idempotent', async () => {
  for (const err of [
    Object.assign(new Error('gone'), { name: 'NoSuchUpload' }),
    Object.assign(new Error('gone'), { $metadata: { httpStatusCode: 404 } }),
  ]) {
    const { api } = harness({ replies: [err] });
    assert.equal(await api.abortMultipartUpload({ key: KEY, uploadId: UPLOAD_ID }), true);
  }
});

test('15. an unrelated abort error propagates', async () => {
  const err = Object.assign(new Error('denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
  const { api } = harness({ replies: [err] });
  await assert.rejects(() => api.abortMultipartUpload({ key: KEY, uploadId: UPLOAD_ID }), /denied/);
});

test('injection is a seam, not the default: production builds a real client', () => {
  // Constructing without deps must not throw, and must not reuse a test double.
  const real = createS3Multipart(CONFIG, {});
  assert.equal(typeof real.createMultipartUpload, 'function');
  assert.equal(typeof real.listMultipartParts, 'function');
});
