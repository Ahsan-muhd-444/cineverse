/**
 * Observable session expiry and completion-failure classification.
 *
 * Two things the review found the server CLAIMED but never did:
 *   - expiry cleaned up nothing (no path cleared room progress when a token aged
 *     out);
 *   - completion cleared the bar on `result.ok` alone, conflating a transient
 *     retryable hiccup with a fatal manifest mismatch.
 *
 * These drive `runExpirySweep` and the completion service with a fake clock and
 * the mock provider, so both are asserted without waiting real minutes.
 *
 * Run: node --test --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/uploads-expiry.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createMockMultipartStorage } = require('../server/storage/mock-multipart.js');
const { createUploadSessionRegistry } = require('../server/uploads-sessions.js');
const { runExpirySweep } = require('../server/uploads-contract.js');
const svc = require('../server/uploads-multipart-service.js');
const { issueMultipartToken, createUploadRuntimeConfig } = require('../server/uploads-multipart.js');

const MIB = 1024 * 1024;
const SECRET = 'a-stable-upload-secret-of-32-bytes!!';
const ROOM = 'ABC123';
const MEMBER = 'member-1';
const KEY = 'rooms/ABC123/0123456789abcdef/movie.mp4';
const FIXTURE_BYTES = 17 * MIB;
const PART_SIZE = 8 * MIB;
const PART_COUNT = 3;
const T0 = 1_700_000_000_000;
const TTL_MS = 6 * 3600_000;

function setup() {
  const storage = createMockMultipartStorage();
  const { config } = createUploadRuntimeConfig(
    { MAX_UPLOAD_BYTES: String(3 * 1024 * MIB), UPLOAD_PART_SIZE_BYTES: String(PART_SIZE), UPLOAD_SECRET: SECRET },
    { objectStorage: true, storage, contractMounted: true },
  );
  const sessions = createUploadSessionRegistry({ maxPerMember: config.maxActivePerMember, maxPerRoom: config.maxActivePerRoom });
  return { storage, uploadConfig: config, sessions };
}

async function openSession(env, { now = T0, memberId = MEMBER } = {}) {
  const { uploadId } = await env.storage.createMultipartUpload({ key: KEY, mimeType: 'video/mp4' });
  const expiresAt = now + TTL_MS;
  const token = issueMultipartToken(
    {
      key: KEY,
      uploadId,
      roomCode: ROOM,
      memberId,
      mimeType: 'video/mp4',
      expectedBytes: FIXTURE_BYTES,
      maxBytes: env.uploadConfig.multipartMaxBytes,
      partSize: PART_SIZE,
      partCount: PART_COUNT,
      expiresAt,
    },
    SECRET,
    now,
  );
  env.sessions.register({ token, roomCode: ROOM, memberId, key: KEY, uploadId, expectedBytes: FIXTURE_BYTES, partCount: PART_COUNT, expiresAt, now });
  return { token, uploadId, expiresAt };
}

const ctx = (env, token, now) => ({
  token,
  storage: env.storage,
  secret: SECRET,
  roomCode: ROOM,
  memberId: MEMBER,
  sessions: env.sessions,
  now,
});

async function fillParts(env, uploadId) {
  const manifest = [];
  for (let n = 1; n <= PART_COUNT; n += 1) {
    const size = n === PART_COUNT ? FIXTURE_BYTES - (PART_COUNT - 1) * PART_SIZE : PART_SIZE;
    manifest.push({ partNumber: n, etag: env.storage.putPart({ key: KEY, uploadId, partNumber: n, size }) });
  }
  return manifest;
}

/* ============================================== the sweeper */

test('an active session before expiry survives a sweep', async () => {
  const env = setup();
  await openSession(env);
  const expired = await runExpirySweep({ sessions: env.sessions, storage: env.storage, now: T0 + TTL_MS - 1000 });
  assert.deepEqual(expired, []);
  assert.equal(env.storage.openUploadCount(), 1, 'the provider session is untouched');
});

test('an expired multipart session is swept, aborted once, and reported for clearing', async () => {
  const env = setup();
  const { uploadId } = await openSession(env);
  assert.equal(env.storage.openUploadCount(), 1);

  const expired = await runExpirySweep({ sessions: env.sessions, storage: env.storage, now: T0 + TTL_MS + 1 });
  assert.equal(expired.length, 1);
  assert.equal(expired[0].memberId, MEMBER);
  assert.equal(expired[0].roomCode, ROOM);
  assert.equal(expired[0].uploadId, uploadId);
  // The provider multipart upload was aborted exactly once.
  assert.equal(env.storage.callsFor('abortMultipartUpload').length, 1);
  assert.equal(env.storage.openUploadCount(), 0);
  // The session is now an expired tombstone (found by its hash — the sweep never
  // exposes the raw token).
  assert.equal(env.sessions.getByHash(expired[0].tokenHash).status, 'expired');
});

test('the sweep aborts each expired provider upload exactly once across a second pass', async () => {
  const env = setup();
  await openSession(env);
  await runExpirySweep({ sessions: env.sessions, storage: env.storage, now: T0 + TTL_MS + 1 });
  // A second pass must not abort again — the session is already terminal.
  await runExpirySweep({ sessions: env.sessions, storage: env.storage, now: T0 + TTL_MS + 2 });
  assert.equal(env.storage.callsFor('abortMultipartUpload').length, 1);
});

test('an expired single-shot grant is swept without a provider abort', async () => {
  const env = setup();
  env.sessions.register({
    token: 'single-token',
    transport: 'single',
    roomCode: ROOM,
    memberId: 'member-2',
    key: KEY,
    expectedBytes: 1024,
    expiresAt: T0 + 1000,
    now: T0,
  });
  const expired = await runExpirySweep({ sessions: env.sessions, storage: env.storage, now: T0 + 2000 });
  assert.equal(expired.length, 1);
  assert.equal(expired[0].transport, 'single');
  // No provider abort for a single-shot grant — it never had a multipart upload.
  assert.equal(env.storage.callsFor('abortMultipartUpload').length, 0);
});

test('a mixed sweep clears both transports and leaves live sessions alone', async () => {
  const env = setup();
  await openSession(env, { memberId: 'stale-member' }); // will expire
  // A live session opened "later" so its expiry is in the future for the sweep.
  await openSession(env, { now: T0 + TTL_MS, memberId: 'live-member' });
  env.sessions.register({ token: 'single', transport: 'single', roomCode: ROOM, memberId: 'single-member', key: KEY, expectedBytes: 10, expiresAt: T0 + 1000, now: T0 });

  const expired = await runExpirySweep({ sessions: env.sessions, storage: env.storage, now: T0 + TTL_MS + 1 });
  const members = expired.map((e) => e.memberId).sort();
  assert.deepEqual(members, ['single-member', 'stale-member']);
  // The live session's provider upload is untouched.
  assert.equal(env.storage.openUploadCount(), 1);
});

/* ============================================== completion classification */

test('a retryable completion failure keeps the session active', async () => {
  const env = setup();
  const { token, uploadId } = await openSession(env);
  const manifest = await fillParts(env, uploadId);

  // A transient provider Complete failure.
  env.storage.fail('completeFails');
  const result = await svc.completeMultipartUpload({ ...ctx(env, token, T0 + 1000), parts: manifest, label: 'x' });

  assert.equal(result.ok, false);
  assert.equal(result.retryable, true);
  assert.equal(result.terminal, false);
  assert.equal(result.error, 'COMPLETE_FAILED');
  // The session is handed back to the client to retry — NOT torn down.
  assert.equal(env.sessions.get(token).status, 'uploading');
  assert.equal(env.storage.openUploadCount(), 1, 'the provider session is preserved');

  // And a retry, once the fault clears, succeeds.
  env.storage.clearFaults();
  const retry = await svc.completeMultipartUpload({ ...ctx(env, token, T0 + 2000), parts: manifest, label: 'x' });
  assert.equal(retry.ok, true, retry.error);
  assert.equal(retry.terminal, true);
  assert.equal(env.sessions.get(token).status, 'completed');
});

test('a terminal completion failure tears the session down and cannot be replayed', async () => {
  const env = setup();
  const { token, uploadId } = await openSession(env);
  const manifest = await fillParts(env, uploadId);
  // Corrupt the client's ETag for part 2: a manifest mismatch.
  manifest[1] = { partNumber: 2, etag: '"deadbeefdeadbeefdeadbeefdeadbeef"' };

  const result = await svc.completeMultipartUpload({ ...ctx(env, token, T0 + 1000), parts: manifest, label: 'x' });
  assert.equal(result.ok, false);
  assert.equal(result.retryable, false);
  assert.equal(result.terminal, true);
  assert.equal(result.error, 'ETAG_MISMATCH');
  // Provider aborted, session tombstoned, nothing published.
  assert.equal(env.sessions.get(token).status, 'aborted');
  assert.equal(env.storage.openUploadCount(), 0);
  assert.equal(env.storage.hasObject(KEY), false);

  // A progress replay after a terminal failure is refused.
  assert.equal(env.sessions.progressVerdict(token, T0 + 2000).error, 'SESSION_TERMINAL');
  // And a re-completion is refused too — the session is closed.
  const replay = await svc.completeMultipartUpload({ ...ctx(env, token, T0 + 2000), parts: manifest, label: 'x' });
  assert.equal(replay.ok, false);
  assert.equal(replay.terminal, true);
  assert.equal(replay.error, 'SESSION_CLOSED');
});

test('a final-size mismatch deletes the object and is terminal', async () => {
  const env = setup();
  const { token, uploadId } = await openSession(env);
  const manifest = await fillParts(env, uploadId);
  // Complete succeeds at the provider; the assembled object then fails to verify.
  env.storage.fail('statMissing');

  const result = await svc.completeMultipartUpload({ ...ctx(env, token, T0 + 1000), parts: manifest, label: 'x' });
  assert.equal(result.ok, false);
  assert.equal(result.terminal, true);
  assert.equal(result.error, 'NOT_UPLOADED');
  assert.ok(env.storage.callNames().includes('deleteObject'), 'the unverifiable object is deleted');
  assert.equal(env.sessions.get(token).status, 'aborted');
});

test('a successful completion is terminal and idempotent', async () => {
  const env = setup();
  const { token, uploadId } = await openSession(env);
  const manifest = await fillParts(env, uploadId);

  const first = await svc.completeMultipartUpload({ ...ctx(env, token, T0 + 1000), parts: manifest, label: 'Movie' });
  assert.equal(first.ok, true);
  assert.equal(first.terminal, true);
  assert.equal(first.replayed, undefined);
  assert.equal(env.sessions.get(token).status, 'completed');

  const again = await svc.completeMultipartUpload({ ...ctx(env, token, T0 + 2000), parts: manifest, label: 'Movie' });
  assert.equal(again.ok, true);
  assert.equal(again.replayed, true);
  assert.equal(env.storage.callsFor('completeMultipartUpload').length, 1, 'assembled once');
});

test('an auth failure mutates no lifecycle', async () => {
  const env = setup();
  const { token, uploadId } = await openSession(env);
  const manifest = await fillParts(env, uploadId);

  // Wrong member: a caller problem, not a session outcome.
  const wrong = await svc.completeMultipartUpload({
    ...ctx(env, token, T0 + 1000),
    memberId: 'someone-else',
    parts: manifest,
    label: 'x',
  });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.error, 'WRONG_MEMBER');
  assert.equal(wrong.terminal, false);
  assert.equal(wrong.retryable, false);
  // The real owner's session is completely untouched.
  assert.equal(env.sessions.get(token).status, 'uploading');
  assert.equal(env.storage.openUploadCount(), 1);
});
