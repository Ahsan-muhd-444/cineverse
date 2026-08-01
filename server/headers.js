/**
 * Production security headers, in one place.
 *
 * They live here rather than in `next.config.mjs` because this process serves
 * more than Next: uploaded video streams and the health endpoints come from the
 * custom server. A policy that only covers the React routes is a policy with a
 * hole in it.
 *
 * The governing rule for the CSP is that it must describe what CineVerse
 * ACTUALLY does. A directive list copied from a hardening guide that blocks the
 * YouTube player, the WebSocket, or a voice note is not security — it is an
 * outage that gets the whole header block deleted at 2am. Every entry below
 * exists because something real needs it, and says which.
 *
 * Pure and env-aware; unit-tested in scripts/headers.test.mjs.
 */

/** YouTube's player iframe and the IFrame API script it pulls in. */
const YOUTUBE_FRAME = ['https://www.youtube.com', 'https://www.youtube-nocookie.com'];
const YOUTUBE_SCRIPT = ['https://www.youtube.com', 'https://s.ytimg.com'];
/** The webfont stylesheet is linked at runtime (fonts are not inlined at build). */
const GOOGLE_FONTS_STYLE = ['https://fonts.googleapis.com'];
const GOOGLE_FONTS_FILES = ['https://fonts.gstatic.com'];

/** An origin (scheme + host + port) from a URL, or null if it is unusable. */
function originOf(raw) {
  if (!raw) return null;
  try {
    const url = new URL(String(raw));
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Origins the browser talks to directly for uploads.
 *
 * Object storage is uploaded to from the BROWSER (presigned POST for single-shot,
 * presigned PUT per part for multipart — both on the S3 endpoint's origin), so it
 * has to be in `connect-src` or every upload fails with a CSP violation — and
 * possibly read back from a CDN domain, which needs `media-src`.
 *
 * The TEST-ONLY mock bucket runs on its own origin under the same
 * NODE_ENV=test + UPLOAD_TEST_MODE gate that selects the mock adapter (see
 * server/storage/index.js). Without it here the browser harness cannot PUT a
 * single part — which is exactly how this was found: a real Chromium refused
 * every part with "violates the following Content Security Policy directive:
 * connect-src". Production is unaffected: the flag is refused there outright.
 */
function testBucketOrigin(env) {
  const enabled = (env.UPLOAD_TEST_MODE === '1' || env.UPLOAD_TEST_MODE === 'true') && env.NODE_ENV === 'test';
  return enabled ? originOf(env.UPLOAD_TEST_BUCKET_ORIGIN) : null;
}

function storageOrigins(env = process.env) {
  return [originOf(env.S3_ENDPOINT), originOf(env.S3_PUBLIC_BASE_URL), testBucketOrigin(env)].filter(Boolean);
}

/**
 * Build the Content-Security-Policy.
 *
 * Known, deliberate looseness — recorded here so it is a decision, not an
 * oversight:
 *
 *  - `script-src 'unsafe-inline'`: Next's App Router streams hydration data in
 *    inline <script> tags. Removing this needs per-request nonces threaded
 *    through Next middleware; that is a real improvement, not a release-eve one.
 *  - `img-src`/`media-src https:`: the whole product is "paste a link and watch
 *    it together". The poster, GIF and video URLs are user-supplied by design,
 *    so an allow-list of hosts cannot be complete. They stay restricted to
 *    https (no http downgrade) and cannot execute.
 */
function buildCsp({ dev = false, env = process.env } = {}) {
  const storage = storageOrigins(env);

  const directives = {
    'default-src': ["'self'"],
    // 'unsafe-eval' is dev-only: webpack's HMR runtime needs it, production
    // never does.
    'script-src': ["'self'", "'unsafe-inline'", ...YOUTUBE_SCRIPT, ...(dev ? ["'unsafe-eval'"] : [])],
    // Tailwind's runtime style attributes and framer-motion's animated inline
    // styles are both inline styles.
    'style-src': ["'self'", "'unsafe-inline'", ...GOOGLE_FONTS_STYLE],
    'font-src': ["'self'", 'data:', ...GOOGLE_FONTS_FILES],
    // Posters, GIF reactions and catalog art are user- and catalog-supplied;
    // blob:/data: cover chat image previews and locally chosen files.
    'img-src': ["'self'", 'data:', 'blob:', 'https:'],
    // Uploaded files, catalog trailers, pasted links, local files (blob:) and
    // recorded voice notes (data:).
    'media-src': ["'self'", 'data:', 'blob:', 'https:', ...storage],
    // The Socket.IO transport is same-origin, but 'self' does not reliably cover
    // ws:/wss: in every browser, so both schemes are named explicitly.
    'connect-src': ["'self'", 'ws:', 'wss:', 'blob:', 'data:', ...storage],
    // The YouTube player. Nothing else may be framed.
    'frame-src': [...YOUTUBE_FRAME],
    // Screen-share and camera previews can be rendered by workers/blob URLs.
    'worker-src': ["'self'", 'blob:'],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    // CineVerse is never embedded in someone else's page.
    'frame-ancestors': ["'none'"],
  };

  return Object.entries(directives)
    .map(([name, values]) => `${name} ${[...new Set(values)].join(' ')}`)
    .join('; ');
}

/**
 * Permissions-Policy.
 *
 * Calls need camera, microphone and screen capture, and the player needs
 * fullscreen — all scoped to `self`, so the YouTube iframe (a cross-origin
 * child) is NOT granted them. That is deliberate and load-bearing: CineVerse
 * owns the fullscreen shell precisely because the iframe must not take over the
 * screen itself.
 */
function buildPermissionsPolicy() {
  return [
    'accelerometer=()',
    'autoplay=(self)',
    'camera=(self)',
    'display-capture=(self)',
    'fullscreen=(self)',
    'geolocation=()',
    'gyroscope=()',
    'magnetometer=()',
    'microphone=(self)',
    'payment=()',
    'usb=()',
  ].join(', ');
}

/**
 * The full header set.
 *
 * Cross-Origin-Embedder-Policy is deliberately ABSENT: `require-corp` would
 * block the YouTube iframe and every cross-origin poster the catalog uses.
 */
function buildSecurityHeaders({ dev = false, env = process.env } = {}) {
  return {
    'Content-Security-Policy': buildCsp({ dev, env }),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': buildPermissionsPolicy(),
    'Cross-Origin-Opener-Policy': 'same-origin',
    // Redundant with frame-ancestors for modern browsers, kept for old ones.
    'X-Frame-Options': 'DENY',
  };
}

module.exports = {
  buildCsp,
  buildPermissionsPolicy,
  buildSecurityHeaders,
  storageOrigins,
  originOf,
};
