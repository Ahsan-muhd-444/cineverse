/**
 * Unit tests for rate-aware playhead projection (src/hooks/playbackProjection.ts).
 *
 * Pure logic — these do not mount the sync hook. `useSyncedPlayback` calls
 * `projectPlaybackState(state, serverNow())` in both drift correction and
 * resync(), so proving the helper proves the projection those paths use.
 *
 * Run:  node --test --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/playback-projection.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRate,
  projectPlaybackState,
  resolveDisplayedPosition,
  shouldPromptPlaybackGesture,
  shouldShowHtml5Loading,
} from '../src/hooks/playbackProjection.ts';

// serverTime and now are both on the server timeline (seconds -> ms).
const at = (seconds) => seconds * 1000;

test('playing at 2x for 5 seconds projects +10 seconds', () => {
  const state = { time: 100, playing: true, rate: 2, serverTime: at(1000) };
  assert.equal(projectPlaybackState(state, at(1005)), 110);
});

test('playing at 0.5x for 6 seconds projects +3 seconds', () => {
  const state = { time: 100, playing: true, rate: 0.5, serverTime: at(1000) };
  assert.equal(projectPlaybackState(state, at(1006)), 103);
});

test('playing at 1x for 4 seconds projects +4 seconds', () => {
  const state = { time: 20, playing: true, rate: 1, serverTime: at(500) };
  assert.equal(projectPlaybackState(state, at(504)), 24);
});

test('paused state does not advance regardless of elapsed time or rate', () => {
  const state = { time: 100, playing: false, rate: 2, serverTime: at(1000) };
  assert.equal(projectPlaybackState(state, at(1010)), 100);
});

test('a missing rate defaults to 1x', () => {
  const state = { time: 100, playing: true, serverTime: at(1000) };
  assert.equal(projectPlaybackState(state, at(1005)), 105);
});

test('an invalid rate (0, negative, NaN) defaults to 1x', () => {
  for (const rate of [0, -2, Number.NaN, undefined, null]) {
    const state = { time: 10, playing: true, rate, serverTime: at(1000) };
    assert.equal(projectPlaybackState(state, at(1002)), 12, `rate=${String(rate)}`);
  }
});

test('projection never goes backwards if now precedes serverTime', () => {
  const state = { time: 100, playing: true, rate: 2, serverTime: at(1000) };
  assert.equal(projectPlaybackState(state, at(999)), 100); // elapsed clamped to 0
});

test('normalizeRate: valid positive stays, everything else becomes 1', () => {
  assert.equal(normalizeRate(2), 2);
  assert.equal(normalizeRate(0.5), 0.5);
  assert.equal(normalizeRate(0), 1);
  assert.equal(normalizeRate(-1), 1);
  assert.equal(normalizeRate(Number.NaN), 1);
  assert.equal(normalizeRate(undefined), 1);
  assert.equal(normalizeRate(null), 1);
});

/* ---------------- seek-hold display guard ---------------- */

test('seek hold: shows the target while the engine still reports the old time', () => {
  const hold = { target: 300, until: 5000 };
  // Engine still at 60s (pre-seek) shortly after the drag: display 300.
  assert.deepEqual(resolveDisplayedPosition(hold, 60, 4000), { position: 300, holding: true });
});

test('seek hold: releases once the engine lands near the target', () => {
  const hold = { target: 300, until: 5000 };
  assert.deepEqual(resolveDisplayedPosition(hold, 299.6, 4000), { position: 299.6, holding: false });
});

test('seek hold: expires after the window even if the engine never caught up', () => {
  const hold = { target: 300, until: 5000 };
  assert.deepEqual(resolveDisplayedPosition(hold, 60, 5001), { position: 60, holding: false });
});

test('seek hold: no hold means the engine time is shown as-is', () => {
  assert.deepEqual(resolveDisplayedPosition(null, 42, 1000), { position: 42, holding: false });
});

/* ---------------- blocked-autoplay detection ---------------- */

test('blocked autoplay: ready but paused after a play attempt → prompt for gesture', () => {
  assert.equal(shouldPromptPlaybackGesture(true, true), true);
});

test('blocked autoplay: ready and playing → no prompt', () => {
  assert.equal(shouldPromptPlaybackGesture(true, false), false);
});

test('blocked autoplay: not yet ready (still starting up) → no prompt', () => {
  // A never-ready engine is loading, not blocked — surfacing the overlay here
  // would false-fire on slow networks.
  assert.equal(shouldPromptPlaybackGesture(false, true), false);
  assert.equal(shouldPromptPlaybackGesture(false, false), false);
});

/* ---------------- HTML5 loading overlay ---------------- */

const loadingCase = (o) =>
  shouldShowHtml5Loading({ hasSource: true, ready: false, failed: false, waiting: false, playing: false, ...o });

test('html5 loading: a set source that is not ready yet shows the spinner', () => {
  assert.equal(loadingCase({ ready: false }), true);
});

test('html5 loading: a ready video PAUSED with a stuck waiting flag does NOT spin', () => {
  // The regression: a paused first frame with waiting=true must never blur
  // forever or hide the controls.
  assert.equal(loadingCase({ ready: true, waiting: true, playing: false }), false);
});

test('html5 loading: a ready video actively PLAYING but buffering does spin', () => {
  assert.equal(loadingCase({ ready: true, waiting: true, playing: true }), true);
});

test('html5 loading: a ready, settled video shows no spinner', () => {
  assert.equal(loadingCase({ ready: true, waiting: false, playing: true }), false);
  assert.equal(loadingCase({ ready: true, waiting: false, playing: false }), false);
});

test('html5 loading: a failed source never shows the spinner (its error card shows)', () => {
  assert.equal(loadingCase({ failed: true, ready: false }), false);
  assert.equal(loadingCase({ failed: true, ready: true, waiting: true, playing: true }), false);
});

test('html5 loading: no source, no spinner', () => {
  assert.equal(loadingCase({ hasSource: false, ready: false }), false);
});
