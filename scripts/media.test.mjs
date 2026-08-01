/**
 * Unit tests for media-source parsing and normalization (src/lib/media.ts).
 *
 * Pure logic only — these do not, and cannot without a browser, exercise the
 * YouTube IFrame player itself. They lock the parsing/normalization contract and
 * the player-recreation predicate. Browser/iframe behavior is covered by the
 * manual QA checklist in the report.
 *
 * Run:  node --test --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/media.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractYouTubeId,
  isYouTubeInput,
  normalizeMediaSource,
  resolveYouTubeId,
  shouldRecreateYouTubePlayer,
} from '../src/lib/media.ts';

const ID = 'dQw4w9WgXcQ';

test('extractYouTubeId: watch URL', () => {
  assert.equal(extractYouTubeId(`https://www.youtube.com/watch?v=${ID}`), ID);
});

test('extractYouTubeId: youtu.be short link', () => {
  assert.equal(extractYouTubeId(`https://youtu.be/${ID}`), ID);
});

test('extractYouTubeId: embed URL', () => {
  assert.equal(extractYouTubeId(`https://www.youtube.com/embed/${ID}`), ID);
});

test('extractYouTubeId: shorts URL', () => {
  assert.equal(extractYouTubeId(`https://www.youtube.com/shorts/${ID}`), ID);
});

test('extractYouTubeId: live URL', () => {
  assert.equal(extractYouTubeId(`https://www.youtube.com/live/${ID}`), ID);
});

test('extractYouTubeId: extra query params (t, list, si)', () => {
  assert.equal(extractYouTubeId(`https://www.youtube.com/watch?v=${ID}&t=90&list=PLxyz`), ID);
  assert.equal(extractYouTubeId(`https://youtu.be/${ID}?si=abc123DEF&t=42`), ID);
});

test('extractYouTubeId: bare 11-character ID', () => {
  assert.equal(extractYouTubeId(ID), ID);
});

test('extractYouTubeId: invalid / non-YouTube input', () => {
  assert.equal(extractYouTubeId('https://example.com/video.mp4'), null);
  assert.equal(extractYouTubeId('not a url'), null);
  assert.equal(extractYouTubeId(''), null);
  assert.equal(extractYouTubeId(null), null);
});

test('isYouTubeInput: links and bare IDs are YouTube; direct files are not', () => {
  assert.equal(isYouTubeInput(`https://youtu.be/${ID}`), true);
  assert.equal(isYouTubeInput(ID), true);
  assert.equal(isYouTubeInput('https://example.com/a.mp4'), false);
});

test('normalizeMediaSource: YouTube watch URL becomes type youtube with bare ID', () => {
  const s = normalizeMediaSource({ type: 'youtube', value: `https://www.youtube.com/watch?v=${ID}&t=30`, label: 'Clip' });
  assert.deepEqual(s, { type: 'youtube', value: ID, label: 'Clip' });
});

test('normalizeMediaSource: a YouTube link mis-typed as url is still normalized to youtube', () => {
  const s = normalizeMediaSource({ type: 'url', value: `https://youtu.be/${ID}` });
  assert.equal(s.type, 'youtube');
  assert.equal(s.value, ID);
});

test('normalizeMediaSource: a bare YouTube ID becomes a youtube source', () => {
  const s = normalizeMediaSource({ type: 'url', value: ID });
  assert.equal(s.type, 'youtube');
  assert.equal(s.value, ID);
});

test('normalizeMediaSource: a direct MP4 URL stays a url source', () => {
  const s = normalizeMediaSource({ type: 'url', value: 'https://example.com/film.mp4', label: 'Film' });
  assert.equal(s.type, 'url');
  assert.equal(s.value, 'https://example.com/film.mp4');
});

test('normalizeMediaSource: an HLS URL stays a url source', () => {
  const s = normalizeMediaSource({ type: 'url', value: 'https://example.com/stream.m3u8' });
  assert.equal(s.type, 'url');
});

test('normalizeMediaSource: catalog and local sources are preserved, never reinterpreted', () => {
  const cat = normalizeMediaSource({ type: 'catalog', value: 'https://cdn/openfilm.mp4', label: 'Sintel' });
  assert.equal(cat.type, 'catalog');
  const local = normalizeMediaSource({ type: 'local', value: 'my-movie.mkv', label: 'my-movie.mkv' });
  assert.equal(local.type, 'local');
});

test('normalizeMediaSource: a YouTube-typed source with no extractable ID falls back to url', () => {
  const s = normalizeMediaSource({ type: 'youtube', value: 'https://youtube.com/watch?v=short' });
  assert.equal(s.type, 'url');
});

test('invalid YouTube-looking input is detectable (SourcePicker rejects it)', () => {
  // The picker gate: isYouTubeInput true but extractYouTubeId null -> reject,
  // rather than normalizeMediaSource silently downgrading it to a url source.
  const bad = 'https://www.youtube.com/watch?v=tooshort';
  assert.equal(isYouTubeInput(bad), true);
  assert.equal(extractYouTubeId(bad), null);
  // A valid one passes the same gate.
  const good = `https://www.youtube.com/watch?v=${ID}`;
  assert.equal(isYouTubeInput(good), true);
  assert.equal(extractYouTubeId(good), ID);
});

test('resolveYouTubeId: reads the ID from a normalized source and from a legacy full URL', () => {
  assert.equal(resolveYouTubeId({ type: 'youtube', value: ID }), ID);
  assert.equal(resolveYouTubeId({ type: 'youtube', value: `https://youtu.be/${ID}` }), ID);
  assert.equal(resolveYouTubeId({ type: 'url', value: 'https://example.com/a.mp4' }), null);
  assert.equal(resolveYouTubeId(null), null);
});

test('shouldRecreateYouTubePlayer: recreate only when the video ID actually changes', () => {
  assert.equal(shouldRecreateYouTubePlayer(ID, ID), false); // unrelated re-render — keep the iframe
  assert.equal(shouldRecreateYouTubePlayer('AAAAAAAAAAA', 'BBBBBBBBBBB'), true); // A -> B
  assert.equal(shouldRecreateYouTubePlayer(null, ID), true); // first load
});
