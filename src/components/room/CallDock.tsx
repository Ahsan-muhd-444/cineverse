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
  label,
  muted,
  mirrored,
  color,
}: {
  stream: MediaStream;
  label: string;
  muted?: boolean;
  mirrored?: boolean;
  color?: string;
}) {
  const ref = React.useRef<HTMLVideoElement>(null);
  const [hasVideo, setHasVideo] = React.useState(stream.getVideoTracks().some((t) => t.enabled));

  React.useEffect(() => {
    if (ref.current) ref.current.srcObject = stream;
    const check = () => setHasVideo(stream.getVideoTracks().some((t) => t.enabled && t.readyState === 'live'));
    check();
    const id = setInterval(check, 1200);
    return () => clearInterval(id);
  }, [stream]);

  return (
    <div className="relative aspect-video overflow-hidden rounded-2xl border border-white/12 bg-ink-850">
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        ref={ref}
        autoPlay
        playsInline
        muted={muted}
        className={cn('h-full w-full object-cover', !hasVideo && 'opacity-0', mirrored && 'scale-x-[-1]')}
      />
      {!hasVideo && (
        <div className="absolute inset-0 grid place-items-center">
          <Avatar name={label} color={color} size={40} speaking />
        </div>
      )}
      <span className="absolute bottom-1.5 left-1.5 rounded-lg bg-black/60 px-1.5 py-0.5 text-[0.625rem] text-white/85 backdrop-blur-sm">
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

  return (
    <div className="flex flex-col gap-3">
      {/* ---------- incoming ---------- */}
      <AnimatePresence>
        {call.incoming && (
          <motion.div
            initial={{ opacity: 0, y: -10, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8 }}
            className="flex items-center gap-3 rounded-2xl border border-electric-400/30 bg-electric-500/10 p-3"
          >
            <span className="relative">
              <Avatar name={call.incoming.name} size={36} />
              <span className="absolute inset-0 animate-pulse-ring rounded-full border-2 border-electric-400" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[0.8125rem] font-medium text-white">{call.incoming.name}</p>
              <p className="text-[0.6875rem] text-white/50">Incoming {call.incoming.mode} call</p>
            </div>
            <button
              onClick={call.decline}
              aria-label="Decline call"
              className="grid h-9 w-9 place-items-center rounded-xl bg-rose-500/20 text-rose-200 transition-colors hover:bg-rose-500/35"
            >
              <PhoneOff size={15} />
            </button>
            <button
              onClick={call.accept}
              aria-label="Accept call"
              className="grid h-9 w-9 place-items-center rounded-xl bg-emerald-500/25 text-emerald-100 transition-colors hover:bg-emerald-500/40"
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
            <div className={cn('grid gap-2', call.remoteStreams.length > 0 ? 'grid-cols-2' : 'grid-cols-1')}>
              {call.localStream && (
                <StreamTile stream={call.localStream} label={`${myName} (you)`} muted mirrored color={myColor} />
              )}
              {call.remoteStreams.map((peer) => (
                <StreamTile
                  key={peer.id}
                  stream={peer.stream}
                  label={peerNames[peer.id]?.name || 'Guest'}
                  color={peerNames[peer.id]?.color}
                />
              ))}
            </div>

            <div className="mt-2 flex items-center gap-1.5 px-1 text-[0.625rem] text-white/35">
              <Wifi size={10} />
              <span className="capitalize">{quality}</span>
              {call.stats.rtt > 0 && <span>· {call.stats.rtt} ms</span>}
              {call.stats.loss > 0.02 && <span>· {(call.stats.loss * 100).toFixed(0)}% loss</span>}
              <span className="ml-auto">Noise suppression on</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ---------- controls ---------- */}
      <div className="flex items-center gap-1.5">
        {!active ? (
          <>
            <Button variant="glass" size="sm" className="flex-1" onClick={() => call.start('audio')}>
              <Phone size={14} />
              Voice
            </Button>
            <Button variant="glass" size="sm" className="flex-1" onClick={() => call.start('video')}>
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
                  'grid h-10 w-10 place-items-center rounded-xl transition-colors',
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
                  'grid h-10 w-10 place-items-center rounded-xl transition-colors',
                  call.camOn ? 'glass-soft text-white hover:bg-white/12' : 'bg-white/[0.06] text-white/45',
                )}
              >
                {call.camOn ? <Video size={16} /> : <VideoOff size={16} />}
              </button>
            </Tooltip>

            <Tooltip label={call.sharing ? 'Stop sharing' : 'Share your screen'}>
              <button
                onClick={call.toggleScreenShare}
                aria-label={call.sharing ? 'Stop screen share' : 'Share screen'}
                aria-pressed={call.sharing}
                className={cn(
                  'grid h-10 w-10 place-items-center rounded-xl transition-colors',
                  call.sharing ? 'bg-electric-500/25 text-electric-200' : 'glass-soft text-white hover:bg-white/12',
                )}
              >
                <MonitorUp size={16} />
              </button>
            </Tooltip>

            <button
              onClick={call.hangUp}
              aria-label="End call"
              className="ml-auto grid h-10 w-10 place-items-center rounded-xl bg-rose-500/85 text-white transition-transform hover:scale-105"
            >
              <PhoneOff size={16} />
            </button>
          </>
        )}
      </div>

      {call.error && <p className="px-1 text-[0.6875rem] text-rose-300">{call.error}</p>}
    </div>
  );
}
