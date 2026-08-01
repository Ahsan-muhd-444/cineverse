'use client';

import * as React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Mic,
  MicOff,
  MonitorUp,
  Phone,
  PhoneOff,
  Video,
  VideoOff,
  Wifi,
} from 'lucide-react';
import type { useWebRTC } from '@/hooks/useWebRTC';
import { Avatar, Tooltip } from '@/components/ui/Bits';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';

type Call = ReturnType<typeof useWebRTC>;

function StreamTile({
  stream,
  version,
  label,
  mirrored,
  color,
}: {
  stream: MediaStream;
  /**
   * Changes whenever a track is added to this (reused) MediaStream object. A
   * programmatic `addTrack` fires no event, so without it an audio→video
   * upgrade never re-attached `srcObject` and rendered as a black rectangle.
   */
  version?: number;
  label: string;
  mirrored?: boolean;
  color?: string;
}) {
  const ref = React.useRef<HTMLVideoElement>(null);
  // A live, enabled, UNMUTED video track means real picture. For a remote peer,
  // `muted` flips true when they switch their camera off (the sender's track is
  // replaced with null), so the tile falls back to the avatar instead of showing
  // a frozen or black frame.
  const hasPicture = (s: MediaStream) => s.getVideoTracks().some((t) => t.enabled && !t.muted && t.readyState === 'live');
  const [hasVideo, setHasVideo] = React.useState(() => hasPicture(stream));

  React.useEffect(() => {
    const el = ref.current;
    if (el) {
      if (el.srcObject !== stream) el.srcObject = stream;
      // `autoPlay` alone is a promise nobody awaited: a refusal left a paused,
      // blank element while every other signal still said "connected". These
      // tiles are muted, so a rejection here is transient rather than a policy
      // block — retry silently on the next tick of the poll below.
      void el.play().catch(() => undefined);
    }
    const check = () => setHasVideo(hasPicture(stream));
    check();
    const id = setInterval(check, 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream, version]);

  return (
    <div className="relative aspect-video overflow-hidden rounded-2xl border border-white/12 bg-ink-850">
      {/* Every tile is muted: remote audio is carried by the always-mounted
          <CallAudio> sinks, so nothing is ever heard twice — and the voice
          survives collapsing this panel. */}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        ref={ref}
        autoPlay
        playsInline
        muted
        className={cn('h-full w-full object-cover', !hasVideo && 'opacity-0', mirrored && 'scale-x-[-1]')}
      />
      {!hasVideo && (
        <div className="absolute inset-0 grid place-items-center">
          <Avatar name={label} color={color} size={40} speaking />
        </div>
      )}
      <span className="absolute bottom-1.5 left-1.5 rounded-lg bg-black/60 px-1.5 py-0.5 text-[0.6875rem] text-white backdrop-blur-sm">
        {label}
      </span>
    </div>
  );
}

export function CallDock({
  call,
  myName,
  myColor,
  peerNames,
}: {
  call: Call;
  myName: string;
  myColor?: string;
  peerNames: Record<string, { name: string; color: string }>;
}) {
  const active = call.mode !== 'idle';
  const quality =
    call.stats.rtt === 0 ? 'measuring' : call.stats.rtt < 90 ? 'excellent' : call.stats.rtt < 220 ? 'good' : 'weak';

  // Plain-language call state, so a slow connect never reads as "frozen".
  const STATUS_COPY: Record<typeof call.status, { text: string; tone: 'info' | 'good' | 'warn' } | null> = {
    idle: null,
    requesting: { text: 'Asking for mic/camera…', tone: 'info' },
    waiting: { text: 'Waiting for someone to join…', tone: 'info' },
    connecting: { text: 'Connecting…', tone: 'info' },
    connected: { text: 'Connected', tone: 'good' },
    reconnecting: { text: 'Reconnecting…', tone: 'warn' },
    failed: { text: 'Connection failed — check your network (a TURN server may be needed).', tone: 'warn' },
  };
  const statusInfo = STATUS_COPY[call.status];
  const waitingForMedia = active && call.status === 'connected' && call.remoteStreams.length === 0;
  // The permission prompt is open: mode is still 'idle', so this state must be
  // surfaced outside the `active` block or the dock looks frozen.
  const requesting = call.status === 'requesting';
  // No secure context (or no getUserMedia at all) — the buttons must say so
  // rather than render as live and fail opaquely on click.
  const callBlocked = call.callBlockedReason;
  const shareBlocked = call.screenShareBlockedReason;
  // Local camera + local screen + one per remote peer.
  const tileCount = (call.localStream ? 1 : 0) + (call.screenStream ? 1 : 0) + call.remoteStreams.length;

  return (
    <div className="flex flex-col gap-3">
      {/* ---------- incoming ---------- */}
      <AnimatePresence>
        {call.incoming && (
          <motion.div
            // Announced, not just drawn: a ringing call that only appears
            // visually is invisible to a screen-reader user until it stops.
            role="alert"
            initial={{ opacity: 0, y: -10, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8 }}
            // Stable neutral panel. The cyan wash and the pulsing ring around
            // the caller's avatar were doing the job of a status marker at ten
            // times the volume; one small live dot says the same thing.
            className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.05] p-3"
          >
            <span className="relative">
              <Avatar name={call.incoming.name} size={36} />
              <span aria-hidden className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-ink-950 bg-electric-400" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[0.8125rem] font-medium text-primary">{call.incoming.name}</p>
              <p className="text-[0.6875rem] text-muted">Incoming {call.incoming.mode} call</p>
            </div>
            <button
              onClick={call.decline}
              aria-label="Decline call"
              className="grid h-11 w-11 place-items-center rounded-xl bg-rose-500/20 text-rose-200 transition-colors hover:bg-rose-500/35"
            >
              <PhoneOff size={15} />
            </button>
            <button
              onClick={call.accept}
              aria-label="Accept call"
              className="grid h-11 w-11 place-items-center rounded-xl bg-emerald-500/25 text-emerald-100 transition-colors hover:bg-emerald-500/40"
            >
              <Phone size={15} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ---------- streams ---------- */}
      <AnimatePresence>
        {active && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            <div className={cn('grid gap-2', tileCount > 1 ? 'grid-cols-2' : 'grid-cols-1')}>
              {call.localStream && (
                <StreamTile stream={call.localStream} label={`${myName} (you)`} mirrored color={myColor} />
              )}
              {/* Proof the share is really running. Without it the sharer keeps
                  seeing their camera and has no way to notice it went nowhere.
                  Not mirrored — a mirrored screen is unreadable. */}
              {call.screenStream && <StreamTile stream={call.screenStream} label="Your screen" color={myColor} />}
              {call.remoteStreams.map((peer) => (
                <StreamTile
                  key={peer.id}
                  stream={peer.stream}
                  version={peer.version}
                  label={peerNames[peer.id]?.name || 'Guest'}
                  color={peerNames[peer.id]?.color}
                />
              ))}
            </div>

            {/* status line: what the call is doing right now */}
            <div className="mt-2 flex items-center gap-1.5 px-1 text-[0.6875rem]">
              {statusInfo && (
                <span
                  className={cn(
                    'inline-flex items-center gap-1.5',
                    statusInfo.tone === 'good' && 'text-emerald-300',
                    statusInfo.tone === 'warn' && 'text-amber-300',
                    statusInfo.tone === 'info' && 'text-supporting',
                  )}
                >
                  <span
                    className={cn(
                      'h-1.5 w-1.5 rounded-full',
                      statusInfo.tone === 'good' && 'bg-emerald-400',
                      statusInfo.tone === 'warn' && 'animate-pulse bg-amber-400',
                      statusInfo.tone === 'info' && 'animate-pulse bg-white/50',
                    )}
                  />
                  {waitingForMedia ? 'Connected — waiting for their video/audio…' : statusInfo.text}
                </span>
              )}
            </div>

            {call.status === 'connected' && (
              <div className="mt-1 flex items-center gap-1.5 px-1 text-[0.6875rem] text-muted">
                <Wifi size={10} />
                <span className="capitalize">{quality}</span>
                {call.stats.rtt > 0 && <span>· {call.stats.rtt} ms</span>}
                {call.stats.loss > 0.02 && <span>· {(call.stats.loss * 100).toFixed(0)}% loss</span>}
                <span className="ml-auto">Noise suppression on</span>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* ---------- controls ---------- */}
      <div className="flex items-center gap-1.5">
        {!active ? (
          <>
            {/* Disabled while the browser permission prompt is open, so a second
                click can't open a second prompt / acquire a second stream. */}
            <Button
              variant="glass"
              size="sm"
              className="!h-11 flex-1"
              disabled={requesting || Boolean(callBlocked)}
              title={callBlocked || undefined}
              onClick={() => call.start('audio')}
            >
              <Phone size={14} />
              Voice
            </Button>
            <Button
              variant="glass"
              size="sm"
              className="!h-11 flex-1"
              disabled={requesting || Boolean(callBlocked)}
              title={callBlocked || undefined}
              onClick={() => call.start('video')}
            >
              <Video size={14} />
              Video
            </Button>
          </>
        ) : (
          <>
            <Tooltip label={call.micOn ? 'Mute' : 'Unmute'}>
              <button
                onClick={call.toggleMic}
                aria-label={call.micOn ? 'Mute microphone' : 'Unmute microphone'}
                aria-pressed={!call.micOn}
                className={cn(
                  'grid h-11 w-11 place-items-center rounded-xl transition-colors',
                  call.micOn ? 'glass-soft text-white hover:bg-white/12' : 'bg-rose-500/25 text-rose-200',
                )}
              >
                {call.micOn ? <Mic size={16} /> : <MicOff size={16} />}
              </button>
            </Tooltip>

            <Tooltip label={call.camOn ? 'Turn camera off' : 'Turn camera on'}>
              <button
                onClick={call.toggleCam}
                aria-label={call.camOn ? 'Turn camera off' : 'Turn camera on'}
                aria-pressed={!call.camOn}
                className={cn(
                  'grid h-11 w-11 place-items-center rounded-xl transition-colors',
                  call.camOn ? 'glass-soft text-white hover:bg-white/12' : 'bg-white/[0.06] text-muted',
                )}
              >
                {call.camOn ? <Video size={16} /> : <VideoOff size={16} />}
              </button>
            </Tooltip>

            {/* Disabled — never "on" — where the browser has no getDisplayMedia
                (most mobile browsers). A lit button that shares nothing is the
                worst of both worlds. */}
            <Tooltip label={shareBlocked || (call.sharing ? 'Stop sharing' : 'Share your screen')}>
              <button
                onClick={call.toggleScreenShare}
                disabled={Boolean(shareBlocked)}
                aria-label={call.sharing ? 'Stop screen share' : 'Share screen'}
                aria-pressed={call.sharing}
                className={cn(
                  'grid h-11 w-11 place-items-center rounded-xl transition-colors',
                  shareBlocked
                    ? 'cursor-not-allowed bg-white/[0.04] text-muted opacity-60'
                    : call.sharing
                      ? 'bg-electric-500/25 text-electric-200'
                      : 'glass-soft text-white hover:bg-white/12',
                )}
              >
                <MonitorUp size={16} />
              </button>
            </Tooltip>

            <button
              onClick={call.hangUp}
              aria-label="End call"
              className="ml-auto grid h-11 w-11 place-items-center rounded-xl bg-rose-500/85 text-white transition-colors duration-[160ms] ease-swift hover:bg-rose-500"
            >
              <PhoneOff size={16} />
            </button>
          </>
        )}
      </div>

      {/* Shown before the call is active (mode is still 'idle' during the prompt). */}
      {requesting && !active && (
        <p className="flex items-center gap-1.5 px-1 text-[0.6875rem] text-supporting">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-white/50" />
          Asking for mic/camera…
        </p>
      )}

      {/* Why the buttons are dead, stated up front rather than on click. */}
      {callBlocked && !active && <p className="px-1 text-[0.6875rem] text-amber-300">{callBlocked}</p>}

      {call.error && <p className="px-1 text-[0.6875rem] text-rose-300">{call.error}</p>}

      {/* Dev-only per-peer diagnostics. `call.diagnostics` is always empty in a
          production build (the hook's sampler is compiled out), so this renders
          nothing there. */}
      {call.diagnostics.length > 0 && (
        <div className="rounded-xl border border-white/10 bg-black/30 px-2 py-1.5 font-mono text-[0.625rem] leading-relaxed text-muted">
          {call.diagnostics.map((d) => (
            <div key={d.id} className="truncate">
              {d.id.slice(0, 8)} {d.polite ? 'polite' : 'impolite'} · sig={d.signalingState} · ice=
              {d.iceConnectionState} · conn={d.connectionState} · tx={d.sendTracks} rx={d.recvTracks}
              {d.lastError ? ` · err=${d.lastError}` : ''}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
