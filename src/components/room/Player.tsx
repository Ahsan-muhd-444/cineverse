'use client';

import * as React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertTriangle,
  Captions,
  Film,
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
import { cn, formatTime } from '@/lib/utils';
import { resolveYouTubeId } from '@/lib/media';
import { resolveDisplayedPosition, shouldShowHtml5Loading } from '@/hooks/playbackProjection';
import {
  enterVideoFullscreen,
  exitAnyFullscreen,
  fullscreenElementOf,
  isForeignFullscreen,
  isShellFullscreen,
  requestElementFullscreen,
  shouldDisableIframePointerEvents,
  shouldShowFullscreenChrome,
} from './fullscreen';
import { resetYouTubeApiLoader, type YouTubeFailure } from './youtubeApi';
import { Tooltip } from '@/components/ui/Bits';
import { Button } from '@/components/ui/Button';
import { YouTubeEngine, type YouTubePhase } from './YouTubeEngine';

const RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];

export interface PlayerProps {
  source: MediaSource | null;
  localFile: File | null;
  handleRef: React.MutableRefObject<PlayerHandle | null>;
  onUserControl: (action: SyncAction, extra?: { time?: number; rate?: number }) => void;
  /** True while a remote sync command is being applied — YouTube uses it to
   *  avoid echoing programmatic play/pause/seek back to the room. */
  isApplying?: () => boolean;
  /** Open the source picker — offered as the recovery action when a source
   *  can't be played (e.g. an embedding-disabled YouTube video). */
  onRequestSource?: () => void;
  onReady?: () => void;
  onProgress?: (position: number, duration: number) => void;
  emptyState: React.ReactNode;
  overlay?: React.ReactNode;
  drift?: number;
  /** True when a remote play was blocked by autoplay policy on this device —
   *  the YouTube branch shows a one-click "Join playback" affordance. */
  needsPlaybackGesture?: boolean;
  /** Resume from the room's current position, driven by the user's click. */
  onJoinPlayback?: () => void;
  /**
   * Mobile "chat mode": render the picture as a height-driven mini player.
   *
   * The parent gives the region a fixed height and this makes the shell fill it
   * (`h-full w-auto`), so 16:9 is preserved by SHRINKING THE WIDTH — never by
   * letterboxing. `lg:` overrides put desktop back exactly as it was.
   */
  compact?: boolean;
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
          // Playback progress is a product state, not a realtime one: solid
          // gold, no purple->cyan sweep and no persistent glow.
          className="absolute inset-y-0 left-0 rounded-full bg-gold-400"
          style={{ width: `${pct}%` }}
        />
        <div
          className={cn(
            'absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_2px_10px_rgba(0,0,0,0.6)] transition-transform duration-[160ms] ease-swift',
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

      {/* Keyboard/screen-reader path only. pointer-events-none is essential:
          without it this invisible input sits on top of the track and its
          onChange fires on EVERY pointer move of a drag — committing a seek
          (and a sync:control broadcast) per movement instead of one on release. */}
      <input
        type="range"
        className="sr-range pointer-events-none"
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
  isApplying,
  onRequestSource,
  onReady,
  onProgress,
  emptyState,
  overlay,
  drift = 0,
  needsPlaybackGesture = false,
  onJoinPlayback,
  compact = false,
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
  // Why the YouTube source failed. An 'api' failure (script blocked, network,
  // loader timeout) is retryable locally; a 'video' one is not.
  const [failureKind, setFailureKind] = React.useState<'api' | 'video' | null>(null);
  // Bumping this remounts ONLY the local YouTube engine — it never touches the
  // shared room source, so a retry can't re-broadcast "put on …" to the room.
  const [youtubeAttempt, setYoutubeAttempt] = React.useState(0);
  const [scrubbing, setScrubbing] = React.useState<number | null>(null);
  // Whether the current engine has reported ready. Controls stay pending until
  // then, so nobody clicks into a player that cannot yet accept the command.
  const [ready, setReady] = React.useState(false);
  // YouTube lifecycle phase — drives ONLY the startup loading affordance, never
  // controls over YouTube's native UI.
  const [youtubePhase, setYoutubePhase] = React.useState<YouTubePhase | null>(null);

  const hideTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // After a local seek, hold the displayed position at the target until the
  // engine actually catches up (YouTube keeps reporting the OLD time while it
  // buffers, which made the bar visibly snap back right after a drag).
  const seekHold = React.useRef<{ target: number; until: number } | null>(null);
  // Whether we have already run the one-time "engine ready" side effect (which
  // triggers sync.resync()) for the CURRENT source. Without this guard, an
  // HTML5 <video> re-fires `canplay` after every programmatic seek, so resync's
  // own seek re-triggered ready → resync → seek in a tight infinite loop that
  // pinned the playhead at 0 and churned the loading overlay forever.
  const readyAnnouncedRef = React.useRef(false);

  const isYouTube = source?.type === 'youtube';
  const ytId = isYouTube ? resolveYouTubeId(source) : null;

  const objectUrl = React.useMemo(() => (localFile ? URL.createObjectURL(localFile) : null), [localFile]);
  React.useEffect(() => () => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }, [objectUrl]);

  const mediaUrl = source?.type === 'local' ? objectUrl : source?.value || null;

  /* ---------------- reset transient state on a source switch ---------------- */

  // A new source must never inherit the previous one's play/loading/error state.
  const sourceKey = source ? `${source.type}:${source.value}` : null;
  React.useEffect(() => {
    setReady(false);
    setFailed(null);
    setFailureKind(null);
    // A genuinely new source starts its retry count over.
    setYoutubeAttempt(0);
    setPlaying(false);
    setWaiting(false);
    setPosition(0);
    setDuration(0);
    setBuffered(0);
    setScrubbing(null);
    setYoutubePhase(null);
    seekHold.current = null;
    // The new source gets exactly one ready→resync announcement.
    readyAnnouncedRef.current = false;
  }, [sourceKey]);

  // A YouTube source whose ID can't be parsed can never load — say so instead of
  // handing an unusable value to a <video> element.
  React.useEffect(() => {
    if (isYouTube && !ytId) {
      setFailed('That YouTube link looks invalid — check the video ID.');
      setFailureKind('video');
    }
  }, [isYouTube, ytId]);

  // YouTube path: the engine fires onReady exactly once per player, so resync
  // once here is safe. Clearing `failed` here is what makes a late-but-successful
  // load (or a successful retry) drop the previous error overlay.
  const handleEngineReady = React.useCallback(() => {
    setReady(true);
    setFailed(null);
    setFailureKind(null);
    onReady?.();
  }, [onReady]);

  const handleEngineError = React.useCallback((failure: YouTubeFailure) => {
    setFailed(failure.message);
    setFailureKind(failure.kind);
  }, []);

  /**
   * Rebuild the local YouTube engine after a retryable API failure.
   *
   * Deliberately local: it resets the loader and remounts the engine via the
   * `key`, but never calls setSource — the shared room source is untouched, so
   * no "put on …" message and no sync:control is broadcast. Once the engine
   * reports ready, the normal onReady → resync path puts us back on the room's
   * projected position.
   */
  const retryYouTube = React.useCallback(() => {
    resetYouTubeApiLoader();
    setFailed(null);
    setFailureKind(null);
    setReady(false);
    setYoutubePhase('loading');
    setYoutubeAttempt((attempt) => attempt + 1);
  }, []);

  /**
   * HTML5 path: mark the player ready from ANY of the several media events that
   * mean "metadata/frame is available" — not one fragile `canplay`. The
   * onReady() side effect (which runs sync.resync()) fires only ONCE per source,
   * because resync seeks and a seek re-fires those same media events; announcing
   * every time was the infinite loop.
   */
  const markReadyOnce = React.useCallback(() => {
    setReady(true);
    setWaiting(false);
    if (!readyAnnouncedRef.current) {
      readyAnnouncedRef.current = true;
      onReady?.();
    }
  }, [onReady]);

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
      // Readiness backstop (HTML5): if the engine reports ready but our media
      // events never marked it — because they fired before React attached its
      // listeners, e.g. cached/instantly-ready media — announce it here (once).
      // This is what guarantees the loading overlay can never stick on a video
      // that is actually ready.
      if (!isYouTube && !readyAnnouncedRef.current) markReadyOnce();
      const t = handle.getTime();
      const d = handle.getDuration();
      // Respect a fresh local seek: keep showing the target until the engine
      // reports a time near it (or the hold expires), instead of snapping back.
      const { position: shown, holding } = resolveDisplayedPosition(seekHold.current, t, Date.now());
      if (!holding) seekHold.current = null;
      setPosition(shown);
      setDuration(d);
      // Play/pause state is driven by engine events (onYouTubePhase / <video>
      // events), not polled here — polling isPaused() flipped the UI to "paused"
      // during buffering.
      onProgress?.(t, d);
    }, 250);
    return () => clearInterval(id);
  }, [handleRef, isYouTube, onProgress, markReadyOnce]);

  /* ---------------- fullscreen ---------------- */

  React.useEffect(() => {
    const onChange = () => {
      // Prefixed lookup: Safari reports `webkitFullscreenElement`, so reading only
      // the unprefixed property left the UI convinced it was never fullscreen.
      const element = fullscreenElementOf(document);
      // Only OUR shell counts. Treating any fullscreen element as ours is what
      // let a YouTube iframe hold fullscreen while the UI rendered its exit
      // button into a document nobody could see.
      setFullscreen(isShellFullscreen(shellRef.current, element));
      // Safety net for YouTube: if the iframe (or anything else) grabs native
      // fullscreen, back out immediately — the parent cannot overlay a
      // cross-origin fullscreen element, so there would be no way out.
      if (isYouTube && isForeignFullscreen(shellRef.current, element)) {
        void exitAnyFullscreen(document);
      }
    };
    document.addEventListener('fullscreenchange', onChange);
    document.addEventListener('webkitfullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      document.removeEventListener('webkitfullscreenchange', onChange);
    };
  }, [isYouTube]);

  /*
   * iOS hands a video to the NATIVE player rather than the Fullscreen API, so no
   * `fullscreenchange` ever fires. These two events are the only signal that the
   * HTML5 video entered or left fullscreen there — without them the control bar
   * would keep offering "Enter fullscreen" while the film was already full-screen.
   */
  React.useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onBegin = () => setFullscreen(true);
    const onEnd = () => setFullscreen(false);
    video.addEventListener('webkitbeginfullscreen', onBegin);
    video.addEventListener('webkitendfullscreen', onEnd);
    return () => {
      video.removeEventListener('webkitbeginfullscreen', onBegin);
      video.removeEventListener('webkitendfullscreen', onEnd);
    };
  }, [isYouTube]);

  /**
   * Enter/leave fullscreen on every platform we ship to.
   *
   * The previous implementation called `shellRef.requestFullscreen()` only. On an
   * iPhone that method does not exist, so the button did nothing at all — it
   * worked on a laptop and silently failed on a phone. Now the shell is tried
   * first (all desktops, Android, iPadOS via the webkit prefix), and when the
   * platform has no element-level fullscreen we hand the HTML5 video to iOS's
   * native player instead.
   */
  const toggleFullscreen = React.useCallback(async () => {
    const active = fullscreenElementOf(document);
    const video = videoRef.current as (HTMLVideoElement & { webkitDisplayingFullscreen?: boolean }) | null;
    if (active || video?.webkitDisplayingFullscreen) {
      await exitAnyFullscreen(document, video);
      return;
    }
    if (await requestElementFullscreen(shellRef.current)) return;
    // No element fullscreen on this platform (iPhone). The video element is the
    // only thing iOS will take fullscreen; a YouTube source has none exposed to
    // us, so its own control is the path there (see youtubePlayerVars).
    enterVideoFullscreen(videoRef.current);
  }, []);

  /* ---------------- fullscreen chrome (cursor + exit button) ----------------
     In fullscreen the cursor and exit button fade out once the pointer has been
     still, and come straight back on any movement — the cinematic behaviour a
     full-screen film needs. Only applies while WE own fullscreen. */

  const [chromeVisible, setChromeVisible] = React.useState(true);
  const lastPointerAtRef = React.useRef(Date.now());

  const wakeFullscreenChrome = React.useCallback(() => {
    lastPointerAtRef.current = Date.now();
    // Reveal immediately; the idle poll below handles hiding.
    setChromeVisible(true);
  }, []);

  React.useEffect(() => {
    if (!fullscreen) {
      setChromeVisible(true);
      return;
    }
    lastPointerAtRef.current = Date.now();
    setChromeVisible(true);
    const id = setInterval(() => {
      setChromeVisible(
        shouldShowFullscreenChrome({ fullscreen: true, lastPointerAt: lastPointerAtRef.current, now: Date.now() }),
      );
    }, 300);
    return () => clearInterval(id);
  }, [fullscreen]);

  // While the chrome is idle-hidden, the YouTube iframe must stop swallowing
  // pointer events, or its own cursor stays drawn over the film and the parent
  // never sees the movement that should bring the chrome back.
  const iframeInteractive = !shouldDisableIframePointerEvents({ isYouTube, fullscreen, chromeVisible });

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
    // Ignore play/pause until the engine can actually accept it.
    if (!handle || !handle.ready()) return;
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
      if (!handle || !handle.ready()) return;
      const next = Math.max(0, Math.min(handle.getDuration() || Infinity, handle.getTime() + delta));
      seekHold.current = { target: next, until: Date.now() + 1600 };
      setPosition(next);
      handle.seek(next);
      onUserControl('seek', { time: next });
      wake();
    },
    [handleRef, onUserControl, wake],
  );

  const seekTo = React.useCallback(
    (t: number) => {
      const handle = handleRef.current;
      if (!handle || !handle.ready()) return;
      seekHold.current = { target: t, until: Date.now() + 1600 };
      setPosition(t);
      handle.seek(t);
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
      // Typing always wins — this guard must come FIRST, before any branch.
      // Behind the YouTube branch it was unreachable, so typing "f" in chat
      // toggled fullscreen.
      const target = e.target as HTMLElement | null;
      const isEditable =
        target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (isEditable) return;

      // YouTube-native mode: let YouTube's own player handle play/seek keys, so
      // we don't double-drive them. Fullscreen, though, is CineVerse-owned now
      // (YouTube's own fs button is disabled), so 'f' toggles our wrapper.
      if (isYouTube) {
        if (e.key.toLowerCase() === 'f') {
          e.preventDefault();
          void toggleFullscreen();
        }
        return;
      }

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
  }, [togglePlay, seekBy, toggleFullscreen, togglePiP, wake, isYouTube]);

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
  // True startup only: a source is set but the engine hasn't reported ready.
  // Used for the "Loading…" label; once ready, a paused first frame is NOT
  // loading and must show controls, not a spinner.
  const html5Startup = Boolean(source) && !ready && !failed;
  // Whether to cover the HTML5 picture: startup, or genuine mid-play buffering —
  // never a stuck `waiting` flag on a paused, ready video.
  const html5Loading = shouldShowHtml5Loading({
    hasSource: Boolean(source),
    ready,
    failed: Boolean(failed),
    waiting,
    playing,
  });

  /* ---------------- YouTube: native controls, CineVerse owns only room sync ----------------
     YouTube keeps its own player UI (controls, seek bar, settings, fullscreen).
     We render just the iframe — no CineVerse control bar, center button, cover
     or click-swallow layer — and the engine mirrors native play/pause/seek/rate
     into the room. Trying to replace YouTube's UI with app controls is what
     caused the cover/flash/"Starting…" bugs; this keeps YouTube's UI and only
     syncs room state. */
  if (source && isYouTube) {
    return (
      <div
        ref={shellRef}
        onPointerMove={wakeFullscreenChrome}
        onPointerDown={wakeFullscreenChrome}
        onKeyDown={wakeFullscreenChrome}
        className={cn(
          'group/player relative isolate overflow-hidden bg-black',
          // Cinema frame: a neutral hairline plus a controlled deep shadow so
          // the screen reads as installed in the room rather than as another
          // glass card. No coloured halo — the frame must never tint the
          // picture. Radius drops one step at narrow widths. Fullscreen is
          // deliberately frame-free: radius, border and shadow all removed.
          //
          // No mobile min-height floor. `min-h-[17rem]` (272px, phones only)
          // forced the player ~53px taller than its natural 16:9 box on a 390px
          // screen; with the room locked to the viewport that stolen height came
          // straight out of the chat. 16:9 is now the only height rule.
          fullscreen
            ? 'h-dvh w-full rounded-none'
            : compact
              ? 'aspect-video h-full min-h-0 w-auto max-w-full rounded-xl border border-white/[0.09] lg:h-auto lg:w-full lg:rounded-3xl lg:shadow-[0_1px_0_0_rgba(255,255,255,0.07)_inset,0_32px_80px_-28px_rgba(0,0,0,0.95)]'
              : 'aspect-video min-h-0 w-full rounded-2xl border border-white/[0.09] shadow-[0_1px_0_0_rgba(255,255,255,0.07)_inset,0_32px_80px_-28px_rgba(0,0,0,0.95)] sm:rounded-3xl',
          // Hide the pointer once the fullscreen chrome has gone idle.
          fullscreen && !chromeVisible && 'cursor-none',
        )}
      >
        {ytId ? (
          <YouTubeEngine
            // The attempt counter remounts the engine on a local retry without
            // touching the room's source.
            key={`${ytId}:${youtubeAttempt}`}
            videoId={ytId}
            handleRef={handleRef}
            muted={muted}
            volume={volume}
            onReady={handleEngineReady}
            onError={handleEngineError}
            onPhase={setYoutubePhase}
            onUserIntent={onUserControl}
            isApplying={isApplying}
            iframeInteractive={iframeInteractive}
          />
        ) : (
          <div className="absolute inset-0 grid place-items-center">{emptyState}</div>
        )}

        {/* Startup affordance: a labelled loader until YouTube's own player is
            ready (never a permanent silent black box). pointer-events-none, so it
            never intercepts YouTube's UI, and gone the moment the player is ready —
            after which YouTube's own thumbnail + play button are the affordance. */}
        {ytId && !failed && (!ready || youtubePhase === 'loading') && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center bg-black">
            <span className="grid place-items-center gap-2">
              <Loader2 className="animate-spin text-white/70" size={30} />
              <span className="text-[0.75rem] font-medium text-supporting">Loading YouTube…</span>
            </span>
          </div>
        )}

        {/* Floating reactions (pointer-events-none — never blocks YouTube UI). */}
        {overlay}

        {/* CineVerse-owned fullscreen affordance.
            YouTube keeps play/pause/seek INSIDE the iframe; CineVerse owns the
            fullscreen shell + a guaranteed exit button, because a cross-origin
            iframe in native fullscreen can't be overlaid by the parent. The
            container is pointer-events-none so YouTube's own controls stay
            clickable — ONLY the button captures pointer events. In fullscreen the
            exit button is always visible (not hover-gated) on desktop and mobile. */}
        {ytId && !failed && (
          <div
            className={cn(
              'pointer-events-none absolute inset-0 z-40 transition-opacity duration-200',
              // Fade out with the cursor once fullscreen goes idle; any pointer
              // movement brings both straight back. Keyboard focus counts as
              // movement — otherwise tabbing to Exit lands on an invisible
              // button with no way to tell it is there.
              fullscreen && !chromeVisible && 'opacity-0 focus-within:opacity-100',
            )}
          >
            {fullscreen ? (
              <button
                onClick={toggleFullscreen}
                aria-label="Exit fullscreen"
                // Not clickable while faded out, so an invisible button can
                // never swallow a click meant for YouTube's controls.
                className={cn(
                  'absolute right-4 top-4 inline-flex min-h-11 items-center gap-2 rounded-full bg-black/70 px-4 py-2 text-[0.8125rem] font-medium text-white shadow-glass ring-1 ring-white/20 backdrop-blur-md transition-colors hover:bg-black/85',
                  // `focus:pointer-events-auto` keeps it activatable by keyboard
                  // even while the pointer chrome is idle-hidden.
                  chromeVisible ? 'pointer-events-auto' : 'pointer-events-none focus:pointer-events-auto',
                )}
              >
                <Minimize2 size={16} />
                Exit fullscreen
              </button>
            ) : (
              <button
                onClick={toggleFullscreen}
                aria-label="Enter fullscreen"
                // Not "press F": once focus is inside the YouTube iframe the
                // parent never sees the key, so this button is the reliable path.
                title="Fullscreen — use this button when YouTube has focus"
                className="pointer-events-auto absolute right-3 top-3 grid h-11 w-11 place-items-center rounded-xl bg-black/45 text-white/85 opacity-70 shadow-glass ring-1 ring-white/15 backdrop-blur-md transition duration-[160ms] ease-swift hover:bg-black/65 hover:opacity-100"
              >
                <Maximize2 size={16} />
              </button>
            )}
          </div>
        )}

        {/* Remote autoplay activation.
            When a remote play arrives but the browser blocks unmuted autoplay,
            the guest would otherwise sit silently on the thumbnail. Explain it and
            offer one click to join at the room's current time. Small + centered so
            it reads as intentional, not broken. */}
        <AnimatePresence>
          {needsPlaybackGesture && !failed && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 z-40 grid place-items-center bg-ink-950/70 px-6 text-center backdrop-blur-sm"
            >
              <div className="max-w-xs">
                <span className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-white/[0.07] text-primary">
                  <Play size={24} fill="currentColor" className="ml-0.5" />
                </span>
                <p className="font-display text-lg font-semibold text-primary">Join playback</p>
                <p className="mx-auto mt-2 text-[0.8125rem] leading-relaxed text-supporting">
                  Your browser needs one click before YouTube can play with sound on this device.
                </p>
                <Button variant="primary" size="md" className="mt-5" onClick={() => onJoinPlayback?.()}>
                  <Play size={16} fill="currentColor" />
                  Join now
                </Button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Playback error (invalid / private / unembeddable). The video can't be
            played at all, so cover YouTube's own dead-end screen with a clear,
            actionable state rather than a floating banner over it. */}
        <AnimatePresence>
          {failed && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 z-30 grid place-items-center bg-ink-950/85 px-6 text-center backdrop-blur-sm"
            >
              <div className="max-w-sm">
                <span className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-rose-500/15 text-rose-300">
                  <AlertTriangle size={24} />
                </span>
                {/* An API failure is about the PLAYER, not the video — say so,
                    and offer a retry that reloads only this device's player. */}
                <p className="font-display text-lg font-semibold text-primary">
                  {failureKind === 'api' ? 'Couldn’t start the player' : 'This video can’t play here'}
                </p>
                <p className="mx-auto mt-2 text-[0.8125rem] leading-relaxed text-supporting">{failed}</p>
                <p className="mx-auto mt-1 text-[0.75rem] leading-relaxed text-muted">
                  {failureKind === 'api'
                    ? 'The film is still on in this room — retrying just reloads the player on this device.'
                    : 'Many music and studio videos block off-YouTube playback. Try another video, a direct link, or an Open Cinema title.'}
                </p>
                <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
                  {failureKind === 'api' && (
                    <Button variant="primary" size="md" onClick={retryYouTube}>
                      <RotateCw size={16} />
                      Retry YouTube
                    </Button>
                  )}
                  {onRequestSource && (
                    <Button
                      variant={failureKind === 'api' ? 'glass' : 'primary'}
                      size="md"
                      onClick={onRequestSource}
                    >
                      <Film size={16} />
                      Choose something else
                    </Button>
                  )}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  }

  return (
    <div
      ref={shellRef}
      onPointerMove={wake}
      onPointerLeave={() => playing && setControlsVisible(false)}
      className={cn(
        'group/player relative isolate overflow-hidden bg-black',
        // Cinema frame: a neutral hairline plus a controlled deep shadow so
        // the screen reads as installed in the room rather than as another
        // glass card. No coloured halo — the frame must never tint the
        // picture. Radius drops one step at narrow widths. Fullscreen is
        // deliberately frame-free: radius, border and shadow all removed.
        //
        // The old `min-h-[17rem]` phone floor is gone: it made the player 53px
        // taller than 16:9 needs on a 390px screen, and inside the
        // viewport-locked room that height was taken from the chat. The empty
        // state is sized to fit the natural ratio instead.
        fullscreen
          ? 'h-dvh w-full rounded-none'
          : compact
            ? 'aspect-video h-full min-h-0 w-auto max-w-full rounded-xl border border-white/[0.09] lg:h-auto lg:w-full lg:rounded-3xl lg:shadow-[0_1px_0_0_rgba(255,255,255,0.07)_inset,0_32px_80px_-28px_rgba(0,0,0,0.95)]'
            : 'aspect-video min-h-0 w-full rounded-2xl border border-white/[0.09] shadow-[0_1px_0_0_rgba(255,255,255,0.07)_inset,0_32px_80px_-28px_rgba(0,0,0,0.95)] sm:rounded-3xl',
        !showingControls && playing && 'cursor-none',
      )}
    >
      {/* ---------- media (HTML5 / catalog / URL / local — YouTube is handled above) ---------- */}
      {source && mediaUrl ? (
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
          // Only a genuine mid-play stall is "buffering". A paused video firing
          // `waiting` (e.g. during a seek to its first frame) must NOT spin.
          onWaiting={() => {
            if (!videoRef.current?.paused) setWaiting(true);
          }}
          // Ready is reported from ANY of these — never a single fragile event —
          // and each clears a stale `waiting`. markReadyOnce runs resync once.
          onLoadedMetadata={(e) => {
            setDuration(e.currentTarget.duration || 0);
            markReadyOnce();
          }}
          onLoadedData={markReadyOnce}
          onCanPlay={markReadyOnce}
          onCanPlayThrough={markReadyOnce}
          onPlaying={() => {
            setWaiting(false);
            markReadyOnce();
          }}
          onTimeUpdate={() => waiting && setWaiting(false)}
          onSeeked={() => setWaiting(false)}
          onProgress={(e) => {
            const v = e.currentTarget;
            if (v.buffered.length) setBuffered(v.buffered.end(v.buffered.length - 1));
          }}
          onError={() => {
            setFailureKind(null); // never offer the YouTube retry for HTML5
            setFailed(
              source.type === 'url'
                ? 'That link could not be played. It may block embedding, or need a direct .mp4 / .webm URL.'
                : 'This file could not be played in your browser.',
            );
          }}
        />
      ) : (
        <div className="absolute inset-0 grid place-items-center">{emptyState}</div>
      )}

      {/* ---------- ambient glow from the picture ---------- */}
      {source && (
        <div
          aria-hidden
          // The purple radial behind the picture tinted every film. Reflected
          // light should be neutral and barely there, never a brand colour.
          className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(circle_at_50%_45%,rgba(255,255,255,0.05),transparent_65%)]"
        />
      )}

      {/* ---------- paused scrim ----------
          A native <video> has no chrome to hide, so on pause we keep the nicer
          dimmed frozen frame. */}
      <AnimatePresence>
        {source && ready && !playing && !waiting && !failed && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
            aria-hidden
            className="pointer-events-none absolute inset-0 z-10 bg-[radial-gradient(circle_at_50%_50%,rgba(0,0,0,0.55),rgba(0,0,0,0.35)_70%)]"
          />
        )}
      </AnimatePresence>

      {/* ---------- buffering / loading ----------
          Shows during true startup or a genuine mid-play stall only — never a
          stuck `waiting` flag on a paused, ready video (see shouldShowHtml5Loading). */}
      <AnimatePresence>
        {html5Loading && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="pointer-events-none absolute inset-0 z-20 grid place-items-center bg-black/25 backdrop-blur-[2px]"
          >
            <span className="grid place-items-center gap-2">
              <Loader2 className="animate-spin text-white/80" size={30} />
              {html5Startup && <span className="text-[0.75rem] font-medium text-supporting">Loading…</span>}
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ---------- top gradient + current title (with the controls) ---------- */}
      <AnimatePresence>
        {source && showingControls && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
            className="pointer-events-none absolute inset-x-0 top-0 z-30"
          >
            <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-black/70 via-black/30 to-transparent" />
            <p className="relative truncate px-4 pt-3 text-[0.8125rem] font-medium text-white/85 sm:px-5 sm:pt-4">
              {source.label}
            </p>
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

      {/* ---------- centre play button (only once the engine can accept it) ----------
          Centered by a grid WRAPPER, not by `-translate-x/y-1/2` on the button:
          framer-motion writes an inline `transform` for the scale animation,
          which overrode the translate classes and pushed the button down-right
          by half its size. The wrapper owns centering; framer only scales. */}
      <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center">
        <AnimatePresence>
          {source && ready && !playing && !waiting && !failed && (
            <motion.button
              initial={{ opacity: 0, scale: 0.85 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={{ type: 'spring', stiffness: 340, damping: 26 }}
              onClick={togglePlay}
              aria-label="Play"
              // Was a translucent glass disc with a perpetual pulse ring. A
              // solid dark surface reads as a control rather than an effect,
              // and stays legible over any frame behind it. 80px visual.
              className="pointer-events-auto relative grid h-20 w-20 place-items-center rounded-full border border-white/20 bg-black/70 shadow-[0_18px_50px_-12px_rgba(0,0,0,0.9)] transition-colors duration-[160ms] ease-swift hover:bg-black/80 hover:border-white/30"
            >
              <Play size={30} fill="currentColor" className="ml-1 text-white" />
            </motion.button>
          )}
        </AnimatePresence>
      </div>

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
                <Tooltip label={!ready ? 'Loading…' : playing ? 'Pause' : 'Play'} shortcut="Space">
                  <button
                    onClick={togglePlay}
                    disabled={!ready}
                    aria-label={playing ? 'Pause' : 'Play'}
                    className="grid h-11 w-11 place-items-center rounded-xl text-white transition-colors duration-[160ms] ease-swift hover:bg-white/12 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                  >
                    {playing ? <Pause size={19} fill="currentColor" /> : <Play size={19} fill="currentColor" />}
                  </button>
                </Tooltip>

                <Tooltip label="Back 10 seconds" shortcut="J">
                  <button
                    onClick={() => seekBy(-10)}
                    aria-label="Back 10 seconds"
                    className="hidden h-11 w-11 place-items-center rounded-xl text-white/80 transition-colors duration-[160ms] ease-swift hover:bg-white/12 hover:text-white sm:grid"
                  >
                    <RotateCcw size={17} />
                  </button>
                </Tooltip>
                <Tooltip label="Forward 10 seconds" shortcut="L">
                  <button
                    onClick={() => seekBy(10)}
                    aria-label="Forward 10 seconds"
                    className="hidden h-11 w-11 place-items-center rounded-xl text-white/80 transition-colors duration-[160ms] ease-swift hover:bg-white/12 hover:text-white sm:grid"
                  >
                    <RotateCw size={17} />
                  </button>
                </Tooltip>

                {/* volume */}
                <div className="group/vol flex items-center">
                  <button
                    onClick={() => setMuted((m) => !m)}
                    aria-label={muted ? 'Unmute' : 'Mute'}
                    className="grid h-11 w-11 place-items-center rounded-xl text-white/80 transition-colors duration-[160ms] ease-swift hover:bg-white/12 hover:text-white"
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
                  <span className="text-muted">&thinsp;/&thinsp;{formatTime(duration)}</span>
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
                        className="hidden min-h-11 items-center gap-1.5 rounded-xl px-2.5 text-[0.75rem] font-medium text-white/80 transition-colors duration-[160ms] ease-swift hover:bg-white/12 hover:text-white sm:flex"
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
                                'flex min-h-11 w-full items-center justify-between rounded-xl px-3 py-2 text-left text-[0.8125rem] transition-colors duration-[160ms] ease-swift',
                                quality === q ? 'bg-white/12 text-white' : 'text-white/60 hover:bg-white/[0.07]',
                              )}
                            >
                              {q}
                              {quality === q && <span className="h-1.5 w-1.5 rounded-full bg-gold-400" />}
                            </button>
                          ))}
                          {!variants && (
                            <p className="px-3 pb-1 pt-2 text-[0.6875rem] leading-relaxed text-supporting">
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
                        className="grid h-11 w-11 place-items-center rounded-xl text-white/80 transition-colors duration-[160ms] ease-swift hover:bg-white/12 hover:text-white"
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
                          <p className="flex items-center gap-2 px-3 py-2 text-eyebrow uppercase text-muted">
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
                                'flex min-h-11 w-full items-center justify-between rounded-xl px-3 py-2 text-left text-[0.8125rem] transition-colors duration-[160ms] ease-swift',
                                rate === r ? 'bg-white/12 text-white' : 'text-white/60 hover:bg-white/[0.07]',
                              )}
                            >
                              {r === 1 ? 'Normal' : `${r}×`}
                              {rate === r && <span className="h-1.5 w-1.5 rounded-full bg-gold-400" />}
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
                        'grid h-11 w-11 place-items-center rounded-xl transition-colors hover:bg-white/12',
                        captions ? 'text-gold-400' : 'text-white/80 hover:text-white',
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
                        className="hidden h-11 w-11 place-items-center rounded-xl text-white/80 transition-colors duration-[160ms] ease-swift hover:bg-white/12 hover:text-white sm:grid"
                      >
                        <PictureInPicture2 size={17} />
                      </button>
                    </Tooltip>
                  )}

                  <Tooltip label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'} shortcut="F">
                    <button
                      onClick={toggleFullscreen}
                      aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
                      className="grid h-11 w-11 place-items-center rounded-xl text-white/80 transition-colors duration-[160ms] ease-swift hover:bg-white/12 hover:text-white"
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
