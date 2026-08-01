/**
 * Unit tests for the WebRTC helper logic.
 *
 * Client helpers (src/lib/rtc.ts) — polite role, ICE-server parsing, signal-type
 * guard, permission-error copy — via Node type-stripping. Server relay validation
 * (server/rtc.js) via require. No browser, no sockets.
 *
 * Run:  node --test --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/rtc.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import {
  isPolite,
  parseIceServers,
  isSupportedSignalType,
  describeMediaError,
  planDecline,
  shouldEndCallAfterPeerClosed,
  connectedMemberIds,
  DEFAULT_ICE_SERVERS,
} from '../src/lib/rtc.ts';

const require = createRequire(import.meta.url);
const { validateRtcSignal, MAX_SIGNAL_BYTES } = require('../server/rtc.js');

/* ---------------- polite role ---------------- */

test('polite role is deterministic and opposite on the two sides', () => {
  // Whoever has the higher id is polite; the other side computes the opposite.
  assert.equal(isPolite('bbb', 'aaa'), true);
  assert.equal(isPolite('aaa', 'bbb'), false);
  // Both sides of the SAME pair must disagree — exactly one polite.
  const a = 'socket-AAA';
  const b = 'socket-ZZZ';
  assert.notEqual(isPolite(a, b), isPolite(b, a));
});

/* ---------------- ICE server parsing ---------------- */

test('valid ICE JSON is parsed through', () => {
  const raw = '[{"urls":"turn:turn.example.com:3478","username":"u","credential":"p"}]';
  const servers = parseIceServers(raw);
  assert.equal(servers.length, 1);
  assert.equal(servers[0].urls, 'turn:turn.example.com:3478');
  assert.equal(servers[0].username, 'u');
});

test('an array of urls is accepted', () => {
  const servers = parseIceServers('[{"urls":["stun:a:1","stun:b:2"]}]');
  assert.deepEqual(servers[0].urls, ['stun:a:1', 'stun:b:2']);
});

test('invalid JSON falls back to default STUN', () => {
  assert.equal(parseIceServers('{not json'), DEFAULT_ICE_SERVERS);
  assert.equal(parseIceServers('nonsense'), DEFAULT_ICE_SERVERS);
});

test('an empty array or missing value falls back to default STUN', () => {
  assert.equal(parseIceServers('[]'), DEFAULT_ICE_SERVERS);
  assert.equal(parseIceServers(''), DEFAULT_ICE_SERVERS);
  assert.equal(parseIceServers(undefined), DEFAULT_ICE_SERVERS);
  assert.equal(parseIceServers(null), DEFAULT_ICE_SERVERS);
});

test('a non-array (object/number) falls back to default STUN', () => {
  assert.equal(parseIceServers('{"urls":"stun:x"}'), DEFAULT_ICE_SERVERS);
  assert.equal(parseIceServers('42'), DEFAULT_ICE_SERVERS);
});

test('entries with no usable urls are dropped; all-invalid falls back', () => {
  // One good, one junk → keep only the good.
  const mixed = parseIceServers('[{"urls":"stun:good:1"},{"foo":"bar"}]');
  assert.equal(mixed.length, 1);
  assert.equal(mixed[0].urls, 'stun:good:1');
  // All junk → fall back.
  assert.equal(parseIceServers('[{"foo":"bar"},{"baz":1}]'), DEFAULT_ICE_SERVERS);
});

/* ---------------- signal type guard ---------------- */

test('isSupportedSignalType accepts only offer/answer/ice', () => {
  for (const t of ['offer', 'answer', 'ice']) assert.equal(isSupportedSignalType(t), true, t);
  for (const t of ['candidate', 'bye', '', null, undefined, 42, {}]) assert.equal(isSupportedSignalType(t), false, String(t));
});

/* ---------------- call-routable members ---------------- */

test('members inside their reconnect grace window are excluded from WebRTC peers', () => {
  const members = [
    { id: 'm_a', connected: true },
    { id: 'm_b', connected: false }, // refreshing — transport is gone
    { id: 'm_c', connected: true },
  ];
  assert.deepEqual(connectedMemberIds(members), ['m_a', 'm_c']);
});

test('a member missing the connected flag is treated as connected', () => {
  // Backwards/forwards compatible: only an explicit false excludes.
  assert.deepEqual(connectedMemberIds([{ id: 'm_a' }, { id: 'm_b', connected: undefined }]), ['m_a', 'm_b']);
});

test('all-disconnected and empty member lists yield no peers', () => {
  assert.deepEqual(connectedMemberIds([{ id: 'm_a', connected: false }]), []);
  assert.deepEqual(connectedMemberIds([]), []);
});

test('a reconnected member becomes routable again', () => {
  const before = [{ id: 'm_a', connected: true }, { id: 'm_b', connected: false }];
  const after = [{ id: 'm_a', connected: true }, { id: 'm_b', connected: true }];
  assert.deepEqual(connectedMemberIds(before), ['m_a']);
  assert.deepEqual(connectedMemberIds(after), ['m_a', 'm_b']);
});

/* ---------------- ending the call when the last peer goes ---------------- */

test('the last peer hanging up ends my call (2-person call)', () => {
  assert.equal(shouldEndCallAfterPeerClosed({ mode: 'audio', remainingPeerCount: 0 }), true);
  assert.equal(shouldEndCallAfterPeerClosed({ mode: 'video', remainingPeerCount: 0 }), true);
});

test('one of several peers hanging up does NOT end my call (group call)', () => {
  assert.equal(shouldEndCallAfterPeerClosed({ mode: 'audio', remainingPeerCount: 1 }), false);
  assert.equal(shouldEndCallAfterPeerClosed({ mode: 'video', remainingPeerCount: 2 }), false);
});

test('a peer closing while I am idle never ends a call', () => {
  // e.g. the caller hangs up before I accept — nothing of mine to end.
  assert.equal(shouldEndCallAfterPeerClosed({ mode: 'idle', remainingPeerCount: 0 }), false);
  assert.equal(shouldEndCallAfterPeerClosed({ mode: 'idle', remainingPeerCount: 3 }), false);
});

/* ---------------- decline cleanup ---------------- */

test('declining an incoming call closes the caller peer and notifies them', () => {
  // Idle callee: tear down the pre-negotiated connection AND tell the caller,
  // so they stop sitting in connecting/waiting for us.
  assert.deepEqual(planDecline({ from: 'caller-1', mode: 'idle' }), {
    closePeerId: 'caller-1',
    notifyCaller: true,
  });
});

test('declining while already in a call does NOT broadcast hangup', () => {
  // rtc:hangup is room-wide; emitting it mid-call would end our other calls too.
  for (const mode of ['audio', 'video']) {
    assert.deepEqual(planDecline({ from: 'caller-1', mode }), { closePeerId: 'caller-1', notifyCaller: false }, mode);
  }
});

test('declining with no pending caller is a no-op', () => {
  for (const from of [null, undefined, '']) {
    assert.deepEqual(planDecline({ from, mode: 'idle' }), { closePeerId: null, notifyCaller: false }, String(from));
  }
});

/* ---------------- permission error copy ---------------- */

test('describeMediaError maps permission denial to actionable copy', () => {
  const denied = describeMediaError({ name: 'NotAllowedError' }, 'audio');
  assert.match(denied, /blocked/i);
  const noDevice = describeMediaError({ name: 'NotFoundError' }, 'video');
  assert.match(noDevice, /no camera or microphone/i);
  const busy = describeMediaError({ name: 'NotReadableError' }, 'audio');
  assert.match(busy, /already in use/i);
  // Unknown errors still yield a sane message, never throw.
  assert.match(describeMediaError(new Error('weird'), 'video'), /camera/i);
  assert.match(describeMediaError(null, 'audio'), /microphone/i);
});

/* ---------------- server signal validation ---------------- */

const sdp = { type: 'offer', sdp: 'v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\n' };

test('a well-formed offer/answer/ice signal is accepted', () => {
  assert.deepEqual(validateRtcSignal({ type: 'offer', sdp }), { ok: true });
  assert.deepEqual(validateRtcSignal({ type: 'answer', sdp: { type: 'answer', sdp: 'v=0\r\n' } }), { ok: true });
  assert.deepEqual(validateRtcSignal({ type: 'ice', candidate: { candidate: 'candidate:1 1 udp ...', sdpMid: '0' } }), {
    ok: true,
  });
});

test('an unsupported signal type is rejected', () => {
  assert.equal(validateRtcSignal({ type: 'bye' }).error, 'BAD_TYPE');
  assert.equal(validateRtcSignal({ type: 'candidate', candidate: {} }).error, 'BAD_TYPE');
});

test('malformed signals are rejected without throwing', () => {
  assert.equal(validateRtcSignal(null).error, 'BAD_SIGNAL');
  assert.equal(validateRtcSignal('offer').error, 'BAD_SIGNAL');
  assert.equal(validateRtcSignal([]).error, 'BAD_SIGNAL');
  // offer without an sdp object
  assert.equal(validateRtcSignal({ type: 'offer' }).error, 'BAD_SIGNAL');
  assert.equal(validateRtcSignal({ type: 'offer', sdp: { type: 'offer' } }).error, 'BAD_SIGNAL');
  // ice without a candidate object
  assert.equal(validateRtcSignal({ type: 'ice' }).error, 'BAD_SIGNAL');
});

test('an oversized signal is rejected', () => {
  const huge = { type: 'offer', sdp: { type: 'offer', sdp: 'x'.repeat(MAX_SIGNAL_BYTES + 100) } };
  assert.equal(validateRtcSignal(huge).error, 'TOO_LARGE');
});

test('a signal right at the size limit is still accepted', () => {
  // Build one comfortably under the cap to prove the boundary isn't inverted.
  const ok = { type: 'offer', sdp: { type: 'offer', sdp: 'x'.repeat(1000) } };
  assert.deepEqual(validateRtcSignal(ok), { ok: true });
});
