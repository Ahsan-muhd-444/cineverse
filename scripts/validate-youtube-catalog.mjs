/**
 * Validate the built-in recommendation catalog against LIVE YouTube.
 *
 *     npm run validate:youtube-catalog
 *
 * Two layers:
 *   1. Pure shape (delegated to `validateRecommendedCatalog` in the data module):
 *      ids/video-ids unique, size in [40,50], per-region minimums, required fields,
 *      valid enums, `isOfficial` true. Offline — the unit test covers the same.
 *   2. LIVE, per item, via YouTube's oEmbed endpoint:
 *        - reachable + embeddable  (HTTP 200 => public and embeddable),
 *        - the channel still MATCHES the recorded `sourceChannel` (a video id belongs
 *          permanently to one channel, so a mismatch means the recorded officiality
 *          claim is wrong),
 *        - title + channel are logged for audit.
 *
 * Exits NON-ZERO on the first layer that fails. A green run is the evidence that
 * every recommended link is a live, embeddable, official upload right now — so no
 * broken or fabricated link can ship.
 *
 * Run with type-stripping so the .ts data module imports directly:
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/validate-youtube-catalog.mjs
 */

import { RECOMMENDED_MOVIES, validateRecommendedCatalog } from '../src/data/recommendedMovies.ts';

const CONCURRENCY = 6;
const PER_REQUEST_TIMEOUT_MS = 15_000;
const log = (m) => console.log(`[youtube-catalog] ${m}`);

/** oEmbed lookup for one video id, with one retry on a transient failure. */
async function oembed(videoId, attempt = 0) {
  const url = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PER_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (res.status === 200) {
      const json = await res.json();
      return { ok: true, status: 200, title: json.title, author: json.author_name };
    }
    // 401 = embedding disabled / private; 404 = removed. Both are hard failures.
    if ((res.status === 429 || res.status >= 500) && attempt < 1) {
      await new Promise((r) => setTimeout(r, 1200));
      return oembed(videoId, attempt + 1);
    }
    return { ok: false, status: res.status };
  } catch (err) {
    if (attempt < 1) {
      await new Promise((r) => setTimeout(r, 1200));
      return oembed(videoId, attempt + 1);
    }
    return { ok: false, status: 0, error: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

const norm = (s) => String(s || '').trim();

async function main() {
  log(`${RECOMMENDED_MOVIES.length} recommended movies`);

  /* -------- layer 1: pure shape -------- */
  const shape = validateRecommendedCatalog();
  if (!shape.ok) {
    log('SHAPE VALIDATION FAILED:');
    for (const e of shape.errors) log(`  ✗ ${e}`);
    process.exit(1);
  }
  log('shape validation: PASS (ids/video-ids unique, size + per-region minimums, fields, enums, official)');

  /* -------- layer 2: live oEmbed -------- */
  log('checking each video against YouTube oEmbed (reachable + embeddable + channel)…');
  const results = [];
  const queue = RECOMMENDED_MOVIES.map((m, i) => ({ m, i }));
  const worker = async () => {
    while (queue.length) {
      const { m, i } = queue.shift();
      const trailer = await oembed(m.youtubeVideoId);
      // A verified official full movie, where one exists, is checked the same way.
      const full = m.fullMovieVideoId ? await oembed(m.fullMovieVideoId) : null;
      results[i] = { m, trailer, full };
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const failures = [];
  let fullCount = 0;
  for (const { m, trailer, full } of results) {
    // --- trailer (always present) ---
    if (!trailer.ok) {
      failures.push(`${m.title} TRAILER (${m.youtubeVideoId}): unreachable/not embeddable — status ${trailer.status}${trailer.error ? ` (${trailer.error})` : ''}`);
      log(`  ✗ [${m.region[0]}] ${m.title} trailer — status ${trailer.status}${trailer.error ? ` ${trailer.error}` : ''}`);
    } else if (norm(trailer.author) !== norm(m.sourceChannel)) {
      failures.push(`${m.title} TRAILER (${m.youtubeVideoId}): channel drift — live "${trailer.author}" != recorded "${m.sourceChannel}"`);
      log(`  ✗ [${m.region[0]}] ${m.title} trailer — channel drift: "${trailer.author}" != "${m.sourceChannel}"`);
    } else {
      log(`  ✓ [${m.region[0]}] ${m.title} (${m.year}) — trailer · ${trailer.author}`);
    }

    // --- optional full movie ---
    if (m.fullMovieVideoId) {
      if (!full || !full.ok) {
        failures.push(`${m.title} FULL MOVIE (${m.fullMovieVideoId}): unreachable/not embeddable — status ${full ? full.status : 'n/a'}${full && full.error ? ` (${full.error})` : ''}`);
        log(`  ✗ [${m.region[0]}] ${m.title} full movie — status ${full ? full.status : 'n/a'}`);
      } else if (norm(full.author) !== norm(m.fullMovieChannel)) {
        failures.push(`${m.title} FULL MOVIE (${m.fullMovieVideoId}): channel drift — live "${full.author}" != recorded "${m.fullMovieChannel}"`);
        log(`  ✗ [${m.region[0]}] ${m.title} full movie — channel drift: "${full.author}" != "${m.fullMovieChannel}"`);
      } else {
        fullCount += 1;
        log(`      + full movie · ${full.author}`);
      }
    }
  }

  log('');
  if (failures.length) {
    log(`LIVE VALIDATION FAILED — ${failures.length} problem(s):`);
    for (const f of failures) log(`  ✗ ${f}`);
    process.exit(1);
  }
  log(`ALL ${RECOMMENDED_MOVIES.length} trailers + ${fullCount} official full movies PASS — every link is live, embeddable, and served by its recorded official channel.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`[youtube-catalog] fatal: ${err?.stack || err}`);
  process.exit(1);
});
