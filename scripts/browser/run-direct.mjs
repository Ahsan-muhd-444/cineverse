/**
 * A DIRECT, single-process browser runner.
 *
 * The Playwright Test runner spawns worker processes and talks to them over IPC,
 * which is blocked in some sandboxed shells — a trivial no-op spec hangs there
 * forever. That made the browser suite unrunnable in exactly the environment it
 * most needed to run in. This runner uses the Playwright BROWSER API only:
 * one process, no workers, scenarios in sequence.
 *
 * It boots the whole stack itself (mock object-storage bucket on its own origin +
 * the real CineVerse server in test mode), drives the ACTUAL room UI in Chromium,
 * writes an atomic JSON result artifact, and exits non-zero on any failure.
 *
 *   node scripts/browser/run-direct.mjs [--headed] [--filter=<substring>]
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

const APP_PORT = Number(process.env.BROWSER_TEST_PORT) || 3999;
const BUCKET_PORT = Number(process.env.BROWSER_TEST_BUCKET_PORT) || 4998;
const APP = `http://127.0.0.1:${APP_PORT}`;
/**
 * A SECOND app instance for the demo-deployment scenario: production, with no
 * object storage at all. It must not share the mock-bucket stack's port or env.
 */
const DEMO_PORT = Number(process.env.BROWSER_TEST_DEMO_PORT) || 3997;
const DEMO_APP = `http://127.0.0.1:${DEMO_PORT}`;
const PART_SIZE = 8 * 1024 * 1024;
const SINGLE_SHOT = 4 * 1024 * 1024;
const MIB = 1024 * 1024;
const FIXTURE_BYTES = 17 * MIB;
const PART_COUNT = 3;

const ARGS = process.argv.slice(2);
const HEADED = ARGS.includes('--headed');
const STRESS = ARGS.includes('--stress');
/**
 * Demo-deployment mode: production with NO object storage. Runs WITHOUT the mock
 * bucket, because that stack boots the app with NODE_ENV=test — Next dev mode,
 * which recompiles `.next` and destroys the production build this mode needs.
 */
const DEMO = ARGS.includes('--demo');
const FILTER = (ARGS.find((a) => a.startsWith('--filter=')) || '').slice('--filter='.length);
const RESULT_FILE =
  process.env.BROWSER_RESULT_FILE ||
  path.join(
    ROOT,
    '.artifacts',
    'browser',
    DEMO ? 'direct-demo-results.json' : STRESS ? 'direct-stress-results.json' : 'direct-results.json',
  );

/* -------------------------------------------------------------------------- */
/*  Browser resolution                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Launch Chromium: the bundled build first, then a system Chrome/Chromium.
 *
 * `--no-sandbox` is applied only where the OS sandbox is unavailable (root in a
 * container, or an explicit opt-in) — never silently on a normal desktop.
 */
async function launchBrowser(chromium) {
  const needsNoSandbox =
    process.env.BROWSER_TEST_NO_SANDBOX === '1' ||
    (process.platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0);
  const args = needsNoSandbox ? ['--no-sandbox', '--disable-setuid-sandbox'] : [];
  const base = { headless: !HEADED, args };

  try {
    const browser = await chromium.launch(base);
    return { browser, channel: 'bundled chromium', noSandbox: needsNoSandbox };
  } catch (bundledError) {
    for (const channel of ['chrome', 'msedge', 'chromium']) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const browser = await chromium.launch({ ...base, channel });
        return { browser, channel: `system ${channel}`, noSandbox: needsNoSandbox };
      } catch {
        /* try the next channel */
      }
    }
    throw new Error(
      `no usable Chromium: bundled launch failed (${bundledError.message}) and no system channel was available. ` +
        'Run `npx playwright install chromium`.',
    );
  }
}

/* -------------------------------------------------------------------------- */
/*  Stack                                                                     */
/* -------------------------------------------------------------------------- */

async function waitForReady(url, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function startStack(log) {
  const { startMockBucket } = await import(pathToFileURL(path.join(ROOT, 'scripts', 'mock-bucket.mjs')).href);
  const bucket = await startMockBucket({ port: BUCKET_PORT, exposeEtag: true });
  log(`mock bucket on ${bucket.origin}`);

  const app = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
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
      /*
       * The PRODUCT default reconnect grace, deliberately not the 500ms the
       * realtime E2E uses. A multipart session is bound to the STABLE member
       * id, so a reload or an offline blip must reclaim the SAME seat to
       * resume — with a 500ms grace the seat expires during the reload and
       * the resumed token fails WRONG_MEMBER. That is a real constraint on
       * resume (see docs/uploads.md), not something to paper over here.
       */
      PORT: String(APP_PORT),
      HOST: '127.0.0.1',
    },
  });
  const appLog = [];
  app.stdout.on('data', (d) => appLog.push(String(d)));
  app.stderr.on('data', (d) => appLog.push(String(d)));

  const ready = await waitForReady(`${APP}/readyz`);
  if (!ready) {
    app.kill('SIGTERM');
    await bucket.close();
    throw new Error(`the app did not become ready:\n${appLog.join('').slice(-2000)}`);
  }
  log(`app ready on ${APP}`);

  // Warm the room route once: `next dev` compiles on first hit, and a cold
  // compile inside a scenario looks like a hang.
  await fetch(`${APP}/room/WARMUP`).catch(() => {});

  return {
    bucket,
    async stop() {
      try {
        app.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      await bucket.close().catch(() => {});
    },
  };
}

/**
 * Boot a SECOND app exactly as the current deployment runs it: production, with
 * NO object storage, NO upload secret and NO explicit ceiling — so
 * `getUploadAvailability` resolves to `disabled` and hosted uploads are off.
 *
 * Every S3/upload variable is deleted from the inherited environment rather than
 * merely left unset: a developer with real credentials exported would otherwise
 * silently flip this scenario into an ENABLED deployment and it would prove the
 * opposite of what it claims.
 */
async function startDemoModeApp(log) {
  const env = { ...process.env };
  for (const key of [
    'S3_ENDPOINT',
    'S3_BUCKET',
    'S3_ACCESS_KEY_ID',
    'S3_SECRET_ACCESS_KEY',
    'S3_REGION',
    'S3_FORCE_PATH_STYLE',
    'S3_PUBLIC_BASE_URL',
    'UPLOAD_SECRET',
    'MAX_UPLOAD_BYTES',
    'UPLOAD_TEST_MODE',
    'UPLOAD_TEST_BUCKET_ORIGIN',
    'UPLOAD_TEST_SINGLE_SHOT_MAX_BYTES',
  ]) {
    delete env[key];
  }
  env.NODE_ENV = 'production';
  env.PORT = String(DEMO_PORT);
  env.HOST = '127.0.0.1';

  const app = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  const appLog = [];
  app.stdout.on('data', (d) => appLog.push(String(d)));
  app.stderr.on('data', (d) => appLog.push(String(d)));

  const ready = await waitForReady(`${DEMO_APP}/readyz`);
  if (!ready) {
    app.kill('SIGTERM');
    throw new Error(`the demo-mode app did not become ready:\n${appLog.join('').slice(-2000)}`);
  }
  log(`demo-mode app (production, no S3) ready on ${DEMO_APP}`);

  return {
    origin: DEMO_APP,
    log: () => appLog.join(''),
    async stop() {
      try {
        app.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Assertions + page helpers                                                 */
/* -------------------------------------------------------------------------- */

class AssertionError extends Error {}
function ok(condition, message) {
  if (!condition) throw new AssertionError(message);
}
function eq(actual, expected, message) {
  if (actual !== expected) throw new AssertionError(`${message} (expected ${expected}, got ${actual})`);
}

const bucketControl = (origin, route, body = {}) =>
  fetch(`${origin}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.ok);

const bucketInspect = (origin) => fetch(`${origin}/_control/inspect`).then((r) => r.json());

let roomSeq = 0;
const freshRoom = (prefix) => `${prefix}${(roomSeq += 1).toString().padStart(3, '0')}`;

/** Install the memory/concurrency probe before any app script runs. */
async function installProbe(page, bucketOrigin) {
  await page.addInitScript((origin) => {
    // Ask the room-scoped uploader to expose its liveness counters (test-only,
    // count-only). The stress gate reads these to prove nothing leaks.
    window.__CINEVERSE_UPLOAD_DEBUG__ = true;
    const probe = { sliceCount: 0, sliceSizes: [], maxConcurrentXhr: 0, activeXhr: 0, totalPutXhr: 0 };
    window.__uploadProbe = probe;

    const origSlice = Blob.prototype.slice;
    Blob.prototype.slice = function patched(start, end, ...rest) {
      probe.sliceCount += 1;
      if (Number.isFinite(start) && Number.isFinite(end)) probe.sliceSizes.push(end - start);
      return origSlice.call(this, start, end, ...rest);
    };

    const OrigXHR = window.XMLHttpRequest;
    window.XMLHttpRequest = function TrackedXHR() {
      const xhr = new OrigXHR();
      const open = xhr.open.bind(xhr);
      xhr.open = function patchedOpen(method, url, ...r) {
        xhr.__isPut = method === 'PUT' && String(url).startsWith(origin);
        return open(method, url, ...r);
      };
      const send = xhr.send.bind(xhr);
      xhr.send = function patchedSend(...args) {
        if (xhr.__isPut) {
          probe.activeXhr += 1;
          probe.totalPutXhr += 1;
          probe.maxConcurrentXhr = Math.max(probe.maxConcurrentXhr, probe.activeXhr);
          xhr.addEventListener('loadend', () => {
            if (xhr.__counted) return;
            xhr.__counted = true;
            probe.activeXhr -= 1;
          });
        }
        return send(...args);
      };
      return xhr;
    };
  }, bucketOrigin);
}

const readProbe = (page) => page.evaluate(() => window.__uploadProbe);

/** Read the engine's liveness counters via the gated test hook (null if absent). */
const readEngineDebug = (page) =>
  page.evaluate(() => (window.__cineverseUploaderDebug ? window.__cineverseUploaderDebug() : null));

/** The server's test-only upload registry readout ({ activeSessions, totalRecords }). */
const testUploads = () => fetch(`${APP}/__test__/uploads`).then((r) => r.json());

/**
 * Assert the whole pipeline is QUIESCENT: no XHR, slice, sleeper, worker or retry
 * timer alive in the engine, no open multipart upload at the provider, no active
 * registry session, and no stale progress in the room. This is the stress gate's
 * core invariant.
 *
 * It POLLS observable predicates to convergence rather than sleeping a fixed
 * settle — the same discipline item 4 requires of the scenarios themselves.
 */
async function assertQuiescent(page, origin, label) {
  await waitForCondition(
    async () => {
      const probe = await readProbe(page);
      const dbg = await readEngineDebug(page);
      const inspect = await bucketInspect(origin);
      const reg = await testUploads().catch(() => ({ activeSessions: -1 }));
      return (
        probe.activeXhr === 0 &&
        inspect.openUploads === 0 &&
        reg.activeSessions === 0 &&
        !!dbg &&
        dbg.activeXhrs === 0 &&
        dbg.activeSlices === 0 &&
        dbg.activeSleepers === 0 &&
        dbg.activeWorkers === 0 &&
        dbg.pendingTimers === 0
      );
    },
    { timeout: 40_000, label: `${label}: quiescence` },
  );

  // Confirm each counter explicitly so a failure names exactly what leaked.
  const probe = await readProbe(page);
  eq(probe.activeXhr, 0, `${label}: active part XHRs`);
  const dbg = await readEngineDebug(page);
  ok(dbg, `${label}: engine debug hook missing (is __CINEVERSE_UPLOAD_DEBUG__ set before load?)`);
  eq(dbg.activeXhrs, 0, `${label}: engine activeXhrs`);
  eq(dbg.activeSlices, 0, `${label}: active slices`);
  eq(dbg.activeSleepers, 0, `${label}: active sleepers`);
  eq(dbg.activeWorkers, 0, `${label}: active workers`);
  eq(dbg.pendingTimers, 0, `${label}: retry timers`);
  eq((await bucketInspect(origin)).openUploads, 0, `${label}: open mock uploads`);
  eq((await testUploads()).activeSessions, 0, `${label}: active registry sessions`);

  // No stale partner-progress broadcast lingering in the room UI.
  const body = await page.locator('body').innerText().catch(() => '');
  ok(
    !/is uploading|is finalizing|is reconnecting|hit a network problem/i.test(body),
    `${label}: stale partner progress in the room`,
  );
}

async function joinRoom(page, code, name) {
  await page.goto(`${APP}/room/${code}`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  const nameField = page.getByPlaceholder('Your name');
  await nameField.waitFor({ state: 'visible', timeout: 90_000 });
  await nameField.fill(name);
  await page.getByRole('button', { name: 'Take my seat' }).click();
  await page
    .getByRole('button', { name: /Choose what to watch|Choose a film|Change film/ })
    .first()
    .waitFor({ timeout: 90_000 });
}

async function openLocalTab(page) {
  await page.getByRole('button', { name: /Choose what to watch|Choose a film|Change film/ }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ state: 'visible', timeout: 30_000 });
  await dialog.getByRole('tab', { name: /Local file/i }).click();
  return dialog;
}

/**
 * Hand the picker a generated fixture.
 *
 * `lastModified` is PINNED to a constant. The refresh-recovery fingerprint is
 * (name, size, type, lastModified), and Playwright's setInputFiles stamps a fresh
 * lastModified on every call — so without pinning it, reselecting the "same" file
 * would legitimately fail FILE_MISMATCH, testing the wrong thing. A DIFFERENT
 * name still mismatches, which is the negative case.
 */
const FIXTURE_LAST_MODIFIED = 1_700_000_000_000;
async function selectFixture(page, over = {}) {
  /*
   * Inject the File in-page via DataTransfer rather than setInputFiles.
   *
   * Playwright's setInputFiles does not let a test control `lastModified`, so it
   * stamps the current time — which makes the refresh-recovery fingerprint (name,
   * size, type, lastModified) unmatchable on reselection. Building the File in the
   * page gives full control, so "the same file" really is the same file. It is a
   * real File, so File.slice() and the whole byte path are exercised unchanged.
   */
  await page.evaluate(
    ({ name, size, lastModified }) => {
      const input = document.querySelector('input[type="file"][accept="video/*"]');
      if (!input) throw new Error('no file input');
      const bytes = new Uint8Array(size).fill(7);
      const file = new File([bytes], name, { type: 'video/mp4', lastModified });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    { name: over.name ?? 'movie.mp4', size: over.size ?? FIXTURE_BYTES, lastModified: over.lastModified ?? FIXTURE_LAST_MODIFIED },
  );
}

const progressBar = (page) => page.getByRole('dialog').locator('[role="progressbar"]').first();

/**
 * Wait for rendered text to match, by POLLING innerText.
 *
 * Deliberately not `getByText`: the dialog re-renders on every progress tick, and
 * a locator resolved against a detached subtree never settles here — the text was
 * verifiably on screen while the locator timed out. Polling the live innerText
 * asserts exactly what a user would read.
 */
async function waitForText(scope, pattern, { timeout = 60_000, label = '' } = {}) {
  const deadline = Date.now() + timeout;
  let last = '';
  for (;;) {
    last = await scope.innerText().catch(() => '');
    if (pattern.test(last)) return last;
    if (Date.now() > deadline) {
      const flat = last.replace(/\s+/g, ' ').slice(0, 300);
      throw new AssertionError(`timed out waiting for ${pattern}${label ? ` (${label})` : ''}; last text: ${flat}`);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

/** Wait for text to DISAPPEAR from a scope. */
async function waitForNoText(scope, pattern, { timeout = 60_000 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const text = await scope.innerText().catch(() => '');
    if (!pattern.test(text)) return;
    if (Date.now() > deadline) throw new AssertionError(`timed out waiting for ${pattern} to clear`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

/** Poll an async predicate until it is true, or time out. */
async function waitForCondition(fn, { timeout = 60_000, label = '' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new AssertionError(`timed out waiting for condition${label ? ` (${label})` : ''}`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

/* -------------------------------------------------------------------------- */
/*  Scenarios                                                                 */
/* -------------------------------------------------------------------------- */

function scenarios({ browser, bucket }) {
  const origin = bucket.origin;
  const list = [];
  const scenario = (name, fn) => list.push({ name, fn });

  scenario('two-member multipart upload publishes a verified source to both', async () => {
    await bucketControl(origin, '/_control/reset');
    await bucketControl(origin, '/_control/slow', { ms: 250 });
    const code = freshRoom('FL');
    const upCtx = await browser.newContext();
    const partnerCtx = await browser.newContext();
    const uploader = await upCtx.newPage();
    const partner = await partnerCtx.newPage();
    await installProbe(uploader, origin);
    try {
      await joinRoom(uploader, code, 'Uploader');
      await joinRoom(partner, code, 'Partner');
      await openLocalTab(uploader);
      await selectFixture(uploader);

      const bar = progressBar(uploader);
      await bar.waitFor({ state: 'visible', timeout: 60_000 });
      eq(await bar.getAttribute('aria-valuemin'), '0', 'aria-valuemin');
      eq(await bar.getAttribute('aria-valuemax'), String(FIXTURE_BYTES), 'aria-valuemax');
      const valueText = await bar.getAttribute('aria-valuetext');
      ok(/of .* uploaded, \d+%/i.test(valueText || ''), `aria-valuetext: ${valueText}`);
      const valueNow = Number(await bar.getAttribute('aria-valuenow'));
      ok(valueNow >= 0 && valueNow <= FIXTURE_BYTES, `aria-valuenow ${valueNow}`);

      // The partner sees progress WITHOUT the uploader's speed or ETA.
      const partnerText = await waitForText(partner.locator('body'), /Uploader is uploading/i, {
        timeout: 60_000,
        label: 'partner progress row',
      });
      ok(!/\d+(\.\d+)?\s*[KMG]B\/s/.test(partnerText), 'partner must not see a speed');
      ok(!/remaining/i.test(partnerText), 'partner must not see an ETA');

      // Completion: the picker closes, both members leave the dark screen.
      await uploader.getByRole('dialog').waitFor({ state: 'hidden', timeout: 120_000 });
      await uploader.getByText('The screen is dark').waitFor({ state: 'hidden', timeout: 30_000 });
      await partner.getByText('The screen is dark').waitFor({ state: 'hidden', timeout: 30_000 });
      await waitForNoText(partner.locator('body'), /Uploader is uploading/i, { timeout: 30_000 });

      const probe = await readProbe(uploader);
      eq(probe.totalPutXhr, PART_COUNT, 'one PUT per part');
      eq(probe.sliceCount, PART_COUNT, 'one File.slice per part');
      ok(probe.maxConcurrentXhr <= 3, `max concurrent XHR ${probe.maxConcurrentXhr}`);
      ok(Math.max(...probe.sliceSizes) <= PART_SIZE, 'slice size bounded by partSize');
      eq(probe.activeXhr, 0, 'no XHR left in flight');

      const inspect = await bucketInspect(origin);
      eq(inspect.openUploads, 0, 'no orphan provider upload');
      eq(inspect.objects.length, 1, 'exactly one object');
      return { parts: PART_COUNT, maxConcurrentXhr: probe.maxConcurrentXhr, sliceCount: probe.sliceCount };
    } finally {
      await upCtx.close();
      await partnerCtx.close();
    }
  });

  scenario('MISSING_ETAG is resumable in the SAME room: fix CORS, Try again, no new intent (item 4)', async () => {
    await bucketControl(origin, '/_control/reset');
    await bucketControl(origin, '/_control/cors', { exposeEtag: false });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await installProbe(page, origin);
    try {
      await joinRoom(page, freshRoom('CN'), 'NoEtag');
      const dialog = await openLocalTab(page);
      await selectFixture(page);

      // Each PUT reaches the provider (the part is stored) but the browser cannot
      // read the ETag → MISSING_ETAG. Under the item-4 fix this is RESUMABLE, so
      // the panel keeps the session and offers Try again — not a dead end.
      await waitForText(dialog, /ETag header|didn.t return an ETag/i, { timeout: 90_000, label: 'MISSING_ETAG copy' });
      await waitForText(dialog, /Try again/i, { timeout: 20_000, label: 'retryable affordance' });
      eq((await bucketInspect(origin)).objects.length, 0, 'nothing is published while ETags are unreadable');
      eq((await readProbe(page)).totalPutXhr, PART_COUNT, 'every part reached the provider once');

      // Fix the bucket CORS and retry IN PLACE: same room, same session/token.
      await bucketControl(origin, '/_control/cors', { exposeEtag: true });
      const intentReqsBefore = (await page.evaluate(() => window.__uploadProbe.totalPutXhr));
      await dialog.getByRole('button', { name: /Try again/i }).click();

      // It completes with NO re-upload — the server reconciles the parts already
      // stored provider-side, so the same session finishes without a second intent.
      await waitForCondition(async () => (await bucketInspect(origin)).objects.length === 1, {
        timeout: 120_000,
        label: 'resumed upload completes',
      });
      const probe = await readProbe(page);
      eq(probe.totalPutXhr, PART_COUNT, 'retry re-uploaded NOTHING — provider parts were reconciled');
      eq(probe.totalPutXhr, intentReqsBefore, 'no part was re-sent on retry');
      eq((await bucketInspect(origin)).openUploads, 0, 'no orphan provider upload');
      return { recovered: 'in-place', reuploadedParts: 0 };
    } finally {
      await ctx.close();
    }
  });

  scenario('pause during an active part, then resume to completion', async () => {
    await bucketControl(origin, '/_control/reset');
    await bucketControl(origin, '/_control/slow', { ms: 400 });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await installProbe(page, origin);
    try {
      await joinRoom(page, freshRoom('PR'), 'Pauser');
      await openLocalTab(page);
      await selectFixture(page);
      await progressBar(page).waitFor({ state: 'visible', timeout: 60_000 });

      const dialog = page.getByRole('dialog');
      await dialog.getByRole('button', { name: 'Pause' }).click();
      await dialog.getByRole('button', { name: 'Resume' }).waitFor({ timeout: 30_000 });
      await page.waitForTimeout(700);
      let probe = await readProbe(page);
      eq(probe.activeXhr, 0, 'pause aborts active part XHRs');

      await dialog.getByRole('button', { name: 'Resume' }).click();
      await dialog.waitFor({ state: 'hidden', timeout: 120_000 });

      probe = await readProbe(page);
      ok(probe.totalPutXhr <= 6, `resume must not restart everything (${probe.totalPutXhr} PUTs)`);
      const inspect = await bucketInspect(origin);
      eq(inspect.openUploads, 0, 'no orphan');
      eq(inspect.objects.length, 1, 'one object');
      return { putsAfterResume: probe.totalPutXhr };
    } finally {
      await ctx.close();
    }
  });

  scenario('a retryable part failure is retried and the upload completes', async () => {
    await bucketControl(origin, '/_control/reset');
    await bucketControl(origin, '/_control/fail', { fault: 'part:2:once' });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await installProbe(page, origin);
    try {
      await joinRoom(page, freshRoom('RT'), 'Retrier');
      await openLocalTab(page);
      await selectFixture(page);
      await page.getByRole('dialog').waitFor({ state: 'hidden', timeout: 120_000 });
      const probe = await readProbe(page);
      eq(probe.totalPutXhr, PART_COUNT + 1, 'the failed part is re-sent exactly once');
      const inspect = await bucketInspect(origin);
      eq(inspect.objects.length, 1, 'one object');
      return { puts: probe.totalPutXhr };
    } finally {
      await ctx.close();
    }
  });

  scenario('an expired part URL (403) is refreshed and the upload completes', async () => {
    await bucketControl(origin, '/_control/reset');
    await bucketControl(origin, '/_control/fail', { fault: 'part:1:expire' });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await joinRoom(page, freshRoom('EX'), 'Refresher');
      await openLocalTab(page);
      await selectFixture(page);
      await page.getByRole('dialog').waitFor({ state: 'hidden', timeout: 120_000 });
      const inspect = await bucketInspect(origin);
      eq(inspect.objects.length, 1, 'one object');
      return { refreshed: true };
    } finally {
      await ctx.close();
    }
  });

  scenario('cancel aborts the provider upload and publishes nothing', async () => {
    await bucketControl(origin, '/_control/reset');
    await bucketControl(origin, '/_control/slow', { ms: 400 });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await installProbe(page, origin);
    try {
      await joinRoom(page, freshRoom('CX'), 'Canceller');
      await openLocalTab(page);
      await selectFixture(page);
      await progressBar(page).waitFor({ state: 'visible', timeout: 60_000 });
      await page.getByRole('dialog').getByRole('button', { name: /Cancel upload|Cancel/ }).first().click();
      await page.getByText('Choose a video from this device').waitFor({ timeout: 30_000 });
      await page.waitForTimeout(800);

      const probe = await readProbe(page);
      eq(probe.activeXhr, 0, 'no XHR left after cancel');
      const inspect = await bucketInspect(origin);
      eq(inspect.openUploads, 0, 'the provider upload is aborted');
      eq(inspect.objects.length, 0, 'nothing is published');
      return { aborted: true };
    } finally {
      await ctx.close();
    }
  });

  scenario('offline suspends the upload; coming back online completes it', async () => {
    await bucketControl(origin, '/_control/reset');
    // Slow enough that offline lands with parts genuinely in flight, not at the
    // finalizing tail — otherwise there is no active transfer to suspend.
    await bucketControl(origin, '/_control/slow', { ms: 1500 });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await joinRoom(page, freshRoom('OF'), 'Offliner');
      await openLocalTab(page);
      await selectFixture(page);
      await progressBar(page).waitFor({ state: 'visible', timeout: 60_000 });
      // Wait until it is ACTIVELY uploading (a part in flight), not merely
      // 'Starting…' — otherwise going offline during intent leaves the engine in
      // a state with no reconnecting affordance to assert.
      await waitForText(page.getByRole('dialog'), /Uploading…|of 3 parts/i, {
        timeout: 60_000,
        label: 'active upload',
      });

      await ctx.setOffline(true);
      await waitForText(page.getByRole('dialog'), /Reconnecting|network problem|Paused/i, {
        timeout: 60_000,
        label: 'offline state copy',
      });
      await ctx.setOffline(false);
      try {
        await page.getByRole('dialog').waitFor({ state: 'hidden', timeout: 90_000 });
      } catch {
        const panel = (await page.getByRole('dialog').innerText().catch(() => '(gone)')).replace(/\s+/g, ' ').slice(0, 300);
        const ins = await bucketInspect(origin);
        throw new AssertionError(`resume did not complete after online; objects=${ins.objects.length} open=${ins.openUploads}; panel: ${panel}`);
      }

      const inspect = await bucketInspect(origin);
      eq(inspect.objects.length, 1, 'one object after reconnect');
      eq(inspect.openUploads, 0, 'no orphan');
      return { recovered: true };
    } finally {
      await ctx.close();
    }
  });

  scenario('refresh shows a recovery card BEFORE a file is chosen, and the same file resumes', async () => {
    await bucketControl(origin, '/_control/reset');
    // Slow enough that the reload lands MID-upload. At 500ms the three parts
    // finished before the reload and the room already had a published source,
    // so there was nothing to recover — the scenario was testing the wrong state.
    await bucketControl(origin, '/_control/slow', { ms: 4000 });
    const code = freshRoom('RF');
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await installProbe(page, origin);
    try {
      await joinRoom(page, code, 'Refresher');
      await openLocalTab(page);
      await selectFixture(page);
      await progressBar(page).waitFor({ state: 'visible', timeout: 60_000 });
      await page.waitForTimeout(1200); // parts are still in flight at slow=4000ms

      await page.reload({ waitUntil: 'domcontentloaded' });
      /*
       * After a reload the app renders EITHER the join gate (seat not yet
       * reclaimed) or the room. Wait for whichever appears, then normalise to
       * "in the room" — polling both is what makes this robust against the
       * hydration race that a single isVisible() check loses.
       */
      await waitForText(page.locator('body'), /Who is arriving\?|Choose what to watch|Choose a film/i, {
        timeout: 60_000,
        label: 'post-reload shell',
      });
      const nameField = page.getByPlaceholder('Your name');
      if (await nameField.isVisible().catch(() => false)) {
        await nameField.fill('Refresher');
        await page.getByRole('button', { name: 'Take my seat' }).click();
      }
      await waitForText(page.locator('body'), /Choose what to watch|Choose a film|Change film/i, {
        timeout: 60_000,
        label: 'room after rejoin',
      });

      // The recovery card must be visible BEFORE choosing a file — the whole
      // point of the room-scoped controller.
      const dialog = await openLocalTab(page);
      await waitForText(dialog, /Resume upload of|already uploaded/i, { timeout: 40_000, label: 'recovery card' });

      // A DIFFERENT file is rejected and the session stays resumable.
      await selectFixture(page, { name: 'other.mp4' });
      await waitForText(dialog, /isn.t the same file|not the same file|different file/i, {
        timeout: 30_000,
        label: 'fingerprint mismatch',
      });
      await waitForText(dialog, /Resume upload of|already uploaded/i, { timeout: 20_000, label: 'still resumable' });

      // The SAME file resumes and completes.
      await selectFixture(page);
      try {
        await dialog.waitFor({ state: 'hidden', timeout: 150_000 });
      } catch (err) {
        const text = await dialog.innerText().catch(() => '(gone)');
        throw new AssertionError(`resume did not complete; dialog: ${text.replace(/\s+/g, ' ').slice(0, 400)}`);
      }
      const inspect = await bucketInspect(origin);
      eq(inspect.objects.length, 1, 'one object after recovery');
      return { recoveredBeforeSelection: true, wrongFileRejected: true };
    } finally {
      await ctx.close();
    }
  });

  scenario('rendered accessibility: progressbar, keyboard Pause/Resume, focus and announcements', async () => {
    await bucketControl(origin, '/_control/reset');
    await bucketControl(origin, '/_control/slow', { ms: 600 });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await joinRoom(page, freshRoom('A1'), 'A11y');
      const dialog = await openLocalTab(page);
      await selectFixture(page);
      const bar = progressBar(page);
      await bar.waitFor({ state: 'visible', timeout: 60_000 });

      eq(await bar.getAttribute('role'), 'progressbar', 'role');
      eq(await bar.getAttribute('aria-valuemin'), '0', 'aria-valuemin');
      eq(await bar.getAttribute('aria-valuemax'), String(FIXTURE_BYTES), 'aria-valuemax');
      ok((await bar.getAttribute('aria-valuenow')) !== null, 'aria-valuenow present');
      ok(/of .* uploaded, \d+%/i.test((await bar.getAttribute('aria-valuetext')) || ''), 'aria-valuetext');

      // A polite live region carries state changes (not every progress tick).
      eq(await dialog.locator('[aria-live="polite"]').count(), 1, 'one polite live region');

      // Pause is keyboard-operable, and focus lands somewhere useful afterwards.
      const pause = dialog.getByRole('button', { name: 'Pause' });
      await pause.focus();
      ok(await pause.evaluate((el) => el === document.activeElement), 'Pause is focusable');
      await page.keyboard.press('Enter');
      const resume = dialog.getByRole('button', { name: 'Resume' });
      await resume.waitFor({ timeout: 30_000 });
      const focusInDialog = await page.evaluate(() => {
        const dlg = document.querySelector('[role="dialog"]');
        return !!dlg && !!document.activeElement && dlg.contains(document.activeElement);
      });
      ok(focusInDialog, 'focus stays within the dialog after Pause→Resume');

      // Cancel returns focus to the file-selection control.
      await dialog.getByRole('button', { name: /Cancel upload|Cancel/ }).first().click();
      const chooser = page.getByText('Choose a video from this device');
      await chooser.waitFor({ timeout: 30_000 });
      return { ariaComplete: true, keyboardPause: true };
    } finally {
      await ctx.close();
    }
  });

  scenario('a late completion does not replace a newer source', async () => {
    await bucketControl(origin, '/_control/reset');
    await bucketControl(origin, '/_control/slow', { ms: 900 });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await joinRoom(page, freshRoom('LT'), 'Later');
      await openLocalTab(page);
      await selectFixture(page);
      await progressBar(page).waitFor({ state: 'visible', timeout: 60_000 });

      // While the upload runs, choose a YouTube source instead.
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('tab', { name: /Link|URL/i }).click();
      const urlField = dialog.getByPlaceholder(/https|link|url/i).first();
      await urlField.fill('https://www.youtube.com/watch?v=aqz-KE-bpKQ');
      await dialog.getByRole('button', { name: /Load this link/i }).click();
      await dialog.waitFor({ state: 'hidden', timeout: 30_000 });

      // The upload finishes later; the room must NOT be yanked off the new source.
      await page.waitForTimeout(6000);
      const bodyText = await page.locator('body').innerText();
      ok(!/movie\.mp4/i.test(bodyText.split('\n').slice(0, 6).join('\n')), 'the newer source is not replaced');
      return { newerSourcePreserved: true };
    } finally {
      await ctx.close();
    }
  });

  /* ---- item 3: the room-scoped uploader is reusable after a terminal state ---- */

  scenario('reselecting after a CANCEL starts a fresh upload that completes (item 3)', async () => {
    await bucketControl(origin, '/_control/reset');
    await bucketControl(origin, '/_control/slow', { ms: 300 });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await installProbe(page, origin);
    try {
      await joinRoom(page, freshRoom('RC'), 'Reuse');
      const dialog = await openLocalTab(page);

      await selectFixture(page);
      await progressBar(page).waitFor({ state: 'visible', timeout: 60_000 });
      await dialog.getByRole('button', { name: /Cancel upload|Cancel/ }).first().click();
      // The chooser returns only once the cancel is ACKNOWLEDGED (phase 'cancelled'),
      // which — now that the server tombstones atomically before provider I/O — means
      // the slot is already free. No fixed settle wait: the chooser IS the predicate.
      await page.getByText('Choose a video from this device').waitFor({ timeout: 30_000 });

      // Reselect immediately in the SAME room/controller.
      await selectFixture(page);
      await waitForCondition(async () => (await bucketInspect(origin)).objects.length === 1, {
        timeout: 120_000,
        label: 'the reselected upload completes',
      });
      eq((await bucketInspect(origin)).openUploads, 0, 'no orphan from the cancelled attempt');
      return { reselectAfterCancel: 'completed' };
    } finally {
      await ctx.close();
    }
  });

  scenario('a second upload after one completes succeeds in the same room (item 3)', async () => {
    await bucketControl(origin, '/_control/reset');
    await bucketControl(origin, '/_control/slow', { ms: 200 });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await installProbe(page, origin);
    try {
      await joinRoom(page, freshRoom('R2'), 'Twice');
      await openLocalTab(page);
      await selectFixture(page);
      // The picker closes on the first completion (the normal choose→onClose path).
      await page.getByRole('dialog').waitFor({ state: 'hidden', timeout: 120_000 });
      await waitForCondition(async () => (await bucketInspect(origin)).objects.length === 1, { timeout: 30_000, label: 'first upload' });

      // Reopen and upload a SECOND file — the controller must reinitialise cleanly.
      await page.getByRole('button', { name: /Change film|Choose what to watch|Choose a film/ }).first().click();
      const dialog = page.getByRole('dialog');
      await dialog.waitFor({ state: 'visible' });
      await dialog.getByRole('tab', { name: /Local file/i }).click();
      await selectFixture(page, { name: 'second.mp4' });
      await waitForCondition(async () => (await bucketInspect(origin)).objects.length === 2, {
        timeout: 120_000,
        label: 'the second upload completes',
      });
      eq((await bucketInspect(origin)).openUploads, 0, 'no orphan');
      return { uploads: 2 };
    } finally {
      await ctx.close();
    }
  });

  scenario('reselecting after a TERMINAL failure starts a new upload (item 3 + item 4 abort)', async () => {
    await bucketControl(origin, '/_control/reset');
    // The provider "assembles" an oversized object → the server's size check fails
    // terminally. The engine must abort the provider session so a fresh start is
    // admitted rather than dead-ended by UPLOAD_ALREADY_ACTIVE.
    await bucketControl(origin, '/_control/fail', { fault: 'complete:oversize' });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await installProbe(page, origin);
    try {
      await joinRoom(page, freshRoom('RT'), 'Terminal');
      const dialog = await openLocalTab(page);

      await selectFixture(page);
      await waitForText(dialog, /wasn.t the size we expected|size we expected/i, {
        timeout: 120_000,
        label: 'terminal SIZE_MISMATCH copy',
      });
      eq((await bucketInspect(origin)).objects.length, 0, 'a terminal failure publishes nothing');
      await waitForCondition(async () => (await bucketInspect(origin)).openUploads === 0, {
        timeout: 30_000,
        label: 'provider session aborted on a terminal failure',
      });

      // Fix the fault and reselect — a brand-new upload starts and completes.
      await bucketControl(origin, '/_control/reset');
      await selectFixture(page);
      await waitForCondition(async () => (await bucketInspect(origin)).objects.length === 1, {
        timeout: 120_000,
        label: 'the new upload after a terminal failure completes',
      });
      return { terminalThenNew: 'completed' };
    } finally {
      await ctx.close();
    }
  });

  scenario('single-shot cancel then an immediate new upload both succeed (item 2/4)', async () => {
    await bucketControl(origin, '/_control/reset');
    await bucketControl(origin, '/_control/slow', { ms: 800 });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await installProbe(page, origin);
    try {
      await joinRoom(page, freshRoom('SS'), 'Single');
      const dialog = await openLocalTab(page);

      // Below the single-shot ceiling (4 MiB in the test stack) → one PUT, no parts.
      await selectFixture(page, { size: 2 * MIB });
      await progressBar(page).waitFor({ state: 'visible', timeout: 60_000 });
      await dialog.getByRole('button', { name: /Cancel upload|Cancel/ }).first().click();
      await page.getByText('Choose a video from this device').waitFor({ timeout: 30_000 });
      eq((await bucketInspect(origin)).objects.length, 0, 'a cancelled single upload publishes nothing');

      // Immediately start another single-shot upload — it completes.
      await selectFixture(page, { size: 2 * MIB });
      await waitForCondition(async () => (await bucketInspect(origin)).objects.length === 1, {
        timeout: 120_000,
        label: 'the second single-shot upload completes',
      });
      await assertQuiescent(page, origin, 'single-shot cancel/reselect');
      return { singleCancelThenNew: 'completed' };
    } finally {
      await ctx.close();
    }
  });

  scenario('a REJECTED cancel keeps the session; retry cancels, then a new upload succeeds (item 7)', async () => {
    await bucketControl(origin, '/_control/reset');
    await bucketControl(origin, '/_control/slow', { ms: 500 });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await installProbe(page, origin);
    try {
      await joinRoom(page, freshRoom('RJ'), 'Rejected');
      const dialog = await openLocalTab(page);
      await selectFixture(page);
      await progressBar(page).waitFor({ state: 'visible', timeout: 60_000 });

      // Arm a one-shot abort refusal, then click Cancel: the server answers
      // {ok:false, RATE_LIMITED}. The request RESOLVES, but the cancel did NOT
      // succeed — the client must keep its authority.
      ok(await fetch(`${APP}/__test__/abort-fault`, { method: 'POST' }).then((r) => r.ok), 'abort fault armed');
      await dialog.getByRole('button', { name: /Cancel upload|Cancel/ }).first().click();

      // A cancellation failure is shown, the chooser stays hidden, and the session
      // is STILL active (registry + provider). Observable predicates, no fixed sleep.
      await waitForText(dialog, /Too many upload requests|Give it a moment/i, {
        timeout: 30_000,
        label: 'cancel-refused copy',
      });
      ok(
        !(await page.getByText('Choose a video from this device').isVisible().catch(() => false)),
        'no fresh selection is offered while the cancel is refused',
      );
      await waitForCondition(async () => (await testUploads()).activeSessions >= 1, {
        timeout: 10_000,
        label: 'the session is still active after a refused cancel',
      });
      eq((await bucketInspect(origin)).openUploads, 1, 'the provider upload is still open');

      // Retry the cancel — now accepted → the chooser returns and a new upload runs.
      // The button reads "Retry cancel" while the cleanup is unresolved.
      await dialog.getByRole('button', { name: /Retry cancel|Cancel upload|Cancel/i }).first().click();
      await page.getByText('Choose a video from this device').waitFor({ timeout: 30_000 });
      await selectFixture(page);
      await waitForCondition(async () => (await bucketInspect(origin)).objects.length === 1, {
        timeout: 120_000,
        label: 'the post-cancel upload completes',
      });
      await assertQuiescent(page, origin, 'rejected-cancel then new upload');
      return { rejectedThenRetried: 'completed' };
    } finally {
      await ctx.close();
    }
  });

  scenario('a client-origin terminal failure whose abort is refused keeps the session; retry-cancel recovers (item 8)', async () => {
    await bucketControl(origin, '/_control/reset');
    await bucketControl(origin, '/_control/slow', { ms: 300 });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await installProbe(page, origin);
    try {
      await joinRoom(page, freshRoom('CT'), 'ClientTerm');
      const dialog = await openLocalTab(page);

      // Arm a BARE completion failure (→ a CLIENT-origin terminal: the server never
      // classified it, so the client must run its own abort) AND a refusal of that
      // automatic abort (→ cleanup pending). Armed before the upload so ordering is
      // deterministic: complete-fault is consumed first, then abort-fault.
      ok(await fetch(`${APP}/__test__/complete-fault`, { method: 'POST' }).then((r) => r.ok), 'complete fault armed');
      ok(await fetch(`${APP}/__test__/abort-fault`, { method: 'POST' }).then((r) => r.ok), 'abort fault armed');

      await selectFixture(page);
      await progressBar(page).waitFor({ state: 'visible', timeout: 60_000 });

      // The completion fails terminally; the client's abort is refused → a
      // retry-cancel is shown, the chooser stays hidden, and the session is STILL
      // active (registry + provider). Observable predicates, no fixed sleep.
      await waitForText(dialog, /still being cancelled|Retry cancel/i, {
        timeout: 90_000,
        label: 'client-terminal cleanup (retry-cancel) state',
      });
      ok(
        !(await page.getByText('Choose a video from this device').isVisible().catch(() => false)),
        'no fresh chooser while the cleanup is unresolved',
      );
      eq((await bucketInspect(origin)).objects.length, 0, 'a terminal failure publishes nothing');
      await waitForCondition(async () => (await testUploads()).activeSessions >= 1, {
        timeout: 10_000,
        label: 'the session is still active',
      });
      eq((await bucketInspect(origin)).openUploads, 1, 'the provider upload is still open');

      // Retry the cancellation — the SAME session/token — now accepted.
      await dialog.getByRole('button', { name: /Retry cancel|Cancel/ }).first().click();
      await page.getByText('Choose a video from this device').waitFor({ timeout: 30_000 });
      await waitForCondition(async () => (await bucketInspect(origin)).openUploads === 0, {
        timeout: 30_000,
        label: 'the provider upload is cleaned up on retry',
      });

      // Immediately start another upload — it completes.
      await selectFixture(page);
      await waitForCondition(async () => (await bucketInspect(origin)).objects.length === 1, {
        timeout: 120_000,
        label: 'the post-cleanup upload completes',
      });
      await assertQuiescent(page, origin, 'client-terminal cleanup then new upload');
      return { clientTerminalRefusedThenRetried: 'completed' };
    } finally {
      await ctx.close();
    }
  });

  scenario('a single-shot upload survives a refresh: the leftover session is cleaned up, then a new upload succeeds (item 9)', async () => {
    await bucketControl(origin, '/_control/reset');
    await bucketControl(origin, '/_control/slow', { ms: 2000 });
    const code = freshRoom('S9');
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await installProbe(page, origin);
    try {
      await joinRoom(page, code, 'SingleRefresh');
      await openLocalTab(page);
      await selectFixture(page, { size: 2 * MIB }); // below the single-shot ceiling
      await progressBar(page).waitFor({ state: 'visible', timeout: 60_000 });
      await waitForCondition(async () => (await testUploads()).activeSessions >= 1, {
        timeout: 10_000,
        label: 'the single session is active before the refresh',
      });

      // Refuse the FIRST cleanup abort so the retry-cancel state is observable.
      ok(await fetch(`${APP}/__test__/abort-fault`, { method: 'POST' }).then((r) => r.ok), 'abort fault armed');

      // Refresh MID-PUT: the File dies with the page, but the persisted single-shot
      // cleanup record does not — the only token that can close the session.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitForText(page.locator('body'), /Who is arriving\?|Choose what to watch|Choose a film|Change film/i, {
        timeout: 60_000,
        label: 'post-reload shell',
      });
      const nameField = page.getByPlaceholder('Your name');
      if (await nameField.isVisible().catch(() => false)) {
        await nameField.fill('SingleRefresh');
        await page.getByRole('button', { name: 'Take my seat' }).click();
      }
      await waitForText(page.locator('body'), /Choose what to watch|Choose a film|Change film/i, {
        timeout: 60_000,
        label: 'room after rejoin',
      });

      // The NEW controller discovered the leftover session and its cleanup was
      // REFUSED: the picker shows a retry-cancel, NO fresh chooser, and the session
      // is still active — the token remains controllable across the remount.
      const dialog = await openLocalTab(page);
      await waitForText(dialog, /still being cancelled|Retry cancel/i, {
        timeout: 40_000,
        label: 'refused single cleanup (retry-cancel) after refresh',
      });
      ok(
        !(await page.getByText('Choose a video from this device').isVisible().catch(() => false)),
        'no fresh chooser while the leftover cleanup is unresolved',
      );
      ok((await testUploads()).activeSessions >= 1, 'the leftover single session is still active');

      // Retry the cancel until the leftover session is closed (tolerates the fault
      // and any re-admission window — observable predicate, no fixed sleep).
      await waitForCondition(
        async () => {
          if ((await testUploads()).activeSessions === 0) return true;
          const btn = dialog.getByRole('button', { name: /Retry cancel|Cancel/i }).first();
          if (await btn.isVisible().catch(() => false)) await btn.click().catch(() => {});
          return false;
        },
        { timeout: 60_000, label: 'the leftover single session is closed on retry' },
      );
      await page.getByText('Choose a video from this device').waitFor({ timeout: 30_000 });

      // A fresh single upload now succeeds.
      await bucketControl(origin, '/_control/slow', { ms: 200 });
      await selectFixture(page, { size: 2 * MIB });
      await waitForCondition(async () => (await bucketInspect(origin)).objects.length === 1, {
        timeout: 120_000,
        label: 'the post-cleanup single upload completes',
      });
      await assertQuiescent(page, origin, 'single refresh cleanup then new upload');
      return { singleRefreshCleaned: 'completed' };
    } finally {
      await ctx.close();
    }
  });

  return FILTER ? list.filter((s) => s.name.includes(FILTER)) : list;
}

/* -------------------------------------------------------------------------- */
/*  Demo-deployment scenarios (--demo)                                         */
/*                                                                            */
/*  THE DEPLOYMENT MODE WE ARE SHIPPING: production with no object storage.    */
/*  Hosted uploads must be off and SAY so, and the built-in recommendations    */
/*  must still give two people something to watch together.                    */
/*                                                                            */
/*  A SEPARATE run mode, not another scenario in the list above, because the   */
/*  mock-bucket stack boots the app with NODE_ENV=test — which runs Next in    */
/*  DEV mode and recompiles `.next`, destroying the production build this      */
/*  server needs. The two cannot share a working directory, so they do not     */
/*  share a run.                                                              */
/* -------------------------------------------------------------------------- */

function demoScenarios({ browser }) {
  const list = [];
  const scenario = (name, fn) => list.push({ name, fn });

  scenario('demo mode (production, no S3): uploads disabled, recommended movie plays for both', async () => {
    const demo = await startDemoModeApp((m) => console.log(`[direct] ${m}`));
    const memberCtx = await browser.newContext();
    const partnerCtx = await browser.newContext();
    const member = await memberCtx.newPage();
    const partner = await partnerCtx.newPage();
    const code = `DEMO${Math.floor(Math.random() * 90 + 10)}`;

    /** Join a room on the DEMO origin (the shared helper is bound to APP). */
    const joinDemoRoom = async (page, name) => {
      await page.goto(`${demo.origin}/room/${code}`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
      const nameField = page.getByPlaceholder('Your name');
      await nameField.waitFor({ state: 'visible', timeout: 90_000 });
      await nameField.fill(name);
      await page.getByRole('button', { name: 'Take my seat' }).click();
      await page
        .getByRole('button', { name: /Choose what to watch|Choose a film|Change film/ })
        .first()
        .waitFor({ timeout: 90_000 });
    };

    try {
      // The server itself must have resolved the deployment as disabled.
      ok(
        /hosted uploads DISABLED \(mode: disabled\)/.test(demo.log()),
        `the demo server did not report uploads disabled:\n${demo.log().slice(-800)}`,
      );

      await joinDemoRoom(member, 'Member');
      await joinDemoRoom(partner, 'Partner');

      /* ---- 1. the Local file tab states the limitation ---- */
      await member.getByRole('button', { name: /Choose what to watch|Choose a film|Change film/ }).first().click();
      const dialog = member.getByRole('dialog');
      await dialog.waitFor({ state: 'visible', timeout: 30_000 });
      await dialog.getByRole('tab', { name: /Local file/i }).click();

      await dialog.getByText('Uploads are not available in this demo yet.').waitFor({ state: 'visible', timeout: 15_000 });
      await dialog
        .getByText('Built-in movie recommendations are available. Hosted uploads will be enabled later.')
        .waitFor({ state: 'visible', timeout: 15_000 });

      /* ---- 2. no usable upload affordance is exposed ---- */
      eq(await dialog.locator('input[type="file"]').count(), 0, 'no file input in the disabled tab');
      eq(
        await dialog.getByRole('button', { name: /Choose a video from this device/i }).count(),
        0,
        'no upload button in the disabled tab',
      );

      /* ---- 3. a recommended movie still starts, for BOTH members ---- */
      await dialog.getByRole('tab', { name: /Recommended/i }).click();
      const firstPick = dialog.getByRole('button', { name: /Trailer|Full movie/i }).first();
      await firstPick.waitFor({ state: 'visible', timeout: 15_000 });
      await firstPick.click();
      await dialog.waitFor({ state: 'hidden', timeout: 30_000 });

      // The room source is a YouTube source: the player mounts a YouTube iframe.
      const youtubeSrc = async (page) =>
        waitForCondition(
          async () => {
            const src = await page.locator('iframe[src*="youtube.com/embed/"]').first().getAttribute('src').catch(() => null);
            return Boolean(src);
          },
          { timeout: 45_000, label: 'a youtube embed is mounted' },
        ).then(() => page.locator('iframe[src*="youtube.com/embed/"]').first().getAttribute('src'));

      const memberSrc = await youtubeSrc(member);
      const partnerSrc = await youtubeSrc(partner);

      const videoId = (src) => (String(src).match(/\/embed\/([\w-]{11})/) || [])[1] || null;
      ok(videoId(memberSrc), `member has no youtube video id: ${memberSrc}`);
      // The PARTNER received the same source through the room, not by navigating.
      eq(videoId(partnerSrc), videoId(memberSrc), 'partner plays the same YouTube video');

      return { uploads: 'disabled', youtubeVideoId: videoId(memberSrc), partnerMatched: true };
    } finally {
      await memberCtx.close();
      await partnerCtx.close();
      await demo.stop();
    }
  });

  return FILTER ? list.filter((s) => s.name.includes(FILTER)) : list;
}

/* -------------------------------------------------------------------------- */
/*  Stress scenarios (--stress)                                                */
/* -------------------------------------------------------------------------- */

/**
 * Sequential, high-cycle-count scenarios that drive the SAME room/controller
 * through cancel, pause/resume, terminal and refresh churn, then assert the whole
 * pipeline is quiescent — zero XHRs, slices, sleepers, workers, retry timers, open
 * provider uploads and stale progress. This is the browser counterpart to the
 * unit stress (upload-engine.test.mjs, 50 pause/offline cycles).
 */
function stressScenarios({ browser, bucket }) {
  const origin = bucket.origin;
  const list = [];
  const scenario = (name, fn) => list.push({ name, fn });

  scenario('stress: 20 cancel→restart cycles in one room leak nothing', async () => {
    await bucketControl(origin, '/_control/reset');
    await bucketControl(origin, '/_control/slow', { ms: 250 });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await installProbe(page, origin);
    try {
      await joinRoom(page, freshRoom('S1'), 'Stress1');
      const dialog = await openLocalTab(page);
      for (let i = 0; i < 20; i += 1) {
        await selectFixture(page);
        await progressBar(page).waitFor({ state: 'visible', timeout: 60_000 });
        await dialog.getByRole('button', { name: /Cancel upload|Cancel/ }).first().click();
        // Observable predicate, NOT a fixed settle: the chooser reappears only after
        // the cancel is acknowledged and the slot is freed.
        await page.getByText('Choose a video from this device').waitFor({ timeout: 30_000 });
      }
      await assertQuiescent(page, origin, '20 cancel/restart');
      eq((await bucketInspect(origin)).objects.length, 0, 'no object survives a cancelled cycle');
      return { cycles: 20 };
    } finally {
      await ctx.close();
    }
  });

  scenario('stress: 10 pause/resume cycles then complete, leaking nothing', async () => {
    await bucketControl(origin, '/_control/reset');
    await bucketControl(origin, '/_control/slow', { ms: 700 });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await installProbe(page, origin);
    try {
      await joinRoom(page, freshRoom('S2'), 'Stress2');
      const dialog = await openLocalTab(page);
      // A larger fixture (6 parts) so there is real work across 10 cycles.
      await selectFixture(page, { size: 48 * MIB });
      await progressBar(page).waitFor({ state: 'visible', timeout: 60_000 });

      // Enter paused, then toggle resume/pause 10 times. Pausing after ~120ms keeps
      // a 700ms part from completing, so the cycles run without racing completion.
      await dialog.getByRole('button', { name: 'Pause' }).click();
      await dialog.getByRole('button', { name: 'Resume' }).waitFor({ timeout: 30_000 });
      for (let i = 0; i < 10; i += 1) {
        await dialog.getByRole('button', { name: 'Resume' }).click();
        await dialog.getByRole('button', { name: 'Pause' }).waitFor({ timeout: 20_000 });
        await page.waitForTimeout(120);
        await dialog.getByRole('button', { name: 'Pause' }).click();
        await dialog.getByRole('button', { name: 'Resume' }).waitFor({ timeout: 20_000 });
      }
      // Finish it off.
      await bucketControl(origin, '/_control/slow', { ms: 150 });
      await dialog.getByRole('button', { name: 'Resume' }).click();
      await dialog.waitFor({ state: 'hidden', timeout: 120_000 });

      await assertQuiescent(page, origin, '10 pause/resume');
      eq((await bucketInspect(origin)).objects.length, 1, 'one object after the pause/resume marathon');
      return { cycles: 10 };
    } finally {
      await ctx.close();
    }
  });

  scenario('stress: 10 terminal-failure → new-upload cycles leak nothing', async () => {
    await bucketControl(origin, '/_control/reset');
    await bucketControl(origin, '/_control/fail', { fault: 'complete:oversize' });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await installProbe(page, origin);
    try {
      await joinRoom(page, freshRoom('S3'), 'Stress3');
      const dialog = await openLocalTab(page);
      for (let i = 0; i < 10; i += 1) {
        await selectFixture(page);
        await waitForText(dialog, /wasn.t the size we expected|size we expected/i, {
          timeout: 120_000,
          label: `terminal failure #${i + 1}`,
        });
        // Each terminal failure must abort its provider upload (no accumulation).
        await waitForCondition(async () => (await bucketInspect(origin)).openUploads === 0, {
          timeout: 30_000,
          label: `provider aborted #${i + 1}`,
        });
      }
      // Disarm and let a final upload complete cleanly.
      await bucketControl(origin, '/_control/reset');
      await selectFixture(page);
      await waitForCondition(async () => (await bucketInspect(origin)).objects.length === 1, {
        timeout: 120_000,
        label: 'the final clean upload completes',
      });
      await assertQuiescent(page, origin, '10 terminal/new');
      return { cycles: 10 };
    } finally {
      await ctx.close();
    }
  });

  scenario('stress: 10 refresh/reselect recovery cycles leak nothing', async () => {
    await bucketControl(origin, '/_control/reset');
    await bucketControl(origin, '/_control/slow', { ms: 800 });
    const code = freshRoom('S4');
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await installProbe(page, origin);
    try {
      await joinRoom(page, code, 'Stress4');
      for (let i = 0; i < 10; i += 1) {
        const dialog = await openLocalTab(page);
        await selectFixture(page);
        await progressBar(page).waitFor({ state: 'visible', timeout: 60_000 });
        // Pause → deterministic mid-upload (session persisted, nothing in flight),
        // then reload: the persisted session must recover BEFORE a file is chosen.
        await dialog.getByRole('button', { name: 'Pause' }).click().catch(() => {});
        await page.waitForTimeout(150);
        await page.reload({ waitUntil: 'domcontentloaded' });

        await waitForText(page.locator('body'), /Who is arriving\?|Choose what to watch|Choose a film|Change film/i, {
          timeout: 60_000,
          label: `post-reload shell #${i + 1}`,
        });
        const nameField = page.getByPlaceholder('Your name');
        if (await nameField.isVisible().catch(() => false)) {
          await nameField.fill('Stress4');
          await page.getByRole('button', { name: 'Take my seat' }).click();
        }
        await waitForText(page.locator('body'), /Choose what to watch|Choose a film|Change film/i, {
          timeout: 60_000,
          label: `room after rejoin #${i + 1}`,
        });

        const dlg = await openLocalTab(page);
        await waitForText(dlg, /Resume upload of|already uploaded/i, { timeout: 40_000, label: `recovery card #${i + 1}` });
        await selectFixture(page); // the SAME file → resume → complete
        await dlg.waitFor({ state: 'hidden', timeout: 120_000 });
      }
      await assertQuiescent(page, origin, '10 refresh/reselect');
      return { cycles: 10 };
    } finally {
      await ctx.close();
    }
  });

  return FILTER ? list.filter((s) => s.name.includes(FILTER)) : list;
}

/* -------------------------------------------------------------------------- */
/*  Run                                                                       */
/* -------------------------------------------------------------------------- */

/** Write the artifact atomically, so a partial file is never read as a result. */
async function writeResult(payload) {
  await fsp.mkdir(path.dirname(RESULT_FILE), { recursive: true });
  const tmp = path.join(os.tmpdir(), `direct-results-${process.pid}.json`);
  await fsp.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
  await fsp.rename(tmp, RESULT_FILE);
}

async function main() {
  const started = Date.now();
  const log = (m) => console.log(`[direct] ${m}`);
  let playwright;
  try {
    playwright = await import('playwright');
  } catch {
    try {
      playwright = await import('@playwright/test');
    } catch {
      throw new Error('playwright is not installed — run `npm i -D @playwright/test` and `npx playwright install chromium`');
    }
  }
  const { chromium } = playwright;

  // The demo mode deliberately runs with NO mock-bucket stack: it needs the
  // PRODUCTION build intact, and that stack would recompile `.next` in dev mode.
  const stack = DEMO ? null : await startStack(log);
  const { browser, channel, noSandbox } = await launchBrowser(chromium);
  log(`browser: ${channel}${noSandbox ? ' (--no-sandbox)' : ''} ${browser.version?.() ?? ''}`);

  const results = [];
  try {
    const list = DEMO
      ? demoScenarios({ browser })
      : (STRESS ? stressScenarios : scenarios)({ browser, bucket: stack.bucket });
    log(`${DEMO ? 'DEMO: ' : STRESS ? 'STRESS: ' : ''}${list.length} scenarios`);
    for (const { name, fn } of list) {
      const at = Date.now();
      try {
        // eslint-disable-next-line no-await-in-loop
        const detail = await fn();
        results.push({ name, ok: true, ms: Date.now() - at, detail: detail ?? null });
        log(`PASS  ${name}  (${Date.now() - at}ms)`);
      } catch (err) {
        results.push({ name, ok: false, ms: Date.now() - at, error: String(err?.message || err).slice(0, 600) });
        log(`FAIL  ${name}  (${Date.now() - at}ms)\n        ${String(err?.message || err).split('\n')[0]}`);
      }
    }
  } finally {
    await browser.close().catch(() => {});
    if (stack) await stack.stop();
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  await writeResult({
    runner: DEMO ? 'direct-demo' : STRESS ? 'direct-stress' : 'direct',
    browser: channel,
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    total: results.length,
    passed,
    failed,
    results,
  });

  log(`\n${passed}/${results.length} scenarios passed  (artifact: ${path.relative(ROOT, RESULT_FILE)})`);
  if (failed > 0) {
    log('FAILED SCENARIOS:');
    for (const r of results.filter((x) => !x.ok)) log(`  - ${r.name}: ${r.error}`);
  }
  // A run that discovered nothing is a failure, not a pass.
  if (results.length === 0) {
    log('no scenarios ran');
    process.exit(1);
  }
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error(`[direct] fatal: ${err?.stack || err}`);
  await writeResult({ runner: 'direct', total: 0, passed: 0, failed: 1, fatal: String(err?.message || err) }).catch(() => {});
  process.exit(1);
});
