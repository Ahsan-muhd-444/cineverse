/**
 * Process-level smoke test: does a real CineVerse process boot, report itself
 * ready, and then shut down cleanly when told to?
 *
 * Deliberately NOT part of the realtime E2E suite. That suite talks to a server
 * someone else started; making it responsible for killing its own dev server is
 * how you get a test that passes locally and orphans a process in CI. This one
 * owns the whole lifetime of the child and always cleans up in `finally`.
 *
 *   node scripts/process-smoke.mjs            (builds are the caller's job)
 *   PORT=3421 node scripts/process-smoke.mjs
 *
 * Signals on Windows: Node only emulates them. `child.kill('SIGTERM')` there
 * terminates the process outright without running any handler, so the
 * clean-exit assertions cannot be made and are reported as SKIPPED rather than
 * quietly passing. Linux is the release environment and asserts everything.
 */

import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..');
const isWindows = process.platform === 'win32';
const results = [];
let failures = 0;
let skipped = 0;

function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition) });
  if (!condition) failures += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

function skip(name, why) {
  skipped += 1;
  console.log(`SKIP  ${name}  — ${why}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** An ephemeral port the OS just told us is free — no fixed-port collisions. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function probe(url) {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch (err) {
    return { status: 0, error: err.message };
  }
}

/** Poll readiness until it turns 200, or give up — never an unbounded wait. */
async function waitForReady(base, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await probe(`${base}/readyz`);
    if (last.status === 200) return last;
    await sleep(250);
  }
  return last;
}

async function main() {
  const port = Number(process.env.PORT) || (await freePort());
  const base = `http://127.0.0.1:${port}`;
  const startupTimeout = Number(process.env.SMOKE_STARTUP_TIMEOUT_MS) || 90_000;

  console.log(`\n— process smoke on ${base} (${process.platform}) —\n`);

  // PRODUCTION mode, always. Not just because that is what we are testing: a
  // Next DEV server rewrites `.next`, so starting one here would quietly
  // destroy the production build the rest of the gate depends on.
  if (!fs.existsSync(path.join(ROOT, '.next', 'BUILD_ID'))) {
    console.error('No production build found (.next/BUILD_ID). Run `npm run build` first.');
    process.exit(1);
  }

  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'production', PORT: String(port), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => {
    stdout += d.toString();
  });
  child.stderr.on('data', (d) => {
    stderr += d.toString();
  });

  const exited = new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  let childGone = false;
  child.on('exit', () => {
    childGone = true;
  });

  try {
    const ready = await waitForReady(base, startupTimeout);
    check('the server becomes ready within the startup window', ready?.status === 200,
      `status=${ready?.status ?? 'none'}`);
    if (ready?.status !== 200) {
      console.error('--- child stdout ---\n' + stdout);
      console.error('--- child stderr ---\n' + stderr);
      throw new Error('server never became ready');
    }

    check('/readyz reports ready and nothing identifying', ready.body?.ready === true &&
      !JSON.stringify(ready.body).match(/code|name|token|password/i), JSON.stringify(ready.body));

    const health = await probe(`${base}/healthz`);
    check('/healthz returns 200 while alive', health.status === 200, `status=${health.status}`);
    check('/healthz reports the process is not shutting down', health.body?.shuttingDown === false,
      JSON.stringify(health.body));

    /* ---- shutdown ---- */
    const beforeShutdown = Date.now();
    child.kill(isWindows ? 'SIGINT' : 'SIGTERM');

    const raced = await Promise.race([exited, sleep(15_000).then(() => null)]);
    check('the process exits after the shutdown signal', raced !== null,
      raced === null ? 'still running after 15s' : `code=${raced.code} signal=${raced.signal}`);
    if (raced === null) throw new Error('server did not exit');

    console.log(`      (exited in ${Date.now() - beforeShutdown}ms)`);

    if (isWindows) {
      skip('the process exits 0 for a normal signal',
        'Windows terminates on kill() without running signal handlers');
      skip('shutdown prints no stack trace', 'no handler runs, so there is nothing to print');
    } else {
      check('the process exits 0 for a normal signal', raced.code === 0,
        `code=${raced.code} signal=${raced.signal}`);
      check('shutdown prints no stack trace', !/\n\s+at\s/.test(stderr),
        stderr.split('\n').slice(0, 3).join(' | '));
      check('shutdown is announced in the log', /shutting down/i.test(stdout),
        stdout.trim().split('\n').slice(-1)[0] || '(no output)');
    }

    // Whatever the platform, the port must be genuinely released.
    await sleep(300);
    const afterExit = await probe(`${base}/healthz`);
    check('the server stops accepting connections once it is gone', afterExit.status === 0,
      afterExit.status === 0 ? afterExit.error : `still answering with ${afterExit.status}`);
  } finally {
    // Belt and braces: never leave a child behind, even on an assertion throw.
    if (!childGone) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      await Promise.race([exited, sleep(3000)]);
    }
  }

  const passed = results.length - failures;
  console.log(`\n${passed}/${results.length} checks passed${skipped ? `, ${skipped} skipped` : ''}`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error('smoke harness error:', error.message);
  process.exit(1);
});
