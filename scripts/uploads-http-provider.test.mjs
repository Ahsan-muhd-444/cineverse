/**
 * The multipart pipeline against a REAL cross-origin HTTP provider.
 *
 * This is the runnable substitute for the parts of the browser suite that a real
 * DOM would exercise: it starts the mock object-storage bucket on its own origin
 * and drives the WHOLE server pipeline against it over HTTP — the Node adapter's
 * control calls AND simulated browser part PUTs that read the `ETag` response
 * header, exactly as the engine does. Everything but the browser's own security
 * model (CORS enforcement, File.slice, the rendered DOM) is exercised here.
 *
 * Why this exists as a `node --test` suite: the Playwright runner cannot execute
 * in this sandbox (its worker-process IPC is blocked), so the real-browser specs
 * in scripts/browser/*.spec.mjs are implemented but unrunnable HERE. This suite
 * proves the cross-origin control + part + ETag + complete + read flow with real
 * HTTP, so the gap that remains genuinely browser-only is small and named.
 *
 * Run: node --test --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/uploads-http-provider.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import { startMockBucket } from './mock-bucket.mjs';

const require = createRequire(import.meta.url);
const { createMockHttpMultipartStorage } = require('../server/storage/mock-http-multipart.js');
const { createUploadIntent } = require('../server/uploads-intent.js');
const { createUploadSessionRegistry } = require('../server/uploads-sessions.js');
const svc = require('../server/uploads-multipart-service.js');
const { createUploadRuntimeConfig } = require('../server/uploads-multipart.js');
const { createStorage } = require('../server/storage/index.js');

const MIB = 1024 * 1024;
const SECRET = 'a-stable-upload-secret-of-32-bytes!!';
const ROOM = 'ABC123';
const MEMBER = 'member-1';
const FIXTURE_BYTES = 17 * MIB;
const PART_SIZE = 8 * MIB;

let bucket;
let storage;
let uploadConfig;

test.before(async () => {
  bucket = await startMockBucket({ exposeEtag: true });
  storage = createMockHttpMultipartStorage({ origin: bucket.origin });
  uploadConfig = createUploadRuntimeConfig(
    { MAX_UPLOAD_BYTES: String(3 * 1024 * MIB), UPLOAD_PART_SIZE_BYTES: String(PART_SIZE), UPLOAD_SECRET: SECRET },
    { objectStorage: true, storage, contractMounted: true, singleShotMaxBytes: 4 * MIB },
  ).config;
});
test.after(async () => {
  if (bucket) await bucket.close();
});
test.beforeEach(async () => {
  await fetch(`${bucket.origin}/_control/reset`, { method: 'POST' });
});

function sessions() {
  return createUploadSessionRegistry({ maxPerMember: uploadConfig.maxActivePerMember, maxPerRoom: uploadConfig.maxActivePerRoom });
}
const ctx = (reg, token) => ({ token, storage, secret: SECRET, roomCode: ROOM, memberId: MEMBER, sessions: reg, uploadConfig });

async function intent(reg, over = {}) {
  return createUploadIntent({
    payload: { fileName: 'movie.mp4', mimeType: 'video/mp4', size: FIXTURE_BYTES, ...over },
    uploadConfig,
    storage,
    secret: SECRET,
    roomCode: ROOM,
    memberId: MEMBER,
    sessions: reg,
  });
}

/**
 * Simulate the browser: request a target per part, PUT the exact slice size, and
 * READ the ETag from the response header (the real acknowledgement path).
 */
async function uploadParts(reg, plan, { corrupt } = {}) {
  const manifest = [];
  for (let n = 1; n <= plan.partCount; n += 1) {
    const targets = await svc.requestPartTargets({ ...ctx(reg, plan.token), partNumbers: [n] });
    assert.equal(targets.ok, true, `targets ${n}: ${targets.error}`);
    const target = targets.targets[0];
    const res = await fetch(target.url, { method: 'PUT', body: Buffer.alloc(target.expectedBytes, 1) });
    assert.equal(res.status, 200, `PUT ${n}`);
    const etag = corrupt === n ? '"0123456789abcdef0123456789abcdef"' : res.headers.get('etag');
    assert.ok(etag, `ETag header must be present for part ${n}`);
    manifest.push({ partNumber: n, etag });
  }
  return manifest;
}

/* ============================================== happy path */

test('intent → cross-origin part PUTs → ETag read → status → complete → readable object', async () => {
  const reg = sessions();
  const plan = await intent(reg);
  assert.equal(plan.mode, 'multipart', plan.error);
  assert.equal(plan.partCount, 3);
  assert.equal(plan.lastPartSize, MIB);

  const manifest = await uploadParts(reg, plan);

  const status = await svc.readUploadStatus(ctx(reg, plan.token));
  assert.equal(status.ok, true);
  assert.equal(status.uploadedBytes, FIXTURE_BYTES);
  assert.equal(status.status, 'finalizing');

  const done = await svc.completeMultipartUpload({ ...ctx(reg, plan.token), parts: manifest, label: 'My Movie' });
  assert.equal(done.ok, true, done.error);
  assert.equal(done.source.quality, 'Uploaded');
  assert.match(done.source.value, /\/object\/rooms\/ABC123\//);

  // The provider is consistent: the multipart upload is consumed, one object.
  const inspect = await (await fetch(`${bucket.origin}/_control/inspect`)).json();
  assert.equal(inspect.openUploads, 0);
  assert.equal(inspect.objects.length, 1);

  // The finished object reads back over HTTP, full and Range — real playback path.
  const full = await fetch(done.source.value);
  assert.equal(full.status, 200);
  assert.equal(Number(full.headers.get('content-length')), FIXTURE_BYTES);
  const ranged = await fetch(done.source.value, { headers: { Range: 'bytes=0-1023' } });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get('content-range'), `bytes 0-1023/${FIXTURE_BYTES}`);

  // A progress replay after completion is refused by the terminal tombstone.
  const replay = svc.buildRoomProgress({
    mode: 'multipart',
    token: plan.token,
    secret: SECRET,
    roomCode: ROOM,
    memberId: MEMBER,
    memberName: 'A',
    sessions: reg,
    label: 'x',
    uploadedBytes: 1,
    totalBytes: FIXTURE_BYTES,
    status: 'uploading',
  });
  assert.equal(replay.error, 'SESSION_TERMINAL');
});

test('the ETag the browser reads is exactly what completion is verified against', async () => {
  const reg = sessions();
  const plan = await intent(reg);
  const manifest = await uploadParts(reg, plan);
  // Corrupt the ETag the "browser" reports for part 2 → completion must refuse it,
  // proving the ETag round-trip is load-bearing, not decorative.
  const tampered = manifest.map((p) => (p.partNumber === 2 ? { ...p, etag: '"deadbeefdeadbeefdeadbeefdeadbeef"' } : p));
  const done = await svc.completeMultipartUpload({ ...ctx(reg, plan.token), parts: tampered, label: 'x' });
  assert.equal(done.ok, false);
  assert.equal(done.error, 'ETAG_MISMATCH');
  assert.equal(done.terminal, true);
});

/* ============================================== failure + idempotency over HTTP */

test('a missing part is refused and nothing is published', async () => {
  const reg = sessions();
  const plan = await intent(reg);
  const partial = await uploadParts(reg, { ...plan, partCount: 2 });
  const done = await svc.completeMultipartUpload({ ...ctx(reg, plan.token), parts: partial, label: 'x' });
  assert.equal(done.ok, false);
  assert.equal(done.error, 'PART_COUNT_MISMATCH');
  const inspect = await (await fetch(`${bucket.origin}/_control/inspect`)).json();
  assert.equal(inspect.objects.length, 0);
});

test('completion is idempotent against the HTTP provider', async () => {
  const reg = sessions();
  const plan = await intent(reg);
  const manifest = await uploadParts(reg, plan);

  const first = await svc.completeMultipartUpload({ ...ctx(reg, plan.token), parts: manifest, label: 'Movie' });
  assert.equal(first.ok, true);
  assert.equal(first.replayed, undefined);
  // The provider upload is gone; a retry HEADs the object and replays the result.
  const second = await svc.completeMultipartUpload({ ...ctx(reg, plan.token), parts: manifest, label: 'Movie' });
  assert.equal(second.ok, true, second.error);
  assert.equal(second.replayed, true);
  const inspect = await (await fetch(`${bucket.origin}/_control/inspect`)).json();
  assert.equal(inspect.objects.length, 1);
});

test('abort tears down the provider upload over HTTP and is idempotent', async () => {
  const reg = sessions();
  const plan = await intent(reg);
  await uploadParts(reg, { ...plan, partCount: 2 });
  let inspect = await (await fetch(`${bucket.origin}/_control/inspect`)).json();
  assert.equal(inspect.openUploads, 1);

  const aborted = await svc.abortMultipartUpload(ctx(reg, plan.token));
  assert.equal(aborted.ok, true);
  inspect = await (await fetch(`${bucket.origin}/_control/inspect`)).json();
  assert.equal(inspect.openUploads, 0, 'the provider multipart upload is gone');

  // A second abort is idempotent success; the session tombstone refuses a replay.
  const again = await svc.abortMultipartUpload(ctx(reg, plan.token));
  assert.equal(again.ok, true);
  assert.equal(reg.progressVerdict(plan.token, Date.now()).error, 'SESSION_TERMINAL');
});

test('the active-upload limit holds against the HTTP provider without orphaning', async () => {
  const reg = sessions();
  const first = await intent(reg);
  assert.equal(first.ok, true);
  const second = await intent(reg, { fileName: 'other.mp4' });
  assert.equal(second.ok, false);
  assert.equal(second.error, 'UPLOAD_ALREADY_ACTIVE');
  // Exactly one provider multipart upload was ever created.
  const inspect = await (await fetch(`${bucket.origin}/_control/inspect`)).json();
  assert.equal(inspect.openUploads, 1);
});

/* ============================================== test-mode storage guard */

/* ============================================== item 7: incomplete bodies */

/** PUT a part but hang up mid-body: declare `declared` bytes, send only `sent`. */
function putPartTruncated(origin, uploadId, partNumber, declared, sent) {
  return new Promise((resolve) => {
    const u = new URL(`${origin}/part/${encodeURIComponent(uploadId)}/${partNumber}`);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname, method: 'PUT', headers: { 'Content-Length': String(declared) } },
      (res) => {
        res.resume();
        res.on('end', () => resolve('responded'));
      },
    );
    req.on('error', () => resolve('reset'));
    req.write(Buffer.alloc(sent, 1));
    // Never call req.end(): the declared length is never fulfilled, then we kill
    // the socket, so the server sees `close` without `end`.
    setTimeout(() => {
      req.destroy();
      setTimeout(() => resolve('destroyed'), 60);
    }, 40);
  });
}

test('a part body cut off mid-upload is NOT committed', async () => {
  const reg = sessions();
  const plan = await intent(reg);
  const { uploadId } = plan;

  // Send 1 KiB of a declared 8 MiB part, then destroy.
  await putPartTruncated(bucket.origin, uploadId, 1, 8 * MIB, 1024);
  // And almost the whole part, then destroy.
  await putPartTruncated(bucket.origin, uploadId, 2, 8 * MIB, 8 * MIB - 4096);

  const status = await svc.readUploadStatus(ctx(reg, plan.token));
  assert.equal(status.ok, true, status.error);
  assert.deepEqual(status.completedParts, [], 'no truncated part may be listed');
  assert.equal(status.uploadedBytes, 0);
});

test('a cleanly-sent part IS committed with its exact size and a readable ETag', async () => {
  const reg = sessions();
  const plan = await intent(reg);
  const targets = await svc.requestPartTargets({ ...ctx(reg, plan.token), partNumbers: [1] });
  const res = await fetch(targets.targets[0].url, { method: 'PUT', body: Buffer.alloc(8 * MIB, 1) });
  assert.equal(res.status, 200);
  assert.ok(res.headers.get('etag'));

  const status = await svc.readUploadStatus(ctx(reg, plan.token));
  assert.equal(status.completedParts.length, 1);
  assert.equal(status.completedParts[0].partNumber, 1);
  assert.equal(status.completedParts[0].size, 8 * MIB, 'exact size');
  assert.ok(status.completedParts[0].etag);
});

/* ============================================== item 8: real deletion */

test('deleteObject actually removes the object from the bucket', async () => {
  const reg = sessions();
  const plan = await intent(reg);
  const manifest = await uploadParts(reg, plan);
  const done = await svc.completeMultipartUpload({ ...ctx(reg, plan.token), parts: manifest, label: 'x' });
  assert.equal(done.ok, true, done.error);

  // The object exists and reads back…
  assert.equal(await storage.statObject(plan.key) !== null, true);
  assert.equal((await fetch(done.source.value)).status, 200);

  // …deleteObject removes it: stat is null and the read route 404s.
  assert.equal(await storage.deleteObject(plan.key), true);
  assert.equal(await storage.statObject(plan.key), null);
  assert.equal((await fetch(done.source.value)).status, 404);
});

test('a completion that fails final verification leaves NO object behind', async () => {
  const reg = sessions();
  const plan = await intent(reg);
  const manifest = await uploadParts(reg, plan);
  // Corrupt the client's ETag for part 2 → the completion is terminal, and the
  // service aborts the provider upload. No object is ever assembled.
  const tampered = manifest.map((p) => (p.partNumber === 2 ? { ...p, etag: '"deadbeefdeadbeefdeadbeefdeadbeef"' } : p));
  const done = await svc.completeMultipartUpload({ ...ctx(reg, plan.token), parts: tampered, label: 'x' });
  assert.equal(done.ok, false);
  assert.equal(done.terminal, true);
  assert.equal(await storage.statObject(plan.key), null, 'no object may exist after a failed completion');
  const inspect = await (await fetch(`${bucket.origin}/_control/inspect`)).json();
  assert.equal(inspect.objects.length, 0);
});

test('the mock adapter is selected ONLY under the test-mode gate, and production refuses it', () => {
  // Normal dev/prod without the flag never gets the mock.
  assert.notEqual(createStorage({}).name, 'mock-http');
  assert.notEqual(createStorage({ NODE_ENV: 'production' }).name, 'mock-http');

  // The flag needs NODE_ENV=test AND an origin.
  assert.throws(() => createStorage({ NODE_ENV: 'production', UPLOAD_TEST_MODE: '1', UPLOAD_TEST_BUCKET_ORIGIN: bucket.origin }), /never be set in production/);
  assert.throws(() => createStorage({ NODE_ENV: 'development', UPLOAD_TEST_MODE: '1', UPLOAD_TEST_BUCKET_ORIGIN: bucket.origin }), /requires NODE_ENV=test/);
  assert.throws(() => createStorage({ NODE_ENV: 'test', UPLOAD_TEST_MODE: '1' }), /requires UPLOAD_TEST_BUCKET_ORIGIN/);

  const selected = createStorage({ NODE_ENV: 'test', UPLOAD_TEST_MODE: '1', UPLOAD_TEST_BUCKET_ORIGIN: bucket.origin });
  assert.equal(selected.name, 'mock-http');
  assert.equal(selected.direct, true);
  assert.equal(selected.multipart, true);
});
