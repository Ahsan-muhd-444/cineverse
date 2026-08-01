/**
 * The browser upload engine, driven by fakes.
 *
 * Every dependency that touches the outside world is injected, so this suite runs
 * the REAL engine with a fake XHR, a fake clock, fake timers, a fake jitter
 * source and fake socket acks. No DOM, no network, no file.
 *
 * The fake File records every `slice()` call, which is how the memory bound is
 * proven structurally: the assertions below check that at most `concurrency`
 * slices are ever live at once and that no code path asks for the whole file.
 *
 * Run: node --test --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/upload-engine.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createUploadController, backoffDelay } from '../src/lib/multipartUpload.ts';

const MIB = 1024 * 1024;
const PART_SIZE = 8 * MIB;
const TOTAL = 17 * MIB; // three parts: 8 + 8 + 1
const PART_COUNT = 3;
const ROOM = 'ABC123';

/* -------------------------------------------------------------------------- */
/*  Fakes                                                                     */
/* -------------------------------------------------------------------------- */

/** A File-shaped object whose slices are views, tracked for the memory bound. */
function fakeFile(over = {}) {
  const size = over.size ?? TOTAL;
  const slices = [];
  const live = new Set();
  const file = {
    name: over.name ?? 'movie.mp4',
    type: over.type ?? 'video/mp4',
    size,
    lastModified: over.lastModified ?? 1700000000000,
    slice(start, end) {
      const record = { start, end, size: end - start };
      slices.push(record);
      live.add(record);
      // A Blob stand-in: it knows its size and nothing else holds the bytes.
      return { size: record.size, __release: () => live.delete(record) };
    },
    // Test-only introspection.
    slices: () => slices,
    liveSlices: () => live.size,
  };
  return file;
}

/** An in-memory store matching the KeyValueStore shape. */
function fakeStore() {
  const map = new Map();
  // Every write is kept, not just the last: completion CLEARS the record, so an
  // assertion about what was persisted mid-upload has to look at the history.
  const writes = [];
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      writes.push(String(v));
      map.set(k, String(v));
    },
    removeItem: (k) => map.delete(k),
    keys: () => [...map.keys()],
    writes: () => writes,
    raw: () => map,
  };
}

/**
 * A fake XHR that reports upload progress and completes when told.
 *
 * `mode` decides the outcome: 'ok' (with an ETag), 'no-etag', or an HTTP status.
 */
function fakeXhrFactory(plan) {
  const created = [];
  const factory = () => {
    const xhr = {
      status: 0,
      upload: {},
      _headers: {},
      _aborted: false,
      _done: false,
      open(method, url) {
        xhr.method = method;
        xhr.url = url;
      },
      setRequestHeader(name, value) {
        xhr._headers[name] = value;
      },
      getResponseHeader(name) {
        const key = String(name).toLowerCase();
        return key === 'etag' ? (xhr._etag ?? null) : null;
      },
      send(body) {
        xhr.body = body;
        created.push(xhr);
        const outcome = plan(xhr, created.length);
        if (!outcome) return; // left in flight, for pause/abort tests
        queueMicrotask(() => {
          if (xhr._aborted || xhr._done) return;
          if (outcome.progressTo !== undefined && xhr.upload.onprogress) {
            xhr.upload.onprogress({ lengthComputable: true, loaded: outcome.progressTo, total: body.size });
          }
          xhr._done = true;
          if (outcome.network) return xhr.onerror?.();
          xhr.status = outcome.status ?? 200;
          xhr._etag = outcome.etag === undefined ? `"etag-${xhr.url.match(/partNumber=(\d+)/)?.[1] ?? '1'}"` : outcome.etag;
          xhr.onload?.();
        });
      },
      abort() {
        xhr._aborted = true;
        xhr.onabort?.();
      },
    };
    return xhr;
  };
  factory.created = created;
  factory.inFlight = () => created.filter((x) => !x._done && !x._aborted);
  return factory;
}

/** Immediate timers, so backoff sleeps do not slow the suite. */
function fakeTimers() {
  const pending = new Set();
  let nextId = 1;
  const delays = [];
  return {
    delays,
    pending: () => pending.size,
    setTimer(fn, ms) {
      delays.push(ms);
      const id = nextId++;
      pending.add(id);
      queueMicrotask(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        fn();
      });
      return id;
    },
    clearTimer(id) {
      pending.delete(id);
    },
  };
}

/**
 * A fake server. Tracks every control call and serves plausible acks.
 * `over` replaces individual event handlers.
 */
function fakeServer(over = {}, plan = {}) {
  const calls = [];
  const confirmed = new Map(); // partNumber -> {etag, size}
  const state = {
    token: 'token-1',
    expiresAt: plan.expiresAt ?? Date.now() + 6 * 3600_000,
    completedOnce: 0,
  };

  // The plan is a parameter so a test can use 24 parts without rewiring the fake.
  const total = plan.total ?? TOTAL;
  const partSize = plan.partSize ?? PART_SIZE;
  const partCount = plan.partCount ?? Math.ceil(total / partSize);
  const concurrency = plan.concurrency ?? 3;

  const sizeOf = (n) => (n === partCount ? total - (partCount - 1) * partSize : partSize);

  const handlers = {
    'upload:intent': () => ({
      ok: true,
      mode: 'multipart',
      token: state.token,
      key: 'rooms/ABC123/0123456789abcdef/movie.mp4',
      uploadId: 'upload-1',
      fileName: 'movie.mp4',
      mimeType: 'video/mp4',
      expectedBytes: total,
      maxBytes: 3 * 1024 * MIB,
      partSize,
      partCount,
      lastPartSize: sizeOf(partCount),
      concurrency,
      retries: 5,
      maxPartBatch: 20,
      expiresAt: state.expiresAt,
      partUrlTtlSeconds: 900,
    }),
    'upload:part-targets': (payload) => ({
      ok: true,
      targets: payload.partNumbers.map((partNumber) => ({
        partNumber,
        method: 'PUT',
        url: `https://bucket.invalid/obj?partNumber=${partNumber}&sig=x`,
        headers: {},
        expectedBytes: sizeOf(partNumber),
        expiresAt: Date.now() + 900_000,
      })),
    }),
    'upload:status': () => ({
      ok: true,
      status: confirmed.size >= partCount ? 'finalizing' : 'uploading',
      completedParts: [...confirmed.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([partNumber, part]) => ({ partNumber, ...part })),
      uploadedBytes: [...confirmed.values()].reduce((s, p) => s + p.size, 0),
      expectedBytes: total,
      partCount,
      expiresAt: state.expiresAt,
    }),
    'upload:renew': () => {
      state.token = `${state.token}-renewed`;
      state.expiresAt += 6 * 3600_000;
      return { ok: true, token: state.token, expiresAt: state.expiresAt };
    },
    'upload:complete': (payload) => {
      state.completedOnce += 1;
      return {
        ok: true,
        source: { type: 'url', value: 'https://cdn.invalid/movie.mp4', label: payload.label, quality: 'Uploaded' },
        key: 'rooms/ABC123/0123456789abcdef/movie.mp4',
        expectedBytes: total,
      };
    },
    'upload:abort': () => ({ ok: true }),
    'upload:room-progress': () => ({ ok: true }),
    ...over,
  };

  const request = async (event, payload) => {
    calls.push({ event, payload });
    const handler = handlers[event];
    if (!handler) throw new Error(`unexpected event ${event}`);
    return handler(payload, { confirmed, state });
  };

  return {
    request,
    calls,
    confirmed,
    state,
    sizeOf,
    plan: { total, partSize, partCount, concurrency },
    eventsOf: (event) => calls.filter((c) => c.event === event).map((c) => c.payload),
    countOf: (event) => calls.filter((c) => c.event === event).length,
    /** Mark a part as stored, as a bucket would once the PUT lands. */
    confirm(partNumber) {
      confirmed.set(partNumber, { etag: `"etag-${partNumber}"`, size: sizeOf(partNumber) });
    },
  };
}

/** Build a controller with all fakes wired, and a snapshot recorder. */
function harness({ server = fakeServer(), xhr, timers = fakeTimers(), store = fakeStore(), online = true, random = () => 0.5 } = {}) {
  const snapshots = [];
  let clock = 1000;
  const completedWith = [];
  const failedWith = [];
  let isOnline = online;

  const controller = createUploadController({
    request: server.request,
    roomCode: ROOM,
    createXhr: xhr,
    now: () => (clock += 250),
    wallClock: () => 1_700_000_000_000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    random,
    isOnline: () => isOnline,
    store,
    onCompleted: (result) => completedWith.push(result),
    onFailed: (code) => failedWith.push(code),
  });
  controller.subscribe((s) => snapshots.push(s));

  return {
    controller,
    server,
    timers,
    store,
    snapshots,
    completedWith,
    failedWith,
    phases: () => [...new Set(snapshots.map((s) => s.phase))],
    setOnline: (next) => {
      isOnline = next;
      controller.setOnline(next);
    },
  };
}

/** Let queued microtasks and immediate timers settle. */
const settle = async (rounds = 40) => {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
  await new Promise((r) => setImmediate(r));
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
};

/** The default XHR plan: every part succeeds and the server confirms it. */
const succeedAll = (server) =>
  fakeXhrFactory((xhr) => {
    const partNumber = Number(xhr.url.match(/partNumber=(\d+)/)[1]);
    server.confirm(partNumber);
    return { progressTo: xhr.body.size, etag: `"etag-${partNumber}"` };
  });

/* ============================================== the happy path */

test('a multipart upload uploads every part and completes exactly once', async () => {
  const server = fakeServer();
  const h = harness({ server, xhr: succeedAll(server) });
  const file = fakeFile();

  await h.controller.start(file);
  await settle();

  const final = h.controller.getSnapshot();
  assert.equal(final.phase, 'completed', final.error);
  assert.equal(final.percentage, 100);
  assert.equal(final.uploadedBytes, TOTAL);
  assert.equal(final.completedParts, PART_COUNT);
  assert.equal(h.completedWith.length, 1);
  assert.equal(h.completedWith[0].source.value, 'https://cdn.invalid/movie.mp4');

  // The client asked the server for the transport; it never guessed.
  assert.equal(server.countOf('upload:intent'), 1);
  // Completion happened once, even though three workers finished together.
  assert.equal(server.countOf('upload:complete'), 1);
  assert.equal(server.state.completedOnce, 1);
  // Status is consulted BEFORE uploading, so a resume never re-sends a part.
  assert.ok(server.calls.findIndex((c) => c.event === 'upload:status') < server.calls.findIndex((c) => c.event === 'upload:part-targets'));
});

test('slices match the plan exactly and never cover the whole file at once', async () => {
  const server = fakeServer();
  const h = harness({ server, xhr: succeedAll(server) });
  const file = fakeFile();

  await h.controller.start(file);
  await settle();

  const slices = file.slices();
  assert.equal(slices.length, PART_COUNT, 'one slice per part, no re-slicing');
  assert.deepEqual(
    slices.map((s) => [s.start, s.end]),
    [
      [0, PART_SIZE],
      [PART_SIZE, 2 * PART_SIZE],
      [2 * PART_SIZE, TOTAL],
    ],
  );
  // No slice is the whole file, and no ArrayBuffer is ever requested.
  assert.ok(slices.every((s) => s.size <= PART_SIZE));
  assert.equal(typeof file.arrayBuffer, 'undefined', 'the engine must not need arrayBuffer()');
});

test('concurrency never exceeds the server-provided value', async () => {
  const server = fakeServer();
  let peak = 0;
  const xhr = fakeXhrFactory((x) => {
    peak = Math.max(peak, xhr.inFlight().length);
    const partNumber = Number(x.url.match(/partNumber=(\d+)/)[1]);
    server.confirm(partNumber);
    return { progressTo: x.body.size };
  });
  const h = harness({ server, xhr });

  await h.controller.start(fakeFile());
  await settle();

  assert.equal(h.controller.getSnapshot().phase, 'completed');
  assert.ok(peak <= 3, `peak in-flight ${peak} must not exceed concurrency 3`);
  assert.ok(h.controller.debug().maxConcurrentSlices <= 3, 'slice bound');
});

test('part-target batches are bounded to 2x concurrency, not the whole plan', async () => {
  // 24 parts with concurrency 3: the engine must never ask for all 24 up front,
  // because each signed URL is a write capability with its own expiry.
  const server = fakeServer({}, { total: 24 * PART_SIZE, partSize: PART_SIZE, partCount: 24, concurrency: 3 });
  const h = harness({ server, xhr: succeedAll(server) });

  await h.controller.start(fakeFile({ size: 24 * PART_SIZE }));
  await settle(120);

  assert.equal(h.controller.getSnapshot().phase, 'completed', h.controller.getSnapshot().error);
  const batches = server.eventsOf('upload:part-targets');
  assert.ok(batches.length > 1, 'targets must be requested in batches');
  for (const batch of batches) {
    assert.ok(batch.partNumbers.length <= 6, `batch of ${batch.partNumbers.length} exceeds 2x concurrency`);
    assert.ok(batch.partNumbers.length <= 20, 'never above the server contract bound');
  }
  // And the memory bound holds across 24 parts just as it does across 3.
  assert.ok(h.controller.debug().maxConcurrentSlices <= 3);
});


test('only MISSING parts are queued after a resume', async () => {
  const server = fakeServer();
  // Two parts already landed before this client ever ran.
  server.confirm(1);
  server.confirm(2);

  const h = harness({ server, xhr: succeedAll(server) });
  const file = fakeFile();
  await h.controller.start(file);
  await settle();

  assert.equal(h.controller.getSnapshot().phase, 'completed');
  // Exactly one slice: part 3. Parts 1 and 2 were never re-read.
  assert.deepEqual(file.slices().map((s) => s.start), [2 * PART_SIZE]);
  const requested = server.eventsOf('upload:part-targets').flatMap((p) => p.partNumbers);
  assert.deepEqual([...new Set(requested)], [3]);
});

/* ============================================== retries */

test('a retryable failure retries with bounded jittered backoff', async () => {
  const server = fakeServer();
  let attempts = 0;
  const xhr = fakeXhrFactory((x) => {
    const partNumber = Number(x.url.match(/partNumber=(\d+)/)[1]);
    if (partNumber === 2 && attempts < 2) {
      attempts += 1;
      return { status: 500 };
    }
    server.confirm(partNumber);
    return { progressTo: x.body.size };
  });
  const timers = fakeTimers();
  const h = harness({ server, xhr, timers });

  await h.controller.start(fakeFile());
  await settle(80);

  assert.equal(h.controller.getSnapshot().phase, 'completed');
  assert.equal(attempts, 2);
  assert.ok(h.phases().includes('retrying'), 'the retrying phase must be visible');
  // 500ms then 1000ms, halved-plus-jitter with random()=0.5 → 375, 750.
  assert.deepEqual(timers.delays.slice(0, 2), [375, 750]);
  assert.equal(h.controller.debug().pendingTimers, 0, 'no retry timer is left behind');
});

test('backoff is exponential, jittered and capped', () => {
  assert.equal(backoffDelay(1, () => 0), 250);
  assert.equal(backoffDelay(1, () => 1), 500);
  assert.equal(backoffDelay(2, () => 1), 1000);
  assert.equal(backoffDelay(3, () => 1), 2000);
  assert.equal(backoffDelay(4, () => 1), 4000);
  assert.equal(backoffDelay(5, () => 1), 8000);
  // Capped near 15s however many attempts have been spent.
  assert.equal(backoffDelay(9, () => 1), 15_000);
  assert.equal(backoffDelay(50, () => 1), 15_000);
  // Jitter never collapses the delay to zero.
  assert.ok(backoffDelay(1, () => 0) > 0);
});

test('a non-retryable status fails immediately without spending retries', async () => {
  const server = fakeServer();
  let sends = 0;
  const xhr = fakeXhrFactory((x) => {
    sends += 1;
    const partNumber = Number(x.url.match(/partNumber=(\d+)/)[1]);
    if (partNumber === 1) return { status: 404 };
    server.confirm(partNumber);
    return { progressTo: x.body.size };
  });
  const h = harness({ server, xhr });

  await h.controller.start(fakeFile());
  await settle(60);

  assert.equal(h.controller.getSnapshot().phase, 'failed');
  assert.equal(h.controller.getSnapshot().error, 'PART_REJECTED_404');
  assert.ok(sends <= PART_COUNT, 'a 404 must not be retried five times');
  assert.equal(server.countOf('upload:complete'), 0);
});

test('a 200 with no ETag is a failure, not a silent success', async () => {
  const server = fakeServer();
  const xhr = fakeXhrFactory(() => ({ status: 200, etag: null }));
  const h = harness({ server, xhr });

  await h.controller.start(fakeFile());
  await settle(60);

  const snapshot = h.controller.getSnapshot();
  assert.equal(snapshot.phase, 'failed');
  // A missing ETag is a bucket CORS problem — named, so it can be fixed.
  assert.equal(snapshot.error, 'MISSING_ETAG');
  assert.equal(server.countOf('upload:complete'), 0);
});

test('a 403 discards the signed URL and asks for a fresh target', async () => {
  const server = fakeServer();
  const seen = [];
  let rejectedOnce = false;
  const xhr = fakeXhrFactory((x) => {
    const partNumber = Number(x.url.match(/partNumber=(\d+)/)[1]);
    seen.push(x.url);
    if (partNumber === 1 && !rejectedOnce) {
      rejectedOnce = true;
      return { status: 403 };
    }
    server.confirm(partNumber);
    return { progressTo: x.body.size };
  });
  const h = harness({ server, xhr });

  await h.controller.start(fakeFile());
  await settle(80);

  assert.equal(h.controller.getSnapshot().phase, 'completed');
  // Part 1 was signed twice: the expired URL was discarded rather than reused.
  const part1Targets = server.eventsOf('upload:part-targets').filter((p) => p.partNumbers.includes(1));
  assert.ok(part1Targets.length >= 2, 'a rejected URL must be re-signed');
});

test('a retry does not double-count bytes', async () => {
  const server = fakeServer();
  let failedOnce = false;
  const xhr = fakeXhrFactory((x) => {
    const partNumber = Number(x.url.match(/partNumber=(\d+)/)[1]);
    if (partNumber === 1 && !failedOnce) {
      failedOnce = true;
      // Half the part "uploads" and then the connection dies.
      return { progressTo: PART_SIZE / 2, network: true };
    }
    server.confirm(partNumber);
    return { progressTo: x.body.size };
  });
  const h = harness({ server, xhr });

  await h.controller.start(fakeFile());
  await settle(80);

  assert.equal(h.controller.getSnapshot().phase, 'completed');
  assert.equal(h.controller.getSnapshot().uploadedBytes, TOTAL, 'exactly the file size, not more');
  // No snapshot along the way ever exceeded the total or 100%.
  for (const snapshot of h.snapshots) {
    assert.ok(snapshot.uploadedBytes <= TOTAL, `saw ${snapshot.uploadedBytes} > ${TOTAL}`);
    assert.ok(snapshot.percentage <= 100);
  }
});

/* ============================================== pause / resume / cancel */

test('pause aborts active requests, keeps completed parts, and does NOT abort the provider', async () => {
  const server = fakeServer();
  // Part 1 completes; part 2 is left in flight so pause has something to abort.
  const xhr = fakeXhrFactory((x) => {
    const partNumber = Number(x.url.match(/partNumber=(\d+)/)[1]);
    if (partNumber === 1) {
      server.confirm(1);
      return { progressTo: x.body.size };
    }
    return null; // never settles
  });
  const h = harness({ server, xhr });

  // NOT awaited: this XHR plan leaves a request in flight on purpose, so start()
  // only resolves once the upload is paused, cancelled or aborted.
  void h.controller.start(fakeFile());
  await settle(30);
  assert.ok(xhr.inFlight().length > 0, 'something must be in flight to pause');

  h.controller.pause();
  await settle();

  const snapshot = h.controller.getSnapshot();
  assert.equal(snapshot.phase, 'paused');
  assert.equal(snapshot.completedParts, 1, 'confirmed parts survive');
  assert.equal(snapshot.uploadedBytes, PART_SIZE, 'transient bytes are dropped');
  // Speed and ETA stop being offered while paused.
  assert.equal(snapshot.smoothedBytesPerSecond, null);
  assert.equal(snapshot.etaSeconds, null);
  // The provider session is untouched — that is what makes resume possible.
  assert.equal(server.countOf('upload:abort'), 0);
  assert.equal(xhr.inFlight().length, 0, 'active requests are aborted');
  assert.equal(h.controller.debug().activeXhrs, 0);
  // The room hears about it immediately, not on the next throttle tick.
  const paused = server.eventsOf('upload:room-progress').filter((p) => p.status === 'paused');
  assert.equal(paused.length, 1);
});

test('resume asks the provider what landed and finishes the rest', async () => {
  const server = fakeServer();
  let allowPart2 = false;
  const xhr = fakeXhrFactory((x) => {
    const partNumber = Number(x.url.match(/partNumber=(\d+)/)[1]);
    if (partNumber === 1 || allowPart2) {
      server.confirm(partNumber);
      return { progressTo: x.body.size };
    }
    return null;
  });
  const h = harness({ server, xhr });
  const file = fakeFile();

  // NOT awaited: part 2 is deliberately left in flight until the test allows it.
  void h.controller.start(file);
  await settle(30);
  h.controller.pause();
  await settle();

  const statusBefore = server.countOf('upload:status');
  allowPart2 = true;
  await h.controller.resume();
  await settle(80);

  assert.equal(h.controller.getSnapshot().phase, 'completed');
  assert.ok(server.countOf('upload:status') > statusBefore, 'resume must consult the provider');
  assert.equal(server.countOf('upload:complete'), 1);
});

test('cancel aborts the provider session, clears persistence and releases the file', async () => {
  const server = fakeServer();
  const xhr = fakeXhrFactory(() => null);
  const store = fakeStore();
  const h = harness({ server, xhr, store });

  // NOT awaited: this XHR plan leaves a request in flight on purpose, so start()
  // only resolves once the upload is paused, cancelled or aborted.
  void h.controller.start(fakeFile());
  await settle(20);
  assert.ok(store.keys().length > 0, 'a resumable session is persisted while running');

  await h.controller.cancel();
  await settle();

  assert.equal(h.controller.getSnapshot().phase, 'cancelled');
  assert.equal(server.countOf('upload:abort'), 1);
  assert.equal(store.keys().length, 0, 'the capability is cleared');
  assert.equal(h.controller.debug().activeXhrs, 0);
  assert.equal(h.controller.debug().pendingTimers, 0);

  // Idempotent: a second cancel is safe.
  await h.controller.cancel();
  await settle();
  assert.equal(h.controller.getSnapshot().phase, 'cancelled');
});

/* ============================================== offline / reconnect */

test('going offline suspends the upload and excludes the gap from speed', async () => {
  const server = fakeServer();
  const xhr = fakeXhrFactory((x) => {
    const partNumber = Number(x.url.match(/partNumber=(\d+)/)[1]);
    if (partNumber === 1) {
      server.confirm(1);
      return { progressTo: x.body.size };
    }
    return null;
  });
  const h = harness({ server, xhr });

  // NOT awaited: this XHR plan leaves a request in flight on purpose, so start()
  // only resolves once the upload is paused, cancelled or aborted.
  void h.controller.start(fakeFile());
  await settle(30);

  h.setOnline(false);
  await settle();

  const offline = h.controller.getSnapshot();
  assert.equal(offline.phase, 'reconnecting');
  assert.equal(offline.smoothedBytesPerSecond, null, 'offline time is not slow transfer');
  assert.equal(offline.etaSeconds, null);
  assert.equal(offline.completedParts, 1, 'confirmed parts survive');
  assert.equal(server.countOf('upload:abort'), 0, 'offline must not abort the provider');
  const reconnecting = server.eventsOf('upload:room-progress').filter((p) => p.status === 'reconnecting');
  assert.equal(reconnecting.length, 1);
});

test('coming back online re-checks provider state before sending anything', async () => {
  const server = fakeServer();
  let allowRest = false;
  const xhr = fakeXhrFactory((x) => {
    const partNumber = Number(x.url.match(/partNumber=(\d+)/)[1]);
    if (partNumber === 1 || allowRest) {
      server.confirm(partNumber);
      return { progressTo: x.body.size };
    }
    return null;
  });
  const h = harness({ server, xhr });

  // NOT awaited: this XHR plan leaves a request in flight on purpose, so start()
  // only resolves once the upload is paused, cancelled or aborted.
  void h.controller.start(fakeFile());
  await settle(30);
  h.setOnline(false);
  await settle();

  const before = server.countOf('upload:status');
  allowRest = true;
  h.setOnline(true);
  await settle(80);

  assert.ok(server.countOf('upload:status') > before, 'status is consulted on reconnect');
  assert.equal(h.controller.getSnapshot().phase, 'completed');
});

/* ============================================== completion guards */

test('a completion failure is reported and does not publish a source', async () => {
  const server = fakeServer({ 'upload:complete': () => ({ ok: false, error: 'SIZE_MISMATCH' }) });
  const h = harness({ server, xhr: succeedAll(server) });

  await h.controller.start(fakeFile());
  await settle(60);

  const snapshot = h.controller.getSnapshot();
  assert.equal(snapshot.phase, 'failed');
  assert.equal(snapshot.error, 'SIZE_MISMATCH');
  assert.equal(h.completedWith.length, 0);
  assert.deepEqual(h.failedWith, ['SIZE_MISMATCH']);
});

test('finalizing is a distinct phase from completed', async () => {
  const server = fakeServer();
  let releaseComplete = () => {};
  const gated = fakeServer({
    'upload:complete': (payload) =>
      new Promise((resolve) => {
        releaseComplete = () =>
          resolve({
            ok: true,
            source: { type: 'url', value: 'https://cdn.invalid/x', label: payload.label, quality: 'Uploaded' },
            key: 'k',
            expectedBytes: TOTAL,
          });
      }),
  });
  gated.confirm = server.confirm.bind(server);
  gated.confirmed = server.confirmed;
  const h = harness({ server: gated, xhr: succeedAll(gated) });

  void h.controller.start(fakeFile());
  await settle(60);

  const midpoint = h.controller.getSnapshot();
  assert.equal(midpoint.phase, 'finalizing');
  // 100% of the bytes are up, but the object does not exist yet.
  assert.equal(midpoint.percentage, 100);
  assert.equal(midpoint.awaitingProvider, true);
  assert.equal(h.completedWith.length, 0, 'not completed until the provider says so');

  releaseComplete();
  await settle();
  assert.equal(h.controller.getSnapshot().phase, 'completed');
  assert.equal(h.controller.getSnapshot().awaitingProvider, false);
});

test('a session close to expiry is renewed rather than risked', async () => {
  // Five minutes left, inside the ten-minute renewal margin. The expiry comes
  // from the fake's shared state, which BOTH intent and status report — status is
  // authoritative and overwrites whatever intent said, so a test that only moved
  // the intent value would prove nothing.
  const server = fakeServer({}, { expiresAt: 1_700_000_000_000 + 5 * 60_000, concurrency: 1 });
  const h = harness({ server, xhr: succeedAll(server) });

  await h.controller.start(fakeFile());
  await settle(120);

  assert.equal(h.controller.getSnapshot().phase, 'completed', h.controller.getSnapshot().error);
  assert.ok(server.countOf('upload:renew') >= 1, 'a near-expiry session must be renewed');
  // The renewed token is the one used from then on.
  const tokens = server.eventsOf('upload:part-targets').map((p) => p.token);
  assert.ok(tokens.some((t) => t.includes('renewed')), 'the renewed token replaces the old one');
  // And it was persisted while in flight, so a refresh mid-upload would recover
  // the CURRENT capability rather than the expiring one. (Completion then clears
  // the record, which is why this looks at the write history.)
  assert.ok(
    h.store.writes().some((raw) => String(JSON.parse(raw).token).includes('renewed')),
    'the renewed token must be persisted',
  );
  assert.equal(h.store.keys().length, 0, 'and cleared once the upload completes');
});


/* ============================================== intent errors */

test('a refused intent surfaces the server code and uploads nothing', async () => {
  for (const error of ['TOO_LARGE', 'UNSUPPORTED_TYPE', 'MULTIPART_REQUIRED', 'UPLOAD_ALREADY_ACTIVE', 'CONFIGURATION_ERROR']) {
    const server = fakeServer({ 'upload:intent': () => ({ ok: false, error, maxBytes: 500 * MIB }) });
    const xhr = fakeXhrFactory(() => ({ progressTo: 0 }));
    const h = harness({ server, xhr });

    await h.controller.start(fakeFile());
    await settle(20);

    assert.equal(h.controller.getSnapshot().phase, 'failed', error);
    assert.equal(h.controller.getSnapshot().error, error);
    assert.equal(xhr.created.length, 0, 'no bytes may be sent');
  }
});

test('the client does not choose the transport — it obeys the server', async () => {
  // A tiny file the server routes to single-shot: no part machinery is used.
  const server = fakeServer({
    'upload:intent': () => ({
      ok: true,
      mode: 'single',
      token: 'single-token',
      key: 'rooms/ABC123/0123456789abcdef/movie.mp4',
      method: 'PUT',
      uploadUrl: 'https://bucket.invalid/put?token=x',
      headers: { 'Content-Type': 'video/mp4' },
      expectedBytes: TOTAL,
      maxBytes: 500 * MIB,
      direct: true,
    }),
  });
  const xhr = fakeXhrFactory((x) => ({ progressTo: x.body.size, etag: '"single"' }));
  const h = harness({ server, xhr });

  await h.controller.start(fakeFile());
  await settle(40);

  assert.equal(h.controller.getSnapshot().mode, 'single');
  assert.equal(h.controller.getSnapshot().phase, 'completed');
  assert.equal(server.countOf('upload:part-targets'), 0, 'a single upload signs no parts');
  assert.equal(server.countOf('upload:status'), 0);
  // The whole file is sent as one body — which is why Pause is not offered.
  assert.equal(xhr.created.length, 1);
});

test('pause is a no-op for a single-shot upload', async () => {
  const server = fakeServer({
    'upload:intent': () => ({
      ok: true,
      mode: 'single',
      token: 't',
      key: 'rooms/ABC123/0123456789abcdef/movie.mp4',
      method: 'PUT',
      uploadUrl: 'https://bucket.invalid/put',
      expectedBytes: TOTAL,
    }),
  });
  const xhr = fakeXhrFactory(() => null);
  const h = harness({ server, xhr });

  void h.controller.start(fakeFile());
  await settle(20);
  h.controller.pause();
  await settle();

  // Never claims to be paused, because a single request cannot resume.
  assert.notEqual(h.controller.getSnapshot().phase, 'paused');
});

/* ============================================== progress reporting */

test('room progress is throttled for bytes and immediate for state changes', async () => {
  const server = fakeServer();
  const xhr = fakeXhrFactory((x) => {
    const partNumber = Number(x.url.match(/partNumber=(\d+)/)[1]);
    if (partNumber === 1) {
      server.confirm(1);
      return { progressTo: x.body.size };
    }
    return null;
  });
  const h = harness({ server, xhr });

  // NOT awaited: this XHR plan leaves a request in flight on purpose, so start()
  // only resolves once the upload is paused, cancelled or aborted.
  void h.controller.start(fakeFile());
  await settle(40);
  const uploadingReports = server.eventsOf('upload:room-progress').filter((p) => p.status === 'uploading').length;

  h.controller.pause();
  await settle();

  const reports = server.eventsOf('upload:room-progress');
  // The clock advances 250ms per read, so a 2s throttle allows very few
  // 'uploading' reports across this many events.
  assert.ok(uploadingReports <= 3, `${uploadingReports} byte reports is not throttled`);
  assert.ok(reports.some((p) => p.status === 'paused'), 'the state change is sent');
  // No secrets in a progress report beyond the token it must prove itself with.
  for (const report of reports) {
    assert.deepEqual(Object.keys(report).sort(), ['label', 'mode', 'status', 'token', 'totalBytes', 'uploadedBytes']);
    assert.equal(report.totalBytes, TOTAL);
    assert.ok(report.uploadedBytes <= TOTAL);
  }
});

/* ==========================================================================
 * Item 3: the server's STATUS decides what to do, not the part count alone.
 * ========================================================================== */

test('a completed status finishes idempotently — no part targets, no slices, no PUTs', async () => {
  /*
   * The lost-ack case. The provider assembled the object and the server reports
   * `status:'completed'` with an EMPTY completedParts list (there is no multipart
   * upload left to list). The old engine read "0 of 3 parts confirmed" and rebuilt
   * the whole queue: it re-sliced the file and re-PUT every part. It must instead
   * call the idempotent completion once and take the verified source.
   */
  const server = fakeServer({
    'upload:status': () => ({
      ok: true,
      status: 'completed',
      completedParts: [],
      uploadedBytes: TOTAL,
      expectedBytes: TOTAL,
      partCount: PART_COUNT,
      expiresAt: Date.now() + 3600_000,
    }),
  });
  const xhr = fakeXhrFactory(() => ({ status: 200 }));
  const h = harness({ server, xhr });
  const file = fakeFile();

  await h.controller.start(file);
  await settle();

  assert.equal(h.controller.getSnapshot().phase, 'completed');
  assert.equal(h.completedWith.length, 1, 'the verified source is delivered exactly once');
  assert.equal(server.countOf('upload:complete'), 1, 'completion is called exactly once');
  // The three things that must NOT happen.
  assert.equal(server.countOf('upload:part-targets'), 0, 'no part targets may be requested');
  assert.equal(file.slices().length, 0, 'the file must not be sliced again');
  assert.equal(xhr.created.length, 0, 'no part PUT may be sent');
});

test('an aborted or expired status is a terminal failure with no part work', async () => {
  for (const [status, expected] of [
    ['aborted', 'SESSION_CLOSED'],
    ['expired', 'SESSION_EXPIRED'],
  ]) {
    const server = fakeServer({
      'upload:status': () => ({
        ok: true,
        status,
        completedParts: [],
        uploadedBytes: 0,
        expectedBytes: TOTAL,
        partCount: PART_COUNT,
        expiresAt: Date.now() + 3600_000,
      }),
    });
    const xhr = fakeXhrFactory(() => ({ status: 200 }));
    const h = harness({ server, xhr });
    const file = fakeFile();

    await h.controller.start(file);
    await settle();

    const snapshot = h.controller.getSnapshot();
    assert.equal(snapshot.phase, 'failed', status);
    assert.equal(snapshot.error, expected, status);
    assert.equal(snapshot.retryable, false, `${status} must be terminal, not retryable`);
    assert.equal(server.countOf('upload:part-targets'), 0, status);
    assert.equal(file.slices().length, 0, status);
    assert.equal(server.countOf('upload:complete'), 0, status);
  }
});

/* ==========================================================================
 * Item 5: retryable failures preserve the session.
 * ========================================================================== */

test('a retryable failure keeps the token, the file, the parts and the persistence', async () => {
  // Network exhaustion on part 2: every attempt fails, so the upload fails — but
  // the session itself is intact and must stay resumable.
  const server = fakeServer();
  const xhr = fakeXhrFactory((x) => {
    const partNumber = Number(x.url.match(/partNumber=(\d+)/)?.[1]);
    return partNumber === 2 ? { network: true } : { status: 200 };
  });
  const h = harness({ server, xhr, random: () => 0 });
  const file = fakeFile();

  await h.controller.start(file);
  await settle(200);

  const snapshot = h.controller.getSnapshot();
  assert.equal(snapshot.phase, 'failed');
  assert.equal(snapshot.retryable, true, 'a network failure is retryable');
  // The persisted recovery record is NOT cleared, so a refresh can still resume.
  assert.ok(h.store.keys().length > 0, 'persistence must survive a retryable failure');
  assert.equal(h.controller.debug().activeXhrs, 0);
});

test('MISSING_ETAG is RETRYABLE and preserves the session (item 4)', async () => {
  /*
   * A 200 with no readable ETag means the PUT reached the provider (the part is
   * stored) but the browser could not read the header — a fixable bucket-CORS
   * problem. It must NOT be terminal: the session, token, File and persistence are
   * kept so a retry resumes and the server reconciles the provider-confirmed parts.
   */
  const server = fakeServer();
  const xhr = fakeXhrFactory(() => ({ status: 200, etag: '' }));
  const h = harness({ server, xhr });

  await h.controller.start(fakeFile());
  await settle(120);

  const snapshot = h.controller.getSnapshot();
  assert.equal(snapshot.phase, 'failed');
  assert.equal(snapshot.error, 'MISSING_ETAG');
  assert.equal(snapshot.retryable, true, 'a fixable CORS/ETag failure keeps the session resumable');
  assert.ok(h.store.keys().length > 0, 'persistence survives so a retry can resume');
  // The provider upload is NOT aborted — the bytes landed, only the ETag was unreadable.
  assert.equal(server.countOf('upload:abort'), 0);
});

test('a CLIENT-origin terminal failure aborts the lifecycle before discarding the token (item 3/4)', async () => {
  // The server did NOT flag terminal, but SIZE_MISMATCH is terminal in the client's
  // set. With a still-valid token, the client fires a mode-appropriate upload:abort
  // to close the lifecycle before releasing anything — so no orphan, no dead-end.
  const server = fakeServer({ 'upload:complete': () => ({ ok: false, error: 'SIZE_MISMATCH' }) });
  const h = harness({ server, xhr: succeedAll(server) });

  await h.controller.start(fakeFile());
  await settle(120);

  const snapshot = h.controller.getSnapshot();
  assert.equal(snapshot.phase, 'failed');
  assert.equal(snapshot.error, 'SIZE_MISMATCH');
  assert.equal(snapshot.retryable, false, 'a client-terminal code is not resumable');
  assert.equal(h.store.keys().length, 0, 'persistence is cleared');
  assert.equal(server.countOf('upload:abort'), 1, 'the lifecycle is aborted on a client-origin terminal failure');
  assert.equal(server.eventsOf('upload:abort')[0].mode, 'multipart');
});

test('a SERVER-terminal completion needs NO redundant client abort (item 3)', async () => {
  // terminal:true means the service already closed the lifecycle (it aborted/deleted
  // its own side), so a redundant client abort would be wasted — and worse, could
  // race a fresh session. The client honours the verdict and clears immediately.
  const server = fakeServer({ 'upload:complete': () => ({ ok: false, error: 'COMPLETE_FAILED', terminal: true }) });
  const h = harness({ server, xhr: succeedAll(server) });

  await h.controller.start(fakeFile());
  await settle(120);

  const snapshot = h.controller.getSnapshot();
  assert.equal(snapshot.phase, 'failed');
  assert.equal(snapshot.error, 'COMPLETE_FAILED');
  assert.equal(snapshot.retryable, false, 'the server terminal verdict overrides the client set');
  assert.equal(h.store.keys().length, 0, 'a terminal session is not preserved');
  assert.equal(server.countOf('upload:abort'), 0, 'no redundant abort — the server already closed the lifecycle');
});

test('the server RETRYABLE flag preserves a code the client would treat as terminal (item 5)', async () => {
  // SIZE_MISMATCH is terminal in the client's static set — but this instance is
  // classified retryable by the server, and the client must keep the session.
  const server = fakeServer({ 'upload:complete': () => ({ ok: false, error: 'SIZE_MISMATCH', retryable: true }) });
  const h = harness({ server, xhr: succeedAll(server) });

  await h.controller.start(fakeFile());
  await settle(120);

  const snapshot = h.controller.getSnapshot();
  assert.equal(snapshot.phase, 'failed');
  assert.equal(snapshot.error, 'SIZE_MISMATCH');
  assert.equal(snapshot.retryable, true, 'the server retryable verdict overrides the client set');
  assert.ok(h.store.keys().length > 0, 'a retryable session is preserved for a retry');
  assert.equal(server.countOf('upload:abort'), 0, 'a retryable failure does not abort the provider');
});

/* ==========================================================================
 * Item 2/3: cancellation is a real lifecycle round-trip, mode-aware.
 * ========================================================================== */

test('cancel enters a cancelling state and awaits the lifecycle ack before discarding (item 3)', async () => {
  let releaseAbort = () => {};
  const server = fakeServer({ 'upload:abort': () => new Promise((res) => (releaseAbort = () => res({ ok: true }))) });
  const xhr = fakeXhrFactory(() => null); // stays in flight
  const h = harness({ server, xhr });

  void h.controller.start(fakeFile());
  await settle(20);

  const cancelling = h.controller.cancel();
  await settle(6);
  // While the ack is pending, the engine is 'cancelling' and keeps its capability.
  assert.equal(h.controller.getSnapshot().phase, 'cancelling');
  assert.equal(server.countOf('upload:abort'), 1);
  assert.equal(server.eventsOf('upload:abort')[0].mode, 'multipart');
  assert.equal(h.controller.debug().activeXhrs, 0, 'the in-flight request is aborted immediately');

  releaseAbort();
  await cancelling;
  await settle();
  assert.equal(h.controller.getSnapshot().phase, 'cancelled', 'discarded only after the ack');
  assert.equal(h.store.keys().length, 0, 'persistence cleared on ack');
});

test('single-shot cancel sends a single-mode abort (item 2)', async () => {
  const server = fakeServer({
    'upload:intent': () => ({
      ok: true,
      mode: 'single',
      token: 'single-token',
      key: 'rooms/ABC123/0123456789abcdef/movie.mp4',
      method: 'PUT',
      uploadUrl: 'https://bucket.invalid/put',
      expectedBytes: TOTAL,
    }),
  });
  const xhr = fakeXhrFactory(() => null); // in flight
  const h = harness({ server, xhr });

  void h.controller.start(fakeFile());
  await settle(20);
  await h.controller.cancel();
  await settle();

  assert.equal(server.countOf('upload:abort'), 1);
  assert.equal(server.eventsOf('upload:abort')[0].mode, 'single');
  assert.equal(server.eventsOf('upload:abort')[0].token, 'single-token');
  assert.equal(h.controller.getSnapshot().phase, 'cancelled');
});

test('a single-shot terminal XHR failure aborts the single lifecycle (item 2)', async () => {
  const server = fakeServer({
    'upload:intent': () => ({
      ok: true,
      mode: 'single',
      token: 'st',
      key: 'rooms/ABC123/0123456789abcdef/movie.mp4',
      method: 'PUT',
      uploadUrl: 'https://bucket.invalid/put',
      expectedBytes: TOTAL,
    }),
  });
  const xhr = fakeXhrFactory(() => ({ status: 500 })); // a terminal HTTP failure
  const h = harness({ server, xhr });

  await h.controller.start(fakeFile());
  await settle(40);

  assert.equal(h.controller.getSnapshot().phase, 'failed');
  // The single lifecycle is aborted, so a fresh upload can begin without dead-ending.
  assert.equal(server.countOf('upload:abort'), 1);
  assert.equal(server.eventsOf('upload:abort')[0].mode, 'single');
});

/* ==========================================================================
 * Cancellation AUTHORITY: a resolved upload:abort is not a successful cancel
 * unless ack.ok === true. A refused ack keeps token/File/recovery.
 * ========================================================================== */

test('a REFUSED multipart abort keeps authority; a retry with the SAME token cancels', async () => {
  let abortCalls = 0;
  const server = fakeServer({
    // The first abort is rate-limited (session still active); the retry succeeds.
    'upload:abort': () => (++abortCalls === 1 ? { ok: false, error: 'RATE_LIMITED', retryAfterMs: 50 } : { ok: true }),
  });
  const xhr = fakeXhrFactory(() => null); // stays in flight
  const h = harness({ server, xhr });

  void h.controller.start(fakeFile());
  await settle(20);
  assert.ok(h.store.keys().length > 0, 'persisted while uploading');

  // First cancel is REFUSED — the client must NOT enter cancelled or drop anything.
  await h.controller.cancel();
  await settle();
  let snap = h.controller.getSnapshot();
  assert.notEqual(snap.phase, 'cancelled', 'a refused abort must not report cancelled');
  assert.equal(snap.phase, 'cancelling');
  assert.equal(snap.cleanupPending, true, 'the cleanup is unresolved');
  assert.equal(snap.cleanupError, 'RATE_LIMITED', 'the refusal is the cleanup error, not the upload error');
  assert.ok(h.store.keys().length > 0, 'persistence retained on a refused abort');
  assert.equal(h.controller.debug().hasToken, true, 'the token is retained');

  // Retry the cancel — the SAME token, now accepted → a real cancellation.
  await h.controller.cancel();
  await settle();
  snap = h.controller.getSnapshot();
  assert.equal(snap.phase, 'cancelled');
  assert.equal(h.store.keys().length, 0, 'released only after ok:true');
  assert.equal(h.controller.debug().hasToken, false, 'the token is released only now');
  const aborts = server.eventsOf('upload:abort');
  assert.equal(aborts.length, 2);
  assert.equal(aborts[0].token, aborts[1].token, 'the retry reused the same token');
});

test('a REFUSED single-shot abort ack does not enter cancelled and retains authority', async () => {
  const server = fakeServer({
    'upload:intent': () => ({
      ok: true,
      mode: 'single',
      token: 'st',
      key: 'rooms/ABC123/0123456789abcdef/movie.mp4',
      method: 'PUT',
      uploadUrl: 'https://bucket.invalid/put',
      expectedBytes: TOTAL,
    }),
    'upload:abort': () => ({ ok: false, error: 'WRONG_MEMBER' }),
  });
  const xhr = fakeXhrFactory(() => null); // in flight
  const h = harness({ server, xhr });

  void h.controller.start(fakeFile());
  await settle(20);
  await h.controller.cancel();
  await settle();

  const snap = h.controller.getSnapshot();
  assert.notEqual(snap.phase, 'cancelled', 'a refused single abort must not report cancelled');
  assert.equal(snap.cleanupPending, true);
  assert.equal(snap.cleanupError, 'WRONG_MEMBER');
  assert.equal(h.controller.debug().hasToken, true, 'authority retained');
  assert.equal(server.eventsOf('upload:abort')[0].mode, 'single');
});

test('an abort ack {ok:true, cleanupPending:true} cancels and releases the token', async () => {
  const server = fakeServer({ 'upload:abort': () => ({ ok: true, cleanupPending: true }) });
  const xhr = fakeXhrFactory(() => null);
  const h = harness({ server, xhr });

  void h.controller.start(fakeFile());
  await settle(20);
  await h.controller.cancel();
  await settle();

  assert.equal(h.controller.getSnapshot().phase, 'cancelled');
  assert.equal(h.controller.debug().hasToken, false);
  assert.equal(h.store.keys().length, 0, 'cleanupPending is a successful terminal cancel');
});

test('an abort that THROWS leaves CANCEL_FAILED and keeps the token', async () => {
  const server = fakeServer({
    'upload:abort': () => {
      throw new Error('unreachable');
    },
  });
  const xhr = fakeXhrFactory(() => null);
  const h = harness({ server, xhr });

  void h.controller.start(fakeFile());
  await settle(20);
  await h.controller.cancel();
  await settle();

  const snap = h.controller.getSnapshot();
  assert.equal(snap.cleanupPending, true);
  assert.equal(snap.cleanupError, 'CANCEL_FAILED');
  assert.notEqual(snap.phase, 'cancelled');
  assert.equal(h.controller.debug().hasToken, true, 'token retained on a throw');
  assert.ok(h.store.keys().length > 0, 'persistence retained on a throw');
});

test('a client-origin terminal abort that is REFUSED does not silently discard the token', async () => {
  // SIZE_MISMATCH (client-terminal) fires a client-origin abort; the server refuses
  // it. fail() must NOT null the token on the resolved {ok:false}.
  let abortCalls = 0;
  const server = fakeServer({
    'upload:complete': () => ({ ok: false, error: 'SIZE_MISMATCH' }),
    'upload:abort': () => {
      abortCalls += 1;
      return { ok: false, error: 'RATE_LIMITED' };
    },
  });
  const h = harness({ server, xhr: succeedAll(server) });

  await h.controller.start(fakeFile());
  await settle(120);

  const snap = h.controller.getSnapshot();
  assert.equal(snap.phase, 'failed');
  assert.equal(snap.error, 'SIZE_MISMATCH');
  assert.equal(abortCalls, 1, 'a client-origin terminal fired the abort');
  assert.equal(h.controller.debug().hasToken, true, 'a refused abort must not silently drop the token');
});

/* ==========================================================================
 * Client-origin terminal failure CLEANUP (8th review): a terminal failure keeps
 * File/persistence and blocks a fresh start until upload:abort is confirmed.
 * ========================================================================== */

test('a client-terminal failure keeps File/persistence, blocks fresh start, then cleans up on retry', async () => {
  let abortCalls = 0;
  let completeCalls = 0;
  const source = { type: 'url', value: 'https://cdn.invalid/movie.mp4', label: 'x', quality: 'Uploaded' };
  const server = fakeServer({
    // First completion fails terminally (client-terminal SIZE_MISMATCH); the
    // retried upload's completion succeeds.
    'upload:complete': (payload) =>
      ++completeCalls === 1
        ? { ok: false, error: 'SIZE_MISMATCH' }
        : { ok: true, source: { ...source, label: payload.label }, key: 'k', expectedBytes: TOTAL },
    // First abort refused; the retry succeeds.
    'upload:abort': () => (++abortCalls === 1 ? { ok: false, error: 'RATE_LIMITED', retryAfterMs: 50 } : { ok: true }),
  });
  const file = fakeFile();
  const h = harness({ server, xhr: succeedAll(server) });

  await h.controller.start(file);
  await settle(120);

  // The terminal failure enters cleanup; the refused abort retains EVERYTHING and
  // keeps the original failure separate from the cleanup error.
  let snap = h.controller.getSnapshot();
  assert.equal(snap.phase, 'failed');
  assert.equal(snap.error, 'SIZE_MISMATCH', 'the original failure is preserved');
  assert.equal(snap.cleanupPending, true, 'cleanup is unresolved');
  assert.equal(snap.cleanupError, 'RATE_LIMITED', 'the abort refusal is a SEPARATE cleanup error');
  assert.equal(snap.retryable, false);
  assert.equal(h.controller.debug().hasToken, true, 'token retained');
  assert.ok(h.store.keys().length > 0, 'persistence retained');
  const intentsAfterFailure = server.countOf('upload:intent');

  // A fresh start is BLOCKED while cleanup is unresolved: no new intent.
  await h.controller.start(fakeFile());
  await settle(20);
  assert.equal(server.countOf('upload:intent'), intentsAfterFailure, 'start() sends no intent while cleanup is unresolved');
  assert.equal(h.controller.getSnapshot().cleanupPending, true, 'still cleaning up');
  assert.equal(h.controller.debug().hasToken, true, 'the old token is not overwritten');

  // Retry the cancellation (same token) — now accepted → authority released.
  await h.controller.cancel();
  await settle();
  snap = h.controller.getSnapshot();
  assert.equal(snap.cleanupPending, false, 'cleanup resolved');
  assert.equal(h.controller.debug().hasToken, false, 'old token released only after ok:true');
  assert.equal(h.store.keys().length, 0, 'persistence cleared');
  const aborts = server.eventsOf('upload:abort');
  assert.equal(aborts[0].token, aborts[1].token, 'the retry used the same token');

  // The SAME File may now start a fresh upload — no UPLOAD_ALREADY_ACTIVE.
  await h.controller.start(file);
  await settle(120);
  assert.equal(server.countOf('upload:intent'), intentsAfterFailure + 1, 'a new intent is sent after cleanup');
  assert.equal(h.controller.getSnapshot().phase, 'completed', h.controller.getSnapshot().error);
});

test('a client-terminal failure whose abort THROWS retains authority and recovery', async () => {
  const server = fakeServer({
    'upload:complete': () => ({ ok: false, error: 'SIZE_MISMATCH' }),
    'upload:abort': () => {
      throw new Error('unreachable');
    },
  });
  const h = harness({ server, xhr: succeedAll(server) });

  await h.controller.start(fakeFile());
  await settle(120);

  const snap = h.controller.getSnapshot();
  assert.equal(snap.phase, 'failed');
  assert.equal(snap.error, 'SIZE_MISMATCH');
  assert.equal(snap.cleanupPending, true);
  assert.equal(snap.cleanupError, 'CANCEL_FAILED');
  assert.equal(h.controller.debug().hasToken, true, 'token retained on a throw');
  assert.ok(h.store.keys().length > 0, 'persistence retained on a throw');
});

test('destroy preserves the recoverable session rather than orphaning it on a refused abort (Option B)', async () => {
  const server = fakeServer({ 'upload:abort': () => ({ ok: false, error: 'RATE_LIMITED' }) });
  const xhr = fakeXhrFactory(() => null); // in flight
  const store = fakeStore();
  const h = harness({ server, xhr, store });

  void h.controller.start(fakeFile());
  await settle(20);
  assert.ok(store.keys().length > 0, 'a resumable session is persisted while running');
  const abortsBefore = server.countOf('upload:abort');

  h.controller.destroy();
  await settle();

  /*
   * Option B: disposal fires NO abort (a refused ack would otherwise strand the
   * session while discarding the client's only authority) and KEEPS the persisted
   * recovery. The session is recovered on a remount, or reaped SERVER-side by
   * departRoom on a true departure (server.js takeForMember) — never silently
   * orphaned.
   */
  assert.equal(server.countOf('upload:abort'), abortsBefore, 'destroy fires no abort');
  assert.ok(store.keys().length > 0, 'the persisted recovery is retained → recoverable, not orphaned');
});

/* ==========================================================================
 * SINGLE-SHOT lifecycle recovery across destroy/remount (9th review).
 * ========================================================================== */

const SINGLE_INTENT = {
  ok: true,
  mode: 'single',
  token: 'st-orig',
  key: 'rooms/ABC123/0123456789abcdef/movie.mp4',
  method: 'PUT',
  uploadUrl: 'https://bucket.invalid/put',
  expectedBytes: TOTAL,
  expiresAt: 1_700_000_000_000 + 3_600_000, // > the harness wallClock, so not expired
};
const singleKey = (store) => store.keys().find((k) => k.includes('upload.single.'));

test('an active single-shot destroy leaves no XHR but KEEPS the persisted cleanup token', async () => {
  const server = fakeServer({ 'upload:intent': () => ({ ...SINGLE_INTENT }) });
  const store = fakeStore();
  const h = harness({ server, xhr: fakeXhrFactory(() => null), store }); // PUT stays in flight

  void h.controller.start(fakeFile());
  await settle(20);
  assert.equal(h.controller.getSnapshot().mode, 'single');
  assert.equal(h.controller.debug().hasToken, true);
  assert.ok(singleKey(store), 'the single cleanup record is persisted at intent');

  const abortsBefore = server.countOf('upload:abort');
  h.controller.destroy();
  await settle();

  assert.equal(h.controller.debug().activeXhrs, 0, 'the local PUT is aborted on destroy');
  assert.equal(server.countOf('upload:abort'), abortsBefore, 'destroy fires no abort');
  assert.ok(singleKey(store), 'the cleanup token survives destroy — not orphaned');
});

test('a new controller discovers a leftover single cleanup and aborts it with the ORIGINAL token', async () => {
  const store = fakeStore();
  // A prior controller starts a single upload and is destroyed mid-flight.
  const h1 = harness({ server: fakeServer({ 'upload:intent': () => ({ ...SINGLE_INTENT }) }), xhr: fakeXhrFactory(() => null), store });
  void h1.controller.start(fakeFile());
  await settle(20);
  h1.controller.destroy();
  await settle();
  assert.ok(singleKey(store), 'the record survives the destroy');

  // A NEW controller mounts with the same store: it must clean up, not offer a chooser.
  const server2 = fakeServer();
  const h2 = harness({ server: server2, xhr: succeedAll(server2), store });
  await settle();

  assert.equal(server2.countOf('upload:intent'), 0, 'no new intent — this is lifecycle cleanup, not byte transfer');
  assert.equal(server2.countOf('upload:abort'), 1, 'the leftover session is aborted');
  const abort = server2.eventsOf('upload:abort')[0];
  assert.equal(abort.mode, 'single');
  assert.equal(abort.token, 'st-orig', 'the ORIGINAL token closes the session');
  // ok:true (default) clears the record and frees a fresh upload.
  assert.ok(!singleKey(store), 'the record is cleared on ok:true');
  assert.equal(h2.controller.getSnapshot().cleanupPending, false);
});

test('a refused single cleanup retains the record/token and blocks a fresh start; retry recovers', async () => {
  const store = fakeStore();
  const h1 = harness({ server: fakeServer({ 'upload:intent': () => ({ ...SINGLE_INTENT }) }), xhr: fakeXhrFactory(() => null), store });
  void h1.controller.start(fakeFile());
  await settle(20);
  h1.controller.destroy();
  await settle();

  // The first cleanup abort is refused; the retry succeeds.
  let abortCalls = 0;
  const server2 = fakeServer({ 'upload:abort': () => (++abortCalls === 1 ? { ok: false, error: 'RATE_LIMITED' } : { ok: true }) });
  const h2 = harness({ server: server2, xhr: succeedAll(server2), store });
  await settle();

  // Refused → record + token retained, cleanupPending, no fresh start.
  let snap = h2.controller.getSnapshot();
  assert.equal(snap.cleanupPending, true);
  assert.equal(snap.cleanupError, 'RATE_LIMITED');
  assert.equal(h2.controller.debug().hasToken, true);
  assert.ok(singleKey(store), 'the record is retained on a refused cleanup');
  const intentsBefore = server2.countOf('upload:intent');
  await h2.controller.start(fakeFile());
  await settle(20);
  assert.equal(server2.countOf('upload:intent'), intentsBefore, 'a fresh start is blocked while cleanup is unresolved');

  // Retry the cancellation — the SAME token, now accepted.
  await h2.controller.cancel();
  await settle();
  const aborts = server2.eventsOf('upload:abort');
  assert.equal(aborts[0].token, aborts[1].token, 'the retry used the same token');
  assert.equal(h2.controller.getSnapshot().cleanupPending, false);
  assert.ok(!singleKey(store), 'the record is removed on ok:true');

  // A fresh upload now succeeds.
  await h2.controller.start(fakeFile());
  await settle(120);
  assert.equal(h2.controller.getSnapshot().phase, 'completed', h2.controller.getSnapshot().error);
});

test('a completed single-shot upload leaves no stale cleanup record', async () => {
  const server = fakeServer({ 'upload:intent': () => ({ ...SINGLE_INTENT }) });
  const store = fakeStore();
  const xhr = fakeXhrFactory((x) => ({ progressTo: x.body.size, etag: '"single"' }));
  const h = harness({ server, xhr, store });

  await h.controller.start(fakeFile());
  await settle(40);
  assert.equal(h.controller.getSnapshot().phase, 'completed');
  assert.ok(!singleKey(store), 'no stale single cleanup record after a clean completion');
});

test('retry resumes the SAME session — no second upload:intent', async () => {
  // Part 2 fails the first time round and succeeds afterwards.
  let failPart2 = true;
  const server = fakeServer();
  const xhr = fakeXhrFactory((x) => {
    const partNumber = Number(x.url.match(/partNumber=(\d+)/)?.[1]);
    if (partNumber === 2 && failPart2) return { network: true };
    return { status: 200 };
  });
  const h = harness({ server, xhr, random: () => 0 });

  await h.controller.start(fakeFile());
  await settle(200);
  assert.equal(h.controller.getSnapshot().phase, 'failed');
  assert.equal(h.controller.getSnapshot().retryable, true);
  const intentsBefore = server.countOf('upload:intent');

  failPart2 = false;
  await h.controller.retry();
  await settle(200);

  assert.equal(server.countOf('upload:intent'), intentsBefore, 'retry must NOT mint a new intent');
  assert.equal(h.controller.getSnapshot().phase, 'completed');
  assert.equal(h.completedWith.length, 1);
});

/* ==========================================================================
 * Item 6: cancelling a timer settles its sleeper.
 * ========================================================================== */

test('pause during a retry backoff settles the sleeper and drains every worker', async () => {
  /*
   * The leak this closes: a worker awaiting `sleep(backoff)` was left pending
   * forever when `clearTimers()` dropped the handle without resolving the
   * Promise, so the worker never reached its generation check and never exited.
   */
  const server = fakeServer();
  const timers = fakeTimers();
  // Every part fails with a retryable network error, so all workers end up in a
  // backoff sleep at some point.
  const xhr = fakeXhrFactory(() => ({ network: true }));
  const h = harness({ server, xhr, timers, random: () => 0.5 });

  void h.controller.start(fakeFile());
  await settle(20);
  h.controller.pause();
  await settle(60);

  const debug = h.controller.debug();
  assert.equal(debug.activeSleepers, 0, 'no sleeper may remain pending after a pause');
  assert.equal(debug.activeWorkers, 0, 'no worker may remain alive after a pause');
  assert.equal(debug.pendingTimers, 0, 'no timer may remain armed');
  assert.equal(debug.activeXhrs, 0);
  assert.equal(debug.activeSlices, 0);
});

test('50 pause/offline cycles leave no sleepers, workers, timers, XHRs or slices', async () => {
  const server = fakeServer();
  const timers = fakeTimers();
  const xhr = fakeXhrFactory(() => ({ network: true }));
  const h = harness({ server, xhr, timers, random: () => 0.5 });

  void h.controller.start(fakeFile());
  await settle(20);

  for (let i = 0; i < 50; i += 1) {
    if (i % 2 === 0) {
      h.controller.pause();
      await settle(6);
      void h.controller.resume();
    } else {
      h.setOnline(false);
      await settle(6);
      h.setOnline(true);
    }
    await settle(6);
  }

  h.controller.pause();
  await settle(80);

  const debug = h.controller.debug();
  assert.equal(debug.activeSleepers, 0, 'zero sleepers');
  assert.equal(debug.activeWorkers, 0, 'zero workers');
  assert.equal(debug.pendingTimers, 0, 'zero timers');
  assert.equal(debug.activeXhrs, 0, 'zero active XHRs');
  assert.equal(debug.activeSlices, 0, 'zero active slices');
  // The structural memory bound held throughout.
  assert.ok(debug.maxConcurrentSlices <= 3, `maxConcurrentSlices ${debug.maxConcurrentSlices}`);
});

test('cancel and destroy also settle every sleeper', async () => {
  for (const teardown of ['cancel', 'destroy']) {
    const server = fakeServer();
    const timers = fakeTimers();
    const xhr = fakeXhrFactory(() => ({ network: true }));
    const h = harness({ server, xhr, timers, random: () => 0.5 });

    void h.controller.start(fakeFile());
    await settle(20);

    if (teardown === 'cancel') await h.controller.cancel();
    else h.controller.destroy();
    await settle(60);

    const debug = h.controller.debug();
    assert.equal(debug.activeSleepers, 0, `${teardown}: sleepers`);
    assert.equal(debug.activeWorkers, 0, `${teardown}: workers`);
    assert.equal(debug.pendingTimers, 0, `${teardown}: timers`);
  }
});
