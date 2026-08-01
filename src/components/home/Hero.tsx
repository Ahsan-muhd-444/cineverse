'use client';

import * as React from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { Play, Radio } from 'lucide-react';
import { buttonClasses } from '@/components/ui/Button';
import { CATALOG, posterArt } from '@/lib/catalog';

/**
 * One still frame, presented like an installed screen.
 *
 * Replaces a three-poster parallax pile that drifted on scroll, floated on an
 * infinite `float-y` loop, and sat in a purple radial beam. Three planes moving
 * independently behind a headline is a lot of competition for the one sentence
 * the page needs to land — and none of it said anything about the product.
 *
 * A single widescreen backdrop, a neutral cinema hairline and a readability
 * gradient under the caption. No fake controls, no play overlay, no film-colour
 * wash: it previews the ATMOSPHERE of the room without pretending to be one.
 */
function StageFrame() {
  const feature = CATALOG[0];

  return (
    <figure className="relative mx-auto w-full max-w-xl">
      <div className="relative overflow-hidden rounded-2xl border border-white/[0.09] bg-black shadow-[0_1px_0_0_rgba(255,255,255,0.07)_inset,0_32px_80px_-28px_rgba(0,0,0,0.95)] sm:rounded-3xl">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={posterArt(feature)}
          alt=""
          className="aspect-[16/10] w-full object-cover"
          loading="eager"
          decoding="async"
        />
        {/* Neutral black only — enough to keep the caption legible, never a tint. */}
        <div
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-2/5 bg-gradient-to-t from-black/85 via-black/35 to-transparent"
        />
        <figcaption className="absolute inset-x-0 bottom-0 p-4 sm:p-5">
          <p className="font-display text-[0.9375rem] font-semibold leading-tight text-primary sm:text-base">
            {feature.title}
          </p>
          <p className="mt-0.5 text-[0.75rem] text-muted">
            {feature.year} · {feature.genres[0]}
          </p>
        </figcaption>
      </div>
    </figure>
  );
}

export function Hero() {
  return (
    <section className="relative overflow-hidden pb-24 pt-32 sm:pt-40">
      <div className="container relative">
        {/* No scroll-linked fade or translate on this wrapper: tying the hero to
            scrollYProgress meant the headline dissolved as soon as you moved,
            which fights the reader rather than rewarding them. */}
        <div className="grid items-center gap-16 lg:grid-cols-[1.15fr_0.85fr] lg:gap-12">
          <div>
            {/* Editorial eyebrow. Was a cyan pulsing dot — but "Realtime" here is
                marketing copy, not a live connection, and cyan is reserved for
                actual realtime state. A gold hairline carries it instead. */}
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1], delay: 0.05 }}
              className="flex items-center gap-3"
            >
              <span aria-hidden className="h-px w-6 bg-gold-400/70" />
              <span className="text-eyebrow uppercase text-muted">Realtime · Private · Free</span>
            </motion.div>

            <motion.h1
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1], delay: 0.12 }}
              className="mt-7 font-display text-display-xl text-primary balance"
            >
              Watch anything.
              <br />
              Stay in sync.
            </motion.h1>

            <motion.p
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1], delay: 0.2 }}
              className="mt-7 max-w-xl text-[1.0625rem] leading-relaxed text-supporting pretty"
            >
              One room, two seats, and a playhead that never drifts. Press play on your side and it
              plays on theirs — with live chat, voice and video, however far apart you are.
            </motion.p>

            <motion.div
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1], delay: 0.28 }}
              className="mt-10 flex flex-col gap-3 sm:flex-row sm:items-center"
            >
              {/* Real anchors wearing the button recipe — one interactive
                  element each, instead of a Link wrapping a <button>. */}
              <Link href="#launchpad" className={buttonClasses({ variant: 'primary', size: 'lg', className: 'w-full sm:w-auto' })}>
                <Play size={17} fill="currentColor" />
                Create a watch room
              </Link>
              <Link href="/join" className={buttonClasses({ variant: 'glass', size: 'lg', className: 'w-full sm:w-auto' })}>
                <Radio size={17} />
                Join with a code
              </Link>
            </motion.div>

            {/* Product facts, not decoration — these were at 0.35 (3.76:1). */}
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.7, delay: 0.36 }}
              className="mt-10 flex flex-wrap items-center gap-x-7 gap-y-2 text-[0.8125rem] text-muted"
            >
              <span>No account needed</span>
              <span aria-hidden className="hidden h-3 w-px bg-white/15 sm:block" />
              <span>Sub-second sync</span>
              <span aria-hidden className="hidden h-3 w-px bg-white/15 sm:block" />
              <span>Your link, your room, nobody else</span>
            </motion.div>
          </div>

          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1], delay: 0.24 }}
            className="hidden lg:block"
          >
            <StageFrame />
          </motion.div>
        </div>
      </div>
    </section>
  );
}
