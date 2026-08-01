/**
 * Grant binding and dishonest-client bodies.
 *
 * The defect these pin down: a client declaring 100 MiB used to receive a
 * grant, a token and an S3 POST policy that all authorized the DEPLOYMENT
 * maximum (up to 3 GiB). The selector protected the metadata while the actual
 * byte authorization stayed deployment-wide.
 *
 * So the assertions here are about what a lying client can actually get away
 * with, at each of the three gates: the signed policy, the local stream, and
 * completion.
 *
 * Run: node --test --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/uploads-grant.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// The local adapter resolves its root at import time, so point it somewhere
// disposable BEFORE requiring it.
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-grant-'));
process.env.UPLOAD_DIR = TMP_ROOT;

const { createUploadIntent } = require('../server/uploads-intent.js');
const { createUploadRuntimeConfig, HARD_LOCAL_UPLOAD_BYTES } = require('../server/uploads-multipart.js');
const { validateSingleUploadGrant } = require('../server/upload-limits.js');
const { createS3Storage, buildPostPolicy } = require('../server/storage/s3.js');
const { issueUploadToken, verifyUploadToken } = require('../server/uploads.js');
const { finalizeUpload } = require('../server/uploads-finalize.js');
const local = require('../server/storage/local.js');

const MIB = 1024 * 1024;
const GIB = 1024 * 1024 * 1024;
const SECRET = 'x'.repeat(32);
const KEY = 'rooms/ABC123/0123456789abcdef/movie.mp4';
const S3_FULL = {
  S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
  S3_BUCKET: 'cineverse',
  S3_ACCESS_KEY_ID: 'AKIAEXAMPLE',
  S3_SECRET_ACCESS_KEY: 'secret',
};
const BIG_ENV = { MAX_UPLOAD_BYTES: String(3 * GIB), ...S3_FULL };

const decodePolicy = (fields) => JSON.parse(Buffer.from(fields.Policy, 'base64').toString('utf8'));
const rangeOf = (policy) => policy.conditions.find((c) => Array.isArray(c) && c[0] === 'content-length-range');

/* ==================================================== policy and token */

test('a 100 MiB declaration on a 3 GiB deployment produces an exact-size grant', async () => {
  const uploadConfig = createUploadRuntimeConfig(BIG_ENV, { objectStorage: true }).config;
  const result = await createUploadIntent({
    payload: { fileName: 'movie.mp4', mimeType: 'video/mp4', size: 100 * MIB },
    uploadConfig,
    storage: createS3Storage(BIG_ENV),
    secret: SECRET,
    roomCode: 'ABC123',
  });

  assert.equal(result.ok, true);
  const claims = verifyUploadToken(result.token, SECRET);
  const range = rangeOf(decodePolicy(result.fields));

  assert.equal(uploadConfig.effectiveMaxBytes, 3 * GIB, 'the deployment really is 3 GiB');
  assert.equal(claims.expectedBytes, 100 * MIB, 'token.expectedBytes = declared size');
  assert.ok(claims.maxBytes <= 500 * MIB, `token.maxBytes ${claims.maxBytes} must be <= 500 MiB`);
  assert.equal(range[1], 100 * MIB, 'policy minimum = declared size');
  assert.equal(range[2], 100 * MIB, 'policy maximum = declared size');
  // The whole point: the deployment capacity appears nowhere in the grant.
  assert.notEqual(range[2], 3 * GIB);
  assert.notEqual(claims.maxBytes, 3 * GIB);
});

test('the policy pins both ends for every accepted size', async () => {
  const uploadConfig = createUploadRuntimeConfig(BIG_ENV, { objectStorage: true }).config;
  const storage = createS3Storage(BIG_ENV);
  for (const size of [1, 4096, 50 * MIB, HARD_LOCAL_UPLOAD_BYTES]) {
    const result = await createUploadIntent({
      payload: { fileName: 'm.mp4', mimeType: 'video/mp4', size },
      uploadConfig,
      storage,
      secret: SECRET,
      roomCode: 'ABC123',
    });
    const range = rangeOf(decodePolicy(result.fields));
    assert.deepEqual([range[1], range[2]], [size, size], `size ${size}`);
  }
});

test('buildPostPolicy still refuses a grant whose byte fields are wrong', () => {
  // Superseded in scope by the full-grant suite at the end of this file; kept
  // because the byte fields are the ones an internal caller is most likely to
  // get wrong, and the error must name the reason.
  const config = { endpoint: 'https://a.b', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's', region: 'auto' };
  const base = { transport: 'single', key: KEY, mimeType: 'video/mp4', roomCode: 'ABC123' };
  const bad = [
    [{ expectedBytes: undefined, maxBytes: 100 }, /BAD_SIZE/],
    [{ expectedBytes: 0, maxBytes: 100 }, /BAD_SIZE/],
    [{ expectedBytes: 1.5, maxBytes: 100 }, /BAD_SIZE/],
    [{ expectedBytes: -1, maxBytes: 100 }, /BAD_SIZE/],
    [{ expectedBytes: 100, maxBytes: undefined }, /BAD_LIMIT/],
    [{ expectedBytes: 100, maxBytes: 0 }, /BAD_LIMIT/],
    [{ expectedBytes: 200, maxBytes: 100 }, /SIZE_EXCEEDS_LIMIT/],
    [{ expectedBytes: 100, maxBytes: 3 * GIB }, /LIMIT_TOO_HIGH/],
  ];
  for (const [over, pattern] of bad) {
    assert.throws(() => buildPostPolicy({ ...base, ...over }, config, 900), pattern, JSON.stringify(over));
  }
  assert.ok(buildPostPolicy({ ...base, expectedBytes: 100, maxBytes: 1000 }, config, 900).fields.Policy);
});

/* ================================================= token v2 semantics */

test('a v1 token is refused outright', () => {
  // Hand-build a v1 body with the same secret: correct signature, old shape.
  const crypto = require('node:crypto');
  const body = { k: KEY, m: 'video/mp4', b: 3 * GIB, r: 'ABC123', e: Date.now() + 60_000 };
  const encoded = Buffer.from(JSON.stringify(body)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(encoded).digest('base64url');
  assert.equal(verifyUploadToken(`${encoded}.${sig}`, SECRET), null, 'a v1 grant must not be honoured');
});

test('the issuer refuses every out-of-contract grant', () => {
  /*
   * Superseded by design: this used to assert that the ISSUER minted an
   * impossible grant and the VERIFIER caught it. The issuer now validates
   * before signing, so it can no longer produce such a capability at all -
   * which is the stronger guarantee. Correctly-signed-but-invalid tokens are
   * covered in uploads-token.test.mjs using a test-only signer.
   */
  const base = { key: KEY, mimeType: 'video/mp4', roomCode: 'ABC123', transport: 'single', expectedBytes: 100, maxBytes: 1000 };
  const mint = (over) => () => issueUploadToken({ ...base, ...over }, SECRET);

  assert.ok(verifyUploadToken(mint({})(), SECRET), 'a sane grant still round-trips');

  assert.throws(mint({ expectedBytes: 2000, maxBytes: 1000 }), /SIZE_EXCEEDS_LIMIT/);
  assert.throws(mint({ expectedBytes: 0 }), /BAD_SIZE/);
  assert.throws(mint({ expectedBytes: 1.5 }), /BAD_SIZE/);
  assert.throws(mint({ expectedBytes: undefined }), /BAD_SIZE/);
  assert.throws(mint({ maxBytes: 3 * GIB }), /LIMIT_TOO_HIGH/);
  assert.throws(mint({ transport: 'multipart' }), /BAD_TRANSPORT/);
  assert.throws(mint({ roomCode: 'ZZZ999' }), /ROOM_KEY_MISMATCH/);
  assert.throws(mint({ key: '../../etc/passwd' }), /BAD_KEY/);
  assert.throws(mint({ mimeType: 'application/zip' }), /UNSUPPORTED_TYPE/);

  // Every rejection names the grant contract, so a failure is diagnosable.
  assert.throws(mint({ transport: 'multipart' }), /refusing to sign an invalid grant/);
});


/* ====================================== lying clients: local adapter */

const grantFor = (expectedBytes) => ({
  // A COMPLETE grant: finalizeUpload defaults nothing.
  transport: 'single',
  key: KEY,
  mimeType: 'video/mp4',
  expectedBytes,
  maxBytes: HARD_LOCAL_UPLOAD_BYTES,
  roomCode: 'ABC123',
});
const bodyOf = (bytes) => Readable.from([Buffer.alloc(bytes, 7)]);
const storedSize = async () => {
  const stat = await local.statObject(KEY);
  return stat ? stat.size : null;
};

test('declare 100 KiB, upload exactly 100 KiB: succeeds', async () => {
  const declared = 100 * 1024;
  const saved = await local.saveStream(KEY, bodyOf(declared), HARD_LOCAL_UPLOAD_BYTES, declared);
  assert.equal(saved.size, declared);
  assert.equal(await storedSize(), declared);
  await local.deleteObject(KEY);
});

test('declare 100 KiB, upload 101 KiB: rejected mid-stream and deleted', async () => {
  const declared = 100 * 1024;
  await assert.rejects(
    () => local.saveStream(KEY, bodyOf(declared + 1024), HARD_LOCAL_UPLOAD_BYTES, declared),
    (err) => err.code === 'SIZE_MISMATCH' || err.code === 'TOO_LARGE',
  );
  assert.equal(await storedSize(), null, 'the partial object must not survive');
});

test('declare 100 KiB, upload a 3 GiB-shaped body: cut off at the declared size', async () => {
  // Streamed in chunks so nothing allocates gigabytes; the guard must fire on
  // the first chunk past the declaration rather than after reading it all.
  const declared = 100 * 1024;
  let produced = 0;
  const huge = new Readable({
    read() {
      if (produced >= 8 * MIB) return this.push(null);
      produced += 64 * 1024;
      this.push(Buffer.alloc(64 * 1024, 1));
    },
  });
  await assert.rejects(
    () => local.saveStream(KEY, huge, HARD_LOCAL_UPLOAD_BYTES, declared),
    (err) => err.code === 'SIZE_MISMATCH' || err.code === 'TOO_LARGE',
  );
  assert.equal(await storedSize(), null);
  assert.ok(produced < 8 * MIB, `must stop early, read ${produced} bytes`);
});

test('declare 100 KiB, upload 99 KiB: rejected on completion and deleted', async () => {
  const declared = 100 * 1024;
  await assert.rejects(
    () => local.saveStream(KEY, bodyOf(declared - 1024), HARD_LOCAL_UPLOAD_BYTES, declared),
    (err) => err.code === 'SIZE_MISMATCH',
  );
  assert.equal(await storedSize(), null, 'a short object must not survive');
});

/* ============================================ completion verification */

/** A storage double whose stored object size we control. */
function storageWithSize(size) {
  const deleted = [];
  return {
    deleted,
    async statObject() {
      return { size, contentType: 'video/mp4' };
    },
    async deleteObject(key) {
      deleted.push(key);
      return true;
    },
    async createReadUrl() {
      return 'https://cdn/movie.mp4';
    },
  };
}

test('completion rejects a short object with SIZE_MISMATCH and deletes it', async () => {
  const storage = storageWithSize(99 * MIB);
  const result = await finalizeUpload({ storage, claims: { ...grantFor(100 * MIB) }, label: 'Movie' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'SIZE_MISMATCH');
  assert.deepEqual(storage.deleted, [KEY]);
});

test('completion rejects a long object and deletes it', async () => {
  const storage = storageWithSize(101 * MIB);
  const result = await finalizeUpload({ storage, claims: { ...grantFor(100 * MIB) }, label: 'Movie' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'SIZE_MISMATCH');
  assert.deepEqual(storage.deleted, [KEY]);
});

test('completion accepts an exact match and returns the source', async () => {
  const storage = storageWithSize(100 * MIB);
  const result = await finalizeUpload({ storage, claims: { ...grantFor(100 * MIB) }, label: 'Movie' });
  assert.equal(result.ok, true);
  assert.equal(result.source.type, 'url');
  assert.deepEqual(storage.deleted, [], 'nothing may be deleted on success');
});

test('completion still rejects zero-byte and over-cap objects first', async () => {
  const empty = storageWithSize(0);
  assert.equal((await finalizeUpload({ storage: empty, claims: grantFor(100 * MIB), label: 'x' })).error, 'BAD_SIZE');

  const over = storageWithSize(HARD_LOCAL_UPLOAD_BYTES + 1);
  assert.equal((await finalizeUpload({ storage: over, claims: grantFor(100 * MIB), label: 'x' })).error, 'TOO_LARGE');
});

test.after(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
});


/* ------------------ the shared validator gates S3 signing (item 5) ------------------ */

test('buildPostPolicy refuses every invalid grant, and signs a valid one', () => {
  const config = { endpoint: 'https://a.b', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's', region: 'auto' };
  const good = {
    transport: 'single',
    key: KEY,
    mimeType: 'video/mp4',
    roomCode: 'ABC123',
    expectedBytes: 100 * MIB,
    maxBytes: HARD_LOCAL_UPLOAD_BYTES,
  };

  // A signed policy is a capability. Checking only the byte fields let one be
  // minted for a malformed key, an unsupported MIME or a mismatched room.
  const bad = [
    ['invalid key', { key: '../../etc/passwd' }],
    ['key type mismatch', { key: 'rooms/ABC123/0123456789abcdef/movie.webm' }],
    ['unsupported MIME', { mimeType: 'application/zip' }],
    ['missing room', { roomCode: undefined }],
    ['empty room', { roomCode: '' }],
    ['room/key mismatch', { roomCode: 'ZZZ999' }],
    ['missing transport', { transport: undefined }],
    ['multipart transport', { transport: 'multipart' }],
    ['invalid expected size', { expectedBytes: 0 }],
    ['fractional expected size', { expectedBytes: 1.5 }],
    ['expected above max', { expectedBytes: 600 * MIB, maxBytes: 500 * MIB }],
    ['over-ceiling max', { maxBytes: 3 * GIB }],
  ];
  for (const [label, over] of bad) {
    assert.throws(
      () => buildPostPolicy({ ...good, ...over }, config, 900),
      /buildPostPolicy: invalid grant/,
      `${label} must not produce a policy`,
    );
  }

  // The valid grant signs an EXACT-size policy.
  const { fields } = buildPostPolicy(good, config, 900, 0);
  const policy = JSON.parse(Buffer.from(fields.Policy, 'base64').toString('utf8'));
  const range = policy.conditions.find((c) => Array.isArray(c) && c[0] === 'content-length-range');
  assert.deepEqual(range, ['content-length-range', 100 * MIB, 100 * MIB]);
});

test('the S3 adapter forwards the whole grant, so signing is gated end to end', async () => {
  const storage = createS3Storage(S3_FULL);
  // A grant the shared validator rejects must not yield a target, even though
  // the byte fields are perfectly reasonable.
  await assert.rejects(
    () =>
      storage.createUploadTarget({
        transport: 'single',
        key: KEY,
        mimeType: 'video/mp4',
        roomCode: 'ZZZ999', // does not match the room in the key
        expectedBytes: 1024,
        maxBytes: 2048,
      }),
    /invalid grant \(ROOM_KEY_MISMATCH\)/,
  );

  const target = await storage.createUploadTarget({
    transport: 'single',
    key: KEY,
    mimeType: 'video/mp4',
    roomCode: 'ABC123',
    expectedBytes: 1024,
    maxBytes: 2048,
  });
  assert.equal(target.method, 'POST');
  assert.equal(target.expectedBytes, 1024);
});

test('the key extension must agree with the signed MIME', () => {
  // buildObjectKey already guarantees this; the validator preserves it so a
  // hand-built internal grant cannot sign an object whose stored name disagrees
  // with its declared type.
  const webmKey = 'rooms/ABC123/0123456789abcdef/movie.webm';
  const base = { transport: 'single', roomCode: 'ABC123', expectedBytes: 1024, maxBytes: 2048 };
  assert.equal(validateSingleUploadGrant({ ...base, key: webmKey, mimeType: 'video/webm' }).ok, true);
  assert.equal(validateSingleUploadGrant({ ...base, key: webmKey, mimeType: 'video/mp4' }).error, 'KEY_TYPE_MISMATCH');
  assert.equal(validateSingleUploadGrant({ ...base, key: KEY, mimeType: 'video/webm' }).error, 'KEY_TYPE_MISMATCH');
});
