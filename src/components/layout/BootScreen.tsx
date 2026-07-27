'use client';

import * as React from 'react';
import { AnimatePresence, motion } from 'framer-motion';

/**
 * The first two seconds.
 *
 * A projector warming up: the aperture opens, the wordmark resolves out of
 * blur, then the whole thing irises away. It runs once per tab (sessionStorage)
 * so it feels like an arrival, not a toll booth.
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
    }, 2050);

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
          exit={{ opacity: 0, scale: 1.08, filter: 'blur(12px)' }}
          transition={{ duration: 0.85, ease: [0.65, 0, 0.35, 1] }}
          className="fixed inset-0 z-[500] grid place-items-center overflow-hidden bg-ink-950"
        >
          <motion.div
            aria-hidden
            initial={{ opacity: 0, scale: 0.4 }}
            animate={{ opacity: [0, 0.9, 0.35], scale: [0.4, 1.9, 2.6] }}
            transition={{ duration: 2, ease: 'easeOut' }}
            className="absolute h-[36rem] w-[36rem] rounded-full bg-[radial-gradient(circle,rgba(124,58,237,0.5),rgba(34,211,238,0.15)_45%,transparent_70%)] blur-3xl"
          />

          <div className="relative flex flex-col items-center">
            <motion.div
              initial={{ opacity: 0, filter: 'blur(18px)', letterSpacing: '0.5em', y: 8 }}
              animate={{ opacity: 1, filter: 'blur(0px)', letterSpacing: '-0.03em', y: 0 }}
              transition={{ duration: 1.15, ease: [0.16, 1, 0.3, 1], delay: 0.15 }}
              className="font-display text-4xl font-bold text-white sm:text-6xl"
            >
              Cine<span className="text-gradient">Verse</span>
            </motion.div>

            <motion.div
              initial={{ scaleX: 0 }}
              animate={{ scaleX: 1 }}
              transition={{ duration: 1.5, ease: [0.16, 1, 0.3, 1], delay: 0.5 }}
              className="mt-6 h-px w-52 origin-left bg-gradient-to-r from-transparent via-white/45 to-transparent"
            />

            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.8, delay: 0.9 }}
              className="mt-5 text-eyebrow uppercase text-white/35"
            >
              Dimming the lights
            </motion.p>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
