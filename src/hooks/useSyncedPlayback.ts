'use client';

import * as React from 'react';
import type { Socket } from 'socket.io-client';
import { serverNow } from '@/lib/socket';

/**
 * Anything the sync engine needs from a player, whether it is an HTML5 <video>
 * or a YouTube iframe. Keeping this narrow is what lets both behave identically.
 */
export interface PlayerHandle {
  getTime: () => number;
  getDuration: () => number;
  isPaused: () => boolean;
  play: () => void | Promise<void>;
  pause: () => void;
  seek: (seconds: number) => void;
  setRate: (rate: number) => void;
  ready: () => boolean;
}

export type SyncAction = 'play' | 'pause' | 'seek' | 'rate';

export interface SyncOptions {
  /** Above this many seconds of drift we hard-seek instead of easing. */
  hardTolerance?: number;
  /** Below this we do nothing at all — chasing noise looks worse than tiny drift. */
  softTolerance?: number;
  enabled?: boolean;
  onRemoteAction?: (action: SyncAction, by: string) => void;
}

/**
 * Keeps two players on the same frame.
 *
 * Three mechanisms, in order of how often they fire:
 *
 *  1. Control events — someone pressed play/pause/seek. The event carries the
 *     initiator's playhead and the server timestamp it happened at, so the
 *     receiver can add the transit time back in instead of landing late.
 *  2. Drift correction — every few seconds we ask the server where the room
 *     should be. Small errors are absorbed by nudging playback rate (invisible);
 *     large ones get a seek.
 *  3. Heartbeat — whoever is playing keeps the server's clock honest.
 */
export function useSyncedPlayback(
  socket: Socket,
  handleRef: React.MutableRefObject<PlayerHandle | null>,
  options: SyncOptions = {},
) {
  const { hardTolerance = 1.2, softTolerance = 0.25, enabled = true, onRemoteAction } = options;

  // While we are applying a remote instruction, the player fires its own
  // play/pause/seeked events. This window stops us echoing them back.
  const applyingUntil = React.useRef(0);
  const rateNudge = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const [lastRemote, setLastRemote] = React.useState<{ action: SyncAction; by: string; at: number } | null>(null);
  const [drift, setDrift] = React.useState(0);

  const isApplying = React.useCallback(() => Date.now() < applyingUntil.current, []);

  const guard = React.useCallback((ms = 700) => {
    applyingUntil.current = Date.now() + ms;
  }, []);

  /**
   * Emit a control the local user initiated.
   *
   * This is only ever called from a real interaction (a click, a key, a scrub) —
   * never from the media element's own events — so it must NOT be suppressed by
   * the apply-guard. Doing so silently dropped the first press after any
   * programmatic seek, and drift correction then pulled playback back to the
   * server's stale "paused" state.
   */
  const emitControl = React.useCallback(
    (action: SyncAction, extra?: { time?: number; rate?: number }) => {
      if (!enabled) return;
      const handle = handleRef.current;
      const time = extra?.time ?? handle?.getTime() ?? 0;
      // A local intent overrides any in-flight remote application.
      applyingUntil.current = 0;
      socket.emit('sync:control', { action, time, rate: extra?.rate ?? 1 });
    },
    [socket, enabled, handleRef],
  );

  /** Ease the playhead back into place without a visible jump. */
  const easeTo = React.useCallback(
    (delta: number) => {
      const handle = handleRef.current;
      if (!handle) return;
      // Run 6% fast or slow for as long as it takes to absorb `delta`.
      const direction = delta > 0 ? 1 : -1;
      const rate = 1 + direction * 0.06;
      const duration = Math.min(4000, (Math.abs(delta) / 0.06) * 1000);
      handle.setRate(rate);
      if (rateNudge.current) clearTimeout(rateNudge.current);
      rateNudge.current = setTimeout(() => handle.setRate(1), duration);
    },
    [handleRef],
  );

  /* ---------------- remote controls ---------------- */

  React.useEffect(() => {
    if (!enabled) return;

    const onControl = (payload: {
      action: SyncAction;
      time: number;
      rate: number;
      issuedAt: number;
      by: string;
    }) => {
      const handle = handleRef.current;
      if (!handle || !handle.ready()) return;

      guard();
      const inFlight = Math.max(0, (serverNow() - payload.issuedAt) / 1000);

      switch (payload.action) {
        case 'play': {
          // Add the time the message spent travelling, so both sides land together.
          handle.seek(payload.time + inFlight);
          void handle.play();
          break;
        }
        case 'pause': {
          handle.pause();
          handle.seek(payload.time);
          break;
        }
        case 'seek': {
          handle.seek(payload.time + (handle.isPaused() ? 0 : inFlight));
          break;
        }
        case 'rate': {
          handle.setRate(payload.rate || 1);
          break;
        }
      }

      setLastRemote({ action: payload.action, by: payload.by, at: Date.now() });
      onRemoteAction?.(payload.action, payload.by);
    };

    const onSourceChanged = () => {
      guard(1500);
    };

    socket.on('sync:control', onControl);
    socket.on('source:set', onSourceChanged);
    return () => {
      socket.off('sync:control', onControl);
      socket.off('source:set', onSourceChanged);
    };
  }, [socket, enabled, guard, handleRef, onRemoteAction]);

  /* ---------------- drift correction + heartbeat ---------------- */

  React.useEffect(() => {
    if (!enabled) return;

    const tick = () => {
      const handle = handleRef.current;
      if (!handle || !handle.ready() || isApplying()) return;

      socket.emit(
        'sync:request',
        null,
        (state: { time: number; playing: boolean; rate: number; serverTime: number } | null) => {
          if (!state) return;
          const local = handle.getTime();
          // The server answered a moment ago; project its answer to *now*.
          const projected = state.playing
            ? state.time + Math.max(0, (serverNow() - state.serverTime) / 1000)
            : state.time;
          const delta = projected - local;
          setDrift(delta);

          if (Math.abs(delta) < softTolerance) return;

          if (Math.abs(delta) > hardTolerance) {
            guard(600);
            handle.seek(projected);
          } else {
            easeTo(delta);
          }
        },
      );
    };

    const report = () => {
      const handle = handleRef.current;
      if (!handle || !handle.ready() || handle.isPaused()) return;
      socket.emit('sync:report', { time: handle.getTime(), playing: true });
    };

    const driftTimer = setInterval(tick, 2500);
    const reportTimer = setInterval(report, 3000);
    return () => {
      clearInterval(driftTimer);
      clearInterval(reportTimer);
      if (rateNudge.current) clearTimeout(rateNudge.current);
    };
  }, [socket, enabled, handleRef, isApplying, guard, easeTo, hardTolerance, softTolerance]);

  /** Pull the room's current position — used right after a source loads. */
  const resync = React.useCallback(() => {
    const handle = handleRef.current;
    if (!handle) return;
    socket.emit(
      'sync:request',
      null,
      (state: { time: number; playing: boolean; serverTime: number } | null) => {
        if (!state) return;
        guard(900);
        const projected = state.playing
          ? state.time + Math.max(0, (serverNow() - state.serverTime) / 1000)
          : state.time;
        handle.seek(projected);
        if (state.playing) void handle.play();
        else handle.pause();
      },
    );
  }, [socket, handleRef, guard]);

  return { emitControl, isApplying, guard, resync, lastRemote, drift };
}
