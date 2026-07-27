'use client';

import * as React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /** Slide up from the bottom on small screens, like a native sheet. */
  sheetOnMobile?: boolean;
}

const SIZES = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl' };

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
  sheetOnMobile = true,
}: ModalProps) {
  const panelRef = React.useRef<HTMLDivElement>(null);
  const titleId = React.useId();

  // Escape to dismiss + focus trap + scroll lock. Table stakes, easy to forget.
  React.useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const focusables = panelRef.current.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])',
      );
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
    const raf = requestAnimationFrame(() => {
      panelRef.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    });

    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      cancelAnimationFrame(raf);
      document.body.style.overflow = overflow;
      previouslyFocused?.focus?.();
    };
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[100] flex items-end justify-center sm:items-center">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
            onClick={onClose}
            className="absolute inset-0 bg-black/70 backdrop-blur-xl"
          />

          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={title ? titleId : undefined}
            initial={{ opacity: 0, y: 28, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 18, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 320, damping: 30, mass: 0.8 }}
            className={cn(
              'relative z-10 w-full glass-deep glass-lit',
              sheetOnMobile ? 'rounded-t-4xl sm:rounded-4xl' : 'rounded-4xl',
              'max-h-[92dvh] overflow-hidden',
              SIZES[size],
              'sm:mx-4',
            )}
          >
            <span
              aria-hidden
              className="pointer-events-none absolute -top-24 left-1/2 h-48 w-3/4 -translate-x-1/2 rounded-full bg-royal-500/25 blur-[80px]"
            />

            {sheetOnMobile && (
              <div className="flex justify-center pt-3 sm:hidden">
                <span className="h-1 w-10 rounded-full bg-white/20" />
              </div>
            )}

            {(title || description) && (
              <div className="relative flex items-start gap-4 px-6 pb-5 pt-6 sm:px-8 sm:pt-8">
                <div className="min-w-0 flex-1">
                  {title && (
                    <h2 id={titleId} className="font-display text-xl font-semibold tracking-tight text-white sm:text-2xl">
                      {title}
                    </h2>
                  )}
                  {description && <p className="mt-1.5 text-sm leading-relaxed text-white/50 pretty">{description}</p>}
                </div>
                <button
                  onClick={onClose}
                  aria-label="Close"
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-white/45 transition-all duration-300 hover:bg-white/10 hover:text-white"
                >
                  <X size={17} />
                </button>
              </div>
            )}

            <div className="max-h-[62dvh] overflow-y-auto px-6 pb-6 sm:px-8">{children}</div>

            {footer && (
              <div className="flex items-center justify-end gap-3 border-t border-white/10 bg-black/25 px-6 py-4 sm:px-8">
                {footer}
              </div>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
