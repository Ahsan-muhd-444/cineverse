'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/* ==========================================================================
   Aurora — slow drifting colour fields behind everything.
   Pure CSS animation so it costs nothing on the main thread.
   ========================================================================== */

export function Aurora({ className, intensity = 1 }: { className?: string; intensity?: number }) {
  // Was four saturated fields — violet 0.55, cyan 0.34, blue 0.42, pink 0.20 —
  // drifting at 0.75 opacity. Four competing hues is what made the product read
  // as generic SaaS rather than cinema. Now three low-saturation warm fields at
  // roughly a fifth of the former strength: the room should feel like a dark
  // auditorium with a little projector spill, not a colour wash.
  const blobs = React.useMemo(
    () => [
      // Rendered-screenshot correction: at these values the fields summed into a
      // page-wide amber cast — a sepia filter over the whole product rather than
      // the occasional projector spill they were meant to be. Roughly halved,
      // and the warm pair is now outweighed by the neutral one.
      { color: 'rgba(221,178,92,0.055)', size: '52vw', top: '-14%', left: '-8%', delay: '0s', duration: '24s' },
      { color: 'rgba(168,122,43,0.04)', size: '44vw', top: '18%', left: '58%', delay: '-7s', duration: '29s' },
      { color: 'rgba(255,255,255,0.05)', size: '48vw', top: '52%', left: '6%', delay: '-13s', duration: '26s' },
    ],
    [],
  );

  return (
    <div aria-hidden className={cn('pointer-events-none absolute inset-0 overflow-hidden', className)}>
      {blobs.map((b, i) => (
        <div
          key={i}
          className="cv-aurora animate-aurora-drift"
          style={{
            background: b.color,
            width: b.size,
            height: b.size,
            top: b.top,
            left: b.left,
            opacity: 0.55 * intensity,
            animationDelay: b.delay,
            animationDuration: b.duration,
          }}
        />
      ))}
      <div className="cv-grain" />
    </div>
  );
}

/* ==========================================================================
   Spotlight — a soft light that follows the cursor.
   Written straight to CSS custom properties inside a rAF, so moving the mouse
   never triggers a React render.
   ========================================================================== */

export function Spotlight({ className }: { className?: string }) {
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia('(pointer: coarse)').matches) return;

    let frame = 0;
    let targetX = window.innerWidth / 2;
    let targetY = window.innerHeight / 3;
    let currentX = targetX;
    let currentY = targetY;

    const onMove = (e: PointerEvent) => {
      targetX = e.clientX;
      targetY = e.clientY;
      el.style.opacity = '1';
    };
    const onLeave = () => {
      el.style.opacity = '0';
    };

    const tick = () => {
      // Easing the follow makes the light feel like it has weight.
      currentX += (targetX - currentX) * 0.12;
      currentY += (targetY - currentY) * 0.12;
      const rect = el.getBoundingClientRect();
      el.style.setProperty('--spotlight-x', `${currentX - rect.left}px`);
      el.style.setProperty('--spotlight-y', `${currentY - rect.top}px`);
      frame = requestAnimationFrame(tick);
    };

    window.addEventListener('pointermove', onMove, { passive: true });
    document.addEventListener('pointerleave', onLeave);
    frame = requestAnimationFrame(tick);

    return () => {
      window.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerleave', onLeave);
      cancelAnimationFrame(frame);
    };
  }, []);

  return <div ref={ref} aria-hidden className={cn('cv-spotlight opacity-0', className)} />;
}

/* ==========================================================================
   Particles — drifting dust in the projector beam.
   One canvas, device-pixel aware, pauses when the tab is hidden.
   ========================================================================== */

export function Particles({
  className,
  density = 0.00009,
  speed = 0.16,
}: {
  className?: string;
  density?: number;
  speed?: number;
}) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let width = 0;
    let height = 0;
    let dpr = 1;
    let raf = 0;
    let running = true;

    type Dot = { x: number; y: number; r: number; vx: number; vy: number; a: number; hue: number };
    let dots: Dot[] = [];

    const seed = () => {
      const count = Math.min(140, Math.max(28, Math.floor(width * height * density)));
      dots = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        r: Math.random() * 1.6 + 0.4,
        vx: (Math.random() - 0.5) * speed,
        vy: -(Math.random() * speed + speed * 0.3),
        // Warm-neutral projector dust. Was violet (265) and cyan (190) at 90%
        // saturation, which read as sci-fi rather than as a lit room.
        a: Math.random() * 0.28 + 0.06,
        hue: 38,
      }));
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = rect.width;
      height = rect.height;
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      seed();
    };

    const draw = () => {
      ctx.clearRect(0, 0, width, height);
      for (const d of dots) {
        d.x += d.vx;
        d.y += d.vy;
        if (d.y < -10) {
          d.y = height + 10;
          d.x = Math.random() * width;
        }
        if (d.x < -10) d.x = width + 10;
        if (d.x > width + 10) d.x = -10;

        ctx.beginPath();
        ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        // No shadow: a glow on every mote is what made this read as an effect.
        ctx.fillStyle = `hsla(${d.hue}, 24%, 88%, ${d.a})`;
        ctx.fill();
      }
      if (running) raf = requestAnimationFrame(draw);
    };

    const onVisibility = () => {
      running = !document.hidden;
      if (running) raf = requestAnimationFrame(draw);
      else cancelAnimationFrame(raf);
    };

    resize();
    raf = requestAnimationFrame(draw);
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [density, speed]);

  return <canvas ref={canvasRef} aria-hidden className={cn('cv-particles absolute inset-0 h-full w-full', className)} />;
}

/* ==========================================================================
   Ambient stack — the standard background for full-page routes.
   ========================================================================== */

/**
 * The standard background for full-page routes.
 *
 * Was six simultaneous layers — aurora, canvas particles, a cursor-following
 * spotlight, grain, a page-wide vignette and a horizon rule. Stacked, they read
 * as an interactive visual effect competing with the content; a cinema should
 * read as a dark room you stopped noticing.
 *
 * Now two: one restrained warm field, plus the grain that `Aurora` already
 * carries as texture.
 *
 *  - Spotlight removed. A light that chases the cursor is a landing-page trick,
 *    and it ran a rAF loop for the whole session.
 *  - Particles off by default. `withParticles` is kept so callers still compile
 *    and can opt in; the dust is now warm-neutral, not purple and cyan.
 *  - Page-wide vignette removed: it darkened functional UI. The room keeps its
 *    own vignette around the player, which is where it belongs.
 *  - Horizon rule removed — decoration standing in for hierarchy.
 *
 * `Spotlight` and `Particles` remain exported; nothing about their API changed.
 */
export function AmbientBackdrop({ withParticles = false }: { withParticles?: boolean }) {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-ink-900">
      <Aurora />
      {withParticles && <Particles />}
    </div>
  );
}
