/**
 * Refresh recovery: what is persisted, what is never persisted, and how strictly
 * a reselected file has to match.
 *
 * A browser cannot hand a `File` back after a reload, so the whole design is
 * "recognise the session, ask the user to pick the same file". The strictness is
 * the point: resuming across a different file would splice two movies into one
 * object that passes every size check and plays as garbage.
 *
 * Run: node --test --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/upload-recovery.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UPLOAD_RECOVERY_VERSION,
  clearSession,
  clearSingleCleanup,
  describeFingerprintMismatch,
  fingerprintOf,
  loadSession,
  loadSingleCleanup,
  matchesFingerprint,
  saveSession,
  saveSingleCleanup,
} from '../src/lib/uploadRecovery.ts';

const MIB = 1024 * 1024;
const ROOM = 'ABC123';
const NOW = 1_700_000_000_000;

function store() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    keys: () => [...map.keys()],
    values: () => [...map.values()],
  };
}

const file = (over = {}) => ({
  name: over.name ?? 'movie.mp4',
  size: over.size ?? 17 * MIB,
  type: over.type ?? 'video/mp4',
  lastModified: over.lastModified ?? 1_699_000_000_000,
});

const session = (over = {}) => ({
  version: UPLOAD_RECOVERY_VERSION,
  mode: 'multipart',
  token: 'session-token-1',
  ...fingerprintOf(file()),
  partSize: 8 * MIB,
  partCount: 3,
  expiresAt: NOW + 6 * 3600_000,
  roomCode: ROOM,
  ...over,
});

/* ============================================== round trip */

test('a session round-trips and is scoped to its room', () => {
  const s = store();
  assert.equal(saveSession(s, session()), true);
  const loaded = loadSession(s, ROOM, NOW);
  assert.deepEqual(loaded, session());
  // Another room's key must not see it.
  assert.equal(loadSession(s, 'ZZZ999', NOW), null);
});

test('only safe metadata is persisted — never a File, Blob or URL', () => {
  const s = store();
  saveSession(s, session());
  const raw = s.values()[0];
  const parsed = JSON.parse(raw);

  assert.deepEqual(Object.keys(parsed).sort(), [
    'expiresAt',
    'fileName',
    'lastModified',
    'mode',
    'partCount',
    'partSize',
    'roomCode',
    'size',
    'token',
    'type',
    'version',
  ]);
  // Nothing that could hold bytes or a write capability for a part.
  for (const forbidden of ['blob:', 'data:', 'https://', 'etag', 'ETag', 'uploadId', 'key', 'parts']) {
    assert.equal(raw.includes(forbidden), false, `persisted record contains "${forbidden}"`);
  }
});

test('the token lives in a tab-scoped store, keyed per room', () => {
  const s = store();
  saveSession(s, session());
  assert.deepEqual(s.keys(), ['cineverse.upload.session.ABC123']);
});

/* ============================================== rejection */

test('an unreadable, wrong-version or malformed record is treated as absent AND cleared', () => {
  const cases = [
    ['not JSON', 'definitely-not-json'],
    ['not an object', '42'],
    ['null', 'null'],
    ['wrong version', JSON.stringify(session({ version: 99 }))],
    ['wrong mode', JSON.stringify(session({ mode: 'single' }))],
    ['no token', JSON.stringify(session({ token: '' }))],
    ['non-string token', JSON.stringify(session({ token: 42 }))],
    ['zero size', JSON.stringify(session({ size: 0 }))],
    ['fractional size', JSON.stringify(session({ size: 1.5 }))],
    ['missing partSize', JSON.stringify(session({ partSize: undefined }))],
    ['fractional lastModified', JSON.stringify(session({ lastModified: 1.5 }))],
    ['room mismatch inside the record', JSON.stringify(session({ roomCode: 'OTHER1' }))],
  ];
  for (const [label, raw] of cases) {
    const s = store();
    s.setItem('cineverse.upload.session.ABC123', raw);
    assert.equal(loadSession(s, ROOM, NOW), null, label);
    // A half-valid record is worse than none: it would offer a resume that cannot
    // work, so it is removed rather than left to be re-read.
    assert.deepEqual(s.keys(), [], `${label} must be cleared`);
  }
});

test('an expired session is not offered, because it cannot be renewed', () => {
  const s = store();
  saveSession(s, session({ expiresAt: NOW - 1 }));
  assert.equal(loadSession(s, ROOM, NOW), null);
  assert.deepEqual(s.keys(), []);

  // One millisecond of life left is still life.
  saveSession(s, session({ expiresAt: NOW + 1 }));
  assert.ok(loadSession(s, ROOM, NOW));
});

test('a missing or throwing store degrades quietly', () => {
  assert.equal(saveSession(null, session()), false);
  assert.equal(loadSession(null, ROOM, NOW), null);
  assert.doesNotThrow(() => clearSession(null, ROOM));

  // Private-mode Safari throws on write; losing recoverability must not break the
  // upload that is currently working.
  const hostile = {
    getItem() {
      throw new Error('nope');
    },
    setItem() {
      throw new Error('quota');
    },
    removeItem() {
      throw new Error('nope');
    },
  };
  assert.equal(saveSession(hostile, session()), false);
  assert.equal(loadSession(hostile, ROOM, NOW), null);
  assert.doesNotThrow(() => clearSession(hostile, ROOM));
});

/* ============================================== single-shot cleanup */

const singleRecord = (over = {}) => ({
  version: UPLOAD_RECOVERY_VERSION,
  mode: 'single',
  roomCode: ROOM,
  token: 'single-token-1',
  fileName: 'movie.mp4',
  size: 2 * MIB,
  expiresAt: NOW + 3600_000,
  ...over,
});

test('a single-shot cleanup record round-trips, scoped to its room and separate from multipart', () => {
  const s = store();
  assert.equal(saveSingleCleanup(s, singleRecord()), true);
  assert.deepEqual(loadSingleCleanup(s, ROOM, NOW), singleRecord());
  assert.equal(loadSingleCleanup(s, 'ZZZ999', NOW), null);
  // It uses a DISTINCT key from multipart recovery, so the two never collide.
  saveSession(s, session());
  assert.ok(loadSingleCleanup(s, ROOM, NOW), 'single record survives a multipart save');
  assert.ok(loadSession(s, ROOM, NOW), 'multipart record survives a single save');
  assert.equal(s.keys().length, 2, 'two independent keys');
});

test('an expired or malformed single cleanup record is absent AND cleared', () => {
  const s = store();
  saveSingleCleanup(s, singleRecord({ expiresAt: NOW - 1 }));
  assert.equal(loadSingleCleanup(s, ROOM, NOW), null);
  assert.deepEqual(s.keys(), [], 'the dead record is cleared');

  for (const [label, over] of [
    ['wrong version', { version: 999 }],
    ['wrong mode', { mode: 'multipart' }],
    ['empty token', { token: '' }],
    ['zero size', { size: 0 }],
    ['wrong room', { roomCode: 'OTHER1' }],
  ]) {
    const s2 = store();
    saveSingleCleanup(s2, singleRecord(over));
    assert.equal(loadSingleCleanup(s2, ROOM, NOW), null, label);
  }
});

test('single cleanup save/clear degrade quietly with a missing or hostile store', () => {
  assert.equal(saveSingleCleanup(null, singleRecord()), false);
  assert.equal(loadSingleCleanup(null, ROOM, NOW), null);
  assert.doesNotThrow(() => clearSingleCleanup(null, ROOM));
  clearSingleCleanup(store(), ROOM); // no-op on an empty store, no throw
});

/* ============================================== fingerprint */

test('all four fingerprint properties must match exactly', () => {
  const s = session();
  assert.equal(matchesFingerprint(s, file()), true);

  const mismatches = [
    ['name', file({ name: 'movie (1).mp4' })],
    ['size', file({ size: 17 * MIB + 1 })],
    ['type', file({ type: 'video/webm' })],
    ['lastModified', file({ lastModified: 1_699_000_000_001 })],
  ];
  for (const [label, candidate] of mismatches) {
    assert.equal(matchesFingerprint(s, candidate), false, label);
    // And the message names the property, so the user can act on it.
    const message = describeFingerprintMismatch(s, candidate);
    assert.ok(message && message.length > 0, label);
  }
  assert.equal(describeFingerprintMismatch(s, file()), null, 'a match has no message');
});

test('a same-name same-size re-encode is still refused', () => {
  /*
   * The dangerous near-miss: identical name, identical byte count, different
   * content. Only lastModified distinguishes them, and resuming across it would
   * assemble parts from two different films into an object whose total size is
   * exactly right.
   */
  const s = session();
  const reencoded = file({ lastModified: s.lastModified + 60_000 });
  assert.equal(matchesFingerprint(s, reencoded), false);
  assert.match(describeFingerprintMismatch(s, reencoded), /modified/);
});

test('the fingerprint is taken from the File itself', () => {
  const f = file({ name: 'a.webm', size: 5 * MIB, type: 'video/webm', lastModified: 123 });
  assert.deepEqual(fingerprintOf(f), {
    fileName: 'a.webm',
    size: 5 * MIB,
    type: 'video/webm',
    lastModified: 123,
  });
});

test('clearing removes the record for that room only', () => {
  const s = store();
  saveSession(s, session());
  saveSession(s, session({ roomCode: 'ZZZ999' }));
  clearSession(s, ROOM);
  assert.deepEqual(s.keys(), ['cineverse.upload.session.ZZZ999']);
});
