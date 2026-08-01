/**
 * Cold realtime stress harness — reproduce lifecycle races.
 *
 *   npm run test:e2e:stress
 *   E2E_ITERATIONS=50 npm run test:e2e:stress
 *   E2E_CONTINUE_AFTER_FAILURE=1 npm run test:e2e:stress   (frequency, not first-failure)
 *
 * Each iteration is a genuinely COLD server: a fresh process on a fresh
 * ephemeral port, waited for via `/readyz`, exercised once by the realtime
 * suite, then shut down and confirmed gone. That is the shape that produced the
 * failure this exists to catch — a single 228/229 run whose identity was lost —
 * and it is deliberately NOT what the release gate does. The gate runs the suite
 * once and fails; turning it into a retry loop would hide exactly this.
 *
 * Reuses the existing production build rather than rebuilding per iteration, so
 * 20 cold starts cost minutes rather than an hour. It never writes `.next`, never
 * touches the port-3000 development server, and preserves every iteration's logs.
 */

import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { validateE2eResult, positiveInteger, nonNegativeInteger } from './e2e-stress-lib.mjs';
import { runLoggedChild, shutdownServer } from './child-process-lib.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..');
const isWindows = process.platform === 'win32';

// Strict, and fatal on nonsense — BEFORE anything is spawned. `Number('-1') || 20`
// yields -1, and a loop that runs -1 times exits 0 having proved nothing: the
// precise failure mode this harness exists to detect.
const CONTINUE_AFTER_FAILURE = process.env.E2E_CONTINUE_AFTER_FAILURE === '1';
let ITERATIONS;
let GRACE_MS;
let START_TIMEOUT_MS;
try {
  ITERATIONS = positiveInteger(process.env.E2E_ITERATIONS, 20, 'E2E_ITERATIONS');
  // 0 is legitimate here: the reconnect grace can be disabled deliberately.
  GRACE_MS = String(nonNegativeInteger(process.env.ROOM_RECONNECT_GRACE_MS, 500, 'ROOM_RECONNECT_GRACE_MS'));
  START_TIMEOUT_MS = positiveInteger(
    process.env.E2E_STRESS_START_TIMEOUT_MS,
    90_000,
    'E2E_STRESS_START_TIMEOUT_MS',
  );
} catch (err) {
  console.error(`\nInvalid stress configuration: ${err.message}\n`);
  process.exit(1);
}

const RUN_DIR = path.join(
  ROOT,
  '.artifacts',
  'e2e-stress',
  `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`,
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const reachable = (url) => fetch(url, { cache: 'no-store' }).then((r) => r.status, () => 0);

/** Run one cold iteration end to end. Never throws for a test failure. */
async function iteration(index) {
  const dir = path.join(RUN_DIR, `iteration-${String(index).padStart(3, '0')}`);
  fs.mkdirSync(dir, { recursive: true });

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const began = Date.now();

  const serverLog = fs.createWriteStream(path.join(dir, 'server.log'));
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      HOST: '127.0.0.1',
      ROOM_RECONNECT_GRACE_MS: GRACE_MS,
    },
  });
  server.stdout.on('data', (d) => serverLog.write(d));
  server.stderr.on('data', (d) => serverLog.write(d));

  // `exit` is watched for STATUS (did the server die mid-run?); `closed` is what
  // artifact flushing keys off, because stdout can still hold the server's last
  // lines when `exit` fires.
  let serverExited = null;
  const exited = new Promise((resolve) =>
    server.on('exit', (code, signal) => {
      serverExited = { code, signal };
      resolve(serverExited);
    }),
  );
  const closed = new Promise((resolve) => server.on('close', resolve));

  const outcome = { index, port, dir: path.relative(ROOT, dir).split(path.sep).join('/') };

  try {
    /* ---- wait for readiness, or give up ---- */
    const deadline = Date.now() + START_TIMEOUT_MS;
    let ready = false;
    while (Date.now() < deadline && !ready) {
      // A child that dies during startup must fail the iteration immediately
      // rather than being waited out.
      if (serverExited) {
        outcome.ok = false;
        outcome.reason = `server exited during startup (code=${serverExited.code} signal=${serverExited.signal})`;
        return outcome;
      }
      ready = (await reachable(`${base}/readyz`)) === 200;
      if (!ready) await sleep(200);
    }
    if (!ready) {
      outcome.ok = false;
      outcome.reason = 'server never became ready';
      return outcome;
    }
    outcome.readyMs = Date.now() - began;

    /* ---- one realtime run, no retries ---- */
    const resultFile = path.join(dir, 'e2e-result.json');
    const e2eLog = fs.createWriteStream(path.join(dir, 'e2e.log'));
    const child = spawn(process.execPath, ['scripts/e2e-realtime.js'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TEST_URL: base, E2E_RESULT_FILE: resultFile, ROOM_RECONNECT_GRACE_MS: GRACE_MS },
    });
    child.stdout.on('data', (d) => e2eLog.write(d));
    child.stderr.on('data', (d) => e2eLog.write(d));

    // Settled on `close`, so the last lines of the suite are in the artifact
    // before it is read. A nonzero exit is an expected outcome here — a failing
    // run is data — so it resolves; a spawn failure or an unwritable log is not
    // a result and still rejects.
    let code = null;
    try {
      ({ code } = await runLoggedChild(child, e2eLog, 'realtime E2E', { allowNonZero: true }));
    } catch (err) {
      outcome.ok = false;
      outcome.reason = err.message;
      return outcome;
    }

    outcome.exitCode = code;

    /* ---- the result artifact is the evidence; a zero exit is not ---- */
    let parsed = null;
    if (!fs.existsSync(resultFile)) {
      outcome.ok = false;
      outcome.reason = 'no result file was written';
    } else {
      try {
        parsed = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
      } catch (err) {
        outcome.ok = false;
        outcome.reason = `unreadable result file: ${err.message}`;
      }
      if (parsed) {
        outcome.total = parsed.total;
        outcome.passed = parsed.passed;
        outcome.failed = parsed.failed;
        outcome.failures = parsed.failures;
        outcome.harnessError = parsed.harnessError;
        outcome.durationMs = parsed.durationMs;
        const verdict = validateE2eResult(parsed, code);
        outcome.ok = verdict.ok;
        if (!verdict.ok) outcome.reason = verdict.reason;
      }
    }

    if (serverExited) {
      outcome.ok = false;
      outcome.reason = `server exited mid-run (code=${serverExited.code} signal=${serverExited.signal})`;
    }
    return outcome;
  } finally {
    /* ---- shut down, then assert exit and port release SEPARATELY ---- */
    // Same helper as the soak and the release gate: one shutdown implementation,
    // so none of them can drift into asserting on the wrong field.
    const stop = await shutdownServer(server, {
      exited,
      closed,
      sink: serverLog,
      label: `iteration ${index} server.log`,
      signal: isWindows ? 'SIGINT' : 'SIGTERM',
      graceMs: 12_000,
    });
    if (stop.logError) {
      outcome.ok = false;
      outcome.reason = stop.logError;
    }
    // `forced` only means SIGKILL was attempted. Without an observed exit the
    // iteration cannot be trusted — a survivor would poison the next one.
    if (!stop.exited) {
      outcome.ok = false;
      outcome.reason = `server never exited (graceful=${stop.graceful} forced=${stop.forced})`;
    }
    if (!stop.closeObserved) {
      outcome.ok = false;
      outcome.reason = 'server stdio never closed — server.log may be truncated';
    }
    await sleep(200);
    if ((await reachable(`${base}/healthz`)) !== 0) {
      outcome.ok = false;
      outcome.reason = `port ${port} still served after shutdown — a process leaked`;
    }
  }
}

function describe(outcome) {
  if (outcome.ok) {
    return `PASS  iteration ${outcome.index}  ${outcome.passed}/${outcome.total} checks  ` +
      `(ready ${outcome.readyMs}ms, suite ${outcome.durationMs}ms, port ${outcome.port})`;
  }
  const counts = outcome.total ? `${outcome.passed}/${outcome.total} checks  ` : '';
  return `FAIL  iteration ${outcome.index}  ${counts}${outcome.reason || `exit ${outcome.exitCode}`}`;
}

function printFailureDetail(outcome) {
  console.log(`\n  artifacts: ${outcome.dir}`);
  if (outcome.harnessError) {
    console.log(`  harness error: ${outcome.harnessError.message}`);
  }
  for (const f of outcome.failures || []) {
    console.log(`  #${f.index} ${f.name}${f.detail ? ` — ${f.detail}` : ''}  [${f.elapsedMs}ms, section: ${f.section}]`);
  }
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, '.next', 'BUILD_ID'))) {
    console.error('\nNo production build found (.next/BUILD_ID). Run `npm run build` first.\n');
    process.exit(1);
  }
  fs.mkdirSync(RUN_DIR, { recursive: true });

  console.log(`\nCold realtime stress: ${ITERATIONS} iterations, grace ${GRACE_MS}ms`);
  console.log(`Artifacts: ${path.relative(ROOT, RUN_DIR).split(path.sep).join('/')}\n`);

  const outcomes = [];
  for (let i = 1; i <= ITERATIONS; i += 1) {
    const outcome = await iteration(i);
    outcomes.push(outcome);
    console.log(describe(outcome));
    if (!outcome.ok) {
      printFailureDetail(outcome);
      if (!CONTINUE_AFTER_FAILURE) {
        console.log('\nStopping at the first failure (set E2E_CONTINUE_AFTER_FAILURE=1 to measure frequency).');
        break;
      }
    }
  }

  // Belt and braces on top of the strict parse: a run that executed nothing must
  // never be reported as a success.
  if (outcomes.length === 0) {
    console.error('\nNo iterations ran — refusing to report success.\n');
    process.exit(1);
  }

  const failed = outcomes.filter((o) => !o.ok);
  fs.writeFileSync(
    path.join(RUN_DIR, 'summary.json'),
    `${JSON.stringify({ iterations: outcomes.length, requested: ITERATIONS, failed: failed.length, outcomes }, null, 2)}\n`,
  );

  console.log(`\n${outcomes.length - failed.length}/${outcomes.length} iterations passed` +
    (failed.length ? ` — ${failed.length} FAILED` : ''));

  // Every distinct failing check, so a frequency run reads at a glance.
  if (failed.length) {
    const tally = new Map();
    for (const o of failed) {
      for (const f of o.failures || []) {
        const key = `#${f.index} ${f.name}`;
        tally.set(key, (tally.get(key) || 0) + 1);
      }
    }
    if (tally.size) {
      console.log('\nFAILING CHECKS BY FREQUENCY');
      for (const [name, count] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${count}x  ${name}`);
      }
    }
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('stress harness error:', err.message);
  process.exit(1);
});
