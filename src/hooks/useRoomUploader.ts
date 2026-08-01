'use client';

/**
 * A ROOM-SCOPED upload controller, created before any file is chosen.
 *
 * This exists because refresh recovery was unreachable: the controller used to be
 * created inside `uploadRoomVideo` at the moment a file was selected, so
 * `pendingRecovery()` could not be consulted until AFTER the user had already
 * picked a file — which is exactly the question the recovery card is supposed to
 * answer first. A controller that lives with the room reads the persisted session
 * on mount, so the picker can offer "Resume upload of …" before anything is
 * chosen.
 *
 * It also survives a retryable failure. The controller holds the token, the File
 * and the provider-confirmed parts; destroying it on a transient network error
 * would turn "Try again" into "start over", so the room owns its lifetime and
 * only tears it down on unmount.
 */

import * as React from 'react';
import type { Socket } from 'socket.io-client';
import type { MediaSource } from '@/lib/types';
import { createRoomUploader, UploadError } from '@/lib/uploads';
import type { UploadController, UploadSnapshot } from '@/lib/multipartUpload';

export interface RoomUploader {
  /** Live engine state, or null before anything has been started/recovered. */
  snapshot: UploadSnapshot | null;
  /** A persisted session waiting for the user to reselect the same file. */
  hasRecovery: boolean;
  /** Start a NEW upload, or resume a recovered one if the file matches. */
  choose(file: File): Promise<MediaSource>;
  /** Resume the SAME session after a retryable failure — never a new intent. */
  retry(): Promise<void>;
  pause(): void;
  resume(): Promise<void>;
  cancel(): Promise<void>;
  /** Forget a finished/failed attempt so the picker returns to its idle state. */
  reset(): void;
}

export function useRoomUploader(
  socket: Socket,
  roomCode: string,
  onCompleted?: (source: MediaSource) => void,
): RoomUploader {
  const [snapshot, setSnapshot] = React.useState<UploadSnapshot | null>(null);
  const controllerRef = React.useRef<UploadController | null>(null);
  const completedRef = React.useRef(onCompleted);
  completedRef.current = onCompleted;

  /* One controller per room, created on mount so recovery is readable at once. */
  React.useEffect(() => {
    const controller = createRoomUploader(socket, roomCode, {
      onCompleted: (result) => completedRef.current?.(result.source as MediaSource),
    });
    controllerRef.current = controller;
    const unsubscribe = controller.subscribe(setSnapshot);

    /*
     * TEST-ONLY liveness probe, gated on a window flag the direct browser STRESS
     * gate sets before load. It reads the engine's debug() counters to assert that
     * active XHRs, slices, sleepers, workers and retry timers all return to zero
     * after many cancel/pause/refresh cycles. Count-only (no tokens, keys or file
     * bytes), so a normal session — where the flag is never set — exposes nothing.
     */
    const w = typeof window !== 'undefined' ? (window as unknown as Record<string, unknown>) : null;
    if (w && w.__CINEVERSE_UPLOAD_DEBUG__) w.__cineverseUploaderDebug = () => controller.debug();

    return () => {
      unsubscribe();
      controller.destroy();
      controllerRef.current = null;
      setSnapshot(null);
      if (w && w.__cineverseUploaderDebug) delete w.__cineverseUploaderDebug;
    };
  }, [socket, roomCode]);

  const choose = React.useCallback(async (file: File): Promise<MediaSource> => {
    const controller = controllerRef.current;
    if (!controller) throw new UploadError('UPLOAD_FAILED');

    return new Promise<MediaSource>((resolve, reject) => {
      /*
       * BEGIN THE ACTION BEFORE OBSERVING.
       *
       * `subscribe()` fires its listener synchronously with the CURRENT snapshot.
       * Observing first therefore let a PRIOR attempt's terminal phase settle this
       * promise before the new action ever ran — a reselect after a cancel saw
       * `cancelled` and rejected with ABORTED, and a reselect after a terminal
       * failure rejected with the stale error, both before `start()` changed the
       * phase. That was the room-reuse bug.
       *
       * Starting first closes the window: `start()` moves the phase to `starting`
       * synchronously (there is no await before it does), and a fresh recovery
       * begins from `idle`, so by the time we subscribe the phase is never a stale
       * terminal one. No transition can occur in the synchronous gap between the
       * two calls, so subscribing after cannot miss a real completed/failed.
       *
       * RESUME, never restart, when a recovered session is waiting: `start()` would
       * mint a second upload:intent and abandon the parts the provider already
       * holds. `resume(file)` validates the fingerprint first and rejects a
       * different file with FILE_MISMATCH, leaving the session intact and resumable.
       */
      const action = controller.pendingRecovery() ? controller.resume(file) : controller.start(file);

      const stop = controller.subscribe((s) => {
        if (s.phase === 'completed') {
          stop();
          // The source itself arrives through onCompleted; the room applies it.
          resolve({ type: 'url', value: '', label: s.fileName } as MediaSource);
        } else if (s.phase === 'failed') {
          stop();
          reject(new UploadError(s.error || 'UPLOAD_FAILED', s.totalBytes));
        } else if (s.phase === 'cancelled') {
          stop();
          reject(new UploadError('ABORTED'));
        }
      });

      void action.catch((err) => {
        stop();
        reject(err instanceof UploadError ? err : new UploadError('UPLOAD_FAILED'));
      });
    });
  }, []);

  const retry = React.useCallback(async () => {
    // The SAME session: no new intent, no re-sliced completed parts.
    await controllerRef.current?.retry();
  }, []);

  const pause = React.useCallback(() => controllerRef.current?.pause(), []);
  const resume = React.useCallback(async () => {
    await controllerRef.current?.resume();
  }, []);
  const cancel = React.useCallback(async () => {
    await controllerRef.current?.cancel();
  }, []);
  const reset = React.useCallback(() => setSnapshot(controllerRef.current?.getSnapshot() ?? null), []);

  return {
    snapshot,
    hasRecovery: Boolean(snapshot?.recovery),
    choose,
    retry,
    pause,
    resume,
    cancel,
    reset,
  };
}
