/**
 * Validation helpers for the cold realtime stress harness.
 *
 * Kept in their own module so they can be imported by a test WITHOUT running
 * the harness — `e2e-stress.mjs` starts servers on import.
 *
 * ---------------------------------------------------------------------------
 * Why a zero exit code is not enough
 *
 * The stress harness exists to catch rare failures, so the one thing it must
 * never do is report success it did not observe. A child process can exit 0
 * having produced nothing useful:
 *
 *   - the result file was never written (a crash between the last check and the
 *     atomic rename);
 *   - it was written but is truncated or not JSON;
 *   - it reports `total: 0` — the suite ran no checks at all, which is exactly
 *     the silent-green failure mode already found in the release gate's unit
 *     step;
 *   - its counts disagree with each other, so at least one is wrong;
 *   - it disagrees with the exit code, which means the harness itself is buggy
 *     and neither signal can be trusted.
 *
 * Every one of those is a FAILED iteration. Treating any of them as a pass
 * would make the whole exercise self-defeating.
 * ---------------------------------------------------------------------------
 */

/**
 * Decide whether one iteration genuinely passed.
 *
 * @param {unknown} parsed contents of e2e-result.json, or null if unreadable
 * @param {number|null} exitCode the child's exit code
 * @returns {{ok: boolean, reason: string|null}}
 */
export function validateE2eResult(parsed, exitCode) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'result is not an object' };
  }

  for (const key of ['total', 'passed', 'failed']) {
    if (!Number.isInteger(parsed[key]) || parsed[key] < 0) {
      return { ok: false, reason: `invalid ${key}` };
    }
  }

  // A suite that ran nothing is the silent green this harness exists to reject.
  if (parsed.total <= 0) {
    return { ok: false, reason: 'E2E result contains zero checks' };
  }

  if (parsed.passed + parsed.failed !== parsed.total) {
    return {
      ok: false,
      reason: `inconsistent counts: passed=${parsed.passed} failed=${parsed.failed} total=${parsed.total}`,
    };
  }

  if (!Array.isArray(parsed.failures)) {
    return { ok: false, reason: 'failures is not an array' };
  }

  if (parsed.failures.length !== parsed.failed) {
    return {
      ok: false,
      reason: `failure list mismatch: failed=${parsed.failed} entries=${parsed.failures.length}`,
    };
  }

  const resultPassed = parsed.failed === 0 && !parsed.harnessError;

  // Two independent signals that must agree. If they do not, the harness is
  // lying somewhere and neither can be believed.
  if ((exitCode === 0) !== resultPassed) {
    return {
      ok: false,
      reason:
        `child exit/result mismatch: exit=${exitCode} ` +
        `failed=${parsed.failed} harnessError=${Boolean(parsed.harnessError)}`,
    };
  }

  return { ok: resultPassed, reason: resultPassed ? null : 'E2E checks failed' };
}

/**
 * Parse a configuration value that must be a positive whole number.
 *
 * Throws rather than falling back: `Number('-1') || 20` silently yields -1, and
 * a loop that runs -1 times "succeeds" having tested nothing. A misconfigured
 * run must stop before it starts a server, not report a vacuous pass.
 */
export function positiveInteger(raw, fallback, name) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer (got "${raw}")`);
  }
  return value;
}

/**
 * Same, but zero is a legitimate value — the reconnect grace may be disabled on
 * purpose, and the server itself accepts 0.
 */
export function nonNegativeInteger(raw, fallback, name) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer (got "${raw}")`);
  }
  return value;
}
