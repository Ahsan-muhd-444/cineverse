/**
 * Unit tests for host succession (server/succession.js).
 *
 * These exist because the rule they cover was previously guarded ONLY by a
 * realtime check that waits on a broadcast driven by the reconnect-grace timer.
 * That check failed roughly once every 24 cold runs — not because succession was
 * wrong, but because the assertion read a snapshot taken before the promotion
 * landed. The rule itself is pure, and a pure rule should not be verified by
 * racing a timer.
 *
 * Run:  node --test --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/succession.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chooseSuccessor } = require('../server/succession.js');

/** Build a room from `[id, joinedAt, connected]` tuples. */
function room(members) {
  return {
    members: new Map(members.map(([id, joinedAt, connected = true]) => [id, { id, joinedAt, connected }])),
    // Present to mirror the real shape — and to prove it is never consulted.
    lobby: new Map(),
  };
}

/* ---------------- the security property ---------------- */

test('a lobby guest is never promoted — they are not a candidate at all', () => {
  const r = room([['m_host', 1], ['m_member', 2]]);
  // A guest waiting for approval lives in the lobby, never in members.
  r.lobby.set('socket-guest', { name: 'Guest', socketId: 'socket-guest', at: 3 });
  assert.equal(chooseSuccessor(r, 'm_host'), 'm_member');
});

test('a room whose only remaining people are in the lobby goes hostless', () => {
  const r = room([['m_host', 1]]);
  r.lobby.set('socket-guest', { name: 'Guest', socketId: 'socket-guest', at: 2 });
  // Null, never the guest: an unapproved socket must not inherit the room.
  assert.equal(chooseSuccessor(r, 'm_host'), null);
});

/* ---------------- who is chosen ---------------- */

test('the longest-standing remaining member inherits', () => {
  const r = room([['m_host', 10], ['m_late', 30], ['m_early', 20]]);
  assert.equal(chooseSuccessor(r, 'm_host'), 'm_early');
});

test('a CONNECTED member is preferred over one inside their reconnect grace', () => {
  // m_dropped joined first but has no transport — promoting them would leave
  // the room with a host who cannot act.
  const r = room([['m_host', 1], ['m_dropped', 2, false], ['m_live', 3, true]]);
  assert.equal(chooseSuccessor(r, 'm_host'), 'm_live');
});

test('if everyone left is mid-grace, the room still gets a host', () => {
  const r = room([['m_host', 1], ['m_a', 2, false], ['m_b', 3, false]]);
  assert.equal(chooseSuccessor(r, 'm_host'), 'm_a', 'oldest, rather than hostless');
});

test('an empty room has no successor', () => {
  assert.equal(chooseSuccessor(room([]), 'm_host'), null);
  assert.equal(chooseSuccessor(room([['m_host', 1]]), 'm_host'), null);
});

/* ---------------- determinism ---------------- */

test('the leaving member is never chosen as their own successor', () => {
  const r = room([['m_host', 1], ['m_other', 2]]);
  assert.equal(chooseSuccessor(r, 'm_host'), 'm_other');
});

test('succession is deterministic — same room, same answer, every time', () => {
  const r = room([['m_host', 1], ['m_a', 5], ['m_b', 5], ['m_c', 2]]);
  const answers = new Set(Array.from({ length: 20 }, () => chooseSuccessor(r, 'm_host')));
  assert.equal(answers.size, 1, `varied: ${[...answers].join(', ')}`);
  assert.equal([...answers][0], 'm_c', 'earliest join wins');
});

test('a member with no explicit connected flag counts as connected', () => {
  // The server sets `connected` explicitly, but a defensive default of
  // "present" is safer than silently skipping a real member.
  const r = { members: new Map([['m_a', { id: 'm_a', joinedAt: 1 }]]), lobby: new Map() };
  assert.equal(chooseSuccessor(r, 'm_gone'), 'm_a');
});

test('calling with no leaving id picks a host for the room as it stands', () => {
  const r = room([['m_a', 2], ['m_b', 1]]);
  assert.equal(chooseSuccessor(r), 'm_b');
});
