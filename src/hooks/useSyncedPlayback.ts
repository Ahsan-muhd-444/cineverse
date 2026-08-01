'use client';

import * as React from 'react';
import type { Socket } from 'socket.io-client';
import { serverNow } from '@/lib/socket';
import {
  normalizeRate,
  projectPlaybackState,
  shouldPromptPlaybackGesture,
  type ServerPlaybackState,
} from '@/hooks/playbackProjection';

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
  /**
   * Whether this engine can absorb small drift by nudging playback rate a few
   * percent. HTML5 video can; YouTube only accepts a fixed rate set, so it
   * returns false and drift is corrected by a bounded seek instead. Optional:
   * an engine that omits it is assumed to support rate nudging.
   */
  canRateNudge?: () => boolean;
  /** Whether the engine is actively buffering — drift correction backs off then. */
  isBuffering?: () => boolean;
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
  // The room's authoritative playback rate. Drift nudges and restores relative
  // to this, never to a hard-coded 1x, so a 1.5x room stays at 1.5x.
  const baseRateRef = React.useRef(1);
  // The server's control epoch. Heartbeats must carry the current controlSeq +
  // sourceVersion or the server rejects them, so a stale/background client can't
  // overwrite room state after someone else takes control or the source changes.
  const controlSeqRef = React.useRef(0);
  const sourceVersionRef = React.useRef(0);
  const [lastRemote, setLastRemote] = React.useState<{ action: SyncAction; by: string; at: number } | null>(null);
  const [drift, setDrift] = React.useState(0);

  // Set when a remote/resync play attempt fails to actually start the engine —
  // the browser blocked unmuted autoplay because no gesture happened on this
  // device. The UI surfaces a "Join playback" affordance; a single click then
  // resumes at the room's current position (see joinPlaybackAfterGesture).
  const [needsPlaybackGesture, setNeedsPlaybackGesture] = React.useState(false);
  // The most recent authoritative room state we have seen (from sync:request or
  // a remote sync:control). The join affordance projects THIS to now so the
  // guest lands on the current frame, without emitting a fresh control.
  const lastAuthoritativeStateRef = React.useRef<ServerPlaybackState | null>(null);
  const gestureCheckRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // `resync` is defined further down but needed by `emitControl` above it, so it
  // is reached through a ref rather than reordering the whole hook.
  const resyncRef = React.useRef<(() => void) | null>(null);

  const isApplying = React.useCallback(() => Date.now() < applyingUntil.current, []);

  const clearGestureCheck = React.useCallback(() => {
    if (gestureCheckRef.current) {
      clearTimeout(gestureCheckRef.current);
      gestureCheckRef.current = null;
    }
  }, []);

  /**
   * After asking the engine to play, give it a beat and check whether it
   * actually started. YouTube's playVideo() does not reliably reject when
   * autoplay is blocked, so detection is state-based: ready but still paused
   * means the browser needs a user gesture. We then raise the join affordance.
   */
  const scheduleGestureCheck = React.useCallback(() => {
    clearGestureCheck();
    gestureCheckRef.current = setTimeout(() => {
      gestureCheckRef.current = null;
      const handle = handleRef.current;
      if (!handle) return;
      if (shouldPromptPlaybackGesture(handle.ready(), handle.isPaused())) {
        setNeedsPlaybackGesture(true);
      }
    }, 900);
  }, [handleRef, clearGestureCheck]);

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

      // Settles exactly once — on the server's verdict or on a timeout. The
      // engine has ALREADY moved locally (the user pressed the button), so a
      // control the room never accepted leaves this client alone with its own
      // idea of the playhead. Both failure paths therefore go and ask.
      let settled = false;
      const finish = (accepted: boolean, res?: { controlSeq?: number; sourceVersion?: number }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (accepted) {
          // Adopt the epoch the server accepted, so our heartbeats are trusted.
          if (typeof res?.controlSeq === 'number') controlSeqRef.current = res.controlSeq;
          if (typeof res?.sourceVersion === 'number') sourceVersionRef.current = res.sourceVersion;
          return;
        }
        // Rejected or unanswered: our epoch refs are deliberately left untouched,
        // so heartbeats keep carrying the old (correct) sequence rather than
        // claiming a control the room never granted. Pull the truth instead of
        // guessing at it — resync also re-adopts the authoritative epoch.
        resyncRef.current?.();
      };
      const timer = setTimeout(() => finish(false), 8000);

      socket.emit(
        'sync:control',
        { action, time, rate: extra?.rate ?? 1 },
        (res: { ok?: boolean; controlSeq?: number; sourceVersion?: number } | null) => {
          // Only an explicit `ok` counts as acceptance; anything else resyncs.
          finish(res?.ok === true, res || undefined);
        },
      );
    },
    [socket, enabled, handleRef],
  );

  /**
   * Ease the playhead back into place without a visible jump, nudging RELATIVE
   * to the room's base rate and restoring to that base — not to a blind 1x.
   */
  const easeTo = React.useCallback(
    (delta: number, baseRate: number) => {
      const handle = handleRef.current;
      if (!handle) return;
      // Run 6% fast or slow (relative to the base rate) until `delta` is absorbed.
      const direction = delta > 0 ? 1 : -1;
      const rate = baseRate * (1 + direction * 0.06);
      // Catch-up speed is baseRate*0.06 per second, so the time to close `delta`.
      const duration = Math.min(4000, (Math.abs(delta) / (0.06 * baseRate)) * 1000);
      handle.setRate(rate);
      if (rateNudge.current) clearTimeout(rateNudge.current);
      // Restore to the room's CURRENT authoritative rate — which may have changed
      // during the nudge — not the value captured when the nudge began.
      rateNudge.current = setTimeout(() => handle.setRate(baseRateRef.current), duration);
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
      controlSeq?: number;
      sourceVersion?: number;
    }) => {
      const handle = handleRef.current;
      if (!handle || !handle.ready()) return;

      // Someone else took control — adopt their epoch so OUR heartbeats stop
      // being trusted until we control again.
      if (typeof payload.controlSeq === 'number') controlSeqRef.current = payload.controlSeq;
      if (typeof payload.sourceVersion === 'number') sourceVersionRef.current = payload.sourceVersion;

      guard();
      // Every control carries the room's authoritative rate; keep our base in step.
      const rate = normalizeRate(payload.rate);
      baseRateRef.current = rate;
      // Transit time is real seconds; the playhead it advanced is scaled by rate.
      const inFlight = Math.max(0, (serverNow() - payload.issuedAt) / 1000) * rate;

      // Cache the room's state so the join affordance can resume from it. play/
      // pause set the playing flag directly; seek/rate keep the last known flag.
      const prevPlaying = lastAuthoritativeStateRef.current?.playing ?? !handle.isPaused();
      lastAuthoritativeStateRef.current = {
        time: payload.time,
        playing: payload.action === 'play' ? true : payload.action === 'pause' ? false : prevPlaying,
        rate,
        serverTime: payload.issuedAt,
        controlSeq: payload.controlSeq,
        sourceVersion: payload.sourceVersion,
      };

      switch (payload.action) {
        case 'play': {
          // Add the time the message spent travelling, so both sides land together.
          handle.setRate(rate);
          handle.seek(payload.time + inFlight);
          void handle.play();
          // The remote play may be blocked by autoplay policy on this device;
          // check shortly after and raise the join affordance if it didn't start.
          scheduleGestureCheck();
          break;
        }
        case 'pause': {
          handle.pause();
          handle.seek(payload.time);
          // A pause resolves any pending "did it start?" — nothing to join now.
          clearGestureCheck();
          setNeedsPlaybackGesture(false);
          break;
        }
        case 'seek': {
          handle.seek(payload.time + (handle.isPaused() ? 0 : inFlight));
          break;
        }
        case 'rate': {
          handle.setRate(rate);
          break;
        }
      }

      setLastRemote({ action: payload.action, by: payload.by, at: Date.now() });
      onRemoteAction?.(payload.action, payload.by);
    };

    const onSourceChanged = () => {
      guard(1500);
      // A new source invalidates any pending join affordance for the old one.
      clearGestureCheck();
      setNeedsPlaybackGesture(false);
      lastAuthoritativeStateRef.current = null;
    };

    socket.on('sync:control', onControl);
    socket.on('source:set', onSourceChanged);
    return () => {
      socket.off('sync:control', onControl);
      socket.off('source:set', onSourceChanged);
    };
  }, [socket, enabled, guard, handleRef, onRemoteAction, scheduleGestureCheck, clearGestureCheck]);

  /* ---------------- drift correction + heartbeat ---------------- */

  React.useEffect(() => {
    if (!enabled) return;

    const tick = () => {
      const handle = handleRef.current;
      if (!handle || !handle.ready() || isApplying()) return;
      // Don't fight the player while it is buffering — the position it reports is
      // in flux and a correction now would just cause a second stall.
      if (handle.isBuffering?.()) return;

      socket.emit(
        'sync:request',
        null,
        (state: ServerPlaybackState | null) => {
          if (!state) return;
          lastAuthoritativeStateRef.current = state;
          // Adopt the authoritative epoch so our heartbeats carry the right seq/version.
          if (typeof state.controlSeq === 'number') controlSeqRef.current = state.controlSeq;
          if (typeof state.sourceVersion === 'number') sourceVersionRef.current = state.sourceVersion;
          // If the engine is actually playing now, any join affordance is stale.
          if (!handle.isPaused()) setNeedsPlaybackGesture(false);
          const local = handle.getTime();
          const roomRate = normalizeRate(state.rate);
          baseRateRef.current = roomRate;
          // Project the room's answer to *now*, scaling elapsed time by the rate.
          const projected = projectPlaybackState(state, serverNow());
          const delta = projected - local;
          setDrift(delta);

          if (Math.abs(delta) < softTolerance) return;

          if (Math.abs(delta) > hardTolerance) {
            guard(600);
            handle.setRate(roomRate);
            handle.seek(projected);
          } else if (handle.canRateNudge?.() === false) {
            // Engines with a fixed rate set (YouTube) can't be micro-nudged.
            // Correct moderate drift with a single guarded seek instead, keeping
            // the base rate correct, and leave small drift alone.
            if (Math.abs(delta) > softTolerance * 2) {
              guard(600);
              handle.setRate(roomRate);
              handle.seek(projected);
            }
          } else {
            // HTML5: nudge relative to the room's base rate, restore to it.
            easeTo(delta, roomRate);
          }
        },
      );
    };

    const report = () => {
      const handle = handleRef.current;
      if (!handle || !handle.ready() || handle.isPaused()) return;
      // A buffering engine (esp. a YouTube iframe) reports a stuck time; sending
      // it would rewind the room's projection, so hold the heartbeat.
      if (handle.isBuffering?.()) return;
      socket.emit('sync:report', {
        time: handle.getTime(),
        playing: true,
        controlSeq: controlSeqRef.current,
        sourceVersion: sourceVersionRef.current,
      });
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
      (state: ServerPlaybackState | null) => {
        if (!state) return;
        lastAuthoritativeStateRef.current = state;
        // Adopt the authoritative epoch (source just loaded / we just rejoined).
        if (typeof state.controlSeq === 'number') controlSeqRef.current = state.controlSeq;
        if (typeof state.sourceVersion === 'number') sourceVersionRef.current = state.sourceVersion;
        guard(900);
        const roomRate = normalizeRate(state.rate);
        baseRateRef.current = roomRate;
        // Match the room's rate before seeking so the player advances correctly.
        handle.setRate(roomRate);
        const projected = projectPlaybackState(state, serverNow());
        handle.seek(projected);
        if (state.playing) {
          void handle.play();
          // Joining an already-playing room is the classic blocked-autoplay case;
          // verify it started and raise the join affordance if not.
          scheduleGestureCheck();
        } else {
          handle.pause();
        }
      },
    );
  }, [socket, handleRef, guard, scheduleGestureCheck]);

  // Published for `emitControl`, which needs it before it exists in source order.
  React.useEffect(() => {
    resyncRef.current = resync;
    return () => {
      resyncRef.current = null;
    };
  }, [resync]);

  /**
   * Resume playback from a real user gesture after autoplay was blocked. Reads
   * the cached authoritative state, projects it to now, and — in the SAME click
   * handler — sets rate, seeks, and plays so the browser accepts it as
   * gesture-initiated. Deliberately does NOT emit a sync:control: the guest is
   * only joining the current playback, not taking control of the room.
   */
  const joinPlaybackAfterGesture = React.useCallback(() => {
    const handle = handleRef.current;
    if (!handle) return;
    clearGestureCheck();
    setNeedsPlaybackGesture(false);
    // Treat the follow-up native play/seek events as programmatic so the engine
    // doesn't echo them back to the room as a fresh local control.
    guard(1200);
    const state = lastAuthoritativeStateRef.current;
    if (state) {
      const roomRate = normalizeRate(state.rate);
      baseRateRef.current = roomRate;
      handle.setRate(roomRate);
      handle.seek(projectPlaybackState(state, serverNow()));
    }
    void handle.play();
    // Correct any small offset that opened up between the click and playback
    // actually starting.
    setTimeout(() => resync(), 450);
  }, [handleRef, guard, clearGestureCheck, resync]);

  // Tidy the pending gesture check on unmount.
  React.useEffect(() => clearGestureCheck, [clearGestureCheck]);

  return {
    emitControl,
    isApplying,
    guard,
    resync,
    lastRemote,
    drift,
    needsPlaybackGesture,
    joinPlaybackAfterGesture,
  };
}
