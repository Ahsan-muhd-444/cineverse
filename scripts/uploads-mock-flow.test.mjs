/**
 * The whole multipart pipeline against the mock provider.
 *
 * These call the REAL extracted services — the same functions server.js invokes —
 * so what passes here is what runs. No credentials, no network, no bucket.
 *
 * The fixture is small but LEGAL: 17 MiB in 8 MiB parts is three parts whose
 * final part is 1 MiB, which S3 permits (only non-final parts must clear the
 * 5 MiB floor). A 3 GB fixture would prove nothing extra and cost minutes.
 *
 * Run: node --test --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/uploads-mock-flow.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createMockMultipartStorage } = require('../server/storage/mock-multipart.js');
const { createUploadSessionRegistry } = require('../server/uploads-sessions.js');
const { createUploadIntent } = require('../server/uploads-intent.js');
const svc = require('../server/uploads-multipart-service.js');
const {
  createUploadRuntimeConfig,
  verifyMultipartToken,
  issueMultipartToken,
} = require('../server/uploads-multipart.js');
const { verifyUploadToken } = require('../server/uploads.js');

const MIB = 1024 * 1024;
const SECRET = 'a-stable-upload-secret-of-32-bytes!!';
const ROOM = 'ABC123';
const MEMBER = 'member-1';
const KEY = 'rooms/ABC123/0123456789abcdef/movie.mp4';

/*
 * The documented small-but-LEGAL fixture: 17 MiB in 8 MiB parts is three parts
 * whose final part is 1 MiB. S3 only requires NON-final parts to clear the 5 MiB
 * floor, so this exercises real multi-part behaviour under the real constraints
 * without a synthetic 3 GB file.
 */
const FIXTURE_BYTES = 17 * MIB;
const PART_SIZE = 8 * MIB;

/*
 * Sizes the INTENT path needs, which are a different question.
 *
 * Transport selection sends anything within the single-shot ceiling (500 MiB) to
 * the existing one-request upload — deliberately, because that behaviour is
 * preserved. So a fixture that proves "intent chooses multipart" has to be above
 * that ceiling. 520 MiB in 64 MiB parts is nine parts, still tiny for a mock that
 * stores byte counts rather than bytes.
 */
const INTENT_BYTES = 520 * MIB;
const INTENT_PART_SIZE = 64 * MIB;

/** A runtime config with multipart genuinely enabled, via real readiness rules. */
function enabledConfig(storage, over = {}) {
  const { config } = createUploadRuntimeConfig(
    {
      MAX_UPLOAD_BYTES: String(3 * 1024 * MIB),
      UPLOAD_PART_SIZE_BYTES: String(INTENT_PART_SIZE),
      UPLOAD_SECRET: SECRET,
      ...over,
    },
    { objectStorage: true, storage, contractMounted: true },
  );
  return config;
}

function setup(over = {}) {
  const storage = createMockMultipartStorage();
  const uploadConfig = enabledConfig(storage, over);
  const sessions = createUploadSessionRegistry({
    maxPerMember: uploadConfig.maxActivePerMember,
    maxPerRoom: uploadConfig.maxActivePerRoom,
  });
  return { storage, uploadConfig, sessions };
}

const intentFor = ({ storage, uploadConfig, sessions }, over = {}) =>
  createUploadIntent({
    payload: { fileName: 'movie.mp4', mimeType: 'video/mp4', size: INTENT_BYTES, ...over },
    uploadConfig,
    storage,
    secret: SECRET,
    roomCode: ROOM,
    memberId: MEMBER,
    sessions,
  });

/**
 * Open a provider session for the small legal fixture and mint its token, exactly
 * as `createUploadIntent` would — but at a size the intent path would route to
 * single-shot. This is how the flow tests get to use the 3-part fixture.
 */
async function session(env, over = {}) {
  const expectedBytes = over.expectedBytes ?? FIXTURE_BYTES;
  const partSize = over.partSize ?? PART_SIZE;
  const partCount = Math.ceil(expectedBytes / partSize);
  const { uploadId } = await env.storage.createMultipartUpload({ key: KEY, mimeType: 'video/mp4' });
  const now = over.now ?? Date.now();
  // Mirror createUploadIntent exactly: the immutable absolute deadline is fixed
  // here, and the first expiry is one TTL clamped to it.
  const absoluteExpiresAt = now + env.uploadConfig.sessionMaxLifetimeSeconds * 1000;
  const expiresAt = Math.min(now + env.uploadConfig.sessionTtlSeconds * 1000, absoluteExpiresAt);
  const token = issueMultipartToken(
    {
      key: KEY,
      uploadId,
      roomCode: ROOM,
      memberId: MEMBER,
      mimeType: 'video/mp4',
      expectedBytes,
      maxBytes: env.uploadConfig.multipartMaxBytes,
      partSize,
      partCount,
      expiresAt,
      absoluteExpiresAt,
    },
    SECRET,
    now,
  );
  env.sessions.register({
    token,
    roomCode: ROOM,
    memberId: MEMBER,
    key: KEY,
    uploadId,
    expectedBytes,
    partCount,
    expiresAt,
    label: 'movie.mp4',
    now,
  });
  return { ok: true, mode: 'multipart', token, key: KEY, uploadId, expectedBytes, partSize, partCount, lastPartSize: expectedBytes - (partCount - 1) * partSize, expiresAt, absoluteExpiresAt };
}

const ctx = (env, token) => ({
  token,
  storage: env.storage,
  secret: SECRET,
  roomCode: ROOM,
  memberId: MEMBER,
  sessions: env.sessions,
  uploadConfig: env.uploadConfig,
});

/** Upload every missing part through the mock, returning the client manifest. */
async function uploadAllParts(env, intent, { only } = {}) {
  const manifest = [];
  const numbers = only || Array.from({ length: intent.partCount }, (_, i) => i + 1);
  for (const partNumber of numbers) {
    const targets = await svc.requestPartTargets({ ...ctx(env, intent.token), partNumbers: [partNumber] });
    assert.equal(targets.ok, true, `targets for part ${partNumber}: ${targets.error}`);
    const [target] = targets.targets;
    // The mock hands back the ETag exactly as a bucket would: only in response to
    // the part actually arriving.
    const etag = env.storage.putPart({
      key: intent.key,
      uploadId: intent.uploadId,
      partNumber,
      size: target.expectedBytes,
    });
    manifest.push({ partNumber, etag });
  }
  return manifest;
}

/* ============================================== readiness */

test('multipart is enabled only when every capability is genuinely present', () => {
  const storage = createMockMultipartStorage();
  assert.equal(enabledConfig(storage).multipartEnabled, true);

  // Each of these is a real way to get it half-right.
  const cases = [
    ['no object storage', { objectStorage: false, storage, contractMounted: true }, /object storage/],
    ['contract not mounted', { objectStorage: true, storage, contractMounted: false }, /contract is not mounted/],
    ['no adapter', { objectStorage: true, storage: null, contractMounted: true }, /no storage adapter/],
    [
      'adapter routes bytes through Node',
      { objectStorage: true, storage: { ...storage, direct: false }, contractMounted: true },
      /through this process/,
    ],
    [
      'adapter does not claim multipart',
      { objectStorage: true, storage: { ...storage, multipart: false }, contractMounted: true },
      /does not advertise multipart/,
    ],
    [
      'adapter is missing an operation',
      { objectStorage: true, storage: { ...storage, listMultipartParts: undefined }, contractMounted: true },
      /missing listMultipartParts/,
    ],
  ];
  for (const [label, opts, pattern] of cases) {
    const { config } = createUploadRuntimeConfig({ UPLOAD_SECRET: SECRET, MAX_UPLOAD_BYTES: String(3 * 1024 * MIB) }, opts);
    assert.equal(config.multipartEnabled, false, label);
    assert.match(config.multipartReadiness.reason, pattern, label);
  }
});

test('a weak or per-boot secret cannot enable resumable sessions', () => {
  const storage = createMockMultipartStorage();
  for (const secret of [undefined, '', '   ', 'short', 'x'.repeat(31)]) {
    const { config } = createUploadRuntimeConfig(
      { UPLOAD_SECRET: secret, MAX_UPLOAD_BYTES: String(3 * 1024 * MIB) },
      { objectStorage: true, storage, contractMounted: true },
    );
    assert.equal(config.multipartEnabled, false, JSON.stringify(secret));
    assert.match(config.multipartReadiness.reason, /UPLOAD_SECRET/);
  }
  // 32 bytes exactly is the boundary and is accepted.
  const { config } = createUploadRuntimeConfig(
    { UPLOAD_SECRET: 'x'.repeat(32), MAX_UPLOAD_BYTES: String(3 * 1024 * MIB) },
    { objectStorage: true, storage, contractMounted: true },
  );
  assert.equal(config.multipartEnabled, true);
});

test('a contradictory adapter refuses a large file instead of downgrading it', async () => {
  const storage = createMockMultipartStorage();
  // Advertises multipart, cannot list parts: misconfigured, not unavailable.
  const broken = { ...storage, listMultipartParts: undefined };
  const uploadConfig = enabledConfig(broken);
  assert.equal(uploadConfig.multipartMisconfigured, true);

  const result = await createUploadIntent({
    payload: { fileName: 'big.mp4', mimeType: 'video/mp4', size: 900 * MIB },
    uploadConfig,
    storage: broken,
    secret: SECRET,
    roomCode: ROOM,
    memberId: MEMBER,
  });
  assert.equal(result.ok, false);
  // NOT 'single' (which cannot carry 900 MiB) and NOT MULTIPART_REQUIRED (which
  // would claim the transport merely has not shipped).
  assert.equal(result.error, 'CONFIGURATION_ERROR');
});

/* ============================================== the happy path */

test('intent chooses multipart above the single-shot ceiling and returns a bounded plan', async () => {
  const env = setup();
  const intent = await intentFor(env);

  assert.equal(intent.ok, true, intent.error);
  assert.equal(intent.mode, 'multipart');
  assert.equal(intent.partSize, INTENT_PART_SIZE);
  assert.equal(intent.partCount, Math.ceil(INTENT_BYTES / INTENT_PART_SIZE));
  assert.equal(intent.lastPartSize, INTENT_BYTES - (intent.partCount - 1) * INTENT_PART_SIZE);
  assert.equal(intent.expectedBytes, INTENT_BYTES);
  assert.equal(intent.maxBytes, env.uploadConfig.multipartMaxBytes);
  assert.equal(intent.concurrency, 3);
  assert.equal(intent.retries, 5);
  assert.equal(intent.maxPartBatch, 20);
  // No part URLs from intent: a 3 GiB plan would be 192 write capabilities.
  assert.equal('targets' in intent, false);
  assert.equal('uploadUrl' in intent, false);
  assert.match(intent.key, /^rooms\/ABC123\/[a-f0-9]{16,}\/movie\.mp4$/);

  // The token binds room, member, key and plan together.
  const claims = verifyMultipartToken(intent.token, SECRET);
  assert.equal(claims.roomCode, ROOM);
  assert.equal(claims.memberId, MEMBER);
  assert.equal(claims.key, intent.key);
  assert.equal(claims.uploadId, intent.uploadId);
  assert.equal(claims.lastPartSize, intent.lastPartSize);

  // A file WITHIN the single-shot ceiling still takes the preserved path.
  const small = await createUploadIntent({
    payload: { fileName: 'small.mp4', mimeType: 'video/mp4', size: 17 * MIB },
    uploadConfig: env.uploadConfig,
    storage: { ...env.storage, createUploadTarget: async (g) => ({ method: 'POST', url: 'https://bucket/', fields: {}, direct: true, key: g.key }) },
    secret: SECRET,
    roomCode: ROOM,
    memberId: 'member-2',
    sessions: env.sessions,
  });
  assert.equal(small.mode, 'single');
});

test('targets → parts → status → complete → verified source', async () => {
  const env = setup();
  const intent = await session(env);
  assert.equal(intent.partCount, 3);
  assert.equal(intent.lastPartSize, MIB);

  // Exact byte ranges, derived from the signed plan.
  const targets = await svc.requestPartTargets({ ...ctx(env, intent.token), partNumbers: [1, 2, 3] });
  assert.deepEqual(
    targets.targets.map((t) => t.expectedBytes),
    [PART_SIZE, PART_SIZE, MIB],
  );
  assert.ok(targets.targets.every((t) => t.method === 'PUT' && t.url.length > 0));

  const manifest = await uploadAllParts(env, intent);

  const status = await svc.readUploadStatus(ctx(env, intent.token));
  assert.equal(status.ok, true);
  assert.equal(status.uploadedBytes, FIXTURE_BYTES);
  assert.equal(status.status, 'finalizing');
  assert.equal(status.completedParts.length, 3);

  const done = await svc.completeMultipartUpload({ ...ctx(env, intent.token), parts: manifest, label: 'My Movie' });
  assert.equal(done.ok, true, done.error);
  assert.deepEqual(done.source, {
    type: 'url',
    value: `https://mock.invalid/read/${encodeURIComponent(intent.key)}`,
    label: 'My Movie',
    quality: 'Uploaded',
  });
  assert.equal(done.expectedBytes, FIXTURE_BYTES);
  // The provider's assembled object is exactly the declared size.
  assert.equal(env.storage.objectSize(intent.key), FIXTURE_BYTES);
  // And no multipart session is left open.
  assert.equal(env.storage.openUploadCount(), 0);
});

test('pause and resume keep provider-confirmed parts and re-queue only the rest', async () => {
  const env = setup();
  const intent = await session(env);

  // Two of three parts land, then the "client pauses" — nothing is aborted.
  await uploadAllParts(env, intent, { only: [1, 2] });
  const paused = await svc.readUploadStatus(ctx(env, intent.token));
  assert.equal(paused.uploadedBytes, 2 * PART_SIZE);
  assert.deepEqual(paused.completedParts.map((p) => p.partNumber), [1, 2]);
  assert.equal(env.storage.openUploadCount(), 1, 'pause must NOT abort the provider session');

  // Resume: the provider is the authority on what to re-send.
  const missing = [1, 2, 3].filter((n) => !paused.completedParts.some((p) => p.partNumber === n));
  assert.deepEqual(missing, [3]);
  const rest = await uploadAllParts(env, intent, { only: missing });

  const manifest = [...paused.completedParts.map((p) => ({ partNumber: p.partNumber, etag: p.etag })), ...rest];
  const done = await svc.completeMultipartUpload({ ...ctx(env, intent.token), parts: manifest, label: 'x' });
  assert.equal(done.ok, true, done.error);
  assert.equal(env.storage.objectSize(intent.key), FIXTURE_BYTES);
});

test('renewal moves only the expiry, and the old token stops working', async () => {
  const env = setup();
  const intent = await session(env);
  const before = verifyMultipartToken(intent.token, SECRET);

  const renewed = svc.renewUploadSession({ ...ctx(env, intent.token), now: Date.now() + 1000 });
  assert.equal(renewed.ok, true, renewed.error);
  assert.notEqual(renewed.token, intent.token);

  const after = verifyMultipartToken(renewed.token, SECRET);
  // Everything that defines the upload is identical…
  for (const field of ['key', 'uploadId', 'roomCode', 'memberId', 'mimeType', 'expectedBytes', 'maxBytes', 'partSize', 'partCount']) {
    assert.deepEqual(after[field], before[field], field);
  }
  // …only the expiry moved, and it moved forward.
  assert.ok(after.expiresAt > before.expiresAt);

  // The registry follows the new capability: the new token owns the active
  // session, and the OLD token is retained as a superseded tombstone (not
  // deleted) so a stale holder cannot act on the renamed session.
  assert.equal(env.sessions.get(intent.token).status, 'superseded');
  assert.equal(env.sessions.get(renewed.token).status, 'uploading');

  // Every operation with the OLD token is now refused with SESSION_SUPERSEDED.
  const stale = ctx(env, intent.token);
  assert.equal((await svc.requestPartTargets({ ...stale, partNumbers: [1] })).error, 'SESSION_SUPERSEDED');
  assert.equal((await svc.readUploadStatus(stale)).error, 'SESSION_SUPERSEDED');
  assert.equal(svc.renewUploadSession(stale).error, 'SESSION_SUPERSEDED');
  assert.equal((await svc.abortMultipartUpload(stale)).error, 'SESSION_SUPERSEDED');
  const staleComplete = await svc.completeMultipartUpload({ ...stale, parts: [], label: 'x' });
  assert.equal(staleComplete.error, 'SESSION_SUPERSEDED');
  assert.equal(staleComplete.terminal, true);
  // The NEW token still works — the stale abort did not tear down the provider.
  assert.equal(env.storage.openUploadCount(), 1, 'the renewed provider session survives');
});

test('renewal fails CLOSED at registry capacity — the old token stays active', async () => {
  const env = setup();
  // A registry with exactly one slot. A renewal needs room for the new token ON
  // TOP of the old one (kept as a superseded tombstone), so it cannot fit.
  env.sessions = createUploadSessionRegistry({ maxPerMember: 9, maxPerRoom: 9, maxSessions: 1 });
  const START = 1_700_000_000_000;
  const intent = await session(env, { now: START });
  assert.equal(env.sessions.size(), 1);

  const renewed = svc.renewUploadSession({ ...ctx(env, intent.token), now: START + 1000 });
  assert.equal(renewed.ok, false);
  assert.equal(renewed.error, 'SESSION_REGISTRY_FULL');
  // No half-rename: the old token is untouched, still active, still usable.
  assert.equal(env.sessions.get(intent.token).status, 'uploading');
  assert.equal(env.sessions.size(), 1, 'the registry never exceeds its bound');
  const targets = await svc.requestPartTargets({ ...ctx(env, intent.token), partNumbers: [1], now: START + 1000 });
  assert.equal(targets.ok, true, 'the old token still works after a refused renewal');
  assert.equal(env.storage.openUploadCount(), 1, 'the provider session is intact');
});

test('an absolute deadline caps a renewal loop; the session cannot outlive it', async () => {
  const env = setup();
  const START = 1_700_000_000_000;
  const intent = await session(env, { now: START });
  const ttlMs = env.uploadConfig.sessionTtlSeconds * 1000;
  const deadline = intent.absoluteExpiresAt;
  assert.equal(deadline, START + env.uploadConfig.sessionMaxLifetimeSeconds * 1000);

  let token = intent.token;
  let currentExpiry = intent.expiresAt;
  let refusal = null;
  for (let i = 0; i < 50; i += 1) {
    // Renew a minute before the CURRENT token lapses — the client's own pattern.
    const now = currentExpiry - 60_000;
    const r = svc.renewUploadSession({ ...ctx(env, token), now });
    if (!r.ok) {
      refusal = { i, error: r.error, token: r.token };
      break;
    }
    assert.ok(r.expiresAt <= deadline, `renewed expiry ${r.expiresAt} must not exceed the deadline ${deadline}`);
    assert.ok(r.expiresAt > currentExpiry, 'every accepted renewal moves the expiry strictly forward');
    currentExpiry = r.expiresAt;
    token = r.token;
  }

  // The loop was stopped by the deadline, not by exhausting its iterations.
  assert.ok(refusal, 'a renewal loop must eventually be refused');
  assert.equal(refusal.error, 'SESSION_EXPIRED', 'the deadline refuses with SESSION_EXPIRED');
  assert.equal(refusal.token, undefined, 'a refused renewal returns NO replacement token');
  // The furthest the session ever reached is EXACTLY the immutable deadline.
  assert.equal(currentExpiry, deadline);
  // The final still-valid token owns the active session at the deadline; the
  // superseded ancestors are tombstones a sweep will reclaim.
  assert.equal(env.sessions.get(token).status, 'uploading');
});

/* ============================================== completion classification */

test('completion classifies failures terminal vs retryable vs auth (item 5)', async () => {
  // TERMINAL — MISSING_PART: the client claims every part but the provider is short
  // one. The session is torn down and the provider upload aborted.
  {
    const env = setup();
    const intent = await session(env);
    const twoParts = await uploadAllParts(env, intent, { only: [1, 2] });
    const manifest = [...twoParts, { partNumber: 3, etag: '"ffffffffffffffffffffffffffffffff"' }];
    const done = await svc.completeMultipartUpload({ ...ctx(env, intent.token), parts: manifest, label: 'x' });
    assert.equal(done.error, 'MISSING_PART');
    assert.equal(done.terminal, true);
    assert.equal(done.retryable, false);
    assert.equal(env.sessions.get(intent.token).status, 'aborted');
    assert.equal(env.storage.openUploadCount(), 0, 'the provider upload is aborted');
  }

  // TERMINAL — PROVIDER_PART_SIZE_MISMATCH caught at completion.
  {
    const env = setup();
    const intent = await session(env);
    await uploadAllParts(env, intent, { only: [1, 2] });
    const badEtag = env.storage.putPart({ key: intent.key, uploadId: intent.uploadId, partNumber: 3, size: MIB - 1 });
    const manifest = [...(await uploadAllParts(env, intent, { only: [1, 2] })), { partNumber: 3, etag: badEtag }];
    const done = await svc.completeMultipartUpload({ ...ctx(env, intent.token), parts: manifest, label: 'x' });
    assert.equal(done.error, 'PROVIDER_PART_SIZE_MISMATCH');
    assert.equal(done.terminal, true);
    assert.equal(done.retryable, false);
  }

  // RETRYABLE — a transient provider assembly failure keeps the session alive.
  {
    const env = setup();
    const intent = await session(env);
    const manifest = await uploadAllParts(env, intent);
    env.storage.fail('completeFails');
    const done = await svc.completeMultipartUpload({ ...ctx(env, intent.token), parts: manifest, label: 'x' });
    assert.equal(done.error, 'COMPLETE_FAILED');
    assert.equal(done.retryable, true);
    assert.equal(done.terminal, false);
    assert.equal(env.sessions.get(intent.token).status, 'uploading', 'the session survives for a retry');
    assert.equal(env.storage.openUploadCount(), 1);
  }

  // AUTH — the caller is wrong, not the session: neither terminal nor retryable,
  // and NOTHING is mutated or aborted.
  {
    const env = setup();
    const intent = await session(env);
    const manifest = await uploadAllParts(env, intent);
    const done = await svc.completeMultipartUpload({
      ...ctx(env, intent.token),
      parts: manifest,
      label: 'x',
      memberId: 'someone-else',
    });
    assert.equal(done.error, 'WRONG_MEMBER');
    assert.equal(done.terminal, false);
    assert.equal(done.retryable, false);
    assert.equal(env.sessions.get(intent.token).status, 'uploading', 'an auth failure mutates nothing');
    assert.equal(env.storage.openUploadCount(), 1);
  }
});

/* ============================================== failure flows */

test('a missing part is refused rather than assembled', async () => {
  const env = setup();
  const intent = await session(env);
  const manifest = await uploadAllParts(env, intent, { only: [1, 2] });

  const done = await svc.completeMultipartUpload({ ...ctx(env, intent.token), parts: manifest, label: 'x' });
  assert.equal(done.ok, false);
  assert.equal(done.error, 'PART_COUNT_MISMATCH');
  assert.equal(env.storage.hasObject(intent.key), false);
});

test('a wrong client ETag is refused even when the provider has the part', async () => {
  const env = setup();
  const intent = await session(env);
  const manifest = await uploadAllParts(env, intent);
  // The client claims a different (well-formed) ETag for part 2.
  manifest[1] = { partNumber: 2, etag: '"0123456789abcdef0123456789abcdef"' };

  const done = await svc.completeMultipartUpload({ ...ctx(env, intent.token), parts: manifest, label: 'x' });
  assert.equal(done.ok, false);
  assert.equal(done.error, 'ETAG_MISMATCH');
  assert.equal(env.storage.hasObject(intent.key), false);
});

test('malformed and duplicated client manifests are refused', async () => {
  // Each case gets a FRESH session: a manifest mismatch is now a TERMINAL failure
  // that tombstones the session, so reusing one would make every later case fail
  // with SESSION_CLOSED instead of its own error.
  const cases = [
    ['not an array', (m) => 'nope', 'BAD_PARTS'],
    ['empty', () => [], 'PART_COUNT_MISMATCH'],
    ['duplicate part', (m) => [m[0], m[0], m[2]], 'DUPLICATE_PART'],
    ['out of plan', (m) => [m[0], m[1], { partNumber: 9, etag: '"x"' }], 'BAD_PARTS'],
    ['empty etag', (m) => [m[0], m[1], { partNumber: 3, etag: '' }], 'BAD_ETAG'],
    ['non-string etag', (m) => [m[0], m[1], { partNumber: 3, etag: 42 }], 'BAD_ETAG'],
  ];
  for (const [label, build, expected] of cases) {
    const env = setup();
    const intent = await session(env);
    const manifest = await uploadAllParts(env, intent);
    const done = await svc.completeMultipartUpload({ ...ctx(env, intent.token), parts: build(manifest), label: 'x' });
    assert.equal(done.ok, false, label);
    assert.equal(done.error, expected, `${label}: got ${done.error}`);
    // A manifest mismatch tears the session down: terminal, provider aborted.
    assert.equal(done.terminal, true, `${label} must be classified terminal`);
    assert.equal(env.sessions.get(intent.token).status, 'aborted', label);
    assert.equal(env.storage.openUploadCount(), 0, `${label}: provider session aborted`);
  }
});

test('a wrong provider part size fails closed', async () => {
  const env = setup();
  const intent = await session(env);
  await uploadAllParts(env, intent, { only: [1, 2] });
  // The provider stored a SHORT final part — the one failure a total-size HEAD
  // could never catch on its own.
  const etag = env.storage.putPart({ key: intent.key, uploadId: intent.uploadId, partNumber: 3, size: MIB - 1 });

  const status = await svc.readUploadStatus(ctx(env, intent.token));
  assert.equal(status.ok, false);
  assert.equal(status.error, 'PROVIDER_PART_SIZE_MISMATCH');

  const done = await svc.completeMultipartUpload({
    ...ctx(env, intent.token),
    parts: [...(await uploadAllParts(env, intent, { only: [1, 2] })), { partNumber: 3, etag }],
    label: 'x',
  });
  assert.equal(done.ok, false);
  assert.equal(done.error, 'PROVIDER_PART_SIZE_MISMATCH');
});

test('a provider that duplicates or invents parts fails closed', async () => {
  for (const [fault, expected] of [
    ['listDuplicatePart', 'PROVIDER_DUPLICATE_PART'],
    ['listExtraPart', 'PROVIDER_PART_OUT_OF_PLAN'],
    ['listBadEtag', 'PROVIDER_BAD_ETAG'],
  ]) {
    const env = setup();
    const intent = await session(env);
    await uploadAllParts(env, intent);
    env.storage.fail(fault);

    const status = await svc.readUploadStatus(ctx(env, intent.token));
    assert.equal(status.ok, false, fault);
    assert.equal(status.error, expected, `${fault}: got ${status.error}`);
  }
});

test('a truncated listing with no continuation marker is an error, not a short list', async () => {
  const env = setup();
  const intent = await session(env);
  await uploadAllParts(env, intent);
  env.storage.fail('listTruncatedNoMarker');

  const status = await svc.readUploadStatus(ctx(env, intent.token));
  assert.equal(status.ok, false);
  assert.equal(status.error, 'STORAGE_UNAVAILABLE');
});

test('a provider completion error leaves no source and no object', async () => {
  const env = setup();
  const intent = await session(env);
  const manifest = await uploadAllParts(env, intent);
  env.storage.fail('completeFails');

  const done = await svc.completeMultipartUpload({ ...ctx(env, intent.token), parts: manifest, label: 'x' });
  assert.equal(done.ok, false);
  assert.equal(done.error, 'COMPLETE_FAILED');
  assert.equal(env.storage.hasObject(intent.key), false);
  // The session goes back to uploading so the client may retry completion.
  assert.equal(env.sessions.get(intent.token).status, 'uploading');
});

test('a final HEAD mismatch deletes the object rather than publishing it', async () => {
  const env = setup();
  const intent = await session(env);
  const manifest = await uploadAllParts(env, intent);

  // Complete succeeds at the provider, then the object cannot be verified.
  env.storage.fail('statMissing');
  const done = await svc.completeMultipartUpload({ ...ctx(env, intent.token), parts: manifest, label: 'x' });
  assert.equal(done.ok, false);
  assert.equal(done.error, 'NOT_UPLOADED');
  assert.ok(env.storage.callNames().includes('deleteObject'), 'an unverifiable object must be deleted');
});

/* ============================================== idempotency */

test('completion is safe to retry after a lost ack', async () => {
  const env = setup();
  const intent = await session(env);
  const manifest = await uploadAllParts(env, intent);

  const first = await svc.completeMultipartUpload({ ...ctx(env, intent.token), parts: manifest, label: 'Movie' });
  assert.equal(first.ok, true);
  assert.equal(first.replayed, undefined);

  // The client never saw the ack and asks again. The multipart upload is gone at
  // the provider, so the OBJECT decides the answer.
  const second = await svc.completeMultipartUpload({ ...ctx(env, intent.token), parts: manifest, label: 'Movie' });
  assert.equal(second.ok, true, second.error);
  assert.equal(second.replayed, true);
  assert.deepEqual(second.source, first.source);
  // Exactly one object, exactly one assembly.
  assert.equal(env.storage.callsFor('completeMultipartUpload').length, 1);
});

test('completion after a lost registry still verifies the object', async () => {
  // A server restart loses the registry; the token plus provider state must be
  // enough. Here the session is simply not registered.
  const env = setup();
  const intent = await session(env);
  const manifest = await uploadAllParts(env, intent);
  await svc.completeMultipartUpload({ ...ctx(env, intent.token), parts: manifest, label: 'Movie' });

  const bare = { ...ctx(env, intent.token), sessions: null, parts: manifest, label: 'Movie' };
  const replay = await svc.completeMultipartUpload(bare);
  assert.equal(replay.ok, true, replay.error);
  assert.equal(replay.replayed, true);
});

test('abort is idempotent and never deletes a completed source', async () => {
  const env = setup();
  const intent = await session(env);

  const first = await svc.abortMultipartUpload(ctx(env, intent.token));
  assert.deepEqual(first, { ok: true });
  assert.equal(env.storage.openUploadCount(), 0);

  // Nothing left to abort: still success, flagged.
  const second = await svc.abortMultipartUpload(ctx(env, intent.token));
  assert.deepEqual(second, { ok: true, alreadyGone: true });

  // A completed session is refused outright — its object is a published source.
  const env2 = setup();
  const intent2 = await session(env2);
  const manifest = await uploadAllParts(env2, intent2);
  await svc.completeMultipartUpload({ ...ctx(env2, intent2.token), parts: manifest, label: 'x' });
  const refused = await svc.abortMultipartUpload(ctx(env2, intent2.token));
  assert.equal(refused.ok, false);
  assert.equal(refused.error, 'ALREADY_COMPLETED');
  assert.equal(env2.storage.hasObject(intent2.key), true);
});

/* ============================================== authorization */

test('every operation refuses the wrong room, the wrong member and a bad token', async () => {
  const env = setup();
  const intent = await session(env);
  const manifest = await uploadAllParts(env, intent);

  const operations = [
    ['part-targets', (over) => svc.requestPartTargets({ ...ctx(env, intent.token), partNumbers: [1], ...over })],
    ['status', (over) => svc.readUploadStatus({ ...ctx(env, intent.token), ...over })],
    ['renew', (over) => svc.renewUploadSession({ ...ctx(env, intent.token), ...over })],
    ['complete', (over) => svc.completeMultipartUpload({ ...ctx(env, intent.token), parts: manifest, label: 'x', ...over })],
    ['abort', (over) => svc.abortMultipartUpload({ ...ctx(env, intent.token), ...over })],
  ];

  for (const [label, run] of operations) {
    assert.equal((await run({ roomCode: 'ZZZ999' })).error, 'WRONG_ROOM', `${label} wrong room`);
    assert.equal((await run({ memberId: 'someone-else' })).error, 'WRONG_MEMBER', `${label} wrong member`);
    assert.equal((await run({ token: 'not-a-token' })).error, 'BAD_TOKEN', `${label} bad token`);
    assert.equal((await run({ secret: 'a-different-secret-of-32-bytes!!!!' })).error, 'BAD_TOKEN', `${label} wrong secret`);
    // An expired session cannot be used, or renewed back to life.
    const expired = { now: Date.now() + 7 * 60 * 60 * 1000 };
    assert.equal((await run(expired)).error, 'BAD_TOKEN', `${label} expired`);
  }
});

test('part-target batches are bounded and plan-checked', async () => {
  const env = setup();
  const intent = await session(env);
  const base = ctx(env, intent.token);

  assert.equal((await svc.requestPartTargets({ ...base, partNumbers: [] })).error, 'BAD_PARTS');
  assert.equal((await svc.requestPartTargets({ ...base, partNumbers: 'all' })).error, 'BAD_PARTS');
  assert.equal((await svc.requestPartTargets({ ...base, partNumbers: [1, 1] })).error, 'DUPLICATE_PART');
  assert.equal((await svc.requestPartTargets({ ...base, partNumbers: [0] })).error, 'BAD_PARTS');
  assert.equal((await svc.requestPartTargets({ ...base, partNumbers: [4] })).error, 'BAD_PARTS', 'beyond the plan');
  assert.equal((await svc.requestPartTargets({ ...base, partNumbers: [1.5] })).error, 'BAD_PARTS');
  // 21 numbers, above MAX_PART_TARGET_BATCH — a client must not make the server
  // sign an unbounded number of write capabilities.
  const many = Array.from({ length: 21 }, (_, i) => i + 1);
  assert.equal((await svc.requestPartTargets({ ...base, partNumbers: many })).error, 'TOO_MANY_PARTS');
});

/* ============================================== active limits */

test('a second upload is refused instead of orphaning the first', async () => {
  const env = setup();
  const first = await intentFor(env);
  assert.equal(first.ok, true);
  assert.equal(env.storage.openUploadCount(), 1);

  const second = await intentFor(env, { fileName: 'other.mp4' });
  assert.equal(second.ok, false);
  assert.equal(second.error, 'UPLOAD_ALREADY_ACTIVE');
  // Crucially: no SECOND provider session was opened, so nothing is orphaned.
  assert.equal(env.storage.openUploadCount(), 1);
  assert.equal(env.storage.callsFor('createMultipartUpload').length, 1);

  // Cancelling the first frees the slot.
  await svc.abortMultipartUpload(ctx(env, first.token));
  const third = await intentFor(env, { fileName: 'third.mp4' });
  assert.equal(third.ok, true, third.error);
});

test('a room limit refuses a third concurrent upload across members', async () => {
  const env = setup();
  const a = await createUploadIntent({
    payload: { fileName: 'a.mp4', mimeType: 'video/mp4', size: INTENT_BYTES },
    uploadConfig: env.uploadConfig,
    storage: env.storage,
    secret: SECRET,
    roomCode: ROOM,
    memberId: 'member-a',
    sessions: env.sessions,
  });
  const b = await createUploadIntent({
    payload: { fileName: 'b.mp4', mimeType: 'video/mp4', size: INTENT_BYTES },
    uploadConfig: env.uploadConfig,
    storage: env.storage,
    secret: SECRET,
    roomCode: ROOM,
    memberId: 'member-b',
    sessions: env.sessions,
  });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);

  const c = await createUploadIntent({
    payload: { fileName: 'c.mp4', mimeType: 'video/mp4', size: INTENT_BYTES },
    uploadConfig: env.uploadConfig,
    storage: env.storage,
    secret: SECRET,
    roomCode: ROOM,
    memberId: 'member-c',
    sessions: env.sessions,
  });
  assert.equal(c.ok, false);
  assert.equal(c.error, 'ROOM_UPLOAD_LIMIT');
  assert.equal(env.storage.openUploadCount(), 2);
});

test('a failure after provider initiation aborts the orphan', async () => {
  const env = setup();
  // A member id the token issuer will refuse (not a string) forces a failure
  // strictly AFTER createMultipartUpload has committed.
  const storage = env.storage;
  let aborted = 0;
  const wrapped = {
    ...storage,
    abortMultipartUpload: async (input) => {
      aborted += 1;
      return storage.abortMultipartUpload(input);
    },
  };

  const result = await createUploadIntent({
    payload: { fileName: 'movie.mp4', mimeType: 'video/mp4', size: INTENT_BYTES },
    uploadConfig: env.uploadConfig,
    storage: wrapped,
    secret: SECRET,
    roomCode: ROOM,
    // A member id above the bound: intent accepts it as a string, the token
    // issuer refuses it, and the provider session must not be left behind.
    memberId: 'm'.repeat(200),
    sessions: env.sessions,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'CONFIGURATION_ERROR');
  assert.equal(aborted, 1, 'the orphaned provider session must be aborted');
  assert.equal(storage.openUploadCount(), 0);
});

test('a full registry refuses a multipart intent AND aborts its provider upload', async () => {
  // A registry with room for exactly one session, already full of an unrelated
  // active upload (in another room, so limits are not what refuses this).
  const storage = createMockMultipartStorage();
  const uploadConfig = enabledConfig(storage);
  const sessions = createUploadSessionRegistry({ maxPerMember: 9, maxPerRoom: 9, maxSessions: 1 });
  sessions.register({
    token: 'occupant',
    roomCode: 'ZZZ999',
    memberId: 'occupant',
    key: 'rooms/ZZZ999/0123456789abcdef/o.mp4',
    uploadId: 'occupant-upload',
    expectedBytes: INTENT_BYTES,
    partCount: 9,
    expiresAt: Date.now() + 6 * 3600_000,
  });

  const result = await createUploadIntent({
    payload: { fileName: 'movie.mp4', mimeType: 'video/mp4', size: INTENT_BYTES },
    uploadConfig,
    storage,
    secret: SECRET,
    roomCode: ROOM,
    memberId: MEMBER,
    sessions,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'SESSION_REGISTRY_FULL');
  // The provider upload created before registration was aborted — no orphan.
  assert.equal(storage.openUploadCount(), 0, 'the just-created provider upload must be aborted');
  // The existing occupant is untouched.
  assert.equal(sessions.get('occupant').status, 'uploading');
  assert.equal(sessions.size(), 1);
});

test('a full registry refuses a SINGLE-SHOT intent and creates no target (item 6)', async () => {
  // Single-shot registration is now fail-closed too: a valid token with no
  // lifecycle record would let its completed/aborted progress replay as "absent".
  const storage = createMockMultipartStorage();
  const uploadConfig = enabledConfig(storage);
  const sessions = createUploadSessionRegistry({ maxPerMember: 9, maxPerRoom: 9, maxSessions: 1 });
  sessions.register({
    token: 'occupant',
    roomCode: 'ZZZ999',
    memberId: 'occupant',
    key: 'rooms/ZZZ999/0123456789abcdef/o.mp4',
    uploadId: 'occupant-upload',
    expectedBytes: INTENT_BYTES,
    partCount: 9,
    expiresAt: Date.now() + 6 * 3600_000,
  });

  // A target factory that MUST NOT run on a refused intent — registration comes
  // first, so a full registry means no target and no provider operation.
  let targetCalls = 0;
  const withTarget = {
    ...storage,
    createUploadTarget: async (g) => {
      targetCalls += 1;
      return { method: 'POST', url: 'https://bucket/', fields: {}, direct: true, key: g.key };
    },
  };

  const result = await createUploadIntent({
    payload: { fileName: 'small.mp4', mimeType: 'video/mp4', size: 17 * MIB }, // single-shot size
    uploadConfig,
    storage: withTarget,
    secret: SECRET,
    roomCode: ROOM,
    memberId: MEMBER,
    sessions,
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, 'SESSION_REGISTRY_FULL');
  assert.equal('uploadUrl' in result, false, 'no upload target reaches the client');
  assert.equal('token' in result, false, 'no token is handed out');
  assert.equal(targetCalls, 0, 'no provider target is created when the registry is full');
  // Existing records are unchanged.
  assert.equal(sessions.get('occupant').status, 'uploading');
  assert.equal(sessions.size(), 1);
});

/* ============================================== single-shot lifecycle (items 1 & 2) */

// A storage adapter that can sign a single-shot target (the multipart mock cannot).
const singleStorage = (env, over = {}) => ({
  ...env.storage,
  createUploadTarget: async (g) => ({ method: 'POST', url: 'https://bucket/', fields: {}, direct: true, key: g.key }),
  ...over,
});

const singleIntentReal = (env, member = MEMBER, storage = singleStorage(env)) =>
  createUploadIntent({
    payload: { fileName: 'small.mp4', mimeType: 'video/mp4', size: 17 * MIB }, // single-shot size
    uploadConfig: env.uploadConfig,
    storage,
    secret: SECRET,
    roomCode: ROOM,
    memberId: member,
    sessions: env.sessions,
  });

test('a single-shot target-signing failure ROLLS BACK the lifecycle record (item 1)', async () => {
  const env = setup();
  const throwing = singleStorage(env, {
    createUploadTarget: async () => {
      throw new Error('signing down');
    },
  });

  const first = await singleIntentReal(env, MEMBER, throwing);
  assert.equal(first.ok, false);
  assert.equal(first.error, 'STORAGE_UNAVAILABLE');
  assert.equal(env.sessions.size(), 0, 'the just-registered record is rolled back, not tombstoned');

  // 50 failures never accumulate and never trip SESSION_REGISTRY_FULL.
  for (let i = 0; i < 50; i += 1) {
    const r = await singleIntentReal(env, `m-${i}`, throwing);
    assert.equal(r.error, 'STORAGE_UNAVAILABLE', `attempt ${i}`);
  }
  assert.equal(env.sessions.size(), 0, 'the registry stays empty after 50 rollbacks');

  // An unrelated record is untouched by the rollbacks.
  env.sessions.register({
    token: 'keep',
    transport: 'single',
    roomCode: ROOM,
    memberId: 'keeper',
    key: KEY,
    expectedBytes: 17 * MIB,
    expiresAt: Date.now() + 3600_000,
  });
  await singleIntentReal(env, 'another', throwing);
  assert.ok(env.sessions.get('keep'), 'the unrelated record survives');
  assert.equal(env.sessions.size(), 1);
});

test('single-shot cancellation aborts the lifecycle and refuses replay (item 2)', async () => {
  const env = setup();
  const intent = await singleIntentReal(env);
  assert.equal(intent.mode, 'single');
  // The single-shot record exists and is active.
  assert.equal(env.sessions.get(intent.token).status, 'uploading');

  const progress = () =>
    svc.buildRoomProgress({
      mode: 'single',
      token: intent.token,
      secret: SECRET,
      roomCode: ROOM,
      memberId: MEMBER,
      memberName: 'A',
      verifySingle: verifyUploadToken,
      sessions: env.sessions,
      label: 'x',
      uploadedBytes: 4 * MIB,
      totalBytes: 17 * MIB,
      status: 'uploading',
    });
  // Partner progress is emitted while active.
  assert.equal(progress().ok, true);

  // Cancel closes the lifecycle — no provider op — and tombstones the record.
  const aborted = svc.abortSingleUpload({
    token: intent.token,
    verifySingle: verifyUploadToken,
    secret: SECRET,
    roomCode: ROOM,
    memberId: MEMBER,
    sessions: env.sessions,
  });
  assert.deepEqual(aborted, { ok: true });
  assert.equal(env.sessions.get(intent.token).status, 'aborted');
  // A progress replay after cancel is refused — the cleared bar cannot return.
  assert.equal(progress().error, 'SESSION_TERMINAL');
  // Idempotent: a repeated cancel is success, not an error.
  assert.deepEqual(
    svc.abortSingleUpload({
      token: intent.token,
      verifySingle: verifyUploadToken,
      secret: SECRET,
      roomCode: ROOM,
      memberId: MEMBER,
      sessions: env.sessions,
    }),
    { ok: true, alreadyGone: true },
  );
});

test('single-shot cancel rejects a wrong member, room or token WITHOUT mutating the lifecycle (item 2)', async () => {
  const env = setup();
  const intent = await singleIntentReal(env);

  const wrongMember = svc.abortSingleUpload({
    token: intent.token,
    verifySingle: verifyUploadToken,
    secret: SECRET,
    roomCode: ROOM,
    memberId: 'someone-else',
    sessions: env.sessions,
  });
  assert.equal(wrongMember.error, 'WRONG_MEMBER');
  assert.equal(env.sessions.get(intent.token).status, 'uploading', 'a wrong-member cancel mutates nothing');

  const wrongRoom = svc.abortSingleUpload({
    token: intent.token,
    verifySingle: verifyUploadToken,
    secret: SECRET,
    roomCode: 'ZZZ999',
    memberId: MEMBER,
    sessions: env.sessions,
  });
  assert.equal(wrongRoom.error, 'WRONG_ROOM');
  assert.equal(env.sessions.get(intent.token).status, 'uploading');

  // A bad token is refused before any lookup.
  assert.equal(
    svc.abortSingleUpload({ token: 'not-a-token', verifySingle: verifyUploadToken, secret: SECRET, roomCode: ROOM, memberId: MEMBER, sessions: env.sessions }).error,
    'BAD_TOKEN',
  );
});

/* ============================================== atomic multipart cancel (item 3) */

test('multipart cancel is ATOMIC: the member slot is freed BEFORE provider I/O (item 3)', async () => {
  const env = setup();
  const intent = await session(env);
  assert.equal(env.storage.openUploadCount(), 1);

  let statusSeenByProvider = null;
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const slowStorage = {
    ...env.storage,
    abortMultipartUpload: async (input) => {
      // What the lifecycle looks like at the moment the provider abort begins.
      statusSeenByProvider = env.sessions.get(intent.token).status;
      await gate;
      return env.storage.abortMultipartUpload(input);
    },
  };

  const pending = svc.abortMultipartUpload({ ...ctx(env, intent.token), storage: slowStorage });
  // The provider abort is parked, but the session is ALREADY terminal and the
  // member/room slot is free — a concurrent intent would be admitted, not raced.
  await Promise.resolve();
  assert.equal(env.sessions.get(intent.token).status, 'aborted', 'tombstoned before provider I/O');
  assert.equal(env.sessions.canStart(ROOM, MEMBER).ok, true, 'the slot is free during the provider wait');

  release();
  const result = await pending;
  assert.equal(result.ok, true);
  assert.equal(statusSeenByProvider, 'aborted', 'the provider abort ran AFTER the tombstone');
});

test('a provider abort failure does not reactivate the cancelled session (item 3)', async () => {
  const env = setup();
  const intent = await session(env);
  const failing = {
    ...env.storage,
    abortMultipartUpload: async () => {
      throw new Error('provider down');
    },
  };

  const result = await svc.abortMultipartUpload({ ...ctx(env, intent.token), storage: failing });
  assert.equal(result.ok, true);
  assert.equal(result.cleanupPending, true, 'a transient provider failure is reported, not fatal');
  // The capability stays revoked — a provider failure must never walk it back.
  assert.equal(env.sessions.get(intent.token).status, 'aborted');
  assert.equal(env.sessions.canStart(ROOM, MEMBER).ok, true);
});

/* ============================================== room progress */

test('room progress is server-computed, size-pinned and secret-free', async () => {
  const env = setup();
  const intent = await session(env);
  const base = {
    mode: 'multipart',
    token: intent.token,
    secret: SECRET,
    roomCode: ROOM,
    memberId: MEMBER,
    memberName: 'Alice',
    verifySingle: verifyUploadToken,
  };

  const good = svc.buildRoomProgress({
    ...base,
    label: '  My Movie.mp4  ',
    uploadedBytes: 8 * MIB,
    totalBytes: FIXTURE_BYTES,
    status: 'uploading',
  });
  assert.equal(good.ok, true);
  assert.equal(good.progress.memberId, MEMBER);
  assert.equal(good.progress.memberName, 'Alice');
  assert.equal(good.progress.label, 'My Movie.mp4', 'the label is sanitised');
  assert.equal(good.progress.percentage, 47, 'the percentage is computed here');
  assert.equal(good.immediate, false, 'ordinary progress may be throttled');

  // NOTHING sensitive is in the payload.
  const serialized = JSON.stringify(good.progress);
  for (const secretish of [intent.token, intent.key, intent.uploadId, SECRET]) {
    assert.equal(serialized.includes(secretish), false, `payload leaked ${secretish.slice(0, 12)}…`);
  }
  assert.deepEqual(Object.keys(good.progress).sort(), [
    'label',
    'memberId',
    'memberName',
    'percentage',
    'status',
    'totalBytes',
    'uploadedBytes',
  ]);

  // A client may not redefine the size of its own upload.
  for (const totalBytes of [FIXTURE_BYTES - 1, FIXTURE_BYTES + 1, 0, -1, 1.5, '17825792', undefined]) {
    const bad = svc.buildRoomProgress({ ...base, label: 'x', uploadedBytes: 1, totalBytes, status: 'uploading' });
    assert.equal(bad.ok, false, String(totalBytes));
    assert.equal(bad.error, 'SIZE_MISMATCH', String(totalBytes));
  }

  // Uploaded bytes are clamped, never trusted to exceed the total.
  const over = svc.buildRoomProgress({
    ...base,
    label: 'x',
    uploadedBytes: FIXTURE_BYTES * 10,
    totalBytes: FIXTURE_BYTES,
    status: 'uploading',
  });
  assert.equal(over.progress.uploadedBytes, FIXTURE_BYTES);
  assert.equal(over.progress.percentage, 100);

  for (const uploadedBytes of [-1, 1.5, NaN, '100', null]) {
    const bad = svc.buildRoomProgress({ ...base, label: 'x', uploadedBytes, totalBytes: FIXTURE_BYTES, status: 'uploading' });
    assert.equal(bad.error, 'BAD_PROGRESS', String(uploadedBytes));
  }

  // Only the documented statuses, and transitions bypass the throttle.
  for (const status of ['paused', 'retrying', 'reconnecting', 'finalizing']) {
    const built = svc.buildRoomProgress({ ...base, label: 'x', uploadedBytes: 1, totalBytes: FIXTURE_BYTES, status });
    assert.equal(built.ok, true, status);
    assert.equal(built.immediate, true, `${status} must send immediately`);
  }
  for (const status of ['completed', 'done', '', null, 'UPLOADING']) {
    const built = svc.buildRoomProgress({ ...base, label: 'x', uploadedBytes: 1, totalBytes: FIXTURE_BYTES, status });
    assert.equal(built.error, 'BAD_STATUS', String(status));
  }

  // The mode must be declared, and a multipart token cannot masquerade as single.
  assert.equal(
    svc.buildRoomProgress({ ...base, mode: 'single', label: 'x', uploadedBytes: 1, totalBytes: FIXTURE_BYTES, status: 'uploading' }).error,
    'BAD_TOKEN',
  );
  assert.equal(
    svc.buildRoomProgress({ ...base, mode: undefined, label: 'x', uploadedBytes: 1, totalBytes: FIXTURE_BYTES, status: 'uploading' }).error,
    'BAD_MODE',
  );
});

/* ============================================== progress replay is refused */

test('progress is refused after the session is completed, aborted or expired', async () => {
  const report = (env, token) =>
    svc.buildRoomProgress({
      mode: 'multipart',
      token,
      secret: SECRET,
      roomCode: ROOM,
      memberId: MEMBER,
      memberName: 'Alice',
      verifySingle: verifyUploadToken,
      sessions: env.sessions,
      label: 'x',
      uploadedBytes: 8 * MIB,
      totalBytes: FIXTURE_BYTES,
      status: 'uploading',
    });

  // While active, progress is accepted…
  const live = setup();
  const activeIntent = await session(live);
  assert.equal(report(live, activeIntent.token).ok, true);

  // …a COMPLETED session refuses it: the bar the room cleared cannot come back.
  const completedEnv = setup();
  const completedIntent = await session(completedEnv);
  const manifest = await uploadAllParts(completedEnv, completedIntent);
  await svc.completeMultipartUpload({ ...ctx(completedEnv, completedIntent.token), parts: manifest, label: 'x' });
  assert.equal(report(completedEnv, completedIntent.token).error, 'SESSION_TERMINAL');

  // …an ABORTED session refuses it…
  const abortedEnv = setup();
  const abortedIntent = await session(abortedEnv);
  await svc.abortMultipartUpload(ctx(abortedEnv, abortedIntent.token));
  assert.equal(report(abortedEnv, abortedIntent.token).error, 'SESSION_TERMINAL');

  // …and an EXPIRED session refuses it, distinctly.
  const expiredEnv = setup();
  const expiredIntent = await session(expiredEnv);
  expiredEnv.sessions.markTerminal(expiredIntent.token, 'expired', Date.now());
  assert.equal(report(expiredEnv, expiredIntent.token).error, 'SESSION_EXPIRED');
});

test('a duplicate terminal completion does not re-run the provider or re-broadcast', async () => {
  const env = setup();
  const intent = await session(env);
  const manifest = await uploadAllParts(env, intent);

  const c1 = await svc.completeMultipartUpload({ ...ctx(env, intent.token), parts: manifest, label: 'Movie' });
  const c2 = await svc.completeMultipartUpload({ ...ctx(env, intent.token), parts: manifest, label: 'Movie' });
  const c3 = await svc.completeMultipartUpload({ ...ctx(env, intent.token), parts: manifest, label: 'Movie' });

  assert.equal(c1.ok, true);
  assert.equal(c1.terminal, true);
  assert.equal(c1.replayed, undefined);
  assert.equal(c2.replayed, true);
  assert.equal(c3.replayed, true);
  // Exactly one assembly, whatever the retry count.
  assert.equal(env.storage.callsFor('completeMultipartUpload').length, 1);
  // The session is a single completed tombstone.
  assert.equal(env.sessions.get(intent.token).status, 'completed');
});
