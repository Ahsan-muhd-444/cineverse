/**
 * Pure tests for the resumable multipart core: configuration bounds, part
 * planning, session tokens and manifest validation.
 *
 * No server, no bucket, no bytes — every rule in server/uploads-multipart.js is
 * arithmetic or crypto, which is exactly why it lives in its own module.
 *
 * Run: node --test --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/uploads-multipart.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mp = require('../server/uploads-multipart.js');

const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;
const SECRET = 'test-secret-value';

const baseSession = () => ({
  key: 'rooms/ABC123/0123456789abcdef/movie.mp4',
  uploadId: 'upload-id-1',
  roomCode: 'ABC123',
  memberId: 'member-1',
  mimeType: 'video/mp4',
  expectedBytes: 100 * MIB,
  maxBytes: 3 * GIB,
  partSize: 16 * MIB,
  partCount: Math.ceil((100 * MIB) / (16 * MIB)),
  ttlMs: 60_000,
});

/**
 * TEST-ONLY raw signer.
 *
 * Signs an arbitrary claim body with the real secret, so a test can present a
 * token the production issuer would REFUSE to mint. That refusal is the point:
 * `issueMultipartToken` validates the complete grant before signing, so the only
 * honest way to prove `verifyMultipartToken` re-checks every claim is to forge
 * one here rather than weaken the issuer.
 */
function signRawSession(overrides = {}) {
  const s = { ...baseSession(), ...overrides };
  const body = {
    v: 1,
    t: 'transport' in overrides ? overrides.transport : 'multipart',
    k: s.key,
    u: s.uploadId,
    r: s.roomCode,
    s: s.memberId,
    m: s.mimeType,
    n: s.expectedBytes,
    b: s.maxBytes,
    p: s.partSize,
    c: s.partCount,
    e: 'expiresAt' in s ? s.expiresAt : Date.now() + (s.ttlMs ?? 60_000),
  };
  const encoded = Buffer.from(JSON.stringify(body)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

/* ------------------------------------------------------------------ limits */

test('the hard ceiling is exactly 3 GiB', () => {
  assert.equal(mp.HARD_MAX_BYTES, 3 * 1024 * 1024 * 1024);
  assert.equal(mp.HARD_MAX_BYTES, 3_221_225_472);
});

test('exactly 3 GiB is an accepted configuration', () => {
  const { config, errors } = mp.readMultipartConfig({ MAX_UPLOAD_BYTES: String(3 * GIB) });
  assert.deepEqual(errors, []);
  assert.equal(config.maxUploadBytes, 3 * GIB);
});

test('one byte over 3 GiB is rejected', () => {
  const { errors } = mp.readMultipartConfig({ MAX_UPLOAD_BYTES: String(3 * GIB + 1) });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /must not exceed/);
});

test('invalid, negative and fractional maximums are rejected', () => {
  for (const bad of ['0', '-1', '1.5', 'abc', '1e9', '16MB', 'Infinity', 'NaN', '0x10']) {
    const { errors } = mp.readMultipartConfig({ MAX_UPLOAD_BYTES: bad });
    assert.ok(errors.length >= 1, `expected "${bad}" to be rejected`);
  }
});

test('an empty or absent maximum falls back to the default rather than erroring', () => {
  // `FOO=` in a .env file is "unset", not "zero" — erroring there would make a
  // blank line in someone's environment file a failed deploy.
  for (const value of ['', ' ', undefined]) {
    const { config, errors } = mp.readMultipartConfig({ MAX_UPLOAD_BYTES: value });
    assert.deepEqual(errors, [], `value ${JSON.stringify(value)}`);
    assert.equal(config.maxUploadBytes, mp.DEFAULTS.maxUploadBytes);
  }
});

test('LOCAL_UPLOAD_MAX_BYTES must be positive and <= MAX_UPLOAD_BYTES', () => {
  assert.equal(mp.readMultipartConfig({ MAX_UPLOAD_BYTES: '1000', LOCAL_UPLOAD_MAX_BYTES: '1000' }).errors.length, 0);
  const over = mp.readMultipartConfig({ MAX_UPLOAD_BYTES: '1000', LOCAL_UPLOAD_MAX_BYTES: '1001' });
  assert.equal(over.errors.length, 1);
  assert.match(over.errors[0], /must not exceed MAX_UPLOAD_BYTES/);
  assert.ok(mp.readMultipartConfig({ LOCAL_UPLOAD_MAX_BYTES: '0' }).errors.length >= 1);
});

test('part size, concurrency, retries and TTLs are bounded', () => {
  const cases = [
    ['UPLOAD_PART_SIZE_BYTES', String(8 * MIB - 1), true],
    ['UPLOAD_PART_SIZE_BYTES', String(8 * MIB), false],
    ['UPLOAD_PART_SIZE_BYTES', String(64 * MIB), false],
    ['UPLOAD_PART_SIZE_BYTES', String(64 * MIB + 1), true],
    ['UPLOAD_PART_CONCURRENCY', '0', true],
    ['UPLOAD_PART_CONCURRENCY', '1', false],
    ['UPLOAD_PART_CONCURRENCY', '6', false],
    ['UPLOAD_PART_CONCURRENCY', '7', true],
    ['UPLOAD_PART_RETRIES', '0', false],
    ['UPLOAD_PART_RETRIES', '10', false],
    ['UPLOAD_PART_RETRIES', '11', true],
    ['UPLOAD_SESSION_TTL_SECONDS', '60', true],
    ['UPLOAD_SESSION_TTL_SECONDS', '21600', false],
  ];
  for (const [key, value, shouldFail] of cases) {
    const { errors } = mp.readMultipartConfig({ [key]: value });
    assert.equal(errors.length > 0, shouldFail, `${key}=${value} expected ${shouldFail ? 'error' : 'ok'}, got ${JSON.stringify(errors)}`);
  }
});

test('there is no small-part escape hatch in any environment', () => {
  // A previous revision let non-production relax the floor to 1 KiB. That
  // configuration VALIDATED and then failed to plan, because planParts still
  // enforces the provider's 5 MiB minimum. The variable is gone; the floor is
  // the floor everywhere.
  for (const env of [{}, { NODE_ENV: 'production' }, { NODE_ENV: 'test' }]) {
    const { errors } = mp.readMultipartConfig({ ...env, UPLOAD_ALLOW_SMALL_PARTS: '1', UPLOAD_PART_SIZE_BYTES: '1024' });
    assert.ok(
      errors.some((e) => /UPLOAD_PART_SIZE_BYTES must be between/.test(e)),
      `expected the 8 MiB floor to hold, got ${JSON.stringify(errors)}`,
    );
  }
});

test('every configurable part size can still plan a whole file', () => {
  // Whatever the operator picks inside the permitted band must produce a legal
  // plan at the ceiling — the config guard and the planner must agree.
  for (const partSize of [8 * MIB, 16 * MIB, 32 * MIB, 64 * MIB]) {
    const { config, errors } = mp.readMultipartConfig({
      MAX_UPLOAD_BYTES: String(3 * GIB),
      UPLOAD_PART_SIZE_BYTES: String(partSize),
    });
    assert.deepEqual(errors, [], `partSize ${partSize}`);
    const plan = mp.planParts(config.maxUploadBytes, config.partSizeBytes);
    assert.ok(plan, `planParts returned null for partSize ${partSize}`);
    assert.ok(plan.partCount <= mp.S3_MAX_PART_COUNT);
  }
});

test('the integration fixture shape is small but legal', () => {
  // 17 MiB with 8 MiB parts = 3 parts: exercises multi-part behaviour, a
  // short final part, and ordering — under the REAL provider constraints.
  const plan = mp.planParts(17 * MIB, 8 * MIB);
  assert.equal(plan.partCount, 3);
  assert.equal(plan.lastPartSize, 1 * MIB);
  assert.ok(plan.partSize >= mp.S3_MIN_PART_BYTES);
});

test('object storage is required above the HARD local ceiling, not the configured one', () => {
  const HARD = mp.HARD_LOCAL_UPLOAD_BYTES;
  assert.equal(mp.requiresObjectStorage({ maxUploadBytes: 3 * GIB, localMaxUploadBytes: HARD }), true);
  assert.equal(mp.requiresObjectStorage({ maxUploadBytes: HARD, localMaxUploadBytes: HARD }), false);
  // The closed bypass: raising the local value in lockstep must NOT make this
  // false, or startup would allow local-fs to serve a 3 GiB limit.
  assert.equal(mp.requiresObjectStorage({ maxUploadBytes: 3 * GIB, localMaxUploadBytes: 3 * GIB }), true);
  assert.equal(mp.requiresObjectStorage({ maxUploadBytes: HARD + 1, localMaxUploadBytes: HARD + 1 }), true);
});

test('effective maximum is a three-way minimum including the hard local ceiling', () => {
  const HARD = mp.HARD_LOCAL_UPLOAD_BYTES;
  const config = { maxUploadBytes: 3 * GIB, localMaxUploadBytes: 512 * MIB };
  assert.equal(mp.effectiveMaxBytes(config, { objectStorage: true }), 3 * GIB);
  // 512 MiB was configured, but the hard ceiling is 500 MiB and wins.
  assert.equal(mp.effectiveMaxBytes(config, { objectStorage: false }), HARD);
  // A LOWER configured local value still wins over the hard ceiling.
  assert.equal(mp.effectiveMaxBytes({ maxUploadBytes: 3 * GIB, localMaxUploadBytes: 100 * MIB }, { objectStorage: false }), 100 * MIB);
  // And a lower global maximum wins over both.
  assert.equal(mp.effectiveMaxBytes({ maxUploadBytes: 50 * MIB, localMaxUploadBytes: 100 * MIB }, { objectStorage: false }), 50 * MIB);
  // Object storage never exceeds the product ceiling either.
  assert.equal(mp.effectiveMaxBytes({ maxUploadBytes: 3 * GIB, localMaxUploadBytes: HARD }, { objectStorage: true }), mp.HARD_MAX_BYTES);
});

/* ----------------------------------------------------------------- planning */

test('3 GiB with 16 MiB parts produces exactly 192 parts', () => {
  const plan = mp.planParts(3 * GIB, 16 * MIB);
  assert.equal(plan.partCount, 192);
  assert.equal(plan.lastPartSize, 16 * MIB);
  assert.equal(plan.partSize * (plan.partCount - 1) + plan.lastPartSize, 3 * GIB);
});

test('the final part carries the remainder', () => {
  const plan = mp.planParts(100 * MIB + 7, 16 * MIB);
  assert.equal(plan.partCount, 7);
  assert.equal(plan.lastPartSize, 100 * MIB + 7 - 6 * 16 * MIB);
  assert.ok(plan.lastPartSize > 0 && plan.lastPartSize <= plan.partSize);
});

test('planning is deterministic', () => {
  for (let i = 0; i < 50; i += 1) {
    const total = 1 + i * 7_919_311;
    assert.deepEqual(mp.planParts(total, 16 * MIB), mp.planParts(total, 16 * MIB));
  }
});

test('every part except the last covers the whole file exactly once', () => {
  const total = 3 * GIB - 12_345;
  const plan = mp.planParts(total, 16 * MIB);
  let covered = 0;
  let previousEnd = 0;
  for (let n = 1; n <= plan.partCount; n += 1) {
    const range = mp.partRange(n, plan, total);
    assert.equal(range.start, previousEnd, `part ${n} must start where ${n - 1} ended`);
    assert.ok(range.size > 0);
    if (n < plan.partCount) assert.equal(range.size, plan.partSize);
    covered += range.size;
    previousEnd = range.end;
  }
  assert.equal(covered, total);
  assert.equal(previousEnd, total);
});

test('no part except the last may be below the provider minimum', () => {
  // 1 MiB parts over 10 MiB would put 5 MiB-floor-violating parts on the wire.
  assert.equal(mp.planParts(10 * MIB, 1 * MIB), null);
  // A single part below the floor is legal — S3 exempts a lone part.
  assert.ok(mp.planParts(1024, 1 * MIB));
});

test('the provider part-count cap is never exceeded', () => {
  assert.equal(mp.planParts(10_001 * MIB, 1 * MIB), null);
  const plan = mp.planParts(3 * GIB, 8 * MIB);
  assert.ok(plan.partCount <= mp.S3_MAX_PART_COUNT);
});

test('invalid totals and part sizes are rejected', () => {
  for (const bad of [0, -1, 1.5, NaN, Infinity, '100']) {
    assert.equal(mp.planParts(bad, 16 * MIB), null, `total ${bad}`);
    assert.equal(mp.planParts(100 * MIB, bad), null, `partSize ${bad}`);
  }
});

test('partRange refuses out-of-range part numbers', () => {
  const total = 100 * MIB;
  const plan = mp.planParts(total, 16 * MIB);
  for (const bad of [0, -1, plan.partCount + 1, 1.5, NaN]) {
    assert.equal(mp.partRange(bad, plan, total), null, `part ${bad}`);
  }
  assert.ok(mp.partRange(1, plan, total));
  assert.ok(mp.partRange(plan.partCount, plan, total));
});

/* ------------------------------------------------------------- part batches */

test('part-number batches are bounded, unique and in range', () => {
  assert.deepEqual(mp.validatePartNumbers([3, 1, 2], 10).partNumbers, [1, 2, 3]);
  assert.equal(mp.validatePartNumbers([], 10).error, 'BAD_PARTS');
  assert.equal(mp.validatePartNumbers('nope', 10).error, 'BAD_PARTS');
  assert.equal(mp.validatePartNumbers([1, 1], 10).error, 'DUPLICATE_PART');
  assert.equal(mp.validatePartNumbers([0], 10).error, 'BAD_PARTS');
  assert.equal(mp.validatePartNumbers([11], 10).error, 'BAD_PARTS');
  assert.equal(mp.validatePartNumbers([1.5], 10).error, 'BAD_PARTS');
  const tooMany = Array.from({ length: mp.MAX_PART_TARGET_BATCH + 1 }, (_, i) => i + 1);
  assert.equal(mp.validatePartNumbers(tooMany, 1000).error, 'TOO_MANY_PARTS');
  const exact = Array.from({ length: mp.MAX_PART_TARGET_BATCH }, (_, i) => i + 1);
  assert.equal(mp.validatePartNumbers(exact, 1000).ok, true);
});

/* -------------------------------------------------------------- completion */

test('a completion manifest must be exactly the planned parts', () => {
  const etag = '"d41d8cd98f00b204e9800998ecf8427e"';
  const good = [1, 2, 3].map((partNumber) => ({ partNumber, etag }));
  assert.equal(mp.validateCompletionParts(good, 3).ok, true);

  assert.equal(mp.validateCompletionParts(good.slice(0, 2), 3).error, 'PART_COUNT_MISMATCH');
  assert.equal(mp.validateCompletionParts([...good, { partNumber: 4, etag }], 3).error, 'PART_COUNT_MISMATCH');
  assert.equal(
    mp.validateCompletionParts([{ partNumber: 1, etag }, { partNumber: 1, etag }, { partNumber: 3, etag }], 3).error,
    'DUPLICATE_PART',
  );
  assert.equal(
    mp.validateCompletionParts([{ partNumber: 1, etag }, { partNumber: 2, etag }, { partNumber: 9, etag }], 3).error,
    'BAD_PARTS',
  );
  // 'nope' is a perfectly good OPAQUE etag now — rejection is about shape
  // (empty, oversized, multi-line), not about looking like an MD5.
  assert.equal(mp.validateCompletionParts([{ partNumber: 1, etag: 'nope' }], 1).ok, true);
  assert.equal(mp.validateCompletionParts([{ partNumber: 1, etag: '' }], 1).error, 'BAD_ETAG');
  assert.equal(mp.validateCompletionParts([{ partNumber: 1, etag: 'a\r\nb' }], 1).error, 'BAD_ETAG');
  assert.equal(mp.validateCompletionParts([{ partNumber: 1, etag: 'x'.repeat(1025) }], 1).error, 'BAD_ETAG');
  assert.equal(mp.validateCompletionParts([{ partNumber: 1, etag: 42 }], 1).error, 'BAD_ETAG');
});

test('completion output is sorted regardless of input order', () => {
  const etag = '"d41d8cd98f00b204e9800998ecf8427e"';
  const shuffled = [3, 1, 2].map((partNumber) => ({ partNumber, etag }));
  const result = mp.validateCompletionParts(shuffled, 3);
  assert.deepEqual(result.parts.map((p) => p.partNumber), [1, 2, 3]);
});

test('ETags are treated as opaque provider tokens and preserved exactly', () => {
  // Whatever the provider returned comes back byte-for-byte. Quoting is NOT
  // manufactured: a provider that compares exactly would reject a value we
  // rewrote, and non-AWS providers do not return MD5-shaped ETags at all.
  const samples = [
    '"d41d8cd98f00b204e9800998ecf8427e"',
    'd41d8cd98f00b204e9800998ecf8427e',
    '"d41d8cd98f00b204e9800998ecf8427e-12"',
    'W/"weak-etag"',           // weak validator
    'a1b2c3d4e5f6-99',          // R2/MinIO-ish
    '"0x8DA1B2C3D4E5F60"',      // Azure-style
    'x'.repeat(1024),           // exactly at the bound
  ];
  for (const value of samples) {
    assert.equal(mp.normalizeEtag(value), value, `must preserve ${value.slice(0, 24)}`);
  }
});

test('ETags are bounded, single-line and control-character free', () => {
  const bad = [
    '',
    null,
    undefined,
    123,
    {},
    'x'.repeat(1025),           // one over the bound
    'abc\r\ndef',               // header injection shape
    'abc\ndef',
    'abc\rdef',
    'abc def',
    'abcdef',
    'abcdef',
  ];
  for (const value of bad) {
    assert.equal(mp.normalizeEtag(value), null, `expected ${JSON.stringify(String(value)).slice(0, 30)} rejected`);
  }
});

/* ------------------------------------------------------------------ tokens */

test('a freshly issued session token verifies and round-trips its plan', () => {
  const session = baseSession();
  const token = mp.issueMultipartToken(session, SECRET);
  const claims = mp.verifyMultipartToken(token, SECRET);
  assert.ok(claims);
  assert.equal(claims.version, 1);
  assert.equal(claims.key, session.key);
  assert.equal(claims.uploadId, session.uploadId);
  assert.equal(claims.roomCode, session.roomCode);
  assert.equal(claims.memberId, session.memberId);
  assert.equal(claims.expectedBytes, session.expectedBytes);
  assert.equal(claims.partSize, session.partSize);
  assert.equal(claims.partCount, session.partCount);
});

test('a tampered token is rejected', () => {
  const token = mp.issueMultipartToken(baseSession(), SECRET);
  const [body, sig] = token.split('.');

  assert.equal(mp.verifyMultipartToken(`${body}x.${sig}`, SECRET), null, 'body edit');
  assert.equal(mp.verifyMultipartToken(`${body}.${sig}x`, SECRET), null, 'signature edit');
  assert.equal(mp.verifyMultipartToken(token, 'other-secret'), null, 'wrong secret');
  assert.equal(mp.verifyMultipartToken(body, SECRET), null, 'missing signature');
  assert.equal(mp.verifyMultipartToken('', SECRET), null);
  assert.equal(mp.verifyMultipartToken(null, SECRET), null);

  // Re-signing an edited payload with the WRONG secret must still fail.
  const edited = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), n: 1 })).toString('base64url');
  assert.equal(mp.verifyMultipartToken(`${edited}.${sig}`, SECRET), null, 'payload swap keeps old signature');
});

test('an expired token is rejected', () => {
  const now = Date.now();
  const token = mp.issueMultipartToken({ ...baseSession(), ttlMs: 1000 }, SECRET, now);
  assert.ok(mp.verifyMultipartToken(token, SECRET, now + 500));
  assert.equal(mp.verifyMultipartToken(token, SECRET, now + 1001), null);
});

test('a token surviving a restart still verifies with the same secret', () => {
  // Same secret, brand-new "process": no server-side session store involved.
  const token = mp.issueMultipartToken(baseSession(), SECRET);
  assert.ok(mp.verifyMultipartToken(token, SECRET));
});

test('a structurally impossible plan is rejected even when correctly signed', () => {
  // Correct signature, but partCount disagrees with expectedBytes/partSize.
  assert.equal(mp.verifyMultipartToken(signRawSession({ partCount: 999 }), SECRET), null);

  const oversize = { expectedBytes: 3 * GIB + 1, partCount: Math.ceil((3 * GIB + 1) / (16 * MIB)) };
  assert.equal(mp.verifyMultipartToken(signRawSession(oversize), SECRET), null);
});

test('the issuer refuses to sign an impossible plan in the first place', () => {
  // The production issuer never mints what the verifier would reject. Both
  // halves matter: this one stops a bad capability existing, the verifier stops
  // a forged one being honoured.
  for (const bad of [
    { partCount: 999 },
    { expectedBytes: 3 * GIB + 1, partCount: Math.ceil((3 * GIB + 1) / (16 * MIB)) },
    { key: '../../etc/passwd' },
    { key: 'rooms/ZZZ999/0123456789abcdef/movie.mp4' }, // room/key mismatch
    { key: 'rooms/ABC123/0123456789abcdef/movie.webm' }, // key/MIME mismatch
    { roomCode: 'abc123' },
    { mimeType: 'application/zip' },
    { memberId: '' },
    { uploadId: '' },
    { partSize: 1024 },
    { maxBytes: 3 * GIB + 1 },
    { expectedBytes: 200 * MIB, maxBytes: 100 * MIB, partCount: Math.ceil((200 * MIB) / (16 * MIB)) },
  ]) {
    assert.throws(
      () => mp.issueMultipartToken({ ...baseSession(), ...bad }, SECRET),
      /refusing to sign an invalid grant/,
      JSON.stringify(bad),
    );
  }
});

test('the multipart grant validator proves the key belongs to the claimed room', () => {
  /*
   * The gap this closes: room and key used to be validated independently, so a
   * forged token could pair room A's claim — which authorizeSession happily
   * matches against the caller's own room — with a key under room B's prefix.
   */
  const grant = {
    transport: 'multipart',
    key: 'rooms/ABC123/0123456789abcdef/movie.mp4',
    uploadId: 'u1',
    roomCode: 'ABC123',
    memberId: 'm1',
    mimeType: 'video/mp4',
    expectedBytes: 100 * MIB,
    maxBytes: 3 * GIB,
    partSize: 16 * MIB,
    partCount: Math.ceil((100 * MIB) / (16 * MIB)),
    expiresAt: Date.now() + 60_000,
  };
  assert.equal(mp.validateMultipartUploadGrant(grant).ok, true);
  assert.equal(mp.validateMultipartUploadGrant({ ...grant, roomCode: 'ZZZ999' }).error, 'ROOM_KEY_MISMATCH');
  assert.equal(mp.validateMultipartUploadGrant({ ...grant, transport: 'single' }).error, 'BAD_TRANSPORT');
  assert.equal(mp.validateMultipartUploadGrant({ ...grant, transport: undefined }).error, 'BAD_TRANSPORT');
  assert.equal(mp.validateMultipartUploadGrant({ ...grant, mimeType: 'video/webm' }).error, 'KEY_TYPE_MISMATCH');
  assert.equal(mp.validateMultipartUploadGrant({ ...grant, lastPartSize: 1 }).error, 'PLAN_MISMATCH');
  // The derived final part is returned, never taken from the wire.
  assert.equal(mp.validateMultipartUploadGrant(grant).plan.lastPartSize, 100 * MIB - 6 * 16 * MIB);
  // Expiry is only enforced when verifying, not when validating a fresh grant.
  const past = { ...grant, expiresAt: 1 };
  assert.equal(mp.validateMultipartUploadGrant(past).ok, true);
  assert.equal(mp.validateMultipartUploadGrant(past, { requireFuture: true, now: 1000 }).error, 'EXPIRED');
});

test('a verified multipart token carries a canonical claim set', () => {
  const claims = mp.verifyMultipartToken(mp.issueMultipartToken(baseSession(), SECRET), SECRET);
  assert.equal(claims.transport, 'multipart');
  assert.equal(claims.version, 1);
  assert.equal(claims.lastPartSize, 100 * MIB - 6 * 16 * MIB);
  assert.deepEqual(Object.keys(claims).sort(), [
    'absoluteExpiresAt',
    'expectedBytes',
    'expiresAt',
    'key',
    'lastPartSize',
    'maxBytes',
    'memberId',
    'mimeType',
    'partCount',
    'partSize',
    'roomCode',
    'transport',
    'uploadId',
    'version',
  ]);
  // A token minted without an explicit deadline reports its own expiry as the
  // ceiling (no renewal headroom), so the field is always present and coherent.
  assert.equal(claims.absoluteExpiresAt, claims.expiresAt);
});

test('a token claiming the wrong transport is refused', () => {
  // A single-shot token must never be honoured as a multipart session.
  assert.equal(mp.verifyMultipartToken(signRawSession({ transport: 'single' }), SECRET), null);
  assert.equal(mp.verifyMultipartToken(signRawSession({ transport: undefined }), SECRET), null);
});

test('structurally malformed token strings are refused before hashing', () => {
  for (const bad of [null, undefined, 42, {}, [], '', 'nodot', 'a.b.c', '.sig', 'body.', 'has spaces.sig', 'body.sig!']) {
    assert.equal(mp.verifyMultipartToken(bad, SECRET), null, JSON.stringify(bad));
  }
});

test('authorization rejects a different room and a different member', () => {
  const claims = mp.verifyMultipartToken(mp.issueMultipartToken(baseSession(), SECRET), SECRET);
  assert.equal(mp.authorizeSession(claims, { roomCode: 'ABC123', memberId: 'member-1' }).ok, true);
  assert.equal(mp.authorizeSession(claims, { roomCode: 'OTHER1', memberId: 'member-1' }).error, 'WRONG_ROOM');
  assert.equal(mp.authorizeSession(claims, { roomCode: 'ABC123', memberId: 'member-2' }).error, 'WRONG_MEMBER');
  assert.equal(mp.authorizeSession(null, { roomCode: 'ABC123', memberId: 'member-1' }).error, 'BAD_TOKEN');
});

test('the token never contains a raw secret and is opaque', () => {
  const token = mp.issueMultipartToken(baseSession(), SECRET);
  assert.ok(!token.includes(SECRET));
  // base64url only — safe to put in JSON and impossible to confuse with a URL.
  assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
});

test('the immutable absolute deadline round-trips through the token and bounds the expiry', () => {
  const now = 1_700_000_000_000;
  const absoluteExpiresAt = now + 24 * 3600_000;
  const token = mp.issueMultipartToken({ ...baseSession(), expiresAt: now + 3600_000, absoluteExpiresAt }, SECRET, now);
  const claims = mp.verifyMultipartToken(token, SECRET, now);
  assert.equal(claims.absoluteExpiresAt, absoluteExpiresAt, 'the deadline is carried in the signed token');
  assert.equal(claims.expiresAt, now + 3600_000);

  // The issuer REFUSES to sign a grant whose expiry exceeds its own deadline —
  // the invariant the renewal clamp relies on to never extend past the ceiling.
  assert.throws(
    () => mp.issueMultipartToken({ ...baseSession(), expiresAt: now + 25 * 3600_000, absoluteExpiresAt }, SECRET, now),
    /EXPIRY_EXCEEDS_LIFETIME/,
  );
});

/* ------------------------------------------------- hardened token claims */

/** Forge a correctly-signed claim set, so post-signature validation is proven. */
const signed = (overrides) => signRawSession(overrides);

test('a correctly signed token with an invalid object key is rejected', () => {
  for (const key of [
    'not-a-key',
    '../../etc/passwd',
    'rooms/ABC123/short/movie.mp4',
    'rooms/abc123/0123456789abcdef/movie.mp4',
    '',
    null,
  ]) {
    assert.equal(mp.verifyMultipartToken(signed({ key }), SECRET), null, `key ${JSON.stringify(key)}`);
  }
});

test('a correctly signed token with an unsupported MIME is rejected', () => {
  for (const mimeType of ['video/quicktime', 'application/octet-stream', 'text/html', '', null, 'VIDEO/MP4 '])
    assert.equal(mp.verifyMultipartToken(signed({ mimeType }), SECRET), null, `mime ${JSON.stringify(mimeType)}`);
  // The allowlist itself is unchanged and still accepts the three containers —
  // each with the key extension that matches it, which is now also enforced.
  for (const [mimeType, ext] of [['video/mp4', 'mp4'], ['video/webm', 'webm'], ['video/ogg', 'ogv']]) {
    const key = `rooms/ABC123/0123456789abcdef/movie.${ext}`;
    assert.ok(mp.verifyMultipartToken(signed({ mimeType, key }), SECRET), `mime ${mimeType} should verify`);
    // …and a key whose extension disagrees with the signed MIME does not.
    assert.equal(
      mp.verifyMultipartToken(signed({ mimeType, key: 'rooms/ABC123/0123456789abcdef/movie.mkv' }), SECRET),
      null,
      `mime ${mimeType} with a mismatched key`,
    );
  }
});

test('empty or malformed room, member and upload id are rejected', () => {
  assert.equal(mp.verifyMultipartToken(signed({ roomCode: '' }), SECRET), null, 'empty room');
  assert.equal(mp.verifyMultipartToken(signed({ roomCode: 'AB-123' }), SECRET), null, 'non-alnum room');
  assert.equal(mp.verifyMultipartToken(signed({ roomCode: 'A'.repeat(13) }), SECRET), null, 'oversized room');
  assert.equal(mp.verifyMultipartToken(signed({ memberId: '' }), SECRET), null, 'empty member');
  assert.equal(mp.verifyMultipartToken(signed({ memberId: 'm'.repeat(129) }), SECRET), null, 'oversized member');
  assert.equal(mp.verifyMultipartToken(signed({ uploadId: '' }), SECRET), null, 'empty upload id');
  assert.equal(mp.verifyMultipartToken(signed({ uploadId: 'u'.repeat(513) }), SECRET), null, 'oversized upload id');
  assert.equal(mp.verifyMultipartToken(signed({ uploadId: 42 }), SECRET), null, 'non-string upload id');
});

test('maxBytes must be a positive safe integer within the hard ceiling', () => {
  for (const maxBytes of [undefined, null, '3221225472', -1, 0, 1.5, NaN, Infinity, GIB * 3 + 1, Number.MAX_VALUE]) {
    assert.equal(mp.verifyMultipartToken(signed({ maxBytes }), SECRET), null, `maxBytes ${String(maxBytes)}`);
  }
  assert.ok(mp.verifyMultipartToken(signed({ maxBytes: 3 * GIB }), SECRET), 'exactly 3 GiB is fine');
});

test('expectedBytes may never exceed maxBytes or the hard ceiling', () => {
  assert.equal(
    mp.verifyMultipartToken(signed({ expectedBytes: 200 * MIB, maxBytes: 100 * MIB, partCount: Math.ceil((200 * MIB) / (16 * MIB)) }), SECRET),
    null,
    'expected over max',
  );
  for (const expectedBytes of [0, -1, 1.5, NaN, '100', Infinity]) {
    assert.equal(mp.verifyMultipartToken(signed({ expectedBytes }), SECRET), null, `expectedBytes ${String(expectedBytes)}`);
  }
});

test('part size must sit inside the permitted plan bounds', () => {
  const bad = [
    mp.BOUNDS.partSizeMin - 1,
    mp.BOUNDS.partSizeMax + 1,
    0,
    -1,
    1.5,
    1024,
  ];
  for (const partSize of bad) {
    const expectedBytes = 100 * MIB;
    const partCount = Math.ceil(expectedBytes / partSize);
    assert.equal(mp.verifyMultipartToken(signed({ partSize, partCount }), SECRET), null, `partSize ${partSize}`);
  }
  assert.ok(mp.verifyMultipartToken(signed({ partSize: mp.BOUNDS.partSizeMin, partCount: Math.ceil((100 * MIB) / mp.BOUNDS.partSizeMin) }), SECRET));
});

test('an oversized token string is rejected before any parsing', () => {
  const huge = 'a'.repeat(mp.MAX_TOKEN_LENGTH + 1);
  assert.equal(mp.verifyMultipartToken(huge, SECRET), null);
  assert.equal(mp.verifyMultipartToken(`${huge}.${huge}`, SECRET), null);
  // A genuine token stays comfortably inside the bound.
  assert.ok(signed({}).length < mp.MAX_TOKEN_LENGTH);
});

test('a non-safe-integer expiry is rejected', () => {
  const now = Date.now();
  for (const expiresAt of [Number.MAX_VALUE, 1e21, Infinity, NaN, '9999999999999', -1, 0]) {
    // Forged, because the issuer refuses these outright — proven just below.
    assert.equal(mp.verifyMultipartToken(signed({ expiresAt }), SECRET, now), null, `expiresAt ${String(expiresAt)}`);
    assert.throws(
      () => mp.issueMultipartToken({ ...baseSession(), expiresAt }, SECRET, now),
      /refusing to sign an invalid grant/,
      `issuer must refuse expiresAt ${String(expiresAt)}`,
    );
  }
});

/* ------------------------------------------- one runtime configuration */

test('the runtime config exposes the effective maximum, not the requested one', () => {
  const requested = { MAX_UPLOAD_BYTES: String(3 * GIB) };
  const withStorage = mp.createUploadRuntimeConfig(requested, { objectStorage: true }).config;
  const without = mp.createUploadRuntimeConfig(requested, { objectStorage: false }).config;

  assert.equal(withStorage.effectiveMaxBytes, 3 * GIB);
  assert.equal(withStorage.maxUploadBytes, 3 * GIB);

  // Requested 3 GiB, but with no bucket the runtime honours the local ceiling.
  assert.equal(without.maxUploadBytes, 3 * GIB, 'the request is still reported');
  assert.equal(without.effectiveMaxBytes, without.localMaxUploadBytes);
  assert.ok(without.effectiveMaxBytes < 3 * GIB);
});

test('the runtime config is frozen', () => {
  const { config } = mp.createUploadRuntimeConfig({}, { objectStorage: false });
  assert.ok(Object.isFrozen(config));
});

test('default configuration preserves the historical 500 MiB limit', () => {
  const { config } = mp.createUploadRuntimeConfig({}, { objectStorage: false });
  assert.equal(config.maxUploadBytes, 500 * 1024 * 1024);
  assert.equal(config.effectiveMaxBytes, 500 * 1024 * 1024);
});
