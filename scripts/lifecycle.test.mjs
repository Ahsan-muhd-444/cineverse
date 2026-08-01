/**
 * Unit tests for process readiness + graceful shutdown (server/lifecycle.js).
 *
 * The behaviours that matter here are ordering and idempotence — readiness must
 * drop before anything closes, and a second signal must not re-enter teardown.
 * Both are cheap to assert on the pure state machine and painful to observe by
 * spawning processes, so the process-level smoke test (scripts/process-smoke.mjs)
 * only has to prove the wiring, not the logic.
 *
 * Run:  node --test --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/lifecycle.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createLifecycle,
  healthResponse,
  readinessResponse,
  exitCodeFor,
  closeQuietly,
  runShutdown,
  describeFatal,
} = require('../server/lifecycle.js');

const silent = { error() {}, log() {} };

/* ---------------- readiness ---------------- */

test('a fresh process is alive but NOT ready', () => {
  const lc = createLifecycle();
  assert.equal(healthResponse(lc).status, 200, 'liveness is immediate');
  assert.equal(readinessResponse(lc).status, 503, 'readiness waits for the app');
});

test('readiness turns on once the app is prepared and listening', () => {
  const lc = createLifecycle();
  lc.markReady();
  const ready = readinessResponse(lc);
  assert.equal(ready.status, 200);
  assert.equal(ready.body.ready, true);
});

test('shutdown drops readiness immediately but keeps liveness', () => {
  const lc = createLifecycle();
  lc.markReady();
  lc.beginShutdown();
  assert.equal(readinessResponse(lc).status, 503, 'stop routing traffic here');
  assert.equal(healthResponse(lc).status, 200, 'but do not let the supervisor kill the drain');
  assert.equal(healthResponse(lc).body.shuttingDown, true);
});

test('a dying process can never be marked ready again', () => {
  const lc = createLifecycle();
  lc.beginShutdown();
  assert.equal(lc.markReady(), false);
  assert.equal(readinessResponse(lc).status, 503);
});

test('neither endpoint leaks anything identifying', () => {
  const lc = createLifecycle();
  lc.markReady();
  const body = JSON.stringify(readinessResponse(lc, { uptime: 12 }).body);
  for (const secret of ['code', 'name', 'token', 'password', 'file']) {
    assert.equal(body.includes(secret), false, `readiness body must not mention ${secret}`);
  }
});

/* ---------------- shutdown ---------------- */

test('a normal signal exits 0, a fatal error exits nonzero', () => {
  assert.equal(exitCodeFor('SIGTERM'), 0);
  assert.equal(exitCodeFor('SIGINT'), 0);
  assert.equal(exitCodeFor('uncaughtException'), 1);
  assert.equal(exitCodeFor('whatever'), 1);
});

test('shutdown runs its steps in order and then exits', async () => {
  const lc = createLifecycle();
  lc.markReady();
  const order = [];
  let exited = null;
  await runShutdown({
    lifecycle: lc,
    reason: 'SIGTERM',
    logger: silent,
    exit: (code) => {
      exited = code;
    },
    steps: [() => order.push('io'), () => order.push('http'), () => order.push('storage')],
  });
  assert.deepEqual(order, ['io', 'http', 'storage']);
  assert.equal(exited, 0);
});

test('a second signal is ignored — teardown never runs twice', async () => {
  const lc = createLifecycle();
  let runs = 0;
  const once = () => runShutdown({
    lifecycle: lc,
    reason: 'SIGTERM',
    logger: silent,
    exit: () => {},
    steps: [() => { runs += 1; }],
  });
  const first = await once();
  const second = await once();
  assert.equal(first, true, 'the first signal owns the shutdown');
  assert.equal(second, false, 'the second is a no-op');
  assert.equal(runs, 1);
});

test('one failing step does not abort the rest of the teardown', async () => {
  const lc = createLifecycle();
  const done = [];
  let exited = null;
  await runShutdown({
    lifecycle: lc,
    reason: 'SIGTERM',
    logger: silent,
    exit: (code) => {
      exited = code;
    },
    steps: [
      () => {
        throw new Error('socket close blew up');
      },
      () => done.push('http'),
      () => Promise.reject(new Error('storage unreachable')),
      () => done.push('timers'),
    ],
  });
  assert.deepEqual(done, ['http', 'timers'], 'later steps still ran');
  assert.equal(exited, 0, 'and the process still exits cleanly for a normal signal');
});

test('a hung teardown is forced out rather than hanging forever', async () => {
  const lc = createLifecycle();
  const exits = [];
  const shutdown = runShutdown({
    lifecycle: lc,
    reason: 'uncaughtException',
    timeoutMs: 20,
    logger: silent,
    exit: (code) => exits.push(code),
    steps: [() => new Promise((resolve) => setTimeout(resolve, 200))],
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(exits, [1], 'forced exit fired with the fatal code');
  await shutdown;
});

test('closing something already closed resolves instead of stalling', async () => {
  await closeQuietly(null);
  await closeQuietly({});
  await closeQuietly({
    close(cb) {
      cb(new Error('Server is not running'));
    },
  });
  await closeQuietly({
    close() {
      throw new Error('already closed');
    },
  });
  // Reaching here at all is the assertion: none of the above may hang.
  assert.ok(true);
});

test('a close callback that fires twice still settles once', async () => {
  let settles = 0;
  await closeQuietly({
    close(cb) {
      cb();
      cb();
    },
  }).then(() => {
    settles += 1;
  });
  assert.equal(settles, 1);
});

/* ---------------- fatal-error context ---------------- */

test('a fatal error is described with a stack and no invented fields', () => {
  const described = describeFatal('uncaughtException', new Error('boom'));
  assert.equal(described.reason, 'uncaughtException');
  assert.equal(described.message, 'boom');
  assert.match(described.stack, /boom/);
  assert.equal(typeof described.uptime, 'number');
});

test('a non-Error rejection is still described safely', () => {
  const described = describeFatal('unhandledRejection', 'just a string');
  assert.equal(described.message, 'just a string');
  assert.ok(described.stack, 'synthesised so the log always has a location');
});
