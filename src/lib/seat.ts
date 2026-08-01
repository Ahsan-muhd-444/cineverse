'use client';

/**
 * Stable per-tab, per-room seat identity.
 *
 * A Socket.IO connection id changes on every refresh, so it cannot be a person's
 * identity — using it made a reload look like someone leaving and a stranger
 * arriving. Instead each tab mints an unguessable seat token per room and sends
 * it with `room:join`; the server uses it to hand back the same seat.
 *
 * `sessionStorage` is deliberate:
 *   - it survives a refresh in the SAME tab (which is exactly the case we fix);
 *   - it is per-tab, so two tabs in one profile get different seats instead of
 *     fighting over one (localStorage would collide);
 *   - it is dropped when the tab closes, which is the right lifetime for a seat.
 *
 * The token is a bearer credential for the seat, so it never leaves this tab
 * except in the join payload, and the server never broadcasts it.
 */

const keyFor = (roomCode: string) => `cineverse:seat:${String(roomCode || '').toUpperCase()}`;

function randomId(): string {
  try {
    const c = globalThis.crypto;
    if (c?.randomUUID) return c.randomUUID().replace(/-/g, '');
    if (c?.getRandomValues) {
      const bytes = c.getRandomValues(new Uint8Array(16));
      return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    }
  } catch {
    /* fall through to the non-crypto path below */
  }
  // Last resort (very old browsers): still unique enough to key a seat.
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * The seat token for this tab + room, creating one on first use. Returns an
 * empty string when storage is unavailable (SSR, hardened privacy modes), in
 * which case the server simply treats the join as a brand-new arrival.
 */
export function getSeatId(roomCode: string): string {
  if (typeof window === 'undefined') return '';
  const key = keyFor(roomCode);
  try {
    const existing = window.sessionStorage.getItem(key);
    if (existing) return existing;
    const fresh = randomId();
    window.sessionStorage.setItem(key, fresh);
    return fresh;
  } catch {
    return '';
  }
}

/** Give up this tab's claim on a seat — used on an explicit "leave room". */
export function clearSeatId(roomCode: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.removeItem(keyFor(roomCode));
  } catch {
    /* nothing to clean up */
  }
}
