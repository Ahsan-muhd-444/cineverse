'use client';

import * as React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Bookmark, Clock, Film, Heart, Play, Star, UserRound, X } from 'lucide-react';
import type { Movie } from '@/lib/types';
import { posterArt } from '@/lib/catalog';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Bits';
import { cn } from '@/lib/utils';
import { getFavorites, getWatchLater, toggleFavorite, toggleWatchLater } from '@/lib/storage';

/** Focusable controls, excluding disabled ones — matches `Modal`. */
const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * A cinematic detail sheet: backdrop, credits, cast, and one obvious action.
 * Opens as a centred pane on desktop and a bottom sheet on phones.
 */
export function MovieDetail({
  movie,
  onClose,
  onPlay,
}: {
  movie: Movie | null;
  onClose: () => void;
  onPlay: (movie: Movie) => void;
}) {
  const [favorite, setFavorite] = React.useState(false);
  const [later, setLater] = React.useState(false);

  React.useEffect(() => {
    if (!movie) return;
    setFavorite(getFavorites().includes(movie.id));
    setLater(getWatchLater().includes(movie.id));
  }, [movie]);

  // Keep the callback in a ref so the effect below depends only on whether the
  // sheet is open. Parents pass an inline arrow, which changes identity on every
  // render — re-subscribing on each one made Escape unreliable and could restore
  // the wrong `overflow` value, leaving the page scroll-locked after closing.
  const onCloseRef = React.useRef(onClose);
  React.useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const isOpen = Boolean(movie);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const titleId = React.useId();
  const descriptionId = React.useId();

  // The Escape listener lives for the whole component and checks a ref, rather
  // than being attached and detached as the sheet opens and closes. Several of
  // these sheets are mounted at once on the browse page (one per carousel), and
  // the subscribe/unsubscribe churn across instances made Escape intermittent.
  const openRef = React.useRef(false);
  React.useEffect(() => {
    openRef.current = isOpen;
  }, [isOpen]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && openRef.current) onCloseRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  React.useEffect(() => {
    if (!isOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const previouslyFocused = document.activeElement as HTMLElement | null;

    // Trap Tab inside the sheet. Focus was previously moved to the panel but
    // never contained, so Tab walked straight out into the browse grid behind
    // the overlay — every poster, favourite and watch-later button underneath.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !panelRef.current) return;
      const focusables = panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);

    const focusInside = () => {
      const panel = panelRef.current;
      if (!panel || panel.contains(document.activeElement)) return;
      const first = panel.querySelector<HTMLElement>(FOCUSABLE);
      if (first) first.focus();
      else panel.focus();
    };
    // Same dual scheduling as Modal: rAF callbacks never run while the document
    // is hidden, so a sheet opened in a background tab would never take focus.
    const frame = requestAnimationFrame(focusInside);
    const focusTimer = window.setTimeout(focusInside, 0);

    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      cancelAnimationFrame(frame);
      clearTimeout(focusTimer);
      previouslyFocused?.focus?.();
    };
  }, [isOpen]);

  return (
    <AnimatePresence>
      {movie && (
        <div className="fixed inset-0 z-[110] flex items-end justify-center sm:items-center sm:p-6">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={onClose}
            className="absolute inset-0 bg-black/[0.78] backdrop-blur-[8px]"
          />

          <motion.div
            ref={panelRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={descriptionId}
            // Focus lives inside the panel (see the effect above), so this
            // handler always sees Escape — regardless of what else is mounted.
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation();
                onClose();
              }
            }}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            className="relative z-10 max-h-[94dvh] w-full max-w-4xl overflow-hidden rounded-t-4xl glass-deep sm:rounded-4xl"
          >
            {/* Backdrop */}
            <div className="relative h-52 overflow-hidden sm:h-72">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={posterArt(movie, 'backdrop')} alt="" className="h-full w-full object-cover" />
              <div className="absolute inset-0 bg-gradient-to-t from-ink-850 via-ink-850/45 to-transparent" />

              <button
                onClick={onClose}
                aria-label="Close"
                className="absolute right-4 top-4 grid h-11 w-11 place-items-center rounded-2xl border border-white/15 bg-black/70 text-white transition-colors duration-[160ms] ease-swift hover:bg-black/85"
              >
                <X size={17} />
              </button>

              <div className="absolute inset-x-0 bottom-0 p-6 sm:p-8">
                <div className="flex flex-wrap items-center gap-2">
                  {movie.genres.map((genre) => (
                    <Badge key={genre} tone="neutral">
                      {genre}
                    </Badge>
                  ))}
                </div>
                <h2 id={titleId} className="mt-3 font-display text-display-md text-primary balance">{movie.title}</h2>
              </div>
            </div>

            <div className="max-h-[46dvh] overflow-y-auto px-6 pb-6 sm:px-8">
              <p className="text-[0.9375rem] text-secondary">{movie.tagline}</p>

              <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-[0.8125rem] text-supporting">
                <span className="inline-flex items-center gap-1.5">
                  <Star size={13} className="fill-amber-300 text-amber-300" />
                  <span className="font-medium text-primary">{movie.rating.toFixed(1)}</span>
                  <span className="text-muted">/ 10</span>
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Clock size={13} />
                  {movie.runtime} min
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Film size={13} />
                  {movie.year}
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <UserRound size={13} />
                  {movie.director}
                </span>
              </div>

              <p id={descriptionId} className="mt-6 max-w-2xl text-[0.9375rem] leading-relaxed text-supporting pretty">{movie.overview}</p>

              <div className="mt-8">
                <h3 className="text-eyebrow uppercase text-muted">Cast</h3>
                <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {movie.cast.map((person) => (
                    <div key={person.name} className="rounded-2xl bg-white/[0.04] p-3.5">
                      <p className="truncate text-[0.8125rem] font-medium text-primary">{person.name}</p>
                      <p className="mt-0.5 truncate text-[0.6875rem] text-muted">{person.role}</p>
                    </div>
                  ))}
                </div>
              </div>

              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <Button
                  variant="primary"
                  size="lg"
                  className="flex-1"
                  onClick={() => {
                    onPlay(movie);
                    onClose();
                  }}
                >
                  <Play size={17} fill="currentColor" />
                  Watch together
                </Button>
                <Button
                  variant="glass"
                  size="lg"
                  onClick={() => setFavorite(toggleFavorite(movie.id).includes(movie.id))}
                  aria-pressed={favorite}
                >
                  <Heart size={16} className={cn(favorite && 'fill-rose-400 text-rose-400')} />
                  {favorite ? 'Favorited' : 'Favorite'}
                </Button>
                <Button
                  variant="glass"
                  size="lg"
                  onClick={() => setLater(toggleWatchLater(movie.id).includes(movie.id))}
                  aria-pressed={later}
                >
                  <Bookmark size={16} className={cn(later && 'fill-gold-400 text-gold-400')} />
                  {later ? 'Saved' : 'Watch later'}
                </Button>
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
