/**
 * The release gate: everything that must pass before CineVerse ships.
 *
 *   npm run release:gate
 *
 * Owns its own server. It builds, starts a PRODUCTION process on an ephemeral
 * port, waits for `/readyz`, runs the realtime suite against it, runs the
 * process-lifecycle smoke test, and shuts everything down in `finally`. That
 * independence is the point: a gate that needs a dev server already running is
 * a gate that passes because of state nobody wrote down, and it is how CI ends
 * up with orphaned Node processes.
 *
 * Deliberately absent: retries. A flaky test that passes on the second attempt
 * is a failing test with the evidence thrown away.
 */

import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { discoverUnitTests, unitTestArgs, verifyE2eResultFile } from './release-gate-lib.mjs';
import { runLoggedChild, shutdownServer } from './child-process-lib.mjs';
import { validateE2eResult } from './e2e-stress-lib.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..');
const isWindows = process.platform === 'win32';
/** Short grace so the seat-expiry checks in the realtime suite stay quick. */
const E2E_GRACE_MS = process.env.ROOM_RECONNECT_GRACE_MS || '500';
const SERVER_START_TIMEOUT_MS = Number(process.env.GATE_START_TIMEOUT_MS) || 120_000;

const steps = [];
let startedAt = Date.now();

function heading(text) {
  console.log(`\n\x1b[1m── ${text} ${'─'.repeat(Math.max(0, 58 - text.length))}\x1b[0m`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* --------------------------------------------------------------------------
   Artifacts

   A failure whose output has scrolled away is a failure nobody can act on —
   which is exactly what happened to an intermittent realtime failure that was
   seen once and could not be identified afterwards. The realtime step now tees
   its output to disk as it streams, so the evidence survives regardless of how
   the console was captured.
   -------------------------------------------------------------------------- */
const ARTIFACT_DIR = path.join(
  ROOT,
  '.artifacts',
  'release-gate',
  `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`,
);

function artifactPath(name) {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  return path.join(ARTIFACT_DIR, name);
}

const relativeArtifacts = () => path.relative(ROOT, ARTIFACT_DIR).split(path.sep).join('/');

/**
 * Run a command to completion.
 *
 * With `logFile`, output is written to disk AND streamed to the console at the
 * same time — incrementally, never buffered whole in memory, so a long build
 * cannot exhaust the heap just to produce a log.
 */
function run(command, args, options = {}) {
  const teeing = Boolean(options.logFile);
  const child = spawn(command, args, {
    cwd: ROOT,
    stdio: teeing ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: { ...process.env, ...options.env },
    shell: false,
  });

  let sink = null;
  if (teeing) {
    sink = fs.createWriteStream(options.logFile, { flags: 'a' });
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk) => {
        process.stdout.write(chunk);
        sink.write(chunk);
      });
    }
  }

  // Settled on `close`, not `exit`: the process can be gone while its pipes
  // still hold the last chunk, and the lines lost that way are the final ones —
  // the failing assertion and the summary. See child-process-lib.mjs.
  return runLoggedChild(child, sink, `${path.basename(command)} ${args.join(' ')}`);
}

const node = (args, options) => run(process.execPath, args, options);

/** npm is a shell script on POSIX and a .cmd on Windows. */
function npm(args) {
  const bin = isWindows ? 'npm.cmd' : 'npm';
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: ROOT, stdio: 'inherit', shell: isWindows });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`npm ${args.join(' ')} exited ${code}`))));
  });
}

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

async function step(name, fn) {
  heading(name);
  const began = Date.now();
  try {
    await fn();
    steps.push({ name, ok: true, ms: Date.now() - began });
  } catch (err) {
    steps.push({ name, ok: false, ms: Date.now() - began, error: err.message });
    throw err;
  }
}

/* -------------------------------------------------------------------------- */

async function main() {
  startedAt = Date.now();
  console.log(`\n\x1b[1mCineVerse release gate\x1b[0m  (${process.platform}, node ${process.version})`);

  await step('typecheck', () => npm(['run', 'typecheck']));

  await step('production build', async () => {
    // The dev server shares `.next` with the build. Running both corrupts the
    // chunks under the live server, so the gate refuses rather than producing a
    // confusing half-broken app.
    await npm(['run', 'build']);
    if (!fs.existsSync(path.join(ROOT, '.next', 'BUILD_ID'))) {
      throw new Error('build produced no .next/BUILD_ID');
    }
  });

  await step('unit tests', async () => {
    // Enumerated, never globbed. A wildcard argument that fails to expand — or
    // expands to nothing — makes Node exit 0 having run no tests, so the gate
    // would report PASS while testing nothing at all. See release-gate-lib.mjs.
    const files = discoverUnitTests(ROOT);
    console.log(`  discovered ${files.length} unit-test files`);
    await node(unitTestArgs(files));
  });

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let server = null;
  let serverExit = null;
  let serverClosed = null;
  let serverSink = null;
  let serverLog = '';

  try {
    await step(`start production server on ${port}`, async () => {
      server = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NODE_ENV: 'production',
          PORT: String(port),
          HOST: '127.0.0.1',
          ROOM_RECONNECT_GRACE_MS: E2E_GRACE_MS,
        },
      });
      // Streamed to disk as it arrives; the in-memory copy is kept only so a
      // startup failure can be printed inline, and is bounded below.
      serverSink = fs.createWriteStream(artifactPath('server.log'), { flags: 'a' });
      const capture = (d) => {
        const text = d.toString();
        serverSink.write(text);
        serverLog = `${serverLog}${text}`.slice(-64_000);
      };
      server.stdout.on('data', capture);
      server.stderr.on('data', capture);
      // Flushing keys off CLOSE, in the shared shutdown helper — `exit` can fire
      // while the pipes still hold the server's final lines, which are the ones
      // a crash investigation needs. `exit` is watched separately, purely to
      // notice a server that dies during startup: a status observation, not
      // artifact flushing.
      serverExit = new Promise((resolve) => server.on('exit', (code, signal) => resolve({ code, signal })));
      serverClosed = new Promise((resolve) => server.on('close', resolve));

      // Either it becomes ready, or it dies, or we give up — never an unbounded wait.
      let died = false;
      serverExit.then(() => {
        died = true;
      });
      const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (died) throw new Error(`server exited during startup:\n${serverLog}`);
        try {
          const res = await fetch(`${base}/readyz`, { cache: 'no-store' });
          if (res.status === 200) {
            console.log(`  ready in ${((Date.now() - (deadline - SERVER_START_TIMEOUT_MS)) / 1000).toFixed(1)}s`);
            return;
          }
        } catch {
          /* not listening yet */
        }
        await sleep(300);
      }
      throw new Error(`server never reported ready:\n${serverLog}`);
    });

    await step('realtime E2E', async () => {
      const resultFile = artifactPath('e2e-result.json');
      await node(['scripts/e2e-realtime.js'], {
        env: { TEST_URL: base, E2E_RESULT_FILE: resultFile },
        logFile: artifactPath('e2e.log'),
      });

      // A zero exit is one signal; the artifact is the other. Requiring both to
      // exist AND agree turns "all four artifacts are written" into an enforced
      // contract rather than something the summary merely claims.
      const parsed = verifyE2eResultFile(resultFile, fs, validateE2eResult);
      console.log(`  result artifact verified: ${parsed.passed}/${parsed.total} checks`);
    });

    await step('process lifecycle smoke', () => node(['scripts/process-smoke.mjs']));

    await step('production build survived the run', async () => {
      // Dev and production share `.next`. If any step above accidentally started
      // a DEV server, it will have rewritten the build out from under the
      // artifact we just validated — a failure that is otherwise invisible
      // until deploy.
      if (!fs.existsSync(path.join(ROOT, '.next', 'BUILD_ID'))) {
        throw new Error('.next/BUILD_ID is gone — something started a dev server and clobbered the build');
      }
      console.log('  .next/BUILD_ID intact');
    });
  } finally {
    // `server.killed` is not a guard: it is false before any signal AND true for
    // a process that ignored one, so it says nothing about whether the server is
    // running. Shut down whenever a server was started.
    if (server) {
      heading('shutting down');
      // The same helper the soak and stress harnesses use.
      const stop = await shutdownServer(server, {
        exited: serverExit,
        closed: serverClosed,
        sink: serverSink,
        label: 'server.log',
        signal: isWindows ? 'SIGINT' : 'SIGTERM',
        graceMs: 15_000,
      });
      console.log(`  server exited=${stop.exited} graceful=${stop.graceful} forced=${stop.forced}`);

      // Three separate facts, each able to fail the gate on its own.
      if (!stop.exited) {
        throw new Error(`server never exited (graceful=${stop.graceful} forced=${stop.forced}) — a process leaked`);
      }
      if (!stop.closeObserved) {
        throw new Error('server stdio never closed — server.log may be truncated');
      }
      if (stop.logError) throw new Error(stop.logError);

      // Exit is not the same as port release: a lingering listener means
      // something else is still bound, which is what this gate exists to catch.
      await sleep(300);
      const stillUp = await fetch(`${base}/healthz`, { cache: 'no-store' }).then(
        () => true,
        () => false,
      );
      if (stillUp) throw new Error(`port ${port} is still being served — a process leaked`);
    }
  }

  return true;
}

/** A summary the next person can read without the console scrollback. */
function writeSummary(ok, error) {
  try {
    const summary = {
      ok,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      nodeVersion: process.version,
      platform: process.platform,
      steps: steps.map(({ name, ok: stepOk, ms, error: stepError }) => ({ name, ok: stepOk, ms, error: stepError })),
      error: error ? error.message : undefined,
    };
    fs.writeFileSync(artifactPath('gate-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  } catch {
    /* a summary that cannot be written must not mask the real result */
  }
}

function printSummary() {
  heading('summary');
  for (const s of steps) console.log(`  ${s.ok ? 'PASS' : 'FAIL'}  ${s.name}  (${(s.ms / 1000).toFixed(1)}s)`);
}

main()
  .then(() => {
    printSummary();
    writeSummary(true);
    console.log(`\n\x1b[32m✓ release gate passed\x1b[0m in ${((Date.now() - startedAt) / 1000).toFixed(1)}s\n`);
    process.exit(0);
  })
  .catch((err) => {
    printSummary();
    writeSummary(false, err);
    console.error(`\n\x1b[31m✗ release gate FAILED\x1b[0m: ${err.message}`);
    // The path is the whole point of writing artifacts — say it last, where a
    // truncated console still shows it.
    console.error(`Release artifacts: ${relativeArtifacts()}\n`);
    process.exit(1);
  });
