'use client';

import * as React from 'react';
import { motion } from 'framer-motion';
import { Bookmark, Heart, Play, Star } from 'lucide-react';
import type { Movie } from '@/lib/types';
import { posterArt } from '@/lib/catalog';
import { cn } from '@/lib/utils';
import { getFavorites, getWatchLater, getProgressFor, toggleFavorite, toggleWatchLater } from '@/lib/storage';

export function MovieCard({
  movie,
  onOpen,
  onPlay,
  priority,
  className,
}: {
  movie: Movie;
  onOpen: (movie: Movie) => void;
  onPlay: (movie: Movie) => void;
  priority?: boolean;
  className?: string;
}) {
  const [favorite, setFavorite] = React.useState(false);
  const [later, setLater] = React.useState(false);
  const [progress, setProgress] = React.useState(0);
  // Prefer a real poster image when one is set; fall back to the generated art on
  // error (or when absent), so a card is never broken and never blank.
  const [posterFailed, setPosterFailed] = React.useState(false);
  const posterSrc = !posterFailed && movie.poster && /^https?:\/\//.test(movie.poster) ? movie.poster : posterArt(movie);

  React.useEffect(() => {
    setFavorite(getFavorites().includes(movie.id));
    setLater(getWatchLater().includes(movie.id));
    const entry = getProgressFor(movie.id);
    if (entry?.duration) setProgress(Math.min(100, (entry.position / entry.duration) * 100));
  }, [movie.id]);

  return (
    <motion.article
      whileHover={{ y: -2 }}
      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      className={cn('group relative w-[168px] shrink-0 sm:w-[196px]', className)}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={() => onOpen(movie)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpen(movie);
          }
        }}
        aria-label={`${movie.title}, ${movie.year}. Open details.`}
        className="relative block w-full cursor-pointer overflow-hidden rounded-3xl border border-white/10 bg-ink-850 transition-[border-color,box-shadow] duration-[180ms] ease-swift group-hover:border-white/25 group-hover:shadow-e-raised"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={posterSrc}
          alt=""
          loading={priority ? 'eager' : 'lazy'}
          decoding="async"
          onError={() => setPosterFailed(true)}
          className="aspect-[2/3] w-full object-cover transition-transform duration-[200ms] ease-swift group-hover:scale-[1.02]"
        />

        <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/25 to-transparent opacity-90 transition-opacity duration-500 group-hover:opacity-100" />

        <div className="absolute inset-x-0 bottom-0 p-3.5">
          <h3 className="font-display text-[0.9375rem] font-semibold leading-snug text-white line-clamp-2">
            {movie.title}
          </h3>
          <div className="mt-1.5 flex items-center gap-2 text-[0.6875rem] text-muted">
            <span>{movie.year}</span>
            <span className="h-2.5 w-px bg-white/20" />
            <span className="inline-flex items-center gap-0.5">
              <Star size={9} className="fill-amber-300 text-amber-300" />
              {movie.rating.toFixed(1)}
            </span>
            <span className="h-2.5 w-px bg-white/20" />
            <span>{movie.runtime}m</span>
          </div>
        </div>

        {progress > 0 && (
          <div className="absolute inset-x-3.5 bottom-2 h-0.5 overflow-hidden rounded-full bg-white/15">
            <div
              className="h-full rounded-full bg-gold-400"
              style={{ width: `${progress}%` }}
            />
          </div>
        )}

        {/* Play affordance */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onPlay(movie);
          }}
          aria-label={`Start a watch room with ${movie.title}`}
          // Invisible is not the same as absent: without pointer-events-none this
          // button still swallowed clicks aimed at the poster, so tapping a film
          // started a room instead of opening its details.
          className="pointer-events-none absolute left-1/2 top-1/2 grid h-14 w-14 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-white/20 bg-black/70 text-white opacity-0 transition-opacity duration-[180ms] ease-swift group-hover:pointer-events-auto group-hover:opacity-100 hover:!bg-black/85 focus-visible:pointer-events-auto focus-visible:opacity-100"
        >
          <Play size={20} fill="currentColor" className="ml-0.5 text-white" />
        </button>
      </div>

      {/* Quick actions */}
      <div className="pointer-events-none absolute right-2.5 top-2.5 flex flex-col gap-1.5 opacity-0 transition-opacity duration-400 group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100">
        <button
          onClick={(e) => {
            e.stopPropagation();
            setFavorite(toggleFavorite(movie.id).includes(movie.id));
          }}
          aria-label={favorite ? `Remove ${movie.title} from favorites` : `Add ${movie.title} to favorites`}
          aria-pressed={favorite}
          className="grid h-11 w-11 place-items-center rounded-xl bg-black/60 text-white transition-colors duration-[160ms] ease-swift hover:bg-black/80 hover:text-rose-300"
        >
          <Heart size={15} className={cn(favorite && 'fill-rose-400 text-rose-400')} />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            setLater(toggleWatchLater(movie.id).includes(movie.id));
          }}
          aria-label={later ? `Remove ${movie.title} from watch later` : `Save ${movie.title} for later`}
          aria-pressed={later}
          className="grid h-11 w-11 place-items-center rounded-xl bg-black/60 text-white transition-colors duration-[160ms] ease-swift hover:bg-black/80 hover:text-gold-300"
        >
          <Bookmark size={15} className={cn(later && 'fill-gold-400 text-gold-400')} />
        </button>
      </div>
    </motion.article>
  );
}
