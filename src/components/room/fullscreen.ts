/**
 * Pure fullscreen-ownership + idle-chrome rules for the player.
 *
 * CineVerse must be the ONLY owner of fullscreen for a YouTube source. A
 * cross-origin iframe that takes native fullscreen cannot be overlaid by the
 * parent document, so the app loses its exit button and the viewer is trapped.
 * These predicates are React-free so the ownership test and the idle rule can be
 * unit-tested without a browser (see scripts/fullscreen.test.mjs).
 */

/** How long the fullscreen chrome (cursor + exit button) stays up when idle. */
export const FULLSCREEN_CHROME_IDLE_MS = 2400;

/**
 * Whether OUR player shell is the element in fullscreen. Anything else — most
 * importantly a YouTube iframe — is NOT our fullscreen, and the UI must not
 * pretend it owns it.
 */
export function isShellFullscreen(shell: Element | null, fullscreenElement: Element | null): boolean {
  return Boolean(shell && fullscreenElement && shell === fullscreenElement);
}

/**
 * Whether some element other than our shell has taken fullscreen. For a YouTube
 * source this is the trap case and must be undone immediately.
 */
export function isForeignFullscreen(shell: Element | null, fullscreenElement: Element | null): boolean {
  return Boolean(fullscreenElement && fullscreenElement !== shell);
}

/**
 * Whether the fullscreen chrome should be showing. Outside fullscreen this is
 * always true (the normal control rules apply); inside fullscreen it hides once
 * the pointer has been still for the idle window.
 */
export function shouldShowFullscreenChrome(params: {
  fullscreen: boolean;
  lastPointerAt: number;
  now: number;
  idleMs?: number;
}): boolean {
  if (!params.fullscreen) return true;
  const idleMs = params.idleMs ?? FULLSCREEN_CHROME_IDLE_MS;
  return params.now - params.lastPointerAt < idleMs;
}

/**
 * Whether the YouTube iframe should stop intercepting pointer events.
 *
 * A cross-origin iframe keeps drawing its own cursor, so `cursor-none` on the
 * parent cannot hide it while the pointer is over the iframe. While the chrome
 * is idle-hidden we let pointer events pass to the parent instead, which both
 * hides the cursor and lets the very next mouse move wake the chrome back up.
 * Only ever true in fullscreen — normal embedded controls must stay clickable.
 */
export function shouldDisableIframePointerEvents(params: {
  isYouTube: boolean;
  fullscreen: boolean;
  chromeVisible: boolean;
}): boolean {
  return Boolean(params.isYouTube && params.fullscreen && !params.chromeVisible);
}

/* -------------------------------------------------------------------------- */
/*  Cross-browser fullscreen capability                                       */
/*                                                                            */
/*  The unprefixed Fullscreen API is not universal, and that is exactly why    */
/*  the button worked on a laptop but did nothing on a phone:                  */
/*                                                                            */
/*    - iPhone Safari has NO Element.requestFullscreen at all. The only        */
/*      fullscreen it offers is HTMLVideoElement.webkitEnterFullscreen(),      */
/*      which hands the video to the native iOS player (with its own Done      */
/*      button, so there is no trap to guard against).                         */
/*    - iPadOS / older Safari expose the webkit-prefixed ELEMENT API.          */
/*    - Older Edge exposes the ms-prefixed one.                                */
/*                                                                            */
/*  Calling only `element.requestFullscreen()` therefore fails silently on the */
/*  devices most likely to want fullscreen. These helpers are pure lookups     */
/*  over injected objects so they can be unit-tested without a browser.        */
/* -------------------------------------------------------------------------- */

type PrefixedDocument = Document & {
  webkitFullscreenElement?: Element | null;
  msFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
  msExitFullscreen?: () => Promise<void> | void;
};

type PrefixedElement = Element & {
  webkitRequestFullscreen?: () => Promise<void> | void;
  msRequestFullscreen?: () => Promise<void> | void;
};

/** A video element with the iOS-only native fullscreen entry points. */
export type IosVideoElement = HTMLVideoElement & {
  webkitEnterFullscreen?: () => void;
  webkitExitFullscreen?: () => void;
  webkitSupportsFullscreen?: boolean;
  webkitDisplayingFullscreen?: boolean;
};

/** The element currently in fullscreen, across vendor prefixes. */
export function fullscreenElementOf(doc: Document | null | undefined): Element | null {
  if (!doc) return null;
  const d = doc as PrefixedDocument;
  return d.fullscreenElement ?? d.webkitFullscreenElement ?? d.msFullscreenElement ?? null;
}

/** Whether an ARBITRARY element (our shell) can be taken fullscreen at all. */
export function supportsElementFullscreen(el: Element | null | undefined): boolean {
  if (!el) return false;
  const e = el as PrefixedElement;
  return typeof e.requestFullscreen === 'function' || typeof e.webkitRequestFullscreen === 'function' || typeof e.msRequestFullscreen === 'function';
}

/** Whether iOS's native video fullscreen is available on this video element. */
export function supportsVideoFullscreen(video: HTMLVideoElement | null | undefined): boolean {
  if (!video) return false;
  const v = video as IosVideoElement;
  // `webkitSupportsFullscreen` is false until metadata loads, so the presence of
  // the METHOD is what decides capability; the flag only gates the call itself.
  return typeof v.webkitEnterFullscreen === 'function';
}

/**
 * Take `el` fullscreen using whichever API exists. Resolves false when the
 * platform has no element-level fullscreen (iPhone) so the caller can fall back
 * to the video element rather than appearing to do nothing.
 */
export async function requestElementFullscreen(el: Element | null | undefined): Promise<boolean> {
  if (!el) return false;
  const e = el as PrefixedElement;
  const request = e.requestFullscreen ?? e.webkitRequestFullscreen ?? e.msRequestFullscreen;
  if (typeof request !== 'function') return false;
  try {
    await request.call(e);
    return true;
  } catch {
    // A browser can refuse without a direct user gesture, or mid-transition.
    return false;
  }
}

/**
 * Hand a video to iOS's native fullscreen player. Returns false when the call is
 * unavailable or the video has no loadable media yet.
 */
export function enterVideoFullscreen(video: HTMLVideoElement | null | undefined): boolean {
  if (!video) return false;
  const v = video as IosVideoElement;
  if (typeof v.webkitEnterFullscreen !== 'function') return false;
  // iOS refuses before metadata exists; treat that as "not yet", not a crash.
  if (v.webkitSupportsFullscreen === false) return false;
  try {
    v.webkitEnterFullscreen();
    return true;
  } catch {
    return false;
  }
}

/** Leave fullscreen, whichever API (or iOS video) is holding it. */
export async function exitAnyFullscreen(doc: Document | null | undefined, video?: HTMLVideoElement | null): Promise<void> {
  const v = video as IosVideoElement | null | undefined;
  if (v && v.webkitDisplayingFullscreen && typeof v.webkitExitFullscreen === 'function') {
    try {
      v.webkitExitFullscreen();
    } catch {
      /* already leaving */
    }
    return;
  }
  if (!doc) return;
  const d = doc as PrefixedDocument;
  const exit = d.exitFullscreen ?? d.webkitExitFullscreen ?? d.msExitFullscreen;
  if (typeof exit !== 'function') return;
  try {
    await exit.call(d);
  } catch {
    /* already exiting, or not permitted */
  }
}
