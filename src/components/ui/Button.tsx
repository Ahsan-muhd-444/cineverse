'use client';

import * as React from 'react';
import { motion, type HTMLMotionProps } from 'framer-motion';
import { cn } from '@/lib/utils';

type Variant = 'primary' | 'glass' | 'ghost' | 'outline' | 'danger';
type Size = 'sm' | 'md' | 'lg' | 'icon' | 'icon-sm';

const VARIANTS: Record<Variant, string> = {
  primary:
    'text-white bg-[linear-gradient(115deg,#7c3aed_0%,#3b6cf6_52%,#22d3ee_100%)] bg-[length:200%_auto] shadow-[0_12px_40px_-12px_rgba(124,58,237,0.75)] hover:bg-[position:right_center] hover:shadow-[0_18px_54px_-12px_rgba(59,108,246,0.8)]',
  glass:
    'text-white glass hover:border-white/20 hover:bg-white/[0.09]',
  ghost: 'text-white/70 hover:text-white hover:bg-white/[0.07]',
  outline: 'text-white border border-white/15 hover:border-white/35 hover:bg-white/[0.05]',
  danger:
    'text-white bg-[linear-gradient(115deg,#e11d48,#fb7185)] shadow-[0_12px_40px_-14px_rgba(225,29,72,0.8)]',
};

const SIZES: Record<Size, string> = {
  sm: 'h-9 px-4 text-[0.8125rem] rounded-xl gap-1.5',
  md: 'h-11 px-5 text-sm rounded-2xl gap-2',
  lg: 'h-14 px-8 text-[0.9375rem] rounded-2xl gap-2.5',
  icon: 'h-11 w-11 rounded-2xl',
  'icon-sm': 'h-9 w-9 rounded-xl',
};

export interface ButtonProps extends Omit<HTMLMotionProps<'button'>, 'ref' | 'children'> {
  children?: React.ReactNode;
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  /** Sweep a light across the surface on hover. Free on primary, opt-in elsewhere. */
  sheen?: boolean;
}

/**
 * The one button. Every press gets a spring, a ripple from the click point,
 * and (optionally) a sheen — so interactions feel physical rather than instant.
 */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'glass', size = 'md', loading, sheen, children, disabled, onPointerDown, ...props },
  ref,
) {
  const [ripples, setRipples] = React.useState<{ id: number; x: number; y: number }[]>([]);

  const handlePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const id = Date.now() + Math.random();
    setRipples((r) => [...r, { id, x: event.clientX - rect.left, y: event.clientY - rect.top }]);
    window.setTimeout(() => setRipples((r) => r.filter((item) => item.id !== id)), 620);
    onPointerDown?.(event);
  };

  const showSheen = sheen ?? variant === 'primary';

  return (
    <motion.button
      ref={ref}
      whileTap={disabled || loading ? undefined : { scale: 0.965 }}
      transition={{ type: 'spring', stiffness: 520, damping: 30, mass: 0.6 }}
      onPointerDown={handlePointerDown}
      disabled={disabled || loading}
      className={cn(
        'group/btn relative isolate inline-flex select-none items-center justify-center overflow-hidden font-medium',
        'transition-[background,border-color,box-shadow,color,transform] duration-500 ease-glide',
        'disabled:pointer-events-none disabled:opacity-45',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    >
      {showSheen && (
        <span className="pointer-events-none absolute inset-0 -z-10 overflow-hidden rounded-[inherit]">
          <span className="absolute inset-y-0 -left-1/3 w-1/3 bg-white/25 blur-md opacity-0 transition-opacity duration-200 group-hover/btn:animate-sheen group-hover/btn:opacity-100" />
        </span>
      )}

      {ripples.map((r) => (
        <span
          key={r.id}
          aria-hidden
          className="pointer-events-none absolute -z-10 h-4 w-4 animate-[pulse-ring_620ms_ease-out_forwards] rounded-full bg-white/35"
          style={{ left: r.x - 8, top: r.y - 8 }}
        />
      ))}

      {loading && (
        <span
          aria-hidden
          className="mr-0.5 h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-white/25 border-t-white"
        />
      )}
      {children}
    </motion.button>
  );
});
