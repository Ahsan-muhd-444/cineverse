'use client';

import * as React from 'react';
import { Search, X } from 'lucide-react';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/Bits';
import { cn } from '@/lib/utils';
import {
  RECOMMENDED_SECTIONS,
  recommendedByRegion,
  searchRecommended,
  type RecommendedMovie,
  type RecommendedRegion,
} from '@/data/recommendedMovies';
import { useStartRecommendation } from '@/hooks/useStartRecommendation';
import { RecommendationCard } from '@/components/recommend/RecommendationCard';

type Filter = 'All' | RecommendedRegion;
const FILTERS: Filter[] = ['All', 'Punjabi', 'Bollywood', 'Hollywood'];

/**
 * The "Recommended Movies" experience: category filters, title search, and a movie
 * grid. Clicking a card creates a room seeded with that title's official YouTube
 * source and drops you in — the partner who joins lands on the same synced player.
 */
export function RecommendedMovies({ className }: { className?: string }) {
  const [filter, setFilter] = React.useState<Filter>('All');
  const [query, setQuery] = React.useState('');
  const { start, starting } = useStartRecommendation();

  const trimmed = query.trim();
  const browsing = trimmed === '' && filter === 'All';

  // Flat result set for the filtered/searching view.
  const results = React.useMemo(() => {
    let list = searchRecommended(query);
    if (filter !== 'All') list = list.filter((m) => m.region === filter);
    return list;
  }, [query, filter]);

  const reset = () => {
    setFilter('All');
    setQuery('');
  };

  return (
    <section id="recommended" className={cn('relative py-16 sm:py-20', className)}>
      <div className="container">
        {/* Heading */}
        <div className="max-w-2xl">
          <p className="text-eyebrow text-gold-300">Watch together now</p>
          <h2 className="mt-3 font-display text-display-sm font-semibold text-primary sm:text-display-md">Recommended movies</h2>
          <p className="mt-3 text-[0.9375rem] leading-relaxed text-secondary">
            Official trailers from studios and labels — no upload needed. Pick one and you’re both watching in the same
            room in seconds.
          </p>
        </div>

        {/* Controls: category filters + search */}
        <div className="mt-8 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by category">
            {FILTERS.map((f) => {
              const activeChip = filter === f;
              return (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFilter(f)}
                  aria-pressed={activeChip}
                  className={cn(
                    'inline-flex min-h-11 items-center rounded-full border px-3.5 text-xs font-medium transition-colors duration-[160ms] ease-swift',
                    activeChip
                      ? 'border-gold-400/60 bg-gold-400/10 text-gold-300'
                      : 'border-white/10 text-secondary hover:border-white/25',
                  )}
                >
                  {f === 'All' ? 'All' : f}
                </button>
              );
            })}
          </div>

          <div className="lg:w-72">
            <Input
              icon={<Search size={16} />}
              placeholder="Search by title, genre or language…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search recommended movies"
              trailing={
                query ? (
                  <button
                    type="button"
                    onClick={() => setQuery('')}
                    aria-label="Clear search"
                    className="grid h-6 w-6 place-items-center rounded-md text-muted transition-colors hover:text-primary"
                  >
                    <X size={14} />
                  </button>
                ) : undefined
              }
            />
          </div>
        </div>

        {/* Content */}
        <div className="mt-10">
          {browsing ? (
            <div className="space-y-12">
              {RECOMMENDED_SECTIONS.map((section) => (
                <RegionRow
                  key={section.region}
                  title={section.title}
                  subtitle={section.subtitle}
                  movies={recommendedByRegion(section.region)}
                  onPlay={start}
                  startingId={starting}
                />
              ))}
            </div>
          ) : results.length === 0 ? (
            <EmptyState
              title="No matches"
              body="Try a different title or category."
              action={
                <Button variant="glass" size="sm" onClick={reset}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <>
              <p className="mb-4 text-[0.8125rem] text-muted">
                {results.length} {results.length === 1 ? 'movie' : 'movies'}
                {filter !== 'All' ? ` · ${filter}` : ''}
              </p>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {results.map((movie) => (
                  <RecommendationCard key={movie.id} movie={movie} onPlay={start} busy={starting === movie.id} />
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

/** One region's horizontal, snap-scrolling row of cards (the default browse view). */
function RegionRow({
  title,
  subtitle,
  movies,
  onPlay,
  startingId,
}: {
  title: string;
  subtitle: string;
  movies: RecommendedMovie[];
  onPlay: (movie: RecommendedMovie, kind: 'trailer' | 'full') => void;
  startingId: string | null;
}) {
  return (
    <div>
      <div className="mb-4">
        <h3 className="font-display text-lg font-semibold text-primary">{title}</h3>
        <p className="mt-0.5 text-[0.8125rem] text-supporting">{subtitle}</p>
      </div>
      <div className="-mx-4 flex snap-x gap-4 overflow-x-auto px-4 pb-3 [scrollbar-width:thin]">
        {movies.map((movie) => (
          <div key={movie.id} className="w-[264px] shrink-0 snap-start sm:w-[288px]">
            <RecommendationCard movie={movie} onPlay={onPlay} busy={startingId === movie.id} />
          </div>
        ))}
      </div>
    </div>
  );
}
