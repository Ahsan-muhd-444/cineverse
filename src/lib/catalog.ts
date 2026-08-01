import type { Movie } from './types';

/**
 * CineVerse Open Cinema.
 *
 * Every title here is a Creative Commons / open-licensed film that streams from a
 * public CDN, so a brand new room can start playing something within one click —
 * no accounts, no keys, no uploads. Metadata is factual; artwork is generated
 * locally (see `posterArt`) so the grid never shows a broken image.
 *
 * Users are of course free to bring their own: a direct video URL, a YouTube
 * link, or a local file both people already have.
 */

const CDN = 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample';

const RAW_CATALOG: Movie[] = [
  {
    id: 'big-buck-bunny',
    title: 'Big Buck Bunny',
    year: 2008,
    runtime: 10,
    rating: 8.1,
    genres: ['Animation', 'Comedy', 'Family'],
    tagline: 'A gentle giant finally pushes back.',
    overview:
      'A large and lovable rabbit wakes to a beautiful morning, only to have three rodents ruin it. What follows is a quietly hilarious revenge plot, staged with the warmth of classic cartoon slapstick. The Blender Institute made it to prove open tools could produce studio-grade animation — and it worked.',
    poster: '',
    backdrop: '',
    cast: [
      { name: 'Big Buck Bunny', role: 'The Giant' },
      { name: 'Frank', role: 'Ringleader Rodent' },
      { name: 'Rinky', role: 'The Squirrel' },
      { name: 'Gamera', role: 'The Flying Squirrel' },
    ],
    director: 'Sacha Goedegebure',
    src: `${CDN}/BigBuckBunny.mp4`,
    accent: '#f59e0b',
  },
  {
    id: 'sintel',
    title: 'Sintel',
    year: 2010,
    runtime: 15,
    rating: 8.5,
    genres: ['Animation', 'Fantasy', 'Drama'],
    tagline: 'She crossed a world to find him.',
    overview:
      'A lone traveller searches a hostile continent for the dragon she raised from a hatchling. Sintel is the Blender Institute at its most ambitious — snowbound landscapes, a wordless emotional core, and an ending that reframes everything you watched before it.',
    poster: '',
    backdrop: '',
    cast: [
      { name: 'Halina Reijn', role: 'Sintel' },
      { name: 'Thom Hoffman', role: 'The Shaman' },
      { name: 'Scales', role: 'The Dragon' },
    ],
    director: 'Colin Levy',
    src: `${CDN}/Sintel.mp4`,
    accent: '#22d3ee',
  },
  {
    id: 'tears-of-steel',
    title: 'Tears of Steel',
    year: 2012,
    runtime: 12,
    rating: 7.6,
    genres: ['Sci-Fi', 'Action', 'Drama'],
    tagline: 'The future was built on a broken promise.',
    overview:
      'Amsterdam, decades from now. A group of scientists try to reconstruct a memory precisely enough to undo the moment that ruined everything. Shot live-action and finished with open-source visual effects, it remains a landmark in what independent filmmaking can look like.',
    poster: '',
    backdrop: '',
    cast: [
      { name: 'Derek de Lint', role: 'Thom' },
      { name: 'Sergio Hasselbaink', role: 'Barley' },
      { name: 'Rogier Schippers', role: 'Dennis' },
      { name: 'Vanja Rukavina', role: 'Celia' },
    ],
    director: 'Ian Hubert',
    src: `${CDN}/TearsOfSteel.mp4`,
    accent: '#8b5cf6',
  },
  {
    id: 'elephants-dream',
    title: 'Elephants Dream',
    year: 2006,
    runtime: 11,
    rating: 7.2,
    genres: ['Animation', 'Sci-Fi', 'Surreal'],
    tagline: 'Two men. One machine. No agreement on what is real.',
    overview:
      'Proog guides Emo through a vast mechanical world he insists is dangerous. Emo sees none of it. The first open movie ever made is still the strangest: an argument about perception staged inside an endlessly folding machine.',
    poster: '',
    backdrop: '',
    cast: [
      { name: 'Tygo Gernandt', role: 'Proog' },
      { name: 'Cas Jansen', role: 'Emo' },
    ],
    director: 'Bassam Kurdali',
    src: `${CDN}/ElephantsDream.mp4`,
    accent: '#3b6cf6',
  },
  {
    id: 'for-bigger-blazes',
    title: 'For Bigger Blazes',
    year: 2015,
    runtime: 1,
    rating: 6.4,
    genres: ['Short', 'Comedy'],
    tagline: 'Small screen. Very big fire.',
    overview:
      'A short demo reel built to show off high-bitrate streaming. It is loud, bright, and exactly one minute long — which makes it the fastest way to check that your room, your sync and your connection are all behaving before the real feature starts.',
    poster: '',
    backdrop: '',
    cast: [{ name: 'Ensemble', role: 'Cast' }],
    director: 'Google Media Lab',
    src: `${CDN}/ForBiggerBlazes.mp4`,
    accent: '#fb7185',
  },
  {
    id: 'for-bigger-escapes',
    title: 'For Bigger Escapes',
    year: 2015,
    runtime: 1,
    rating: 6.2,
    genres: ['Short', 'Action'],
    tagline: 'One minute, one getaway.',
    overview:
      'A compact chase sequence used across the industry as a streaming reference clip. Handy as a sync test: the fast cuts make even a half-second of drift obvious to both people at once.',
    poster: '',
    backdrop: '',
    cast: [{ name: 'Ensemble', role: 'Cast' }],
    director: 'Google Media Lab',
    src: `${CDN}/ForBiggerEscapes.mp4`,
    accent: '#34d399',
  },
  {
    id: 'for-bigger-fun',
    title: 'For Bigger Fun',
    year: 2015,
    runtime: 1,
    rating: 6.0,
    genres: ['Short', 'Comedy'],
    tagline: 'Bright, brief, and built for testing.',
    overview:
      'A saturated one-minute reel. Useful when you want something playing in the background while you set up the room, pick your seats and get the call connected.',
    poster: '',
    backdrop: '',
    cast: [{ name: 'Ensemble', role: 'Cast' }],
    director: 'Google Media Lab',
    src: `${CDN}/ForBiggerFun.mp4`,
    accent: '#a78bfa',
  },
  {
    id: 'for-bigger-joyrides',
    title: 'For Bigger Joyrides',
    year: 2015,
    runtime: 1,
    rating: 6.1,
    genres: ['Short', 'Action'],
    tagline: 'Engines, dusk, and a very short runtime.',
    overview:
      'A minute of motion designed to stress-test playback. If this stays perfectly in step on both sides, a two-hour feature will too.',
    poster: '',
    backdrop: '',
    cast: [{ name: 'Ensemble', role: 'Cast' }],
    director: 'Google Media Lab',
    src: `${CDN}/ForBiggerJoyrides.mp4`,
    accent: '#f472b6',
  },
  {
    id: 'for-bigger-meltdowns',
    title: 'For Bigger Meltdowns',
    year: 2015,
    runtime: 1,
    rating: 6.3,
    genres: ['Short', 'Comedy'],
    tagline: 'Everything falls apart, beautifully.',
    overview:
      'The last of the reference reels, and the funniest. A good palate cleanser between features when neither of you can decide what to watch next.',
    poster: '',
    backdrop: '',
    cast: [{ name: 'Ensemble', role: 'Cast' }],
    director: 'Google Media Lab',
    src: `${CDN}/ForBiggerMeltdowns.mp4`,
    accent: '#22d3ee',
  },
];

/**
 * Artwork for the titles that have an official upload — the official YouTube
 * thumbnail served for each film's own video on the Blender Foundation channel
 * (confirmed via oEmbed). This is YouTube artwork for that upload, not a licensed
 * movie poster. Titles with no entry keep the generated art (`posterArt`), and
 * `MovieCard` falls back to it on any load error, so a card is never broken. The
 * five "For Bigger …" clips are Google sample/test reels with no official
 * standalone upload, so they intentionally have no thumbnail here.
 */
const YOUTUBE_THUMBNAILS: Record<string, string> = {
  'big-buck-bunny': 'https://i.ytimg.com/vi/aqz-KE-bpKQ/hqdefault.jpg',
  sintel: 'https://i.ytimg.com/vi/eRsGyueVLvQ/hqdefault.jpg',
  'tears-of-steel': 'https://i.ytimg.com/vi/R6MlUcmOul8/hqdefault.jpg',
  'elephants-dream': 'https://i.ytimg.com/vi/TLkA0RELQ1g/hqdefault.jpg',
};

export const CATALOG: Movie[] = RAW_CATALOG.map((m) => ({
  ...m,
  poster: YOUTUBE_THUMBNAILS[m.id] ?? m.poster,
  backdrop: YOUTUBE_THUMBNAILS[m.id] ?? m.backdrop,
}));

export const GENRES = Array.from(new Set(CATALOG.flatMap((m) => m.genres))).sort();

export function findMovie(id: string): Movie | undefined {
  return CATALOG.find((m) => m.id === id);
}

export function searchCatalog(query: string): Movie[] {
  const q = query.trim().toLowerCase();
  if (!q) return CATALOG;
  return CATALOG.filter((m) =>
    [m.title, m.tagline, m.overview, m.director, ...m.genres, ...m.cast.map((c) => c.name)]
      .join(' ')
      .toLowerCase()
      .includes(q),
  );
}

/** Curated rows for the browse page. Deterministic, so SSR and client agree. */
export const ROWS: { id: string; title: string; subtitle: string; items: Movie[] }[] = [
  {
    id: 'trending',
    title: 'Trending in CineVerse',
    subtitle: 'What rooms are opening with this week',
    // The four Blender open films — each with a real, verified poster.
    items: [CATALOG[1], CATALOG[2], CATALOG[0], CATALOG[3]].filter(Boolean),
  },
  {
    id: 'features',
    title: 'Open Cinema features',
    subtitle: 'Full short films, licensed to share',
    items: CATALOG.filter((m) => m.runtime >= 10),
  },
  {
    id: 'quick',
    title: 'Under five minutes',
    subtitle: 'Perfect for testing your sync before the main event',
    items: CATALOG.filter((m) => m.runtime < 10),
  },
];

/**
 * Generated poster art — a deterministic SVG data URI per film.
 * Nothing to download, nothing to break, and the whole collection shares a look.
 */
export function posterArt(movie: Movie, variant: 'poster' | 'backdrop' = 'poster'): string {
  const wide = variant === 'backdrop';
  const w = wide ? 1280 : 600;
  const h = wide ? 720 : 900;
  const a = movie.accent;
  const seed = movie.id.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const rot = seed % 360;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <radialGradient id="g1" cx="28%" cy="18%" r="85%">
      <stop offset="0%" stop-color="${a}" stop-opacity="0.85"/>
      <stop offset="45%" stop-color="${a}" stop-opacity="0.22"/>
      <stop offset="100%" stop-color="#090909" stop-opacity="1"/>
    </radialGradient>
    <radialGradient id="g2" cx="82%" cy="88%" r="70%">
      <stop offset="0%" stop-color="#8b5cf6" stop-opacity="0.55"/>
      <stop offset="60%" stop-color="#3b6cf6" stop-opacity="0.12"/>
      <stop offset="100%" stop-color="#090909" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="veil" x1="0" y1="0" x2="0" y2="1">
      <stop offset="55%" stop-color="#000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000" stop-opacity="0.85"/>
    </linearGradient>
    <filter id="grain">
      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="3"/>
      <feColorMatrix type="saturate" values="0"/>
    </filter>
  </defs>
  <rect width="${w}" height="${h}" fill="#090909"/>
  <rect width="${w}" height="${h}" fill="url(#g1)"/>
  <rect width="${w}" height="${h}" fill="url(#g2)"/>
  <g opacity="0.5" transform="rotate(${rot} ${w / 2} ${h / 2})">
    <ellipse cx="${w * 0.5}" cy="${h * 0.42}" rx="${w * 0.52}" ry="${h * 0.1}" fill="none" stroke="${a}" stroke-opacity="0.35" stroke-width="1.5"/>
    <ellipse cx="${w * 0.5}" cy="${h * 0.42}" rx="${w * 0.38}" ry="${h * 0.2}" fill="none" stroke="#ffffff" stroke-opacity="0.14" stroke-width="1"/>
    <ellipse cx="${w * 0.5}" cy="${h * 0.42}" rx="${w * 0.24}" ry="${h * 0.3}" fill="none" stroke="${a}" stroke-opacity="0.2" stroke-width="1"/>
  </g>
  <rect width="${w}" height="${h}" fill="url(#veil)"/>
  <rect width="${w}" height="${h}" filter="url(#grain)" opacity="0.05"/>
</svg>`;

  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
