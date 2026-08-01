/**
 * Pure playhead-projection helpers for the sync engine.
 *
 * Kept free of React and socket imports so the rate-aware projection can be
 * unit-tested on its own (see scripts/playback-projection.test.mjs). `now` and
 * `serverTime` are both on the server timeline (the caller passes `serverNow()`),
 * so this function does no clock math itself.
 */

export interface ServerPlaybackState {
  time: number;
  playing: boolean;
  rate?: number;
  serverTime: number;
  /** Current playback-authority epoch — carried back on heartbeats so the server
   *  can reject stale reports. Present on sync:request replies. */
  controlSeq?: number;
  sourceVersion?: number;
  controllerId?: string | null;
}

/** Clamp a room rate to a sane positive multiplier; anything invalid → 1x. */
export function normalizeRate(rate: number | null | undefined): number {
  return typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? rate : 1;
}

/**
 * Project the room's authoritative playhead to `now`.
 *
 * A paused room does not advance. A playing room advances by the elapsed real
 * time SCALED BY the playback rate — so a room running at 2x that answered 5s
 * ago is 10s further along, not 5s. Ignoring the rate (the previous bug) landed
 * late joiners, resync and drift correction on the wrong frame at any non-1x
 * speed.
 */
export function projectPlaybackState(state: ServerPlaybackState, now: number): number {
  if (!state.playing) return state.time;
  const rate = normalizeRate(state.rate);
  const elapsed = Math.max(0, (now - state.serverTime) / 1000);
  return state.time + elapsed * rate;
}

/**
 * Whether a play attempt should be treated as blocked by the browser's
 * autoplay policy — i.e. we asked the engine to play, gave it a beat, and it is
 * READY but still reporting PAUSED. A never-ready engine is still starting up
 * (not blocked); a playing/buffering engine is fine. Kept pure so the
 * blocked-autoplay decision can be unit-tested without a browser.
 */
export function shouldPromptPlaybackGesture(ready: boolean, paused: boolean): boolean {
  return ready && paused;
}

/**
 * Whether the HTML5 (`<video>`) player should show its loading/buffering
 * overlay. Kept pure so the rule is unit-tested and can't silently regress.
 *
 * Two — and only two — reasons to cover the picture:
 *   1. startup: a source is set but the engine has not reported ready yet;
 *   2. buffering: the engine is ready and actively PLAYING but stalled waiting
 *      for data.
 *
 * Crucially, a ready video PAUSED on its first frame is NOT loading — a stuck
 * `waiting` flag must never blur the picture or hide the controls forever. A
 * failed source shows its own error, never the spinner.
 */
export function shouldShowHtml5Loading(params: {
  hasSource: boolean;
  ready: boolean;
  failed: boolean;
  waiting: boolean;
  playing: boolean;
}): boolean {
  if (params.failed) return false;
  if (params.hasSource && !params.ready) return true;
  return Boolean(params.ready && params.waiting && params.playing);
}

export interface SeekHold {
  /** Where the user just asked to be. */
  target: number;
  /** Wall-clock ms after which the hold expires regardless. */
  until: number;
}

/**
 * What the seek bar should display while a fresh local seek settles.
 *
 * YouTube (and a buffering <video>) keeps reporting the OLD playhead for a
 * moment after seekTo(), so echoing the engine's time right after a drag makes
 * the bar visibly snap back. While a hold is active and the engine still
 * reports a time far from the target, show the target; once the engine lands
 * near it (or the hold expires) trust the engine again.
 *
 * Returns the position to display plus whether the hold is still active.
 */
export function resolveDisplayedPosition(
  hold: SeekHold | null,
  engineTime: number,
  now: number,
  settleWindow = 0.75,
): { position: number; holding: boolean } {
  if (hold && now < hold.until && Math.abs(engineTime - hold.target) > settleWindow) {
    return { position: hold.target, holding: true };
  }
  return { position: engineTime, holding: false };
}
