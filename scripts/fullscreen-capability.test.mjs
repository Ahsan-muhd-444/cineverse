/**
 * Cross-browser fullscreen capability (src/components/room/fullscreen.ts).
 *
 * The bug being pinned down: the player called `element.requestFullscreen()` and
 * read `document.fullscreenElement` — unprefixed, unconditionally. On a laptop
 * that works; on an iPhone `Element.requestFullscreen` does not exist at all, so
 * the fullscreen button was a silent no-op. These are pure lookups over injected
 * fakes, so every platform shape can be asserted without a browser.
 *
 * Run: node --test --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/fullscreen-capability.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  enterVideoFullscreen,
  exitAnyFullscreen,
  fullscreenElementOf,
  requestElementFullscreen,
  supportsElementFullscreen,
  supportsVideoFullscreen,
} from '../src/components/room/fullscreen.ts';

import { YOUTUBE_PLAYER_VARS, YOUTUBE_IFRAME_ALLOW, youtubePlayerConfig } from '../src/components/room/youtubePlayerVars.ts';

/* ---------------- reading the current fullscreen element ---------------- */

test('fullscreenElementOf reads the standard property', () => {
  const el = { tag: 'shell' };
  assert.equal(fullscreenElementOf({ fullscreenElement: el }), el);
});

test('fullscreenElementOf falls back to the webkit property (Safari)', () => {
  const el = { tag: 'shell' };
  // Safari reports ONLY the prefixed property; reading the standard one alone
  // left the UI convinced it was never in fullscreen.
  assert.equal(fullscreenElementOf({ webkitFullscreenElement: el }), el);
});

test('fullscreenElementOf returns null when nothing is fullscreen', () => {
  assert.equal(fullscreenElementOf({ fullscreenElement: null }), null);
  assert.equal(fullscreenElementOf(null), null);
  assert.equal(fullscreenElementOf(undefined), null);
});

/* ---------------- element-level capability ---------------- */

test('supportsElementFullscreen is true for the standard API', () => {
  assert.equal(supportsElementFullscreen({ requestFullscreen: () => {} }), true);
});

test('supportsElementFullscreen is true for the webkit-prefixed API (iPadOS)', () => {
  assert.equal(supportsElementFullscreen({ webkitRequestFullscreen: () => {} }), true);
});

test('supportsElementFullscreen is FALSE on iPhone (no element fullscreen at all)', () => {
  // This is the platform the button silently failed on.
  assert.equal(supportsElementFullscreen({}), false);
  assert.equal(supportsElementFullscreen(null), false);
});

/* ---------------- requesting element fullscreen ---------------- */

test('requestElementFullscreen prefers the standard API', async () => {
  let called = '';
  const el = { requestFullscreen: async () => { called = 'standard'; }, webkitRequestFullscreen: () => { called = 'webkit'; } };
  assert.equal(await requestElementFullscreen(el), true);
  assert.equal(called, 'standard');
});

test('requestElementFullscreen uses the webkit API when standard is absent', async () => {
  let called = false;
  assert.equal(await requestElementFullscreen({ webkitRequestFullscreen: () => { called = true; } }), true);
  assert.equal(called, true);
});

test('requestElementFullscreen reports false when the platform has none', async () => {
  // False, not a throw: the caller falls back to the video element instead of
  // appearing to do nothing.
  assert.equal(await requestElementFullscreen({}), false);
  assert.equal(await requestElementFullscreen(null), false);
});

test('requestElementFullscreen reports false when the browser REFUSES', async () => {
  const el = { requestFullscreen: async () => { throw new Error('gesture required'); } };
  assert.equal(await requestElementFullscreen(el), false);
});

/* ---------------- iOS video fullscreen ---------------- */

test('supportsVideoFullscreen keys off the method, not the readiness flag', () => {
  // webkitSupportsFullscreen is false until metadata loads; the METHOD is what
  // decides whether the platform can do it at all.
  assert.equal(supportsVideoFullscreen({ webkitEnterFullscreen: () => {}, webkitSupportsFullscreen: false }), true);
  assert.equal(supportsVideoFullscreen({}), false);
  assert.equal(supportsVideoFullscreen(null), false);
});

test('enterVideoFullscreen hands the video to the native iOS player', () => {
  let entered = false;
  assert.equal(enterVideoFullscreen({ webkitEnterFullscreen: () => { entered = true; } }), true);
  assert.equal(entered, true);
});

test('enterVideoFullscreen refuses before the media can go fullscreen', () => {
  let entered = false;
  const video = { webkitEnterFullscreen: () => { entered = true; }, webkitSupportsFullscreen: false };
  assert.equal(enterVideoFullscreen(video), false, 'must not call before metadata');
  assert.equal(entered, false);
  assert.equal(enterVideoFullscreen({}), false, 'no method at all');
});

/* ---------------- exiting ---------------- */

test('exitAnyFullscreen leaves the iOS native video player first', async () => {
  let exited = '';
  const doc = { exitFullscreen: async () => { exited = 'document'; } };
  const video = { webkitDisplayingFullscreen: true, webkitExitFullscreen: () => { exited = 'video'; } };
  await exitAnyFullscreen(doc, video);
  assert.equal(exited, 'video', 'the video owns fullscreen on iOS, not the document');
});

test('exitAnyFullscreen uses the document API otherwise, prefixed or not', async () => {
  let exited = '';
  await exitAnyFullscreen({ exitFullscreen: async () => { exited = 'standard'; } });
  assert.equal(exited, 'standard');
  await exitAnyFullscreen({ webkitExitFullscreen: () => { exited = 'webkit'; } });
  assert.equal(exited, 'webkit');
});

test('exitAnyFullscreen never throws when there is nothing to exit', async () => {
  await exitAnyFullscreen({});
  await exitAnyFullscreen(null);
  await exitAnyFullscreen({ exitFullscreen: async () => { throw new Error('not active'); } });
});

/* ---------------- the YouTube fullscreen contract per platform ---------------- */

test('where the shell CAN go fullscreen, CineVerse keeps ownership', () => {
  const config = youtubePlayerConfig(true);
  assert.equal(config.playerVars.fs, 0, "YouTube's own fullscreen button stays hidden");
  assert.equal(config.allowFullscreenAttribute, false);
  assert.ok(!/fullscreen/i.test(config.allow), `the capability is withheld: ${config.allow}`);
  // Identical to the frozen default the rest of the app documents.
  assert.equal(config.playerVars, YOUTUBE_PLAYER_VARS);
  assert.equal(config.allow, YOUTUBE_IFRAME_ALLOW);
});

test('where the shell CANNOT (iPhone), fullscreen is handed back to YouTube', () => {
  // Otherwise a phone viewer has no fullscreen at all: the parent cannot take an
  // element fullscreen AND the iframe was denied the capability.
  const config = youtubePlayerConfig(false);
  assert.equal(config.playerVars.fs, 1, "YouTube's own button is the only path there");
  assert.equal(config.allowFullscreenAttribute, true);
  assert.ok(/fullscreen/i.test(config.allow), config.allow);
  // Everything else about the contract is unchanged.
  assert.equal(config.playerVars.controls, 1);
  assert.equal(config.playerVars.disablekb, 1);
  assert.equal(config.playerVars.playsinline, 1);
});
