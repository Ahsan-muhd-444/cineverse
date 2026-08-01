/**
 * Small accessibility helpers shared by the room's overlays.
 *
 * They exist as pure functions rather than inline conditions because the rules
 * are easy to get subtly wrong and impossible to notice by looking: an Escape
 * handler that also fires for Ctrl+Escape, or a reaction pill whose accessible
 * name is just an emoji and a bare number.
 *
 * Unit-tested in scripts/a11y.test.mjs.
 */

/** The minimum shape needed to decide — so tests need no real KeyboardEvent. */
export interface DismissKeyEvent {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  defaultPrevented?: boolean;
}

/**
 * Whether a key press should close an open overlay.
 *
 * Plain Escape only. A modified Escape belongs to the browser or the OS, and an
 * event something else already handled must not be acted on twice — otherwise
 * one press closes a picker AND the dialog behind it.
 */
export function isDismissKey(event: DismissKeyEvent): boolean {
  if (event.key !== 'Escape') return false;
  if (event.defaultPrevented) return false;
  return !(event.ctrlKey || event.metaKey || event.altKey || event.shiftKey);
}

/**
 * Accessible name for a reaction pill.
 *
 * "😂 3" is announced as the emoji's name followed by a naked number, which
 * tells a screen-reader user nothing about what the number counts.
 */
export function describeReaction(emoji: string, count: number): string {
  const n = Math.max(0, Math.floor(count));
  return `${emoji}, ${n} ${n === 1 ? 'reaction' : 'reactions'} — press to toggle yours`;
}

/**
 * Accessible name for a connection-quality indicator.
 *
 * The pill is colour-coded, and colour alone is never allowed to be the signal.
 * The visible label carries the latency; this carries the meaning.
 */
export function describeConnection(quality: string, latency: number): string {
  const ms = Number.isFinite(latency) && latency > 0 ? `, ${Math.round(latency)} milliseconds` : '';
  switch (quality) {
    case 'offline':
      return 'Connection lost — reconnecting';
    case 'excellent':
      return `Connection excellent${ms}`;
    case 'good':
      return `Connection good${ms}`;
    case 'fair':
      return `Connection fair${ms}`;
    case 'poor':
      return `Connection poor${ms}`;
    default:
      return `Connection ${quality}${ms}`;
  }
}
