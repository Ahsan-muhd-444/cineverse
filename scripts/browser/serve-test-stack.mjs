/**
 * The browser-test stack: a mock object-storage bucket on one origin and the REAL
 * CineVerse server (in test mode) on another.
 *
 * Playwright's `webServer` runs this and waits for /readyz. It exists so a browser
 * exercises the ACTUAL room UI against a real cross-origin bucket, with no S3
 * credentials — the mock bucket is selected only under the NODE_ENV=test +
 * UPLOAD_TEST_MODE gate that production refuses.
 *
 * Two child pieces, one process: the bucket runs in-process here; the app is a
 * spawned `node server.js` so it is byte-for-byte the production entrypoint. Both
 * are torn down on exit.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const APP_PORT = Number(process.env.BROWSER_TEST_PORT) || 3999;
const BUCKET_PORT = Number(process.env.BROWSER_TEST_BUCKET_PORT) || 4998;
const PART_SIZE = 8 * 1024 * 1024; // 8 MiB — 17 MiB fixture => 3 parts
const SINGLE_SHOT = 4 * 1024 * 1024; // below the fixture, so it routes to multipart

const { startMockBucket } = await import(pathToFileURL(path.join(ROOT, 'scripts', 'mock-bucket.mjs')).href);

const bucket = await startMockBucket({ port: BUCKET_PORT, exposeEtag: true });
// eslint-disable-next-line no-console
console.log(`[test-stack] mock bucket on ${bucket.origin}`);

const app = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  stdio: ['ignore', 'inherit', 'inherit'],
  env: {
    ...process.env,
    NODE_ENV: 'test',
    UPLOAD_TEST_MODE: '1',
    UPLOAD_TEST_BUCKET_ORIGIN: bucket.origin,
    UPLOAD_TEST_SINGLE_SHOT_MAX_BYTES: String(SINGLE_SHOT),
    UPLOAD_SECRET: 'browser-test-stable-upload-secret-32b',
    MAX_UPLOAD_BYTES: String(3 * 1024 * 1024 * 1024),
    UPLOAD_PART_SIZE_BYTES: String(PART_SIZE),
    UPLOAD_PART_CONCURRENCY: '3',
    ROOM_RECONNECT_GRACE_MS: '500',
    PORT: String(APP_PORT),
    HOST: '127.0.0.1',
  },
});

let closing = false;
async function shutdown(code) {
  if (closing) return;
  closing = true;
  try {
    app.kill('SIGTERM');
  } catch {
    /* already gone */
  }
  await bucket.close().catch(() => {});
  process.exit(code ?? 0);
}

app.on('exit', (code) => shutdown(code ?? 0));
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
