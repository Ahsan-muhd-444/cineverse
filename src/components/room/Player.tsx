'use client';

import * as React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Captions,
  Gauge,
  Loader2,
  Maximize2,
  Minimize2,
  Pause,
  PictureInPicture2,
  Play,
  RotateCcw,
  RotateCw,
  Settings2,
  SlidersHorizontal,
  Volume1,
  Volume2,
  VolumeX,
} from 'lucide-react';
import type { MediaSource } from '@/lib/types';
import type { PlayerHandle, SyncAction } from '@/hooks/useSyncedPlayback';
import { cn, formatTime, youTubeId } from '@/lib/utils';
import { Tooltip } from '@/components/ui/Bits';
import { YouTubeEngine } from './YouTubeEngine';

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];

export interface PlayerProps {
  source: MediaSource | null;
  localFile: File | null;
  handleRef: React.MutableRefObject<PlayerHandle | null>;
  onUserControl: (action: SyncAction, extra?: { time?: number; rate?: number }) => void;
  onReady?: () => void;
  onProgress?: (position: number, duration: number) => void;
  emptyState: React.ReactNode;
  overlay?: React.ReactNode;
  drift?: number;
}

/* ------------------------------------------------------------------ Seek bar */

function SeekBar({
  position,
  duration,
  buffered,
  onScrub,
  onCommit,
}: {
  position: number;
  duration: number;
  buffered: number;
  onScrub: (t: number) => void;
  onCommit: (t: number) => void;
}) {
  const trackRef = React.useRef<HTMLDivElement>(null);
  const [hover, setHover] = React.useState<number | null>(null);
  const [dragging, setDragging] = React.useState(false);

  const pct = duration > 0 ? (position / duration) * 100 : 0;
  const bufPct = duration > 0 ? (buffered / duration) * 100 : 0;

  const timeAt = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || !duration) return 0;
    return Math.min(duration, Math.max(0, ((clientX - rect.left) / rect.width) * duration));
  };

  React.useEffect(() => {
    if (!dragging) return;
    const move = (e: PointerEvent) => onScrub(timeAt(e.clientX));
    const up = (e: PointerEvent) => {
      setDragging(false);
      onCommit(timeAt(e.clientX));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging, duration]);

  return (
    <div
      className="group/seek relative -mx-1 cursor-pointer px-1 py-3"
      onPointerDown={(e) => {
        setDragging(true);
        onScrub(timeAt(e.clientX));
      }}
      onPointerMove={(e) => setHover(timeAt(e.clientX))}
      onPointerLeave={() => setHover(null)}
    >
      <div
        ref={trackRef}
        className="relative h-1 w-full overflow-visible rounded-full bg-white/15 transition-[height] duration-300 group-hover/seek:h-1.5"
      >
        <div className="absolute inset-y-0 left-0 rounded-full bg-white/20" style={{ width: `${bufPct}%` }} />
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-[linear-gradient(90deg,#7c3aed,#3b6cf6_55%,#22d3ee)] shadow-[0_0_14px_rgba(124,58,237,0.75)]"
          style={{ width: `${pct}%` }}
        />
        <div
          className={cn(
            'absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_2px_10px_rgba(0,0,0,0.6)] transition-transform duration-300',
            dragging ? 'scale-125' : 'scale-0 group-hover/seek:scale-100',
          )}
          style={{ left: `${pct}%` }}
        />
      </div>

      <AnimatePresence>
        {hover !== null && duration > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="pointer-events-none absolute bottom-full mb-1 -translate-x-1/2 rounded-lg bg-black/85 px-2 py-1 font-mono text-[0.6875rem] text-white backdrop-blur-md"
            style={{ left: `${(hover / duration) * 100}%` }}
          >
            {formatTime(hover)}
          </motion.div>
        )}
      </AnimatePresence>

      <input
        type="range"
        className="sr-range"
        min={0}
        max={Math.max(1, duration)}
        step={0.5}
        value={position}
        aria-label="Seek"
        onChange={(e) => onCommit(Number(e.target.value))}
      />
    </div>
  );
}

/* -------------------------------------------------------------------- Player */

export function Player({
  source,
  localFile,
  handleRef,
  onUserControl,
  onReady,
  onProgress,
  emptyState,
  overlay,
  drift = 0,
}: PlayerProps) {
  const shellRef = React.useRef<HTMLDivElement>(null);
  const videoRef = React.useRef<HTMLVideoElement>(null);

  const [playing, setPlaying] = React.useState(false);
  const [position, setPosition] = React.useState(0);
  const [duration, setDuration] = React.useState(0);
  const [buffered, setBuffered] = React.useState(0);
  const [volume, setVolume] = React.useState(1);
  const [muted, setMuted] = React.useState(false);
  const [rate, setRate] = React.useState(1);
  const [waiting, setWaiting] = React.useState(false);
  const [fullscreen, setFullscreen] = React.useState(false);
  const [captions, setCaptions] = React.useState(false);
  const [quality, setQuality] = React.useState('Auto');
  const [menu, setMenu] = React.useState<null | 'settings' | 'quality'>(null);
  const [controlsVisible, setControlsVisible] = React.useState(true);
  const [failed, setFailed] = React.useState<string | null>(null);
  const [scrubbing, setScrubbing] = React.useState<number | null>(null);

  const hideTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const isYouTube = source?.type === 'youtube';
  const ytId = isYouTube ? youTubeId(source!.value) : null;

  const objectUrl = React.useMemo(() => (localFile ? URL.createObjectURL(localFile) : null), [localFile]);
  React.useEffect(() => () => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }, [objectUrl]);

  const mediaUrl = source?.type === 'local' ? objectUrl : source?.value || null;

  /* ---------------- controls auto-hide ---------------- */

  const wake = React.useCallback(() => {
    setControlsVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      // Never hide while a menu is open or the film is paused.
      setControlsVisible((prev) => (menu || !playing ? prev : false));
    }, 2800);
  }, [menu, playing]);

  React.useEffect(() => {
    wake();
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [wake, playing, menu]);

  /* ---------------- HTML5 engine ---------------- */

  React.useEffect(() => {
    if (isYouTube) return;
    const video = videoRef.current;
    if (!video) return;

    handleRef.current = {
      getTime: () => video.currentTime,
      getDuration: () => video.duration || 0,
      isPaused: () => video.paused,
      play: () => video.play().catch(() => setFailed('Your browser blocked autoplay — press play once.')),
      pause: () => video.pause(),
      seek: (seconds) => {
        if (Number.isFinite(seconds)) video.currentTime = Math.max(0, seconds);
      },
      setRate: (r) => {
        video.playbackRate = r;
      },
      ready: () => video.readyState >= 2,
    };

    return () => {
      handleRef.current = null;
    };
  }, [isYouTube, handleRef, mediaUrl]);

  /* ---------------- progress polling (engine agnostic) ---------------- */

  React.useEffect(() => {
    const id = setInterval(() => {
      const handle = handleRef.current;
      if (!handle || !handle.ready()) return;
      const t = handle.getTime();
      const d = handle.getDuration();
      setPosition(t);
      setDuration(d);
      if (isYouTube) setPlaying(!handle.isPaused());
      onProgress?.(t, d);
    }, 250);
    return () => clearInterval(id);
  }, [handleRef, isYouTube, onProgress]);

  /* ---------------- fullscreen ---------------- */

  React.useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFullscreen = React.useCallback(async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await shellRef.current?.requestFullscreen();
    } catch {
      /* some browsers refuse without a direct gesture */
    }
  }, []);

  const togglePiP = React.useCallback(async () => {
    const video = videoRef.current;
    if (!video || isYouTube) return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await video.requestPictureInPicture();
    } catch {
      /* unsupported — the button is hidden in that case anyway */
    }
  }, [isYouTube]);

  /* ---------------- user actions ---------------- */

  const togglePlay = React.useCallback(() => {
    const handle = handleRef.current;
    if (!handle) return;
    if (handle.isPaused()) {
      void handle.play();
      onUserControl('play', { time: handle.getTime() });
    } else {
      handle.pause();
      onUserControl('pause', { time: handle.getTime() });
    }
    wake();
  }, [handleRef, onUserControl, wake]);

  /**
   * On a mouse, clicking the picture toggles playback — that is the expectation.
   * On a touch screen there is no hover, so the first tap has to bring the
   * controls back; only a tap while they are already showing toggles playback.
   */
  const tapSurface = React.useCallback(() => {
    const coarse = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
    if (coarse && !controlsVisible) {
      wake();
      return;
    }
    togglePlay();
  }, [controlsVisible, wake, togglePlay]);

  const seekBy = React.useCallback(
    (delta: number) => {
      const handle = handleRef.current;
      if (!handle) return;
      const next = Math.max(0, Math.min(handle.getDuration() || Infinity, handle.getTime() + delta));
      handle.seek(next);
      onUserControl('seek', { time: next });
      wake();
    },
    [handleRef, onUserControl, wake],
  );

  const seekTo = React.useCallback(
    (t: number) => {
      const handle = handleRef.current;
      if (!handle) return;
      handle.seek(t);
      setPosition(t);
      onUserControl('seek', { time: t });
      wake();
    },
    [handleRef, onUserControl, wake],
  );

  const changeRate = React.useCallback(
    (r: number) => {
      handleRef.current?.setRate(r);
      setRate(r);
      onUserControl('rate', { rate: r, time: handleRef.current?.getTime() });
    },
    [handleRef, onUserControl],
  );

  /* ---------------- keyboard ---------------- */

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;

      switch (e.key.toLowerCase()) {
        case ' ':
        case 'k':
          e.preventDefault();
          togglePlay();
          break;
        case 'arrowleft':
          e.preventDefault();
          seekBy(-5);
          break;
        case 'arrowright':
          e.preventDefault();
          seekBy(5);
          break;
        case 'j':
          seekBy(-10);
          break;
        case 'l':
          seekBy(10);
          break;
        case 'arrowup':
          e.preventDefault();
          setVolume((v) => Math.min(1, v + 0.1));
          break;
        case 'arrowdown':
          e.preventDefault();
          setVolume((v) => Math.max(0, v - 0.1));
          break;
        case 'm':
          setMuted((m) => !m);
          break;
        case 'f':
          void toggleFullscreen();
          break;
        case 'p':
          void togglePiP();
          break;
        case 'c':
          setCaptions((c) => !c);
          break;
        default:
          return;
      }
      wake();
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, seekBy, toggleFullscreen, togglePiP, wake]);

  /* ---------------- volume plumbing ---------------- */

  React.useEffect(() => {
    const video = videoRef.current;
    if (video) {
      video.volume = volume;
      video.muted = muted;
    }
  }, [volume, muted]);

  React.useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    Array.from(video.textTracks).forEach((track) => {
      track.mode = captions ? 'showing' : 'hidden';
    });
  }, [captions, source]);

  const showingControls = controlsVisible || !playing || Boolean(menu);
  const VolumeIcon = muted || volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2;
  const variants = source?.variants?.length ? source.variants : null;

  return (
    <div
      ref={shellRef}
      onPointerMove={wake}
      onPointerLeave={() => playing && setControlsVisible(false)}
      className={cn(
        'group/player relative isolate w-full overflow-hidden bg-black',
        // On phones the 16:9 box alone is too short to hold the empty state, so
        // give it a floor until there is enough width for the ratio to breathe.
        fullscreen ? 'h-dvh rounded-none' : 'aspect-video min-h-[17rem] rounded-3xl sm:min-h-0',
        !showingControls && playing && 'cursor-none',
      )}
    >
      {/* ---------- media ---------- */}
      {source && ytId && isYouTube ? (
        <YouTubeEngine
          videoId={ytId}
          handleRef={handleRef}
          muted={muted}
          volume={volume}
          onReady={onReady}
          onStateChange={setPlaying}
        />
      ) : source && mediaUrl ? (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <video
          ref={videoRef}
          key={mediaUrl}
          src={mediaUrl}
          poster={source.poster}
          playsInline
          preload="metadata"
          crossOrigin="anonymous"
          className="absolute inset-0 h-full w-full bg-black object-contain"
          onClick={tapSurface}
          onPlay={() => {
            setPlaying(true);
            setFailed(null);
          }}
          onPause={() => setPlaying(false)}
          onWaiting={() => setWaiting(true)}
          onPlaying={() => setWaiting(false)}
          onCanPlay={() => {
            setWaiting(false);
            onReady?.();
          }}
          onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
          onProgress={(e) => {
            const v = e.currentTarget;
            if (v.buffered.length) setBuffered(v.buffered.end(v.buffered.length - 1));
          }}
          onError={() =>
            setFailed(
              source.type === 'url'
                ? 'That link could not be played. It may block embedding, or need a direct .mp4 / .webm URL.'
                : 'This file could not be played in your browser.',
            )
          }
        />
      ) : (
        <div className="absolute inset-0 grid place-items-center">{emptyState}</div>
      )}

      {/* ---------- ambient glow from the picture ---------- */}
      {source && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(circle_at_50%_45%,rgba(124,58,237,0.22),transparent_65%)]"
        />
      )}

      {/* ---------- buffering ---------- */}
      <AnimatePresence>
        {waiting && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="pointer-events-none absolute inset-0 grid place-items-center bg-black/25 backdrop-blur-[2px]"
          >
            <Loader2 className="animate-spin text-white/80" size={30} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* ---------- playback error ---------- */}
      <AnimatePresence>
        {failed && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="absolute inset-x-4 top-4 z-30 mx-auto max-w-md rounded-2xl border border-rose-400/25 bg-rose-950/70 px-4 py-3 text-[0.8125rem] text-rose-100 backdrop-blur-xl"
          >
            {failed}
          </motion.div>
        )}
      </AnimatePresence>

      {overlay}

      {/* ---------- centre play button ---------- */}
      <AnimatePresence>
        {source && !playing && !waiting && (
          <motion.button
            initial={{ opacity: 0, scale: 0.85 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            transition={{ type: 'spring', stiffness: 340, damping: 26 }}
            onClick={togglePlay}
            aria-label="Play"
            className="absolute left-1/2 top-1/2 z-20 grid h-20 w-20 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-white/12 shadow-glass backdrop-blur-2xl transition-colors hover:bg-white/22"
          >
            <span className="absolute inset-0 animate-pulse-ring rounded-full border border-white/25" />
            <Play size={30} fill="currentColor" className="ml-1 text-white" />
          </motion.button>
        )}
      </AnimatePresence>

      {/* ---------- controls ---------- */}
      <AnimatePresence>
        {source && showingControls && (
          <motion.div
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 14 }}
            transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
            className="absolute inset-x-0 bottom-0 z-30"
          >
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-black/90 via-black/45 to-transparent" />

            <div className="relative px-3 pb-3 sm:px-5 sm:pb-4">
              <SeekBar
                position={scrubbing ?? position}
                duration={duration}
                buffered={buffered}
                onScrub={setScrubbing}
                onCommit={(t) => {
                  setScrubbing(null);
                  seekTo(t);
                }}
              />

              <div className="flex items-center gap-1 sm:gap-1.5">
                <Tooltip label={playing ? 'Pause' : 'Play'} shortcut="Space">
                  <button
                    onClick={togglePlay}
                    aria-label={playing ? 'Pause' : 'Play'}
                    className="grid h-10 w-10 place-items-center rounded-xl text-white transition-colors hover:bg-white/12"
                  >
                    {playing ? <Pause size={19} fill="currentColor" /> : <Play size={19} fill="currentColor" />}
                  </button>
                </Tooltip>

                <Tooltip label="Back 10 seconds" shortcut="J">
                  <button
                    onClick={() => seekBy(-10)}
                    aria-label="Back 10 seconds"
                    className="hidden h-10 w-10 place-items-center rounded-xl text-white/80 transition-colors hover:bg-white/12 hover:text-white sm:grid"
                  >
                    <RotateCcw size={17} />
                  </button>
                </Tooltip>
                <Tooltip label="Forward 10 seconds" shortcut="L">
                  <button
                    onClick={() => seekBy(10)}
                    aria-label="Forward 10 seconds"
                    className="hidden h-10 w-10 place-items-center rounded-xl text-white/80 transition-colors hover:bg-white/12 hover:text-white sm:grid"
                  >
                    <RotateCw size={17} />
                  </button>
                </Tooltip>

                {/* volume */}
                <div className="group/vol flex items-center">
                  <button
                    onClick={() => setMuted((m) => !m)}
                    aria-label={muted ? 'Unmute' : 'Mute'}
                    className="grid h-10 w-10 place-items-center rounded-xl text-white/80 transition-colors hover:bg-white/12 hover:text-white"
                  >
                    <VolumeIcon size={18} />
                  </button>
                  <div className="relative h-1 w-0 overflow-hidden rounded-full bg-white/20 transition-all duration-400 ease-glide group-hover/vol:w-20 group-focus-within/vol:w-20 sm:mr-1">
                    <div
                      className="h-full rounded-full bg-white"
                      style={{ width: `${(muted ? 0 : volume) * 100}%` }}
                    />
                    <input
                      type="range"
                      className="sr-range"
                      min={0}
                      max={1}
                      step={0.02}
                      value={muted ? 0 : volume}
                      aria-label="Volume"
                      onChange={(e) => {
                        setVolume(Number(e.target.value));
                        setMuted(false);
                      }}
                    />
                  </div>
                </div>

                <span className="ml-1 select-none whitespace-nowrap font-mono text-[0.6875rem] tabular-nums text-white/70 sm:text-[0.75rem]">
                  {formatTime(scrubbing ?? position)}
                  <span className="text-white/30">&thinsp;/&thinsp;{formatTime(duration)}</span>
                </span>

                {Math.abs(drift) > 0.6 && (
                  <span className="ml-2 hidden rounded-full bg-amber-500/15 px-2 py-0.5 text-[0.625rem] font-medium text-amber-300 sm:inline">
                    realigning
                  </span>
                )}

                <div className="ml-auto flex items-center gap-1 sm:gap-1.5">
                  {/* quality */}
                  <div className="relative">
                    <Tooltip label="Quality">
                      <button
                        onClick={() => setMenu(menu === 'quality' ? null : 'quality')}
                        aria-label="Video quality"
                        aria-expanded={menu === 'quality'}
                        className="hidden h-10 items-center gap-1.5 rounded-xl px-2.5 text-[0.75rem] font-medium text-white/80 transition-colors hover:bg-white/12 hover:text-white sm:flex"
                      >
                        <SlidersHorizontal size={15} />
                        {quality}
                      </button>
                    </Tooltip>
                    <AnimatePresence>
                      {menu === 'quality' && (
                        <motion.div
                          initial={{ opacity: 0, y: 8, scale: 0.96 }}
                          animate={{ opacity: 1, y: 0, scale: 1 }}
                          exit={{ opacity: 0, y: 6, scale: 0.97 }}
                          transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                          className="absolute bottom-full right-0 mb-2 w-40 overflow-hidden rounded-2xl glass-deep p-1.5"
                        >
                          {['Auto', ...(variants?.map((v) => v.label) ?? ['1080p', '720p', '480p'])].map((q) => (
                            <button
                              key={q}
                              onClick={() => {
                                setQuality(q);
                                setMenu(null);
                              }}
                              className={cn(
                                'flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-[0.8125rem] transition-colors',
                                quality === q ? 'bg-white/12 text-white' : 'text-white/60 hover:bg-white/[0.07]',
                              )}
                            >
                              {q}
                              {quality === q && <span className="h-1.5 w-1.5 rounded-full bg-electric-400" />}
                            </button>
                          ))}
                          {!variants && (
                            <p className="px-3 pb-1 pt-2 text-[0.625rem] leading-relaxed text-white/30">
                              This source streams a single rendition; your browser adapts it automatically.
                            </p>
                          )}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>

                  {/* settings */}
                  <div className="relative">
                    <Tooltip label="Playback settings">
                      <button
                        onClick={() => setMenu(menu === 'settings' ? null : 'settings')}
                        aria-label="Playback settings"
                        aria-expanded={menu === 'settings'}
                        className="grid h-10 w-10 place-items-center rounded-xl text-white/80 transition-colors hover:bg-white/12 hover:text-white"
                      >
                        <Settings2 size={17} />
                      </button>
                    </Tooltip>
                    <AnimatePresence>
                      {menu === 'settings' && (
                        <motion.div
                          initial={{ opacity: 0, y: 8, scale: 0.96 }}
                          animate={{ opacity: 1, y: 0, scale: 1 }}
                          exit={{ opacity: 0, y: 6, scale: 0.97 }}
                          transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                          className="absolute bottom-full right-0 mb-2 w-48 overflow-hidden rounded-2xl glass-deep p-1.5"
                        >
                          <p className="flex items-center gap-2 px-3 py-2 text-eyebrow uppercase text-white/35">
                            <Gauge size={11} /> Speed
                          </p>
                          {RATES.map((r) => (
                            <button
                              key={r}
                              onClick={() => {
                                changeRate(r);
                                setMenu(null);
                              }}
                              className={cn(
                                'flex w-full items-center justify-between rounded-xl px-3 py-2 text-left text-[0.8125rem] transition-colors',
                                rate === r ? 'bg-white/12 text-white' : 'text-white/60 hover:bg-white/[0.07]',
                              )}
                            >
                              {r === 1 ? 'Normal' : `${r}×`}
                              {rate === r && <span className="h-1.5 w-1.5 rounded-full bg-electric-400" />}
                            </button>
                          ))}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>

                  <Tooltip label="Subtitles" shortcut="C">
                    <button
                      onClick={() => setCaptions((c) => !c)}
                      aria-label="Toggle subtitles"
                      aria-pressed={captions}
                      className={cn(
                        'grid h-10 w-10 place-items-center rounded-xl transition-colors hover:bg-white/12',
                        captions ? 'text-electric-300' : 'text-white/80 hover:text-white',
                      )}
                    >
                      <Captions size={17} />
                    </button>
                  </Tooltip>

                  {!isYouTube && (
                    <Tooltip label="Picture in picture" shortcut="P">
                      <button
                        onClick={togglePiP}
                        aria-label="Picture in picture"
                        className="hidden h-10 w-10 place-items-center rounded-xl text-white/80 transition-colors hover:bg-white/12 hover:text-white sm:grid"
                      >
                        <PictureInPicture2 size={17} />
                      </button>
                    </Tooltip>
                  )}

                  <Tooltip label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'} shortcut="F">
                    <button
                      onClick={toggleFullscreen}
                      aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
                      className="grid h-10 w-10 place-items-center rounded-xl text-white/80 transition-colors hover:bg-white/12 hover:text-white"
                    >
                      {fullscreen ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
                    </button>
                  </Tooltip>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
