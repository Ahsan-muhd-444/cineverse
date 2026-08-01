/**
 * The single-shot grant validator and v2 token structural hardening.
 *
 * The grant validator is the one definition of "a valid single-shot upload",
 * shared by issuance, verification, the storage policy and completion. These
 * tests prove it rejects the shapes each of those layers used to accept on its
 * own, and that the token layer refuses malformed input before spending an
 * HMAC on it.
 *
 * A TEST-ONLY signer forges correctly-signed-but-invalid tokens. The
 * production issuer must never mint one, so the tests cannot ask it to; they
 * sign directly with the same secret instead.
 *
 * Run: node --test --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/uploads-token.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { validateSingleUploadGrant, HARD_LOCAL_UPLOAD_BYTES } = require('../server/upload-limits.js');
const { issueUploadToken, verifyUploadToken, MAX_TOKEN_LENGTH, SINGLE_TOKEN_VERSION } = require('../server/uploads.js');

const MIB = 1024 * 1024;
const GIB = 1024 * 1024 * 1024;
const SECRET = 'x'.repeat(32);
const KEY = 'rooms/ABC123/0123456789abcdef/movie.mp4';

const goodGrant = () => ({
  transport: 'single',
  key: KEY,
  mimeType: 'video/mp4',
  roomCode: 'ABC123',
  expectedBytes: 100 * MIB,
  maxBytes: 500 * MIB,
});

/**
 * TEST-ONLY signer: encodes an arbitrary body with a valid signature, so a test
 * can present a token the production issuer would refuse to mint. This is why
 * verifyUploadToken must re-validate every claim rather than trusting the
 * signature.
 */
function signRaw(body, secret = SECRET) {
  const encoded = Buffer.from(JSON.stringify(body)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}
const v2Body = (over = {}) => ({
  v: SINGLE_TOKEN_VERSION,
  t: 'single',
  k: KEY,
  m: 'video/mp4',
  n: 100 * MIB,
  b: 500 * MIB,
  r: 'ABC123',
  e: Date.now() + 60_000,
  ...over,
});

/* ============================================== grant validator */

test('the canonical grant is accepted', () => {
  assert.deepEqual(validateSingleUploadGrant(goodGrant()), { ok: true });
});

test('the grant validator rejects every malformed shape', () => {
  const cases = [
    ['not an object', null, 'BAD_GRANT'],
    ['wrong transport', { ...goodGrant(), transport: 'multipart' }, 'BAD_TRANSPORT'],
    ['missing transport', { ...goodGrant(), transport: undefined }, 'BAD_TRANSPORT'],
    ['invalid key', { ...goodGrant(), key: '../../etc/passwd' }, 'BAD_KEY'],
    ['unsupported mime', { ...goodGrant(), mimeType: 'application/zip' }, 'UNSUPPORTED_TYPE'],
    ['empty room', { ...goodGrant(), roomCode: '' }, 'BAD_ROOM'],
    ['malformed room', { ...goodGrant(), roomCode: 'has spaces' }, 'BAD_ROOM'],
    ['over-long room', { ...goodGrant(), roomCode: 'A'.repeat(13) }, 'BAD_ROOM'],
    ['room/key mismatch', { ...goodGrant(), roomCode: 'ZZZ999' }, 'ROOM_KEY_MISMATCH'],
    ['missing expectedBytes', { ...goodGrant(), expectedBytes: undefined }, 'BAD_SIZE'],
    ['fractional expectedBytes', { ...goodGrant(), expectedBytes: 100.5 }, 'BAD_SIZE'],
    ['zero expectedBytes', { ...goodGrant(), expectedBytes: 0 }, 'BAD_SIZE'],
    ['negative expectedBytes', { ...goodGrant(), expectedBytes: -1 }, 'BAD_SIZE'],
    ['missing maxBytes', { ...goodGrant(), maxBytes: undefined }, 'BAD_LIMIT'],
    ['fractional maxBytes', { ...goodGrant(), maxBytes: 1.5 }, 'BAD_LIMIT'],
    ['expectedBytes > maxBytes', { ...goodGrant(), expectedBytes: 600 * MIB, maxBytes: 500 * MIB }, 'SIZE_EXCEEDS_LIMIT'],
    ['over-ceiling maxBytes', { ...goodGrant(), maxBytes: 3 * GIB }, 'LIMIT_TOO_HIGH'],
  ];
  for (const [label, grant, expected] of cases) {
    const result = validateSingleUploadGrant(grant);
    assert.equal(result.ok, false, label);
    assert.equal(result.error, expected, `${label}: got ${result.error}`);
  }
});

test('a non-canonical room claim is refused, not folded', () => {
  /*
   * This test used to assert the OPPOSITE: that `abc123` was accepted against a
   * key under `rooms/ABC123/`. It was, by case-folding at the comparison — and
   * then the token preserved `abc123`, while `upload:complete` compares the
   * claim byte-for-byte with the room's uppercase code. That combination minted
   * signed grants that could never be redeemed.
   *
   * One representation: validated and stored, never folded.
   */
  assert.equal(validateSingleUploadGrant({ ...goodGrant(), roomCode: 'abc123' }).error, 'BAD_ROOM');
  assert.equal(validateSingleUploadGrant({ ...goodGrant(), roomCode: 'Abc123' }).error, 'BAD_ROOM');
  assert.equal(validateSingleUploadGrant({ ...goodGrant(), roomCode: 'ABC123' }).ok, true);
});

test('the issuer refuses a lowercase room, and a canonical one round-trips unchanged', () => {
  // Fail loudly at issuance rather than quietly at completion.
  assert.throws(
    () => issueUploadToken({ ...goodGrant(), roomCode: 'abc123' }, SECRET),
    /refusing to sign an invalid grant \(BAD_ROOM\)/,
  );

  const claims = verifyUploadToken(issueUploadToken(goodGrant(), SECRET), SECRET);
  assert.equal(claims.roomCode, 'ABC123', 'the verified claim must be canonical uppercase');
  // And the claim is exactly the key's room segment, which is what
  // upload:complete compares against room.code.
  assert.equal(claims.roomCode, claims.key.split('/')[1]);
});

test('a correctly signed lowercase room claim is refused at verification', () => {
  // The forged-token path: a leaked secret still cannot produce a room claim the
  // rest of the system would honour.
  assert.equal(verifyUploadToken(signRaw(v2Body({ r: 'abc123' })), SECRET), null);
});

/* ============================================== issuer hardening */

test('the issuer refuses to sign an invalid grant', () => {
  const bad = [
    { ...goodGrant(), expectedBytes: 1.5 },
    { ...goodGrant(), expectedBytes: 600 * MIB, maxBytes: 500 * MIB },
    { ...goodGrant(), maxBytes: 3 * GIB },
    { ...goodGrant(), roomCode: 'ZZZ999' },
    { ...goodGrant(), transport: 'multipart' },
  ];
  for (const grant of bad) {
    assert.throws(() => issueUploadToken(grant, SECRET), /refusing to sign an invalid grant/, JSON.stringify(grant));
  }
});

test('the issuer refuses a non-positive TTL', () => {
  for (const ttl of [0, -1, 1.5, NaN]) {
    assert.throws(() => issueUploadToken(goodGrant(), SECRET, ttl), /ttlMs/);
  }
});

test('a freshly issued token round-trips', () => {
  const claims = verifyUploadToken(issueUploadToken(goodGrant(), SECRET), SECRET);
  assert.ok(claims);
  assert.equal(claims.version, SINGLE_TOKEN_VERSION);
  assert.equal(claims.expectedBytes, 100 * MIB);
  assert.equal(claims.maxBytes, 500 * MIB);
  assert.equal(claims.roomCode, 'ABC123');
});

/* ============================================== verifier structure */

test('an oversized token is refused before hashing', () => {
  // A valid-looking but enormous token: the length guard must reject it without
  // an HMAC over the whole payload.
  const huge = `${'a'.repeat(MAX_TOKEN_LENGTH)}.${'b'.repeat(16)}`;
  assert.ok(huge.length > MAX_TOKEN_LENGTH);
  assert.equal(verifyUploadToken(huge, SECRET), null);
});

test('non-string and structurally wrong tokens are refused', () => {
  for (const bad of [null, undefined, 42, {}, [], '', 'nodot', 'a.b.c', '.sig', 'body.']) {
    assert.equal(verifyUploadToken(bad, SECRET), null, JSON.stringify(bad));
  }
});

test('non-base64url components are refused before parsing', () => {
  assert.equal(verifyUploadToken('has spaces.sig', SECRET), null);
  assert.equal(verifyUploadToken('body.has+slash/', SECRET), null);
  assert.equal(verifyUploadToken('body.sig!', SECRET), null);
});

/* ============================================== verifier claims */

test('a correctly signed token with an out-of-contract claim is refused', () => {
  // Every one of these carries a VALID signature (test-only signer) and must
  // still be rejected, because a signature proves origin, not sanity.
  const forged = [
    ['empty room', v2Body({ r: '' })],
    ['malformed room', v2Body({ r: 'has spaces' })],
    ['room/key mismatch', v2Body({ r: 'ZZZ999' })],
    ['expectedBytes > maxBytes', v2Body({ n: 600 * MIB, b: 500 * MIB })],
    ['over-ceiling maxBytes', v2Body({ b: 3 * GIB })],
    ['fractional expectedBytes', v2Body({ n: 100.5 })],
    ['zero expectedBytes', v2Body({ n: 0 })],
    ['invalid key', v2Body({ k: '../../etc/passwd' })],
    ['unsupported mime', v2Body({ m: 'application/zip' })],
    ['wrong transport', v2Body({ t: 'multipart' })],
    ['v1 shape', { k: KEY, m: 'video/mp4', b: 500 * MIB, r: 'ABC123', e: Date.now() + 60_000 }],
  ];
  for (const [label, body] of forged) {
    assert.equal(verifyUploadToken(signRaw(body), SECRET), null, label);
  }
});

test('invalid expiry is refused even with a valid signature', () => {
  const now = Date.now();
  assert.equal(verifyUploadToken(signRaw(v2Body({ e: now - 1 })), SECRET, now), null, 'past');
  assert.equal(verifyUploadToken(signRaw(v2Body({ e: now })), SECRET, now), null, 'exactly now');
  assert.equal(verifyUploadToken(signRaw(v2Body({ e: -1 })), SECRET, now), null, 'negative');
  assert.equal(verifyUploadToken(signRaw(v2Body({ e: 1.5 })), SECRET, now), null, 'fractional');
  assert.equal(verifyUploadToken(signRaw(v2Body({ e: 'soon' })), SECRET, now), null, 'non-numeric');
  // And a future expiry with a valid signature passes.
  assert.ok(verifyUploadToken(signRaw(v2Body({ e: now + 1000 })), SECRET, now));
});

test('a token signed with the wrong secret is refused', () => {
  assert.equal(verifyUploadToken(signRaw(v2Body(), 'wrong-secret-value-that-is-long'), SECRET), null);
});
