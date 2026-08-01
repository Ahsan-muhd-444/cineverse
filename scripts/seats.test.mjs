/**
 * Unit tests for seat identity + reconnect-grace rules (server/seats.js).
 *
 * These are the predicates that decide whether a refresh silently reclaims a
 * seat or the room announces a departure — pure, so they can be proven without
 * a server or a browser.
 *
 * Run:  node --test --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/seats.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  reconnectGraceMs,
  newMemberId,
  canReclaimSeat,
  shouldFinalizeDisconnect,
  isSeatKicked,
  DEFAULT_GRACE_MS,
} = require('../server/seats.js');

/* ---------------- grace configuration ---------------- */

test('grace window reads env and falls back to the default', () => {
  assert.equal(reconnectGraceMs({ ROOM_RECONNECT_GRACE_MS: '500' }), 500);
  assert.equal(reconnectGraceMs({}), DEFAULT_GRACE_MS);
  assert.equal(reconnectGraceMs({ ROOM_RECONNECT_GRACE_MS: 'soon' }), DEFAULT_GRACE_MS);
  assert.equal(reconnectGraceMs({ ROOM_RECONNECT_GRACE_MS: '-5' }), DEFAULT_GRACE_MS);
});

test('the default grace survives a real phone interruption', () => {
  /*
   * A phone suspends the page and closes the socket the instant it is
   * backgrounded. At 30s the seat expired during an ordinary interruption —
   * answering a message, checking something else — and rejoining a room with a
   * waiting room meant the other person had to approve the viewer again.
   * Anything shorter than a minute reintroduces that.
   */
  assert.ok(DEFAULT_GRACE_MS >= 60_000, `default grace ${DEFAULT_GRACE_MS}ms is too short for a backgrounded phone`);
  assert.equal(DEFAULT_GRACE_MS, 120_000, 'two minutes — see server/seats.js');
});

test('a seat is still held part-way through the default grace', () => {
  // The exact property the bug violated: disconnected 60s ago, still yours.
  const member = { connected: false, disconnectedAt: 1_000_000 };
  const graceMs = DEFAULT_GRACE_MS;
  assert.equal(
    shouldFinalizeDisconnect({ member, now: 1_000_000 + 60_000, graceMs }),
    false,
    'a seat must survive a one-minute interruption',
  );
  assert.equal(
    shouldFinalizeDisconnect({ member, now: 1_000_000 + graceMs, graceMs }),
    true,
    'and be released once the window truly elapses',
  );
});

test('grace can be explicitly disabled with 0', () => {
  // 0 is meaningful (immediate removal), so it must NOT fall back to the default.
  assert.equal(reconnectGraceMs({ ROOM_RECONNECT_GRACE_MS: '0' }), 0);
});

test('member ids are unique and do not leak the seat token', () => {
  const a = newMemberId();
  const b = newMemberId();
  assert.notEqual(a, b);
  assert.match(a, /^m_[0-9a-f]{18}$/);
});

/* ---------------- reclaiming a seat ---------------- */

const seat = 'seat-token-abc';
const member = { id: 'm_1', seatId: seat, connected: false };

test('a matching seat token reclaims the seat', () => {
  assert.equal(canReclaimSeat({ seatId: seat, member, kickedSeats: new Set() }), true);
});

test('a connected member can also be reclaimed (a second tab supersedes)', () => {
  // The server evicts the older socket; the predicate itself allows the takeover.
  assert.equal(canReclaimSeat({ seatId: seat, member: { ...member, connected: true }, kickedSeats: new Set() }), true);
});

test('a mismatched or missing seat token cannot reclaim', () => {
  assert.equal(canReclaimSeat({ seatId: 'other', member, kickedSeats: new Set() }), false);
  assert.equal(canReclaimSeat({ seatId: '', member, kickedSeats: new Set() }), false);
  assert.equal(canReclaimSeat({ seatId: null, member, kickedSeats: new Set() }), false);
});

test('there is nothing to reclaim when the seat is gone', () => {
  assert.equal(canReclaimSeat({ seatId: seat, member: null, kickedSeats: new Set() }), false);
  assert.equal(canReclaimSeat({ seatId: seat, member: undefined, kickedSeats: new Set() }), false);
});

test('a KICKED seat can never be reclaimed', () => {
  // The whole point of the tombstone: stable identity must not re-open the kick.
  const kicked = new Set([seat]);
  assert.equal(canReclaimSeat({ seatId: seat, member, kickedSeats: kicked }), false);
});

test('isSeatKicked is safe with missing inputs', () => {
  assert.equal(isSeatKicked(seat, new Set([seat])), true);
  assert.equal(isSeatKicked(seat, new Set()), false);
  assert.equal(isSeatKicked(null, new Set([seat])), false);
  assert.equal(isSeatKicked(seat, null), false);
  assert.equal(isSeatKicked(seat, undefined), false);
});

/* ---------------- finalizing a disconnect ---------------- */

test('an expired grace window removes the member', () => {
  const m = { connected: false, disconnectedAt: 1000 };
  assert.equal(shouldFinalizeDisconnect({ member: m, now: 1600, graceMs: 500 }), true);
});

test('a member who reconnected inside the window is NOT removed', () => {
  // The late timer from the earlier disconnect must be a no-op.
  const m = { connected: true, disconnectedAt: 1000 };
  assert.equal(shouldFinalizeDisconnect({ member: m, now: 5000, graceMs: 500 }), false);
});

test('a still-disconnected member inside the window is NOT removed yet', () => {
  const m = { connected: false, disconnectedAt: 1000 };
  assert.equal(shouldFinalizeDisconnect({ member: m, now: 1200, graceMs: 500 }), false);
});

test('the boundary counts as expired', () => {
  const m = { connected: false, disconnectedAt: 1000 };
  assert.equal(shouldFinalizeDisconnect({ member: m, now: 1500, graceMs: 500 }), true);
});

test('a member already removed, or with no disconnect stamp, is handled safely', () => {
  assert.equal(shouldFinalizeDisconnect({ member: null, now: 1, graceMs: 500 }), false);
  assert.equal(shouldFinalizeDisconnect({ member: undefined, now: 1, graceMs: 500 }), false);
  // No stamp but disconnected: nothing to wait for.
  assert.equal(shouldFinalizeDisconnect({ member: { connected: false }, now: 1, graceMs: 500 }), true);
});
