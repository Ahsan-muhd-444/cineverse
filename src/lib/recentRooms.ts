/**
 * Retention rules for the recent-room list.
 *
 * These codes are held in localStorage and never leave the browser: the server
 * has no room-listing endpoint, and a passphrase is checked server-side on every
 * join, so a code alone opens nothing that is actually locked. The risk this
 * addresses is the remaining one — a SHARED device. A code that sat on the home
 * screen indefinitely let whoever picked the phone up next walk straight into an
 * unlocked room.
 *
 * Rooms are ephemeral anyway (the server reaps one 15 minutes after the last
 * person leaves), so an old code is almost always dead already — it is exposure
 * without benefit.
 *
 * Dependency-free on purpose, so the rules can be unit-tested directly without a
 * DOM (see scripts/recent-rooms.test.mjs).
 */

export interface RecentRoomEntry {
  code: string;
  label?: string;
  at: number;
}

/**
 * How long a room code stays in this browser's list. Twelve hours comfortably
 * covers "we're watching again this evening" and expires everything else.
 */
export const RECENT_ROOM_TTL_MS = 12 * 60 * 60 * 1000;

/** The most recent rooms kept at once. */
export const RECENT_ROOM_LIMIT = 8;

/** Whether an entry is well-formed AND still within the retention window. */
export function isFreshRoom(entry: unknown, now: number, ttlMs: number = RECENT_ROOM_TTL_MS): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const room = entry as Partial<RecentRoomEntry>;
  if (typeof room.code !== 'string' || room.code.length === 0) return false;
  if (!Number.isFinite(room.at)) return false;
  return now - (room.at as number) < ttlMs;
}

/**
 * The list as it should be stored: malformed and expired entries dropped, and
 * never more than the cap. Callers persist the result, so an expired code cannot
 * reappear on the next read.
 */
export function pruneRecentRooms(
  list: unknown,
  now: number,
  ttlMs: number = RECENT_ROOM_TTL_MS,
): RecentRoomEntry[] {
  if (!Array.isArray(list)) return [];
  return list.filter((entry) => isFreshRoom(entry, now, ttlMs)).slice(0, RECENT_ROOM_LIMIT) as RecentRoomEntry[];
}

/** The list with `code` moved to the front, deduplicated and capped. */
export function withRoomRemembered(
  list: unknown,
  code: string,
  label: string | undefined,
  now: number,
  ttlMs: number = RECENT_ROOM_TTL_MS,
): RecentRoomEntry[] {
  const rest = pruneRecentRooms(list, now, ttlMs).filter((room) => room.code !== code);
  return [{ code, label, at: now }, ...rest].slice(0, RECENT_ROOM_LIMIT);
}

/** The list without `code`. */
export function withRoomForgotten(list: unknown, code: string, now: number, ttlMs: number = RECENT_ROOM_TTL_MS): RecentRoomEntry[] {
  return pruneRecentRooms(list, now, ttlMs).filter((room) => room.code !== code);
}
