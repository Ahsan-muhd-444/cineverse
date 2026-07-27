'use client';

import * as React from 'react';
import type { PlayerHandle } from '@/hooks/useSyncedPlayback';

/* Minimal shape of the bits of the YouTube IFrame API we actually touch. */
interface YTPlayer {
  playVideo: () => void;
  pauseVideo: () => void;
  seekTo: (seconds: number, allowSeekAhead: boolean) => void;
  getCurrentTime: () => number;
  getDuration: () => number;
  getPlayerState: () => number;
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
      PlayerState: { PLAYING: number; PAUSED: number; ENDED: number; BUFFERING: number };
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiPromise: Promise<void> | null = null;

function loadApi(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (window.YT?.Player) return Promise.resolve();
  if (apiPromise) return apiPromise;

  apiPromise = new Promise<void>((resolve) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve();
    };
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.async = true;
    document.head.appendChild(script);
  });
  return apiPromise;
}

/**
 * Wraps a YouTube embed behind the same PlayerHandle the HTML5 engine exposes,
 * so the sync layer never has to care which one is on screen.
 */
export function YouTubeEngine({
  videoId,
  handleRef,
  onStateChange,
  onReady,
  muted,
  volume,
}: {
  videoId: string;
  handleRef: React.MutableRefObject<PlayerHandle | null>;
  onStateChange?: (playing: boolean) => void;
  onReady?: () => void;
  muted: boolean;
  volume: number;
}) {
  const mountRef = React.useRef<HTMLDivElement>(null);
  const playerRef = React.useRef<YTPlayer | null>(null);
  const readyRef = React.useRef(false);

  React.useEffect(() => {
    let disposed = false;

    loadApi().then(() => {
      if (disposed || !mountRef.current || !window.YT) return;

      playerRef.current = new window.YT.Player(mountRef.current, {
        videoId,
        playerVars: {
          controls: 0,
          modestbranding: 1,
          rel: 0,
          playsinline: 1,
          disablekb: 1,
          iv_load_policy: 3,
          fs: 0,
        },
        events: {
          onReady: () => {
            readyRef.current = true;
            onReady?.();
          },
          onStateChange: (event: { data: number }) => {
            const state = window.YT?.PlayerState;
            if (!state) return;
            if (event.data === state.PLAYING) onStateChange?.(true);
            if (event.data === state.PAUSED || event.data === state.ENDED) onStateChange?.(false);
          },
        },
      });

      handleRef.current = {
        getTime: () => playerRef.current?.getCurrentTime() ?? 0,
        getDuration: () => playerRef.current?.getDuration() ?? 0,
        isPaused: () => playerRef.current?.getPlayerState() !== window.YT?.PlayerState.PLAYING,
        play: () => playerRef.current?.playVideo(),
        pause: () => playerRef.current?.pauseVideo(),
        seek: (seconds) => playerRef.current?.seekTo(Math.max(0, seconds), true),
        setRate: (rate) => playerRef.current?.setPlaybackRate(rate),
        ready: () => readyRef.current,
      };
    });

    return () => {
      disposed = true;
      readyRef.current = false;
      handleRef.current = null;
      try {
        playerRef.current?.destroy();
      } catch {
        /* the iframe may already be gone */
      }
      playerRef.current = null;
    };
  }, [videoId, handleRef, onReady, onStateChange]);

  React.useEffect(() => {
    const player = playerRef.current;
    if (!player || !readyRef.current) return;
    player.setVolume(Math.round(volume * 100));
    if (muted) player.mute();
    else player.unMute();
  }, [muted, volume]);

  return (
    <div className="absolute inset-0">
      <div ref={mountRef} className="h-full w-full" />
      {/* Swallow clicks so YouTube's own UI can never desync the room */}
      <div className="absolute inset-0" aria-hidden />
    </div>
  );
}
