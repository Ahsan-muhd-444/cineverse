'use client';

import * as React from 'react';
import type { Socket } from 'socket.io-client';

export type CallMode = 'idle' | 'audio' | 'video';

export interface PeerStream {
  id: string;
  stream: MediaStream;
}

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' },
];

interface SignalPayload {
  type: 'offer' | 'answer' | 'ice';
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
}

/**
 * Peer-to-peer voice, video and screen share.
 *
 * Media never touches the server — only the handshake does. Whoever has the
 * lexicographically smaller socket id makes the offer, which is a cheap way to
 * stop both sides calling each other at the same instant (glare).
 */
export function useWebRTC(socket: Socket, memberIds: string[], enabled: boolean) {
  const [mode, setMode] = React.useState<CallMode>('idle');
  const [micOn, setMicOn] = React.useState(false);
  const [camOn, setCamOn] = React.useState(false);
  const [sharing, setSharing] = React.useState(false);
  const [remoteStreams, setRemoteStreams] = React.useState<PeerStream[]>([]);
  const [localStream, setLocalStream] = React.useState<MediaStream | null>(null);
  const [incoming, setIncoming] = React.useState<{ from: string; name: string; mode: 'audio' | 'video' } | null>(null);
  const [stats, setStats] = React.useState<{ rtt: number; loss: number }>({ rtt: 0, loss: 0 });
  const [error, setError] = React.useState<string | null>(null);

  const peers = React.useRef(new Map<string, RTCPeerConnection>());
  const localRef = React.useRef<MediaStream | null>(null);
  const cameraTrack = React.useRef<MediaStreamTrack | null>(null);
  const modeRef = React.useRef<CallMode>('idle');

  const publishState = React.useCallback(
    (next: Partial<{ mic: boolean; cam: boolean; screen: boolean; inCall: boolean }>) => {
      socket.emit('rtc:state', {
        mic: next.mic ?? micOn,
        cam: next.cam ?? camOn,
        screen: next.screen ?? sharing,
        inCall: next.inCall ?? modeRef.current !== 'idle',
      });
    },
    [socket, micOn, camOn, sharing],
  );

  /* ---------------- connection plumbing ---------------- */

  const ensurePeer = React.useCallback(
    (peerId: string) => {
      const existing = peers.current.get(peerId);
      if (existing) return existing;

      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit('rtc:signal', { to: peerId, data: { type: 'ice', candidate: event.candidate.toJSON() } });
        }
      };

      pc.ontrack = (event) => {
        const [stream] = event.streams;
        if (!stream) return;
        setRemoteStreams((prev) => {
          const without = prev.filter((p) => p.id !== peerId);
          return [...without, { id: peerId, stream }];
        });
      };

      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
          setRemoteStreams((prev) => prev.filter((p) => p.id !== peerId));
        }
      };

      localRef.current?.getTracks().forEach((track) => {
        pc.addTrack(track, localRef.current as MediaStream);
      });

      peers.current.set(peerId, pc);
      return pc;
    },
    [socket],
  );

  const negotiate = React.useCallback(
    async (peerId: string) => {
      const pc = ensurePeer(peerId);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('rtc:signal', { to: peerId, data: { type: 'offer', sdp: offer } });
    },
    [ensurePeer, socket],
  );

  React.useEffect(() => {
    if (!enabled) return;

    const onSignal = async ({ from, data }: { from: string; data: SignalPayload }) => {
      const pc = ensurePeer(from);
      try {
        if (data.type === 'offer' && data.sdp) {
          await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit('rtc:signal', { to: from, data: { type: 'answer', sdp: answer } });
        } else if (data.type === 'answer' && data.sdp) {
          await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        } else if (data.type === 'ice' && data.candidate) {
          await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        }
      } catch {
        /* a late candidate after teardown is normal and harmless */
      }
    };

    const onCall = (payload: { from: string; name: string; mode: 'audio' | 'video' }) => {
      if (modeRef.current === 'idle') setIncoming(payload);
    };

    const onHangup = ({ from }: { from: string }) => {
      peers.current.get(from)?.close();
      peers.current.delete(from);
      setRemoteStreams((prev) => prev.filter((p) => p.id !== from));
      setIncoming((prev) => (prev?.from === from ? null : prev));
    };

    const onPeerLeft = ({ id }: { id: string }) => onHangup({ from: id });

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
  }, [socket, enabled, ensurePeer]);

  /* ---------------- starting and stopping ---------------- */

  const start = React.useCallback(
    async (wanted: 'audio' | 'video') => {
      setError(null);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: wanted === 'video' ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
        });

        localRef.current = stream;
        setLocalStream(stream);
        cameraTrack.current = stream.getVideoTracks()[0] ?? null;
        setMode(wanted);
        modeRef.current = wanted;
        setMicOn(true);
        setCamOn(wanted === 'video');

        // Attach to any peer we already have, then offer to everyone else.
        memberIds
          .filter((id) => id !== socket.id)
          .forEach((id) => {
            const pc = ensurePeer(id);
            stream.getTracks().forEach((track) => {
              const sender = pc.getSenders().find((s) => s.track?.kind === track.kind);
              if (sender) void sender.replaceTrack(track);
              else pc.addTrack(track, stream);
            });
            if ((socket.id || '') < id) void negotiate(id);
          });

        socket.emit('rtc:call', { mode: wanted });
        publishState({ mic: true, cam: wanted === 'video', inCall: true });
      } catch {
        setError(
          wanted === 'video'
            ? 'Camera or microphone unavailable. Check your browser permissions.'
            : 'Microphone unavailable. Check your browser permissions.',
        );
      }
    },
    [memberIds, socket, ensurePeer, negotiate, publishState],
  );

  const accept = React.useCallback(async () => {
    if (!incoming) return;
    const wanted = incoming.mode;
    setIncoming(null);
    await start(wanted);
  }, [incoming, start]);

  const hangUp = React.useCallback(() => {
    peers.current.forEach((pc) => pc.close());
    peers.current.clear();
    localRef.current?.getTracks().forEach((t) => t.stop());
    localRef.current = null;
    cameraTrack.current = null;
    setLocalStream(null);
    setRemoteStreams([]);
    setMode('idle');
    modeRef.current = 'idle';
    setMicOn(false);
    setCamOn(false);
    setSharing(false);
    socket.emit('rtc:hangup');
    publishState({ mic: false, cam: false, screen: false, inCall: false });
  }, [socket, publishState]);

  /* ---------------- toggles ---------------- */

  const toggleMic = React.useCallback(() => {
    const track = localRef.current?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setMicOn(track.enabled);
    publishState({ mic: track.enabled });
  }, [publishState]);

  const toggleCam = React.useCallback(async () => {
    const stream = localRef.current;
    if (!stream) return;

    const existing = stream.getVideoTracks()[0];
    if (existing) {
      existing.enabled = !existing.enabled;
      setCamOn(existing.enabled);
      publishState({ cam: existing.enabled });
      return;
    }

    // Upgrading an audio call to video: pull a camera track and renegotiate.
    try {
      const camStream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 } } });
      const track = camStream.getVideoTracks()[0];
      cameraTrack.current = track;
      stream.addTrack(track);
      peers.current.forEach((pc, id) => {
        pc.addTrack(track, stream);
        void negotiate(id);
      });
      setCamOn(true);
      setMode('video');
      modeRef.current = 'video';
      publishState({ cam: true });
    } catch {
      setError('Camera unavailable.');
    }
  }, [negotiate, publishState]);

  const toggleScreenShare = React.useCallback(async () => {
    if (sharing) {
      const camera = cameraTrack.current;
      peers.current.forEach((pc) => {
        const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
        if (sender && camera) void sender.replaceTrack(camera);
      });
      setSharing(false);
      publishState({ screen: false });
      return;
    }

    try {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const track = display.getVideoTracks()[0];
      peers.current.forEach((pc) => {
        const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
        if (sender) void sender.replaceTrack(track);
        else pc.addTrack(track, display);
      });
      track.onended = () => {
        const camera = cameraTrack.current;
        peers.current.forEach((pc) => {
          const sender = pc.getSenders().find((s) => s.track?.kind === 'video');
          if (sender && camera) void sender.replaceTrack(camera);
        });
        setSharing(false);
        publishState({ screen: false });
      };
      setSharing(true);
      publishState({ screen: true });
    } catch {
      /* the user dismissed the picker */
    }
  }, [sharing, publishState]);

  /* ---------------- link quality ---------------- */

  React.useEffect(() => {
    if (mode === 'idle') return;
    const id = setInterval(async () => {
      const pc = peers.current.values().next().value as RTCPeerConnection | undefined;
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

  /* ---------------- cleanup ---------------- */

  React.useEffect(
    () => () => {
      peers.current.forEach((pc) => pc.close());
      peers.current.clear();
      localRef.current?.getTracks().forEach((t) => t.stop());
    },
    [],
  );

  return {
    mode,
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
    decline: () => setIncoming(null),
    hangUp,
    toggleMic,
    toggleCam,
    toggleScreenShare,
  };
}
