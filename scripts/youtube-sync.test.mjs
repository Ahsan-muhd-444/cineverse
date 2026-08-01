/**
 * Unit tests for native-YouTube-control sync helpers (src/components/room/youtubeSync.ts).
 *
 * These prove the echo-suppression and seek-detection logic that lets YouTube's
 * OWN controls drive the room without (a) bouncing the room's own programmatic
 * commands back as fresh local actions, or (b) mistaking normal playback for a
 * seek. The actual iframe wiring is verified manually in a visible browser.
 *
 * Run: node --test --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/youtube-sync.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldEmitNativeEvent, isNativeSeek, seekDebounceOk } from '../src/components/room/youtubeSync.ts';
import { YOUTUBE_PLAYER_VARS, YOUTUBE_IFRAME_ALLOW } from '../src/components/room/youtubePlayerVars.ts';

/* ---------------- fullscreen-ownership flags ----------------
   These are load-bearing: a silent regression here traps a viewer in a
   fullscreen they cannot exit, which is invisible until it happens. */

test('YouTube keeps its own visible controls', () => {
  assert.equal(YOUTUBE_PLAYER_VARS.controls, 1);
});

test('YouTube fullscreen BUTTON is hidden (fs: 0)', () => {
  assert.equal(YOUTUBE_PLAYER_VARS.fs, 0);
});

test('YouTube internal keyboard shortcuts are disabled (disablekb: 1)', () => {
  // Without this, F inside the focused iframe made YouTube attempt a fullscreen
  // the browser then blocked — a visible glitch rather than a clean no-op.
  assert.equal(YOUTUBE_PLAYER_VARS.disablekb, 1);
});

test('the iframe allow-list never grants fullscreen', () => {
  // The capability half of the fix: `fs`/`disablekb` stop YouTube ASKING, this
  // stops the browser GRANTING. Both are required.
  assert.ok(!/fullscreen/i.test(YOUTUBE_IFRAME_ALLOW), YOUTUBE_IFRAME_ALLOW);
});

test('the iframe allow-list keeps the permissions playback needs', () => {
  for (const feature of ['autoplay', 'encrypted-media']) {
    assert.ok(YOUTUBE_IFRAME_ALLOW.includes(feature), feature);
  }
});

test('the player vars object is frozen against accidental mutation', () => {
  assert.equal(Object.isFrozen(YOUTUBE_PLAYER_VARS), true);
});

/* ---------------- echo suppression ---------------- */

test('a local native action emits when nothing is applying and no suppression window', () => {
  assert.equal(shouldEmitNativeEvent({ isApplying: false, suppressUntil: 0, now: 1000 }), true);
});

test('a programmatic command does NOT echo: within the suppression window', () => {
  // handle.play() opened a window until 1800; the resulting native PLAYING at
  // 1200 must not be re-emitted to the room.
  assert.equal(shouldEmitNativeEvent({ isApplying: false, suppressUntil: 1800, now: 1200 }), false);
});

test('a remote command being applied does NOT echo (isApplying true)', () => {
  assert.equal(shouldEmitNativeEvent({ isApplying: true, suppressUntil: 0, now: 5000 }), false);
});

test('emits again once the suppression window has passed', () => {
  assert.equal(shouldEmitNativeEvent({ isApplying: false, suppressUntil: 1800, now: 1801 }), true);
});

/* ---------------- seek detection ---------------- */

test('normal playback progression is not a seek', () => {
  // ~0.5s advance between 500ms polls at 1x (or ~1s at 2x) is under the threshold.
  assert.equal(isNativeSeek(60.0, 60.5, 2), false);
  assert.equal(isNativeSeek(60.0, 61.0, 2), false);
});

test('a large forward jump is a seek', () => {
  assert.equal(isNativeSeek(60, 300, 2), true);
});

test('a large backward jump (rewind) is a seek', () => {
  assert.equal(isNativeSeek(300, 60, 2), true);
});

test('non-finite times are never a seek', () => {
  assert.equal(isNativeSeek(NaN, 60, 2), false);
  assert.equal(isNativeSeek(60, Infinity, 2), false);
});

/* ---------------- seek debounce ---------------- */

test('seek debounce blocks a second emit inside the window', () => {
  assert.equal(seekDebounceOk(1000, 1300, 700), false); // 300ms < 700ms
});

test('seek debounce allows an emit once the window has passed', () => {
  assert.equal(seekDebounceOk(1000, 1750, 700), true); // 750ms >= 700ms
});
