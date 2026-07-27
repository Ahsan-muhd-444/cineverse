'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { motion, useMotionValueEvent, useScroll } from 'framer-motion';
import { Clapperboard, Menu, Sparkles, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/Button';

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
      className={cn('group inline-flex items-center gap-2.5', className)}
    >
      <span className="relative grid h-9 w-9 place-items-center overflow-hidden rounded-xl bg-[linear-gradient(135deg,#7c3aed,#3b6cf6_55%,#22d3ee)] shadow-[0_8px_26px_-8px_rgba(124,58,237,0.9)]">
        <Clapperboard size={17} className="relative z-10 text-white" strokeWidth={2.2} />
        <span className="absolute inset-0 -translate-x-full bg-white/30 blur-sm transition-transform duration-700 group-hover:translate-x-full" />
      </span>
      {!compact && (
        <span className="font-display text-[1.0625rem] font-semibold tracking-tight text-white">
          Cine<span className="text-white/55 transition-colors duration-500 group-hover:text-electric-300">Verse</span>
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
                    active ? 'text-white' : 'text-white/50 hover:text-white/85',
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
            <Link href="/#launchpad" className="hidden sm:inline-flex">
              <Button variant="primary" size="sm">
                <Sparkles size={14} />
                Create room
              </Button>
            </Link>

            <button
              onClick={() => setMenuOpen((v) => !v)}
              aria-label={menuOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={menuOpen}
              className="grid h-10 w-10 place-items-center rounded-xl glass-soft text-white/70 transition-colors hover:text-white md:hidden"
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
                className="rounded-2xl px-4 py-3 text-sm font-medium text-white/75 transition-colors hover:bg-white/[0.07] hover:text-white"
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
