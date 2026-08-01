/**
 * Unit tests for player fullscreen ownership + idle-chrome rules
 * (src/components/room/fullscreen.ts).
 *
 * The important invariant: CineVerse only ever believes it is in fullscreen
 * when ITS OWN shell is the fullscreen element. A cross-origin YouTube iframe
 * holding fullscreen must be detected as foreign (and backed out of), because
 * the parent cannot render an exit button over it.
 *
 * Run:  node --test --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/fullscreen.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isShellFullscreen,
  isForeignFullscreen,
  shouldShowFullscreenChrome,
  shouldDisableIframePointerEvents,
  FULLSCREEN_CHROME_IDLE_MS,
} from '../src/components/room/fullscreen.ts';

// Stand-ins for DOM nodes — identity is all these predicates use.
const shell = { tag: 'shell' };
const iframe = { tag: 'iframe' };

/* ---------------- ownership ---------------- */

test('our shell in fullscreen is recognised as ours', () => {
  assert.equal(isShellFullscreen(shell, shell), true);
  assert.equal(isForeignFullscreen(shell, shell), false);
});

test('a YouTube iframe in fullscreen is NOT ours (the trap case)', () => {
  // This is the bug: treating any fullscreenElement as ours left the app
  // rendering an exit button that the iframe's fullscreen covered.
  assert.equal(isShellFullscreen(shell, iframe), false);
  assert.equal(isForeignFullscreen(shell, iframe), true);
});

test('no fullscreen element means neither ours nor foreign', () => {
  assert.equal(isShellFullscreen(shell, null), false);
  assert.equal(isForeignFullscreen(shell, null), false);
});

test('a missing shell ref never claims ownership', () => {
  assert.equal(isShellFullscreen(null, iframe), false);
  // …and with no shell of our own, anything in fullscreen is foreign.
  assert.equal(isForeignFullscreen(null, iframe), true);
});

/* ---------------- idle chrome ---------------- */

test('chrome is always shown outside fullscreen', () => {
  // Normal (windowed) control rules apply there, not the idle timer.
  assert.equal(shouldShowFullscreenChrome({ fullscreen: false, lastPointerAt: 0, now: 999999 }), true);
});

test('chrome stays visible right after pointer movement', () => {
  assert.equal(shouldShowFullscreenChrome({ fullscreen: true, lastPointerAt: 1000, now: 1200 }), true);
});

test('chrome hides once the pointer has been still past the idle window', () => {
  const now = 1000 + FULLSCREEN_CHROME_IDLE_MS + 1;
  assert.equal(shouldShowFullscreenChrome({ fullscreen: true, lastPointerAt: 1000, now }), false);
});

test('the idle boundary hides the chrome', () => {
  assert.equal(
    shouldShowFullscreenChrome({ fullscreen: true, lastPointerAt: 1000, now: 1000 + FULLSCREEN_CHROME_IDLE_MS }),
    false,
  );
});

test('the idle window is configurable', () => {
  assert.equal(shouldShowFullscreenChrome({ fullscreen: true, lastPointerAt: 0, now: 400, idleMs: 500 }), true);
  assert.equal(shouldShowFullscreenChrome({ fullscreen: true, lastPointerAt: 0, now: 600, idleMs: 500 }), false);
});

/* ---------------- iframe pointer-events ---------------- */

test('the iframe stops intercepting pointers only when fullscreen chrome is idle', () => {
  assert.equal(
    shouldDisableIframePointerEvents({ isYouTube: true, fullscreen: true, chromeVisible: false }),
    true,
    'idle fullscreen: let the parent hide the cursor and see the next move',
  );
});

test('the iframe stays interactive whenever the chrome is visible', () => {
  assert.equal(shouldDisableIframePointerEvents({ isYouTube: true, fullscreen: true, chromeVisible: true }), false);
});

test('windowed YouTube controls are NEVER disabled', () => {
  // The whole point of keeping YouTube native: its controls must stay clickable.
  assert.equal(shouldDisableIframePointerEvents({ isYouTube: true, fullscreen: false, chromeVisible: false }), false);
  assert.equal(shouldDisableIframePointerEvents({ isYouTube: true, fullscreen: false, chromeVisible: true }), false);
});

test('non-YouTube sources never disable pointer events', () => {
  assert.equal(shouldDisableIframePointerEvents({ isYouTube: false, fullscreen: true, chromeVisible: false }), false);
});
