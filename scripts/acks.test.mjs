/**
 * Unit tests for acknowledgement handling of optimistic client actions
 * (src/lib/acks.ts) and for the WebRTC signal-failure policy (src/lib/rtc.ts).
 *
 * The interesting cases here are all about ORDER: what a late rejection is
 * allowed to undo once newer state has landed. Those are impossible to
 * exercise reliably through the UI and trivial to pin down as pure functions.
 *
 * Run:  node --test --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/acks.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  normalizeAck,
  isRateLimited,
  describeActionError,
  createAttemptTracker,
  beginAttempt,
  adoptAuthoritative,
  shouldRevertAttempt,
} = await import('../src/lib/acks.ts');

const { classifySignalFailure, signalRetryDelay, SIGNAL_FAILURE_LIMIT } = await import('../src/lib/rtc.ts');

/* ---------------- normalizing a verdict ---------------- */

test('a well-formed success is a success', () => {
  const ack = normalizeAck({ ok: true, id: 'm1' });
  assert.equal(ack.ok, true);
  assert.equal(ack.id, 'm1');
});

test('a missing acknowledgement is a FAILURE, never a silent success', () => {
  for (const res of [null, undefined, '', 0, 'ok']) {
    const ack = normalizeAck(res);
    assert.equal(ack.ok, false, `${String(res)} must not count as accepted`);
    assert.equal(ack.error, 'FAILED');
  }
});

test('the caller controls the fallback error code', () => {
  assert.equal(normalizeAck(null, 'TIMEOUT').error, 'TIMEOUT');
});

test('a rejection keeps its error code and retryAfterMs', () => {
  const ack = normalizeAck({ ok: false, error: 'RATE_LIMITED', retryAfterMs: 2500 });
  assert.equal(ack.ok, false);
  assert.equal(ack.error, 'RATE_LIMITED');
  assert.equal(ack.retryAfterMs, 2500);
  assert.equal(isRateLimited(ack), true);
});

test('a nonsensical retryAfterMs is dropped rather than propagated', () => {
  for (const bad of [0, -1, NaN, Infinity, '2000', null]) {
    const ack = normalizeAck({ ok: false, error: 'RATE_LIMITED', retryAfterMs: bad });
    assert.equal(ack.retryAfterMs, undefined, `retryAfterMs=${String(bad)}`);
  }
});

test('an ok:false without an error code still fails, with the fallback', () => {
  const ack = normalizeAck({ ok: false }, 'SEND_FAILED');
  assert.equal(ack.ok, false);
  assert.equal(ack.error, 'SEND_FAILED');
});

/* ---------------- distinct user-facing copy ---------------- */

test('rate limiting, authorization and silence read as different problems', () => {
  const limited = describeActionError('RATE_LIMITED', 3000);
  const unauthorized = describeActionError('UNAUTHORIZED');
  const timeout = describeActionError('TIMEOUT');
  assert.match(limited, /3s/, 'a limiter tells you how long to wait');
  assert.notEqual(limited, unauthorized);
  assert.notEqual(unauthorized, timeout);
  assert.notEqual(limited, timeout);
});

test('a rate limit with no retry hint still reads sensibly', () => {
  assert.match(describeActionError('RATE_LIMITED'), /moment/);
});

/* ---------------- out-of-order acknowledgements ----------------
   The scenario this exists for:
     A optimistic change
     B optimistic change
     A rejected, late
   A must not roll the room back over the top of B. */

test('a rejected attempt reverts when nothing newer happened', () => {
  const tracker = createAttemptTracker();
  const a = beginAttempt(tracker);
  assert.equal(shouldRevertAttempt(tracker, a), true);
});

test('a LATE rejection for A does not clobber a newer attempt B', () => {
  const tracker = createAttemptTracker();
  const a = beginAttempt(tracker);
  const b = beginAttempt(tracker);
  assert.equal(shouldRevertAttempt(tracker, a), false, 'A is stale — B is what the user wants');
  assert.equal(shouldRevertAttempt(tracker, b), true, 'B may still undo itself');
});

test('an authoritative update voids an in-flight attempt', () => {
  const tracker = createAttemptTracker();
  const a = beginAttempt(tracker);
  // The server broadcast the real source — that is the truth now.
  adoptAuthoritative(tracker);
  assert.equal(shouldRevertAttempt(tracker, a), false);
});

test('A accepted then B rejected reverts only B', () => {
  const tracker = createAttemptTracker();
  beginAttempt(tracker); // A
  adoptAuthoritative(tracker); // the server broadcast A
  const b = beginAttempt(tracker);
  assert.equal(shouldRevertAttempt(tracker, b), true, 'B is the newest, so B may revert to A');
});

test('the tracker is monotonic, so an attempt id is never reused', () => {
  const tracker = createAttemptTracker();
  const seen = new Set();
  for (let i = 0; i < 50; i += 1) {
    seen.add(i % 3 === 0 ? (adoptAuthoritative(tracker), tracker.epoch) : beginAttempt(tracker));
  }
  assert.equal(seen.size, 50, 'every id distinct');
});

/* ---------------- WebRTC signal failures ---------------- */

test('a single dropped ICE candidate is ignored', () => {
  const verdict = classifySignalFailure({ type: 'ice', error: 'RATE_LIMITED', consecutiveFailures: 1 });
  assert.equal(verdict, 'ignore', 'ICE is expendable and must not tear down a call');
});

test('a dropped offer or answer is retried, not ignored', () => {
  for (const type of ['offer', 'answer']) {
    assert.equal(
      classifySignalFailure({ type, error: 'RATE_LIMITED', consecutiveFailures: 1 }),
      'retry',
      `${type} must be re-sent — nothing else will`,
    );
  }
});

test('a peer who is not in the room is dropped immediately, whatever the signal type', () => {
  for (const error of ['NOT_MEMBER', 'UNAUTHORIZED', 'NO_RECIPIENT']) {
    for (const type of ['ice', 'offer', 'answer']) {
      assert.equal(
        classifySignalFailure({ type, error, consecutiveFailures: 1 }),
        'drop',
        `${type}/${error} cannot be fixed by retrying`,
      );
    }
  }
});

test('PEER_OFFLINE is transient — the seat outlives the disconnect, so the call must too', () => {
  // The server refuses relays to a member inside their reconnect grace window
  // (two minutes in production). Treating that as fatal ended a two-person call
  // on the FIRST candidate sent during a Wi-Fi handoff.
  assert.equal(classifySignalFailure({ type: 'ice', error: 'PEER_OFFLINE', consecutiveFailures: 1 }), 'ignore');
  assert.equal(classifySignalFailure({ type: 'offer', error: 'PEER_OFFLINE', consecutiveFailures: 1 }), 'retry');
  // Still bounded: a peer that never comes back stops being retried.
  assert.equal(
    classifySignalFailure({ type: 'offer', error: 'PEER_OFFLINE', consecutiveFailures: SIGNAL_FAILURE_LIMIT }),
    'drop',
  );
});

test('sustained failure gives up on the peer instead of retrying forever', () => {
  assert.equal(
    classifySignalFailure({ type: 'offer', error: 'RATE_LIMITED', consecutiveFailures: SIGNAL_FAILURE_LIMIT }),
    'drop',
  );
  assert.equal(
    classifySignalFailure({ type: 'ice', error: 'RATE_LIMITED', consecutiveFailures: SIGNAL_FAILURE_LIMIT }),
    'ignore',
    'ICE is never a reason to tear a call down — the limit check must not outrank the ICE exemption',
  );
});

test('retry backoff honours the limiter and stays bounded', () => {
  assert.ok(signalRetryDelay(undefined, 1) > 0, 'always waits a beat');
  assert.ok(signalRetryDelay(5000, 1) >= 5000, 'never retries sooner than the server asked');
  assert.ok(signalRetryDelay(undefined, 2) > signalRetryDelay(undefined, 1), 'backs off');
  assert.ok(signalRetryDelay(999999, 9) <= 6000, 'bounded — no multi-minute stall');
});
