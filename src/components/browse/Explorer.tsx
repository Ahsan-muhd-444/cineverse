'use client';

import * as React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Bookmark, Compass, Heart, History, Search, X } from 'lucide-react';
import { CATALOG, GENRES, findMovie, searchCatalog } from '@/lib/catalog';
import type { Movie } from '@/lib/types';
import { MovieCard } from './MovieCard';
import { MovieDetail } from './MovieDetail';
import { MovieRow } from './MovieRow';
import { Input } from '@/components/ui/Input';
import { EmptyState, PosterSkeleton } from '@/components/ui/Bits';
import { Button } from '@/components/ui/Button';
import { useStartRoom } from '@/hooks/useStartRoom';
import { getFavorites, getProgress, getWatchLater } from '@/lib/storage';
import { cn } from '@/lib/utils';

type Tab = 'all' | 'favorites' | 'later' | 'continue';

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: 'all', label: 'Everything', icon: <Compass size={14} /> },
  { id: 'continue', label: 'Continue watching', icon: <History size={14} /> },
  { id: 'favorites', label: 'Favorites', icon: <Heart size={14} /> },
  { id: 'later', label: 'Watch later', icon: <Bookmark size={14} /> },
];

export function Explorer() {
  const [query, setQuery] = React.useState('');
  const [genre, setGenre] = React.useState<string | null>(null);
  const [tab, setTab] = React.useState<Tab>('all');
  const [detail, setDetail] = React.useState<Movie | null>(null);
  const [mounted, setMounted] = React.useState(false);
  const [lists, setLists] = React.useState<{ favorites: string[]; later: string[]; progress: string[] }>({
    favorites: [],
    later: [],
    progress: [],
  });
  const { start } = useStartRoom();

  const refreshLists = React.useCallback(() => {
    setLists({
      favorites: getFavorites(),
      later: getWatchLater(),
      progress: getProgress().map((p) => p.movieId),
    });
  }, []);

  React.useEffect(() => {
    setMounted(true);
    refreshLists();
    const onStorage = () => refreshLists();
    window.addEventListener('cineverse:storage', onStorage);
    return () => window.removeEventListener('cineverse:storage', onStorage);
  }, [refreshLists]);

  const searching = query.trim().length > 0 || genre !== null || tab !== 'all';

  const results = React.useMemo(() => {
    let items = searchCatalog(query);
    if (genre) items = items.filter((m) => m.genres.includes(genre));
    if (tab === 'favorites') items = items.filter((m) => lists.favorites.includes(m.id));
    if (tab === 'later') items = items.filter((m) => lists.later.includes(m.id));
    if (tab === 'continue') {
      const order = lists.progress;
      items = order.map((id) => findMovie(id)).filter((m): m is Movie => Boolean(m));
    }
    return items;
  }, [query, genre, tab, lists]);

  const rows = React.useMemo(
    () => [
      {
        id: 'trending',
        title: 'Trending in CineVerse',
        subtitle: 'What rooms are opening with this week',
        items: [CATALOG[1], CATALOG[2], CATALOG[0], CATALOG[3], CATALOG[4]].filter(Boolean),
      },
      {
        id: 'features',
        title: 'Open Cinema features',
        subtitle: 'Full short films, licensed to share',
        items: CATALOG.filter((m) => m.runtime >= 10),
      },
      {
        id: 'popular',
        title: 'Most watched',
        subtitle: 'The ones people come back to',
        items: [...CATALOG].sort((a, b) => b.rating - a.rating).slice(0, 6),
      },
      {
        id: 'quick',
        title: 'Under five minutes',
        subtitle: 'Perfect for testing your sync before the main event',
        items: CATALOG.filter((m) => m.runtime < 10),
      },
    ],
    [],
  );

  const emptyCopy: Record<Tab, { title: string; body: string }> = {
    all: { title: 'Nothing matches that', body: 'Try a different title, genre or actor.' },
    favorites: { title: 'No favorites yet', body: 'Tap the heart on any poster and it will wait for you here.' },
    later: { title: 'Your watch list is empty', body: 'Bookmark anything you want to come back to.' },
    continue: {
      title: 'Nothing in progress',
      body: 'Start something in a room and it will pick up right where you left it.',
    },
  };

  return (
    <div className="pb-24">
      {/* ---------- Search + filters ---------- */}
      <div className="container">
        <div className="max-w-2xl">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search titles, genres, directors, cast…"
            aria-label="Search the catalog"
            icon={<Search size={17} />}
            trailing={
              query ? (
                <button
                  onClick={() => setQuery('')}
                  aria-label="Clear search"
                  className="grid h-11 w-11 place-items-center rounded-lg text-muted transition-colors duration-[160ms] ease-swift hover:bg-white/10 hover:text-primary"
                >
                  <X size={13} />
                </button>
              ) : null
            }
          />
        </div>

        <div className="no-scrollbar mt-6 flex gap-2 overflow-x-auto pb-1">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              aria-pressed={tab === t.id}
              className={cn(
                'relative inline-flex min-h-11 shrink-0 items-center gap-2 rounded-2xl px-4 text-[0.8125rem] font-medium transition-colors duration-[180ms] ease-swift',
                tab === t.id
                  // Neutral raised surface with a small gold underline, rather
                  // than a white-filled pill under a large white glow.
                  ? 'bg-white/[0.10] text-primary after:absolute after:inset-x-4 after:bottom-1 after:h-0.5 after:rounded-full after:bg-gold-400'
                  : 'glass-soft text-secondary hover:text-primary',
              )}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>

        <div className="no-scrollbar mt-3 flex gap-2 overflow-x-auto pb-1">
          <button
            onClick={() => setGenre(null)}
            className={cn(
              'inline-flex min-h-11 shrink-0 items-center rounded-full border px-3.5 text-xs',
              'transition-colors duration-[160ms] ease-swift',
              genre === null
                ? 'border-gold-400/60 bg-gold-400/10 text-gold-300'
                : 'border-white/10 text-secondary hover:border-white/25 hover:text-primary',
            )}
          >
            All genres
          </button>
          {GENRES.map((g) => (
            <button
              key={g}
              onClick={() => setGenre(genre === g ? null : g)}
              className={cn(
                'inline-flex min-h-11 shrink-0 items-center rounded-full border px-3.5 text-xs',
                'transition-colors duration-[160ms] ease-swift',
                genre === g
                  ? 'border-gold-400/60 bg-gold-400/10 text-gold-300'
                  : 'border-white/10 text-secondary hover:border-white/25 hover:text-primary',
              )}
            >
              {g}
            </button>
          ))}
        </div>
      </div>

      {/* ---------- Results ---------- */}
      <div className="mt-12">
        <AnimatePresence mode="wait" initial={false}>
          {searching ? (
            <motion.div
              key="grid"
              initial={{ opacity: 0, y: 7 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
              className="container"
            >
              {!mounted ? (
                <div className="flex flex-wrap gap-4">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <PosterSkeleton key={i} />
                  ))}
                </div>
              ) : results.length ? (
                <>
                  <p className="mb-6 text-[0.8125rem] text-muted">
                    {results.length} {results.length === 1 ? 'title' : 'titles'}
                  </p>
                  <div className="flex flex-wrap gap-4 sm:gap-5">
                    {results.map((movie, i) => (
                      <MovieCard key={movie.id} movie={movie} onOpen={setDetail} onPlay={start} priority={i < 6} />
                    ))}
                  </div>
                </>
              ) : (
                <EmptyState
                  icon={<Search size={20} />}
                  title={emptyCopy[tab].title}
                  body={emptyCopy[tab].body}
                  action={
                    <Button
                      variant="glass"
                      onClick={() => {
                        setQuery('');
                        setGenre(null);
                        setTab('all');
                      }}
                    >
                      Reset filters
                    </Button>
                  }
                />
              )}
            </motion.div>
          ) : (
            <motion.div
              key="rows"
              initial={{ opacity: 0, y: 7 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
              className="space-y-16"
            >
              {rows.map((row) => (
                <MovieRow key={row.id} row={row} />
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <MovieDetail movie={detail} onClose={() => setDetail(null)} onPlay={start} />
    </div>
  );
}
