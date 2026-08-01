'use client';

/**
 * The resumable browser upload engine.
 *
 * Framework-independent on purpose: React components subscribe to snapshots and
 * render buttons, and none of the scheduling, retry, backoff, byte accounting or
 * recovery logic lives in a component. That split is what makes this testable
 * without a DOM — every dependency that touches the outside world is injected
 * (the socket request function, the XHR factory, the clock, timers, the jitter
 * source, the online signal, the persistence store).
 *
 * THE BYTE PATH, which the rest of this file exists to protect:
 *
 *   file.slice(start, end)  ->  XHR PUT  ->  object storage
 *
 * A movie never enters Socket.IO, never becomes base64, never becomes a complete
 * ArrayBuffer, and is never held in React state. `file.slice()` returns a Blob
 * that is a VIEW on the file, not a copy, and it is created immediately before a
 * part upload and dropped immediately after. The live footprint is therefore
 * bounded by `partSize × concurrency` (16 MiB × 3 ≈ 48 MiB by default) plus
 * whatever the browser's networking layer holds — regardless of whether the file
 * is 100 MB or 3 GB.
 *
 * Control flow is Socket.IO acks: intent, part targets, status, renew, complete,
 * abort, progress. Those carry numbers, opaque provider ids and presigned URLs.
 */

/*
 * RELATIVE imports, deliberately.
 *
 * These are runtime values, and this module is imported directly by
 * scripts/upload-engine.test.mjs through Node's type stripping, which knows
 * nothing about the `@/` path alias and requires an explicit extension. Type-only
 * `@/` imports are fine anywhere (they are erased); a runtime one would make the
 * engine untestable outside the Next build. Same rule as src/lib/media.ts, which
 * is why `allowImportingTsExtensions` is on.
 */
import {
  computeEtaSeconds,
  computePercentage,
  computeUploadedBytes,
  createSpeedSampler,
  partRangeFor,
  type SpeedSampler,
} from './uploadMetrics.ts';
import {
  clearSession,
  clearSingleCleanup,
  fingerprintOf,
  loadSession,
  loadSingleCleanup,
  matchesFingerprint,
  describeFingerprintMismatch,
  saveSession,
  saveSingleCleanup,
  UPLOAD_RECOVERY_VERSION,
  type KeyValueStore,
  type RecoverableSession,
} from './uploadRecovery.ts';

/* -------------------------------------------------------------------------- */
/*  Public shape                                                              */
/* -------------------------------------------------------------------------- */

export type UploadPhase =
  | 'idle'
  | 'starting'
  | 'uploading'
  | 'paused'
  | 'retrying'
  | 'reconnecting'
  | 'finalizing'
  | 'completed'
  | 'cancelling'
  | 'cancelled'
  | 'failed';

export type UploadMode = 'single' | 'multipart';

export interface UploadSnapshot {
  phase: UploadPhase;
  mode: UploadMode | null;
  fileName: string;
  uploadedBytes: number;
  totalBytes: number;
  percentage: number;
  currentBytesPerSecond: number | null;
  smoothedBytesPerSecond: number | null;
  etaSeconds: number | null;
  completedParts: number;
  partCount: number;
  /** True once every byte is uploaded but the provider has not confirmed yet. */
  awaitingProvider: boolean;
  retry?: { partNumber: number; attempt: number; delayMs: number };
  error?: string;
  /** In a `failed` state, whether the SAME session can be resumed (vs. a fresh start). */
  retryable: boolean;
  /**
   * A lifecycle cleanup (`upload:abort`) is UNRESOLVED — a user cancel or a
   * client-origin terminal failure is holding the token/File/recovery until the
   * abort is confirmed. While true, the ONLY legal control is "Retry cancel": no
   * fresh start, reselect or new intent is offered.
   */
  cleanupPending: boolean;
  /** The abort/cleanup refusal code, when a cancellation was refused. */
  cleanupError?: string;
  /** A refresh-recoverable session is waiting for the user to reselect a file. */
  recovery?: { fileName: string; size: number; uploadedBytes: number };
}

export interface CompletedUpload {
  source: { type: 'url'; value: string; label: string; quality?: string };
  key: string;
  expectedBytes: number;
}

export interface UploadController {
  start(file: File): Promise<void>;
  pause(): void;
  resume(file?: File): Promise<void>;
  cancel(): Promise<void>;
  retry(file?: File): Promise<void>;
  subscribe(listener: (snapshot: UploadSnapshot) => void): () => void;
  getSnapshot(): UploadSnapshot;
  /** A pending refresh-recovered session, if one is waiting for a reselection. */
  pendingRecovery(): RecoverableSession | null;
  /** Notify the engine that connectivity changed (online/offline, socket state). */
  setOnline(online: boolean): void;
  destroy(): void;
  /** Test-only introspection of the memory bound and task liveness. */
  debug(): {
    maxConcurrentSlices: number;
    activeSlices: number;
    pendingTimers: number;
    activeXhrs: number;
    activeWorkers: number;
    activeSleepers: number;
    /** Whether a session token is still held (i.e. authority not yet released). */
    hasToken: boolean;
  };
}

export type UploadRequest = <T>(event: string, payload: unknown) => Promise<T>;

export interface UploadEngineDeps {
  /** Socket.IO request/ack. The ONLY control channel. */
  request: UploadRequest;
  roomCode: string;
  createXhr?: () => XMLHttpRequest;
  /** Monotonic clock. `performance.now()` in a browser. */
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Jitter source, injected so backoff is deterministic under test. */
  random?: () => number;
  isOnline?: () => boolean;
  store?: KeyValueStore | null;
  /** Wall clock, for expiry comparisons against server timestamps. */
  wallClock?: () => number;
  onCompleted?: (result: CompletedUpload) => void;
  onFailed?: (error: string) => void;
}

/* -------------------------------------------------------------------------- */
/*  Server payloads                                                           */
/* -------------------------------------------------------------------------- */

interface IntentAck {
  ok: boolean;
  error?: string;
  mode?: UploadMode;
  token?: string;
  key?: string;
  fileName?: string;
  mimeType?: string;
  expectedBytes?: number;
  maxBytes?: number;
  singleShotMaxBytes?: number;
  /* single */
  method?: string;
  uploadUrl?: string;
  headers?: Record<string, string>;
  fields?: Record<string, string>;
  direct?: boolean;
  /* multipart */
  uploadId?: string;
  partSize?: number;
  partCount?: number;
  lastPartSize?: number;
  concurrency?: number;
  retries?: number;
  maxPartBatch?: number;
  expiresAt?: number;
  partUrlTtlSeconds?: number;
}

interface PartTarget {
  partNumber: number;
  method: 'PUT';
  url: string;
  headers: Record<string, string>;
  expectedBytes: number;
  expiresAt: number;
}

interface TargetsAck {
  ok: boolean;
  error?: string;
  targets?: PartTarget[];
}

interface StatusAck {
  ok: boolean;
  error?: string;
  status?: 'uploading' | 'finalizing' | 'completed' | 'aborted' | 'expired' | 'superseded';
  completedParts?: Array<{ partNumber: number; etag: string; size: number }>;
  uploadedBytes?: number;
  expectedBytes?: number;
  partCount?: number;
  expiresAt?: number;
}

interface RenewAck {
  ok: boolean;
  error?: string;
  token?: string;
  expiresAt?: number;
}

/**
 * The lifecycle-abort acknowledgement. `ok:true` (INCLUDING `cleanupPending`)
 * means the server session is terminal and the client may release its authority;
 * `ok:false` means the session is STILL ACTIVE (rate-limited, wrong member, …) and
 * nothing may be discarded. A resolved `{ok:false}` is a refusal, not a success —
 * the whole point of this type.
 */
type AbortAck =
  | { ok: true; alreadyGone?: boolean; cleanupPending?: boolean }
  | { ok: false; error: string; retryAfterMs?: number };

interface CompleteAck {
  ok: boolean;
  error?: string;
  source?: CompletedUpload['source'];
  key?: string;
  expectedBytes?: number;
  /*
   * The server CLASSIFIES a completion failure, and the client honours it over
   * its own static code set. `terminal` means the session is finished (the
   * provider upload was aborted/deleted server-side) — tear it down; `retryable`
   * means keep the token/File/parts and let the user try again. Neither present is
   * an auth/configuration failure the code decides.
   */
  retryable?: boolean;
  terminal?: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Retry policy                                                              */
/* -------------------------------------------------------------------------- */

/** HTTP statuses worth another attempt. Everything else is a real refusal. */
const RETRYABLE_STATUS = new Set([408, 425, 429]);

/** Statuses meaning "this signed URL is no longer acceptable — get a new one". */
const REFRESH_STATUS = new Set([401, 403]);

function isRetryableStatus(status: number): boolean {
  if (RETRYABLE_STATUS.has(status)) return true;
  return status >= 500 && status <= 599;
}

const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 15_000;

/**
 * Exponential backoff with jitter, bounded.
 *
 * Jitter matters with concurrency 3: without it, three parts that fail on the
 * same network blip retry in lockstep forever, hammering the provider in
 * synchronised bursts. Injected randomness keeps it deterministic under test.
 */
export function backoffDelay(attempt: number, random: () => number): number {
  const exponential = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
  // Full jitter over the lower half, so delays spread without ever collapsing to 0.
  return Math.round(exponential * (0.5 + 0.5 * random()));
}

/** How early a session is renewed rather than risked. */
const RENEW_MARGIN_MS = 10 * 60 * 1000;

/** Upper bound on prefetched part targets: enough to keep workers fed, no more. */
const PREFETCH_MULTIPLIER = 2;

class UploadFailure extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.name = 'UploadFailure';
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/*  Engine                                                                    */
/* -------------------------------------------------------------------------- */

export function createUploadController(deps: UploadEngineDeps): UploadController {
  const request = deps.request;
  const createXhr = deps.createXhr || (() => new XMLHttpRequest());
  const now = deps.now || (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
  const wallClock = deps.wallClock || (() => Date.now());
  const setTimer = deps.setTimer || ((fn: () => void, ms: number) => setTimeout(fn, ms) as unknown);
  const clearTimer = deps.clearTimer || ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const random = deps.random || Math.random;
  const store = deps.store === undefined ? null : deps.store;

  /* ------------------------------ state ------------------------------ */

  let phase: UploadPhase = 'idle';
  let mode: UploadMode | null = null;
  let token: string | null = null;
  let objectKey: string | null = null;
  let fileRef: File | null = null;
  let fileName = '';
  let totalBytes = 0;
  let partSize = 0;
  let partCount = 0;
  let concurrency = 3;
  let maxRetries = 5;
  let maxBatch = 20;
  let expiresAt = 0;
  let label = '';
  let errorCode: string | undefined;
  // The effective retryable/terminal verdict for the current failure. Set by
  // fail() from the server's classification when supplied, else from the client's
  // static set — so the snapshot and the teardown decision never disagree.
  let errorRetryable: boolean | undefined;
  // When a cancellation is REFUSED (rate-limited, wrong member, …), how long the
  // server asked us to wait before retrying the cancel. Informational.
  let cancelRetryAfterMs: number | undefined;
  /*
   * Lifecycle-cleanup state. An `upload:abort` is UNRESOLVED (in flight, or
   * refused and awaiting a retry), so the token, File and persisted recovery are
   * all retained until it is confirmed `ok:true`. `cleanupOrigin` decides the
   * success end-state: a user `cancel` ends `cancelled` with nothing held; a
   * client-origin `terminal` failure ends `failed` with the File kept so a fresh
   * start is possible. `cleanupError` is the abort refusal, kept SEPARATE from the
   * original upload `errorCode` (e.g. failure SIZE_MISMATCH + cleanup RATE_LIMITED).
   */
  let cleanupPending = false;
  let cleanupError: string | undefined;
  let cleanupOrigin: 'cancel' | 'terminal' | null = null;
  let cleanupInFlight = false;
  let retryInfo: UploadSnapshot['retry'];
  let recovery: RecoverableSession | null = null;
  let online = deps.isOnline ? deps.isOnline() : true;

  /** partNumber -> provider-confirmed ETag. The only definition of "done". */
  const completed = new Map<number, { etag: string; size: number }>();
  /** partNumber -> live loaded bytes for an in-flight attempt. */
  const activeBytes = new Map<number, number>();
  /** partNumber -> attempts already spent. */
  const attempts = new Map<number, number>();
  /** Prefetched, not-yet-used targets. */
  const targets = new Map<number, PartTarget>();

  const activeXhrs = new Set<XMLHttpRequest>();
  /*
   * A timer is a CANCELLABLE entry, not a bare handle. `clearTimers` used to drop
   * the handle and leave the `sleep()` Promise pending forever, so a worker
   * blocked in `await sleep(delay)` during a retry backoff never woke and never
   * exited — a leaked task that no generation check could reach. Each entry now
   * carries a `settle` that resolves its sleeper, so cancelling a timer also
   * releases the worker awaiting it, which then exits through the generation guard.
   */
  const timers = new Set<{ handle: unknown; settle: () => void }>();
  let activeSlices = 0;
  let maxConcurrentSlices = 0;
  // Test-only liveness counters: how many worker loops and sleepers are alive.
  // The stress proof asserts both return to zero after pause/offline/cancel.
  let activeWorkers = 0;
  let activeSleepers = 0;

  let sampler: SpeedSampler = createSpeedSampler();
  let listeners: Array<(s: UploadSnapshot) => void> = [];
  let generation = 0;
  let completionPromise: Promise<void> | null = null;
  let lastReportedProgressAt = 0;
  let lastReportedStatus: string | null = null;
  let destroyed = false;

  /* ------------------------------ snapshot ------------------------------ */

  const completedBytes = () => {
    let sum = 0;
    for (const part of completed.values()) sum += part.size;
    return sum;
  };
  const inFlightBytes = () => {
    let sum = 0;
    for (const value of activeBytes.values()) sum += value;
    return sum;
  };

  function snapshot(): UploadSnapshot {
    const uploaded = computeUploadedBytes({
      completedBytes: completedBytes(),
      activeBytes: inFlightBytes(),
      totalBytes,
    });
    const reading = sampler.read();
    const active = phase === 'uploading' || phase === 'retrying';
    const etaSeconds = active ? computeEtaSeconds(uploaded, totalBytes, reading.smoothed) : null;

    return {
      phase,
      mode,
      fileName,
      uploadedBytes: uploaded,
      totalBytes,
      percentage: computePercentage(uploaded, totalBytes),
      currentBytesPerSecond: active ? reading.current : null,
      smoothedBytesPerSecond: active ? reading.smoothed : null,
      etaSeconds: reading.stable ? etaSeconds : null,
      completedParts: completed.size,
      partCount,
      // 100% of the bytes are up, but the object does not exist until the
      // provider assembles it and the server verifies it.
      awaitingProvider: phase === 'finalizing',
      retry: retryInfo,
      error: errorCode,
      // A failed multipart attempt whose token and file are still held can resume
      // in place; anything else needs a fresh selection. The verdict is the one
      // fail() recorded (server classification when present, else the code set).
      retryable:
        phase === 'failed' &&
        !!errorCode &&
        (errorRetryable !== undefined ? errorRetryable : isRetryableFailure(errorCode)) &&
        mode === 'multipart' &&
        !!token &&
        !!fileRef,
      cleanupPending,
      cleanupError,
      recovery: recovery
        ? { fileName: recovery.fileName, size: recovery.size, uploadedBytes: completedBytes() }
        : undefined,
    };
  }

  function emit() {
    if (destroyed) return;
    const value = snapshot();
    for (const listener of listeners) listener(value);
  }

  function setPhase(next: UploadPhase) {
    if (phase === next) return;
    phase = next;
    emit();
  }

  /**
   * Has the user stopped this upload?
   *
   * Read through a function, not inline, for a reason that is easy to trip over:
   * `phase` changes from OUTSIDE the async worker loops (pause() and cancel() are
   * called from the UI while a part is in flight), and an inline comparison lets
   * the compiler narrow the captured variable and then treat the next check as
   * unreachable. A call reads the live value every time.
   */
  const stopped = () => phase === 'paused' || phase === 'cancelled';

  /* ------------------------------ helpers ------------------------------ */

  /**
   * Sleep for `ms`, but as a CANCELLABLE task.
   *
   * The returned Promise resolves either when the timer fires or when
   * `clearTimers()` settles it early. It never rejects — a cancelled sleeper
   * resolves so its awaiting worker continues to the generation check and exits
   * cleanly, rather than throwing a failure into a queue that is being torn down.
   */
  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      activeSleepers += 1;
      const entry = { handle: undefined as unknown, settle: () => {} };
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        activeSleepers -= 1;
        timers.delete(entry);
        resolve();
      };
      entry.settle = finish;
      entry.handle = setTimer(finish, ms);
      timers.add(entry);
    });
  }

  function clearTimers() {
    // Clear the handle AND settle the sleeper: a pending backoff must not outlive
    // the pause/cancel/offline that cleared it.
    for (const entry of timers) {
      clearTimer(entry.handle);
      entry.settle();
    }
    timers.clear();
  }

  function abortActiveXhrs() {
    for (const xhr of activeXhrs) {
      try {
        xhr.abort();
      } catch {
        /* already finished */
      }
    }
    activeXhrs.clear();
    // Transient bytes belong to attempts that no longer exist. Leaving them would
    // double-count when the part is retried.
    activeBytes.clear();
  }

  function resetTransient() {
    abortActiveXhrs();
    clearTimers();
    retryInfo = undefined;
  }

  /** Report progress to the room, throttled locally as well as on the server. */
  function reportProgress(status: 'uploading' | 'paused' | 'retrying' | 'reconnecting' | 'finalizing') {
    if (!token || !mode) return;
    const at = now();
    const changed = status !== lastReportedStatus;
    if (!changed && at - lastReportedProgressAt < 2000) return;
    lastReportedProgressAt = at;
    lastReportedStatus = status;

    const uploaded = computeUploadedBytes({
      completedBytes: completedBytes(),
      activeBytes: inFlightBytes(),
      totalBytes,
    });
    // Fire and forget: partner progress is nice-to-have and must never block or
    // fail an upload. Speed and ETA are deliberately NOT sent — they are local
    // estimates, and relaying them would be extra traffic for a worse number.
    void request<{ ok: boolean }>('upload:room-progress', {
      mode,
      token,
      label,
      uploadedBytes: uploaded,
      totalBytes,
      status,
    }).catch(() => {});
  }

  function persist() {
    if (mode !== 'multipart' || !token || !fileRef) return;
    const session: RecoverableSession = {
      version: UPLOAD_RECOVERY_VERSION,
      mode: 'multipart',
      token,
      // The fingerprint the reselected file will be compared against. Four
      // properties, taken from the File itself so they cannot drift from what a
      // later comparison reads.
      ...fingerprintOf(fileRef),
      partSize,
      partCount,
      expiresAt,
      roomCode: deps.roomCode,
    };
    saveSession(store, session);
  }

  /**
   * Persist a SINGLE-SHOT lifecycle so a destroy/remount can still close it.
   *
   * A single upload has no byte-transfer to resume, but its server session is a
   * live capability only this token can end. Persisting the token as soon as the
   * intent is accepted is what lets the next controller discover and abort it —
   * the exact gap that left single-shot sessions orphaned across disposal.
   */
  function persistSingle() {
    if (mode !== 'single' || !token) return;
    saveSingleCleanup(store, {
      version: UPLOAD_RECOVERY_VERSION,
      mode: 'single',
      roomCode: deps.roomCode,
      token,
      fileName,
      size: totalBytes,
      expiresAt,
    });
  }

  function forgetPersisted() {
    clearSession(store, deps.roomCode);
    clearSingleCleanup(store, deps.roomCode);
    recovery = null;
  }

  /* ------------------------------ part upload ------------------------------ */

  interface PartOutcome {
    ok: boolean;
    etag?: string;
    /** Retryable transport/server failure. */
    retryable?: boolean;
    /** The signed URL was refused — discard it and sign a new one. */
    refresh?: boolean;
    error?: string;
  }

  /**
   * PUT exactly one part.
   *
   * XHR rather than fetch because only XHR exposes upload progress, and a 3 GB
   * upload with no progress is indistinguishable from a hang. The Blob is created
   * here and released when this function returns.
   */
  function putPart(target: PartTarget, blob: Blob, myGeneration: number): Promise<PartOutcome> {
    return new Promise((resolve) => {
      const xhr = createXhr();
      let settled = false;
      const finish = (outcome: PartOutcome) => {
        if (settled) return;
        settled = true;
        activeXhrs.delete(xhr);
        resolve(outcome);
      };

      activeXhrs.add(xhr);
      xhr.open('PUT', target.url, true);

      // Only headers the server told us to send. Anything else would either
      // break the signature or leak a capability into a request that does not
      // need it.
      for (const [name, value] of Object.entries(target.headers || {})) {
        try {
          xhr.setRequestHeader(name, value);
        } catch {
          /* the browser forbids some header names; the signature does not need them */
        }
      }

      if (xhr.upload) {
        xhr.upload.onprogress = (event: ProgressEvent) => {
          if (myGeneration !== generation || !event.lengthComputable) return;
          activeBytes.set(target.partNumber, Math.min(event.loaded, target.expectedBytes));
          sampler.sample(completedBytes() + inFlightBytes(), now());
          emit();
        };
      }

      xhr.onload = () => {
        activeBytes.delete(target.partNumber);
        if (xhr.status >= 200 && xhr.status < 300) {
          /*
           * The ETag is the provider's receipt. Without it the part cannot be
           * named in the completion manifest, so a 200 with no ETag is a FAILURE
           * even though the bytes probably arrived — usually it means the bucket's
           * CORS configuration does not expose the ETag header, which is a
           * configuration error worth surfacing rather than silently retrying
           * forever.
           */
          const raw = xhr.getResponseHeader('ETag') || xhr.getResponseHeader('etag');
          const etag = typeof raw === 'string' ? raw.trim() : '';
          if (!etag) return finish({ ok: false, error: 'MISSING_ETAG' });
          // Never rewritten: providers compare ETags byte-for-byte, so adding or
          // stripping quotes can invalidate a completion.
          return finish({ ok: true, etag });
        }
        if (REFRESH_STATUS.has(xhr.status)) return finish({ ok: false, retryable: true, refresh: true });
        if (isRetryableStatus(xhr.status)) return finish({ ok: false, retryable: true });
        finish({ ok: false, error: `PART_REJECTED_${xhr.status}` });
      };
      xhr.onerror = () => {
        activeBytes.delete(target.partNumber);
        finish({ ok: false, retryable: true, error: 'NETWORK' });
      };
      xhr.ontimeout = () => {
        activeBytes.delete(target.partNumber);
        finish({ ok: false, retryable: true, error: 'TIMEOUT' });
      };
      xhr.onabort = () => {
        activeBytes.delete(target.partNumber);
        finish({ ok: false, error: 'ABORTED' });
      };

      xhr.send(blob);
    });
  }

  /* ------------------------------ targets ------------------------------ */

  async function fetchTargets(partNumbers: number[]): Promise<void> {
    if (!token || partNumbers.length === 0) return;
    // Bounded by the server contract (20) and by what the workers can consume.
    const batch = partNumbers.slice(0, Math.min(maxBatch, partNumbers.length));
    const ack = await request<TargetsAck>('upload:part-targets', { token, partNumbers: batch });
    if (!ack?.ok || !Array.isArray(ack.targets)) throw new UploadFailure(ack?.error || 'TARGETS_FAILED');
    for (const target of ack.targets) targets.set(target.partNumber, target);
  }

  async function targetFor(partNumber: number, queue: number[]): Promise<PartTarget> {
    const existing = targets.get(partNumber);
    // A target that is about to expire is worse than no target: the PUT would
    // start, upload megabytes and then be refused.
    if (existing && existing.expiresAt - wallClock() > 30_000) return existing;
    targets.delete(partNumber);

    // Prefetch alongside this one, but never the whole plan: at most
    // 2 × concurrency signed URLs exist at a time, so a 192-part upload never
    // mints 192 write capabilities.
    const wanted = [partNumber];
    const budget = Math.min(maxBatch, PREFETCH_MULTIPLIER * concurrency);
    for (const candidate of queue) {
      if (wanted.length >= budget) break;
      if (candidate === partNumber || targets.has(candidate)) continue;
      wanted.push(candidate);
    }
    await fetchTargets(wanted);
    const target = targets.get(partNumber);
    if (!target) throw new UploadFailure('TARGETS_FAILED');
    return target;
  }

  /* ------------------------------ session ------------------------------ */

  /**
   * Read provider status, tolerating the RE-ADMISSION WINDOW after a reconnect.
   *
   * When the socket drops and comes back, there is a brief window where it is
   * connected but not yet a room member again (the room re-admits it on its own
   * round-trip). A status read in that window answers UNAUTHORIZED. Treating that
   * as fatal stranded every offline→online resume; retrying a bounded number of
   * transient failures lets the resume wait for re-admission instead of failing.
   */
  async function refreshStatusResilient(myGeneration: number): Promise<StatusAck | null> {
    const transient = new Set(['UNAUTHORIZED', 'TIMEOUT', 'NETWORK', 'STATUS_FAILED', 'STORAGE_UNAVAILABLE', 'RATE_LIMITED']);
    let lastError: unknown;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      // Only the generation guard: pause/cancel/offline all bump `generation`, and
      // a resume runs while the phase is momentarily still `paused`, so a
      // `stopped()` check here would abort the very resume it is meant to serve.
      if (myGeneration !== generation) return null;
      try {
        return await refreshStatus();
      } catch (err) {
        lastError = err;
        const code = err instanceof UploadFailure ? err.code : '';
        if (!transient.has(code)) throw err;
        await sleep(Math.min(1000 * (attempt + 1), 3000));
      }
    }
    throw lastError instanceof UploadFailure ? lastError : new UploadFailure('STATUS_FAILED');
  }

  async function refreshStatus(): Promise<StatusAck> {
    if (!token) throw new UploadFailure('BAD_TOKEN');
    const ack = await request<StatusAck>('upload:status', { token });
    if (!ack?.ok) throw new UploadFailure(ack?.error || 'STATUS_FAILED');

    /*
     * The provider is the authority on what has landed. Local bookkeeping is
     * discarded, not merged: after a refresh it is gone anyway, and after a
     * reconnect it may claim parts the provider never stored.
     */
    completed.clear();
    for (const part of ack.completedParts || []) {
      completed.set(part.partNumber, { etag: part.etag, size: part.size });
    }
    if (Number.isSafeInteger(ack.expiresAt)) expiresAt = ack.expiresAt as number;
    emit();
    return ack;
  }

  async function renewIfNeeded(): Promise<void> {
    if (!token || !expiresAt) return;
    if (expiresAt - wallClock() > RENEW_MARGIN_MS) return;
    const ack = await request<RenewAck>('upload:renew', { token });
    if (!ack?.ok || typeof ack.token !== 'string') return; // keep the old one; it is still valid
    token = ack.token;
    if (Number.isSafeInteger(ack.expiresAt)) expiresAt = ack.expiresAt as number;
    persist();
  }

  /* ------------------------------ the queue ------------------------------ */

  function missingParts(): number[] {
    const queue: number[] = [];
    for (let n = 1; n <= partCount; n += 1) if (!completed.has(n)) queue.push(n);
    return queue;
  }

  /**
   * Run the part queue with bounded concurrency until every part is confirmed,
   * the upload is paused/cancelled, or a non-retryable failure occurs.
   */
  async function runQueue(myGeneration: number): Promise<void> {
    const queue = missingParts();
    let cursor = 0;
    let fatal: string | null = null;

    const nextPart = (): number | null => {
      while (cursor < queue.length) {
        const candidate = queue[cursor];
        cursor += 1;
        if (!completed.has(candidate)) return candidate;
      }
      return null;
    };

    const workerBody = async (): Promise<void> => {
      for (;;) {
        if (myGeneration !== generation || fatal) return;
        if (stopped() || !online) return;

        const partNumber = nextPart();
        if (partNumber === null) return;

        const range = partRangeFor(partNumber, partSize, totalBytes);
        if (!range) {
          fatal = 'PLAN_MISMATCH';
          return;
        }

        for (;;) {
          if (myGeneration !== generation || fatal) return;
          if (stopped() || !online) return;

          let target: PartTarget;
          try {
            await renewIfNeeded();
            target = await targetFor(partNumber, queue.slice(cursor));
          } catch (err) {
            fatal = err instanceof UploadFailure ? err.code : 'TARGETS_FAILED';
            return;
          }
          if (myGeneration !== generation) return;

          const file = fileRef;
          if (!file) {
            fatal = 'FILE_MISSING';
            return;
          }

          /*
           * The ONE place a slice exists. `File.slice` is a view, not a copy, and
           * it is dropped at the end of this block — so at most `concurrency`
           * slices are referenced at once, whatever the file size.
           */
          activeSlices += 1;
          maxConcurrentSlices = Math.max(maxConcurrentSlices, activeSlices);
          let outcome: PartOutcome;
          try {
            const blob = file.slice(range.start, range.end);
            outcome = await putPart(target, blob, myGeneration);
          } finally {
            activeSlices -= 1;
          }

          if (myGeneration !== generation) return;

          if (outcome.ok && outcome.etag) {
            completed.set(partNumber, { etag: outcome.etag, size: range.size });
            activeBytes.delete(partNumber);
            attempts.delete(partNumber);
            retryInfo = undefined;
            targets.delete(partNumber);
            sampler.sample(completedBytes() + inFlightBytes(), now());
            emit();
            reportProgress('uploading');
            break;
          }

          if (stopped() || !online) return;

          if (!outcome.retryable) {
            // A missing ETag is a bucket CORS problem, not a transient failure —
            // retrying it 5 times would waste the user's bandwidth to reach the
            // same wall.
            fatal = outcome.error || 'PART_FAILED';
            return;
          }

          const spent = (attempts.get(partNumber) || 0) + 1;
          attempts.set(partNumber, spent);
          if (spent > maxRetries) {
            fatal = outcome.error || 'PART_FAILED';
            return;
          }

          if (outcome.refresh) targets.delete(partNumber);
          // The abandoned attempt's bytes are gone; the sampler's baseline has to
          // go with them or the next reading is a negative rate.
          activeBytes.delete(partNumber);
          sampler.reset();

          const delayMs = backoffDelay(spent, random);
          retryInfo = { partNumber, attempt: spent, delayMs };
          setPhase('retrying');
          reportProgress('retrying');
          emit();
          await sleep(delayMs);
          if (myGeneration !== generation) return;
          if (phase === 'retrying') setPhase('uploading');
        }
      }
    };

    // Count live workers so the stress proof can assert none leak past a cancel.
    const worker = async (): Promise<void> => {
      activeWorkers += 1;
      try {
        await workerBody();
      } finally {
        activeWorkers -= 1;
      }
    };

    const workers: Array<Promise<void>> = [];
    for (let i = 0; i < Math.max(1, concurrency); i += 1) workers.push(worker());
    await Promise.all(workers);

    if (myGeneration !== generation) return;
    if (fatal) throw new UploadFailure(fatal);
  }

  /* ------------------------------ completion ------------------------------ */

  /**
   * Complete EXACTLY once.
   *
   * Several workers finish within milliseconds of each other, and two completions
   * would either create two sources or emit duplicate progress. The promise is
   * the guard: the first caller runs it, every other caller awaits the same one.
   */
  function completeOnce(myGeneration: number): Promise<void> {
    if (completionPromise) return completionPromise;
    completionPromise = (async () => {
      setPhase('finalizing');
      reportProgress('finalizing');

      const parts = [...completed.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([partNumber, part]) => ({ partNumber, etag: part.etag }));

      const ack = await request<CompleteAck>('upload:complete', {
        mode: 'multipart',
        token,
        label,
        parts,
      });
      if (myGeneration !== generation) return;
      if (!ack?.ok || !ack.source) {
        /*
         * Honour the SERVER's classification over the client's static set: a
         * completion that failed terminally (MISSING_PART, a part-size mismatch)
         * already aborted/deleted the provider upload, so the session is dead and
         * must be torn down; a retryable one (STORAGE_UNAVAILABLE, COMPLETE_FAILED)
         * kept the session, so the token/File/parts are preserved for retry. When
         * the server sends neither flag it is an auth/config failure the code
         * decides. fail() ends the attempt without throwing, so the completion
         * promise resolves and no caller double-fails.
         */
        const code = ack?.error || 'COMPLETE_FAILED';
        const serverTerminal = ack?.terminal === true;
        const retryable = serverTerminal ? false : ack?.retryable === true ? true : undefined;
        // terminalAcked: the server already closed the lifecycle, so the client
        // must NOT fire a redundant abort — clear immediately.
        const failOpts: { retryable?: boolean; terminalAcked?: boolean } = { terminalAcked: serverTerminal };
        if (retryable !== undefined) failOpts.retryable = retryable;
        fail(code, failOpts);
        return;
      }

      forgetPersisted();
      setPhase('completed');
      deps.onCompleted?.({
        source: ack.source,
        key: ack.key || objectKey || '',
        expectedBytes: ack.expectedBytes ?? totalBytes,
      });
    })();
    return completionPromise;
  }

  /* ------------------------------ drive ------------------------------ */

  async function drive(myGeneration: number): Promise<void> {
    try {
      const status = await refreshStatusResilient(myGeneration);
      if (myGeneration !== generation || !status) return;

      /*
       * INSPECT THE SERVER STATUS before deciding to rebuild a part queue.
       *
       * The server can report `status:'completed'` with `completedParts:[]` and
       * `uploadedBytes:expectedBytes` because the object is already assembled (a
       * lost completion ack, or a reconnect after completion). The old code only
       * looked at the completed-parts count — which is zero here — so it rebuilt
       * the whole queue, requested part targets, and sliced the file all over
       * again. Now a terminal/finalizing status short-circuits to the right thing.
       */
      if (status.status === 'completed') {
        // Idempotent complete: retrieve the verified source, no targets, no slices.
        await completeOnce(myGeneration);
        return;
      }
      if (status.status === 'aborted') {
        fail('SESSION_CLOSED');
        return;
      }
      if (status.status === 'expired') {
        fail('SESSION_EXPIRED');
        return;
      }

      // uploading | finalizing: the provider-confirmed parts drive the queue.
      if (completed.size >= partCount) {
        await completeOnce(myGeneration);
        return;
      }

      sampler.resume();
      sampler.sample(completedBytes(), now());
      setPhase('uploading');
      reportProgress('uploading');

      await runQueue(myGeneration);
      if (myGeneration !== generation) return;
      if (stopped()) return;
      if (!online) {
        setPhase('reconnecting');
        reportProgress('reconnecting');
        return;
      }

      if (completed.size >= partCount) {
        await completeOnce(myGeneration);
        return;
      }
      // Neither finished nor stopped: something removed parts underneath us.
      throw new UploadFailure('INCOMPLETE');
    } catch (err) {
      if (myGeneration !== generation) return;
      fail(err instanceof UploadFailure ? err.code : 'UPLOAD_FAILED');
    }
  }

  /**
   * Failures that END the session — the token, the file, or the manifest is no
   * longer usable, so keeping any of it would only offer a resume that fails
   * again. Everything NOT in this set is treated as transient (network, timeout,
   * target-refresh exhaustion, a retryable completion failure): the session, its
   * token, its File and its completed parts are all preserved for a retry.
   */
  const TERMINAL_FAILURES = new Set([
    'SESSION_CLOSED',
    'SESSION_EXPIRED',
    'SESSION_SUPERSEDED',
    'SESSION_TERMINAL',
    'FILE_MISMATCH',
    'FILE_MISSING',
    'PLAN_MISMATCH',
    'PART_MISMATCH',
    'ETAG_MISMATCH',
    'PROVIDER_STATE_INVALID',
    'SIZE_MISMATCH',
    'BAD_CONTENT',
    // MISSING_ETAG is deliberately NOT terminal. The PUT reached the provider (the
    // part is stored server-side); only the browser could not READ the ETag,
    // usually a fixable bucket-CORS problem. So it keeps the session resumable: on
    // retry the server reconciles the provider-confirmed parts and completes
    // without re-uploading. It is still fatal to the CURRENT queue (no point
    // hammering a CORS wall), just not to the session.
    'UNSUPPORTED_TYPE',
    'TOO_LARGE',
    'BAD_SIZE',
    'CONFIGURATION_ERROR',
    'MULTIPART_REQUIRED',
    'BAD_TOKEN',
    'WRONG_ROOM',
    'WRONG_MEMBER',
    'NO_SUCH_UPLOAD',
    'BAD_GRANT',
  ]);

  const isRetryableFailure = (code: string) => !TERMINAL_FAILURES.has(code);

  /**
   * End the current attempt in `failed`, classifying it retryable vs terminal.
   *
   * `opts.retryable` is the SERVER's classification (from a completion ack); when
   * given it wins over the client's static code set, so the client does not need
   * to hardcode every terminal server code. A retryable failure keeps the token,
   * File, confirmed parts and persistence so `retry()` resumes the SAME session.
   */
  function fail(code: string, opts: { retryable?: boolean; terminalAcked?: boolean } = {}) {
    resetTransient();
    sampler.suspend();
    errorCode = code;
    errorRetryable = opts.retryable !== undefined ? opts.retryable : isRetryableFailure(code);
    setPhase('failed');

    if (errorRetryable && mode === 'multipart' && token && fileRef) {
      /*
       * RETRYABLE. No new upload:intent, no re-sliced completed parts. The UI
       * shows "Try again"; the controller is not destroyed. This is the difference
       * between a transient blip and a dead upload.
       */
      deps.onFailed?.(code);
      emit();
      return;
    }

    /*
     * TERMINAL. Nothing here can be resumed.
     *
     * If the SERVER already closed the lifecycle (`terminalAcked` — a completion
     * ack with terminal:true) or there is no token, release everything now.
     *
     * Otherwise this is a CLIENT-origin terminal failure whose server session is
     * STILL ACTIVE. Do NOT discard authority up front: keep the token, the File and
     * the persisted recovery, enter an explicit cleanup state, and run the
     * authoritative abort. Authority is released ONLY on a confirmed `ok:true`
     * (which keeps the File so a fresh start is possible); a refusal surfaces a
     * retry-cancel, and start() is blocked until cleanup resolves — so the UI can
     * never offer a fresh start that would collide with the live session. The
     * original `errorCode` (e.g. SIZE_MISMATCH) is preserved separately from the
     * cleanup's `cleanupError` (e.g. RATE_LIMITED).
     */
    const needsCleanup = !!token && (mode === 'multipart' || mode === 'single') && !opts.terminalAcked;
    if (needsCleanup) {
      cleanupOrigin = 'terminal';
      deps.onFailed?.(code);
      void runCleanup();
      emit();
      return;
    }
    forgetPersisted();
    fileRef = null;
    token = null;
    deps.onFailed?.(code);
    emit();
  }

  /* ------------------------------ single shot ------------------------------ */

  /**
   * The existing single-request upload, brought into the shared progress model.
   *
   * Pause is deliberately absent for this mode rather than mislabelled: one HTTP
   * request cannot be paused and resumed, and a Pause button that silently
   * restarts a 400 MB upload is a worse experience than no Pause button.
   */
  async function runSingle(intent: IntentAck, myGeneration: number): Promise<void> {
    const file = fileRef;
    if (!file) return fail('FILE_MISSING');

    sampler.resume();
    setPhase('uploading');
    reportProgress('uploading');

    const outcome = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const xhr = createXhr();
      activeXhrs.add(xhr);
      const method = intent.method || 'PUT';
      xhr.open(method, intent.uploadUrl as string, true);

      if (xhr.upload) {
        xhr.upload.onprogress = (event: ProgressEvent) => {
          if (myGeneration !== generation || !event.lengthComputable) return;
          activeBytes.set(1, Math.min(event.loaded, totalBytes));
          sampler.sample(inFlightBytes(), now());
          emit();
          reportProgress('uploading');
        };
      }
      xhr.onload = () => {
        activeXhrs.delete(xhr);
        if (xhr.status >= 200 && xhr.status < 300) return resolve({ ok: true });
        if (xhr.status === 413 || xhr.status === 400) return resolve({ ok: false, error: 'TOO_LARGE' });
        if (xhr.status === 401 || xhr.status === 403) return resolve({ ok: false, error: 'BAD_TOKEN' });
        resolve({ ok: false, error: 'UPLOAD_FAILED' });
      };
      xhr.onerror = () => {
        activeXhrs.delete(xhr);
        resolve({ ok: false, error: 'NETWORK' });
      };
      xhr.onabort = () => {
        activeXhrs.delete(xhr);
        resolve({ ok: false, error: 'ABORTED' });
      };

      if (method === 'POST' && intent.fields) {
        const form = new FormData();
        // Policy fields first; the binary MUST be the final field for S3.
        for (const [k, v] of Object.entries(intent.fields)) form.append(k, v);
        form.append('file', file);
        xhr.send(form);
      } else {
        for (const [k, v] of Object.entries(intent.headers || {})) {
          try {
            xhr.setRequestHeader(k, v);
          } catch {
            /* forbidden header name */
          }
        }
        xhr.send(file);
      }
    });

    if (myGeneration !== generation) return;
    if (!outcome.ok) return fail(outcome.error || 'UPLOAD_FAILED');

    setPhase('finalizing');
    reportProgress('finalizing');
    const ack = await request<CompleteAck>('upload:complete', { token, label });
    if (myGeneration !== generation) return;
    if (!ack?.ok || !ack.source) return fail(ack?.error || 'UPLOAD_FAILED');

    // Every byte is confirmed only now.
    activeBytes.clear();
    completed.set(1, { etag: 'single', size: totalBytes });
    partCount = 1;
    // The session is over — drop the cleanup record so a later mount finds nothing.
    forgetPersisted();
    setPhase('completed');
    deps.onCompleted?.({
      source: ack.source,
      key: ack.key || objectKey || '',
      expectedBytes: ack.expectedBytes ?? totalBytes,
    });
  }

  /* ------------------------------ public API ------------------------------ */

  function reset() {
    generation += 1;
    resetTransient();
    completed.clear();
    activeBytes.clear();
    attempts.clear();
    targets.clear();
    completionPromise = null;
    lastReportedStatus = null;
    lastReportedProgressAt = 0;
    errorCode = undefined;
    errorRetryable = undefined;
    cancelRetryAfterMs = undefined;
    cleanupPending = false;
    cleanupError = undefined;
    cleanupOrigin = null;
    cleanupInFlight = false;
    retryInfo = undefined;
    sampler = createSpeedSampler();
    activeSlices = 0;
  }

  async function start(file: File): Promise<void> {
    /*
     * A previous lifecycle is still awaiting authoritative cleanup. A new intent
     * would collide with the still-active server session, so REFUSE it and leave
     * the cleanup state (and its retry-cancel) intact — the old token is never
     * overwritten and no `upload:intent` is sent. The UI does not offer a fresh
     * chooser while `cleanupPending`, so this is the last-line defensive guard.
     */
    if (cleanupPending) return;

    reset();
    const myGeneration = generation;

    fileRef = file;
    fileName = file.name;
    label = file.name;
    totalBytes = file.size;
    mode = null;
    token = null;
    objectKey = null;
    partCount = 0;
    partSize = 0;
    setPhase('starting');

    let intent: IntentAck;
    try {
      intent = await request<IntentAck>('upload:intent', {
        fileName: file.name,
        mimeType: file.type,
        size: file.size,
        lastModified: file.lastModified,
      });
    } catch {
      return fail('TIMEOUT');
    }
    if (myGeneration !== generation) return;

    if (!intent?.ok) return fail(intent?.error || 'UPLOAD_FAILED');

    token = intent.token || null;
    objectKey = intent.key || null;
    if (intent.fileName) fileName = intent.fileName;

    /*
     * The SERVER chooses the transport. The client never guesses from size: the
     * ceilings, the storage capability and the enablement state all live on the
     * server, and a client that guessed would be wrong in exactly the cases that
     * matter (a bucket that is not configured, a transport that is not enabled).
     */
    if (intent.mode === 'multipart') {
      mode = 'multipart';
      partSize = intent.partSize || 0;
      partCount = intent.partCount || 0;
      totalBytes = intent.expectedBytes ?? totalBytes;
      concurrency = intent.concurrency && intent.concurrency > 0 ? intent.concurrency : 3;
      maxRetries = Number.isSafeInteger(intent.retries) ? (intent.retries as number) : 5;
      maxBatch = intent.maxPartBatch && intent.maxPartBatch > 0 ? intent.maxPartBatch : 20;
      expiresAt = intent.expiresAt || 0;
      if (!partSize || !partCount) return fail('CONFIGURATION_ERROR');
      persist();
      await drive(myGeneration);
      return;
    }

    if (intent.mode === 'single' || intent.uploadUrl) {
      mode = 'single';
      partCount = 1;
      totalBytes = intent.expectedBytes ?? totalBytes;
      // Pin the single token's expiry and persist a cleanup record IMMEDIATELY, so
      // a destroy/remount mid-upload can still discover and close this session.
      expiresAt = Number.isSafeInteger(intent.expiresAt) ? (intent.expiresAt as number) : wallClock() + 60 * 60 * 1000;
      persistSingle();
      await runSingle(intent, myGeneration);
      return;
    }

    fail('UPLOAD_FAILED');
  }

  function pause(): void {
    if (mode !== 'multipart') return;
    if (phase !== 'uploading' && phase !== 'retrying' && phase !== 'reconnecting') return;
    /*
     * Local only. The provider multipart session is deliberately NOT aborted —
     * that is what makes resume possible, and aborting it would throw away every
     * confirmed part.
     */
    generation += 1;
    resetTransient();
    sampler.suspend();
    setPhase('paused');
    reportProgress('paused');
    emit();
  }

  async function resume(file?: File): Promise<void> {
    if (file) {
      // A reselection after a refresh: the file must be the SAME file, or the
      // assembled object would splice two different movies together.
      const target = recovery;
      if (target) {
        if (!matchesFingerprint(target, file)) {
          errorCode = 'FILE_MISMATCH';
          emit();
          throw new UploadFailure(describeFingerprintMismatch(target, file) || 'FILE_MISMATCH');
        }
        token = target.token;
        partSize = target.partSize;
        partCount = target.partCount;
        totalBytes = target.size;
        expiresAt = target.expiresAt;
        fileName = target.fileName;
        label = target.fileName;
        mode = 'multipart';
        recovery = null;
      }
      fileRef = file;
    }
    if (mode !== 'multipart' || !token) return;
    if (!fileRef) return;

    generation += 1;
    const myGeneration = generation;
    errorCode = undefined;
    completionPromise = null;
    sampler = createSpeedSampler();
    await drive(myGeneration);
  }

  /**
   * Authoritative lifecycle cleanup: send `upload:abort` and release client
   * authority ONLY on a confirmed `ok:true`.
   *
   * A refusal or an unreachable server keeps EVERYTHING (token, File, persisted
   * recovery) and surfaces a retry-cancel — the server session is still active, so
   * a fresh start would collide with it. Reused by `cancel()` and by a
   * client-origin terminal failure; `cleanupOrigin` selects the success end-state.
   */
  async function runCleanup(): Promise<void> {
    if (cleanupInFlight) return; // one abort at a time; a retry awaits this one
    const tok = token;
    const m = mode;
    cleanupPending = true;
    cleanupError = undefined;
    cancelRetryAfterMs = undefined;
    if (!tok || (m !== 'multipart' && m !== 'single')) {
      finishCleanup(); // nothing to abort — the lifecycle is already terminal
      return;
    }
    cleanupInFlight = true;
    const gen = generation;
    emit();
    let ack: AbortAck | null = null;
    try {
      // Idempotent by contract; the mode selects the lifecycle path (a single
      // token has no provider multipart upload to tear down).
      ack = await request<AbortAck>('upload:abort', { mode: m, token: tok });
    } catch {
      ack = null; // timeout / unreachable
    }
    cleanupInFlight = false;
    // A newer action (destroy, or a superseding generation bump) owns state now.
    if (gen !== generation) return;
    if (ack && ack.ok) {
      finishCleanup(); // confirmed terminal (incl. cleanupPending server-side)
      return;
    }
    // REFUSED or unreachable: retain ALL authority; surface a retry-cancel.
    cleanupError = ack ? ack.error || 'CANCEL_FAILED' : 'CANCEL_FAILED';
    cancelRetryAfterMs = ack && !ack.ok ? ack.retryAfterMs : undefined;
    emit();
  }

  /** Release authority after a CONFIRMED terminal abort. */
  function finishCleanup(): void {
    forgetPersisted();
    token = null;
    cleanupPending = false;
    cleanupError = undefined;
    cancelRetryAfterMs = undefined;
    cleanupInFlight = false;
    const origin = cleanupOrigin;
    cleanupOrigin = null;
    if (origin === 'cancel') {
      // A user cancel ends fully cancelled, holding nothing.
      fileRef = null;
      setPhase('cancelled');
    }
    // A terminal-failure cleanup KEEPS the File so a fresh start with the same
    // selection is possible; the phase stays 'failed'. token is now null, so
    // snapshot.retryable is false and the UI offers a fresh start, not resume.
    emit();
  }

  async function cancel(): Promise<void> {
    // RETRY a refused/unreachable cleanup: re-fire the abort, keeping the origin,
    // phase and all retained authority (works for a user cancel AND for a
    // terminal-failure cleanup whose abort was refused).
    if (cleanupPending) {
      await runCleanup();
      return;
    }
    generation += 1;
    // Abort the in-flight request IMMEDIATELY, but keep token/File/recovery until
    // the server acknowledges the lifecycle abort — a lost ack must not pretend it
    // is safe to start over.
    resetTransient();
    sampler.suspend();
    cleanupOrigin = 'cancel';
    setPhase('cancelling');
    await runCleanup();
  }

  async function retryUpload(file?: File): Promise<void> {
    if (mode === 'multipart' && token) return resume(file);
    const target = file || fileRef;
    if (target) return start(target);
  }

  function setOnline(next: boolean): void {
    if (online === next) return;
    online = next;
    if (!online) {
      // Offline time is not slow transfer: suspend sampling so a 3-minute outage
      // does not become a 0 B/s average and an ETA of hours.
      generation += 1;
      resetTransient();
      sampler.suspend();
      /*
       * Any IN-FLIGHT multipart phase becomes `reconnecting`, so `setOnline(true)`
       * can resume it. Narrowing this to uploading/retrying left a race: going
       * offline while `finalizing` (or in the brief `starting` window once a token
       * exists) stranded the upload — the phase stayed put, so coming back online
       * found nothing in `reconnecting` to resume.
       */
      if (
        mode === 'multipart' &&
        (phase === 'uploading' || phase === 'retrying' || phase === 'finalizing' || phase === 'starting')
      ) {
        setPhase('reconnecting');
        reportProgress('reconnecting');
      }
      return;
    }
    if (phase === 'reconnecting' && mode === 'multipart' && token && fileRef) {
      generation += 1;
      const myGeneration = generation;
      completionPromise = null; // a stranded finalizing must be allowed to retry
      sampler = createSpeedSampler();
      // Provider-confirmed state first, always: the parts that were in flight
      // when the network dropped may or may not have landed.
      void drive(myGeneration);
    }
  }

  /* A pending recovery is discovered eagerly so the UI can offer it. */
  {
    const found = loadSession(store, deps.roomCode, wallClock());
    if (found) {
      recovery = found;
      token = found.token;
      partSize = found.partSize;
      partCount = found.partCount;
      totalBytes = found.size;
      expiresAt = found.expiresAt;
      fileName = found.fileName;
      label = found.fileName;
      mode = 'multipart';
      // Ask the server what actually landed, so the offer shows a real number.
      void request<StatusAck>('upload:status', { token: found.token })
        .then((ack) => {
          if (!ack?.ok || recovery === null) return;
          completed.clear();
          for (const part of ack.completedParts || []) {
            completed.set(part.partNumber, { etag: part.etag, size: part.size });
          }
          emit();
        })
        .catch(() => {});
    } else {
      /*
       * A leftover SINGLE-SHOT lifecycle from a destroy/remount. There is no
       * byte-transfer to resume — only a live server session to close. Enter
       * cleanup and abort it with the persisted token: on ok:true the record is
       * cleared and a fresh upload becomes possible; on a refusal it stays and the
       * UI shows "Retry cancel" (no chooser, no new intent). This is what makes
       * single-shot disposal safe, mirroring the multipart recovery above.
       */
      const leftoverSingle = loadSingleCleanup(store, deps.roomCode, wallClock());
      if (leftoverSingle) {
        token = leftoverSingle.token;
        mode = 'single';
        fileName = leftoverSingle.fileName;
        label = leftoverSingle.fileName;
        totalBytes = leftoverSingle.size;
        expiresAt = leftoverSingle.expiresAt;
        cleanupOrigin = 'cancel';
        phase = 'cancelling';
        void runCleanup();
      }
    }
  }

  return {
    start,
    pause,
    resume,
    cancel,
    retry: retryUpload,
    subscribe(listener) {
      listeners.push(listener);
      listener(snapshot());
      return () => {
        listeners = listeners.filter((l) => l !== listener);
      };
    },
    getSnapshot: snapshot,
    pendingRecovery: () => recovery,
    setOnline,
    destroy() {
      /*
       * DISPOSAL PRESERVES RECOVERY (Option B), for BOTH transports.
       *
       * A controller is destroyed on unmount, which happens on a BARE REMOUNT (a
       * socket/room prop change, a React strict-mode double-mount) just as much as
       * on a true departure. Firing an `upload:abort` here would be wrong for both:
       * a remount wants the session KEPT so the next controller can act on it, and a
       * refused abort would strand a live session while discarding the client's only
       * authority. So disposal aborts the local XHR (resetTransient) but does NOT
       * send an abort and does NOT clear either persisted record.
       *
       *   - MULTIPART: the recovery record survives, and the next controller offers
       *     to resume it.
       *   - SINGLE: the cleanup record (persisted at intent) survives, and the next
       *     controller discovers it and runs the authoritative abort (see the
       *     recovery block below). Without this the single token — the ONLY thing
       *     that can close the session — died with the controller.
       *
       * A TRUE room departure is cleaned authoritatively SERVER-side. Note that
       * `useRoom` deliberately does NOT emit `room:leave` on unmount (a refresh
       * unmounts the tree too, and emitting leave there made a reload look like a
       * departure) — a plain unmount relies on the SOCKET DISCONNECT, whose
       * reconnect-grace expiry runs `departRoom` → `takeForMember`/`takeForRoom`,
       * aborting the member's sessions. So a session is recovered on a swap or
       * reaped on a departure — never silently orphaned by a resolved abort refusal.
       */
      destroyed = true;
      generation += 1;
      resetTransient();
      listeners = [];
      fileRef = null;
    },
    debug: () => ({
      maxConcurrentSlices,
      activeSlices,
      pendingTimers: timers.size,
      activeXhrs: activeXhrs.size,
      activeWorkers,
      activeSleepers,
      hasToken: !!token,
    }),
  };
}
