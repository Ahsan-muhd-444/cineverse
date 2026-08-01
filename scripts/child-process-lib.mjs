/**
 * Running a child process while preserving its log artifact.
 *
 * Import-safe: no side effects, no servers, no `main()`. The harnesses that use
 * it (`release-gate.mjs`, `e2e-stress.mjs`) start real servers on import, so the
 * logic worth testing lives here instead.
 *
 * ---------------------------------------------------------------------------
 * Why `close` and not `exit`
 *
 * `exit` fires when the child process terminates. Its stdout and stderr pipes
 * can still hold unread data at that moment — the process is gone, the bytes are
 * not yet delivered. Ending the log sink from `exit` therefore races the final
 * writes, and the lines lost are the LAST ones: the assertion that failed, the
 * stack trace, the summary. Precisely the content the artifact exists for.
 *
 * `close` fires only once every stdio stream of the child has been closed, so by
 * then every chunk has been emitted. That is the only safe point to end the sink.
 *
 * A caller may still watch `exit` separately — the release gate uses it to notice
 * a server dying during startup — but artifact flushing keys off `close`.
 * ---------------------------------------------------------------------------
 */

import { finished } from 'node:stream/promises';

/**
 * Settle once the child's stdio has closed AND its log has reached disk.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {import('node:fs').WriteStream|null} sink log destination, if any
 * @param {string} label used in the rejection message
 * @param {{allowNonZero?: boolean}} [options] when `allowNonZero`, a nonzero
 *   exit RESOLVES with its code instead of rejecting — for callers where a
 *   failing child is an expected outcome to inspect, not an error. Spawn and
 *   log-write failures still reject either way, because those are not results.
 * @returns {Promise<{code:number|null, signal:string|null}>}
 */
export function runLoggedChild(child, sink, label, options = {}) {
  return new Promise((resolve, reject) => {
    let spawnError = null;
    let settled = false;
    // A failed write (disk full, permissions) must not be discovered only when
    // someone opens an empty file weeks later.
    let sinkError = null;

    if (sink) sink.once('error', (error) => { sinkError = sinkError || error; });

    // Recorded rather than settled on: `close` still follows, and it is the
    // event that guarantees the sink can be safely ended and flushed. Settling
    // here would skip the flush entirely.
    child.once('error', (error) => { spawnError = error; });

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    const done = async (code, signal) => {
      if (settled) return;
      try {
        if (sink) {
          sink.end();
          try {
            await finished(sink);
          } catch (error) {
            // A flush failure is an ARTIFACT failure, and must be named as one:
            // "EISDIR" alone gives no hint that the missing log is the problem.
            sinkError = sinkError || error;
          }
        }
        if (sinkError) {
          settle(reject, new Error(`${label} log could not be written: ${sinkError.message}`));
          return;
        }
        if (spawnError) {
          settle(reject, spawnError);
          return;
        }
        if (code === 0 || options.allowNonZero) {
          settle(resolve, { code, signal: signal ?? null });
          return;
        }
        settle(reject, new Error(`${label} exited code=${code} signal=${signal || 'none'}`));
      } catch (error) {
        settle(reject, error);
      }
    };

    child.once('close', (code, signal) => { void done(code, signal); });

    // A command that never starts (ENOENT) emits `error` and, on some platforms,
    // no `close` at all. The sink must still be flushed and the promise settled.
    child.once('error', () => {
      if (child.pid === undefined) void done(null, null);
    });
  });
}

/**
 * Stop a child, escalating to SIGKILL if it ignores the polite signal.
 *
 * `child.killed` is NOT evidence of exit — it records only that a signal was
 * DELIVERED, and stays true for a process that caught it and kept running. The
 * bounded wait on the exit promise is the only real proof.
 *
 * Neither is `forced`. It means "SIGKILL was ATTEMPTED", not "the process is
 * gone" — a SIGKILL can fail to reap a process stuck in uninterruptible I/O, or
 * the caller's `exited` promise may simply never resolve. Callers must therefore
 * assert on **`exited`**, which is the only field that reports an observed
 * termination.
 *
 * @param {import('node:child_process').ChildProcess} child
 * @param {Promise<unknown>} exited resolves when the child exits
 * @param {{signal?: NodeJS.Signals, graceMs?: number, forceMs?: number}} [options]
 * @returns {Promise<{exited: boolean, graceful: boolean, forced: boolean}>}
 */
export async function stopChild(child, exited, options = {}) {
  const { signal = 'SIGTERM', graceMs = 10_000, forceMs = 3000 } = options;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    child.kill(signal);
  } catch {
    /* it may already have exited */
  }

  const gracefulExit = await Promise.race([exited.then(() => true), sleep(graceMs).then(() => false)]);
  if (gracefulExit) return { exited: true, graceful: true, forced: false };

  try {
    child.kill('SIGKILL');
  } catch {
    /* it may have exited between the checks */
  }

  const forcedExit = await Promise.race([exited.then(() => true), sleep(forceMs).then(() => false)]);
  return { exited: forcedExit, graceful: false, forced: true };
}

/**
 * The single shutdown routine for a harness-owned server: stop it, wait for its
 * stdio to close, flush its log, and report what was actually observed.
 *
 * One implementation for the soak, the stress harness and the release gate —
 * three subtly different versions of this is how one of them ends up asserting
 * on the wrong field.
 *
 * `closeObserved` is reported rather than thrown on, so the caller can decide:
 * a missing `close` after the deadline means the log may be truncated, which is
 * a process-lifecycle failure, not something to wait forever for.
 *
 * @returns {Promise<{exited:boolean, graceful:boolean, forced:boolean,
 *   closeObserved:boolean, logError:string|null}>}
 */
export async function shutdownServer(child, { exited, closed, sink, label, signal, graceMs, forceMs, closeMs = 5000 }) {
  const stop = await stopChild(child, exited, { signal, graceMs, forceMs });

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const closeObserved = closed
    ? await Promise.race([closed.then(() => true), sleep(closeMs).then(() => false)])
    : true;

  let logError = null;
  try {
    await closeLogSink(sink, label);
  } catch (err) {
    logError = err.message;
  }

  return { ...stop, closeObserved, logError };
}

/**
 * Flush and close a log sink, surfacing any write failure.
 *
 * Used for sinks not owned by `runLoggedChild` (a long-lived server's log).
 * Deliberately NOT swallowed: `finished(sink).catch(() => {})` turns a disk-full
 * or permission error into a silently missing artifact, which is exactly the
 * failure mode these harnesses exist to prevent.
 *
 * @returns {Promise<void>} rejects if the log could not be written
 */
export async function closeLogSink(sink, label) {
  if (!sink) return;
  let sinkError = null;
  sink.once('error', (error) => { sinkError = sinkError || error; });
  try {
    sink.end();
    await finished(sink);
  } catch (error) {
    throw new Error(`${label} log could not be written: ${error.message}`);
  }
  if (sinkError) throw new Error(`${label} log could not be written: ${sinkError.message}`);
}
