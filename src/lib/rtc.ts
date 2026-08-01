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

/** Errors that mean the route itself is gone — retrying cannot fix them. */
const FATAL_SIGNAL_ERRORS = new Set(['UNAUTHORIZED', 'NOT_MEMBER', 'NO_RECIPIENT', 'PEER_OFFLINE']);

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
  if (params.consecutiveFailures >= SIGNAL_FAILURE_LIMIT) return 'drop';
  return params.type === 'ice' ? 'ignore' : 'retry';
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

/** Turn a getUserMedia/getDisplayMedia rejection into copy a user can act on. */
export function describeMediaError(err: unknown, wanted: 'audio' | 'video'): string {
  const name = (err as { name?: string } | null)?.name || '';
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
