'use client';

import * as React from 'react';
import {
  motion,
  useMotionTemplate,
  useMotionValue,
  useSpring,
  useTransform,
  type HTMLMotionProps,
} from 'framer-motion';
import { cn } from '@/lib/utils';

export interface GlassCardProps extends Omit<HTMLMotionProps<'div'>, 'ref' | 'children'> {
  children?: React.ReactNode;
  /** Card tilts toward the cursor and a highlight follows it. */
  interactive?: boolean;
  /** Animated conic border on hover. */
  glow?: boolean;
  tone?: 'default' | 'deep' | 'soft';
  tiltStrength?: number;
}

const TONES = {
  default: 'glass',
  deep: 'glass-deep',
  soft: 'glass-soft',
} as const;

/**
 * The workhorse surface. On pointer devices it tilts a few degrees toward the
 * cursor and carries a soft specular highlight, which is what sells the
 * "pane of real glass" impression without costing a re-render — everything
 * rides on motion values.
 */
export function GlassCard({
  className,
  interactive = false,
  glow = false,
  tone = 'default',
  tiltStrength = 6,
  children,
  onMouseMove,
  onMouseLeave,
  ...props
}: GlassCardProps) {
  const px = useMotionValue(0.5);
  const py = useMotionValue(0.5);

  const rotateX = useSpring(useMotionValue(0), { stiffness: 220, damping: 22 });
  const rotateY = useSpring(useMotionValue(0), { stiffness: 220, damping: 22 });

  const hx = useTransform(px, (v) => `${(v * 100).toFixed(2)}%`);
  const hy = useTransform(py, (v) => `${(v * 100).toFixed(2)}%`);
  const highlight = useMotionTemplate`radial-gradient(420px circle at ${hx} ${hy}, rgba(255,255,255,0.10), transparent 60%)`;

  const handleMove = (event: React.MouseEvent<HTMLDivElement>) => {
    onMouseMove?.(event);
    if (!interactive) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    px.set(x);
    py.set(y);
    rotateY.set((x - 0.5) * tiltStrength * 2);
    rotateX.set((0.5 - y) * tiltStrength * 2);
  };

  const handleLeave = (event: React.MouseEvent<HTMLDivElement>) => {
    onMouseLeave?.(event);
    if (!interactive) return;
    rotateX.set(0);
    rotateY.set(0);
    px.set(0.5);
    py.set(0.5);
  };

  return (
    <motion.div
      onMouseMove={handleMove}
      onMouseLeave={handleLeave}
      style={interactive ? { rotateX, rotateY, transformPerspective: 1200 } : undefined}
      className={cn(
        'relative overflow-hidden rounded-3xl glass-lit',
        TONES[tone],
        glow && 'gradient-border',
        className,
      )}
      {...props}
    >
      {interactive && (
        <motion.span
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-500 group-hover:opacity-100"
          style={{ background: highlight }}
        />
      )}
      {children}
    </motion.div>
  );
}
