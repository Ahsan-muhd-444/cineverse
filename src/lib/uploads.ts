'use client';

import type { Socket } from 'socket.io-client';
import type { MediaSource } from '@/lib/types';
import { createUploadController, type UploadController, type UploadEngineDeps } from '@/lib/multipartUpload';
import { sessionStore } from '@/lib/uploadRecovery';

/**
 * Client half of the shared-upload pipeline.
 *
 * The server is the authority on what may be uploaded AND on which transport
 * carries it — this module never duplicates the allowlist, the size cap, or the
 * single-vs-multipart decision. It asks for an intent and does what it is told.
 *
 * Bytes travel over plain HTTP (XHR, for upload progress), never through
 * Socket.IO. For a large file the engine in multipartUpload.ts sends independent
 * `File.slice()` ranges straight to object storage, so a 3 GB film is never held
 * in memory, in React state, or in a websocket frame.
 *
 * Two entry points:
 *   `uploadRoomVideo`      one-shot promise, for the simple picker flow
 *   `createRoomUploader`   the full controller (pause/resume/cancel/recovery)
 */

export class UploadError extends Error {
  code: string;
  maxBytes?: number;

  constructor(code: string, maxBytes?: number) {
    super(code);
    this.name = 'UploadError';
    this.code = code;
    this.maxBytes = maxBytes;
  }
}

/** Human-readable size for error copy. */
function formatLimit(bytes?: number): string {
  if (!bytes || !Number.isFinite(bytes)) return 'the limit';
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(0)} GB` : `${Math.round(mb)} MB`;
}

/** Map a server error code to something actionable for the viewer. */
export function describeUploadError(code: string, maxBytes?: number): string {
  switch (code) {
    case 'UNSUPPORTED_TYPE':
      return 'That file type can’t be streamed in a browser. Use an MP4, WebM, or OGG video.';
    case 'TOO_LARGE':
      return `That file is bigger than ${formatLimit(maxBytes)}. Try a smaller file, or play it on this device only.`;
    case 'BAD_SIZE':
      return 'That file looks empty. Pick another one.';
    case 'UNAUTHORIZED':
      return 'You’re not in the room any more. Rejoin and try again.';
    case 'UPLOADS_DISABLED':
      return 'Uploads aren’t available in this demo yet. Pick a built-in recommended movie, or play a video on this device only.';
    case 'STORAGE_UNAVAILABLE':
      return 'Shared uploads aren’t available right now. You can still play it on this device only.';
    case 'CONFIGURATION_ERROR':
      return 'Shared uploads aren’t configured correctly on this server. You can still play it on this device only.';
    case 'MULTIPART_REQUIRED':
      return `Files over ${formatLimit(maxBytes)} need resumable uploads, which aren’t enabled on this server. You can still play it on this device only.`;
    case 'UPLOAD_ALREADY_ACTIVE':
      return 'You already have an upload running. Cancel it before starting another.';
    case 'ROOM_UPLOAD_LIMIT':
      return 'This room already has as many uploads running as it allows.';
    case 'SESSION_REGISTRY_FULL':
      return 'The server is handling as many uploads as it can right now. Try again in a moment.';
    case 'MISSING_ETAG':
      return 'The storage bucket didn’t return an ETag for a part. Its CORS settings need to expose the ETag header.';
    case 'NOT_UPLOADED':
      return 'The upload didn’t finish. Try again.';
    case 'BAD_CONTENT':
      return 'The uploaded file didn’t match what was expected. Try again with an MP4, WebM, or OGG video.';
    case 'SIZE_MISMATCH':
      return 'The finished file wasn’t the size we expected. Try uploading again.';
    case 'NO_SUCH_UPLOAD':
      return 'That upload is no longer available on the server. Start it again.';
    case 'FILE_MISMATCH':
      return 'That isn’t the same file that started the upload.';
    case 'BAD_TOKEN':
    case 'WRONG_ROOM':
    case 'WRONG_MEMBER':
      return 'That upload expired. Pick the file again.';
    case 'RATE_LIMITED':
      return 'Too many upload requests just now. Give it a moment and try again.';
    case 'ABORTED':
      return 'Upload cancelled.';
    case 'CANCEL_FAILED':
      return 'Couldn’t reach the server to cancel. Try cancelling again.';
    case 'SUPERSEDED':
      // Not a failure: the file uploaded fine, but a newer choice is on screen.
      return 'The upload finished, but you picked something else in the meantime.';
    default:
      return 'The upload failed. Check your connection and try again.';
  }
}

/**
 * Promise wrapper around a Socket.IO ack, with a timeout so the UI can't hang.
 *
 * The timeout is generous for completion: assembling a 192-part object and
 * HEAD-ing it is several provider round-trips, and a 12s ceiling would abandon an
 * upload that is about to succeed.
 */
const ACK_TIMEOUT_MS: Record<string, number> = {
  'upload:complete': 60_000,
  'upload:status': 30_000,
  'upload:part-targets': 20_000,
};

export function socketRequest(socket: Socket) {
  return function request<T>(event: string, payload: unknown): Promise<T> {
    const timeoutMs = ACK_TIMEOUT_MS[event] ?? 12_000;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new UploadError('TIMEOUT')), timeoutMs);
      socket.emit(event, payload, (res: T) => {
        clearTimeout(timer);
        resolve(res);
      });
    });
  };
}

/**
 * The full upload controller for a room.
 *
 * The React layer subscribes to snapshots and calls pause/resume/cancel; it never
 * schedules a part, computes a retry delay, or decides when an upload is done.
 */
export function createRoomUploader(
  socket: Socket,
  roomCode: string,
  options: Partial<Omit<UploadEngineDeps, 'request' | 'roomCode'>> = {},
): UploadController {
  const controller = createUploadController({
    request: socketRequest(socket),
    roomCode,
    // Tab-scoped: a session capability must not outlive the tab that owns it.
    store: options.store !== undefined ? options.store : sessionStore(),
    isOnline: options.isOnline || (() => (typeof navigator === 'undefined' ? true : navigator.onLine)),
    ...options,
  });

  /*
   * Wire the browser's connectivity signals into the engine.
   *
   * The engine reacts to online/offline through `setOnline`, but something has to
   * CALL it — otherwise a dropped network leaves parts retrying blindly instead of
   * suspending the upload and excluding the gap from the speed estimate. The
   * socket's own connect/disconnect are the most accurate signal (a websocket drop
   * is exactly when the control channel is unusable); `window` online/offline
   * cover the case where the socket has not noticed yet. Both are torn down when
   * the controller is destroyed.
   */
  if (typeof window !== 'undefined') {
    const goOnline = () => controller.setOnline(true);
    const goOffline = () => controller.setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    socket.on('connect', goOnline);
    socket.on('disconnect', goOffline);
    const destroy = controller.destroy.bind(controller);
    controller.destroy = () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
      socket.off('connect', goOnline);
      socket.off('disconnect', goOffline);
      destroy();
    };
  }

  return controller;
}

/**
 * Upload a local video and resolve with the shared source both members can play.
 *
 * A thin promise over the controller, kept because the picker's simple flow reads
 * better this way. `onSnapshot` exposes the full live state (speed, ETA, parts) to
 * a caller that wants to render it, and `onProgress` keeps the older
 * fraction-based callers working.
 *
 * Deliberately does NOT set the room source — the caller owns that, so the picker
 * keeps its existing `onChoose` flow and the sync authority is untouched.
 */
export function uploadRoomVideo(
  socket: Socket,
  file: File,
  /**
   * `roomCode` is MANDATORY. It scopes the persisted recovery session, so a
   * fallback placeholder would file every room's recovery under one key and let
   * a session from room A be offered in room B.
   */
  options: {
    roomCode: string;
    onProgress?: (fraction: number) => void;
    onSnapshot?: (snapshot: ReturnType<UploadController['getSnapshot']>) => void;
    onController?: (controller: UploadController) => void;
    signal?: AbortSignal;
  },
): Promise<MediaSource> {
  return new Promise<MediaSource>((resolve, reject) => {
    let settled = false;
    let unsubscribe = () => {};
    let controller: UploadController | null = null;

    const finish = (fn: () => void, { keepController = false } = {}) => {
      if (settled) return;
      settled = true;
      unsubscribe();
      if (options.signal) options.signal.removeEventListener('abort', onAbort);
      const target = controller;
      fn();
      /*
       * Do NOT destroy a controller whose session is still resumable.
       *
       * Destroying on any `failed` phase threw away the token, the File and the
       * confirmed parts for a transient network blip — so "Try again" could only
       * mean "start a brand-new upload". A retryable failure keeps everything and
       * the caller calls `retry()` on the same controller (which it received via
       * `onController`).
       */
      if (!keepController) target?.destroy();
    };

    function onAbort() {
      const target = controller;
      // Cancel is idempotent and aborts the provider session; the failure path
      // below turns it into a rejected promise.
      void target?.cancel();
      finish(() => reject(new UploadError('ABORTED')));
    }

    controller = createRoomUploader(socket, options.roomCode, {
      // Completion carries the verified source object, so it is passed through
      // exactly as the server built it.
      onCompleted: (result) => finish(() => resolve(result.source as MediaSource)),
      onFailed: (code) =>
        finish(() => reject(new UploadError(code, controller?.getSnapshot().totalBytes)), {
          keepController: controller?.getSnapshot().retryable === true,
        }),
    });
    options.onController?.(controller);

    unsubscribe = controller.subscribe((snapshot) => {
      options.onSnapshot?.(snapshot);
      if (options.onProgress && snapshot.totalBytes > 0) {
        options.onProgress(snapshot.uploadedBytes / snapshot.totalBytes);
      }
    });

    if (options.signal) {
      if (options.signal.aborted) return onAbort();
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    void controller.start(file).catch((err) => {
      finish(() => reject(err instanceof UploadError ? err : new UploadError('UPLOAD_FAILED')));
    });
  });
}
