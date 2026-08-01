/**
 * Unit tests for the call-layer fixes: signal validation, ICE-candidate
 * queueing, screen-share teardown, capability gating, peer-departure policy and
 * media-error copy.
 *
 * Pure logic only — no browser, no sockets, no RTCPeerConnection. Client helpers
 * come from src/lib/rtc.ts via Node's type stripping (that module has no
 * relative imports, which the stripper cannot resolve); the server's relay
 * validator is required directly from server/rtc.js.
 *
 * Run:  node --test --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/webrtc.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import {
  describeCallSupport,
  describeMediaError,
  drainCandidateQueue,
  hasTurnServer,
  INSECURE_CONTEXT_MESSAGE,
  planCandidateDelivery,
  planPeerDeparture,
  planScreenShareEnd,
  SCREEN_SHARE_UNSUPPORTED_MESSAGE,
  SIGNAL_TYPES,
} from '../src/lib/rtc.ts';

const require = createRequire(import.meta.url);
const { validateRtcSignal, MAX_SIGNAL_BYTES } = require('../server/rtc.js');

/* ---------------- signal-type validation ---------------- */

/** The three payload shapes the client actually emits, minimally realistic. */
const EMITTED_SIGNALS = {
  offer: { type: 'offer', sdp: { type: 'offer', sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n' } },
  answer: { type: 'answer', sdp: { type: 'answer', sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n' } },
  ice: {
    type: 'ice',
    candidate: { candidate: 'candidate:1 1 udp 2113937151 192.0.2.1 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 },
  },
};

test('the server accepts every signal type the client emits', () => {
  // If these ever diverge, one leg of the handshake vanishes with an ack that
  // says {ok:false} and the call sits on "Connecting…" forever.
  for (const type of SIGNAL_TYPES) {
    assert.ok(EMITTED_SIGNALS[type], `no fixture for emitted type ${type}`);
    assert.deepEqual(validateRtcSignal(EMITTED_SIGNALS[type]), { ok: true }, `${type} must relay`);
  }
  assert.deepEqual([...SIGNAL_TYPES], ['offer', 'answer', 'ice']);
});

test('unknown or malformed signals are still refused', () => {
  assert.equal(validateRtcSignal({ type: 'renegotiate' }).error, 'BAD_TYPE');
  assert.equal(validateRtcSignal({ type: 'offer' }).error, 'BAD_SIGNAL', 'offer without an sdp');
  assert.equal(validateRtcSignal({ type: 'offer', sdp: { type: 'offer' } }).error, 'BAD_SIGNAL', 'sdp.sdp not a string');
  assert.equal(validateRtcSignal({ type: 'ice' }).error, 'BAD_SIGNAL', 'ice without a candidate');
  assert.equal(validateRtcSignal(null).error, 'BAD_SIGNAL');
  assert.equal(validateRtcSignal([]).error, 'BAD_SIGNAL');
});

test('a realistic video SDP is nowhere near the size limit', () => {
  // A worst-case non-trickle answer — multi-track, full codec set, candidates
  // inlined — is tens of KB. Build one an order of magnitude past a typical
  // offer and assert it relays untouched.
  const line = 'a=rtpmap:96 VP8/90000\r\na=candidate:1 1 udp 2113937151 192.0.2.1 5000 typ host\r\n';
  const bigSdp = `v=0\r\n${line.repeat(700)}`;
  assert.ok(Buffer.byteLength(bigSdp) > 40 * 1024, 'fixture must actually be a large SDP');
  assert.deepEqual(validateRtcSignal({ type: 'offer', sdp: { type: 'offer', sdp: bigSdp } }), { ok: true });
  assert.ok(MAX_SIGNAL_BYTES >= 128 * 1024, 'the cap must leave real headroom over a large SDP');
});

test('an absurd payload is still rejected, so the relay stays bounded', () => {
  const huge = { type: 'offer', sdp: { type: 'offer', sdp: 'x'.repeat(MAX_SIGNAL_BYTES + 1024) } };
  assert.equal(validateRtcSignal(huge).error, 'TOO_LARGE');
});

/* ---------------- ICE candidate queueing ---------------- */

test('candidates arriving before the remote description are queued, not applied', () => {
  assert.equal(planCandidateDelivery({ hasRemoteDescription: false }), 'queue');
  assert.equal(planCandidateDelivery({ hasRemoteDescription: true }), 'apply');
});

test('the queue flushes in arrival order and empties exactly once', () => {
  const queue = ['a', 'b', 'c'];
  const drained = drainCandidateQueue(queue);
  assert.deepEqual(drained, ['a', 'b', 'c'], 'ICE order matters — pairs are checked in priority order');
  assert.deepEqual(queue, [], 'the take must be atomic: nothing left behind to be replayed');
  assert.deepEqual(drainCandidateQueue(queue), [], 'a second flush yields nothing');
});

test('a candidate that arrives mid-flush lands in the next flush, never lost', () => {
  // Mirrors the real interleaving: `addIceCandidate` is async, so the socket
  // handler can push while the previous batch is still being applied.
  const queue = ['first'];
  const batch = drainCandidateQueue(queue);
  queue.push('during-flush');
  assert.deepEqual(batch, ['first']);
  assert.deepEqual(drainCandidateQueue(queue), ['during-flush']);
});

/* ---------------- screen share teardown ---------------- */

test('ending a share restores the camera only when it is on AND live', () => {
  assert.deepEqual(planScreenShareEnd({ cameraOn: true, cameraTrackLive: true }), { restoreCamera: true });
  // Camera switched off: sending nothing mutes their receiver so the tile falls
  // back to the avatar, instead of freezing on our last screen frame.
  assert.deepEqual(planScreenShareEnd({ cameraOn: false, cameraTrackLive: true }), { restoreCamera: false });
  // Track ended (device unplugged / released): restoring it would push a dead
  // track at the far side.
  assert.deepEqual(planScreenShareEnd({ cameraOn: true, cameraTrackLive: false }), { restoreCamera: false });
  assert.deepEqual(planScreenShareEnd({ cameraOn: false, cameraTrackLive: false }), { restoreCamera: false });
});

/* ---------------- peer departure policy ---------------- */

test('a transport drop keeps the call alive; a real departure ends it', () => {
  const mode = 'video';
  assert.deepEqual(
    planPeerDeparture({ reason: 'transport', mode, remainingPeerCount: 0 }),
    { endCall: false, awaitReconnect: true },
    'a backgrounded phone or Wi-Fi handoff must not end the call',
  );
  assert.deepEqual(planPeerDeparture({ reason: 'left', mode, remainingPeerCount: 0 }), {
    endCall: true,
    awaitReconnect: false,
  });
  assert.deepEqual(planPeerDeparture({ reason: 'hangup', mode, remainingPeerCount: 0 }), {
    endCall: true,
    awaitReconnect: false,
  });
});

test('a group call survives one person leaving', () => {
  assert.deepEqual(planPeerDeparture({ reason: 'left', mode: 'audio', remainingPeerCount: 1 }), {
    endCall: false,
    awaitReconnect: false,
  });
});

test('nothing happens when we were never in a call', () => {
  for (const reason of ['transport', 'left', 'hangup']) {
    assert.deepEqual(planPeerDeparture({ reason, mode: 'idle', remainingPeerCount: 0 }), {
      endCall: false,
      awaitReconnect: false,
    });
  }
});

/* ---------------- capability gating ---------------- */

test('an insecure origin disables calls with an honest reason', () => {
  const verdict = describeCallSupport({ secureContext: false, hostname: 'cineverse.example', hasUserMedia: false });
  assert.equal(verdict.canCall, false);
  assert.equal(verdict.callBlockedReason, INSECURE_CONTEXT_MESSAGE);
  assert.equal(verdict.canShareScreen, false, 'screen capture needs a secure context too');
});

test('localhost counts as secure, so plain-HTTP development still works', () => {
  for (const hostname of ['localhost', '127.0.0.1', '::1', 'app.localhost']) {
    const verdict = describeCallSupport({ secureContext: false, hostname, hasUserMedia: true, hasDisplayMedia: true });
    assert.equal(verdict.canCall, true, `${hostname} must be callable`);
    assert.equal(verdict.callBlockedReason, null);
  }
});

test('a browser without getDisplayMedia can still call, but not share', () => {
  const verdict = describeCallSupport({
    secureContext: true,
    hostname: 'cineverse.example',
    hasUserMedia: true,
    hasDisplayMedia: false,
  });
  assert.equal(verdict.canCall, true);
  assert.equal(verdict.canShareScreen, false);
  assert.equal(verdict.screenBlockedReason, SCREEN_SHARE_UNSUPPORTED_MESSAGE);
});

/* ---------------- TURN detection ---------------- */

test('STUN-only lists are reported as having no relay', () => {
  assert.equal(hasTurnServer([{ urls: 'stun:stun.l.google.com:19302' }]), false);
  assert.equal(hasTurnServer([]), false);
  assert.equal(hasTurnServer(null), false);
});

test('TURN is detected in either urls shape and in TURNS', () => {
  assert.equal(hasTurnServer([{ urls: 'turn:turn.example.com:3478' }]), true);
  assert.equal(hasTurnServer([{ urls: ['stun:a:1', 'turns:b:5349'] }]), true);
  assert.equal(hasTurnServer([{ urls: 'TURN:UPPER.example:3478' }]), true);
});

/* ---------------- media error copy ---------------- */

test('acquisition failures map to an actionable message, never a shrug', () => {
  const cases = [
    ['NotAllowedError', 'audio', /blocked/i],
    ['NotAllowedError', 'video', /blocked/i],
    ['NotFoundError', 'audio', /No microphone/i],
    ['NotFoundError', 'video', /No camera/i],
    ['NotReadableError', 'video', /already in use/i],
    ['TrackStartError', 'audio', /already in use/i],
  ];
  for (const [name, wanted, expected] of cases) {
    assert.match(describeMediaError({ name }, wanted), expected, `${name}/${wanted}`);
  }
});

test('screen capture gets its own copy, readable for both cancel and block', () => {
  // The browser reports a dismissed picker and a denied permission identically,
  // so this one string has to be true either way.
  assert.match(describeMediaError({ name: 'NotAllowedError' }, 'screen'), /cancelled or blocked/i);
  assert.match(describeMediaError({ name: 'NotFoundError' }, 'screen'), /No screen or window/i);
  assert.match(describeMediaError({ name: 'NotReadableError' }, 'screen'), /could not be captured/i);
  assert.match(describeMediaError(new Error('boom'), 'screen'), /Could not start screen sharing/i);
});

test('an unrecognised failure still says something specific to what was asked for', () => {
  assert.match(describeMediaError(new Error('boom'), 'audio'), /microphone/i);
  assert.match(describeMediaError(undefined, 'video'), /camera/i);
});
