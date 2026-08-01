/**
 * Unit tests for the retry-safe YouTube IFrame API loader
 * (src/components/room/youtubeApi.ts).
 *
 * The bug these guard against: a module-level promise that could stay pending
 * forever (missed global callback, cached script, hot reload) poisoned every
 * later mount, so refreshing a room onto an existing YouTube source failed
 * permanently. Environment + timers are injected, so the state machine is
 * exercised with no browser, no network and no real waiting.
 *
 * Run:  node --test --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/youtube-api.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadYouTubeApi,
  resetYouTubeApiLoader,
  isYouTubeApiReady,
  hasUsableYouTubeApi,
  YOUTUBE_SCRIPT_ID,
  YOUTUBE_API_ERROR,
  YOUTUBE_API_TIMEOUT,
} from '../src/components/room/youtubeApi.ts';

/** A fake window/document/timer environment we can drive by hand. */
function makeEnv() {
  const scripts = [];
  const timeouts = [];
  const intervals = [];
  const win = {};

  const doc = {
    getElementById: (id) => scripts.find((s) => s.id === id) || null,
    createElement: () => ({
      id: '',
      src: '',
      async: false,
      onerror: null,
      remove() {
        const i = scripts.indexOf(this);
        if (i >= 0) scripts.splice(i, 1);
      },
    }),
    head: { appendChild: (el) => scripts.push(el) },
  };

  const env = {
    win,
    doc,
    setTimeout: (fn) => {
      const h = { fn };
      timeouts.push(h);
      return h;
    },
    clearTimeout: (h) => {
      const i = timeouts.indexOf(h);
      if (i >= 0) timeouts.splice(i, 1);
    },
    setInterval: (fn) => {
      const h = { fn };
      intervals.push(h);
      return h;
    },
    clearInterval: (h) => {
      const i = intervals.indexOf(h);
      if (i >= 0) intervals.splice(i, 1);
    },
  };

  return {
    env,
    win,
    scripts,
    /** Pretend the API script finished loading and defined YT. */
    defineApi: () => {
      win.YT = { Player: function Player() {} };
    },
    fireTimeout: () => timeouts.slice().forEach((t) => t.fn()),
    firePoll: () => intervals.slice().forEach((t) => t.fn()),
    fireScriptError: () => scripts.slice().forEach((s) => s.onerror?.()),
    counts: () => ({ timeouts: timeouts.length, intervals: intervals.length }),
  };
}

// The loader caches module-level state, so every test starts from clean.
test.beforeEach(() => resetYouTubeApiLoader({ win: {}, doc: { getElementById: () => null } }));

/* ---------------- post-load readiness guard ---------------- */

test('hasUsableYouTubeApi only accepts a window with a real YT.Player', () => {
  assert.equal(hasUsableYouTubeApi({ YT: { Player: function () {} } }), true);
  // Every shape the engine must treat as "not usable" and therefore RETRYABLE,
  // rather than silently returning and hanging on "Loading YouTube…".
  assert.equal(hasUsableYouTubeApi({ YT: {} }), false, 'YT present but no Player');
  assert.equal(hasUsableYouTubeApi({}), false);
  assert.equal(hasUsableYouTubeApi(null), false);
  assert.equal(hasUsableYouTubeApi(undefined), false);
});

test('the API can vanish between the loader resolving and its use', async () => {
  // This is the exact race the engine now guards: the loader legitimately
  // resolves, but the global is gone by the time the .then() microtask runs.
  const h = makeEnv();
  const p = loadYouTubeApi(h.env);
  h.defineApi();
  h.firePoll();
  await p; // loader resolved successfully…

  delete h.win.YT; // …and the global disappeared before player construction.

  assert.equal(
    hasUsableYouTubeApi(h.win),
    false,
    'the engine detects this and throws into the retryable catch instead of returning silently',
  );
});

/* ---------------- fast paths ---------------- */

test('resolves immediately when the API is already present', async () => {
  const h = makeEnv();
  h.defineApi();
  await loadYouTubeApi(h.env); // must not throw or hang
  assert.equal(h.scripts.length, 0, 'no script needed when YT already exists');
  assert.equal(isYouTubeApiReady(h.env), true);
});

test('concurrent callers share ONE promise and ONE script', async () => {
  const h = makeEnv();
  const a = loadYouTubeApi(h.env);
  const b = loadYouTubeApi(h.env);
  assert.equal(a, b, 'same promise instance is reused');
  assert.equal(h.scripts.length, 1, 'exactly one script appended');
  h.defineApi();
  h.firePoll();
  await Promise.all([a, b]);
});

test('an existing script element is reused, never duplicated', async () => {
  const h = makeEnv();
  // Simulate a script tag already in the document (e.g. left by a prior mount).
  h.scripts.push({ id: YOUTUBE_SCRIPT_ID, src: 'x', onerror: null, remove() {} });
  const p = loadYouTubeApi(h.env);
  assert.equal(h.scripts.length, 1, 'reused the existing tag');
  h.defineApi();
  h.firePoll();
  await p;
});

/* ---------------- readiness mechanisms ---------------- */

test('the global onYouTubeIframeAPIReady callback resolves the loader', async () => {
  const h = makeEnv();
  const p = loadYouTubeApi(h.env);
  h.defineApi();
  h.win.onYouTubeIframeAPIReady();
  await p;
});

test('polling resolves even if the global callback never fires', async () => {
  // The real-world failure: cached script / hot reload / another library
  // overwriting the global means the callback is simply never called.
  const h = makeEnv();
  const p = loadYouTubeApi(h.env);
  h.defineApi();
  h.firePoll();
  await p; // resolves without ever invoking the callback
});

test('a pre-existing global callback is preserved, not clobbered', async () => {
  const h = makeEnv();
  let othersRan = 0;
  h.win.onYouTubeIframeAPIReady = () => {
    othersRan += 1;
  };
  const p = loadYouTubeApi(h.env);
  h.defineApi();
  h.win.onYouTubeIframeAPIReady();
  await p;
  assert.equal(othersRan, 1, "the other library's callback still ran");
});

test('a resolved promise is not reused after the API global disappears', async () => {
  // The cache must represent an IN-FLIGHT load only. A resolved promise kept
  // forever would let a later call skip past a YT.Player that has since vanished
  // (hot reload, another script replacing the global), leaving the engine stuck
  // on "loading" with no retryable error.
  const h = makeEnv();

  const first = loadYouTubeApi(h.env);
  h.defineApi();
  h.firePoll();
  await first;

  delete h.win.YT;

  const second = loadYouTubeApi(h.env);
  assert.notEqual(second, first, 'a genuinely new attempt, not the stale resolved promise');
  assert.equal(h.scripts.length, 1, 'the existing script is reused, not duplicated');

  // …and it must not resolve until the API is actually back.
  let resolved = false;
  second.then(() => {
    resolved = true;
  });
  await Promise.resolve();
  assert.equal(resolved, false, 'still pending while the API is unavailable');

  h.defineApi();
  h.firePoll();
  await second;
});

test('a successful load leaves no cached promise behind', async () => {
  const h = makeEnv();
  const first = loadYouTubeApi(h.env);
  h.defineApi();
  h.firePoll();
  await first;
  // With YT present the fast path returns a fresh resolved promise, never the
  // cached one.
  const second = loadYouTubeApi(h.env);
  assert.notEqual(second, first);
  await second;
  assert.equal(h.scripts.length, 1, 'no duplicate script from the fast path');
});

test('timers are cleaned up once the load succeeds', async () => {
  const h = makeEnv();
  const p = loadYouTubeApi(h.env);
  h.defineApi();
  h.firePoll();
  await p;
  assert.deepEqual(h.counts(), { timeouts: 0, intervals: 0 }, 'no leaked poll/timeout');
});

/* ---------------- failure + retry ---------------- */

test('a script error rejects AND clears the cached promise', async () => {
  const h = makeEnv();
  const p = loadYouTubeApi(h.env);
  h.fireScriptError();
  await assert.rejects(p, (e) => e.message === YOUTUBE_API_ERROR);
  // The stale script is gone, so a retry starts genuinely fresh.
  assert.equal(h.scripts.length, 0);
  const second = loadYouTubeApi(h.env);
  assert.notEqual(second, p, 'a NEW attempt, not the poisoned promise');
  h.defineApi();
  h.firePoll();
  await second;
});

test('a timeout rejects AND clears the cached promise', async () => {
  const h = makeEnv();
  const p = loadYouTubeApi(h.env);
  h.fireTimeout();
  await assert.rejects(p, (e) => e.message === YOUTUBE_API_TIMEOUT);
  const second = loadYouTubeApi(h.env);
  assert.notEqual(second, p, 'the hang did not poison later mounts');
  h.defineApi();
  h.firePoll();
  await second;
});

test('a second attempt after failure can succeed (the refresh case)', async () => {
  const h = makeEnv();
  const first = loadYouTubeApi(h.env);
  h.fireTimeout();
  await assert.rejects(first);
  // …user hits Retry / the page is refreshed:
  const retry = loadYouTubeApi(h.env);
  h.defineApi();
  h.firePoll();
  await retry;
  assert.equal(isYouTubeApiReady(h.env), true);
});

test('the loader wrapper is not left installed after a failure', async () => {
  const h = makeEnv();
  const original = () => {};
  h.win.onYouTubeIframeAPIReady = original;
  const p = loadYouTubeApi(h.env);
  h.fireTimeout();
  await assert.rejects(p);
  assert.equal(h.win.onYouTubeIframeAPIReady, original, 'previous callback restored');
});

/* ---------------- reset semantics ---------------- */

test('reset does NOT destroy an already healthy API', () => {
  const h = makeEnv();
  h.defineApi();
  h.scripts.push({ id: YOUTUBE_SCRIPT_ID, src: 'x', onerror: null, remove() {} });
  resetYouTubeApiLoader(h.env);
  assert.ok(h.win.YT?.Player, 'window.YT left intact');
  assert.equal(h.scripts.length, 1, 'working script left in place');
});

test('reset clears a pending load and removes the stale script', async () => {
  const h = makeEnv();
  const p = loadYouTubeApi(h.env);
  // Awaiting callers must settle rather than hang forever.
  const settled = assert.rejects(p);
  resetYouTubeApiLoader(h.env);
  await settled;
  assert.equal(h.scripts.length, 0, 'stale script removed while API unavailable');
  assert.deepEqual(h.counts(), { timeouts: 0, intervals: 0 }, 'timers cleaned up');
});

test('reset then load starts a brand-new attempt', async () => {
  const h = makeEnv();
  const first = loadYouTubeApi(h.env);
  const settled = assert.rejects(first);
  resetYouTubeApiLoader(h.env);
  await settled;
  const second = loadYouTubeApi(h.env);
  assert.notEqual(second, first);
  assert.equal(h.scripts.length, 1, 'a fresh script was appended');
  h.defineApi();
  h.firePoll();
  await second;
});
