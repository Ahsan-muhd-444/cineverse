/**
 * Pure decision helpers for the room join/reconnect lifecycle.
 *
 * Kept free of React and socket imports so the guard logic that stops a
 * terminal room from auto-rejoining on a transport reconnect can be unit-tested
 * on its own (see scripts/room-lifecycle.test.mjs). `useRoom` is the only
 * consumer; these functions carry no state.
 */

/**
 * Join-result errors that put a room into a TERMINAL state — one a bare
 * Socket.IO reconnect must never silently retry.
 *
 * `BAD_PASSWORD` is deliberately NOT terminal: the user can submit another
 * passphrase. A generic/transient failure ("unreachable") is not terminal
 * either, so a reconnect may legitimately retry it.
 */
export function isTerminalJoinError(error: string | null | undefined): boolean {
  return error === 'KICKED' || error === 'LOCKED';
}

/**
 * Whether a reconnect may auto-emit `room:join` for `code`. Blocked while `code`
 * is the code we recorded as terminal (closed / denied / kicked / locked). A
 * transport reconnect is not user intent to retry a terminal room.
 */
export function canAutoJoin(code: string, terminalCode: string | null): boolean {
  return terminalCode !== code;
}

/**
 * How a failed join should be presented and whether it may be retried.
 *
 * The distinction that matters: "you are going too fast" and "this room is gone"
 * look identical if both fall into a generic failure branch, and the first one
 * then reads as a permanent, unexplained error. A user who waits two seconds
 * could have got in.
 *
 *  - `retry`     transient and self-healing — show a waiting state, try again
 *  - `password`  the gate is answerable; ask again
 *  - `terminal`  kicked or locked; never auto-retry
 *  - `unreachable` unknown failure; recoverable by a reconnect, not by looping
 */
export type JoinFailureKind = 'retry' | 'password' | 'terminal' | 'unreachable';

export function classifyJoinFailure(error: string | null | undefined): JoinFailureKind {
  if (error === 'BAD_PASSWORD') return 'password';
  if (isTerminalJoinError(error)) return 'terminal';
  // RATE_LIMITED is the server saying "later", not "no". TIMEOUT is the ack
  // going missing, which a second attempt routinely fixes.
  if (error === 'RATE_LIMITED' || error === 'TIMEOUT') return 'retry';
  return 'unreachable';
}

/** Longest a join attempt may wait for an acknowledgement before giving up. */
export const JOIN_ACK_TIMEOUT_MS = 12_000;
/** How many automatic retries a transient join failure gets before it stops. */
export const MAX_JOIN_RETRIES = 4;

/**
 * How long to wait before retrying a join, honouring the server's own hint.
 *
 * Bounded and increasing on purpose: a client that retries a rate-limited join
 * every 200ms is indistinguishable from the abuse the limiter exists to stop,
 * and would keep its own bucket permanently empty.
 */
export function joinRetryDelay(retryAfterMs: number | undefined, attempt: number): number {
  const backoff = Math.min(8000, 1000 * 2 ** Math.max(0, attempt - 1));
  return Math.min(15_000, Math.max(backoff, retryAfterMs || 0));
}

/** Whether another automatic join attempt is allowed. */
export function shouldRetryJoin(kind: JoinFailureKind, attempts: number): boolean {
  return kind === 'retry' && attempts < MAX_JOIN_RETRIES;
}

/**
 * Whether an inbound room event — each of which carries its own room code —
 * belongs to the room this hook is currently managing. Guards against delayed
 * events from a room the socket has already left.
 */
export function eventIsForRoom(payloadCode: string | null | undefined, code: string): boolean {
  return payloadCode === code;
}
