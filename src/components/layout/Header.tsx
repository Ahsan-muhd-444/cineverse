'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { motion, useMotionValueEvent, useScroll } from 'framer-motion';
import { Clapperboard, Menu, Sparkles, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { buttonClasses } from '@/components/ui/Button';

const LINKS = [
  { href: '/', label: 'Home' },
  { href: '/browse', label: 'Browse' },
  { href: '/join', label: 'Join a room' },
];

export function Wordmark({ className, compact }: { className?: string; compact?: boolean }) {
  return (
    <Link
      href="/"
      aria-label="CineVerse home"
      // The visible tile stays 36px; the LINK carries the 44px minimum so the
      // brand mark meets the same target standard as every other control.
      // `min-w-11` matters in the compact (room) variant, where the link holds
      // only the 36px tile; the full wordmark is already wider.
      className={cn('group inline-flex min-h-11 min-w-11 items-center justify-center gap-2.5', className)}
    >
      {/* Was a purple -> blue -> cyan gradient tile with a purple halo and a
          light-sweep on hover. Now a gold symbol on a near-black tile: the mark
          reads as one brand rather than three colours, and the gold appears as
          a detail rather than a fill. Dimensions, icon, link target and
          accessible name are unchanged. */}
      <span className="relative grid h-9 w-9 place-items-center overflow-hidden rounded-xl border border-gold-400/25 bg-ink-850 transition-colors duration-200 group-hover:border-gold-400/50">
        <Clapperboard size={17} className="relative z-10 text-gold-400" strokeWidth={2.2} />
      </span>
      {!compact && (
        <span className="font-display text-[1.0625rem] font-semibold tracking-tight text-primary">
          Cine<span className="text-secondary transition-colors duration-200 group-hover:text-primary">Verse</span>
        </span>
      )}
    </Link>
  );
}

export function Header() {
  const pathname = usePathname();
  const { scrollY } = useScroll();
  const [condensed, setCondensed] = React.useState(false);
  const [menuOpen, setMenuOpen] = React.useState(false);

  useMotionValueEvent(scrollY, 'change', (latest) => setCondensed(latest > 24));

  React.useEffect(() => setMenuOpen(false), [pathname]);

  return (
    <header className="fixed inset-x-0 top-0 z-50">
      <motion.div
        animate={{ paddingTop: condensed ? 10 : 20, paddingBottom: condensed ? 10 : 20 }}
        transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
        className={cn(
          'relative transition-colors duration-500',
          condensed && 'border-b border-white/[0.07] bg-ink-900/70 backdrop-blur-2xl',
        )}
      >
        <div className="container flex items-center justify-between gap-4">
          <Wordmark />

          <nav aria-label="Primary" className="hidden items-center gap-1 md:flex">
            {LINKS.map((link) => {
              const active = link.href === '/' ? pathname === '/' : pathname.startsWith(link.href);
              return (
                <Link
                  key={link.href}
                  href={link.href}
                  className={cn(
                    'relative rounded-xl px-4 py-2 text-[0.8125rem] font-medium transition-colors duration-300',
                    active ? 'text-primary' : 'text-secondary hover:text-primary',
                  )}
                >
                  {active && (
                    <motion.span
                      layoutId="nav-pill"
                      transition={{ type: 'spring', stiffness: 380, damping: 32 }}
                      className="absolute inset-0 rounded-xl bg-white/[0.08] shadow-inner-hairline"
                    />
                  )}
                  <span className="relative z-10">{link.label}</span>
                </Link>
              );
            })}
          </nav>

          <div className="flex items-center gap-2">
            <Link
              href="/#launchpad"
              className={buttonClasses({ variant: 'primary', size: 'sm', className: 'hidden !h-11 sm:inline-flex' })}
            >
              <Sparkles size={14} />
              Create room
            </Link>

            <button
              onClick={() => setMenuOpen((v) => !v)}
              aria-label={menuOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={menuOpen}
              className="grid h-11 w-11 place-items-center rounded-xl glass-soft text-secondary transition-colors duration-[160ms] ease-swift hover:text-primary md:hidden"
            >
              {menuOpen ? <X size={17} /> : <Menu size={17} />}
            </button>
          </div>
        </div>
      </motion.div>

      <motion.div
        initial={false}
        animate={menuOpen ? { height: 'auto', opacity: 1 } : { height: 0, opacity: 0 }}
        transition={{ duration: 0.42, ease: [0.16, 1, 0.3, 1] }}
        className="overflow-hidden md:hidden"
      >
        <div className="container pb-4">
          <div className="flex flex-col gap-1 rounded-3xl glass-deep p-2">
            {LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="rounded-2xl px-4 py-3 text-sm font-medium text-secondary transition-colors hover:bg-white/[0.07] hover:text-primary"
              >
                {link.label}
              </Link>
            ))}
          </div>
        </div>
      </motion.div>
    </header>
  );
}
