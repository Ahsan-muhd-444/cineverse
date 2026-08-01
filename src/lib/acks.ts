/**
 * Acknowledgement handling for client actions the server can reject.
 *
 * Every optimistic mutation in the room has the same three failure modes, and
 * getting any of them wrong is invisible until it bites:
 *
 *  1. the server refuses (rate limit, not host, not a member);
 *  2. the acknowledgement never arrives at all;
 *  3. the acknowledgement arrives LATE, after the user has already moved on.
 *
 * (3) is the subtle one. Two quick source changes A then B, with A rejected
 * after B was accepted, must not roll the room back to A's predecessor. The
 * epoch counter below is what makes that decidable: an attempt may only undo
 * itself while it is still the newest thing that happened.
 *
 * Pure and framework-free so the ordering rules are unit-tested without React
 * (see scripts/acks.test.mjs).
 */

/** What a rejected action tells the caller. `retryAfterMs` survives from the server. */
export interface AckFailure {
  ok: false;
  error: string;
  retryAfterMs?: number;
}

export interface AckSuccess {
  ok: true;
  [key: string]: unknown;
}

export type AckResult = AckSuccess | AckFailure;

/**
 * Turn whatever came back over the wire into a definite verdict.
 *
 * A missing, null or malformed acknowledgement is a FAILURE, never a silent
 * success — treating "no answer" as "fine" is how optimistic state drifts away
 * from the room. `retryAfterMs` is preserved whenever the server sent one, so a
 * caller can honour the limiter's own backoff instead of inventing one.
 */
export function normalizeAck(res: unknown, fallbackError = 'FAILED'): AckResult {
  if (!res || typeof res !== 'object') return { ok: false, error: fallbackError };
  const value = res as { ok?: unknown; error?: unknown; retryAfterMs?: unknown };
  if (value.ok === true) return { ...(res as object), ok: true } as AckSuccess;
  const failure: AckFailure = {
    ok: false,
    error: typeof value.error === 'string' && value.error ? value.error : fallbackError,
  };
  if (typeof value.retryAfterMs === 'number' && Number.isFinite(value.retryAfterMs) && value.retryAfterMs > 0) {
    failure.retryAfterMs = value.retryAfterMs;
  }
  return failure;
}

export function isRateLimited(ack: AckResult): ack is AckFailure {
  return ack.ok === false && ack.error === 'RATE_LIMITED';
}

/**
 * User-facing copy for a rejected room action.
 *
 * The categories stay distinct on purpose: "you are going too fast" is
 * recoverable by waiting, "you are not allowed" is not, and "we never heard
 * back" is neither — conflating them produces the generic failure message that
 * tells a user nothing.
 */
export function describeActionError(error: string, retryAfterMs?: number): string {
  switch (error) {
    case 'RATE_LIMITED': {
      const seconds = Math.max(1, Math.ceil((retryAfterMs || 0) / 1000));
      return retryAfterMs ? `Too fast — try again in ${seconds}s.` : 'Too fast — try again in a moment.';
    }
    case 'UNAUTHORIZED':
      return 'Only the host can do that.';
    case 'NOT_FOUND':
      return 'That person is no longer in the room.';
    case 'TIMEOUT':
      return 'No response from the room. Check your connection.';
    default:
      return 'That did not go through. Try again.';
  }
}

/* -------------------------------------------------------------------------- */
/*  Optimistic attempt ordering                                               */
/* -------------------------------------------------------------------------- */

/**
 * A monotonic counter shared by optimistic attempts AND authoritative updates.
 *
 * Both bump it, which is the whole trick: an attempt can only be rolled back
 * while nothing newer has happened — no later attempt, and no authoritative
 * broadcast from the server. One number answers both questions.
 */
export interface AttemptTracker {
  epoch: number;
}

export function createAttemptTracker(): AttemptTracker {
  return { epoch: 0 };
}

/** Claim the next attempt id for an optimistic change. */
export function beginAttempt(tracker: AttemptTracker): number {
  tracker.epoch += 1;
  return tracker.epoch;
}

/**
 * Record that the server told us the truth (a broadcast or a fresh snapshot).
 * Authoritative state always wins, so any attempt still in flight is void.
 */
export function adoptAuthoritative(tracker: AttemptTracker): void {
  tracker.epoch += 1;
}

/**
 * Whether a failed attempt may still undo itself.
 *
 * False once anything newer has landed — a second optimistic change, or an
 * authoritative update — because reverting then would clobber a value the room
 * has actually agreed on.
 */
export function shouldRevertAttempt(tracker: AttemptTracker, attempt: number): boolean {
  return attempt === tracker.epoch;
}
