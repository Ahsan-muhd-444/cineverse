'use client';

import * as React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { Movie } from '@/lib/types';
import { MovieCard } from './MovieCard';
import { MovieDetail } from './MovieDetail';
import { useStartRoom } from '@/hooks/useStartRoom';
import { cn } from '@/lib/utils';

export interface Row {
  id: string;
  title: string;
  subtitle?: string;
  items: Movie[];
}

export function MovieRow({ row, className }: { row: Row; className?: string }) {
  const scroller = React.useRef<HTMLDivElement>(null);
  const [detail, setDetail] = React.useState<Movie | null>(null);
  const [edges, setEdges] = React.useState({ start: true, end: false });
  const { start } = useStartRoom();

  const measure = React.useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    setEdges({
      start: el.scrollLeft <= 8,
      end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 8,
    });
  }, []);

  React.useEffect(() => {
    measure();
    const el = scroller.current;
    if (!el) return;
    el.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    return () => {
      el.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
    };
  }, [measure]);

  const nudge = (direction: -1 | 1) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollBy({ left: direction * Math.max(320, el.clientWidth * 0.8), behavior: 'smooth' });
  };

  if (!row.items.length) return null;

  return (
    <section className={cn('group/row relative', className)} aria-labelledby={`row-${row.id}`}>
      <div className="container mb-5 flex items-end justify-between gap-4">
        <div>
          <h2 id={`row-${row.id}`} className="font-display text-display-sm text-white">
            {row.title}
          </h2>
          {row.subtitle && <p className="mt-1 text-[0.8125rem] text-supporting">{row.subtitle}</p>}
        </div>
        <div className="hidden gap-1.5 sm:flex">
          <button
            onClick={() => nudge(-1)}
            disabled={edges.start}
            aria-label={`Scroll ${row.title} left`}
            className="grid h-11 w-11 place-items-center rounded-xl glass-soft text-secondary transition-colors duration-[160ms] ease-swift hover:text-primary disabled:text-decorative"
          >
            <ChevronLeft size={16} />
          </button>
          <button
            onClick={() => nudge(1)}
            disabled={edges.end}
            aria-label={`Scroll ${row.title} right`}
            className="grid h-11 w-11 place-items-center rounded-xl glass-soft text-secondary transition-colors duration-[160ms] ease-swift hover:text-primary disabled:text-decorative"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      <div
        ref={scroller}
        className="no-scrollbar edge-fade-x flex gap-4 overflow-x-auto scroll-smooth px-5 pb-4 sm:px-8 lg:px-12 2xl:px-[max(3rem,calc((100vw-1440px)/2+4rem))]"
        style={{ scrollSnapType: 'x proximity' }}
      >
        {row.items.map((movie, i) => (
          <div key={`${row.id}-${movie.id}`} style={{ scrollSnapAlign: 'start' }}>
            <MovieCard movie={movie} onOpen={setDetail} onPlay={start} priority={i < 4} />
          </div>
        ))}
      </div>

      <MovieDetail movie={detail} onClose={() => setDetail(null)} onPlay={start} />
    </section>
  );
}
