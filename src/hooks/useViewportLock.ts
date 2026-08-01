'use client';

import * as React from 'react';

/**
 * Pin the room to the visible viewport, like an app screen rather than a page.
 *
 * Two separate problems, both of which only show up on a phone:
 *
 * 1. THE PAGE ITSELF SCROLLS. Even with the room root bounded, the document can
 *    still scroll — rubber-banding the whole screen, and on some browsers
 *    shifting the composer out of view. Locking `overflow` on <html>/<body> for
 *    exactly as long as the room is mounted stops that, and is reverted on the
 *    way out so the home and browse pages keep scrolling normally.
 *
 * 2. THE KEYBOARD DOES NOT SHRINK `100dvh`. Dynamic viewport units account for
 *    browser chrome, not the on-screen keyboard, so when the keyboard opens the
 *    room stays full height and the composer ends up behind it — exactly the
 *    "typing box disappears" symptom. `visualViewport` DOES report the shrunken
 *    height, so it is published as `--room-viewport-h` for the room root to use
 *    (falling back to `100dvh` where the API is missing).
 */
export function useViewportLock(enabled = true): void {
  React.useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;

    const root = document.documentElement;
    const { body } = document;
    const previous = {
      rootOverflow: root.style.overflow,
      bodyOverflow: body.style.overflow,
      bodyOverscroll: body.style.overscrollBehavior,
    };

    root.style.overflow = 'hidden';
    body.style.overflow = 'hidden';
    // Stops the pull-to-refresh / rubber-band gesture chaining out of the room.
    body.style.overscrollBehavior = 'none';

    const viewport = window.visualViewport;
    const applyHeight = () => {
      const height = viewport ? viewport.height : window.innerHeight;
      if (Number.isFinite(height) && height > 0) {
        root.style.setProperty('--room-viewport-h', `${Math.round(height)}px`);
      }
    };

    applyHeight();
    viewport?.addEventListener('resize', applyHeight);
    // The visual viewport also OFFSETS when the keyboard opens; recomputing on
    // scroll keeps the height honest while that settles.
    viewport?.addEventListener('scroll', applyHeight);
    window.addEventListener('orientationchange', applyHeight);
    window.addEventListener('resize', applyHeight);

    return () => {
      root.style.overflow = previous.rootOverflow;
      body.style.overflow = previous.bodyOverflow;
      body.style.overscrollBehavior = previous.bodyOverscroll;
      root.style.removeProperty('--room-viewport-h');
      viewport?.removeEventListener('resize', applyHeight);
      viewport?.removeEventListener('scroll', applyHeight);
      window.removeEventListener('orientationchange', applyHeight);
      window.removeEventListener('resize', applyHeight);
    };
  }, [enabled]);
}
