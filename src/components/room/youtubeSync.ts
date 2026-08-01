/**
 * Pure helpers for syncing NATIVE YouTube control usage into the room.
 *
 * In YouTube-native mode the user drives YouTube's own controls; CineVerse only
 * listens (to mirror play/pause/seek/rate into the room) and applies remote
 * commands through the IFrame API. The tricky part is not echoing the room's own
 * programmatic commands back as if they were fresh local actions. These helpers
 * are React-free so that echo-suppression and seek detection can be unit-tested
 * without a browser (see scripts/youtube-sync.test.mjs).
 */

/**
 * Whether a native YouTube event should be emitted to the room as a local user
 * action. It must NOT be emitted while a remote command is being applied
 * (`isApplying`) or within the suppression window opened by a programmatic
 * command (`now < suppressUntil`) — those events were caused by us, not by the
 * user.
 */
export function shouldEmitNativeEvent(params: {
  isApplying: boolean;
  suppressUntil: number;
  now: number;
}): boolean {
  return !params.isApplying && params.now >= params.suppressUntil;
}

/**
 * Whether a jump in reported playhead looks like a user seek rather than normal
 * playback progression. Normal advance between polls is well under the
 * threshold (even at 2x); a larger jump — forward or backward — is a seek.
 */
export function isNativeSeek(prevTime: number, currTime: number, threshold = 2): boolean {
  if (!Number.isFinite(prevTime) || !Number.isFinite(currTime)) return false;
  return Math.abs(currTime - prevTime) > threshold;
}

/**
 * Debounce guard so one native seek (which can report a couple of intermediate
 * jumps) does not emit a burst of seek events.
 */
export function seekDebounceOk(lastEmitAt: number, now: number, debounceMs = 700): boolean {
  return now - lastEmitAt >= debounceMs;
}
