/**
 * Process lifecycle: readiness, and one shutdown that actually finishes.
 *
 * Two things go wrong in a long-lived Node server, and both are invisible until
 * a deploy:
 *
 *  - a load balancer keeps sending traffic to a process that is on its way out,
 *    because "is the process alive" and "should it receive requests" are not the
 *    same question. Hence `/healthz` and `/readyz` being separate.
 *  - shutdown runs twice (SIGTERM arrives, then the platform sends SIGKILL, or a
 *    handler throws mid-teardown), so half-closed resources are closed again and
 *    the process hangs on the error instead of exiting.
 *
 * The state machine is deliberately tiny and pure so both can be unit-tested
 * without spawning anything (see scripts/lifecycle.test.mjs). The one impure
 * part — actually closing sockets — is injected as a list of steps.
 */

/** Longest a graceful shutdown may take before the process is forced out. */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * Readiness state for one process.
 *
 * `ready` is set once, when the app is prepared AND the HTTP server is
 * listening. It is cleared the instant shutdown begins — that ordering is the
 * whole point: readiness must go false BEFORE connections stop being accepted,
 * or in-flight requests get refused rather than drained.
 */
function createLifecycle() {
  let ready = false;
  let shuttingDown = false;

  return {
    markReady() {
      if (shuttingDown) return false; // too late — never resurrect a dying process
      ready = true;
      return true;
    },
    /**
     * Claim the shutdown. Returns false if one is already running, which is what
     * makes repeated signals (SIGTERM then SIGINT, or a fatal error during
     * teardown) idempotent instead of re-entrant.
     */
    beginShutdown() {
      if (shuttingDown) return false;
      shuttingDown = true;
      ready = false;
      return true;
    },
    isReady: () => ready,
    isShuttingDown: () => shuttingDown,
  };
}

/**
 * The answer `/healthz` should give: is this process alive at all?
 *
 * Deliberately still 200 while shutting down. A liveness probe that fails during
 * a graceful drain gets the container killed mid-drain, which is the opposite of
 * what draining is for.
 */
function healthResponse(lifecycle, details = {}) {
  return {
    status: 200,
    body: { ok: true, shuttingDown: lifecycle.isShuttingDown(), ...details },
  };
}

/**
 * The answer `/readyz` should give: should this process receive traffic?
 *
 * 503 both before the app has finished preparing and from the moment shutdown
 * starts. Nothing identifying goes in the body — no room codes, no names, no
 * filenames — because readiness endpoints are routinely public.
 */
function readinessResponse(lifecycle, details = {}) {
  const ready = lifecycle.isReady() && !lifecycle.isShuttingDown();
  return {
    status: ready ? 200 : 503,
    body: ready
      ? { ok: true, ready: true, ...details }
      : { ok: false, ready: false, shuttingDown: lifecycle.isShuttingDown() },
  };
}

/** Normal signals exit 0; anything fatal must exit nonzero so a supervisor notices. */
function exitCodeFor(reason) {
  return reason === 'SIGTERM' || reason === 'SIGINT' ? 0 : 1;
}

/**
 * Close a Node server (HTTP or Socket.IO) as a promise that always settles.
 *
 * `close()` reports an error when the server was never listening or is already
 * closed. During shutdown that is not a failure — it is the state we wanted —
 * so it resolves rather than rejecting and stalling the sequence.
 */
function closeQuietly(closable) {
  return new Promise((resolve) => {
    if (!closable || typeof closable.close !== 'function') return resolve();
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    try {
      closable.close(done);
    } catch {
      done();
    }
  });
}

/**
 * Run an ordered list of teardown steps, then exit.
 *
 * Every step is isolated: one throwing (or hanging past the deadline) must not
 * prevent the rest from running, because a half-shut-down process that never
 * exits is worse than an ungraceful one. The forced-exit timer is the backstop
 * and is unref'd so it can never be the reason the process stays alive.
 */
async function runShutdown({ lifecycle, reason, steps = [], timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS, logger = console, exit = process.exit }) {
  if (!lifecycle.beginShutdown()) return false;
  const code = exitCodeFor(reason);

  const forced = setTimeout(() => {
    logger.error(`[shutdown] timed out after ${timeoutMs}ms — forcing exit`);
    exit(code || 1);
  }, timeoutMs);
  if (typeof forced.unref === 'function') forced.unref();

  for (const step of steps) {
    try {
      await step();
    } catch (err) {
      logger.error('[shutdown] step failed', { message: err && err.message });
    }
  }

  clearTimeout(forced);
  exit(code);
  return true;
}

/** One-line structured context for a fatal error, without dumping secrets. */
function describeFatal(reason, err) {
  const error = err instanceof Error ? err : new Error(String(err));
  return {
    reason,
    message: error.message,
    stack: error.stack,
    pid: process.pid,
    uptime: Math.round(process.uptime()),
  };
}

module.exports = {
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  createLifecycle,
  healthResponse,
  readinessResponse,
  exitCodeFor,
  closeQuietly,
  runShutdown,
  describeFatal,
};
