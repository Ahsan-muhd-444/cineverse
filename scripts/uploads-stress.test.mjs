/**
 * Repeated-cycle stress over the upload pipeline.
 *
 * Lifecycle bugs do not show up once — they show up as a counter that creeps.
 * Every test here runs the same operation many times and then asserts that the
 * things which must return to zero have: registry entries, open provider
 * sessions, active XHRs, pending retry timers, room-progress entries and
 * unhandled rejections.
 *
 * All in-process (mock provider, fake XHR, fake timers), so it belongs in the
 * unit suite and runs on every `npm test` rather than only in a nightly.
 *
 * Run: node --test --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/uploads-stress.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createUploadController } from '../src/lib/multipartUpload.ts';

const require = createRequire(import.meta.url);
const { createMockMultipartStorage } = require('../server/storage/mock-multipart.js');
const { createUploadSessionRegistry } = require('../server/uploads-sessions.js');
const { createUploadIntent } = require('../server/uploads-intent.js');
const svc = require('../server/uploads-multipart-service.js');
const { createUploadRuntimeConfig, issueMultipartToken } = require('../server/uploads-multipart.js');

const MIB = 1024 * 1024;
const SECRET = 'a-stable-upload-secret-of-32-bytes!!';
const ROOM = 'ABC123';
const MEMBER = 'member-1';
const KEY = 'rooms/ABC123/0123456789abcdef/movie.mp4';
const FIXTURE_BYTES = 17 * MIB;
const PART_SIZE = 8 * MIB;
const PART_COUNT = 3;
const CYCLES = 50;
/** Far enough past any session's 6-hour expiry that a sweep reclaims tombstones. */
const FAR_FUTURE = Date.now() + 48 * 3600_000;

const unhandled = [];
test.before(() => process.on('unhandledRejection', (reason) => unhandled.push(reason)));

function serverEnv() {
  const storage = createMockMultipartStorage();
  const { config } = createUploadRuntimeConfig(
    {
      MAX_UPLOAD_BYTES: String(3 * 1024 * MIB),
      UPLOAD_PART_SIZE_BYTES: String(64 * MIB),
      UPLOAD_SECRET: SECRET,
    },
    { objectStorage: true, storage, contractMounted: true },
  );
  const sessions = createUploadSessionRegistry({
    maxPerMember: config.maxActivePerMember,
    maxPerRoom: config.maxActivePerRoom,
  });
  return { storage, uploadConfig: config, sessions };
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

/** Open a provider session at the small legal fixture size. */
async function session(env, memberId = MEMBER) {
  const { uploadId } = await env.storage.createMultipartUpload({ key: KEY, mimeType: 'video/mp4' });
  const expiresAt = Date.now() + env.uploadConfig.sessionTtlSeconds * 1000;
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
  );
  env.sessions.register({
    token,
    roomCode: ROOM,
    memberId,
    key: KEY,
    uploadId,
    expectedBytes: FIXTURE_BYTES,
    partCount: PART_COUNT,
    expiresAt,
  });
  return { token, uploadId, key: KEY };
}

async function fillParts(env, s) {
  const manifest = [];
  for (let partNumber = 1; partNumber <= PART_COUNT; partNumber += 1) {
    const size = partNumber === PART_COUNT ? FIXTURE_BYTES - (PART_COUNT - 1) * PART_SIZE : PART_SIZE;
    const etag = env.storage.putPart({ key: s.key, uploadId: s.uploadId, partNumber, size });
    manifest.push({ partNumber, etag });
  }
  return manifest;
}

/* ============================================== server-side cycles */

test(`${CYCLES} cancellation cycles leave no provider session and no registry entry`, async () => {
  const env = serverEnv();
  for (let i = 0; i < CYCLES; i += 1) {
    const s = await session(env);
    // Some cycles cancel mid-upload, some after every part has landed.
    if (i % 3 === 0) await fillParts(env, s);
    const aborted = await svc.abortMultipartUpload(ctx(env, s.token));
    assert.equal(aborted.ok, true, `cycle ${i}: ${aborted.error}`);
  }
  // No orphaned PROVIDER sessions — the abuse-relevant resource.
  assert.equal(env.storage.openUploadCount(), 0, 'no orphaned provider multipart sessions');
  assert.equal(env.storage.hasObject(KEY), false, 'a cancelled upload publishes nothing');
  // Every registry entry is a terminal TOMBSTONE, not an active session: they
  // block a progress replay until their token expires, and none counts against
  // the limits.
  assert.equal(env.sessions.countForRoom(ROOM), 0, 'no active sessions remain');
  // A sweep well past expiry reclaims every tombstone, leaving nothing behind.
  const { removed } = env.sessions.sweep(FAR_FUTURE);
  assert.ok(removed >= CYCLES, `expected >= ${CYCLES} tombstones reclaimed, got ${removed}`);
  assert.equal(env.sessions.size(), 0, 'no leaked registry entries after expiry');
});

test(`${CYCLES} invalid-token cycles change no state at all`, async () => {
  const env = serverEnv();
  const live = await session(env);
  const before = { open: env.storage.openUploadCount(), sessions: env.sessions.size() };

  for (let i = 0; i < CYCLES; i += 1) {
    const bogus = `forged-${i}.signature-${i}`;
    // eslint-disable-next-line no-await-in-loop
    const results = await Promise.all([
      svc.requestPartTargets({ ...ctx(env, bogus), partNumbers: [1] }),
      svc.readUploadStatus(ctx(env, bogus)),
      svc.completeMultipartUpload({ ...ctx(env, bogus), parts: [{ partNumber: 1, etag: '"a"' }], label: 'x' }),
      svc.abortMultipartUpload(ctx(env, bogus)),
    ]);
    for (const result of results) {
      assert.equal(result.ok, false, `cycle ${i}`);
      assert.equal(result.error, 'BAD_TOKEN', `cycle ${i}: ${result.error}`);
    }
    assert.equal(svc.renewUploadSession(ctx(env, bogus)).error, 'BAD_TOKEN');
  }

  // The live session is untouched, and nothing new was created.
  assert.equal(env.storage.openUploadCount(), before.open);
  assert.equal(env.sessions.size(), before.sessions);
  assert.ok(env.sessions.get(live.token));
});

test('repeated completion attempts assemble the object exactly once', async () => {
  const env = serverEnv();
  const s = await session(env);
  const manifest = await fillParts(env, s);

  const results = [];
  for (let i = 0; i < 10; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    results.push(await svc.completeMultipartUpload({ ...ctx(env, s.token), parts: manifest, label: 'Movie' }));
  }
  assert.ok(results.every((r) => r.ok === true), JSON.stringify(results.find((r) => !r.ok)));
  // One assembly; every later attempt took the idempotent path.
  assert.equal(env.storage.callsFor('completeMultipartUpload').length, 1);
  assert.equal(results.filter((r) => r.replayed).length, 9);
  // And every answer describes the SAME source.
  const values = new Set(results.map((r) => r.source.value));
  assert.equal(values.size, 1);
  assert.equal(env.storage.openUploadCount(), 0);
});

test('concurrent completions of one session still assemble once', async () => {
  const env = serverEnv();
  const s = await session(env);
  const manifest = await fillParts(env, s);

  // Five workers racing, as several finishing parts would produce.
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      svc.completeMultipartUpload({ ...ctx(env, s.token), parts: manifest, label: 'Movie' }),
    ),
  );
  assert.ok(results.every((r) => r.ok === true));
  assert.equal(env.storage.objectSize(KEY), FIXTURE_BYTES);
  assert.equal(env.storage.openUploadCount(), 0);
});

test('the member limit holds across many attempts without orphaning anything', async () => {
  const env = serverEnv();
  const first = await createUploadIntent({
    payload: { fileName: 'a.mp4', mimeType: 'video/mp4', size: 600 * MIB },
    uploadConfig: env.uploadConfig,
    storage: env.storage,
    secret: SECRET,
    roomCode: ROOM,
    memberId: MEMBER,
    sessions: env.sessions,
  });
  assert.equal(first.ok, true, first.error);

  for (let i = 0; i < CYCLES; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const denied = await createUploadIntent({
      payload: { fileName: `x${i}.mp4`, mimeType: 'video/mp4', size: 600 * MIB },
      uploadConfig: env.uploadConfig,
      storage: env.storage,
      secret: SECRET,
      roomCode: ROOM,
      memberId: MEMBER,
      sessions: env.sessions,
    });
    assert.equal(denied.error, 'UPLOAD_ALREADY_ACTIVE', `cycle ${i}`);
  }
  // 50 refusals, and still exactly ONE provider session — the whole point of
  // checking admission before initiation.
  assert.equal(env.storage.callsFor('createMultipartUpload').length, 1);
  assert.equal(env.storage.openUploadCount(), 1);
});

test('a swept registry drops everything and leaves the provider consistent', async () => {
  const env = serverEnv();
  const opened = [];
  for (let i = 0; i < 20; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    opened.push(await session(env, `member-${i}`));
  }
  assert.equal(env.sessions.size(), 20);

  // A room closing takes every active session for aborting; they become terminal
  // tombstones, not deletions, so no active session remains.
  const taken = env.sessions.takeForRoom(ROOM);
  assert.equal(taken.length, 20);
  assert.equal(env.sessions.countForRoom(ROOM), 0, 'no active sessions remain');
  for (const s of taken) {
    // eslint-disable-next-line no-await-in-loop
    await env.storage.abortMultipartUpload({ key: s.key, uploadId: s.uploadId });
  }
  assert.equal(env.storage.openUploadCount(), 0);
  // Sweeping past expiry reclaims the tombstones, leaving nothing.
  env.sessions.sweep(FAR_FUTURE);
  assert.equal(env.sessions.size(), 0);
});

/* ============================================== client-side cycles */

function fakeFile(size = FIXTURE_BYTES) {
  return {
    name: 'movie.mp4',
    type: 'video/mp4',
    size,
    lastModified: 1_700_000_000_000,
    slice: (start, end) => ({ size: end - start }),
  };
}

/** A client harness whose parts never settle unless allowed. */
function clientHarness({ settle = true } = {}) {
  const confirmed = new Map();
  const calls = [];
  const live = new Set();
  let timers = 0;

  const sizeOf = (n) => (n === PART_COUNT ? FIXTURE_BYTES - (PART_COUNT - 1) * PART_SIZE : PART_SIZE);

  const request = async (event, payload) => {
    calls.push(event);
    switch (event) {
      case 'upload:intent':
        return {
          ok: true,
          mode: 'multipart',
          token: 'token-1',
          key: KEY,
          uploadId: 'u1',
          expectedBytes: FIXTURE_BYTES,
          partSize: PART_SIZE,
          partCount: PART_COUNT,
          concurrency: 3,
          retries: 5,
          maxPartBatch: 20,
          expiresAt: 1_700_000_000_000 + 6 * 3600_000,
        };
      case 'upload:part-targets':
        return {
          ok: true,
          targets: payload.partNumbers.map((partNumber) => ({
            partNumber,
            method: 'PUT',
            url: `https://mock.invalid/o?partNumber=${partNumber}`,
            headers: {},
            expectedBytes: sizeOf(partNumber),
            expiresAt: 1_700_000_000_000 + 900_000,
          })),
        };
      case 'upload:status':
        return {
          ok: true,
          status: 'uploading',
          completedParts: [...confirmed.entries()].map(([partNumber, part]) => ({ partNumber, ...part })),
          uploadedBytes: [...confirmed.values()].reduce((sum, p) => sum + p.size, 0),
          expectedBytes: FIXTURE_BYTES,
          partCount: PART_COUNT,
          expiresAt: 1_700_000_000_000 + 6 * 3600_000,
        };
      case 'upload:complete':
        return {
          ok: true,
          source: { type: 'url', value: 'https://cdn/x', label: payload.label, quality: 'Uploaded' },
          key: KEY,
          expectedBytes: FIXTURE_BYTES,
        };
      default:
        return { ok: true };
    }
  };

  const createXhr = () => {
    const xhr = {
      status: 0,
      upload: {},
      open() {},
      setRequestHeader() {},
      getResponseHeader: (name) => (String(name).toLowerCase() === 'etag' ? xhr._etag : null),
      send(body) {
        live.add(xhr);
        if (!settle) return;
        queueMicrotask(() => {
          if (!live.has(xhr)) return;
          live.delete(xhr);
          const partNumber = Number(xhr._url.match(/partNumber=(\d+)/)[1]);
          confirmed.set(partNumber, { etag: `"e-${partNumber}"`, size: body.size });
          xhr.status = 200;
          xhr._etag = `"e-${partNumber}"`;
          xhr.onload?.();
        });
      },
      abort() {
        live.delete(xhr);
        xhr.onabort?.();
      },
    };
    const open = xhr.open;
    xhr.open = (method, url) => {
      xhr._url = url;
      open();
    };
    return xhr;
  };

  const store = new Map();
  const controller = createUploadController({
    request,
    roomCode: ROOM,
    createXhr,
    now: (() => {
      let t = 0;
      return () => (t += 250);
    })(),
    wallClock: () => 1_700_000_000_000,
    setTimer: (fn, ms) => {
      timers += 1;
      const id = { ms };
      queueMicrotask(() => {
        timers -= 1;
        fn();
      });
      return id;
    },
    clearTimer: () => {
      timers = Math.max(0, timers - 1);
    },
    random: () => 0.5,
    isOnline: () => true,
    store: {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => store.set(k, v),
      removeItem: (k) => store.delete(k),
    },
  });

  return { controller, calls, liveXhrs: () => live.size, storeSize: () => store.size, timerCount: () => timers };
}

const drain = async (rounds = 60) => {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
  await new Promise((r) => setImmediate(r));
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
};

test(`${CYCLES} pause/resume cycles leave no active request and no pending timer`, async () => {
  const h = clientHarness({ settle: false });
  void h.controller.start(fakeFile());
  await drain(20);

  for (let i = 0; i < CYCLES; i += 1) {
    h.controller.pause();
    // eslint-disable-next-line no-await-in-loop
    await drain(4);
    assert.equal(h.liveXhrs(), 0, `cycle ${i}: an aborted attempt is still live`);
    assert.equal(h.controller.debug().activeXhrs, 0, `cycle ${i}`);
    // eslint-disable-next-line no-await-in-loop
    void h.controller.resume();
    // eslint-disable-next-line no-await-in-loop
    await drain(4);
  }

  h.controller.pause();
  await drain();
  const snapshot = h.controller.getSnapshot();
  assert.equal(snapshot.phase, 'paused');
  assert.equal(h.controller.debug().activeXhrs, 0);
  assert.equal(h.controller.debug().pendingTimers, 0, 'no retry timer survives a pause');
  // Byte progress never went backwards past zero or above the total.
  assert.ok(snapshot.uploadedBytes >= 0 && snapshot.uploadedBytes <= FIXTURE_BYTES);
});

test(`${CYCLES} offline/online cycles never exceed the slice bound or leak requests`, async () => {
  const h = clientHarness({ settle: false });
  void h.controller.start(fakeFile());
  await drain(20);

  for (let i = 0; i < CYCLES; i += 1) {
    h.controller.setOnline(false);
    // eslint-disable-next-line no-await-in-loop
    await drain(4);
    assert.equal(h.controller.debug().activeXhrs, 0, `offline cycle ${i}`);
    h.controller.setOnline(true);
    // eslint-disable-next-line no-await-in-loop
    await drain(4);
  }

  h.controller.setOnline(false);
  await drain();
  const debug = h.controller.debug();
  assert.equal(debug.activeXhrs, 0);
  assert.equal(debug.activeSlices, 0, 'no slice reference is held after suspension');
  assert.ok(debug.maxConcurrentSlices <= 3, `peak slices ${debug.maxConcurrentSlices}`);
});

test(`${CYCLES} cancel cycles release everything, every time`, async () => {
  for (let i = 0; i < CYCLES; i += 1) {
    const h = clientHarness({ settle: false });
    // eslint-disable-next-line no-await-in-loop
    void h.controller.start(fakeFile());
    // eslint-disable-next-line no-await-in-loop
    await drain(12);
    // eslint-disable-next-line no-await-in-loop
    await h.controller.cancel();
    // eslint-disable-next-line no-await-in-loop
    await drain(8);

    assert.equal(h.controller.getSnapshot().phase, 'cancelled', `cycle ${i}`);
    assert.equal(h.controller.debug().activeXhrs, 0, `cycle ${i}: active XHR`);
    assert.equal(h.controller.debug().pendingTimers, 0, `cycle ${i}: pending timer`);
    assert.equal(h.liveXhrs(), 0, `cycle ${i}: live request`);
    assert.equal(h.storeSize(), 0, `cycle ${i}: persisted capability`);
  }
});

test('a full upload run leaves the controller with nothing held', async () => {
  const h = clientHarness({ settle: true });
  await h.controller.start(fakeFile());
  await drain();

  assert.equal(h.controller.getSnapshot().phase, 'completed');
  const debug = h.controller.debug();
  assert.equal(debug.activeXhrs, 0);
  assert.equal(debug.activeSlices, 0);
  assert.equal(debug.pendingTimers, 0);
  assert.ok(debug.maxConcurrentSlices <= 3, `peak slices ${debug.maxConcurrentSlices}`);
  assert.equal(h.storeSize(), 0, 'the recovery record is cleared on completion');

  h.controller.destroy();
  assert.equal(h.controller.debug().activeXhrs, 0);
});

test('no unhandled rejections escaped any of the above', () => {
  assert.deepEqual(unhandled, []);
});
