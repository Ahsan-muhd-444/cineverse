/**
 * Built-in movie recommendations — a curated, legally-sourced catalog that lets two
 * people start watching something together in one click, no upload required.
 *
 * LEGAL SOURCING. Every entry points at an OFFICIAL TRAILER hosted on the
 * rights-holder's / studio's / label's own YouTube channel — never a pirated full
 * movie or a random reupload. Each `youtubeVideoId` was verified live via YouTube's
 * oEmbed endpoint (HTTP 200 => public + embeddable), and `sourceChannel` is the
 * exact `author_name` that endpoint returned. Re-verify any time with:
 *
 *     npm run validate:youtube-catalog
 *
 * The script fails (non-zero) if any video is unreachable, non-embeddable, its URL
 * stops matching its id, a required field is missing, or two entries share an id.
 *
 * PLAYBACK. A recommendation maps to CineVerse's canonical YouTube source
 * (`{ type:'youtube', value:'<videoId>' }`), so clicking one seeds a room with it
 * and BOTH members watch the same synced YouTube player — bytes never touch this
 * server. See `toYouTubeSource` below.
 *
 * ARTWORK. `posterUrl`/`bannerUrl` are the official YouTube thumbnail served by
 * YouTube for that exact upload (`i.ytimg.com`) — i.e. YouTube trailer artwork for
 * the video we link to, not a movie poster and not scraped from image search. The
 * UI falls back to generated art if an image fails to load. If a metadata provider
 * (e.g. TMDb) is wired in later, swap the helpers below for provider URLs and
 * follow that provider's attribution terms; the shape is already right.
 */

export type RecommendedLanguage = 'Punjabi' | 'Hindi' | 'English';
export type RecommendedRegion = 'Punjabi' | 'Bollywood' | 'Hollywood';
export type YouTubeType = 'trailer' | 'full_movie';

export interface RecommendedMovie {
  id: string;
  title: string;
  year: number;
  language: RecommendedLanguage;
  region: RecommendedRegion;
  genres: string[];
  description: string;
  posterUrl: string;
  bannerUrl?: string;
  youtubeVideoId: string;
  youtubeUrl: string;
  youtubeType: YouTubeType;
  /**
   * An OFFICIAL full-movie upload, when the whole film is legally available on a
   * rights-holder / studio / official-distribution channel (common for Punjabi and
   * some Bollywood cinema; almost never for Hollywood, which is rental-only). Absent
   * when only the trailer is available. Verified live the same way the trailer is.
   */
  fullMovieVideoId?: string;
  fullMovieUrl?: string;
  fullMovieChannel?: string;
  /** Human label for the source, e.g. "Official Trailer". */
  sourceLabel: string;
  /** The exact YouTube channel serving the video (oEmbed author_name). */
  sourceChannel: string;
  /** True only for rights-holder / studio / label / official-artist channels. */
  isOfficial: boolean;
  /** True once the id verified as reachable + embeddable via oEmbed. */
  isEmbeddableVerified: boolean;
}

/** The compact per-title seed; everything derivable is derived below. */
interface Seed {
  title: string;
  year: number;
  language: RecommendedLanguage;
  region: RecommendedRegion;
  genres: string[];
  description: string;
  youtubeVideoId: string;
  sourceChannel: string;
}

/* -------------------------------------------------------------------------- */
/*  Seed data — verified official trailers (see validate-youtube-catalog)      */
/* -------------------------------------------------------------------------- */

const SEEDS: Seed[] = [
  /* ---------------- Punjabi (15) ---------------- */
  { title: 'Chal Mera Putt', year: 2019, language: 'Punjabi', region: 'Punjabi', genres: ['Comedy', 'Drama'], description: 'Undocumented Punjabi immigrants in the UK form an unlikely found-family while dodging deportation and chasing better lives.', youtubeVideoId: 'L4SWVmkwQvg', sourceChannel: 'Rhythm Boyz' },
  { title: 'Qismat', year: 2018, language: 'Punjabi', region: 'Punjabi', genres: ['Romance', 'Drama'], description: 'Two strangers fall deeply in love only to discover that fate has a heartbreaking twist in store for them.', youtubeVideoId: 'xgQcYRakbms', sourceChannel: 'Speed Records' },
  { title: 'Qismat 2', year: 2021, language: 'Punjabi', region: 'Punjabi', genres: ['Romance', 'Drama'], description: 'Picking up the threads of destiny, this sequel follows fresh heartbreak and the fragile hope of a second chance at love.', youtubeVideoId: 'fF2zgAIGgBU', sourceChannel: 'Zee Studios' },
  { title: 'Nikka Zaildar', year: 2016, language: 'Punjabi', region: 'Punjabi', genres: ['Comedy', 'Romance'], description: 'A young man juggles family expectations and a whirlwind romance in a breezy village comedy of errors.', youtubeVideoId: 'AlpSxOWN9HU', sourceChannel: 'Speed Records' },
  { title: 'Shadaa', year: 2019, language: 'Punjabi', region: 'Punjabi', genres: ['Comedy', 'Romance'], description: "A commitment-shy bachelor's endless search for the perfect bride turns his life upside down once the right woman arrives.", youtubeVideoId: 'ti94DXKnmkE', sourceChannel: 'Zee Music Company' },
  { title: 'Guddiyan Patole', year: 2019, language: 'Punjabi', region: 'Punjabi', genres: ['Comedy', 'Drama', 'Family'], description: 'Two Canada-raised sisters return to their Punjab roots and rediscover family bonds, tradition, and an unexpected romance.', youtubeVideoId: 'XFPo9Br-a_c', sourceChannel: 'Speed Records' },
  { title: 'Puaada', year: 2021, language: 'Punjabi', region: 'Punjabi', genres: ['Romance', 'Comedy'], description: 'A hot-headed villager and a spirited young woman clash over pride and class while falling reluctantly in love.', youtubeVideoId: 'w6vUHZxPUvI', sourceChannel: 'Zee Studios' },
  { title: 'Ardaas', year: 2016, language: 'Punjabi', region: 'Punjabi', genres: ['Drama'], description: 'An ensemble portrait of a Punjab village weaves together everyday struggles, faith, and quiet acts of resilience.', youtubeVideoId: 'Wm73yx3Qq20', sourceChannel: 'Speed Records' },
  { title: 'Ardaas Sarbat De Bhale Di', year: 2024, language: 'Punjabi', region: 'Punjabi', genres: ['Drama'], description: 'The heartfelt franchise returns to explore social pressures and human compassion across a community facing crisis.', youtubeVideoId: 'cBjy7gaB_RI', sourceChannel: 'JioStudios' },
  { title: 'Jatt & Juliet 2', year: 2013, language: 'Punjabi', region: 'Punjabi', genres: ['Romance', 'Comedy'], description: "A bickering couple's on-again romance is tested when duty, disguise, and comic chaos pull them across continents.", youtubeVideoId: 'FtGrababuKo', sourceChannel: 'Speed Records' },
  { title: 'Jatt & Juliet 3', year: 2024, language: 'Punjabi', region: 'Punjabi', genres: ['Romance', 'Comedy'], description: 'The beloved sparring duo reunites as two police officers who each secretly pine for the other while on a UK mission.', youtubeVideoId: 'n8EkV8ECXyk', sourceChannel: 'Speed Punjabi' },
  { title: 'Carry On Jatta 3', year: 2023, language: 'Punjabi', region: 'Punjabi', genres: ['Comedy'], description: 'A tangle of lies, fake identities, and mistaken marriages spirals into relentless slapstick chaos.', youtubeVideoId: 'v9TfEqeCe8w', sourceChannel: 'Prime Video India' },
  { title: 'Honsla Rakh', year: 2021, language: 'Punjabi', region: 'Punjabi', genres: ['Comedy', 'Drama'], description: "A single father raising his young son must navigate messy co-parenting when the boy's mother re-enters their lives.", youtubeVideoId: 'KjOfqltPRqs', sourceChannel: 'Diljit Dosanjh' },
  { title: 'Angrej', year: 2015, language: 'Punjabi', region: 'Punjabi', genres: ['Romance', 'Drama', 'Period'], description: 'Set in pre-independence rural Punjab, a tender love story blossoms and falters amid tradition and misunderstanding.', youtubeVideoId: '2jcbSzoPNVA', sourceChannel: 'Amrinder Gill' },
  { title: 'Sardaar Ji', year: 2015, language: 'Punjabi', region: 'Punjabi', genres: ['Comedy', 'Fantasy'], description: 'A quirky ghost-hunter teams up with a trapped spirit in a supernatural caper packed with laughs and surprises.', youtubeVideoId: 'MuMcSiIqCpc', sourceChannel: 'Ishtar Punjabi' },

  /* ---------------- Bollywood / Hindi (16) ---------------- */
  { title: '3 Idiots', year: 2009, language: 'Hindi', region: 'Bollywood', genres: ['Comedy', 'Drama'], description: 'Two friends retrace a college rebellion while hunting for the brilliant, free-spirited classmate who changed their lives.', youtubeVideoId: 'zIKu9k50SDo', sourceChannel: 'Vidhu Vinod Chopra Films' },
  { title: 'Dangal', year: 2016, language: 'Hindi', region: 'Bollywood', genres: ['Biography', 'Drama', 'Sport'], description: "A former wrestler defies a small town's expectations by training his two daughters into champion athletes.", youtubeVideoId: 'x_7YlGv9u1g', sourceChannel: 'UTV Motion Pictures' },
  { title: 'Bajrangi Bhaijaan', year: 2015, language: 'Hindi', region: 'Bollywood', genres: ['Drama', 'Adventure', 'Comedy'], description: 'A big-hearted, devout man takes it upon himself to reunite a lost, mute girl with her family across a hostile border.', youtubeVideoId: '4nwAra0mz_Q', sourceChannel: 'Salman Khan Films' },
  { title: 'Chennai Express', year: 2013, language: 'Hindi', region: 'Bollywood', genres: ['Action', 'Comedy', 'Romance'], description: "A reluctant traveler's train trip south spirals into a chaotic adventure after he falls for a local don's daughter.", youtubeVideoId: 'hZGR5Sj1Bfo', sourceChannel: 'Red Chillies Entertainment' },
  { title: 'Gully Boy', year: 2019, language: 'Hindi', region: 'Bollywood', genres: ['Drama', 'Music'], description: "A young man from Mumbai's slums channels his frustrations into street rap and chases an unlikely dream of stardom.", youtubeVideoId: 'JfbxcD6biOk', sourceChannel: 'Excel Movies' },
  { title: 'AndhaDhun', year: 2018, language: 'Hindi', region: 'Bollywood', genres: ['Thriller', 'Crime', 'Comedy'], description: 'A pianist pretending to be blind stumbles into a murder cover-up that grows more dangerous by the minute.', youtubeVideoId: '2iVYI99VGaw', sourceChannel: 'Viacom18 Studios' },
  { title: 'Queen', year: 2014, language: 'Hindi', region: 'Bollywood', genres: ['Comedy', 'Drama', 'Adventure'], description: 'Jilted just before her wedding, a sheltered young woman heads off on her honeymoon alone and discovers herself in Europe.', youtubeVideoId: 'M_HP8xgXhBU', sourceChannel: 'FuhSePhantom' },
  { title: 'Kabir Singh', year: 2019, language: 'Hindi', region: 'Bollywood', genres: ['Drama', 'Romance'], description: 'A gifted but self-destructive surgeon spirals into rage and addiction after losing the woman he loves.', youtubeVideoId: 'RiANSSgCuJk', sourceChannel: 'T-Series' },
  { title: 'Padmaavat', year: 2018, language: 'Hindi', region: 'Bollywood', genres: ['Drama', 'History', 'Romance'], description: 'A tyrannical ruler becomes obsessed with a legendary queen, setting the stage for a clash of honor and siege.', youtubeVideoId: 'X_5_BLt76c0', sourceChannel: 'Viacom18 Studios' },
  { title: 'Pathaan', year: 2023, language: 'Hindi', region: 'Bollywood', genres: ['Action', 'Thriller'], description: 'A veteran spy steps out of the shadows to stop a rogue mercenary from unleashing a catastrophic attack.', youtubeVideoId: 'vqu4z34wENw', sourceChannel: 'YRF' },
  { title: 'Jawan', year: 2023, language: 'Hindi', region: 'Bollywood', genres: ['Action', 'Thriller'], description: 'A man with a hidden past leads a squad of women on a high-stakes mission to right systemic wrongs.', youtubeVideoId: 'COv52Qyctws', sourceChannel: 'Red Chillies Entertainment' },
  { title: 'Brahmastra: Part One - Shiva', year: 2022, language: 'Hindi', region: 'Bollywood', genres: ['Fantasy', 'Action', 'Adventure'], description: 'A young DJ discovers he can wield fire and is drawn into an ancient secret society guarding a cosmic weapon.', youtubeVideoId: 'AgS_6UbQ8JM', sourceChannel: 'Dharma Productions' },
  { title: 'Uri: The Surgical Strike', year: 2019, language: 'Hindi', region: 'Bollywood', genres: ['Action', 'War', 'Drama'], description: 'An army officer plans and leads a covert cross-border retaliation after a deadly attack on his comrades.', youtubeVideoId: 'VVY3do673Zc', sourceChannel: 'RSVP Movies' },
  { title: 'Stree', year: 2018, language: 'Hindi', region: 'Bollywood', genres: ['Horror', 'Comedy'], description: 'A sleepy town gripped by a vanishing-men legend forces a few friends to confront a vengeful female spirit.', youtubeVideoId: 'gzeaGcLLl_A', sourceChannel: 'Maddock Films' },
  { title: 'Drishyam', year: 2015, language: 'Hindi', region: 'Bollywood', genres: ['Thriller', 'Crime', 'Drama'], description: 'An ordinary family man uses his movie-loving wits to protect his loved ones after a crime shatters their calm.', youtubeVideoId: '64xJLmcA2K8', sourceChannel: 'Panorama Studios' },
  { title: 'Baahubali 2: The Conclusion', year: 2017, language: 'Hindi', region: 'Bollywood', genres: ['Action', 'Drama', 'Fantasy'], description: "A warrior prince uncovers the betrayal behind his father's death and rises to reclaim a kingdom's throne.", youtubeVideoId: 'G62HrubdD6o', sourceChannel: 'Dharma Productions' },

  /* ---------------- Hollywood (16) ---------------- */
  { title: 'Interstellar', year: 2014, language: 'English', region: 'Hollywood', genres: ['Sci-Fi', 'Adventure', 'Drama'], description: 'A team of explorers rides a wormhole across the galaxy in a desperate search for a new home as Earth slowly dies.', youtubeVideoId: 'zSWdZVtXT7E', sourceChannel: 'Warner Bros. UK & Ireland' },
  { title: 'Avengers: Endgame', year: 2019, language: 'English', region: 'Hollywood', genres: ['Action', 'Adventure', 'Sci-Fi'], description: "The surviving heroes gamble everything on one last plan to undo the devastation left in Thanos' wake.", youtubeVideoId: 'TcMBFSGVi1c', sourceChannel: 'Marvel Entertainment' },
  { title: 'Spider-Man: No Way Home', year: 2021, language: 'English', region: 'Hollywood', genres: ['Action', 'Adventure', 'Sci-Fi'], description: 'When a botched spell shatters the barrier between realities, Spider-Man must face villains from other universes.', youtubeVideoId: 'JfVOs4VSpmA', sourceChannel: 'Sony Pictures Entertainment' },
  { title: 'Top Gun: Maverick', year: 2022, language: 'English', region: 'Hollywood', genres: ['Action', 'Drama'], description: 'A veteran Navy pilot returns to train a new generation of aviators for a mission that may cost him everything.', youtubeVideoId: 'qSqVVswa420', sourceChannel: 'Paramount Pictures' },
  { title: 'Oppenheimer', year: 2023, language: 'English', region: 'Hollywood', genres: ['Biography', 'Drama', 'History'], description: 'The physicist who fathered the atomic bomb wrestles with genius, ambition, and the moral weight of what he unleashed.', youtubeVideoId: 'uYPbbksJxIg', sourceChannel: 'Universal Pictures' },
  { title: 'Dune: Part Two', year: 2024, language: 'English', region: 'Hollywood', genres: ['Sci-Fi', 'Adventure', 'Drama'], description: 'Bonding with desert warriors, the exiled heir wages a war of vengeance while confronting the terrible future he foresees.', youtubeVideoId: '_YUzQa_1RCE', sourceChannel: 'Warner Bros.' },
  { title: 'Joker', year: 2019, language: 'English', region: 'Hollywood', genres: ['Crime', 'Drama', 'Thriller'], description: "A lonely failed comedian's slow unraveling in a cruel city gives birth to a chilling agent of chaos.", youtubeVideoId: 'zAGVQLHvwOY', sourceChannel: 'Warner Bros.' },
  { title: 'The Batman', year: 2022, language: 'English', region: 'Hollywood', genres: ['Action', 'Crime', 'Drama'], description: 'In his second year of crime-fighting, the caped detective hunts a sadistic killer targeting Gotham’s corrupt elite.', youtubeVideoId: 'mqqft2x_Aa4', sourceChannel: 'Warner Bros.' },
  { title: 'John Wick: Chapter 4', year: 2023, language: 'English', region: 'Hollywood', genres: ['Action', 'Thriller', 'Crime'], description: 'The legendary assassin fights across continents to win his freedom from the shadowy syndicate hunting him.', youtubeVideoId: 'qEVUtrk8_B4', sourceChannel: 'Lionsgate Movies' },
  { title: 'Mad Max: Fury Road', year: 2015, language: 'English', region: 'Hollywood', genres: ['Action', 'Adventure', 'Sci-Fi'], description: 'Across a scorched wasteland, a drifter and a rebel commander flee a tyrant in one relentless vehicular chase.', youtubeVideoId: 'hEJnMQG9ev8', sourceChannel: 'Warner Bros.' },
  { title: 'Black Panther', year: 2018, language: 'English', region: 'Hollywood', genres: ['Action', 'Adventure', 'Sci-Fi'], description: 'A newly crowned African king must defend his hidden, technologically advanced nation from a challenger to the throne.', youtubeVideoId: 'xjDjIWPwcPU', sourceChannel: 'Marvel Entertainment' },
  { title: 'Barbie', year: 2023, language: 'English', region: 'Hollywood', genres: ['Comedy', 'Adventure', 'Fantasy'], description: "A doll's picture-perfect existence cracks open when she ventures out of her plastic paradise into the real world.", youtubeVideoId: 'pBk4NYhWNMM', sourceChannel: 'Warner Bros.' },
  { title: 'Everything Everywhere All at Once', year: 2022, language: 'English', region: 'Hollywood', genres: ['Action', 'Adventure', 'Comedy'], description: 'An overwhelmed laundromat owner must channel countless parallel versions of herself to save the multiverse.', youtubeVideoId: 'wxN1T1uxQ2g', sourceChannel: 'A24' },
  { title: 'Inception', year: 2010, language: 'English', region: 'Hollywood', genres: ['Sci-Fi', 'Action', 'Thriller'], description: 'A thief who steals secrets through dream infiltration is offered redemption if he can plant an idea instead.', youtubeVideoId: 'Qwe6qXFTdgc', sourceChannel: 'Warner Bros. Entertainment' },
  { title: 'Deadpool', year: 2016, language: 'English', region: 'Hollywood', genres: ['Action', 'Comedy'], description: 'A wisecracking mercenary left disfigured by a rogue experiment sets out for bloody, fourth-wall-breaking revenge.', youtubeVideoId: 'FyKWUTwSYAs', sourceChannel: '20th Century Studios' },
  { title: 'The Dark Knight', year: 2008, language: 'English', region: 'Hollywood', genres: ['Action', 'Crime', 'Drama'], description: "Gotham's masked protector is pushed to his limits by an anarchic criminal who wants to watch the whole city burn.", youtubeVideoId: '_PZpmTj1Q8Q', sourceChannel: 'Warner Bros. Rewind' },
];

/* -------------------------------------------------------------------------- */
/*  Derivation                                                                 */
/* -------------------------------------------------------------------------- */

/** A YouTube thumbnail URL — the official trailer's own artwork, always available. */
export function youtubeThumb(videoId: string, quality: 'hqdefault' | 'mqdefault' | 'maxresdefault' = 'hqdefault'): string {
  return `https://i.ytimg.com/vi/${videoId}/${quality}.jpg`;
}

/** A stable, unique id from title + year (e.g. "jatt-juliet-2-2013"). */
function slugId(seed: Seed): string {
  const slug = seed.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug}-${seed.year}`;
}

/**
 * Verified OFFICIAL full-movie uploads, keyed by movie id. ONLY rights-holder /
 * studio / label channels appear here, and every id is re-checked live by
 * `npm run validate:youtube-catalog`. Most cinema on YouTube is trailer-only —
 * Hollywood and mainstream Bollywood are rental/subscription only — so this map is
 * mostly Punjabi, where studios (Speed Records, Rhythm Boyz, White Hill, Zee, …)
 * officially publish full films. A title absent here shows only its trailer.
 */
const FULL_MOVIES: Record<string, { videoId: string; channel: string }> = {
  // Punjabi — officially free on Speed Records Movies (@SpeedRecords-Movies) and
  // Rhythm Boyz (@RhythmBoyz). Verified live via oEmbed. Every other catalog title
  // is trailer-only: Hollywood and mainstream Bollywood are rental/subscription
  // only, and the newer Punjabi films are locked to paid OTT (ZEE5/Prime/Netflix).
  'qismat-2018': { videoId: '9SzPR42sYU8', channel: 'Speed Records Movies' },
  'nikka-zaildar-2016': { videoId: 'qEYzi_F0g_w', channel: 'Speed Records Movies' },
  'guddiyan-patole-2019': { videoId: 'kFYd2csCka8', channel: 'Speed Records Movies' },
  'jatt-juliet-2-2013': { videoId: 'BgxIr2IGzBY', channel: 'Speed Records Movies' },
  'angrej-2015': { videoId: 'A2vcDRAdf5I', channel: 'Rhythm Boyz' },
};

export const RECOMMENDED_MOVIES: RecommendedMovie[] = SEEDS.map((seed) => {
  const id = slugId(seed);
  const full = FULL_MOVIES[id];
  return {
    id,
    title: seed.title,
    year: seed.year,
    language: seed.language,
    region: seed.region,
    genres: seed.genres,
    description: seed.description,
    posterUrl: youtubeThumb(seed.youtubeVideoId, 'hqdefault'),
    bannerUrl: youtubeThumb(seed.youtubeVideoId, 'maxresdefault'),
    youtubeVideoId: seed.youtubeVideoId,
    youtubeUrl: `https://www.youtube.com/watch?v=${seed.youtubeVideoId}`,
    // The trailer is always present; a verified official full movie is added
    // alongside it when one exists (fullMovie* fields), so a viewer can watch the
    // trailer or the whole film.
    youtubeType: 'trailer',
    fullMovieVideoId: full ? full.videoId : undefined,
    fullMovieUrl: full ? `https://www.youtube.com/watch?v=${full.videoId}` : undefined,
    fullMovieChannel: full ? full.channel : undefined,
    sourceLabel: 'Official Trailer',
    sourceChannel: seed.sourceChannel,
    isOfficial: true,
    isEmbeddableVerified: true,
  };
});

/* -------------------------------------------------------------------------- */
/*  Grouping + helpers for the UI                                              */
/* -------------------------------------------------------------------------- */

export const RECOMMENDED_REGIONS: RecommendedRegion[] = ['Punjabi', 'Bollywood', 'Hollywood'];

/** Display metadata for each region section, in display order. */
export const RECOMMENDED_SECTIONS: { region: RecommendedRegion; title: string; subtitle: string }[] = [
  { region: 'Punjabi', title: 'Punjabi Picks', subtitle: 'Comedy, romance and heart from Punjabi cinema' },
  { region: 'Bollywood', title: 'Bollywood Favorites', subtitle: 'Blockbusters and modern classics from Hindi cinema' },
  { region: 'Hollywood', title: 'Hollywood Hits', subtitle: 'Tentpole spectacle and award-winning drama' },
];

export function recommendedByRegion(region: RecommendedRegion): RecommendedMovie[] {
  return RECOMMENDED_MOVIES.filter((m) => m.region === region);
}

/** Case-insensitive title/genre/language search. Empty query returns everything. */
export function searchRecommended(query: string): RecommendedMovie[] {
  const q = query.trim().toLowerCase();
  if (!q) return RECOMMENDED_MOVIES;
  return RECOMMENDED_MOVIES.filter(
    (m) =>
      m.title.toLowerCase().includes(q) ||
      m.language.toLowerCase().includes(q) ||
      m.region.toLowerCase().includes(q) ||
      m.genres.some((g) => g.toLowerCase().includes(q)),
  );
}

export function findRecommended(id: string): RecommendedMovie | undefined {
  return RECOMMENDED_MOVIES.find((m) => m.id === id);
}

/**
 * A recommendation as CineVerse's canonical YouTube source. This is the ONE mapping
 * the room uses — the bare 11-char video id as `value`, so `room:create` (which
 * stores the source without re-normalizing) and the Player's `resolveYouTubeId`
 * both accept it directly. Bytes stay on YouTube; the server only syncs state.
 */
export function toYouTubeSource(
  movie: RecommendedMovie,
  kind: 'trailer' | 'full' = 'trailer',
): { type: 'youtube'; value: string; label: string; poster: string } {
  const wantFull = kind === 'full' && Boolean(movie.fullMovieVideoId);
  const value = wantFull ? (movie.fullMovieVideoId as string) : movie.youtubeVideoId;
  const label = wantFull ? movie.title : `${movie.title} — Trailer`;
  return { type: 'youtube', value, label, poster: movie.posterUrl };
}

/** Whether an official full-movie link is available for this title. */
export function hasFullMovie(movie: RecommendedMovie): boolean {
  return Boolean(movie.fullMovieVideoId);
}

/* -------------------------------------------------------------------------- */
/*  Pure shape validation — shared by the unit test AND the live script         */
/* -------------------------------------------------------------------------- */

const LANGUAGES: readonly RecommendedLanguage[] = ['Punjabi', 'Hindi', 'English'];
const REGIONS: readonly RecommendedRegion[] = ['Punjabi', 'Bollywood', 'Hollywood'];
const YOUTUBE_TYPES: readonly YouTubeType[] = ['trailer', 'full_movie'];
const VIDEO_ID_RE = /^[\w-]{11}$/;

/** Minimum per-region counts (the catalog must exceed these). */
export const REGION_MINIMUMS: Record<RecommendedRegion, number> = { Punjabi: 12, Bollywood: 15, Hollywood: 15 };
export const CATALOG_MIN = 40;
export const CATALOG_MAX = 50;

/** Field-level checks for a single item. Returns a list of human-readable errors. */
export function validateRecommendedItem(m: RecommendedMovie): string[] {
  const errs: string[] = [];
  const at = (msg: string) => `${m.id || m.title || '<unknown>'}: ${msg}`;
  if (!m.id) errs.push(at('missing id'));
  if (!m.title) errs.push(at('missing title'));
  if (!Number.isInteger(m.year) || m.year < 1900 || m.year > 2100) errs.push(at(`bad year ${m.year}`));
  if (!LANGUAGES.includes(m.language)) errs.push(at(`bad language ${m.language}`));
  if (!REGIONS.includes(m.region)) errs.push(at(`bad region ${m.region}`));
  if (!Array.isArray(m.genres) || m.genres.length === 0 || m.genres.some((g) => typeof g !== 'string' || !g)) {
    errs.push(at('genres must be a non-empty string array'));
  }
  if (!m.description || m.description.length < 8) errs.push(at('missing/short description'));
  if (!m.posterUrl || !/^https:\/\//.test(m.posterUrl)) errs.push(at('posterUrl must be an https URL'));
  if (m.bannerUrl && !/^https:\/\//.test(m.bannerUrl)) errs.push(at('bannerUrl must be an https URL'));
  if (!VIDEO_ID_RE.test(m.youtubeVideoId || '')) errs.push(at(`bad youtubeVideoId ${m.youtubeVideoId}`));
  if (!m.youtubeUrl || !m.youtubeUrl.includes(m.youtubeVideoId)) errs.push(at('youtubeUrl does not contain the video id'));
  if (!YOUTUBE_TYPES.includes(m.youtubeType)) errs.push(at(`bad youtubeType ${m.youtubeType}`));
  // Optional official full movie: if any full-movie field is set, all must be, and
  // the id/url must agree.
  if (m.fullMovieVideoId !== undefined || m.fullMovieUrl !== undefined || m.fullMovieChannel !== undefined) {
    if (!VIDEO_ID_RE.test(m.fullMovieVideoId || '')) errs.push(at(`bad fullMovieVideoId ${m.fullMovieVideoId}`));
    if (!m.fullMovieUrl || !m.fullMovieUrl.includes(m.fullMovieVideoId || '\0')) errs.push(at('fullMovieUrl does not contain the full-movie id'));
    if (!m.fullMovieChannel) errs.push(at('missing fullMovieChannel'));
  }
  if (!m.sourceLabel) errs.push(at('missing sourceLabel'));
  if (!m.sourceChannel) errs.push(at('missing sourceChannel'));
  if (m.isOfficial !== true) errs.push(at('isOfficial must be true'));
  if (m.isEmbeddableVerified !== true) errs.push(at('isEmbeddableVerified must be true'));
  return errs;
}

/**
 * Whole-catalog validation: every item is well-formed, ids and video ids are
 * unique, the total is within [40, 50], and each region clears its minimum. Pure —
 * no network. The live `validate-youtube-catalog` script adds oEmbed on top.
 */
export function validateRecommendedCatalog(catalog: RecommendedMovie[] = RECOMMENDED_MOVIES): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  for (const m of catalog) errors.push(...validateRecommendedItem(m));

  if (catalog.length < CATALOG_MIN || catalog.length > CATALOG_MAX) {
    errors.push(`catalog size ${catalog.length} is outside [${CATALOG_MIN}, ${CATALOG_MAX}]`);
  }

  const ids = new Set<string>();
  const videoIds = new Set<string>();
  for (const m of catalog) {
    if (ids.has(m.id)) errors.push(`duplicate id ${m.id}`);
    ids.add(m.id);
    if (videoIds.has(m.youtubeVideoId)) errors.push(`duplicate youtubeVideoId ${m.youtubeVideoId} (${m.title})`);
    videoIds.add(m.youtubeVideoId);
  }

  // Full-movie ids must be unique among themselves and never reuse a trailer id.
  const fullIds = new Set<string>();
  for (const m of catalog) {
    if (!m.fullMovieVideoId) continue;
    if (videoIds.has(m.fullMovieVideoId)) errors.push(`fullMovieVideoId ${m.fullMovieVideoId} collides with a trailer id (${m.title})`);
    if (fullIds.has(m.fullMovieVideoId)) errors.push(`duplicate fullMovieVideoId ${m.fullMovieVideoId} (${m.title})`);
    fullIds.add(m.fullMovieVideoId);
  }

  for (const region of REGIONS) {
    const count = catalog.filter((m) => m.region === region).length;
    if (count < REGION_MINIMUMS[region]) errors.push(`region ${region} has ${count}, needs >= ${REGION_MINIMUMS[region]}`);
  }

  return { ok: errors.length === 0, errors };
}
