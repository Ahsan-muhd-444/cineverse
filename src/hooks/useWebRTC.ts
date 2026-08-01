'use client';

import * as React from 'react';
import type { Socket } from 'socket.io-client';
import {
  classifySignalFailure,
  DEFAULT_ICE_SERVERS,
  describeMediaError,
  isPolite,
  parseIceServers,
  planDecline,
  shouldEndCallAfterPeerClosed,
  signalRetryDelay,
} from '@/lib/rtc';
import { normalizeAck } from '@/lib/acks';

export type CallMode = 'idle' | 'audio' | 'video';
/** Coarse, user-facing status for the dock — never the raw RTC enum. */
export type CallStatus = 'idle' | 'requesting' | 'waiting' | 'connecting' | 'connected' | 'reconnecting' | 'failed';

export interface PeerStream {
  id: string;
  stream: MediaStream;
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
}

/**
 * Peer-to-peer voice, video and screen share.
 *
 * Media never touches the server — only the SDP/ICE handshake is relayed. The
 * connection model is the standard "perfect negotiation" pattern:
 *
 *  - a deterministic polite/impolite role per pair (from socket-id order) makes
 *    simultaneous offers (glare) resolve without a coin-flip: the impolite side
 *    ignores a colliding offer, the polite side rolls back and accepts it;
 *  - `onnegotiationneeded` drives every (re)negotiation, so adding a camera,
 *    upgrading audio→video, or sharing a screen all renegotiate the same way;
 *  - ICE candidates that arrive before the remote description are QUEUED and
 *    flushed once it is set, never dropped.
 *
 * Camera-off model: we keep the sender and just disable the track (no
 * renegotiation) — symmetric with mute, and the receiver's track goes `muted`.
 */
export function useWebRTC(socket: Socket, memberIds: string[], enabled: boolean, selfId: string) {
  const [mode, setMode] = React.useState<CallMode>('idle');
  const [micOn, setMicOn] = React.useState(false);
  const [camOn, setCamOn] = React.useState(false);
  const [sharing, setSharing] = React.useState(false);
  const [remoteStreams, setRemoteStreams] = React.useState<PeerStream[]>([]);
  const [localStream, setLocalStream] = React.useState<MediaStream | null>(null);
  const [incoming, setIncoming] = React.useState<{ from: string; name: string; mode: 'audio' | 'video' } | null>(null);
  const [stats, setStats] = React.useState<{ rtt: number; loss: number }>({ rtt: 0, loss: 0 });
  const [error, setError] = React.useState<string | null>(null);
  const [acquiring, setAcquiring] = React.useState(false);
  const [connState, setConnState] = React.useState<Record<string, RTCPeerConnectionState>>({});

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
  // Consecutive refused relays per peer, and the retry timers they scheduled.
  const signalFailuresRef = React.useRef(new Map<string, number>());
  const signalRetryTimersRef = React.useRef(new Set<ReturnType<typeof setTimeout>>());
  const sendSignalRef = React.useRef<((to: string, data: SignalPayload, attempt?: number) => void) | null>(null);

  const iceServers = React.useMemo(
    () => parseIceServers(process.env.NEXT_PUBLIC_RTC_ICE_SERVERS, DEFAULT_ICE_SERVERS),
    [],
  );

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

  /** The video track we currently want to send: screen share wins over camera. */
  const outboundVideoTrack = React.useCallback(
    () => (sharingRef.current ? screenTrackRef.current : cameraTrackRef.current),
    [],
  );

  /** Add (or replace) our current local tracks onto a peer — safe to call again. */
  const addLocalTracksTo = React.useCallback(
    (peer: Peer) => {
      const stream = localRef.current;
      if (!stream) return; // idle receiver: nothing to send yet
      const { pc } = peer;
      const audio = stream.getAudioTracks()[0];
      if (audio && !pc.getSenders().some((snd) => snd.track === audio)) pc.addTrack(audio, stream);

      const video = outboundVideoTrack();
      if (video) {
        const vSender = pc.getSenders().find((snd) => snd.track?.kind === 'video');
        if (vSender) {
          if (vSender.track !== video) void vSender.replaceTrack(video);
        } else {
          pc.addTrack(video, stream); // triggers onnegotiationneeded
        }
      }
    },
    [outboundVideoTrack],
  );

  /* ---------------- connection plumbing (perfect negotiation) ---------------- */

  const closePeer = React.useCallback((peerId: string) => {
    const peer = peersRef.current.get(peerId);
    if (peer) {
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
        try {
          peer.pc.close();
        } catch {
          /* already closed */
        }
      });
      peersRef.current.clear();

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
      setRemoteStreams([]);
      setConnState({});
      setIncoming(null);

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
    [socket, publishState],
  );

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
      const finish = (res: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);

        const ack = normalizeAck(res, 'SIGNAL_FAILED');
        if (ack.ok) {
          signalFailuresRef.current.delete(to);
          return;
        }

        const failures = (signalFailuresRef.current.get(to) || 0) + 1;
        signalFailuresRef.current.set(to, failures);
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
        signalFailuresRef.current.delete(to);
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
      if (existing) return existing;

      const pc = new RTCPeerConnection({ iceServers });
      const peer: Peer = {
        pc,
        polite: isPolite(selfId, peerId),
        makingOffer: false,
        ignoreOffer: false,
        isSettingRemoteAnswerPending: false,
        pendingCandidates: [],
      };

      pc.onnegotiationneeded = async () => {
        try {
          peer.makingOffer = true;
          // Implicit-offer form: the browser picks offer vs rollback by state.
          await pc.setLocalDescription();
          sendSignal(peerId, { type: 'offer', sdp: pc.localDescription ?? undefined });
        } catch (err) {
          // A parallel remote offer may have moved us out of a stable state; the
          // perfect-negotiation handler will reconcile. Not fatal.
          // eslint-disable-next-line no-console
          console.warn('[rtc] negotiation failed', err);
        } finally {
          peer.makingOffer = false;
        }
      };

      pc.onicecandidate = ({ candidate }) => {
        if (candidate) sendSignal(peerId, { type: 'ice', candidate: candidate.toJSON() });
      };

      pc.ontrack = ({ streams }) => {
        const stream = streams[0];
        if (!stream) return;
        setRemoteStreams((prev) => [...prev.filter((p) => p.id !== peerId), { id: peerId, stream }]);
      };

      pc.onconnectionstatechange = () => {
        setConnState((prev) => ({ ...prev, [peerId]: pc.connectionState }));
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
      return peer;
    },
    [iceServers, selfId, addLocalTracksTo, sendSignal],
  );

  /* ---------------- signalling ---------------- */

  React.useEffect(() => {
    if (!enabled) return;

    const flushCandidates = async (peer: Peer) => {
      const queued = peer.pendingCandidates;
      peer.pendingCandidates = [];
      for (const candidate of queued) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
          if (!peer.ignoreOffer) {
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

          // Now that a remote description exists, any queued ICE is applicable.
          await flushCandidates(peer);

          if (description.type === 'offer') {
            await pc.setLocalDescription();
            sendSignal(from, { type: 'answer', sdp: pc.localDescription ?? undefined });
          }
        } else if (data.type === 'ice' && data.candidate) {
          if (pc.remoteDescription && pc.remoteDescription.type) {
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

    // A peer hanging up, or leaving the room entirely, both mean "that peer is
    // gone" — and if it was the last one, our own call ends too.
    const onHangup = ({ from }: { from: string }) => {
      if (from) handleRemoteHangup(from);
    };
    const onPeerLeft = ({ id }: { id: string }) => {
      if (id) handleRemoteHangup(id);
    };

    socket.on('rtc:signal', onSignal);
    socket.on('rtc:call', onCall);
    socket.on('rtc:hangup', onHangup);
    socket.on('peer:left', onPeerLeft);

    return () => {
      socket.off('rtc:signal', onSignal);
      socket.off('rtc:call', onCall);
      socket.off('rtc:hangup', onHangup);
      socket.off('peer:left', onPeerLeft);
    };
  }, [socket, enabled, selfId, ensurePeer, handleRemoteHangup, sendSignal]);

  /* ---------------- starting / stopping ---------------- */

  const startMedia = React.useCallback(
    async (wanted: 'audio' | 'video'): Promise<boolean> => {
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
    [memberIds, socket, selfId, ensurePeer, addLocalTracksTo, publishState],
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
        closePeer(id);
        closedAny = true;
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
    // Someone new joined mid-call: connect + push our tracks + prompt them.
    others.forEach((id) => {
      if (!peersRef.current.has(id)) {
        addLocalTracksTo(ensurePeer(id));
        socket.emit('rtc:call', { mode: modeRef.current === 'video' ? 'video' : 'audio' });
      }
    });
  }, [memberIds, socket, selfId, ensurePeer, addLocalTracksTo, closePeer, endLocalCall]);

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
    // Camera-off model = disable the track, keep the sender (no renegotiation).
    if (existing && existing.readyState === 'live') {
      existing.enabled = !existing.enabled;
      camRef.current = existing.enabled;
      setCamOn(existing.enabled);
      publishState({ cam: existing.enabled });
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
      // If a screen share is active it owns the video sender; the camera will be
      // restored when sharing stops. Otherwise publish the camera now.
      if (!sharingRef.current) {
        peersRef.current.forEach((peer) => {
          const vSender = peer.pc.getSenders().find((snd) => snd.track?.kind === 'video');
          if (vSender) void vSender.replaceTrack(track);
          else peer.pc.addTrack(track, stream); // triggers renegotiation
        });
      }
      modeRef.current = 'video';
      setMode('video');
      camRef.current = true;
      setCamOn(true);
      publishState({ cam: true });
    } catch (err) {
      setError(describeMediaError(err, 'video'));
    }
  }, [publishState]);

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
    // Restore the camera if it's on, otherwise send nothing (replaceTrack(null))
    // — never leave the screen track attached.
    const camera =
      cameraTrackRef.current && cameraTrackRef.current.readyState === 'live' && camRef.current
        ? cameraTrackRef.current
        : null;
    peersRef.current.forEach((peer) => {
      const vSender = peer.pc.getSenders().find((snd) => snd.track?.kind === 'video');
      if (vSender) void vSender.replaceTrack(camera);
    });
    sharingRef.current = false;
    setSharing(false);
    publishState({ screen: false });
  }, [publishState]);

  const toggleScreenShare = React.useCallback(async () => {
    if (sharingRef.current) {
      stopScreenShare();
      return;
    }
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const track = display.getVideoTracks()[0];
      screenTrackRef.current = track;
      // Replace the camera on the existing video sender, or add a new sender in
      // an audio-only call (which renegotiates).
      peersRef.current.forEach((peer) => {
        const vSender = peer.pc.getSenders().find((snd) => snd.track?.kind === 'video');
        if (vSender) void vSender.replaceTrack(track);
        else peer.pc.addTrack(track, localRef.current || display);
      });
      // The browser's own "Stop sharing" button ends the track.
      track.onended = () => stopScreenShare();
      sharingRef.current = true;
      setSharing(true);
      publishState({ screen: true });
    } catch {
      /* the user dismissed the picker — not an error */
    }
  }, [stopScreenShare, publishState]);

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

  /* ---------------- unmount cleanup ---------------- */

  React.useEffect(
    () => () => {
      peersRef.current.forEach((peer) => {
        try {
          peer.pc.close();
        } catch {
          /* noop */
        }
      });
      peersRef.current.clear();
      localRef.current?.getTracks().forEach((t) => t.stop());
      if (screenTrackRef.current) {
        try {
          screenTrackRef.current.stop();
        } catch {
          /* noop */
        }
      }
    },
    [],
  );

  /* ---------------- derived status ---------------- */

  const status: CallStatus = React.useMemo(() => {
    // `acquiring` is checked FIRST: while the browser permission prompt is open
    // the mode is still 'idle', so testing mode first made 'requesting'
    // unreachable and left the Voice/Video buttons live for double-clicks.
    if (acquiring) return 'requesting';
    if (mode === 'idle') return 'idle';
    const others = memberIds.filter((id) => id !== selfId);
    if (others.length === 0) return 'waiting';
    const states = Object.values(connState);
    if (states.includes('connected')) return 'connected';
    if (states.includes('failed')) return 'failed';
    if (states.some((s) => s === 'disconnected')) return 'reconnecting';
    if (states.some((s) => s === 'connecting' || s === 'new')) return 'connecting';
    return 'waiting';
  }, [mode, acquiring, connState, memberIds, selfId]);

  return {
    mode,
    status,
    micOn,
    camOn,
    sharing,
    localStream,
    remoteStreams,
    incoming,
    stats,
    error,
    start,
    accept,
    decline: declineIncomingCall,
    hangUp,
    toggleMic,
    toggleCam,
    toggleScreenShare,
  };
}
