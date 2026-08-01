/**
 * Recent-room retention rules (src/lib/recentRooms.ts).
 *
 * Context for what these protect. The codes live in localStorage and never leave
 * the browser: the server has NO room-listing endpoint, and a passphrase is
 * checked server-side on every join, so a code by itself opens nothing that is
 * actually locked. The risk that remains is a SHARED device — a code sitting on
 * the home screen indefinitely let whoever picked the phone up next walk into an
 * unlocked room. Rooms are reaped 15 minutes after emptying anyway, so an old
 * code is almost always dead: exposure without benefit.
 *
 * Run: node --test --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/recent-rooms.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RECENT_ROOM_LIMIT,
  RECENT_ROOM_TTL_MS,
  isFreshRoom,
  pruneRecentRooms,
  withRoomForgotten,
  withRoomRemembered,
} from '../src/lib/recentRooms.ts';

const NOW = 1_000_000_000;
const codes = (list) => list.map((room) => room.code);

/* ---------------- freshness ---------------- */

test('an entry inside the window is fresh', () => {
  assert.equal(isFreshRoom({ code: 'FRESH1', at: NOW - 60_000 }, NOW), true);
});

test('an entry past the window is NOT fresh', () => {
  assert.equal(isFreshRoom({ code: 'STALE1', at: NOW - RECENT_ROOM_TTL_MS - 1 }, NOW), false);
});

test('the boundary is exclusive — exactly at the TTL has expired', () => {
  assert.equal(isFreshRoom({ code: 'EDGE01', at: NOW - RECENT_ROOM_TTL_MS }, NOW), false);
  assert.equal(isFreshRoom({ code: 'EDGE02', at: NOW - RECENT_ROOM_TTL_MS + 1 }, NOW), true);
});

test('malformed entries are never fresh', () => {
  for (const bad of [null, undefined, 42, 'ABC123', {}, { code: 'NOTIME' }, { at: NOW }, { code: '', at: NOW }]) {
    assert.equal(isFreshRoom(bad, NOW), false, `should reject ${JSON.stringify(bad)}`);
  }
});

/* ---------------- pruning ---------------- */

test('pruning drops expired codes and keeps the rest in order', () => {
  const list = [
    { code: 'FRESH1', at: NOW - 1000 },
    { code: 'STALE1', at: NOW - RECENT_ROOM_TTL_MS - 1 },
    { code: 'FRESH2', at: NOW - 2000 },
  ];
  assert.deepEqual(codes(pruneRecentRooms(list, NOW)), ['FRESH1', 'FRESH2']);
});

test('pruning is total — an all-expired list becomes empty', () => {
  const list = [
    { code: 'OLD001', at: NOW - RECENT_ROOM_TTL_MS - 1 },
    { code: 'OLD002', at: NOW - RECENT_ROOM_TTL_MS * 3 },
  ];
  assert.deepEqual(pruneRecentRooms(list, NOW), []);
});

test('anything that is not a list is treated as empty, never thrown on', () => {
  for (const junk of [null, undefined, 'nope', 7, {}]) {
    assert.deepEqual(pruneRecentRooms(junk, NOW), []);
  }
});

test('the list is capped', () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ code: `ROOM${i}`, at: NOW - i }));
  assert.equal(pruneRecentRooms(many, NOW).length, RECENT_ROOM_LIMIT);
});

/* ---------------- remembering ---------------- */

test('a remembered room goes to the front', () => {
  const list = [{ code: 'OLDER1', at: NOW - 5000 }];
  assert.deepEqual(codes(withRoomRemembered(list, 'NEWER1', 'Dune', NOW)), ['NEWER1', 'OLDER1']);
});

test('remembering the same room again does not duplicate it', () => {
  const list = [{ code: 'SAME01', at: NOW - 5000 }, { code: 'OTHER1', at: NOW - 6000 }];
  const next = withRoomRemembered(list, 'SAME01', undefined, NOW);
  assert.deepEqual(codes(next), ['SAME01', 'OTHER1']);
  assert.equal(next.filter((r) => r.code === 'SAME01').length, 1);
});

test('remembering also prunes what has expired', () => {
  const list = [{ code: 'STALE1', at: NOW - RECENT_ROOM_TTL_MS - 1 }];
  assert.deepEqual(codes(withRoomRemembered(list, 'NEW001', undefined, NOW)), ['NEW001']);
});

test('remembering respects the cap', () => {
  const many = Array.from({ length: RECENT_ROOM_LIMIT }, (_, i) => ({ code: `ROOM${i}`, at: NOW - i }));
  assert.equal(withRoomRemembered(many, 'BRAND1', undefined, NOW).length, RECENT_ROOM_LIMIT);
});

/* ---------------- forgetting (the shared-device escape hatch) ---------------- */

test('a single room can be forgotten', () => {
  const list = [{ code: 'KEEP01', at: NOW - 1000 }, { code: 'DROP01', at: NOW - 2000 }];
  assert.deepEqual(codes(withRoomForgotten(list, 'DROP01', NOW)), ['KEEP01']);
});

test('forgetting a code that is not there changes nothing', () => {
  const list = [{ code: 'KEEP01', at: NOW - 1000 }];
  assert.deepEqual(codes(withRoomForgotten(list, 'ABSENT', NOW)), ['KEEP01']);
});

/* ---------------- the policy itself ---------------- */

test('the retention window is short enough to matter', () => {
  // A room dies 15 minutes after the last person leaves, so holding codes for
  // days is exposure with no upside.
  assert.ok(RECENT_ROOM_TTL_MS <= 24 * 60 * 60 * 1000, `TTL ${RECENT_ROOM_TTL_MS}ms is too long`);
  assert.ok(RECENT_ROOM_TTL_MS >= 60 * 60 * 1000, 'but long enough to be useful the same evening');
});
