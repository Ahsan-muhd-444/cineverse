'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

/* ==========================================================================
   Aurora — slow drifting colour fields behind everything.
   Pure CSS animation so it costs nothing on the main thread.
   ========================================================================== */

export function Aurora({ className, intensity = 1 }: { className?: string; intensity?: number }) {
  const blobs = React.useMemo(
    () => [
      { color: 'rgba(124,58,237,0.55)', size: '52vw', top: '-14%', left: '-8%', delay: '0s', duration: '24s' },
      { color: 'rgba(34,211,238,0.34)', size: '44vw', top: '18%', left: '58%', delay: '-7s', duration: '29s' },
      { color: 'rgba(59,108,246,0.42)', size: '48vw', top: '52%', left: '6%', delay: '-13s', duration: '26s' },
      { color: 'rgba(244,114,182,0.20)', size: '34vw', top: '66%', left: '62%', delay: '-4s', duration: '32s' },
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
            opacity: 0.75 * intensity,
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
        a: Math.random() * 0.5 + 0.12,
        hue: Math.random() > 0.6 ? 265 : 190,
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
        ctx.fillStyle = `hsla(${d.hue}, 90%, 78%, ${d.a})`;
        ctx.shadowBlur = 8;
        ctx.shadowColor = `hsla(${d.hue}, 90%, 70%, ${d.a * 0.8})`;
        ctx.fill();
      }
      ctx.shadowBlur = 0;
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

export function AmbientBackdrop({ withParticles = true }: { withParticles?: boolean }) {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-ink-900">
      <Aurora />
      {withParticles && <Particles />}
      <Spotlight />
      <div className="absolute inset-0 vignette" />
      {/* A faint horizon line keeps the black from reading as empty */}
      <div className="absolute inset-x-0 top-[62%] h-px bg-gradient-to-r from-transparent via-white/[0.07] to-transparent" />
    </div>
  );
}
