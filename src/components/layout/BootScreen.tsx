'use client';

import * as React from 'react';
import { AnimatePresence, motion } from 'framer-motion';

/**
 * A brief brand arrival — roughly 850ms, once per tab.
 *
 * Was just over two seconds of purple-and-cyan iris: a radial that scaled to
 * 2.6x, a wordmark unblurring from 0.5em letter-spacing, and a blurred scale-up
 * exit. Held together it was the loudest surface in the product and it blocked
 * the app while doing it. Now a still gold mark on near-black with one short
 * reveal and a fast fade out.
 *
 * Unchanged: once-per-tab sessionStorage key, the reduced-motion bypass, body
 * scroll restoration, and the cleanup on unmount.
 */
export function BootScreen() {
  const [visible, setVisible] = React.useState(false);

  React.useEffect(() => {
    let seen = false;
    try {
      seen = sessionStorage.getItem('cineverse:booted') === '1';
    } catch {
      seen = false;
    }
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (seen || reduced) return;

    setVisible(true);
    document.body.style.overflow = 'hidden';
    const timer = setTimeout(() => {
      setVisible(false);
      document.body.style.overflow = '';
      try {
        sessionStorage.setItem('cineverse:booted', '1');
      } catch {
        /* ignore */
      }
    }, 850);

    return () => {
      clearTimeout(timer);
      document.body.style.overflow = '';
    };
  }, []);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          key="boot"
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          // aria-hidden + inert pointer/selection: the boot layer must never be
          // reachable, and nothing behind it should be operable while it blocks.
          aria-hidden
          className="pointer-events-none fixed inset-0 z-[500] grid select-none place-items-center overflow-hidden bg-ink-950"
        >
          <div className="relative flex flex-col items-center">
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.34, ease: [0.16, 1, 0.3, 1] }}
              className="font-display text-4xl font-bold text-primary sm:text-6xl"
            >
              Cine<span className="text-gold-400">Verse</span>
            </motion.div>

            {/* One still projector line. No scaleX sweep. */}
            <div className="mt-6 h-px w-52 bg-gradient-to-r from-transparent via-white/25 to-transparent" />

            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.28, delay: 0.16 }}
              className="mt-5 text-eyebrow uppercase text-muted"
            >
              Dimming the lights
            </motion.p>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
