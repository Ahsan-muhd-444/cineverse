/**
 * Retry-safe loader for the YouTube IFrame API.
 *
 * The previous loader cached a module-level promise that could stay pending
 * forever: if `onYouTubeIframeAPIReady` was never called (script cached, hot
 * reload, another library replacing the global, a partially-loaded script), the
 * promise never settled and every later mount reused the same poisoned promise.
 * A room refresh onto an existing YouTube source then failed permanently.
 *
 * This loader fixes that by owning its own outcome:
 *   - it resolves on the global callback OR on a poll that sees `YT.Player`;
 *   - it owns the timeout and REJECTS (the component no longer runs its own
 *     timer that merely painted an error while the promise hung);
 *   - every failure clears the cached promise and the stale script, so the next
 *     attempt is genuinely fresh.
 *
 * All environment access goes through an injectable `env`, so the state machine
 * is unit-tested deterministically — no browser, no real timers, no network
 * (see scripts/youtube-api.test.mjs).
 */

/** Why a YouTube source failed. `api` is retryable; `video` is not. */
export type YouTubeFailure = { kind: 'api'; message: string } | { kind: 'video'; message: string };

export const YOUTUBE_SCRIPT_ID = 'cineverse-youtube-iframe-api';
export const YOUTUBE_API_SRC = 'https://www.youtube.com/iframe_api';
export const YOUTUBE_API_TIMEOUT_MS = 12_000;
export const YOUTUBE_API_POLL_MS = 50;

export const YOUTUBE_API_ERROR = 'YOUTUBE_API_ERROR';
export const YOUTUBE_API_TIMEOUT = 'YOUTUBE_API_TIMEOUT';
/** The loader resolved, but the global was gone by the time we used it. */
export const YOUTUBE_API_UNAVAILABLE = 'YOUTUBE_API_UNAVAILABLE_AFTER_LOAD';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface LoaderEnv {
  win: any;
  doc: any;
  setTimeout: (fn: () => void, ms: number) => any;
  clearTimeout: (handle: any) => void;
  setInterval: (fn: () => void, ms: number) => any;
  clearInterval: (handle: any) => void;
}

/** Safe even when imported where there is no DOM (SSR): never throws on access. */
function defaultEnv(): LoaderEnv {
  const win: any = typeof window !== 'undefined' ? window : {};
  const doc: any =
    typeof document !== 'undefined'
      ? document
      : { getElementById: () => null, createElement: () => ({}), head: { appendChild: () => {} } };
  return {
    win,
    doc,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h),
  };
}

/** The single in-flight load, shared by concurrent callers. */
let apiPromise: Promise<void> | null = null;
/** Tear-down + failure hooks for that in-flight load, so a reset can settle it. */
let activeCleanup: (() => void) | null = null;
let activeFail: ((error: Error) => void) | null = null;

function removeElement(el: any): void {
  if (!el) return;
  if (typeof el.remove === 'function') el.remove();
  else if (el.parentNode?.removeChild) el.parentNode.removeChild(el);
}

/**
 * Whether a window-like object exposes a usable YouTube API *right now*.
 *
 * Worth checking again even after `loadYouTubeApi()` resolves: the global can
 * disappear between resolution and the `.then()` microtask (hot reload, another
 * script replacing it). Treating that as "fine" left the engine silently
 * returning and the UI stuck on "Loading YouTube…" with no way to retry.
 */
export function hasUsableYouTubeApi(win: unknown): boolean {
  return Boolean((win as any)?.YT?.Player);
}

/** Whether the API is usable right now, using the loader's environment. */
export function isYouTubeApiReady(env: Partial<LoaderEnv> = {}): boolean {
  return hasUsableYouTubeApi(env.win ?? defaultEnv().win);
}

/**
 * Load the YouTube IFrame API, reusing an in-flight load and an existing script
 * tag. Rejects with `YOUTUBE_API_ERROR` / `YOUTUBE_API_TIMEOUT` — and clears its
 * own cache on the way out, so the caller may simply try again.
 */
export function loadYouTubeApi(envOverride: Partial<LoaderEnv> = {}): Promise<void> {
  const env: LoaderEnv = { ...defaultEnv(), ...envOverride };

  // Already there (e.g. a second source in the same session): nothing to do.
  if (env.win?.YT?.Player) return Promise.resolve();
  // Concurrent callers share one load.
  if (apiPromise) return apiPromise;

  apiPromise = new Promise<void>((resolve, reject) => {
    let settled = false;
    let pollHandle: any = null;
    let timeoutHandle: any = null;

    // Preserve any callback another library (or an earlier attempt) installed.
    const previousCallback = env.win.onYouTubeIframeAPIReady;

    const cleanup = () => {
      if (pollHandle !== null) env.clearInterval(pollHandle);
      if (timeoutHandle !== null) env.clearTimeout(timeoutHandle);
      pollHandle = null;
      timeoutHandle = null;
      // Never leave our wrapper installed once we're done with it.
      if (env.win.onYouTubeIframeAPIReady === onReady) {
        env.win.onYouTubeIframeAPIReady = previousCallback;
      }
    };

    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      activeCleanup = null;
      activeFail = null;
      // The cache represents an IN-FLIGHT load only. Holding a resolved promise
      // forever would let a later call skip straight past a `YT.Player` that has
      // since disappeared (hot reload, another script replacing the global),
      // handing the engine a resolved promise with no usable API — it would then
      // return silently and sit on "loading" with no retryable error. Clearing it
      // costs nothing: while pending, concurrent callers still share this promise,
      // and once resolved the `YT.Player` fast path takes over.
      apiPromise = null;
      resolve();
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      activeCleanup = null;
      activeFail = null;
      // Clear the cache so the NEXT call starts a fresh attempt. This is the
      // core of the bug fix: a failed load must never poison later mounts.
      apiPromise = null;
      // Drop the stale script — but only if the API really isn't available, so
      // a late-but-successful load is never destroyed.
      if (!env.win?.YT?.Player) removeElement(env.doc.getElementById(YOUTUBE_SCRIPT_ID));
      reject(error);
    };

    function onReady() {
      // Don't swallow someone else's callback.
      try {
        previousCallback?.();
      } catch {
        /* not our problem, and must not block our own completion */
      }
      succeed();
    }
    env.win.onYouTubeIframeAPIReady = onReady;

    // Belt and braces: the global callback can be missed entirely (cached
    // script, hot reload, another loader overwriting it), so also watch for the
    // API simply appearing.
    pollHandle = env.setInterval(() => {
      if (env.win?.YT?.Player) succeed();
    }, YOUTUBE_API_POLL_MS);

    // The LOADER owns the deadline, so a hang becomes a rejection + cache clear.
    timeoutHandle = env.setTimeout(() => fail(new Error(YOUTUBE_API_TIMEOUT)), YOUTUBE_API_TIMEOUT_MS);

    activeCleanup = cleanup;
    activeFail = fail;

    // Exactly one script tag, identified by a stable id.
    const existing = env.doc.getElementById(YOUTUBE_SCRIPT_ID);
    if (existing) {
      // Reuse it, but make sure a later error still reaches us.
      existing.onerror = () => fail(new Error(YOUTUBE_API_ERROR));
    } else {
      const script = env.doc.createElement('script');
      script.id = YOUTUBE_SCRIPT_ID;
      script.src = YOUTUBE_API_SRC;
      script.async = true;
      script.onerror = () => fail(new Error(YOUTUBE_API_ERROR));
      env.doc.head.appendChild(script);
    }
  });

  return apiPromise;
}

/**
 * Clear failed/pending loader state so the next `loadYouTubeApi()` retries from
 * scratch. Deliberately conservative: if the API is already healthy this only
 * drops the cached promise — it never deletes `window.YT` or a working script.
 */
export function resetYouTubeApiLoader(envOverride: Partial<LoaderEnv> = {}): void {
  const env: LoaderEnv = { ...defaultEnv(), ...envOverride };

  // Settle anything in flight so awaiting callers don't hang forever.
  if (activeFail) activeFail(new Error(YOUTUBE_API_ERROR));
  else if (activeCleanup) activeCleanup();
  activeCleanup = null;
  activeFail = null;
  apiPromise = null;

  // A healthy API is never torn down.
  if (env.win?.YT?.Player) return;
  removeElement(env.doc.getElementById(YOUTUBE_SCRIPT_ID));
}
