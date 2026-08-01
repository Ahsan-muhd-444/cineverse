'use client';

import * as React from 'react';
import type { PlayerHandle, SyncAction } from '@/hooks/useSyncedPlayback';
import { isNativeSeek, seekDebounceOk, shouldEmitNativeEvent } from './youtubeSync';
import { YOUTUBE_IFRAME_ALLOW, YOUTUBE_PLAYER_VARS } from './youtubePlayerVars';
import {
  hasUsableYouTubeApi,
  loadYouTubeApi,
  YOUTUBE_API_UNAVAILABLE,
  type YouTubeFailure,
} from './youtubeApi';

/* Minimal shape of the bits of the YouTube IFrame API we actually touch. */
interface YTPlayer {
  playVideo: () => void;
  pauseVideo: () => void;
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  getCurrentTime: () => number;
  getDuration: () => number;
  getPlayerState: () => number;
  getAvailablePlaybackRates: () => number[];
  setVolume: (v: number) => void;
  mute: () => void;
  unMute: () => void;
  setPlaybackRate: (r: number) => void;
  destroy: () => void;
}

declare global {
  interface Window {
    YT?: {
      Player: new (el: HTMLElement | string, config: Record<string, unknown>) => YTPlayer;
      PlayerState: { UNSTARTED: number; PLAYING: number; PAUSED: number; ENDED: number; BUFFERING: number; CUED: number };
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

/** Coarse YouTube lifecycle phase, for a startup loading/recovery affordance only. */
export type YouTubePhase = 'loading' | 'ready' | 'cued' | 'buffering' | 'playing' | 'paused' | 'ended' | 'error';

// Ignore native events for this long after a programmatic (remote/drift) command,
// so the room's own commands don't bounce back as fresh local actions.
const SUPPRESS_MS = 800;
const SEEK_POLL_MS = 500;
const SEEK_THRESHOLD = 2; // seconds
const SEEK_DEBOUNCE_MS = 700;

// YouTube onError codes -> a message a human can act on. Never fail silently.
function errorMessage(code: number): string {
  switch (code) {
    case 2:
      return 'That YouTube link looks invalid — check the video ID.';
    case 5:
      return 'The YouTube player ran into a problem in this browser.';
    case 100:
      return 'That video is unavailable — it may be private, deleted, or region-locked.';
    case 101:
    case 150:
      return 'The uploader has disabled playing this video outside YouTube.';
    default:
      return 'This YouTube video could not be played.';
  }
}

/**
 * Wraps a YouTube embed behind the same PlayerHandle the HTML5 engine exposes,
 * so the sync layer can drive it. Crucially, YouTube keeps its OWN native
 * controls (`controls: 1`) as the visible control surface — CineVerse does not
 * render play/seek/settings over it. Instead:
 *
 *  - the room APPLIES remote commands via the handle (which opens a short
 *    suppression window so the resulting native events aren't echoed back);
 *  - LOCAL native control usage (play/pause/seek/rate) is detected from the
 *    player's own events + a light seek poll and emitted via `onUserIntent`.
 *
 * The iframe is created once per `videoId` (callbacks live in refs), so chat,
 * presence and drift re-renders never rebuild it.
 */
export function YouTubeEngine({
  videoId,
  handleRef,
  onReady,
  onError,
  onPhase,
  onUserIntent,
  isApplying,
  muted,
  volume,
  iframeInteractive = true,
}: {
  videoId: string;
  handleRef: React.MutableRefObject<PlayerHandle | null>;
  onReady?: () => void;
  /** Carries WHY it failed: an `api` failure is retryable, a `video` one isn't. */
  onError?: (failure: YouTubeFailure) => void;
  /** Coarse lifecycle phase — used ONLY for a startup loading/recovery affordance,
   *  never to render controls over YouTube's native UI. */
  onPhase?: (phase: YouTubePhase) => void;
  /** Emit a control the LOCAL user performed through YouTube's native UI. */
  onUserIntent?: (action: SyncAction, extra?: { time?: number; rate?: number }) => void;
  /** True while a remote command is being applied — used to suppress echo. */
  isApplying?: () => boolean;
  muted: boolean;
  volume: number;
  /** False while fullscreen chrome is idle-hidden: the iframe stops swallowing
   *  pointer events so the parent can hide the cursor and see the next move. */
  iframeInteractive?: boolean;
}) {
  const mountRef = React.useRef<HTMLDivElement>(null);
  const playerRef = React.useRef<YTPlayer | null>(null);
  const readyRef = React.useRef(false);
  const pendingRef = React.useRef<{ seek?: number; playing?: boolean; rate?: number }>({});
  // Whether the video has ever actually played. Until it has, the player is in
  // YouTube's CUED state showing the thumbnail + play button; pausing/seeking it
  // then drops it to a BLACK paused-at-0 frame (the "blank startup" bug), so we
  // leave a never-played cued player untouched.
  const hasPlayedRef = React.useRef(false);

  // Echo-suppression + local-seek detection bookkeeping.
  const suppressUntil = React.useRef(0);
  const lastTimeRef = React.useRef(0);
  const lastSeekEmitRef = React.useRef(0);
  const playingRef = React.useRef(false); // last emitted play/pause intent, to dedupe

  // Latest-callback refs: keep identities out of the create effect's deps.
  const onReadyRef = React.useRef(onReady);
  const onErrorRef = React.useRef(onError);
  const onPhaseRef = React.useRef(onPhase);
  const onUserIntentRef = React.useRef(onUserIntent);
  const isApplyingRef = React.useRef(isApplying);
  React.useEffect(() => {
    onReadyRef.current = onReady;
    onErrorRef.current = onError;
    onPhaseRef.current = onPhase;
    onUserIntentRef.current = onUserIntent;
    isApplyingRef.current = isApplying;
  }, [onReady, onError, onPhase, onUserIntent, isApplying]);

  // Whether the player is currently in a never-played cued/unstarted state.
  const isCued = () => {
    const st = window.YT?.PlayerState;
    const state = playerRef.current?.getPlayerState?.();
    return !!st && (state === st.CUED || state === st.UNSTARTED);
  };

  const mutedRef = React.useRef(muted);
  const volumeRef = React.useRef(volume);
  mutedRef.current = muted;
  volumeRef.current = volume;
  // Read inside styleIframe (which runs in the create effect), so it must be a
  // ref — a prop change must never rebuild the player.
  const interactiveRef = React.useRef(iframeInteractive);
  interactiveRef.current = iframeInteractive;

  // Open a suppression window for a programmatic command (remote sync / drift).
  const markProgrammatic = React.useCallback(() => {
    suppressUntil.current = Date.now() + SUPPRESS_MS;
  }, []);
  // Whether a native event may be reported to the room as a local user action.
  const canEmit = React.useCallback(
    () =>
      shouldEmitNativeEvent({
        isApplying: isApplyingRef.current?.() ?? false,
        suppressUntil: suppressUntil.current,
        now: Date.now(),
      }),
    [],
  );

  /* ---------------- create the player (ONLY on videoId / mount) ---------------- */

  React.useEffect(() => {
    let disposed = false;
    readyRef.current = false;
    pendingRef.current = {};
    playingRef.current = false;
    hasPlayedRef.current = false;
    onPhaseRef.current?.('loading');
    let renderCheck: ReturnType<typeof setTimeout> | null = null;

    // NOTE: there is deliberately no component-level API timeout any more. The
    // loader owns the deadline and REJECTS, so a hang surfaces here as a caught
    // error AND clears the loader cache — the old timer only painted an error
    // while the shared promise stayed pending forever.

    const applyVolume = () => {
      const player = playerRef.current;
      if (!player) return;
      player.setVolume(Math.round(volumeRef.current * 100));
      if (mutedRef.current) player.mute();
      else player.unMute();
    };

    // Force the GENERATED iframe to fill the frame and carry the permissions
    // YouTube's own embed uses. Without `allow` (autoplay/encrypted-media/…) some
    // videos render as a blank black frame with no error.
    const styleIframe = () => {
      const iframe = mountRef.current?.querySelector('iframe');
      if (!iframe) return;
      iframe.style.position = 'absolute';
      iframe.style.inset = '0';
      iframe.style.width = '100%';
      iframe.style.height = '100%';
      iframe.style.border = '0';
      iframe.style.pointerEvents = interactiveRef.current ? 'auto' : 'none';
      // `fullscreen` is deliberately ABSENT from this allow-list: CineVerse owns
      // fullscreen for YouTube. A cross-origin iframe in native fullscreen
      // cannot be overlaid by the parent, so the app's exit button would vanish
      // and the viewer would be trapped. (`disablekb` stops YouTube even trying;
      // this stops the browser granting it.)
      iframe.setAttribute('allow', YOUTUBE_IFRAME_ALLOW);
      iframe.removeAttribute('allowfullscreen');
      (iframe as HTMLIFrameElement).allowFullscreen = false;
    };

    loadYouTubeApi()
      .then(() => {
        const host = mountRef.current;
        // Lifecycle exit: the component is gone, so there is nothing to report.
        if (disposed || !host) return;

        // API-readiness is NOT a lifecycle exit. The global can vanish between
        // the loader resolving and this microtask; returning silently there left
        // the UI stuck on "Loading YouTube…" forever. Throw instead, so it lands
        // in the retryable .catch() below.
        const YT = window.YT;
        if (!hasUsableYouTubeApi(window) || !YT) {
          throw new Error(YOUTUBE_API_UNAVAILABLE);
        }

        // Give YouTube a DISPOSABLE child to replace — never the React-owned
        // wrapper node. Passing the wrapper to YT.Player lets it rip that node
        // out of React's tree, which desyncs reconciliation and can leave a
        // blank/mis-sized frame. We manage this child's lifecycle by hand.
        host.innerHTML = '';
        const target = document.createElement('div');
        host.appendChild(target);

        playerRef.current = new YT.Player(target, {
          width: '100%',
          height: '100%',
          videoId,
          // YouTube's OWN controls are the visible surface for play/pause/seek/
          // rate, but fullscreen (button, shortcut AND capability) belongs to
          // CineVerse — see youtubePlayerVars.ts for why each flag is there.
          playerVars: { ...YOUTUBE_PLAYER_VARS },
          events: {
            onReady: () => {
              if (disposed) return;
              readyRef.current = true;
              styleIframe();
              applyVolume();

              // Apply any intent that arrived before ready (seek, then rate, then
              // play/pause). Programmatic, so open a suppression window first.
              const pending = pendingRef.current;
              pendingRef.current = {};
              const player = playerRef.current;
              if (player && (pending.seek !== undefined || pending.rate !== undefined || pending.playing !== undefined)) {
                markProgrammatic();
                // Don't disturb a never-played cued player with a seek-to-~0 or a
                // pause — that turns YouTube's thumbnail into a black paused frame.
                const wantsPlay = pending.playing === true;
                if (pending.seek !== undefined && !(isCued() && !hasPlayedRef.current && pending.seek < 0.5)) {
                  player.seekTo(Math.max(0, pending.seek), true);
                }
                if (pending.rate !== undefined) {
                  const rates = player.getAvailablePlaybackRates?.() ?? [1];
                  if (rates.includes(pending.rate)) player.setPlaybackRate(pending.rate);
                }
                if (wantsPlay) player.playVideo();
                else if (pending.playing === false && !(isCued() && !hasPlayedRef.current)) player.pauseVideo();
              }

              lastTimeRef.current = playerRef.current?.getCurrentTime() ?? 0;
              onPhaseRef.current?.(isCued() ? 'cued' : 'ready');
              onReadyRef.current?.();

              // Fallback only: ready, but nothing ever becomes playable. Surface an
              // actionable error instead of a permanently blank black frame. Long
              // enough not to false-fail slow networks.
              renderCheck = setTimeout(() => {
                if (disposed) return;
                const p = playerRef.current;
                const st = window.YT?.PlayerState;
                if (!p || !readyRef.current || !st) return;
                const duration = p.getDuration?.() ?? 0;
                const state = p.getPlayerState?.();
                const rendering = state === st.CUED || state === st.PLAYING || state === st.BUFFERING;
                if (!duration && !rendering) {
                  // A startup stall rather than a bad video — offer a retry.
                  onErrorRef.current?.({
                    kind: 'api',
                    message: 'The YouTube player didn’t finish starting.',
                  });
                }
              }, 8000);
            },
            onStateChange: (event: { data: number }) => {
              const st = window.YT?.PlayerState;
              if (!st) return;
              const time = playerRef.current?.getCurrentTime() ?? 0;
              if (event.data === st.PLAYING) {
                hasPlayedRef.current = true;
                onPhaseRef.current?.('playing');
                const was = playingRef.current;
                playingRef.current = true;
                if (!was && canEmit()) onUserIntentRef.current?.('play', { time });
              } else if (event.data === st.PAUSED) {
                onPhaseRef.current?.('paused');
                const was = playingRef.current;
                playingRef.current = false;
                if (was && canEmit()) onUserIntentRef.current?.('pause', { time });
              } else if (event.data === st.ENDED) {
                onPhaseRef.current?.('ended');
                playingRef.current = false;
                if (canEmit()) {
                  onUserIntentRef.current?.('pause', { time: playerRef.current?.getDuration() ?? time });
                }
              } else if (event.data === st.BUFFERING) {
                onPhaseRef.current?.('buffering');
              } else if (event.data === st.CUED) {
                onPhaseRef.current?.('cued');
              }
            },
            onPlaybackRateChange: (event: { data: number }) => {
              if (canEmit()) {
                onUserIntentRef.current?.('rate', { rate: event.data, time: playerRef.current?.getCurrentTime() ?? 0 });
              }
            },
            onError: (event: { data: number }) => {
              onPhaseRef.current?.('error');
              // A video-level problem (private/removed/embedding disabled):
              // retrying the same id won't help, so it isn't retryable.
              onErrorRef.current?.({ kind: 'video', message: errorMessage(event.data) });
            },
          },
        });

        // Style the generated iframe immediately so sizing, playback permissions,
        // fullscreen denial, and pointer interactivity are correct before onReady.
        // Re-applied in onReady as belt-and-suspenders.
        styleIframe();

        handleRef.current = {
          getTime: () => playerRef.current?.getCurrentTime() ?? 0,
          getDuration: () => playerRef.current?.getDuration() ?? 0,
          // BUFFERING is an active-play state, not an intentional pause.
          isPaused: () => {
            const state = playerRef.current?.getPlayerState();
            const st = window.YT?.PlayerState;
            if (!st || state === undefined) return true;
            return state !== st.PLAYING && state !== st.BUFFERING;
          },
          play: () => {
            markProgrammatic();
            if (readyRef.current && playerRef.current) playerRef.current.playVideo();
            else pendingRef.current.playing = true;
          },
          pause: () => {
            markProgrammatic();
            // Never pause a never-played cued player — it blacks out the thumbnail.
            // It is already effectively "paused" (cued), so this is a safe no-op.
            if (!hasPlayedRef.current && isCued()) return;
            if (readyRef.current && playerRef.current) playerRef.current.pauseVideo();
            else pendingRef.current.playing = false;
          },
          seek: (seconds) => {
            markProgrammatic();
            const t = Math.max(0, seconds);
            // A seek-to-~0 on a never-played cued player also blacks the thumbnail;
            // leave it cued and let the real play (or a later seek) move it.
            if (!hasPlayedRef.current && isCued() && t < 0.5) return;
            if (readyRef.current && playerRef.current) playerRef.current.seekTo(t, true);
            else pendingRef.current.seek = t;
          },
          setRate: (rate) => {
            markProgrammatic();
            if (readyRef.current && playerRef.current) {
              const rates = playerRef.current.getAvailablePlaybackRates?.() ?? [1];
              if (rates.includes(rate)) playerRef.current.setPlaybackRate(rate);
            } else {
              pendingRef.current.rate = rate;
            }
          },
          ready: () => readyRef.current,
          // YouTube rates are a fixed set — drift uses bounded seek, not nudging,
          // and must not fight the player while it is buffering.
          canRateNudge: () => false,
          isBuffering: () => playerRef.current?.getPlayerState() === window.YT?.PlayerState.BUFFERING,
        };
      })
      .catch(() => {
        // Script blocked, network down, or the loader's own timeout. The loader
        // has already cleared its cache, so "Retry YouTube" starts fresh.
        if (!disposed) {
          onPhaseRef.current?.('error');
          onErrorRef.current?.({
            kind: 'api',
            message: 'Could not load the YouTube player. Check your connection and try again.',
          });
        }
      });

    return () => {
      disposed = true;
      if (renderCheck) clearTimeout(renderCheck);
      readyRef.current = false;
      handleRef.current = null;
      try {
        playerRef.current?.destroy();
      } catch {
        /* the iframe may already be gone */
      }
      playerRef.current = null;
      // Clear the manually-managed child (the iframe YouTube inserted). React
      // never owned it, so it must be removed by hand.
      if (mountRef.current) mountRef.current.innerHTML = '';
    };
    // Recreate ONLY on a true video identity change — not on callback changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId, handleRef, markProgrammatic, canEmit]);

  /* ---------------- local native-seek detection ---------------- */

  React.useEffect(() => {
    const id = setInterval(() => {
      if (!readyRef.current || !playerRef.current) return;
      const t = playerRef.current.getCurrentTime() ?? 0;
      const prev = lastTimeRef.current;
      lastTimeRef.current = t;
      // Ignore jumps caused by our own programmatic seeks / remote application.
      if (!canEmit()) return;
      const now = Date.now();
      if (isNativeSeek(prev, t, SEEK_THRESHOLD) && seekDebounceOk(lastSeekEmitRef.current, now, SEEK_DEBOUNCE_MS)) {
        lastSeekEmitRef.current = now;
        onUserIntentRef.current?.('seek', { time: t });
      }
    }, SEEK_POLL_MS);
    return () => clearInterval(id);
  }, [canEmit]);

  /* ---------------- fullscreen idle: let pointer events fall through ---------------- */

  React.useEffect(() => {
    const iframe = mountRef.current?.querySelector('iframe');
    if (!iframe) return;
    iframe.style.pointerEvents = iframeInteractive ? 'auto' : 'none';
  }, [iframeInteractive]);

  /* ---------------- volume / mute (command, never a rebuild) ---------------- */

  React.useEffect(() => {
    const player = playerRef.current;
    if (!player || !readyRef.current) return;
    player.setVolume(Math.round(volume * 100));
    if (muted) player.mute();
    else player.unMute();
  }, [muted, volume]);

  // Stable, React-owned wrapper. YouTube only ever touches a disposable child
  // created inside it (see the effect), so React reconciliation stays intact.
  return <div ref={mountRef} className="absolute inset-0 h-full w-full" />;
}
