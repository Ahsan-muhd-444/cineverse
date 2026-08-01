/**
 * Pure, framework-free helpers for the WebRTC call layer.
 *
 * Kept out of the hook so the fiddly, get-it-wrong-once bits — the polite/impolite
 * role, ICE-server parsing, signal-type validation, permission-error copy — are
 * unit-tested without a browser (see scripts/rtc.test.mjs). The server mirrors
 * the signal-type/size validation in server/rtc.js.
 */

export const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' },
];

/**
 * Does this ICE list contain an actual relay?
 *
 * STUN only discovers your public address; it cannot forward media. Behind
 * symmetric NAT / CGNAT (most mobile carriers) no candidate pair ever succeeds,
 * so the handshake completes, both docks say "connected", and nothing is heard.
 * The hook uses this to warn ONCE in development instead of shipping a call
 * layer that silently cannot work on those networks.
 */
export function hasTurnServer(servers: RTCIceServer[] | null | undefined): boolean {
  if (!Array.isArray(servers)) return false;
  return servers.some((s) =>
    ([] as unknown[]).concat(s?.urls ?? []).some((u) => String(u).toLowerCase().startsWith('turn')),
  );
}

/**
 * Parse the env-provided ICE-server list, falling back to public STUN on
 * anything invalid — bad JSON, a non-array, an empty array, or entries with no
 * usable `urls`. A misconfigured TURN block must degrade to STUN, never crash
 * the call layer or block the app from loading.
 */
export function parseIceServers(raw: string | undefined | null, fallback = DEFAULT_ICE_SERVERS): RTCIceServer[] {
  if (!raw || !raw.trim()) return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return fallback;
    const valid = parsed.filter(
      (s) => s && typeof s === 'object' && ((typeof s.urls === 'string' && s.urls) || (Array.isArray(s.urls) && s.urls.length)),
    );
    return valid.length ? (valid as RTCIceServer[]) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Deterministic "polite" role for perfect negotiation. Exactly one side of any
 * pair is polite, derived from the two socket ids so both peers agree without a
 * round-trip: the higher id is polite (rolls back on an offer collision), the
 * lower id is impolite (ignores the colliding offer). Ids are unique, so this is
 * never a tie.
 */
export function isPolite(myId: string, peerId: string): boolean {
  return String(myId) > String(peerId);
}

export const SIGNAL_TYPES = ['offer', 'answer', 'ice'] as const;
export type SignalType = (typeof SIGNAL_TYPES)[number];

export function isSupportedSignalType(type: unknown): type is SignalType {
  return typeof type === 'string' && (SIGNAL_TYPES as readonly string[]).includes(type);
}

/**
 * How many times in a row a peer's handshake may fail to be relayed before the
 * connection is given up on. Low enough that a genuinely broken peer resolves
 * quickly, high enough to ride out one rate-limited burst.
 */
export const SIGNAL_FAILURE_LIMIT = 3;

/**
 * Errors that mean the route itself is gone — retrying cannot fix them.
 *
 * `PEER_OFFLINE` is deliberately NOT here. The server holds a disconnected
 * member's seat for the whole reconnect grace window (two minutes in
 * production) and refuses relays to them meanwhile; treating that as fatal
 * ended a two-person call on the FIRST candidate sent during a Wi-Fi handoff.
 * It is transient by construction, so it falls through to the bounded
 * ignore/retry path below.
 */
const FATAL_SIGNAL_ERRORS = new Set(['UNAUTHORIZED', 'NOT_MEMBER', 'NO_RECIPIENT']);

/**
 * What to do when the server refuses to relay a signal.
 *
 * The three signal types fail very differently, and treating them alike is what
 * produces calls that hang on "Connecting…" forever:
 *
 *  - a dropped ICE candidate is routine. Candidates arrive in bursts, any one of
 *    them is expendable, and ICE will usually still find a path. Never tear a
 *    call down over one, and never show the user anything.
 *  - a dropped OFFER or ANSWER is fatal to that peer unless it is re-sent —
 *    nothing else in the negotiation loop will spontaneously retry it.
 *  - "the peer is not there" is not retryable at all, whatever the type.
 */
export function classifySignalFailure(params: {
  type: SignalType;
  error: string;
  consecutiveFailures: number;
}): 'ignore' | 'retry' | 'drop' {
  if (FATAL_SIGNAL_ERRORS.has(params.error)) return 'drop';
  // The ICE exemption is checked BEFORE the failure limit on purpose: the limit
  // used to win, so three rate-limited candidates in a burst tore the whole peer
  // down — the exact opposite of this function's own contract above. ICE loss is
  // never a reason to end a call; a stuck handshake still is, via offer/answer.
  if (params.type === 'ice') return 'ignore';
  if (params.consecutiveFailures >= SIGNAL_FAILURE_LIMIT) return 'drop';
  return 'retry';
}

/* ---------------- ICE candidate queueing ---------------- */

/**
 * Where an inbound ICE candidate has to go.
 *
 * Adding a candidate before `setRemoteDescription` throws, and a thrown
 * candidate is a lost candidate — the #1 cause of calls that connect "sometimes"
 * on one network and never on another. Anything that arrives early is held.
 */
export function planCandidateDelivery(params: { hasRemoteDescription: boolean }): 'apply' | 'queue' {
  return params.hasRemoteDescription ? 'apply' : 'queue';
}

/**
 * Take everything queued so far, in arrival order, and leave the queue empty.
 *
 * The take must be atomic: `addIceCandidate` is async, so a candidate that
 * arrives mid-flush has to land in the (now empty) queue rather than be replayed
 * or dropped. `splice` gives exactly that — one synchronous hand-off, order
 * preserved.
 */
export function drainCandidateQueue<T>(queue: T[]): T[] {
  return queue.splice(0, queue.length);
}

/* ---------------- capability gating ---------------- */

export const INSECURE_CONTEXT_MESSAGE = 'Voice and video require HTTPS.';
export const SCREEN_SHARE_UNSUPPORTED_MESSAGE = 'Screen sharing is not supported on this browser.';

/**
 * What this browser/origin can actually do, decided up front.
 *
 * `getUserMedia` is only exposed in a secure context, and `getDisplayMedia` is
 * absent on most mobile browsers. Without this the buttons rendered as live and
 * failed at click time with an opaque error — "the UI claims the feature is
 * active while nothing happens". Localhost counts as secure (browsers treat it
 * that way) so plain-HTTP development is unaffected.
 */
export function describeCallSupport(env: {
  secureContext?: boolean;
  hostname?: string;
  hasUserMedia?: boolean;
  hasDisplayMedia?: boolean;
}): { canCall: boolean; callBlockedReason: string | null; canShareScreen: boolean; screenBlockedReason: string | null } {
  const host = (env.hostname || '').toLowerCase();
  const localhost = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || host.endsWith('.localhost');
  const secure = Boolean(env.secureContext) || localhost;
  if (!secure || !env.hasUserMedia) {
    return {
      canCall: false,
      callBlockedReason: INSECURE_CONTEXT_MESSAGE,
      canShareScreen: false,
      screenBlockedReason: INSECURE_CONTEXT_MESSAGE,
    };
  }
  return {
    canCall: true,
    callBlockedReason: null,
    canShareScreen: Boolean(env.hasDisplayMedia),
    screenBlockedReason: env.hasDisplayMedia ? null : SCREEN_SHARE_UNSUPPORTED_MESSAGE,
  };
}

/**
 * What the video sender must carry once a screen share ends.
 *
 * Restoring a dead or switched-off camera would push a frozen last frame at the
 * other side forever; sending nothing (`replaceTrack(null)`) mutes their
 * receiver so their tile falls back to the avatar. Exactly one of the two.
 */
export function planScreenShareEnd(params: { cameraOn: boolean; cameraTrackLive: boolean }): {
  restoreCamera: boolean;
} {
  return { restoreCamera: params.cameraOn && params.cameraTrackLive };
}

/** Why a peer connection went away — the three cases need different handling. */
export type PeerDepartureReason = 'hangup' | 'transport' | 'left';

/**
 * What losing a peer means for MY call.
 *
 * The server emits `peer:left` for a genuine departure AND for a dropped
 * transport, because the peer connection really is dead either way. Treating
 * them alike is what made a one-second Wi-Fi blip end a call permanently: the
 * seat survived the grace window, the call did not, and nothing re-established
 * it. A transport drop therefore closes only that connection and keeps the call
 * alive so the returning peer can be re-offered; a real hangup/leave ends the
 * call once no peers remain.
 */
export function planPeerDeparture(params: {
  reason: PeerDepartureReason;
  mode: 'idle' | 'audio' | 'video';
  remainingPeerCount: number;
}): { endCall: boolean; awaitReconnect: boolean } {
  if (params.mode === 'idle') return { endCall: false, awaitReconnect: false };
  if (params.reason === 'transport') return { endCall: false, awaitReconnect: true };
  return { endCall: params.remainingPeerCount === 0, awaitReconnect: false };
}

/** How long to wait before re-sending a handshake signal, honouring the limiter. */
export function signalRetryDelay(retryAfterMs: number | undefined, attempt: number): number {
  const backoff = Math.min(4000, 400 * Math.max(1, attempt));
  return Math.min(6000, Math.max(backoff, retryAfterMs || 0));
}

/**
 * The members WebRTC may actually route to.
 *
 * Presence deliberately keeps a member listed while they are inside their
 * reconnect grace window (`connected: false`), so a refresh doesn't churn the
 * People list. Media is different: their transport is genuinely gone, so
 * handing that id to the call layer would recreate a peer connection to nobody
 * and leave a stale entry blocking renegotiation when they return.
 */
export function connectedMemberIds(members: { id: string; connected?: boolean }[]): string[] {
  return members.filter((m) => m.connected !== false).map((m) => m.id);
}

/**
 * Whether closing a peer should also end MY local call.
 *
 * In a two-person call, the other side hanging up leaves me with no peers: the
 * call is over, so my tracks must stop and the dock must return to idle. Leaving
 * `mode` active there stranded the dock on "Waiting for someone to join…" with
 * the mic/camera still live.
 *
 * In a group call, one person leaving still leaves peers connected, so the call
 * continues and local tracks stay up.
 */
export function shouldEndCallAfterPeerClosed(params: {
  mode: 'idle' | 'audio' | 'video';
  remainingPeerCount: number;
}): boolean {
  return params.mode !== 'idle' && params.remainingPeerCount === 0;
}

/**
 * What declining an incoming call must do.
 *
 * Because the callee pre-negotiates (the peer connection is answered before the
 * user clicks Accept), declining has to tear that connection down — not just hide
 * the prompt. It should also notify the caller so they stop waiting, but ONLY
 * when we are otherwise idle: `rtc:hangup` is broadcast to the room, so emitting
 * it while we're in a call with other people would end those calls too.
 */
export function planDecline(params: { from: string | null | undefined; mode: 'idle' | 'audio' | 'video' }): {
  closePeerId: string | null;
  notifyCaller: boolean;
} {
  if (!params.from) return { closePeerId: null, notifyCaller: false };
  return { closePeerId: params.from, notifyCaller: params.mode === 'idle' };
}

/**
 * Turn a getUserMedia/getDisplayMedia rejection into copy a user can act on.
 *
 * `'screen'` is its own case because a dismissed screen picker and a blocked one
 * both surface as `NotAllowedError` — the browser gives us no way to tell them
 * apart — so that copy has to read sensibly for either.
 */
export function describeMediaError(err: unknown, wanted: 'audio' | 'video' | 'screen'): string {
  const name = (err as { name?: string } | null)?.name || '';
  if (wanted === 'screen') {
    switch (name) {
      case 'NotAllowedError':
      case 'SecurityError':
      case 'PermissionDeniedError':
        return 'Screen sharing was cancelled or blocked. Allow screen recording for this site, then try again.';
      case 'NotFoundError':
      case 'DevicesNotFoundError':
        return 'No screen or window was available to share.';
      case 'NotReadableError':
      case 'TrackStartError':
      case 'AbortError':
        return 'Your screen could not be captured — another app may be recording it. Close it and try again.';
      default:
        return 'Could not start screen sharing.';
    }
  }
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return wanted === 'video'
        ? 'Camera & microphone access was blocked. Allow it in your browser’s site settings, then try again.'
        : 'Microphone access was blocked. Allow it in your browser’s site settings, then try again.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return wanted === 'video'
        ? 'No camera or microphone was found on this device.'
        : 'No microphone was found on this device.';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'Your camera or microphone is already in use by another app. Close it and try again.';
    default:
      return wanted === 'video' ? 'Could not start the camera and microphone.' : 'Could not start the microphone.';
  }
}
