/**
 * The upload lifecycle authority: coordination, limits, terminal tombstones and
 * observable expiry.
 *
 * It is no longer just a counter. A completed/aborted/expired session is
 * TOMBSTONED until its token would have expired, so a replay against it is
 * refused — deletion alone is not enough, because absence cannot tell "never
 * existed" from "already over". The clock is injected, so every lifecycle and
 * expiry rule is asserted without waiting real minutes.
 *
 * Run: node --test --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/uploads-sessions.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createUploadSessionRegistry,
  hashToken,
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  lifecycleOf,
} = require('../server/uploads-sessions.js');

const MIB = 1024 * 1024;
const NOW = 1_700_000_000_000;
const HOUR = 3600_000;

const entry = (over = {}) => ({
  token: over.token ?? 'token-1',
  transport: over.transport ?? 'multipart',
  roomCode: over.roomCode ?? 'ABC123',
  memberId: over.memberId ?? 'member-1',
  key: over.key ?? 'rooms/ABC123/0123456789abcdef/movie.mp4',
  uploadId: over.uploadId ?? 'upload-1',
  expectedBytes: over.expectedBytes ?? 17 * MIB,
  partCount: over.partCount ?? 3,
  expiresAt: over.expiresAt ?? NOW + 6 * HOUR,
  label: over.label ?? 'movie.mp4',
  now: over.now ?? NOW,
});

/* ============================================== raw token never kept */

test('the raw token is never stored, only a SHA-256 lookup key', () => {
  const registry = createUploadSessionRegistry();
  const token = 'a-very-secret-session-capability';
  const record = registry.register(entry({ token }));

  assert.equal(record.tokenHash, crypto.createHash('sha256').update(token).digest('hex'));
  assert.equal(JSON.stringify(record).includes(token), false);
  assert.equal(JSON.stringify(registry.listForRoom('ABC123')).includes(token), false);
  assert.equal(registry.get(token).uploadId, 'upload-1');
});

/* ============================================== lifecycle states */

test('lifecycleOf maps fine-grained status to the coarse authority state', () => {
  assert.equal(lifecycleOf('uploading'), 'active');
  assert.equal(lifecycleOf('paused'), 'active');
  assert.equal(lifecycleOf('finalizing'), 'finalizing');
  assert.equal(lifecycleOf('completed'), 'completed');
  assert.equal(lifecycleOf('aborted'), 'aborted');
  assert.equal(lifecycleOf('expired'), 'expired');
});

test('a fresh session is active; marking it terminal keeps it as a tombstone', () => {
  const registry = createUploadSessionRegistry();
  registry.register(entry());
  assert.equal(registry.lifecycle('token-1', NOW), 'active');

  const done = registry.markTerminal('token-1', 'completed', NOW + 1000);
  assert.equal(done.status, 'completed');
  // Still present — the tombstone is the whole point.
  assert.equal(registry.get('token-1').status, 'completed');
  assert.equal(registry.lifecycle('token-1', NOW + 1000), 'completed');
  assert.equal(registry.size(), 1);
});

test('a terminal record is immutable — it cannot be walked back to active', () => {
  const registry = createUploadSessionRegistry();
  registry.register(entry());
  registry.markTerminal('token-1', 'completed', NOW);

  // update refuses a terminal record…
  assert.equal(registry.update('token-1', { status: 'uploading' }, NOW + 1), null);
  assert.equal(registry.get('token-1').status, 'completed');
  // …and re-marking is an idempotent no-op, not a second transition.
  const again = registry.markTerminal('token-1', 'aborted', NOW + 2);
  assert.equal(again.alreadyTerminal, true);
  assert.equal(registry.get('token-1').status, 'completed', 'the first terminal state wins');
});

/* ============================================== progress replay authority */

test('progressVerdict refuses a completed, aborted or expired session', () => {
  const registry = createUploadSessionRegistry();
  registry.register(entry({ token: 'active' }));
  registry.register(entry({ token: 'done', memberId: 'm2' }));
  registry.markTerminal('done', 'completed', NOW);
  registry.register(entry({ token: 'gone', memberId: 'm3' }));
  registry.markTerminal('gone', 'aborted', NOW);

  assert.deepEqual(registry.progressVerdict('active', NOW), { ok: true });
  assert.deepEqual(registry.progressVerdict('done', NOW), { ok: false, error: 'SESSION_TERMINAL' });
  assert.deepEqual(registry.progressVerdict('gone', NOW), { ok: false, error: 'SESSION_TERMINAL' });
  // Absent is allowed: the signed token remains the gate, and a post-restart
  // replay looks identical to a never-existed one.
  assert.deepEqual(registry.progressVerdict('never', NOW), { ok: true, absent: true });
});

test('progressVerdict refuses a session past its expiry even before the sweep runs', () => {
  const registry = createUploadSessionRegistry();
  registry.register(entry({ expiresAt: NOW + 1000 }));
  assert.deepEqual(registry.progressVerdict('token-1', NOW), { ok: true });
  assert.deepEqual(registry.progressVerdict('token-1', NOW + 2000), { ok: false, error: 'SESSION_EXPIRED' });
});

/* ============================================== limits (multipart only) */

test('one active MULTIPART upload per member', () => {
  const registry = createUploadSessionRegistry({ maxPerMember: 1, maxPerRoom: 2 });
  assert.deepEqual(registry.canStart('ABC123', 'member-1'), { ok: true });
  registry.register(entry({ token: 'a' }));
  assert.deepEqual(registry.canStart('ABC123', 'member-1'), { ok: false, error: 'UPLOAD_ALREADY_ACTIVE' });
  assert.deepEqual(registry.canStart('ABC123', 'member-2'), { ok: true });
  assert.deepEqual(registry.canStart('ZZZ999', 'member-1'), { ok: true });
});

test('a single-shot grant does NOT count against the multipart limits', () => {
  const registry = createUploadSessionRegistry({ maxPerMember: 1, maxPerRoom: 2 });
  registry.register(entry({ token: 's', transport: 'single', uploadId: undefined, partCount: undefined }));
  // A single-shot upload in flight must not block a multipart start.
  assert.deepEqual(registry.canStart('ABC123', 'member-1'), { ok: true });
  assert.equal(registry.countForMember('ABC123', 'member-1'), 0);
});

test('terminal sessions free the limit slot', () => {
  const registry = createUploadSessionRegistry({ maxPerMember: 1, maxPerRoom: 2 });
  registry.register(entry({ token: 'a' }));
  assert.equal(registry.canStart('ABC123', 'member-1').ok, false);

  registry.markTerminal('a', 'completed', NOW);
  assert.equal(registry.canStart('ABC123', 'member-1').ok, true, 'a completed upload frees the slot');
  // Every active status counts; every terminal one does not.
  for (const status of ACTIVE_STATUSES) {
    registry.register(entry({ token: `x-${status}` }));
    registry.update(`x-${status}`, { status }, NOW);
    assert.equal(registry.canStart('ABC123', 'member-1').ok, false, status);
    registry.markTerminal(`x-${status}`, 'aborted', NOW);
  }
  for (const status of TERMINAL_STATUSES) {
    assert.equal(registry.canStart('ABC123', 'member-1').ok, true, status);
  }
});

/* ============================================== departure tombstones */

test('taking a member’s sessions tombstones them and returns them for aborting', () => {
  const registry = createUploadSessionRegistry({ maxPerMember: 5, maxPerRoom: 9 });
  registry.register(entry({ token: 'a', memberId: 'member-1', uploadId: 'u-a' }));
  registry.register(entry({ token: 'b', memberId: 'member-1', uploadId: 'u-b' }));
  registry.register(entry({ token: 'c', memberId: 'member-2', uploadId: 'u-c' }));
  registry.markTerminal('b', 'completed', NOW); // already over — not taken

  const taken = registry.takeForMember('ABC123', 'member-1', NOW);
  assert.deepEqual(taken.map((s) => s.uploadId), ['u-a']);
  // Tombstoned, not deleted: a departed member's still-valid token cannot replay.
  assert.equal(registry.get('a').status, 'aborted');
  assert.equal(registry.progressVerdict('a', NOW).error, 'SESSION_TERMINAL');
  // No longer counts, so a second take finds nothing.
  assert.deepEqual(registry.takeForMember('ABC123', 'member-1', NOW), []);
  assert.ok(registry.get('c'));
});

test('taking a room’s sessions tombstones every active upload in it', () => {
  const registry = createUploadSessionRegistry({ maxPerMember: 5, maxPerRoom: 9 });
  registry.register(entry({ token: 'a', memberId: 'm1' }));
  registry.register(entry({ token: 'b', memberId: 'm2' }));
  registry.register(entry({ token: 'c', roomCode: 'ZZZ999', memberId: 'm3' }));

  const taken = registry.takeForRoom('ABC123', NOW);
  assert.equal(taken.length, 2);
  assert.equal(registry.countForRoom('ABC123'), 0, 'no active sessions remain');
  assert.equal(registry.get('a').status, 'aborted');
  assert.equal(registry.countForRoom('ZZZ999'), 1, 'other rooms untouched');
});

/* ============================================== observable expiry */

test('sweep returns expired ACTIVE entries, tombstones them, and deletes dead ones', () => {
  const registry = createUploadSessionRegistry({ maxPerMember: 9, maxPerRoom: 9 });
  registry.register(entry({ token: 'live', expiresAt: NOW + HOUR }));
  registry.register(entry({ token: 'stale', memberId: 'm2', uploadId: 'u-stale', expiresAt: NOW - 1 }));
  registry.register(entry({ token: 'single-stale', transport: 'single', memberId: 'm3', uploadId: undefined, expiresAt: NOW - 1 }));
  registry.register(entry({ token: 'old-done', memberId: 'm4', expiresAt: NOW - 1 }));
  registry.markTerminal('old-done', 'completed', NOW - HOUR); // terminal AND past expiry

  const { removed, expired } = registry.sweep(NOW);

  // The one terminal-past-expiry tombstone is deleted.
  assert.equal(removed, 1);
  assert.equal(registry.get('old-done'), null);
  // The two expired ACTIVE sessions are returned, with everything an abort needs.
  assert.deepEqual(expired.map((e) => e.tokenHash).sort(), [hashToken('stale'), hashToken('single-stale')].sort());
  const stale = expired.find((e) => e.tokenHash === hashToken('stale'));
  assert.equal(stale.transport, 'multipart');
  assert.equal(stale.uploadId, 'u-stale');
  assert.equal(stale.memberId, 'm2');
  const single = expired.find((e) => e.tokenHash === hashToken('single-stale'));
  assert.equal(single.transport, 'single');
  // They are now tombstoned expired, so a progress replay is refused.
  assert.equal(registry.get('stale').status, 'expired');
  assert.equal(registry.progressVerdict('stale', NOW).error, 'SESSION_EXPIRED');
  // The live session is untouched.
  assert.equal(registry.get('live').status, 'uploading');
});

test('sweep is idempotent: an expired session is returned once, then cleaned up', () => {
  const registry = createUploadSessionRegistry({ maxPerMember: 9, maxPerRoom: 9 });
  registry.register(entry({ token: 'stale', expiresAt: NOW - 1 }));

  // First pass: the active-but-expired session is tombstoned and returned once.
  const first = registry.sweep(NOW);
  assert.equal(first.expired.length, 1);
  assert.equal(first.removed, 0);
  assert.equal(registry.get('stale').status, 'expired');

  // Second pass at the same instant: never returned as "newly expired" again. The
  // tombstone's token is already dead (its expiry is in the past), so a genuinely
  // expired session is also reclaimed on this next pass — there is no replay
  // window to protect, unlike a COMPLETED session whose token is still valid.
  const second = registry.sweep(NOW);
  assert.equal(second.expired.length, 0, 'not returned as newly-expired twice');
  assert.equal(second.removed, 1, 'the dead tombstone is reclaimed');
  assert.equal(registry.get('stale'), null);
});

test('a COMPLETED tombstone survives until its token would have expired', () => {
  const registry = createUploadSessionRegistry({ maxPerMember: 9, maxPerRoom: 9 });
  registry.register(entry({ token: 'done', expiresAt: NOW + 6 * HOUR }));
  registry.markTerminal('done', 'completed', NOW);

  // Well before expiry, repeated sweeps keep the tombstone so a replay is refused.
  for (const t of [NOW, NOW + HOUR, NOW + 5 * HOUR]) {
    const { removed } = registry.sweep(t);
    assert.equal(removed, 0, `t=${t}`);
    assert.equal(registry.progressVerdict('done', t).error, 'SESSION_TERMINAL');
  }
  // Once the token would have expired, the tombstone is finally reclaimed.
  const { removed } = registry.sweep(NOW + 6 * HOUR + 1);
  assert.equal(removed, 1);
  assert.equal(registry.get('done'), null);
});

/* ============================================== renewal + bounds */

test('a renewal supersedes the old token and activates the new one, counting once', () => {
  const registry = createUploadSessionRegistry({ maxPerMember: 1, maxPerRoom: 2 });
  registry.register(entry());
  const renewed = registry.rekey('token-1', 'token-2', { expiresAt: NOW + 12 * HOUR, now: NOW + 1000 });
  assert.equal(renewed.ok, true);
  assert.equal(renewed.expiresAt, NOW + 12 * HOUR);
  assert.equal(renewed.status, 'uploading');

  // The old token is a SUPERSEDED tombstone (retained), not deleted.
  assert.equal(registry.get('token-1').status, 'superseded');
  // Its original expiry is preserved (only the NEW token got the renewed expiry).
  assert.equal(registry.get('token-1').expiresAt, NOW + 6 * HOUR);
  assert.equal(registry.get('token-2').uploadId, 'upload-1');
  assert.equal(registry.size(), 2, 'both records exist: one active, one tombstone');

  // The superseded token is refused; the new one is allowed.
  assert.deepEqual(registry.authorityCheck('token-1', NOW + 1000), { ok: false, error: 'SESSION_SUPERSEDED' });
  assert.deepEqual(registry.authorityCheck('token-2', NOW + 1000), { ok: true });
  assert.equal(registry.progressVerdict('token-1', NOW + 1000).error, 'SESSION_SUPERSEDED');

  // The session still counts EXACTLY ONCE against the limits (only the active).
  assert.equal(registry.countForMember('ABC123', 'member-1'), 1);
  assert.equal(registry.canStart('ABC123', 'member-1').error, 'UPLOAD_ALREADY_ACTIVE');

  // The superseded tombstone is reclaimed once its original token would expire.
  registry.sweep(NOW + 6 * HOUR + 1);
  assert.equal(registry.get('token-1'), null);
  assert.equal(registry.get('token-2').status, 'uploading');

  // A terminal session cannot be renewed.
  registry.register(entry({ token: 'done', memberId: 'other' }));
  registry.markTerminal('done', 'completed', NOW);
  assert.deepEqual(registry.rekey('done', 'x'), { ok: false, error: 'SESSION_NOT_RENEWABLE' });
  // Neither can an absent one.
  assert.deepEqual(registry.rekey('never', 'x'), { ok: false, error: 'SESSION_NOT_RENEWABLE' });
});

test('rekey is REGISTRY-BOUNDED: a renewal at capacity is refused, the old token stays active', () => {
  // Two slots. Register one active session and renew it once (superseded + new =
  // 2 records, exactly at the bound). A SECOND renewal has no room for a third
  // record and must be refused without touching the still-active token.
  const registry = createUploadSessionRegistry({ maxPerMember: 9, maxPerRoom: 9, maxSessions: 2 });
  registry.register(entry({ token: 't1' }));

  const first = registry.rekey('t1', 't2', { expiresAt: NOW + 7 * HOUR, now: NOW + 1000 });
  assert.equal(first.ok, true);
  assert.equal(registry.size(), 2, 'superseded t1 + active t2');

  const second = registry.rekey('t2', 't3', { expiresAt: NOW + 8 * HOUR, now: NOW + 2000 });
  assert.deepEqual(second, { ok: false, error: 'SESSION_REGISTRY_FULL' });
  // t2 is untouched and still active; t3 was never created.
  assert.equal(registry.get('t2').status, 'uploading');
  assert.equal(registry.get('t3'), null);
  assert.equal(registry.size(), 2, 'the registry never exceeds maxSessions');
});

test('100 renewal attempts against a tiny registry prove the HARD bound', () => {
  const registry = createUploadSessionRegistry({ maxPerMember: 9, maxPerRoom: 9, maxSessions: 2 });
  registry.register(entry({ token: 'r0' }));

  let current = 'r0';
  let accepted = 0;
  let refused = 0;
  for (let i = 1; i <= 100; i += 1) {
    const r = registry.rekey(current, `r${i}`, { expiresAt: NOW + (6 + i) * HOUR, now: NOW + i });
    if (r.ok) {
      accepted += 1;
      current = `r${i}`;
    } else {
      assert.equal(r.error, 'SESSION_REGISTRY_FULL', `attempt ${i}`);
      refused += 1;
    }
    // The invariant under test: the map NEVER exceeds the bound, on any attempt.
    assert.ok(registry.size() <= 2, `size ${registry.size()} exceeded the bound at attempt ${i}`);
  }
  // Exactly one renewal fits (r0→r1 → superseded r0 + active r1 = 2); the tombstone
  // holds its slot until r0's expiry, so every later attempt is refused.
  assert.equal(accepted, 1);
  assert.equal(refused, 99);
  assert.equal(registry.get('r1').status, 'uploading', 'the one accepted renewal is still active');
});

test('the registry fails CLOSED at capacity — it never evicts an active record', () => {
  const registry = createUploadSessionRegistry({ maxPerMember: 500, maxPerRoom: 500, maxSessions: 2 });
  assert.equal(registry.register(entry({ token: 'A', memberId: 'mA' })).ok, true);
  assert.equal(registry.register(entry({ token: 'B', memberId: 'mB' })).ok, true);

  // A third registration is REFUSED, not squeezed in by evicting A or B.
  const c = registry.register(entry({ token: 'C', memberId: 'mC' }));
  assert.equal(c.ok, false);
  assert.equal(c.error, 'SESSION_REGISTRY_FULL');

  // A and B are untouched and still authoritative.
  assert.equal(registry.get('A').status, 'uploading');
  assert.equal(registry.get('B').status, 'uploading');
  assert.equal(registry.get('C'), null);
  assert.equal(registry.progressVerdict('A', NOW).ok, true);
  assert.equal(registry.countForRoom('ABC123'), 2, 'both still count against limits');
});

test('capacity is only freed by reclaiming EXPIRED tombstones, never live records', () => {
  const registry = createUploadSessionRegistry({ maxPerMember: 500, maxPerRoom: 500, maxSessions: 2 });
  // One active, one COMPLETED tombstone whose token is still valid.
  registry.register(entry({ token: 'active', expiresAt: NOW + 6 * HOUR }));
  registry.register(entry({ token: 'done', memberId: 'm2', expiresAt: NOW + 6 * HOUR }));
  registry.markTerminal('done', 'completed', NOW);

  // Full: an unexpired completed tombstone must NOT be evicted to make room.
  assert.equal(registry.register(entry({ token: 'x', memberId: 'm3' })).error, 'SESSION_REGISTRY_FULL');
  assert.equal(registry.get('done').status, 'completed', 'the unexpired tombstone survives');

  // Once the tombstone's token has expired, it becomes reclaimable and a new
  // registration succeeds by pruning it.
  const later = NOW + 6 * HOUR + 1;
  const ok = registry.register(entry({ token: 'y', memberId: 'm4', expiresAt: later + HOUR, now: later }));
  assert.equal(ok.ok, true);
  assert.equal(registry.get('done'), null, 'the expired tombstone was reclaimed');
  assert.equal(registry.get('active').status, 'uploading', 'the active record was never touched');
});

test('re-registering the SAME token is idempotent even at capacity', () => {
  const registry = createUploadSessionRegistry({ maxSessions: 1 });
  assert.equal(registry.register(entry({ token: 'A' })).ok, true);
  // The same token overwrites its own slot rather than being refused as "full".
  assert.equal(registry.register(entry({ token: 'A', label: 'renamed.mp4' })).ok, true);
  assert.equal(registry.get('A').label, 'renamed.mp4');
  assert.equal(registry.size(), 1);
});

test('invalid limit options fall back to the safe defaults', () => {
  for (const bad of [0, -1, 1.5, NaN, 'two', undefined]) {
    const registry = createUploadSessionRegistry({ maxPerMember: bad, maxPerRoom: bad });
    assert.equal(registry.limits.maxPerMember, 1, String(bad));
    assert.equal(registry.limits.maxPerRoom, 2, String(bad));
  }
});
