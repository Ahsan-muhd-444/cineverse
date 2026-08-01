/**
 * Unit tests for the room join/reconnect GUARD PREDICATES in
 * src/hooks/roomLifecycle.ts.
 *
 * Scope, stated honestly: this repository has no client component/hook test
 * framework (no jest / vitest / React Testing Library, no jsdom, no `test`
 * script), and this focused fix does not add one. These tests therefore exercise
 * the pure decision logic that `useRoom` delegates to — they do NOT mount or
 * execute the React hook, so they are not a substitute for the manual reconnect
 * checks in the report. They lock the contract behind each reviewer scenario:
 *
 *   - closed / denied / kicked / locked must block auto-rejoin        -> canAutoJoin
 *   - BAD_PASSWORD must stay retryable (never terminal)               -> isTerminalJoinError
 *   - a delayed event for another room must be ignored               -> eventIsForRoom
 *   - a code change must not be blocked by the old code's marker      -> canAutoJoin
 *
 * Run:  node --test --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/room-lifecycle.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isTerminalJoinError,
  canAutoJoin,
  eventIsForRoom,
  classifyJoinFailure,
  shouldRetryJoin,
  joinRetryDelay,
  MAX_JOIN_RETRIES,
} from '../src/hooks/roomLifecycle.ts';

test('isTerminalJoinError: KICKED and LOCKED are terminal', () => {
  assert.equal(isTerminalJoinError('KICKED'), true);
  assert.equal(isTerminalJoinError('LOCKED'), true);
});

test('isTerminalJoinError: BAD_PASSWORD is retryable, not terminal', () => {
  assert.equal(isTerminalJoinError('BAD_PASSWORD'), false);
});

test('isTerminalJoinError: transient / unknown failures are not terminal', () => {
  assert.equal(isTerminalJoinError('MISSING_CODE'), false);
  assert.equal(isTerminalJoinError(undefined), false);
  assert.equal(isTerminalJoinError(null), false);
});

test('canAutoJoin: a terminal room blocks auto-rejoin on reconnect', () => {
  // closed / denied / kicked / locked all record terminalCode === code.
  assert.equal(canAutoJoin('ROOMA', 'ROOMA'), false);
});

test('canAutoJoin: a non-terminal room may auto-rejoin', () => {
  assert.equal(canAutoJoin('ROOMA', null), true);
});

test('canAutoJoin: a stale terminal marker from another room does not block a new code', () => {
  // Room A was terminal; hook now manages Room B. B must boot normally.
  assert.equal(canAutoJoin('ROOMB', 'ROOMA'), true);
});

test('eventIsForRoom: an event for the current room is accepted', () => {
  assert.equal(eventIsForRoom('ROOMB', 'ROOMB'), true);
});

test('eventIsForRoom: a delayed event for another room is ignored', () => {
  // Managing Room B, a terminal/approval event for Room A must not apply.
  assert.equal(eventIsForRoom('ROOMA', 'ROOMB'), false);
  assert.equal(eventIsForRoom(undefined, 'ROOMB'), false);
  assert.equal(eventIsForRoom(null, 'ROOMB'), false);
});

/* ---------------- transient vs terminal join failures ----------------
   A rate-limited join used to fall into the generic branch and render as a
   permanent "could not join that room", when waiting two seconds would have
   worked. These pin the distinction down. */

test('classifyJoinFailure: a rate limit is transient, not a dead room', () => {
  assert.equal(classifyJoinFailure('RATE_LIMITED'), 'retry');
  assert.equal(classifyJoinFailure('TIMEOUT'), 'retry', 'a lost ack is worth one more go');
});

test('classifyJoinFailure: the gates stay distinguishable', () => {
  assert.equal(classifyJoinFailure('BAD_PASSWORD'), 'password');
  assert.equal(classifyJoinFailure('KICKED'), 'terminal');
  assert.equal(classifyJoinFailure('LOCKED'), 'terminal');
  assert.equal(classifyJoinFailure('MISSING_CODE'), 'unreachable');
  assert.equal(classifyJoinFailure(undefined), 'unreachable');
});

test('only transient failures are retried, and only a bounded number of times', () => {
  assert.equal(shouldRetryJoin('retry', 1), true);
  assert.equal(shouldRetryJoin('retry', MAX_JOIN_RETRIES), false, 'the loop must end');
  for (const kind of ['password', 'terminal', 'unreachable']) {
    assert.equal(shouldRetryJoin(kind, 1), false, `${kind} must never auto-retry`);
  }
});

test('retry backoff grows, honours retryAfterMs, and stays bounded', () => {
  const first = joinRetryDelay(undefined, 1);
  const second = joinRetryDelay(undefined, 2);
  assert.ok(first >= 1000, 'never a tight loop against the limiter');
  assert.ok(second > first, 'backs off');
  assert.ok(joinRetryDelay(7000, 1) >= 7000, 'waits at least as long as the server asked');
  assert.ok(joinRetryDelay(10 * 60_000, 9) <= 15_000, 'but never strands the user for minutes');
});

test('a terminal room is still never auto-rejoined, whatever the retry logic does', () => {
  // The two guards compose: retry decides "may I try again", canAutoJoin decides
  // "is this room allowed to be tried at all". Terminal wins.
  assert.equal(canAutoJoin('ROOMA', 'ROOMA'), false);
  assert.equal(shouldRetryJoin(classifyJoinFailure('KICKED'), 0), false);
});
