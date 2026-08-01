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

/** Focusable controls, excluding disabled ones — a disabled element can never
 *  receive focus, so treating it as the trap's first/last stop breaks the wrap. */
const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

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
  const descriptionId = React.useId();

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
    // Focus must land INSIDE the dialog every time. Previously only an explicit
    // `[data-autofocus]` was honoured, so views without one — SourcePicker's
    // default Catalog tab, Room settings — left focus behind the overlay, where
    // Tab walks the page underneath instead of the dialog.
    const focusInside = () => {
      const panel = panelRef.current;
      // Idempotent: whichever scheduler wins, the other becomes a no-op.
      if (!panel || panel.contains(document.activeElement)) return;
      const preferred = panel.querySelector<HTMLElement>('[data-autofocus]');
      if (preferred) {
        preferred.focus();
        return;
      }
      // First ENABLED focusable — normally the close button.
      const first = panel.querySelector<HTMLElement>(FOCUSABLE);
      if (first) {
        first.focus();
        return;
      }
      // Nothing focusable at all: the panel itself takes focus.
      panel.focus();
    };

    // Two schedulers on purpose. rAF is the right moment in a visible tab —
    // after layout, before paint. But rAF callbacks DO NOT RUN while the
    // document is hidden, so a dialog opened in a background tab would never
    // receive focus, and the user would return to a trapped-looking overlay
    // with focus still behind it. The timeout covers that case; the guard above
    // makes the second one harmless.
    const raf = requestAnimationFrame(focusInside);
    const focusTimer = window.setTimeout(focusInside, 0);

    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      cancelAnimationFrame(raf);
      clearTimeout(focusTimer);
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
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            onClick={onClose}
            // Neutral black, restrained blur. 24px of backdrop blur over a
            // playing film is an expensive compositing layer that also made the
            // video read as "still active" behind the dialog.
            className="absolute inset-0 bg-black/[0.78] backdrop-blur-[8px]"
          />

          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={title ? titleId : undefined}
            aria-describedby={description ? descriptionId : undefined}
            tabIndex={-1}
            // Opacity plus a short rise. The spring overshot on every open,
            // which reads as a toy rather than a considered surface.
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className={cn(
              'relative z-10 w-full glass-deep',
              sheetOnMobile ? 'rounded-t-4xl sm:rounded-4xl' : 'rounded-4xl',
              'max-h-[92dvh] overflow-hidden',
              SIZES[size],
              'sm:mx-4',
            )}
          >
            {sheetOnMobile && (
              <div className="flex justify-center pt-3 sm:hidden">
                <span className="h-1 w-10 rounded-full bg-white/20" />
              </div>
            )}

            {(title || description) && (
              <div className="relative flex items-start gap-4 px-6 pb-5 pt-6 sm:px-8 sm:pt-8">
                <div className="min-w-0 flex-1">
                  {title && (
                    <h2 id={titleId} className="font-display text-xl font-semibold tracking-tight text-primary">
                      {title}
                    </h2>
                  )}
                  {description && (
                    <p id={descriptionId} className="mt-1.5 text-[0.875rem] leading-relaxed text-supporting pretty">
                      {description}
                    </p>
                  )}
                </div>
                <button
                  onClick={onClose}
                  aria-label="Close"
                  className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-muted transition-colors duration-[160ms] ease-swift hover:bg-white/10 hover:text-primary"
                >
                  <X size={17} />
                </button>
              </div>
            )}

            <div className="max-h-[62dvh] overflow-y-auto px-6 pb-6 sm:px-8">{children}</div>

            {footer && (
              <div className="flex items-center justify-end gap-3 border-t border-white/[0.08] px-6 py-4 sm:px-8">
                {footer}
              </div>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
