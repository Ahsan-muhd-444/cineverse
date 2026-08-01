'use client';

import * as React from 'react';
import {
  classifySignalFailure,
  DEFAULT_ICE_SERVERS,
  describeCallSupport,
  describeMediaError,
  drainCandidateQueue,
  hasTurnServer,
  isPolite,
  parseIceServers,
  planCandidateDelivery,
  planDecline,
  planPeerDeparture,
  planScreenShareEnd,
  shouldEndCallAfterPeerClosed,
  signalRetryDelay,
  type PeerDepartureReason,
} from '@/lib/rtc';
import type { Socket } from 'socket.io-client';
import { normalizeAck } from '@/lib/acks';

export type CallMode = 'idle' | 'audio' | 'video';
/** Coarse, user-facing status for the dock — never the raw RTC enum. */
export type CallStatus = 'idle' | 'requesting' | 'waiting' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

export interface PeerStream {
  id: string;
  stream: MediaStream;
  /**
   * Bumped every time a track is added to (or removed from) this peer's stream.
   *
   * We own the MediaStream object, and a programmatic `addTrack` deliberately
   * does NOT fire `addtrack` — so the object identity never changes and a
   * consumer keyed on `[stream]` alone would never re-attach `srcObject`. That
   * is what made an audio→video upgrade arrive as a black rectangle.
   */
  version: number;
}

/** Dev-only, per-peer connection facts. Never rendered in production. */
export interface PeerDiagnostics {
  id: string;
  polite: boolean;
  signalingState: RTCSignalingState;
  iceConnectionState: RTCIceConnectionState;
  connectionState: RTCPeerConnectionState;
  sendTracks: number;
  recvTracks: number;
  lastError: string | null;
}

interface SignalPayload {
  type: 'offer' | 'answer' | 'ice';
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
}

/**
 * One peer connection plus the small amount of state the "perfect negotiation"
 * pattern needs to stay glare-proof. `pendingCandidates` holds ICE that arrived
 * before we had a remote description — adding those early is the #1 cause of
 * calls that connect "sometimes".
 */
interface Peer {
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  isSettingRemoteAnswerPending: boolean;
  pendingCandidates: RTCIceCandidateInit[];
  /**
   * OUR video sender, remembered rather than looked up.
   *
   * Every lookup used to be `getSenders().find((s) => s.track?.kind === 'video')`,
   * which is `undefined` for a sender whose track is null — precisely the state
   * a stopped screen share leaves behind. The sender was then invisible, so
   * turning the camera back on took the `addTrack` path and opened a SECOND
   * video m-line; the receiver rendered the first (dead) track and showed a
   * permanently black tile with the handshake reported as successful.
   */
  videoSender: RTCRtpSender | null;
  /** The single MediaStream we hand the UI for this peer (see PeerStream.version). */
  remoteStream: MediaStream | null;
  /** Re-sends our offer if no answer comes back — see armOfferWatchdog. */
  offerWatchdog: ReturnType<typeof setTimeout> | null;
  offerResends: number;
  lastError: string | null;
}

/** How long a call survives with zero peers after a transport drop. */
const RECONNECT_HOLD_MS = 45_000;
/** How long to wait for an answer before re-sending the same offer. */
const OFFER_RESEND_MS = 2_500;
const OFFER_RESEND_LIMIT = 3;

/** Next.js inlines NODE_ENV, so the dev-only blocks below vanish in a prod build. */
const DEV = process.env.NODE_ENV !== 'production';
/** Module-scoped so the TURN warning is logged once per page load, not per room. */
let turnWarned = false;

/**
 * Peer-to-peer voice, video and screen share.
 *
 * Media never touches the server — only the SDP/ICE handshake is relayed. The
 * connection model is the standard "perfect negotiation" pattern:
 *
 *  - a deterministic polite/impolite role per pair (from member-id order) makes
 *    simultaneous offers (glare) resolve without a coin-flip: the impolite side
 *    ignores a colliding offer, the polite side rolls back and accepts it;
 *  - `onnegotiationneeded` drives every (re)negotiation, so adding a camera,
 *    upgrading audio→video, or sharing a screen all renegotiate the same way;
 *  - ICE candidates that arrive before the remote description are QUEUED and
 *    flushed once it is set, never dropped.
 *
 * Camera-off model: the track stays alive (so it can be re-attached instantly)
 * but the sender is switched to `replaceTrack(null)`. Merely setting
 * `track.enabled = false` keeps the encoder running, so the far side received a
 * live black rectangle instead of an avatar; a null sender track genuinely
 * mutes their receiver, and neither direction needs renegotiation.
 */
export function useWebRTC(socket: Socket, memberIds: string[], enabled: boolean, selfId: string) {
  const [mode, setMode] = React.useState<CallMode>('idle');
  const [micOn, setMicOn] = React.useState(false);
  const [camOn, setCamOn] = React.useState(false);
  const [sharing, setSharing] = React.useState(false);
  const [remoteStreams, setRemoteStreams] = React.useState<PeerStream[]>([]);
  const [localStream, setLocalStream] = React.useState<MediaStream | null>(null);
  const [screenStream, setScreenStream] = React.useState<MediaStream | null>(null);
  const [incoming, setIncoming] = React.useState<{ from: string; name: string; mode: 'audio' | 'video' } | null>(null);
  const [stats, setStats] = React.useState<{ rtt: number; loss: number }>({ rtt: 0, loss: 0 });
  const [error, setError] = React.useState<string | null>(null);
  const [acquiring, setAcquiring] = React.useState(false);
  const [connState, setConnState] = React.useState<Record<string, RTCPeerConnectionState>>({});
  const [awaitingReconnect, setAwaitingReconnect] = React.useState(false);
  const [diagnostics, setDiagnostics] = React.useState<PeerDiagnostics[]>([]);

  /**
   * Capability verdict. Starts optimistic and is corrected after mount: it
   * depends on `window`, and rendering a different `disabled` on the server than
   * on the first client pass is a hydration mismatch.
   */
  const [support, setSupport] = React.useState(() =>
    describeCallSupport({ secureContext: true, hasUserMedia: true, hasDisplayMedia: true }),
  );
  React.useEffect(() => {
    setSupport(
      describeCallSupport({
        secureContext: window.isSecureContext,
        hostname: window.location.hostname,
        hasUserMedia: typeof navigator.mediaDevices?.getUserMedia === 'function',
        hasDisplayMedia: typeof navigator.mediaDevices?.getDisplayMedia === 'function',
      }),
    );
  }, []);

  const peersRef = React.useRef(new Map<string, Peer>());
  const localRef = React.useRef<MediaStream | null>(null);
  const cameraTrackRef = React.useRef<MediaStreamTrack | null>(null);
  const screenTrackRef = React.useRef<MediaStreamTrack | null>(null);
  // Mirror the booleans as refs so callbacks/timers publish accurate state
  // without being recreated (and going stale) on every toggle.
  const modeRef = React.useRef<CallMode>('idle');
  const micRef = React.useRef(false);
  const camRef = React.useRef(false);
  const sharingRef = React.useRef(false);
  // Guards against a second getUserMedia while the permission prompt is open.
  const acquiringRef = React.useRef(false);
  // Consecutive refused relays, keyed `peer|type`: an ICE burst must never
  // poison the counter that decides whether the next OFFER is worth retrying.
  const signalFailuresRef = React.useRef(new Map<string, number>());
  const signalRetryTimersRef = React.useRef(new Set<ReturnType<typeof setTimeout>>());
  const sendSignalRef = React.useRef<((to: string, data: SignalPayload, attempt?: number) => void) | null>(null);
  // Peers whose transport dropped and who are expected back inside the server's
  // reconnect grace window, plus the bounded countdown that gives up on them.
  const reconnectingRef = React.useRef(new Set<string>());
  const holdTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // One-shot: re-assert our media state after OUR transport came back.
  const republishRef = React.useRef(false);

  const iceServers = React.useMemo(
    () => parseIceServers(process.env.NEXT_PUBLIC_RTC_ICE_SERVERS, DEFAULT_ICE_SERVERS),
    [],
  );

  // STUN alone cannot relay media, so a call across symmetric NAT/CGNAT
  // completes its handshake and then carries nothing. Say so once, in dev only.
  React.useEffect(() => {
    if (!DEV || turnWarned || hasTurnServer(iceServers)) return;
    turnWarned = true;
    // eslint-disable-next-line no-console
    console.warn('[rtc] TURN is not configured. Calls may fail across some networks.');
  }, [iceServers]);

  const publishState = React.useCallback(
    (s: Partial<{ mic: boolean; cam: boolean; screen: boolean; inCall: boolean }> = {}) => {
      socket.emit('rtc:state', {
        mic: s.mic ?? micRef.current,
        cam: s.cam ?? camRef.current,
        screen: s.screen ?? sharingRef.current,
        inCall: s.inCall ?? modeRef.current !== 'idle',
      });
    },
    [socket],
  );

  /* ---------------- local track plumbing ---------------- */

  /**
   * The video track we currently want to send: screen share wins over camera,
   * and a switched-off camera sends nothing at all (see the camera-off model).
   */
  const outboundVideoTrack = React.useCallback(() => {
    if (sharingRef.current) return screenTrackRef.current;
    return camRef.current ? cameraTrackRef.current : null;
  }, []);

  /** Point every peer's video sender at `track` (or at nothing, for `null`). */
  const setOutboundVideo = React.useCallback((track: MediaStreamTrack | null) => {
    peersRef.current.forEach((peer) => {
      if (peer.videoSender) {
        // Same-kind swap: no renegotiation, and null genuinely stops the flow.
        void peer.videoSender.replaceTrack(track).catch((err) => {
          peer.lastError = String((err as Error)?.message || err);
        });
      } else if (track) {
        // First video for this peer — this is the one path that adds an m-line.
        peer.videoSender = peer.pc.addTrack(track, localRef.current || new MediaStream([track]));
      }
    });
  }, []);

  /** Add (or replace) our current local tracks onto a peer — safe to call again. */
  const addLocalTracksTo = React.useCallback(
    (peer: Peer) => {
      const stream = localRef.current;
      if (!stream) return; // idle receiver: nothing to send yet
      const { pc } = peer;
      const audio = stream.getAudioTracks()[0];
      if (audio && !pc.getSenders().some((snd) => snd.track === audio)) pc.addTrack(audio, stream);

      const video = outboundVideoTrack();
      if (peer.videoSender) {
        if (peer.videoSender.track !== video) {
          void peer.videoSender.replaceTrack(video).catch((err) => {
            peer.lastError = String((err as Error)?.message || err);
          });
        }
      } else if (video) {
        peer.videoSender = pc.addTrack(video, stream); // triggers onnegotiationneeded
      }
    },
    [outboundVideoTrack],
  );

  /* ---------------- connection plumbing (perfect negotiation) ---------------- */

  const closePeer = React.useCallback((peerId: string) => {
    const peer = peersRef.current.get(peerId);
    if (peer) {
      if (peer.offerWatchdog) clearTimeout(peer.offerWatchdog);
      try {
        peer.pc.close();
      } catch {
        /* already closed */
      }
      peersRef.current.delete(peerId);
    }
    setRemoteStreams((prev) => prev.filter((p) => p.id !== peerId));
    setConnState((prev) => {
      if (!(peerId in prev)) return prev;
      const next = { ...prev };
      delete next[peerId];
      return next;
    });
    setIncoming((prev) => (prev?.from === peerId ? null : prev));
  }, []);

  /** Stop waiting for a dropped peer to come back. */
  const clearReconnectHold = React.useCallback(() => {
    if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
    holdTimerRef.current = null;
    reconnectingRef.current.clear();
    setAwaitingReconnect(false);
  }, []);

  /**
   * Tear down MY side of the call: close every peer, stop every local track
   * (including screen capture, which lives in its own stream), and reset all
   * call state to idle.
   *
   * `notify` controls whether we broadcast `rtc:hangup`. It must be FALSE when we
   * are reacting to someone else's hangup — otherwise the two clients bounce
   * hangups off each other.
   */
  const endLocalCall = React.useCallback(
    ({ notify }: { notify: boolean }) => {
      peersRef.current.forEach((peer) => {
        if (peer.offerWatchdog) clearTimeout(peer.offerWatchdog);
        try {
          peer.pc.close();
        } catch {
          /* already closed */
        }
      });
      peersRef.current.clear();
      clearReconnectHold();

      localRef.current?.getTracks().forEach((t) => t.stop());
      if (screenTrackRef.current) {
        screenTrackRef.current.onended = null;
        try {
          screenTrackRef.current.stop();
        } catch {
          /* noop */
        }
      }
      localRef.current = null;
      cameraTrackRef.current = null;
      screenTrackRef.current = null;

      setLocalStream(null);
      setScreenStream(null);
      setRemoteStreams([]);
      setConnState({});
      setIncoming(null);
      setDiagnostics([]);

      modeRef.current = 'idle';
      setMode('idle');
      micRef.current = false;
      setMicOn(false);
      camRef.current = false;
      setCamOn(false);
      sharingRef.current = false;
      setSharing(false);
      acquiringRef.current = false;
      setAcquiring(false);

      if (notify) socket.emit('rtc:hangup');
      publishState({ mic: false, cam: false, screen: false, inCall: false });
    },
    [socket, publishState, clearReconnectHold],
  );

  /**
   * Wait a bounded time for a dropped peer to reclaim their seat before giving
   * up. The server holds the seat for two minutes; holding the CALL forever
   * would leave a hot mic, and ending it instantly is what made a one-second
   * Wi-Fi handoff kill the call permanently.
   */
  const armReconnectHold = React.useCallback(() => {
    setAwaitingReconnect(true);
    if (holdTimerRef.current) return; // one countdown, however many peers dropped
    holdTimerRef.current = setTimeout(() => {
      holdTimerRef.current = null;
      reconnectingRef.current.clear();
      setAwaitingReconnect(false);
      // Someone may have reconnected (or another peer may still be live) — only
      // a genuinely empty call ends here.
      if (modeRef.current !== 'idle' && peersRef.current.size === 0) endLocalCall({ notify: false });
    }, RECONNECT_HOLD_MS);
  }, [endLocalCall]);

  /**
   * A peer hung up or left. Close just that connection; then, if that was the
   * last one and we are still in a call, end our own call too — without
   * re-broadcasting, so there is no hangup loop. A group call with peers still
   * connected carries on untouched.
   */
  const handleRemoteHangup = React.useCallback(
    (from: string) => {
      // `rtc:hangup` is broadcast room-wide, so it can arrive from someone we
      // were never connected to (two OTHER people ending their call). Only a
      // peer we actually had can end our call — otherwise a call we started and
      // are still waiting alone in would be killed by an unrelated hangup.
      const wasOurPeer = peersRef.current.has(from);
      closePeer(from);
      reconnectingRef.current.delete(from);
      if (reconnectingRef.current.size === 0) setAwaitingReconnect(false);
      if (
        wasOurPeer &&
        shouldEndCallAfterPeerClosed({ mode: modeRef.current, remainingPeerCount: peersRef.current.size })
      ) {
        endLocalCall({ notify: false });
      }
    },
    [closePeer, endLocalCall],
  );

  /* ---------------- signalling delivery ---------------- */

  /**
   * Relay one signal to a peer and actually care whether it arrived.
   *
   * Signalling used to be fire-and-forget, so a refused relay — rate-limited, or
   * a peer who dropped — was invisible: the offer vanished and the call sat on
   * "Connecting…" indefinitely. Now every send settles exactly once, ICE losses
   * stay silent (they are expendable and frequent), and a handshake signal is
   * re-sent a bounded number of times before the peer is given up on.
   */
  const sendSignal = React.useCallback(
    (to: string, data: SignalPayload, attempt = 1) => {
      let settled = false;
      // Per TYPE as well as per peer: a refused ICE burst must not make the next
      // offer look like a peer that has failed three times in a row.
      const failureKey = `${to}|${data.type}`;
      const finish = (res: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);

        const ack = normalizeAck(res, 'SIGNAL_FAILED');
        if (ack.ok) {
          signalFailuresRef.current.delete(failureKey);
          return;
        }

        const failures = (signalFailuresRef.current.get(failureKey) || 0) + 1;
        signalFailuresRef.current.set(failureKey, failures);
        const verdict = classifySignalFailure({ type: data.type, error: ack.error, consecutiveFailures: failures });
        if (verdict === 'ignore') return;

        if (verdict === 'retry') {
          const timer = setTimeout(() => {
            signalRetryTimersRef.current.delete(timer);
            // The peer may have gone while we waited; a retry then is pointless.
            if (!peersRef.current.has(to)) return;
            sendSignalRef.current?.(to, data, attempt + 1);
          }, signalRetryDelay(ack.retryAfterMs, attempt));
          signalRetryTimersRef.current.add(timer);
          return;
        }

        // Unreachable peer, or a handshake that will not go through. Tear that
        // one connection down predictably rather than leaving it half-open —
        // which also ends our call if it was the last peer.
        // eslint-disable-next-line no-console
        console.warn('[rtc] dropping peer after signal failures', to, ack.error);
        signalFailuresRef.current.delete(failureKey);
        handleRemoteHangup(to);
      };

      const timeout = setTimeout(() => finish(null), 8000);
      socket.emit('rtc:signal', { to, data }, finish);
    },
    [socket, handleRemoteHangup],
  );

  // Retries call back into the latest `sendSignal` without making it depend on
  // itself, which would rebuild it (and every peer callback) on each render.
  React.useEffect(() => {
    sendSignalRef.current = sendSignal;
    return () => {
      sendSignalRef.current = null;
    };
  }, [sendSignal]);

  // Every pending retry is cancelled when the hook goes away, so a timer can
  // never fire into a torn-down call.
  React.useEffect(() => {
    const timers = signalRetryTimersRef.current;
    return () => {
      timers.forEach(clearTimeout);
      timers.clear();
    };
  }, []);

  const ensurePeer = React.useCallback(
    (peerId: string): Peer => {
      const existing = peersRef.current.get(peerId);
      // A closed connection can never be revived — reusing one is what left a
      // reconnecting member with a dead RTCPeerConnection that blocked every
      // rebuild attempt. Discard it and start clean.
      if (existing && existing.pc.signalingState !== 'closed') return existing;
      if (existing) closePeer(peerId);

      const pc = new RTCPeerConnection({ iceServers });
      const peer: Peer = {
        pc,
        polite: isPolite(selfId, peerId),
        makingOffer: false,
        ignoreOffer: false,
        isSettingRemoteAnswerPending: false,
        pendingCandidates: [],
        videoSender: null,
        remoteStream: null,
        offerWatchdog: null,
        offerResends: 0,
        lastError: null,
      };

      /**
       * Re-send our offer if no answer comes back.
       *
       * The server acks `{ok:true}` for a relay it delivered to a socket that
       * had not yet attached its `rtc:signal` listener (a member admitted a
       * moment ago is still applying their snapshot), so a lost first offer was
       * indistinguishable from a delivered one and nothing ever retried it —
       * the caller sat on "Connecting…" and the callee was never even prompted.
       */
      const armOfferWatchdog = () => {
        if (peer.offerWatchdog) clearTimeout(peer.offerWatchdog);
        peer.offerWatchdog = setTimeout(() => {
          peer.offerWatchdog = null;
          if (pc.signalingState !== 'have-local-offer' || peer.offerResends >= OFFER_RESEND_LIMIT) return;
          peer.offerResends += 1;
          sendSignal(peerId, { type: 'offer', sdp: pc.localDescription ?? undefined });
          armOfferWatchdog();
        }, OFFER_RESEND_MS);
      };

      pc.onnegotiationneeded = async () => {
        try {
          peer.makingOffer = true;
          // Implicit-offer form: the browser picks offer vs rollback by state.
          await pc.setLocalDescription();
          sendSignal(peerId, { type: 'offer', sdp: pc.localDescription ?? undefined });
          armOfferWatchdog();
        } catch (err) {
          // A parallel remote offer may have moved us out of a stable state; the
          // perfect-negotiation handler will reconcile. Not fatal.
          peer.lastError = String((err as Error)?.message || err);
          // eslint-disable-next-line no-console
          console.warn('[rtc] negotiation failed', err);
        } finally {
          peer.makingOffer = false;
        }
      };

      pc.onicecandidate = ({ candidate }) => {
        if (candidate) sendSignal(peerId, { type: 'ice', candidate: candidate.toJSON() });
      };

      /**
       * Every received track lands in ONE stream we own, per peer.
       *
       * Using `event.streams[0]` and bailing when it was missing meant any track
       * delivered without an msid was silently discarded — an ICE-connected call
       * with no media at all, which the dock reported as "Connected". Owning the
       * stream also stops a second m-line (an audio→video upgrade) from
       * replacing the entry that was carrying the audio.
       */
      pc.ontrack = (event) => {
        if (!peer.remoteStream) peer.remoteStream = new MediaStream();
        const stream = peer.remoteStream;
        if (!stream.getTracks().some((t) => t.id === event.track.id)) stream.addTrack(event.track);
        setRemoteStreams((prev) => {
          const rest = prev.filter((p) => p.id !== peerId);
          const version = (prev.find((p) => p.id === peerId)?.version ?? 0) + 1;
          return [...rest, { id: peerId, stream, version }];
        });
      };

      pc.onconnectionstatechange = () => {
        setConnState((prev) => ({ ...prev, [peerId]: pc.connectionState }));
        if (pc.connectionState === 'connected') {
          // Self-correcting: whatever we were waiting for is demonstrably back,
          // so stop the give-up countdown rather than leaving the dock stuck on
          // "Reconnecting…" for the rest of the hold window.
          reconnectingRef.current.delete(peerId);
          if (reconnectingRef.current.size === 0) clearReconnectHold();
        }
        if (pc.connectionState === 'failed') {
          // Try an ICE restart before giving up — a NAT rebinding or a brief
          // network blip shouldn't kill an otherwise healthy call.
          try {
            pc.restartIce();
          } catch {
            /* not supported — the UI surfaces 'reconnecting/failed' */
          }
        }
        if (pc.connectionState === 'closed') {
          setRemoteStreams((prev) => prev.filter((p) => p.id !== peerId));
        }
      };

      addLocalTracksTo(peer);
      peersRef.current.set(peerId, peer);
      // Seed the status map: `onconnectionstatechange` only fires on a CHANGE,
      // and a fresh pc is already 'new' — so an in-flight handshake used to
      // render as "Waiting for someone to join…".
      setConnState((prev) => ({ ...prev, [peerId]: pc.connectionState }));
      return peer;
    },
    [iceServers, selfId, addLocalTracksTo, sendSignal, closePeer, clearReconnectHold],
  );

  /* ---------------- signalling ---------------- */

  React.useEffect(() => {
    if (!enabled) return;

    const flushCandidates = async (peer: Peer) => {
      // Atomic take: a candidate that arrives while we await below lands in the
      // (now empty) queue rather than being replayed or lost.
      const queued = drainCandidateQueue(peer.pendingCandidates);
      for (const candidate of queued) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
          if (!peer.ignoreOffer) {
            peer.lastError = String((err as Error)?.message || err);
            // eslint-disable-next-line no-console
            console.warn('[rtc] failed to add queued candidate', err);
          }
        }
      }
    };

    const onSignal = async ({ from, data }: { from: string; data: SignalPayload }) => {
      const peer = ensurePeer(from);
      const { pc } = peer;
      try {
        if (data.type === 'offer' || data.type === 'answer') {
          const description = data.sdp;
          if (!description) return;
          // Ready to accept an offer only when we're not mid-offer ourselves and
          // the connection is stable (or we're just finishing setting an answer).
          const readyForOffer =
            !peer.makingOffer && (pc.signalingState === 'stable' || peer.isSettingRemoteAnswerPending);
          const offerCollision = description.type === 'offer' && !readyForOffer;

          peer.ignoreOffer = !peer.polite && offerCollision;
          if (peer.ignoreOffer) return; // impolite: keep our own offer, drop theirs

          peer.isSettingRemoteAnswerPending = description.type === 'answer';
          await pc.setRemoteDescription(new RTCSessionDescription(description)); // polite side rolls back if needed
          peer.isSettingRemoteAnswerPending = false;
          // The handshake is moving: stop re-sending the offer.
          if (peer.offerWatchdog) clearTimeout(peer.offerWatchdog);
          peer.offerWatchdog = null;
          peer.offerResends = 0;

          // Now that a remote description exists, any queued ICE is applicable.
          await flushCandidates(peer);

          if (description.type === 'offer') {
            await pc.setLocalDescription();
            sendSignal(from, { type: 'answer', sdp: pc.localDescription ?? undefined });
          }
        } else if (data.type === 'ice' && data.candidate) {
          if (planCandidateDelivery({ hasRemoteDescription: Boolean(pc.remoteDescription?.type) }) === 'apply') {
            try {
              await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
            } catch (err) {
              // A candidate we deliberately ignored (impolite collision) can fail
              // harmlessly; anything else is worth surfacing for diagnosis.
              if (!peer.ignoreOffer) throw err;
            }
          } else {
            // No remote description yet — queue instead of dropping.
            peer.pendingCandidates.push(data.candidate);
          }
        }
      } catch (err) {
        peer.lastError = String((err as Error)?.message || err);
        // Swallow only the benign after-teardown case; keep real errors visible.
        if (pc.connectionState !== 'closed') {
          // eslint-disable-next-line no-console
          console.warn('[rtc] signal handling error', err);
        }
      }
    };

    const onCall = (payload: { from: string; name: string; mode: 'audio' | 'video' }) => {
      // Only prompt when we're free; if already in a call the connection is set
      // up by the membership effect instead.
      if (modeRef.current === 'idle' && payload.from !== selfId) setIncoming(payload);
    };

    const onHangup = ({ from }: { from: string }) => {
      if (from) handleRemoteHangup(from);
    };

    /**
     * A peer's transport went away. The server distinguishes a real departure
     * (`reason: 'left'`) from a dropped socket inside the reconnect grace
     * (`reason: 'transport'`) — treating them alike is what made a backgrounded
     * phone or a Wi-Fi handoff end the call for good, with nothing to restore
     * it. An older server sends no reason; 'left' keeps that behaviour.
     */
    const onPeerLeft = ({ id, reason }: { id: string; reason?: PeerDepartureReason }) => {
      if (!id) return;
      const wasOurPeer = peersRef.current.has(id);
      const plan = planPeerDeparture({
        reason: reason === 'transport' ? 'transport' : 'left',
        mode: modeRef.current,
        remainingPeerCount: Math.max(0, peersRef.current.size - (wasOurPeer ? 1 : 0)),
      });
      closePeer(id);
      if (!wasOurPeer) return;
      if (plan.awaitReconnect) {
        reconnectingRef.current.add(id);
        armReconnectHold();
        return;
      }
      reconnectingRef.current.delete(id);
      if (reconnectingRef.current.size === 0) setAwaitingReconnect(false);
      if (plan.endCall) endLocalCall({ notify: false });
    };

    /** They are back (fresh join or a reclaimed seat) — rebuild and re-offer. */
    const onPeerJoined = ({ id }: { id: string }) => {
      if (!id || id === selfId) return;
      reconnectingRef.current.delete(id);
      if (reconnectingRef.current.size === 0) clearReconnectHold();
      if (modeRef.current === 'idle') return;
      // Their old peer connection died with their old socket; a stale entry here
      // is exactly what blocked recovery, so drop it before rebuilding.
      closePeer(id);
      addLocalTracksTo(ensurePeer(id));
      socket.emit('rtc:call', { mode: modeRef.current === 'video' ? 'video' : 'audio' });
    };

    /**
     * OUR transport dropped. Every peer connection was built over it and is now
     * dead, and each peer has already been told so (`peer:left`). Close them
     * here too: keeping the corpses is what made the returning side answer a
     * fresh offer on a connection that could never complete a handshake, so the
     * other person stayed on "Connecting…" for good. The CALL is held — the
     * membership effect rebuilds once presence comes back.
     */
    const onSocketDisconnect = () => {
      if (modeRef.current === 'idle') return;
      republishRef.current = true;
      peersRef.current.forEach((_, id) => reconnectingRef.current.add(id));
      [...peersRef.current.keys()].forEach((id) => closePeer(id));
      armReconnectHold();
    };

    socket.on('rtc:signal', onSignal);
    socket.on('rtc:call', onCall);
    socket.on('rtc:hangup', onHangup);
    socket.on('peer:left', onPeerLeft);
    socket.on('peer:joined', onPeerJoined);
    socket.on('disconnect', onSocketDisconnect);

    return () => {
      socket.off('rtc:signal', onSignal);
      socket.off('rtc:call', onCall);
      socket.off('rtc:hangup', onHangup);
      socket.off('peer:left', onPeerLeft);
      socket.off('peer:joined', onPeerJoined);
      socket.off('disconnect', onSocketDisconnect);
    };
  }, [
    socket,
    enabled,
    selfId,
    ensurePeer,
    handleRemoteHangup,
    sendSignal,
    closePeer,
    endLocalCall,
    armReconnectHold,
    clearReconnectHold,
    addLocalTracksTo,
  ]);

  /* ---------------- starting / stopping ---------------- */

  const startMedia = React.useCallback(
    async (wanted: 'audio' | 'video'): Promise<boolean> => {
      // Never pretend: an origin without a secure context has no getUserMedia at
      // all, so the buttons must say why instead of failing opaquely on click.
      if (!support.canCall) {
        setError(support.callBlockedReason);
        return false;
      }
      // Belt-and-braces against a double-start: the UI disables the buttons while
      // requesting, but a keyboard/repeat click must not open two prompts or
      // acquire two streams (which would leak the first one's tracks).
      if (acquiringRef.current) return false;
      acquiringRef.current = true;
      setError(null);
      setAcquiring(true);
      let stream: MediaStream;
      let effectiveMode: 'audio' | 'video' = wanted;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: wanted === 'video' ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
        });
      } catch (err) {
        // Camera denied/unavailable but audio might still work — fall back so a
        // video call gracefully becomes an audio call instead of failing outright.
        if (wanted === 'video') {
          try {
            stream = await navigator.mediaDevices.getUserMedia({
              audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
              video: false,
            });
            effectiveMode = 'audio';
            setError('Camera unavailable — continuing with audio only.');
          } catch (err2) {
            acquiringRef.current = false;
            setAcquiring(false);
            setError(describeMediaError(err2, 'audio'));
            return false;
          }
        } else {
          acquiringRef.current = false;
          setAcquiring(false);
          setError(describeMediaError(err, 'audio'));
          return false;
        }
      }
      acquiringRef.current = false;
      setAcquiring(false);

      localRef.current = stream;
      setLocalStream(stream);
      cameraTrackRef.current = stream.getVideoTracks()[0] ?? null;

      modeRef.current = effectiveMode;
      setMode(effectiveMode);
      micRef.current = true;
      setMicOn(true);
      const cam = effectiveMode === 'video' && Boolean(cameraTrackRef.current);
      // Set BEFORE building peers: `outboundVideoTrack` reads this ref to decide
      // whether a new peer gets a video m-line at all.
      camRef.current = cam;
      setCamOn(cam);

      // Connect to (or upgrade) every other member. addLocalTracksTo triggers
      // onnegotiationneeded, which does the offer via perfect negotiation.
      memberIds
        .filter((id) => id !== selfId)
        .forEach((id) => addLocalTracksTo(ensurePeer(id)));

      publishState({ mic: true, cam, screen: sharingRef.current, inCall: true });
      return true;
    },
    [memberIds, selfId, ensurePeer, addLocalTracksTo, publishState, support],
  );

  const start = React.useCallback(
    async (wanted: 'audio' | 'video') => {
      const ok = await startMedia(wanted);
      if (ok) socket.emit('rtc:call', { mode: modeRef.current === 'video' ? 'video' : 'audio' });
    },
    [startMedia, socket],
  );

  const accept = React.useCallback(async () => {
    if (!incoming) return;
    const wanted = incoming.mode;
    setIncoming(null);
    // Peers already exist from the caller's offer; adding our tracks upgrades the
    // one-way connection to two-way via renegotiation.
    await startMedia(wanted);
  }, [incoming, startMedia]);

  /**
   * A real decline, not just hiding the prompt. Because we pre-negotiate on the
   * caller's offer (ensurePeer answers before Accept), the connection to the
   * caller already exists — declining must close it, drop their stream, discard
   * their queued candidates, and tell the caller to close their side. `rtc:hangup`
   * carries `{ from }`, and receivers close only that one peer, so a decline never
   * disturbs the caller's calls with anyone else.
   */
  const declineIncomingCall = React.useCallback(() => {
    const plan = planDecline({ from: incoming?.from, mode: modeRef.current });
    setIncoming(null);
    if (!plan.closePeerId) return;
    // Closes the pc, drops their remote stream + conn state, and discards the
    // queued ICE candidates along with the peer entry.
    closePeer(plan.closePeerId);
    if (plan.notifyCaller) socket.emit('rtc:hangup');
  }, [incoming, closePeer, socket]);

  /** The hangup button: end my call AND tell the room. */
  const hangUp = React.useCallback(() => endLocalCall({ notify: true }), [endLocalCall]);

  /* ---------------- active-call membership ---------------- */

  React.useEffect(() => {
    const others = memberIds.filter((id) => id !== selfId);
    // Drop peers for anyone no longer in the room, whether we're in a call or not.
    let closedAny = false;
    peersRef.current.forEach((_, id) => {
      if (!others.includes(id)) {
        // A member inside their reconnect grace also disappears from the
        // routable list. Their connection is dead either way, but only a real
        // departure may end the call — the hold timer owns that decision.
        if (!reconnectingRef.current.has(id)) closedAny = true;
        closePeer(id);
      }
    });
    // Backstop for the same rule as a remote hangup. Gated on actually having
    // closed a peer: a call started before anyone joined legitimately has zero
    // peers and must stay in its "waiting" state, not be torn down.
    if (
      closedAny &&
      shouldEndCallAfterPeerClosed({ mode: modeRef.current, remainingPeerCount: peersRef.current.size })
    ) {
      endLocalCall({ notify: false });
      return;
    }
    if (modeRef.current === 'idle') return;
    // Exactly once after our own transport came back: the server zeroes a
    // disconnected member's `media`, so without this the People panel shows
    // someone who is mid-call as "Watching". It must NOT run on every presence
    // event — presence is re-broadcast on each rtc:state, which would loop.
    if (republishRef.current) {
      republishRef.current = false;
      publishState();
    }
    // Someone new joined mid-call: connect + push our tracks + prompt them.
    others.forEach((id) => {
      if (!peersRef.current.has(id)) {
        addLocalTracksTo(ensurePeer(id));
        socket.emit('rtc:call', { mode: modeRef.current === 'video' ? 'video' : 'audio' });
      }
    });
  }, [memberIds, socket, selfId, ensurePeer, addLocalTracksTo, closePeer, endLocalCall, publishState]);

  // Leaving the room / room no longer ready: tear the call down locally.
  React.useEffect(() => {
    if (!enabled && modeRef.current !== 'idle') hangUp();
  }, [enabled, hangUp]);

  /* ---------------- toggles ---------------- */

  const toggleMic = React.useCallback(() => {
    const track = localRef.current?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    micRef.current = track.enabled;
    setMicOn(track.enabled);
    publishState({ mic: track.enabled });
  }, [publishState]);

  const toggleCam = React.useCallback(async () => {
    const stream = localRef.current;
    if (!stream) return;

    const existing = cameraTrackRef.current;
    if (existing && existing.readyState === 'live') {
      const on = !camRef.current;
      // `enabled` is for OUR preview (a disabled track renders black locally);
      // the sender swap is what the far side actually sees. Doing only the
      // former kept the encoder running, so "camera off" reached them as a live
      // black rectangle instead of an avatar.
      existing.enabled = on;
      camRef.current = on;
      setCamOn(on);
      // While sharing, the screen owns the video sender — the camera is restored
      // when the share stops (planScreenShareEnd).
      if (!sharingRef.current) setOutboundVideo(on ? existing : null);
      publishState({ cam: on });
      return;
    }

    // No camera track yet → upgrading an audio call to video.
    try {
      const camStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      const track = camStream.getVideoTracks()[0];
      cameraTrackRef.current = track;
      stream.addTrack(track);
      camRef.current = true;
      setCamOn(true);
      // If a screen share is active it owns the video sender; the camera will be
      // restored when sharing stops. Otherwise publish the camera now.
      if (!sharingRef.current) setOutboundVideo(track);
      modeRef.current = 'video';
      setMode('video');
      // A fresh MediaStream identity so the local preview re-attaches srcObject —
      // adding a track to an existing stream fires no event.
      setLocalStream(new MediaStream(stream.getTracks()));
      publishState({ cam: true });
    } catch (err) {
      setError(describeMediaError(err, 'video'));
    }
  }, [publishState, setOutboundVideo]);

  const stopScreenShare = React.useCallback(() => {
    const track = screenTrackRef.current;
    if (track) {
      track.onended = null;
      try {
        track.stop();
      } catch {
        /* noop */
      }
    }
    screenTrackRef.current = null;
    sharingRef.current = false;
    setSharing(false);
    setScreenStream(null);
    // Restore the camera only if it is genuinely on and live; otherwise send
    // nothing, which mutes their receiver so their tile shows the avatar rather
    // than the last frozen frame of our screen.
    const camera = cameraTrackRef.current;
    const { restoreCamera } = planScreenShareEnd({
      cameraOn: camRef.current,
      cameraTrackLive: Boolean(camera && camera.readyState === 'live'),
    });
    setOutboundVideo(restoreCamera ? camera : null);
    publishState({ screen: false });
  }, [publishState, setOutboundVideo]);

  const toggleScreenShare = React.useCallback(async () => {
    if (sharingRef.current) {
      stopScreenShare();
      return;
    }
    // Most mobile browsers have no getDisplayMedia at all. Say so instead of
    // lighting the button and silently sharing nothing.
    if (!support.canShareScreen) {
      setError(support.screenBlockedReason);
      return;
    }
    let display: MediaStream;
    try {
      display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    } catch (err) {
      // Covers both a dismissed picker and a blocked one — the browser reports
      // the same error for each, so the copy has to work for both. State is
      // untouched, so the button never shows an active share that isn't.
      setError(describeMediaError(err, 'screen'));
      return;
    }
    const track = display.getVideoTracks()[0];
    if (!track) {
      setError(describeMediaError({ name: 'NotFoundError' }, 'screen'));
      return;
    }
    setError(null);
    screenTrackRef.current = track;
    sharingRef.current = true;
    setSharing(true);
    // Our own proof that the share is live: without this the sharer kept seeing
    // their camera and had no way to notice the share was going nowhere.
    setScreenStream(display);
    // Replace the camera on the existing video sender, or add a new sender in an
    // audio-only call (which renegotiates).
    setOutboundVideo(track);
    // The browser's own "Stop sharing" button ends the track.
    track.onended = () => stopScreenShare();
    publishState({ screen: true });
  }, [stopScreenShare, publishState, setOutboundVideo, support]);

  /* ---------------- link quality ---------------- */

  React.useEffect(() => {
    if (mode === 'idle') return;
    const id = setInterval(async () => {
      // Prefer a connected peer for the readout.
      const peer =
        [...peersRef.current.values()].find((p) => p.pc.connectionState === 'connected') ||
        peersRef.current.values().next().value;
      const pc = peer?.pc;
      if (!pc) return;
      try {
        const report = await pc.getStats();
        let rtt = 0;
        let loss = 0;
        report.forEach((entry) => {
          if (entry.type === 'candidate-pair' && entry.state === 'succeeded' && entry.currentRoundTripTime) {
            rtt = Math.round(entry.currentRoundTripTime * 1000);
          }
          if (entry.type === 'inbound-rtp' && entry.packetsLost != null && entry.packetsReceived) {
            loss = entry.packetsLost / Math.max(1, entry.packetsLost + entry.packetsReceived);
          }
        });
        setStats({ rtt, loss });
      } catch {
        /* stats are best-effort */
      }
    }, 3000);
    return () => clearInterval(id);
  }, [mode]);

  /* ---------------- dev-only diagnostics ---------------- */

  // Polled rather than event-driven: signalingState and iceConnectionState have
  // no single "anything changed" event, and this whole block is compiled out of
  // a production build (DEV is a literal there).
  React.useEffect(() => {
    if (!DEV || mode === 'idle') return;
    const sample = () => {
      setDiagnostics(
        [...peersRef.current.entries()].map(([id, peer]) => ({
          id,
          polite: peer.polite,
          signalingState: peer.pc.signalingState,
          iceConnectionState: peer.pc.iceConnectionState,
          connectionState: peer.pc.connectionState,
          sendTracks: peer.pc.getSenders().filter((s) => s.track).length,
          recvTracks: peer.pc.getReceivers().filter((r) => r.track).length,
          lastError: peer.lastError,
        })),
      );
    };
    sample();
    const id = setInterval(sample, 2000);
    return () => clearInterval(id);
  }, [mode]);

  /* ---------------- unmount cleanup ---------------- */

  React.useEffect(() => {
    const peers = peersRef.current;
    return () => {
      peers.forEach((peer) => {
        if (peer.offerWatchdog) clearTimeout(peer.offerWatchdog);
        try {
          peer.pc.close();
        } catch {
          /* noop */
        }
      });
      peers.clear();
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
      localRef.current?.getTracks().forEach((t) => t.stop());
      if (screenTrackRef.current) {
        try {
          screenTrackRef.current.stop();
        } catch {
          /* noop */
        }
      }
    };
  }, []);

  /* ---------------- derived status ---------------- */

  const status: CallStatus = React.useMemo(() => {
    // `acquiring` is checked FIRST: while the browser permission prompt is open
    // the mode is still 'idle', so testing mode first made 'requesting'
    // unreachable and left the Voice/Video buttons live for double-clicks.
    if (acquiring) return 'requesting';
    if (mode === 'idle') return 'idle';
    // Checked before the member list: a dropped peer vanishes from the routable
    // ids, which would otherwise read as "waiting for someone to join".
    if (awaitingReconnect) return 'reconnecting';
    const others = memberIds.filter((id) => id !== selfId);
    if (others.length === 0) return 'waiting';
    const states = Object.values(connState);
    if (states.includes('connected')) return 'connected';
    if (states.includes('failed')) return 'failed';
    if (states.some((s) => s === 'disconnected')) return 'reconnecting';
    if (states.some((s) => s === 'connecting' || s === 'new')) return 'connecting';
    return 'waiting';
  }, [mode, acquiring, connState, memberIds, selfId, awaitingReconnect]);

  return {
    mode,
    status,
    micOn,
    camOn,
    sharing,
    localStream,
    screenStream,
    remoteStreams,
    incoming,
    stats,
    error,
    /** Null when calls are possible; the reason to show the user when not. */
    callBlockedReason: support.callBlockedReason,
    screenShareBlockedReason: support.screenBlockedReason,
    /** Empty in production — see the dev-only diagnostics effect. */
    diagnostics,
    start,
    accept,
    decline: declineIncomingCall,
    hangUp,
    toggleMic,
    toggleCam,
    toggleScreenShare,
  };
}
