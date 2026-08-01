/**
 * Unit tests for the production security headers (server/headers.js).
 *
 * These assert BOTH directions, which is the only way a CSP test is worth
 * having: the policy must be restrictive where it can be, and must not block
 * the things CineVerse genuinely needs — the YouTube player, the WebSocket,
 * blob/data media, and the configured object-storage origin. A CSP that only
 * gets tested for strictness is a CSP that ships broken.
 *
 * Run:  node --test --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/headers.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildCsp, buildPermissionsPolicy, buildSecurityHeaders, storageOrigins, originOf } =
  require('../server/headers.js');

/** Pull one directive's value list out of a policy string. */
function directive(csp, name) {
  const found = csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `));
  return found ? found.slice(name.length + 1).split(' ') : null;
}

const prod = buildCsp({ dev: false, env: {} });

/* ---------------- the app must still work ---------------- */

test('the YouTube player may be framed and its API loaded', () => {
  assert.ok(directive(prod, 'frame-src').includes('https://www.youtube.com'), 'iframe');
  assert.ok(directive(prod, 'script-src').includes('https://www.youtube.com'), 'iframe_api');
  assert.ok(directive(prod, 'script-src').includes('https://s.ytimg.com'), 'the player bundle');
});

test('the Socket.IO WebSocket is allowed on the same origin', () => {
  const connect = directive(prod, 'connect-src');
  assert.ok(connect.includes("'self'"));
  assert.ok(connect.includes('ws:') && connect.includes('wss:'), 'named explicitly, not left to self');
});

test('chat previews, voice notes and local files (data:/blob:) are allowed', () => {
  for (const name of ['img-src', 'media-src']) {
    assert.ok(directive(prod, name).includes('data:'), `${name} data:`);
    assert.ok(directive(prod, name).includes('blob:'), `${name} blob:`);
  }
  assert.ok(directive(prod, 'worker-src').includes('blob:'), 'blob workers');
});

test('the runtime webfont stylesheet and its font files are allowed', () => {
  assert.ok(directive(prod, 'style-src').includes('https://fonts.googleapis.com'));
  assert.ok(directive(prod, 'font-src').includes('https://fonts.gstatic.com'));
});

test('Next hydration works — inline scripts and styles are permitted', () => {
  assert.ok(directive(prod, 'script-src').includes("'unsafe-inline'"));
  assert.ok(directive(prod, 'style-src').includes("'unsafe-inline'"));
});

test('a configured object-storage origin is reachable for upload and playback', () => {
  const env = {
    S3_ENDPOINT: 'https://acct.r2.cloudflarestorage.com',
    S3_PUBLIC_BASE_URL: 'https://cdn.example.com/videos',
  };
  const csp = buildCsp({ dev: false, env });
  assert.ok(directive(csp, 'connect-src').includes('https://acct.r2.cloudflarestorage.com'), 'presigned POST');
  assert.ok(directive(csp, 'media-src').includes('https://cdn.example.com'), 'playback from the CDN');
});

test('a broken storage URL is dropped rather than emitted as garbage', () => {
  assert.deepEqual(storageOrigins({ S3_ENDPOINT: 'not a url', S3_PUBLIC_BASE_URL: '' }), []);
  assert.equal(originOf('javascript:alert(1)'), null, 'only http(s) origins');
  assert.equal(originOf('https://a.example.com/deep/path?x=1'), 'https://a.example.com', 'origin only');
});

/* ---------------- and must still be restrictive ---------------- */

test('nothing is granted a wildcard source', () => {
  assert.equal(prod.includes(" *"), false, `no bare wildcard in: ${prod}`);
  assert.equal(prod.includes("'unsafe-eval'"), false, 'never eval in production');
});

test('dev alone gets unsafe-eval, for the HMR runtime', () => {
  assert.ok(buildCsp({ dev: true, env: {} }).includes("'unsafe-eval'"));
});

test('the dangerous sinks are shut off', () => {
  assert.deepEqual(directive(prod, 'object-src'), ["'none'"], 'no plugins');
  assert.deepEqual(directive(prod, 'base-uri'), ["'self'"], 'no base-tag hijack');
  assert.deepEqual(directive(prod, 'form-action'), ["'self'"], 'no exfiltration by form post');
  assert.deepEqual(directive(prod, 'frame-ancestors'), ["'none'"], 'CineVerse is never embedded');
});

test('only YouTube may be framed — nothing else', () => {
  const frames = directive(prod, 'frame-src');
  assert.equal(frames.every((s) => s.includes('youtube')), true, frames.join(' '));
});

/* ---------------- the rest of the header set ---------------- */

test('the baseline headers are all present', () => {
  const headers = buildSecurityHeaders({ dev: false, env: {} });
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(headers['Referrer-Policy'], 'strict-origin-when-cross-origin');
  assert.equal(headers['Cross-Origin-Opener-Policy'], 'same-origin');
  assert.equal(headers['X-Frame-Options'], 'DENY');
  assert.ok(headers['Content-Security-Policy']);
  assert.ok(headers['Permissions-Policy']);
});

test('COEP require-corp is NOT set — it would break the YouTube iframe', () => {
  const headers = buildSecurityHeaders({ dev: false, env: {} });
  assert.equal(headers['Cross-Origin-Embedder-Policy'], undefined);
});

test('calls keep camera, microphone and screen capture — scoped to self', () => {
  const policy = buildPermissionsPolicy();
  for (const feature of ['camera=(self)', 'microphone=(self)', 'display-capture=(self)', 'fullscreen=(self)']) {
    assert.ok(policy.includes(feature), `${feature} missing from: ${policy}`);
  }
});

test('features the app never uses are denied outright', () => {
  const policy = buildPermissionsPolicy();
  for (const feature of ['geolocation=()', 'payment=()', 'usb=()']) {
    assert.ok(policy.includes(feature), `${feature} missing`);
  }
});

test('the cross-origin YouTube iframe is not granted fullscreen by policy', () => {
  // `(self)` is the top document only. The iframe owning fullscreen is exactly
  // the bug the shell-fullscreen work removed; the header must not undo it.
  assert.equal(buildPermissionsPolicy().includes('fullscreen=*'), false);
  assert.equal(buildPermissionsPolicy().includes('fullscreen=(self "https://www.youtube.com")'), false);
});

test('the TEST-ONLY mock bucket origin is in the CSP only under the test gate', () => {
  /*
   * Found by a real browser: with the mock bucket on its own origin, Chromium
   * refused every part PUT with a connect-src violation. The harness origin has
   * to be allowed under the SAME gate that selects the mock adapter — and must
   * never leak into a normal or production policy.
   */
  const origin = 'http://127.0.0.1:4998';
  const testEnv = { NODE_ENV: 'test', UPLOAD_TEST_MODE: '1', UPLOAD_TEST_BUCKET_ORIGIN: origin };

  const allowed = buildSecurityHeaders({ dev: false, env: testEnv })['Content-Security-Policy'];
  assert.ok(allowed.includes(`connect-src 'self' ws: wss: blob: data: ${origin}`), allowed);

  // Every way the gate can be off keeps the origin OUT.
  for (const env of [
    { NODE_ENV: 'production', UPLOAD_TEST_MODE: '1', UPLOAD_TEST_BUCKET_ORIGIN: origin },
    { NODE_ENV: 'development', UPLOAD_TEST_MODE: '1', UPLOAD_TEST_BUCKET_ORIGIN: origin },
    { NODE_ENV: 'test', UPLOAD_TEST_BUCKET_ORIGIN: origin },
    { NODE_ENV: 'test', UPLOAD_TEST_MODE: '1' },
  ]) {
    const csp = buildSecurityHeaders({ dev: false, env })['Content-Security-Policy'];
    assert.equal(csp.includes(origin), false, JSON.stringify(env));
  }
});
