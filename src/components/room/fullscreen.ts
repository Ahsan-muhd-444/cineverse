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
