'use client';

import * as React from 'react';
import { motion } from 'framer-motion';
import { Play, Youtube } from 'lucide-react';
import { Badge } from '@/components/ui/Bits';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';
import { hasFullMovie, type RecommendedMovie } from '@/data/recommendedMovies';

/**
 * A recommendation card. 16:9 because the artwork IS the official YouTube
 * thumbnail for the video we link to — YouTube trailer artwork, not a movie
 * poster, which keeps the card honest about what a click actually plays. If the
 * image fails to load the card renders a titled gradient fallback instead, so it
 * is never empty and never broken.
 */
export function RecommendationCard({
  movie,
  onPlay,
  busy,
  priority,
  className,
}: {
  movie: RecommendedMovie;
  onPlay: (movie: RecommendedMovie, kind: 'trailer' | 'full') => void;
  /** True while this card's room is being created (shows the CTA as loading). */
  busy?: boolean;
  priority?: boolean;
  className?: string;
}) {
  const [imgFailed, setImgFailed] = React.useState(false);
  const full = hasFullMovie(movie);

  return (
    <motion.article
      whileHover={{ y: -2 }}
      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      className={cn(
        'group relative flex w-full flex-col overflow-hidden rounded-3xl border border-white/10 bg-ink-850',
        'transition-[border-color,box-shadow] duration-[180ms] ease-swift hover:border-white/25 hover:shadow-e-raised',
        className,
      )}
    >
      <button
        type="button"
        onClick={() => onPlay(movie, full ? 'full' : 'trailer')}
        aria-label={`${full ? 'Watch' : 'Play trailer'}: ${movie.title} (${movie.year})`}
        className="relative block aspect-video w-full overflow-hidden"
      >
        {imgFailed ? (
          <div className="grid h-full w-full place-items-center bg-gradient-to-br from-ink-800 to-ink-900 p-4 text-center">
            <span className="font-display text-sm font-semibold text-secondary line-clamp-3">{movie.title}</span>
          </div>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={movie.posterUrl}
            alt=""
            loading={priority ? 'eager' : 'lazy'}
            decoding="async"
            onError={() => setImgFailed(true)}
            className="h-full w-full object-cover transition-transform duration-[200ms] ease-swift group-hover:scale-[1.03]"
          />
        )}

        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent" />

        {/* Label — "Full movie" when the whole film is officially available, else
            "Trailer", so viewers always know what a click will play. */}
        <span
          className={cn(
            'absolute left-2.5 top-2.5 inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[0.625rem] font-medium uppercase tracking-wide backdrop-blur',
            full ? 'border-gold-400/50 bg-black/70 text-gold-200' : 'border-white/15 bg-black/70 text-white',
          )}
        >
          <Youtube size={11} className={full ? 'text-gold-300' : 'text-rose-400'} />
          {full ? 'Full movie' : 'Trailer'}
        </span>

        {/* Play affordance on hover. */}
        <span className="pointer-events-none absolute left-1/2 top-1/2 grid h-12 w-12 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-white/20 bg-black/70 text-white opacity-0 transition-opacity duration-[180ms] ease-swift group-hover:opacity-100">
          <Play size={18} fill="currentColor" className="ml-0.5" />
        </span>
      </button>

      <div className="flex flex-1 flex-col gap-2.5 p-4">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="truncate font-display text-[0.9375rem] font-semibold text-primary" title={movie.title}>
            {movie.title}
          </h3>
          <span className="shrink-0 text-[0.75rem] text-muted">{movie.year}</span>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {movie.genres.slice(0, 3).map((g) => (
            <Badge key={g} tone="neutral">
              {g}
            </Badge>
          ))}
        </div>

        <p className="line-clamp-2 text-[0.75rem] leading-relaxed text-supporting">{movie.description}</p>

        <div className="mt-auto space-y-2 pt-1">
          <span className="block min-w-0 truncate text-[0.6875rem] text-muted" title={full ? movie.fullMovieChannel : movie.sourceChannel}>
            {movie.language} · {full ? movie.fullMovieChannel : movie.sourceChannel}
          </span>
          {full ? (
            <div className="flex items-center gap-2">
              <Button variant="primary" size="sm" loading={busy} disabled={busy} onClick={() => onPlay(movie, 'full')} className="flex-1">
                <Play size={13} fill="currentColor" />
                Watch movie
              </Button>
              <Button variant="glass" size="sm" disabled={busy} onClick={() => onPlay(movie, 'trailer')} className="shrink-0">
                Trailer
              </Button>
            </div>
          ) : (
            <Button variant="primary" size="sm" loading={busy} disabled={busy} onClick={() => onPlay(movie, 'trailer')} className="w-full">
              <Play size={13} fill="currentColor" />
              Play trailer
            </Button>
          )}
        </div>
      </div>
    </motion.article>
  );
}
