/**
 * The YouTube IFrame player configuration.
 *
 * Extracted and frozen because these flags are load-bearing for fullscreen
 * ownership — two separate bugs came from them — and a silent regression here
 * is invisible until someone is trapped in a fullscreen they cannot exit.
 * Asserted in scripts/youtube-sync.test.mjs.
 *
 *  controls: 1        YouTube keeps its own play/pause/seek/volume/settings UI.
 *  fs: 0              hides YouTube's fullscreen BUTTON.
 *  disablekb: 1       disables YouTube's internal keyboard shortcuts. Without
 *                     this, pressing F with the iframe focused made YouTube
 *                     attempt its own fullscreen — which the (deliberately)
 *                     removed iframe fullscreen permission then blocks, so the
 *                     viewer saw a glitch/no-op instead of nothing.
 *  rel: 0             no unrelated end-cards.
 *  playsinline: 1     iOS plays in place rather than hijacking to native full.
 *  iv_load_policy: 3  no annotation overlays.
 *
 * NOTE: `fs: 0` and `disablekb: 1` only cover YouTube's own UI and key handling.
 * The capability itself is revoked separately by omitting `fullscreen` from the
 * iframe's `allow` list — see styleIframe() in YouTubeEngine.tsx. Both halves
 * are required: one stops YouTube asking, the other stops the browser granting.
 */
export const YOUTUBE_PLAYER_VARS = Object.freeze({
  controls: 1,
  rel: 0,
  playsinline: 1,
  iv_load_policy: 3,
  fs: 0,
  disablekb: 1,
});

/**
 * The `allow` list for the generated iframe. `fullscreen` is deliberately
 * ABSENT — CineVerse owns fullscreen via its own shell, because a cross-origin
 * iframe in native fullscreen cannot be overlaid with an exit button.
 */
export const YOUTUBE_IFRAME_ALLOW =
  'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
