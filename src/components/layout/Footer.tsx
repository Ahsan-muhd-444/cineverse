'use client';

import Link from 'next/link';
import { Github, Heart } from 'lucide-react';
import { Wordmark } from './Header';

export function Footer() {
  return (
    <footer className="relative border-t border-white/[0.07] py-14">
      <div className="container">
        <div className="flex flex-col items-start justify-between gap-10 sm:flex-row sm:items-center">
          <div className="max-w-xs">
            <Wordmark />
            <p className="mt-4 text-sm leading-relaxed text-supporting pretty">
              A private cinema for two. Built for the nights you cannot be in the same room.
            </p>
          </div>

          <nav aria-label="Footer" className="flex flex-wrap gap-x-10 gap-y-4 text-sm">
            <div className="flex flex-col gap-0.5">
              <span className="text-eyebrow uppercase text-muted">Product</span>
              <Link href="/browse" className="inline-flex min-h-11 items-center text-secondary transition-colors duration-[160ms] ease-swift hover:text-primary">
                Browse
              </Link>
              <Link href="/join" className="inline-flex min-h-11 items-center text-secondary transition-colors duration-[160ms] ease-swift hover:text-primary">
                Join a room
              </Link>
            </div>
            <div className="flex flex-col gap-0.5">
              <span className="text-eyebrow uppercase text-muted">More</span>
              <Link href="/#launchpad" className="inline-flex min-h-11 items-center text-secondary transition-colors duration-[160ms] ease-swift hover:text-primary">
                Create a room
              </Link>
              <a
                href="https://github.com"
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex min-h-11 items-center gap-1.5 text-secondary transition-colors duration-[160ms] ease-swift hover:text-primary"
              >
                <Github size={13} />
                Source
              </a>
            </div>
          </nav>
        </div>

        <div className="mt-12 flex flex-col items-start justify-between gap-3 border-t border-white/[0.07] pt-7 text-xs text-muted sm:flex-row sm:items-center">
          <p>© {new Date().getFullYear()} CineVerse. Rooms are ephemeral and never recorded.</p>
          <p className="inline-flex items-center gap-1.5">
            Made for watching together <Heart size={11} className="text-rose-400/70" fill="currentColor" />
          </p>
        </div>
      </div>
    </footer>
  );
}
