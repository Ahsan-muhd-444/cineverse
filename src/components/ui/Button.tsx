'use client';

import * as React from 'react';
import { motion, type HTMLMotionProps } from 'framer-motion';
import { cn } from '@/lib/utils';
import {
  BUTTON_SIZES,
  BUTTON_VARIANTS,
  buttonClasses,
  type ButtonSize as Size,
  type ButtonVariant as Variant,
} from './buttonStyles';

// Re-exported so existing import sites keep working. The definition lives in
// a non-client module because SERVER components import it too — see
// buttonStyles.ts for why that distinction is load-bearing.
export { buttonClasses };
export type { ButtonVariant, ButtonSize } from './buttonStyles';

export interface ButtonProps extends Omit<HTMLMotionProps<'button'>, 'ref' | 'children'> {
  children?: React.ReactNode;
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  /** Sweep a light across the surface on hover. Free on primary, opt-in elsewhere. */
  sheen?: boolean;
}

/**
 * The one button. Press feedback is a 1px settle over 120ms — enough to confirm
 * the press, quiet enough that a page of controls stays calm.
 */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'glass', size = 'md', loading, sheen, children, disabled, onPointerDown, ...props },
  ref,
) {
  // `sheen` is still accepted so no caller breaks, but the hover light-sweep is
  // gone: a shine travelling across a control on every hover is showroom
  // behaviour, and it fired on the primary action by default.
  void sheen;

  return (
    <motion.button
      ref={ref}
      // Was `scale: 0.965` on a spring (stiffness 520, mass 0.6) — a visible
      // compression that made every control feel like a game button, plus a
      // click ripple that mounted DOM nodes and set a 620ms timeout per press.
      // A 1px settle is enough to confirm the press.
      whileTap={disabled || loading ? undefined : { y: 1 }}
      transition={{ duration: 0.12, ease: [0.2, 0, 0, 1] }}
      onPointerDown={onPointerDown}
      disabled={disabled || loading}
      className={cn(
        'group/btn relative isolate inline-flex select-none items-center justify-center overflow-hidden font-medium',
        // 500ms is a page transition, not a control response. 160ms reads as
        // immediate while still being visibly eased.
        'transition-[background,border-color,box-shadow,color,transform] duration-[160ms] ease-swift',
        'disabled:pointer-events-none disabled:opacity-45',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
      {...props}
    >
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
