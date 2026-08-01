/**
 * Unit tests for stress-result validation (scripts/e2e-stress-lib.mjs).
 *
 * The property under test is diagnostic integrity: a harness whose job is to
 * catch rare failures must never report a pass it did not observe. A zero exit
 * code is one signal; the result artifact is another; when they disagree, or
 * when the artifact is missing, empty or self-contradictory, the only honest
 * verdict is FAIL.
 *
 * Run:  node --test --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/e2e-stress-lib.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { validateE2eResult, positiveInteger, nonNegativeInteger } from './e2e-stress-lib.mjs';

/** A well-formed passing result. */
const good = (over = {}) => ({ total: 230, passed: 230, failed: 0, failures: [], ...over });

/* ---------------- the happy path ---------------- */

test('a valid, non-empty, all-passing result with exit 0 passes', () => {
  const verdict = validateE2eResult(good(), 0);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.reason, null);
});

/* ---------------- missing or malformed ---------------- */

test('a missing result (null) fails — a crash before the write is not a pass', () => {
  const verdict = validateE2eResult(null, 0);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /not an object/);
});

test('a non-object result fails', () => {
  for (const value of [undefined, 'ok', 42, true, []]) {
    const verdict = validateE2eResult(value, 0);
    assert.equal(verdict.ok, false, `${JSON.stringify(value)} must not pass`);
    assert.match(verdict.reason, /not an object/);
  }
});

test('non-integer or negative counts fail', () => {
  for (const key of ['total', 'passed', 'failed']) {
    for (const bad of [-1, 1.5, '10', NaN, null, undefined]) {
      const verdict = validateE2eResult(good({ [key]: bad }), 0);
      assert.equal(verdict.ok, false, `${key}=${String(bad)}`);
      assert.match(verdict.reason, new RegExp(`invalid ${key}`));
    }
  }
});

/* ---------------- zero checks is the silent green ---------------- */

test('a result with ZERO checks fails, even with exit 0', () => {
  const verdict = validateE2eResult({ total: 0, passed: 0, failed: 0, failures: [] }, 0);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /zero checks/);
});

/* ---------------- internal consistency ---------------- */

test('counts that do not add up fail', () => {
  const verdict = validateE2eResult({ total: 230, passed: 228, failed: 0, failures: [] }, 0);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /inconsistent counts/);
  assert.match(verdict.reason, /total=230/, 'and the reason shows the numbers');
});

test('a non-array failures field fails', () => {
  const verdict = validateE2eResult(good({ failures: 'none' }), 0);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /failures is not an array/);
});

test('a failure list whose length disagrees with the count fails', () => {
  const verdict = validateE2eResult({ total: 230, passed: 229, failed: 1, failures: [] }, 1);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /failure list mismatch/);
});

/* ---------------- exit code vs result ---------------- */

test('exit 0 with a FAILED result is a contradiction, not a pass', () => {
  const parsed = { total: 230, passed: 229, failed: 1, failures: [{ index: 91, name: 'x' }] };
  const verdict = validateE2eResult(parsed, 0);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /exit\/result mismatch/);
});

test('exit 1 with a fully successful result is also a contradiction', () => {
  const verdict = validateE2eResult(good(), 1);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /exit\/result mismatch/);
});

test('a harness error means failure, even with zero failed checks', () => {
  const parsed = good({ harnessError: { message: 'websocket error' } });
  // Exit 1 is what the harness actually does here, so this is consistent…
  const verdict = validateE2eResult(parsed, 1);
  assert.equal(verdict.ok, false);
  assert.match(verdict.reason, /E2E checks failed/);
  // …and claiming success alongside a harness error is a contradiction.
  assert.match(validateE2eResult(parsed, 0).reason, /exit\/result mismatch/);
});

test('a genuine failure with a matching exit code is reported as a failure', () => {
  const parsed = { total: 230, passed: 227, failed: 3, failures: [{ index: 105 }, { index: 106 }, { index: 109 }] };
  const verdict = validateE2eResult(parsed, 1);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'E2E checks failed');
});

test('a null exit code (killed by signal) never counts as success', () => {
  assert.equal(validateE2eResult(good(), null).ok, false);
});

/* ---------------- configuration parsing ---------------- */

test('the default iteration count is 20', () => {
  assert.equal(positiveInteger(undefined, 20, 'E2E_ITERATIONS'), 20);
  assert.equal(positiveInteger('', 20, 'E2E_ITERATIONS'), 20);
});

test('negative iterations are REJECTED, not silently coerced', () => {
  // `Number('-1') || 20` yields -1, and a loop that runs -1 times exits 0.
  assert.throws(() => positiveInteger('-1', 20, 'E2E_ITERATIONS'), /positive integer/);
});

test('zero iterations are rejected', () => {
  assert.throws(() => positiveInteger('0', 20, 'E2E_ITERATIONS'), /positive integer/);
});

test('fractional and non-numeric iterations are rejected', () => {
  for (const bad of ['1.5', 'twenty', 'NaN', 'Infinity', '1e', ' ']) {
    assert.throws(() => positiveInteger(bad, 20, 'E2E_ITERATIONS'), /positive integer/, `raw=${bad}`);
  }
});

test('the rejection names the variable and echoes the bad value', () => {
  assert.throws(() => positiveInteger('-4', 20, 'E2E_ITERATIONS'), (err) => {
    assert.match(err.message, /E2E_ITERATIONS/);
    assert.match(err.message, /-4/);
    return true;
  });
});

test('a valid iteration count is returned as a number', () => {
  assert.equal(positiveInteger('50', 20, 'E2E_ITERATIONS'), 50);
  assert.equal(typeof positiveInteger('50', 20, 'E2E_ITERATIONS'), 'number');
});

/* ---------------- soak configuration uses the same rules ---------------- */

test('SOAK_ROOMS=-1 is rejected — a soak of -1 rooms exercises nothing', () => {
  assert.throws(() => positiveInteger('-1', 8, 'SOAK_ROOMS'), /SOAK_ROOMS must be a positive integer/);
});

test('zero and fractional soak counts are rejected', () => {
  for (const name of ['SOAK_ROOMS', 'SOAK_MEMBERS', 'SOAK_ROUNDS']) {
    for (const bad of ['0', '2.5', '-3', 'lots']) {
      assert.throws(() => positiveInteger(bad, 3, name), new RegExp(`${name} must be a positive integer`),
        `${name}=${bad}`);
    }
  }
});

test('soak duration values may be zero but never negative or fractional', () => {
  for (const name of ['SOAK_SETTLE_MS', 'SOAK_REAP_MS']) {
    assert.equal(nonNegativeInteger('0', 4000, name), 0);
    assert.throws(() => nonNegativeInteger('-1', 4000, name), /non-negative integer/);
    assert.throws(() => nonNegativeInteger('1.5', 4000, name), /non-negative integer/);
  }
});

test('soak defaults are used when the variables are unset', () => {
  assert.equal(positiveInteger(undefined, 8, 'SOAK_ROOMS'), 8);
  assert.equal(positiveInteger(undefined, 3, 'SOAK_MEMBERS'), 3);
  assert.equal(positiveInteger(undefined, 3, 'SOAK_ROUNDS'), 3);
  assert.equal(nonNegativeInteger(undefined, 4000, 'SOAK_SETTLE_MS'), 4000);
  assert.equal(nonNegativeInteger(undefined, 2000, 'SOAK_REAP_MS'), 2000);
});

test('the grace value accepts zero — disabling it is deliberate — but not negatives', () => {
  assert.equal(nonNegativeInteger('0', 500, 'ROOM_RECONNECT_GRACE_MS'), 0);
  assert.equal(nonNegativeInteger(undefined, 500, 'ROOM_RECONNECT_GRACE_MS'), 500);
  assert.throws(() => nonNegativeInteger('-1', 500, 'ROOM_RECONNECT_GRACE_MS'), /non-negative integer/);
  assert.throws(() => nonNegativeInteger('2.5', 500, 'ROOM_RECONNECT_GRACE_MS'), /non-negative integer/);
});
