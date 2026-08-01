/**
 * Unit tests for the built-in recommendation catalog (src/data/recommendedMovies.ts).
 *
 * Pure and offline: shape, counts, uniqueness, enums, and the room-source mapping.
 * The LIVE reachability/embeddability of each YouTube id is proven separately by
 * `npm run validate:youtube-catalog` (which hits YouTube oEmbed).
 *
 * Run:  node --test --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/recommended-movies.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RECOMMENDED_MOVIES,
  RECOMMENDED_REGIONS,
  REGION_MINIMUMS,
  CATALOG_MIN,
  CATALOG_MAX,
  validateRecommendedCatalog,
  recommendedByRegion,
  searchRecommended,
  findRecommended,
  toYouTubeSource,
  hasFullMovie,
} from '../src/data/recommendedMovies.ts';

test('the whole catalog passes pure shape validation', () => {
  const { ok, errors } = validateRecommendedCatalog();
  assert.equal(ok, true, errors.join('\n'));
});

test('catalog size is within the required 40–50 range', () => {
  assert.ok(RECOMMENDED_MOVIES.length >= CATALOG_MIN && RECOMMENDED_MOVIES.length <= CATALOG_MAX, `size ${RECOMMENDED_MOVIES.length}`);
});

test('each region clears its minimum count', () => {
  for (const region of RECOMMENDED_REGIONS) {
    const count = recommendedByRegion(region).length;
    assert.ok(count >= REGION_MINIMUMS[region], `${region}: ${count} < ${REGION_MINIMUMS[region]}`);
  }
});

test('every id is unique', () => {
  const ids = RECOMMENDED_MOVIES.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('every YouTube video id is unique', () => {
  const vids = RECOMMENDED_MOVIES.map((m) => m.youtubeVideoId);
  assert.equal(new Set(vids).size, vids.length);
});

test('only allowed languages and regions appear', () => {
  const langs = new Set(['Punjabi', 'Hindi', 'English']);
  const regions = new Set(['Punjabi', 'Bollywood', 'Hollywood']);
  for (const m of RECOMMENDED_MOVIES) {
    assert.ok(langs.has(m.language), `bad language ${m.language}`);
    assert.ok(regions.has(m.region), `bad region ${m.region}`);
  }
});

test('youtubeType is only trailer or full_movie', () => {
  for (const m of RECOMMENDED_MOVIES) {
    assert.ok(m.youtubeType === 'trailer' || m.youtubeType === 'full_movie', `${m.id}: ${m.youtubeType}`);
  }
});

test('every included item is marked official and embeddable-verified', () => {
  for (const m of RECOMMENDED_MOVIES) {
    assert.equal(m.isOfficial, true, `${m.id} not official`);
    assert.equal(m.isEmbeddableVerified, true, `${m.id} not verified`);
  }
});

test('every item has the required fields (no missing title/year/language/poster/url)', () => {
  for (const m of RECOMMENDED_MOVIES) {
    assert.ok(m.id && m.title, `${m.id}`);
    assert.ok(Number.isInteger(m.year), `${m.id} year`);
    assert.ok(m.language, `${m.id} language`);
    assert.ok(/^https:\/\/i\.ytimg\.com\//.test(m.posterUrl), `${m.id} posterUrl`);
    assert.ok(m.youtubeUrl.includes(m.youtubeVideoId), `${m.id} url<->id`);
    assert.ok(m.sourceChannel, `${m.id} channel`);
  }
});

test('validateRecommendedItem rejects a malformed entry', () => {
  // A duplicate id + bad enum injected into a copy must be caught.
  const bad = [
    { ...RECOMMENDED_MOVIES[0], id: 'dup' },
    { ...RECOMMENDED_MOVIES[1], id: 'dup', region: 'Tollywood', isOfficial: false },
  ];
  const { ok, errors } = validateRecommendedCatalog(bad);
  assert.equal(ok, false);
  assert.ok(errors.some((e) => /duplicate id/.test(e)), errors.join('|'));
  assert.ok(errors.some((e) => /bad region/.test(e)), errors.join('|'));
  assert.ok(errors.some((e) => /isOfficial/.test(e)), errors.join('|'));
});

test('toYouTubeSource returns the canonical bare-id youtube source', () => {
  const m = RECOMMENDED_MOVIES[0];
  const src = toYouTubeSource(m);
  assert.equal(src.type, 'youtube');
  assert.equal(src.value, m.youtubeVideoId, 'value must be the bare 11-char id (trailer by default)');
  assert.ok(src.label.includes(m.title), 'label references the title');
  assert.equal(src.poster, m.posterUrl);
});

test('optional full movies: fields are consistent and validate', () => {
  const withFull = RECOMMENDED_MOVIES.filter(hasFullMovie);
  assert.ok(withFull.length >= 1, 'at least one official full movie is present');
  const idRe = /^[\w-]{11}$/;
  for (const m of withFull) {
    assert.ok(idRe.test(m.fullMovieVideoId), `${m.id} fullMovieVideoId`);
    assert.ok(m.fullMovieUrl.includes(m.fullMovieVideoId), `${m.id} fullMovieUrl<->id`);
    assert.ok(m.fullMovieChannel, `${m.id} fullMovieChannel`);
    // A full-movie id must never be the same as its own trailer id.
    assert.notEqual(m.fullMovieVideoId, m.youtubeVideoId, `${m.id} full != trailer`);
  }
});

test('toYouTubeSource picks the full movie for kind="full", the trailer otherwise', () => {
  const m = RECOMMENDED_MOVIES.find(hasFullMovie);
  assert.ok(m, 'a full-movie title exists');
  assert.equal(toYouTubeSource(m, 'full').value, m.fullMovieVideoId, 'full → full-movie id');
  assert.equal(toYouTubeSource(m, 'trailer').value, m.youtubeVideoId, 'trailer → trailer id');
  // A trailer-only title ignores kind="full" and stays on the trailer.
  const trailerOnly = RECOMMENDED_MOVIES.find((x) => !hasFullMovie(x));
  assert.equal(toYouTubeSource(trailerOnly, 'full').value, trailerOnly.youtubeVideoId, 'no full → trailer id');
});

test('search filters by title, genre, language and region', () => {
  assert.ok(searchRecommended('dangal').some((m) => m.title === 'Dangal'));
  assert.ok(searchRecommended('comedy').length > 0);
  assert.ok(searchRecommended('punjabi').every((m) => m.region === 'Punjabi' || m.language === 'Punjabi'));
  assert.equal(searchRecommended('').length, RECOMMENDED_MOVIES.length, 'empty query returns all');
  assert.equal(searchRecommended('zzzznotathing').length, 0);
});

test('recommendations are static data, independent of upload availability', () => {
  // "disabled upload state does not break movie recommendations": the catalog has
  // no dependency on any server/upload state — it is importable and non-empty on
  // its own.
  assert.ok(RECOMMENDED_MOVIES.length > 0);
  assert.ok(findRecommended(RECOMMENDED_MOVIES[0].id));
});
