'use client';

import * as React from 'react';
import Link from 'next/link';
import { motion, useReducedMotion, useScroll, useTransform } from 'framer-motion';
import { ArrowRight, Play, Radio } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { CATALOG, posterArt } from '@/lib/catalog';

const WORDS = ['together', 'in sync', 'side by side', 'as one'];

/**
 * A rotating word inside the headline. Each swap is a blurred vertical wipe —
 * the same trick title cards use, at 1/20th the duration.
 */
function RotatingWord() {
  const [index, setIndex] = React.useState(0);
  const reduced = useReducedMotion();

  React.useEffect(() => {
    if (reduced) return;
    const id = setInterval(() => setIndex((i) => (i + 1) % WORDS.length), 2600);
    return () => clearInterval(id);
  }, [reduced]);

  return (
    <span className="relative inline-grid overflow-hidden align-bottom">
      {WORDS.map((word, i) => (
        <motion.span
          key={word}
          aria-hidden={i !== index}
          initial={false}
          animate={
            i === index
              ? { y: '0%', opacity: 1, filter: 'blur(0px)' }
              : { y: i < index ? '-110%' : '110%', opacity: 0, filter: 'blur(10px)' }
          }
          transition={{ duration: 0.75, ease: [0.16, 1, 0.3, 1] }}
          className="col-start-1 row-start-1 whitespace-nowrap text-gradient"
        >
          {word}
        </motion.span>
      ))}
      {/* Keeps the layout box the width of the longest word */}
      <span className="invisible col-start-1 row-start-1">side by side</span>
    </span>
  );
}

/** Three poster planes that drift apart as you scroll. The parallax. */
function PosterStack() {
  const ref = React.useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'end start'] });

  const yA = useTransform(scrollYProgress, [0, 1], [0, -110]);
  const yB = useTransform(scrollYProgress, [0, 1], [0, -50]);
  const yC = useTransform(scrollYProgress, [0, 1], [0, -180]);
  const rotate = useTransform(scrollYProgress, [0, 1], [0, -6]);

  const picks = [CATALOG[1], CATALOG[2], CATALOG[0]];
  const ys = [yA, yB, yC];
  const layout = [
    'left-0 top-10 w-[46%] z-20',
    'right-2 top-0 w-[42%] z-10',
    'left-[24%] bottom-0 w-[44%] z-30',
  ];

  return (
    <div ref={ref} className="relative mx-auto aspect-[4/5] w-full max-w-md stack-3d">
      {picks.map((movie, i) => (
        <motion.div
          key={movie.id}
          style={{ y: ys[i], rotate: i === 2 ? rotate : undefined }}
          className={`absolute ${layout[i]} animate-float-y`}
        >
          <div className="group relative overflow-hidden rounded-3xl border border-white/12 shadow-lift">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={posterArt(movie)}
              alt=""
              className="aspect-[2/3] w-full object-cover"
              loading="lazy"
              decoding="async"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-transparent to-transparent" />
            <div className="absolute inset-x-0 bottom-0 p-4">
              <p className="font-display text-sm font-semibold leading-tight text-white">{movie.title}</p>
              <p className="mt-0.5 text-[0.6875rem] text-white/45">
                {movie.year} · {movie.genres[0]}
              </p>
            </div>
            <span className="pointer-events-none absolute inset-0 rounded-3xl shadow-inner-hairline" />
          </div>
        </motion.div>
      ))}

      {/* The beam of light the posters float in */}
      <div
        aria-hidden
        className="absolute -inset-16 -z-10 rounded-full bg-[radial-gradient(circle_at_50%_40%,rgba(124,58,237,0.34),transparent_62%)] blur-2xl"
      />
    </div>
  );
}

export function Hero() {
  const { scrollYProgress } = useScroll();
  const contentY = useTransform(scrollYProgress, [0, 0.28], [0, 70]);
  const contentOpacity = useTransform(scrollYProgress, [0, 0.22], [1, 0]);

  return (
    <section className="relative min-h-[100svh] overflow-hidden pb-24 pt-32 sm:pt-40">
      <div className="container relative">
        <motion.div style={{ y: contentY, opacity: contentOpacity }} className="grid items-center gap-16 lg:grid-cols-[1.15fr_0.85fr] lg:gap-12">
          <div>
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1], delay: 0.05 }}
              className="inline-flex items-center gap-2.5 rounded-full glass-soft px-3.5 py-1.5"
            >
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-electric-400 opacity-70" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-electric-400" />
              </span>
              <span className="text-eyebrow uppercase text-white/60">Realtime · Private · Free</span>
            </motion.div>

            <motion.h1
              initial={{ opacity: 0, y: 24 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.95, ease: [0.16, 1, 0.3, 1], delay: 0.12 }}
              className="mt-7 font-display text-display-xl text-white balance"
            >
              Watch anything
              <br />
              <RotatingWord />
            </motion.h1>

            <motion.p
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1], delay: 0.24 }}
              className="mt-7 max-w-xl text-[1.0625rem] leading-relaxed text-white/55 pretty"
            >
              One room, two seats, and a playhead that never drifts. Press play on your side and it
              plays on theirs — with live chat, voice and video, however far apart you are.
            </motion.p>

            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.9, ease: [0.16, 1, 0.3, 1], delay: 0.34 }}
              className="mt-10 flex flex-col gap-3 sm:flex-row sm:items-center"
            >
              <Link href="#launchpad" className="sm:w-auto">
                <Button variant="primary" size="lg" className="w-full sm:w-auto">
                  <Play size={17} fill="currentColor" />
                  Create a watch room
                </Button>
              </Link>
              <Link href="/join" className="sm:w-auto">
                <Button variant="glass" size="lg" className="w-full sm:w-auto">
                  <Radio size={17} />
                  Join with a code
                </Button>
              </Link>
            </motion.div>

            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 1, delay: 0.5 }}
              className="mt-10 flex flex-wrap items-center gap-x-7 gap-y-3 text-[0.8125rem] text-white/35"
            >
              <span>No account needed</span>
              <span className="h-3 w-px bg-white/15" />
              <span>Sub-second sync</span>
              <span className="h-3 w-px bg-white/15" />
              <span>Your link, your room, nobody else</span>
            </motion.div>
          </div>

          <motion.div
            initial={{ opacity: 0, scale: 0.94, y: 30 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{ duration: 1.2, ease: [0.16, 1, 0.3, 1], delay: 0.3 }}
            className="hidden lg:block"
          >
            <PosterStack />
          </motion.div>
        </motion.div>
      </div>

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 1.4, duration: 1 }}
        className="absolute inset-x-0 bottom-8 hidden justify-center lg:flex"
      >
        <Link
          href="#launchpad"
          aria-label="Scroll to room launchpad"
          className="group flex flex-col items-center gap-2 text-white/30 transition-colors hover:text-white/70"
        >
          <span className="text-[0.625rem] uppercase tracking-[0.24em]">Open a room</span>
          <span className="grid h-9 w-9 place-items-center rounded-full border border-white/12 transition-transform duration-500 group-hover:translate-y-1">
            <ArrowRight size={14} className="rotate-90" />
          </span>
        </Link>
      </motion.div>
    </section>
  );
}
