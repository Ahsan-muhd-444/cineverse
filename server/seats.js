/**
 * Seat identity + reconnect-grace rules.
 *
 * A "seat" is a human's place in a room. It must survive a page refresh or a
 * brief network drop, which a Socket.IO connection id cannot — every refresh
 * mints a new socket id. So the room keys members by a stable `memberId`, and
 * the client proves ownership of a seat with an unguessable `seatId` held in
 * sessionStorage (per tab, per room).
 *
 * These predicates are pure so the reconnect logic can be unit-tested without a
 * server — see scripts/seats.test.mjs.
 */

const crypto = require('crypto');

/**
 * How long a seat survives a disconnect, by default.
 *
 * TWO MINUTES, not thirty seconds, because of how phones actually behave. Tap
 * the home button, answer a message, come back — the OS suspends the page and
 * closes the socket almost immediately. At 30s the seat was gone before a normal
 * interruption ended, and rejoining meant going through the waiting room again
 * and asking the other person to re-approve you. For a two-person cinema that is
 * far worse than briefly showing someone as "reconnecting": the seat is held,
 * presence already reports `connected: false`, and nothing about the room is lost.
 */
const DEFAULT_GRACE_MS = 120_000;

/** How long a disconnected member keeps their seat before being removed. */
function reconnectGraceMs(env = process.env) {
  const raw = Number(env.ROOM_RECONNECT_GRACE_MS);
  // 0 is a legitimate value (grace disabled) — only reject negatives/garbage.
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_GRACE_MS;
}

/** Public, stable participant id. Never the client's secret seat token. */
function newMemberId() {
  return `m_${crypto.randomBytes(9).toString('hex')}`;
}

/**
 * Whether a joining socket may reclaim an existing seat.
 *
 * Possession of the seat token is the proof: it is random, server-unknown to
 * everyone else, and scoped to one tab. A kicked seat is tombstoned for the
 * room's lifetime so the stable identity can never re-open the kick hole.
 */
function canReclaimSeat(params) {
  const { seatId, member, kickedSeats } = params;
  if (!seatId || !member) return false;
  if (kickedSeats && typeof kickedSeats.has === 'function' && kickedSeats.has(seatId)) return false;
  // The seat must still belong to this token.
  return member.seatId === seatId;
}

/**
 * Whether a member whose grace timer just fired should really be removed.
 *
 * A reconnect during the window sets `connected` back to true (and bumps
 * `disconnectedAt`), so a late timer from an earlier disconnect must be a no-op.
 */
function shouldFinalizeDisconnect(params) {
  const { member, now, graceMs } = params;
  if (!member) return false;
  if (member.connected) return false;
  if (!Number.isFinite(member.disconnectedAt)) return true;
  return now - member.disconnectedAt >= graceMs;
}

/** Whether this seat has been kicked from the room. */
function isSeatKicked(seatId, kickedSeats) {
  if (!seatId || !kickedSeats || typeof kickedSeats.has !== 'function') return false;
  return kickedSeats.has(seatId);
}

module.exports = {
  DEFAULT_GRACE_MS,
  reconnectGraceMs,
  newMemberId,
  canReclaimSeat,
  shouldFinalizeDisconnect,
  isSeatKicked,
};
