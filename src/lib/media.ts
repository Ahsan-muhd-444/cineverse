import type { MediaSource, SourceType } from '@/lib/types';

/**
 * Media-source parsing and normalization.
 *
 * The one place that turns whatever a user pasted (a YouTube link, a bare video
 * ID, a direct file URL) into a canonical `MediaSource`. Kept free of React and
 * socket imports so it can be unit-tested on its own.
 */

const YT_ID = /^[\w-]{11}$/;

// Ordered so the most specific path wins; each captures the 11-char video ID.
const YT_URL_PATTERNS = [
  /(?:youtube\.com\/watch\?(?:.*&)?v=)([\w-]{11})/i,
  /(?:youtu\.be\/)([\w-]{11})/i,
  /(?:youtube\.com\/embed\/)([\w-]{11})/i,
  /(?:youtube\.com\/shorts\/)([\w-]{11})/i,
  /(?:youtube\.com\/live\/)([\w-]{11})/i,
  /(?:youtube\.com\/v\/)([\w-]{11})/i,
];

/**
 * Pull an 11-character YouTube video ID out of a watch / youtu.be / embed /
 * shorts / live / `/v/` URL (ignoring `t`, `list`, `si` and other params), or
 * accept a bare ID as-is. Returns null when there is no YouTube ID to find.
 */
export function extractYouTubeId(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = String(input).trim();
  if (YT_ID.test(trimmed)) return trimmed;
  for (const pattern of YT_URL_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) return match[1];
  }
  return null;
}

/** Whether a string looks like a YouTube link or a bare YouTube video ID. */
export function isYouTubeInput(input: string | null | undefined): boolean {
  if (!input) return false;
  const value = String(input).trim();
  return /(?:youtube\.com|youtu\.be)/i.test(value) || YT_ID.test(value);
}

const DEFAULT_LABELS: Record<SourceType, string> = {
  youtube: 'YouTube video',
  url: 'Shared link',
  catalog: 'Open Cinema',
  local: 'Local file',
};

const VALID_TYPES: SourceType[] = ['youtube', 'url', 'catalog', 'local'];

export interface RawSource {
  type?: string;
  value: string;
  label?: string;
  poster?: string;
  quality?: string;
  variants?: { label: string; value: string }[];
  subtitles?: { label: string; src: string; lang: string }[];
}

/**
 * Canonicalize a chosen source.
 *
 * A YouTube link or bare ID — whatever `type` was guessed — becomes
 * `{ type: 'youtube', value: '<videoId>' }`. Direct URLs stay `type: 'url'`;
 * catalog and local sources keep their declared type (their `value` is a
 * catalog URL / filename and must never be reinterpreted as YouTube). If a
 * source claims to be YouTube but no ID can be extracted, it falls back to a
 * plain URL source so nothing is silently dropped.
 */
export function normalizeMediaSource(raw: RawSource): MediaSource {
  const label = (raw.label ?? '').trim();
  const declared = raw.type;

  // Only an unspecified or URL-typed source may be reinterpreted as YouTube.
  const mayBeYouTube =
    declared === 'youtube' ||
    ((declared === undefined || declared === 'url') && isYouTubeInput(raw.value));

  if (mayBeYouTube) {
    const id = extractYouTubeId(raw.value);
    if (id) {
      return { type: 'youtube', value: id, label: label || DEFAULT_LABELS.youtube };
    }
    // Declared YouTube but unparseable — fall through to a URL source.
  }

  const type: SourceType =
    declared && VALID_TYPES.includes(declared as SourceType) && declared !== 'youtube'
      ? (declared as SourceType)
      : 'url';

  return {
    type,
    value: raw.value,
    label: label || DEFAULT_LABELS[type],
    poster: raw.poster,
    quality: raw.quality,
    variants: raw.variants,
    subtitles: raw.subtitles,
  };
}

/**
 * The playable YouTube ID for a source, or null. `value` is already the ID for
 * a normalized source; the extract call is a legacy fallback for rooms that
 * still hold a full YouTube URL from before normalization existed.
 */
export function resolveYouTubeId(source: Pick<MediaSource, 'type' | 'value'> | null | undefined): string | null {
  if (!source || source.type !== 'youtube') return null;
  return extractYouTubeId(source.value);
}

/**
 * Whether the YouTube player must be torn down and rebuilt. The iframe should be
 * recreated ONLY when the actual video identity changes — never for a changed
 * callback identity or an unrelated parent re-render.
 */
export function shouldRecreateYouTubePlayer(
  prevVideoId: string | null | undefined,
  nextVideoId: string | null | undefined,
): boolean {
  return prevVideoId !== nextVideoId;
}
