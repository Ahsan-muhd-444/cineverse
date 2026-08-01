/**
 * Unit tests for abuse throttling + chat memory bounds
 * (server/rate-limit.js, server/chat-limits.js).
 *
 * `now` is injected throughout, so refill, expiry and eviction are exercised
 * deterministically — no sleeping, no real clock.
 *
 * Run:  node --test --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/rate-limit.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createRateLimiter,
  normalizeIp,
  socketClientIp,
  buildRuntimePolicy,
  RATE_POLICIES,
} = require('../server/rate-limit.js');
const {
  decodedBase64Bytes,
  validateAttachment,
  attachmentCost,
  maxAttachmentCost,
  maxEncodedAttachmentBytes,
  estimateMessageBytes,
  pushMessageBounded,
  attachmentMaxBytes,
  historyMaxBytes,
  realtimeMaxBufferBytes,
  REALTIME_ENVELOPE_BYTES,
  MAX_ATTACHMENT_MAX_BYTES,
  MAX_REALTIME_BUFFER_BYTES,
} = require('../server/chat-limits.js');

// 3 tokens, fully refilling every 3000ms → 1 token per second.
const policy = { capacity: 3, refillTokens: 3, refillMs: 3000 };

/* ---------------- token bucket ---------------- */

test('the first request succeeds', () => {
  const rl = createRateLimiter();
  const v = rl.consume({ key: 'k', policy, now: 0 });
  assert.equal(v.ok, true);
  assert.equal(v.remaining, 2);
  assert.equal(v.retryAfterMs, 0);
});

test('a burst up to capacity succeeds, and the next one is rejected', () => {
  const rl = createRateLimiter();
  for (let i = 0; i < policy.capacity; i += 1) {
    assert.equal(rl.consume({ key: 'k', policy, now: 0 }).ok, true, `burst #${i + 1}`);
  }
  const over = rl.consume({ key: 'k', policy, now: 0 });
  assert.equal(over.ok, false);
  assert.equal(over.remaining, 0);
});

test('retryAfterMs is positive and matches the refill rate', () => {
  const rl = createRateLimiter();
  for (let i = 0; i < 3; i += 1) rl.consume({ key: 'k', policy, now: 0 });
  const over = rl.consume({ key: 'k', policy, now: 0 });
  // Empty bucket, 1 token/sec → ~1000ms until one token is available.
  assert.ok(over.retryAfterMs > 0);
  assert.equal(over.retryAfterMs, 1000);
});

test('tokens refill over time', () => {
  const rl = createRateLimiter();
  for (let i = 0; i < 3; i += 1) rl.consume({ key: 'k', policy, now: 0 });
  assert.equal(rl.consume({ key: 'k', policy, now: 500 }).ok, false, 'still empty at 0.5s');
  assert.equal(rl.consume({ key: 'k', policy, now: 1000 }).ok, true, 'one token back at 1s');
  assert.equal(rl.consume({ key: 'k', policy, now: 9000 }).ok, true, 'refilled after a long idle');
});

test('refill is capped at capacity (idle does not bank infinite tokens)', () => {
  const rl = createRateLimiter();
  rl.consume({ key: 'k', policy, now: 0 });
  // A day later the bucket is full, not overflowing.
  for (let i = 0; i < policy.capacity; i += 1) {
    assert.equal(rl.consume({ key: 'k', policy, now: 86_400_000 }).ok, true, `refilled #${i + 1}`);
  }
  assert.equal(rl.consume({ key: 'k', policy, now: 86_400_000 }).ok, false);
});

test('weighted cost consumes multiple tokens', () => {
  const rl = createRateLimiter();
  const v = rl.consume({ key: 'k', policy, cost: 3, now: 0 });
  assert.equal(v.ok, true);
  assert.equal(v.remaining, 0);
  assert.equal(rl.consume({ key: 'k', policy, cost: 1, now: 0 }).ok, false);
});

test('a cost larger than capacity is rejected without draining the bucket', () => {
  const rl = createRateLimiter();
  const v = rl.consume({ key: 'k', policy, cost: 99, now: 0 });
  assert.equal(v.ok, false);
  assert.equal(v.remaining, 3, 'bucket untouched — an impossible cost is not punitive');
  assert.ok(v.retryAfterMs > 0);
});

test('keys are independent', () => {
  const rl = createRateLimiter();
  for (let i = 0; i < 3; i += 1) rl.consume({ key: 'a', policy, now: 0 });
  assert.equal(rl.consume({ key: 'a', policy, now: 0 }).ok, false);
  assert.equal(rl.consume({ key: 'b', policy, now: 0 }).ok, true, 'another key is unaffected');
});

/* ---------------- housekeeping ---------------- */

test('expired buckets are swept', () => {
  const rl = createRateLimiter({ ttlMs: 1000 });
  rl.consume({ key: 'k', policy, now: 0 });
  assert.equal(rl.size(), 1);
  assert.equal(rl.sweep(500), 0, 'still fresh');
  assert.equal(rl.sweep(5000), 1, 'expired');
  assert.equal(rl.size(), 0);
});

test('the map does not grow forever', () => {
  const rl = createRateLimiter({ maxKeys: 50 });
  for (let i = 0; i < 500; i += 1) rl.consume({ key: `k${i}`, policy, now: i });
  assert.ok(rl.size() <= 50, `bounded, got ${rl.size()}`);
});

test('clearPrefix drops only the matching buckets', () => {
  const rl = createRateLimiter();
  rl.consume({ key: 'socket:abc:chat', policy, now: 0 });
  rl.consume({ key: 'socket:abc:join', policy, now: 0 });
  rl.consume({ key: 'member:ROOM:m_1:chat', policy, now: 0 });
  assert.equal(rl.clearPrefix('socket:abc:'), 2);
  assert.equal(rl.size(), 1, 'member bucket survives a disconnect');
});

/* ---------------- identity ---------------- */

test('IPv4-mapped IPv6 normalizes to one key', () => {
  assert.equal(normalizeIp('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(normalizeIp('203.0.113.7'), '203.0.113.7');
  assert.equal(normalizeIp('[2001:db8::1]'), '2001:db8::1');
  assert.equal(normalizeIp('fe80::1%eth0'), 'fe80::1');
  assert.equal(normalizeIp(''), '');
});

test('x-forwarded-for is IGNORED when trust proxy is off', () => {
  const socket = {
    handshake: { address: '::ffff:10.0.0.5', headers: { 'x-forwarded-for': '1.2.3.4' } },
  };
  // Otherwise a flooder rotates the header and gets an unlimited key space.
  assert.equal(socketClientIp(socket, {}), '10.0.0.5');
  assert.equal(socketClientIp(socket, { RATE_LIMIT_TRUST_PROXY: '0' }), '10.0.0.5');
});

test('x-forwarded-for is used (first hop only) when trust proxy is on', () => {
  const socket = {
    handshake: { address: '10.0.0.5', headers: { 'x-forwarded-for': '203.0.113.9, 70.41.3.18' } },
  };
  assert.equal(socketClientIp(socket, { RATE_LIMIT_TRUST_PROXY: '1' }), '203.0.113.9');
});

test('a missing address still yields a stable key', () => {
  assert.equal(socketClientIp({}, {}), 'unknown');
});

test('every policy is well-formed', () => {
  for (const [name, p] of Object.entries(RATE_POLICIES)) {
    assert.ok(p.capacity > 0, `${name}.capacity`);
    assert.ok(p.refillTokens > 0, `${name}.refillTokens`);
    assert.ok(p.refillMs > 0, `${name}.refillMs`);
  }
  // ICE bursts are legitimate — this must stay generous.
  assert.ok(RATE_POLICIES.rtcSignal.capacity >= 100, 'rtcSignal must absorb candidate bursts');
});

/* ---------------- attachment sizing ---------------- */

const dataUrl = (bytes) => `data:image/png;base64,${'A'.repeat(Math.ceil(bytes / 3) * 4)}`;

test('decoded size is estimated from base64 length and padding', () => {
  assert.equal(decodedBase64Bytes('AAAA'), 3);
  assert.equal(decodedBase64Bytes('AAA='), 2);
  assert.equal(decodedBase64Bytes('AA=='), 1);
  assert.equal(decodedBase64Bytes(''), 0);
});

test('a normal attachment validates and reports decoded bytes', () => {
  const v = validateAttachment(dataUrl(1024), { maxDecodedBytes: 8 * 1024 * 1024 });
  assert.equal(v.ok, true);
  assert.ok(v.decodedBytes >= 1024 && v.decodedBytes < 1100, `got ${v.decodedBytes}`);
  assert.equal(v.mimeType, 'image/png');
});

test('an oversized attachment is rejected by DECODED size', () => {
  const v = validateAttachment(dataUrl(9 * 1024 * 1024), { maxDecodedBytes: 8 * 1024 * 1024 });
  assert.equal(v.ok, false);
  assert.equal(v.error, 'TOO_LARGE');
});

test('malformed payloads are rejected without decoding', () => {
  for (const bad of ['', 'not-a-data-url', 'data:image/png,rawtext', 'data:;base64,']) {
    assert.equal(validateAttachment(bad, { maxDecodedBytes: 1024 }).ok, false, bad);
  }
});

test('attachment cost scales with payload size', () => {
  assert.equal(attachmentCost(1024), 1, 'a tiny voice note costs one token');
  assert.equal(attachmentCost(256 * 1024), 1);
  assert.equal(attachmentCost(256 * 1024 + 1), 2);
  assert.ok(attachmentCost(11 * 1024 * 1024) > 40, 'a huge attachment costs many tokens');
});

test('byte limits are read from env and clamped', () => {
  assert.equal(attachmentMaxBytes({ CHAT_ATTACHMENT_MAX_BYTES: '4096' }), 4096);
  assert.equal(attachmentMaxBytes({}), 8 * 1024 * 1024);
  assert.equal(attachmentMaxBytes({ CHAT_ATTACHMENT_MAX_BYTES: 'lots' }), 8 * 1024 * 1024);
  assert.equal(historyMaxBytes({}), 24 * 1024 * 1024);
  assert.ok(historyMaxBytes({ CHAT_HISTORY_MAX_BYTES: '1' }) >= 256 * 1024, 'clamped to a usable minimum');
});

/* ---------------- background-traffic isolation ----------------
   Chat typing must never spend the PLAYBACK protocol's budget. Sharing one
   bucket let a fast typist silently drop drift requests and, for the active
   controller, its heartbeats — which can trigger stale-controller handoff. */

test('clock, chat-background and sync-background are distinct valid policies', () => {
  for (const name of ['clockPing', 'chatBackground', 'syncBackground']) {
    const p = RATE_POLICIES[name];
    assert.ok(p, `${name} exists`);
    assert.ok(p.capacity > 0 && p.refillTokens > 0 && p.refillMs > 0, `${name} well-formed`);
  }
});

test('their runtime names are distinct, so limiter keys are independent', () => {
  const policy = buildRuntimePolicy(attachmentMaxBytes({}));
  const names = ['clockPing', 'chatBackground', 'syncBackground'].map((n) => policy[n].name);
  assert.equal(new Set(names).size, 3, `distinct names: ${names.join(',')}`);
});

test('draining the chat-background bucket does NOT consume sync-background', () => {
  const runtime = buildRuntimePolicy(attachmentMaxBytes({}));
  const rl = createRateLimiter();
  const key = (p) => `member:ROOM:m_1:${p.name}`;

  // Exhaust chat background (a typing flood), and then some.
  for (let i = 0; i < runtime.chatBackground.capacity + 20; i += 1) {
    rl.consume({ key: key(runtime.chatBackground), policy: runtime.chatBackground, now: 0 });
  }
  assert.equal(
    rl.consume({ key: key(runtime.chatBackground), policy: runtime.chatBackground, now: 0 }).ok,
    false,
    'chat background is drained',
  );

  // Playback protocol traffic from the SAME member is untouched.
  const report = rl.consume({ key: key(runtime.syncBackground), policy: runtime.syncBackground, now: 0 });
  assert.equal(report.ok, true, 'sync:report still accepted after a typing flood');
  assert.equal(report.remaining, runtime.syncBackground.capacity - 1, 'sync bucket was never touched');
});

test('a full clock calibration burst (7 samples) is never throttled', () => {
  const runtime = buildRuntimePolicy(attachmentMaxBytes({}));
  const rl = createRateLimiter();
  for (let i = 0; i < 7; i += 1) {
    assert.equal(
      rl.consume({ key: 'socket:s1:clockPing', policy: runtime.clockPing, now: i * 60 }).ok,
      true,
      `calibration sample #${i + 1}`,
    );
  }
  // …and the steady-state 5s probe keeps working indefinitely.
  for (let i = 1; i <= 20; i += 1) {
    assert.equal(
      rl.consume({ key: 'socket:s1:clockPing', policy: runtime.clockPing, now: i * 5000 }).ok,
      true,
      `steady probe #${i}`,
    );
  }
});

/* ---------------- attachment cost vs bucket capacity ----------------
   The invariant this section exists for: anything validateAttachment() ACCEPTS
   must be affordable by a full bucket. Otherwise a valid file passes validation
   and is then rejected by the limiter forever, since cost > capacity can never
   be satisfied by waiting. */

test('the attachment bucket can accept one maximum-sized valid attachment', () => {
  const maxDecoded = attachmentMaxBytes({});
  const cost = maxAttachmentCost(maxDecoded);
  const policy = buildRuntimePolicy(maxDecoded).chatAttachment;
  assert.ok(cost <= policy.capacity, `cost=${cost} capacity=${policy.capacity}`);
});

test('the invariant holds for non-default configured limits', () => {
  // Future env changes must not be able to recreate the mismatch.
  for (const mib of [1, 2, 4, 8, 16, 32, 64]) {
    const maxDecoded = attachmentMaxBytes({ CHAT_ATTACHMENT_MAX_BYTES: String(mib * 1024 * 1024) });
    const cost = maxAttachmentCost(maxDecoded);
    const policy = buildRuntimePolicy(maxDecoded).chatAttachment;
    assert.ok(cost <= policy.capacity, `${mib}MiB: cost=${cost} capacity=${policy.capacity}`);
  }
});

test('a max-sized attachment consumes nearly the whole bucket', () => {
  // The weighting must stay meaningful — not clamped to 1 — so a huge file is
  // rate-limited far sooner than a stream of small ones.
  const maxDecoded = attachmentMaxBytes({});
  const cost = maxAttachmentCost(maxDecoded);
  const { capacity } = buildRuntimePolicy(maxDecoded).chatAttachment;
  assert.ok(cost >= capacity * 0.75, `cost=${cost} should be most of capacity=${capacity}`);
});

test('small attachments still cost proportionally little', () => {
  const { capacity } = buildRuntimePolicy(attachmentMaxBytes({})).chatAttachment;
  assert.ok(attachmentCost(64 * 1024) < capacity / 10, 'a voice note barely dents the bucket');
});

test('a fresh bucket accepts one max-cost attachment, then limits the next', () => {
  const maxDecoded = attachmentMaxBytes({});
  const policy = buildRuntimePolicy(maxDecoded).chatAttachment;
  const cost = maxAttachmentCost(maxDecoded);
  const rl = createRateLimiter();

  const first = rl.consume({ key: 'm', policy, cost, now: 0 });
  assert.equal(first.ok, true, 'a valid max-sized attachment is accepted');

  const second = rl.consume({ key: 'm', policy, cost, now: 0 });
  assert.equal(second.ok, false, 'a second, immediately, is rate-limited');
  assert.ok(second.retryAfterMs > 0, 'and reports when to retry');

  // …and becomes possible again after a full refill window.
  const later = rl.consume({ key: 'm', policy, cost, now: policy.refillMs + 1 });
  assert.equal(later.ok, true, 'possible again after refill');
});

test('the encoded ceiling is the single source of truth for both limits', () => {
  const maxDecoded = 4 * 1024 * 1024;
  const ceiling = maxEncodedAttachmentBytes(maxDecoded);
  // validateAttachment rejects above this ceiling…
  assert.equal(validateAttachment('data:image/png;base64,' + 'A'.repeat(ceiling + 10), {
    maxDecodedBytes: maxDecoded,
  }).error, 'TOO_LARGE');
  // …and the cost model is derived from the same number.
  assert.equal(maxAttachmentCost(maxDecoded), attachmentCost(ceiling));
});

/* ---------------- transport vs application limits ----------------
   The Socket.IO frame allowance is DERIVED from the attachment limit. If it were
   written down separately the two would drift, and a valid attachment would be
   dropped by the transport before any handler could answer it. */

test('the derived transport limit fits the largest valid attachment', () => {
  const maxDecoded = attachmentMaxBytes({});
  const encoded = maxEncodedAttachmentBytes(maxDecoded);
  const buffer = realtimeMaxBufferBytes(maxDecoded);
  assert.ok(buffer > encoded, `buffer=${buffer} must exceed encoded ceiling=${encoded}`);
});

test('the transport limit carries nonzero envelope headroom', () => {
  const maxDecoded = attachmentMaxBytes({});
  const headroom = realtimeMaxBufferBytes(maxDecoded) - maxEncodedAttachmentBytes(maxDecoded);
  assert.equal(headroom, REALTIME_ENVELOPE_BYTES);
  assert.ok(headroom >= 64 * 1024, 'enough for the data-URL prefix + message fields');
});

test('a configured attachment limit moves the transport limit with it', () => {
  let previous = 0;
  for (const mib of [1, 2, 4, 8, 16, 32, 64]) {
    const maxDecoded = attachmentMaxBytes({ CHAT_ATTACHMENT_MAX_BYTES: String(mib * 1024 * 1024) });
    const buffer = realtimeMaxBufferBytes(maxDecoded);
    assert.ok(buffer > maxEncodedAttachmentBytes(maxDecoded), `${mib}MiB fits`);
    assert.ok(buffer > previous, `${mib}MiB raised the buffer`);
    previous = buffer;
  }
});

test('the transport limit stays under the defensive maximum', () => {
  // Even a deliberately absurd env value cannot open a multi-gigabyte frame.
  for (const raw of ['99999999999', String(8 * 1024 * 1024 * 1024), 'Infinity']) {
    const maxDecoded = attachmentMaxBytes({ CHAT_ATTACHMENT_MAX_BYTES: raw });
    assert.ok(maxDecoded <= MAX_ATTACHMENT_MAX_BYTES, `attachment clamped: ${maxDecoded}`);
    const buffer = realtimeMaxBufferBytes(maxDecoded);
    assert.ok(buffer <= MAX_REALTIME_BUFFER_BYTES, `buffer clamped: ${buffer}`);
  }
});

test('a near-limit attachment is valid AND fits through the transport', () => {
  const maxDecoded = attachmentMaxBytes({});
  const buffer = realtimeMaxBufferBytes(maxDecoded);
  // Largest base64 payload whose decoded size is still under the cap.
  const payloadLen = Math.floor((maxDecoded / 3) * 4) - 4;
  const data = 'data:image/png;base64,' + 'A'.repeat(payloadLen);
  const verdict = validateAttachment(data, { maxDecodedBytes: maxDecoded });
  assert.equal(verdict.ok, true, `near-limit accepted (${verdict.error || ''})`);
  assert.ok(data.length < buffer, `and fits the frame: ${data.length} < ${buffer}`);
});

test('a slightly over-limit attachment reaches the handler and is TOO_LARGE', () => {
  const maxDecoded = attachmentMaxBytes({});
  const buffer = realtimeMaxBufferBytes(maxDecoded);
  // 8.5 MiB decoded against an 8 MiB cap — the case the E2E suite exercises live.
  const oversize = Math.floor(maxDecoded * 1.0625);
  const data = 'data:image/png;base64,' + 'A'.repeat(Math.floor((oversize / 3) * 4));
  assert.ok(data.length < buffer, 'still small enough to be delivered, not dropped');
  assert.equal(validateAttachment(data, { maxDecodedBytes: maxDecoded }).error, 'TOO_LARGE');
});

test('a grossly oversized frame is still rejected by the transport', () => {
  const maxDecoded = attachmentMaxBytes({});
  const buffer = realtimeMaxBufferBytes(maxDecoded);
  // 4x the cap: the frame exceeds maxHttpBufferSize, so Socket.IO refuses it
  // before a handler ever runs. That backstop must remain intact.
  const gross = 'data:image/png;base64,' + 'A'.repeat(Math.floor(((maxDecoded * 4) / 3) * 4));
  assert.ok(gross.length > buffer, `${gross.length} > ${buffer} — dropped at transport`);
});

/* ---------------- room history bounds ---------------- */

const makeRoom = () => ({ messages: [], messageBytes: 0 });
const textMessage = (i) => ({ id: `m${i}`, kind: 'text', text: `hello ${i}` });

test('history evicts by message count', () => {
  const room = makeRoom();
  for (let i = 0; i < 10; i += 1) pushMessageBounded(room, textMessage(i), { maxMessages: 5, maxBytes: 1e9 });
  assert.equal(room.messages.length, 5);
  assert.equal(room.messages[4].id, 'm9', 'newest kept');
  assert.equal(room.messages[0].id, 'm5', 'oldest evicted');
});

test('history evicts by BYTES even when the count is fine', () => {
  const room = makeRoom();
  // Each ~1KB; a 4KB budget must hold only a few, despite a 100-message cap.
  const big = (i) => ({ id: `b${i}`, kind: 'image', data: 'x'.repeat(1024) });
  for (let i = 0; i < 20; i += 1) pushMessageBounded(room, big(i), { maxMessages: 100, maxBytes: 4096 });
  assert.ok(room.messages.length < 20, `evicted by bytes, kept ${room.messages.length}`);
  assert.ok(room.messageBytes <= 4096, `budget held: ${room.messageBytes}`);
});

test('byte accounting stays correct after eviction', () => {
  const room = makeRoom();
  for (let i = 0; i < 30; i += 1) {
    pushMessageBounded(room, { id: `x${i}`, kind: 'image', data: 'y'.repeat(500) }, { maxMessages: 8, maxBytes: 1e9 });
  }
  const recomputed = room.messages.reduce((sum, m) => sum + estimateMessageBytes(m), 0);
  assert.equal(room.messages.length, 8);
  // Incremental accounting must match a fresh measurement.
  assert.equal(room.messageBytes, recomputed);
});

test('a single message is never evicted to nothing', () => {
  const room = makeRoom();
  // Even a message larger than the whole budget stays — the per-attachment cap
  // is what rejects those, not the history budget.
  pushMessageBounded(room, { id: 'solo', kind: 'image', data: 'z'.repeat(9999) }, { maxMessages: 50, maxBytes: 100 });
  assert.equal(room.messages.length, 1);
});

test('text and system messages survive attachment eviction pressure', () => {
  const room = makeRoom();
  pushMessageBounded(room, { id: 'sys', kind: 'system', text: 'x joined' }, { maxMessages: 50, maxBytes: 1e9 });
  for (let i = 0; i < 5; i += 1) {
    pushMessageBounded(room, { id: `img${i}`, kind: 'image', data: 'q'.repeat(200) }, { maxMessages: 50, maxBytes: 1e9 });
  }
  assert.equal(room.messages[0].id, 'sys', 'nothing evicted while under budget');
  assert.equal(room.messages.length, 6);
});

test('the internal byte tag never leaks into a broadcast payload', () => {
  const room = makeRoom();
  const message = { id: 'm', kind: 'text', text: 'hi' };
  pushMessageBounded(room, message, { maxMessages: 10, maxBytes: 1e9 });
  assert.ok(!Object.keys(message).includes('__bytes'));
  assert.equal(JSON.parse(JSON.stringify(message)).__bytes, undefined);
});
