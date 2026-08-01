import { cn } from '@/lib/utils';

/**
 * The button's visual recipe, in its own module — deliberately WITHOUT
 * `'use client'`.
 *
 * `Button.tsx` is a client component. A server component (`not-found.tsx`,
 * `error.tsx`'s siblings, any static page) that imports a value from a client
 * module receives a client-reference proxy rather than the real export, so
 * calling it during server render throws
 * `buttonClasses is not a function` — a runtime crash TypeScript cannot see,
 * because the types are perfectly valid either way.
 *
 * Pure styling has no client-only needs, so it lives here and both worlds can
 * import it. `Button.tsx` re-exports it so existing import sites keep working.
 */

export type ButtonVariant = 'primary' | 'glass' | 'ghost' | 'outline' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'icon' | 'icon-sm';

export const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  // One solid warm gold with near-black type — 9.9:1, and the only filled
  // accent in the interface, so "primary" reads as primary without shouting.
  primary:
    'text-ink-950 bg-gold-500 hover:bg-gold-400 active:bg-gold-600 shadow-e-raised hover:shadow-e-float',
  glass: 'text-white glass hover:border-white/20 hover:bg-white/[0.09]',
  ghost: 'text-white/70 hover:text-white hover:bg-white/[0.07]',
  outline: 'text-white border border-white/15 hover:border-white/35 hover:bg-white/[0.05]',
  // A tinted error surface reads as clearly destructive next to the gold
  // primary, without the festive rose-to-pink gradient it replaced.
  danger:
    'text-rose-200 bg-rose-500/12 border border-rose-400/45 hover:bg-rose-500/20 hover:border-rose-400/70 hover:text-rose-100',
};

export const BUTTON_SIZES: Record<ButtonSize, string> = {
  sm: 'h-9 px-4 text-[0.8125rem] rounded-xl gap-1.5',
  md: 'h-11 px-5 text-sm rounded-2xl gap-2',
  lg: 'h-14 px-8 text-[0.9375rem] rounded-2xl gap-2.5',
  icon: 'h-11 w-11 rounded-2xl',
  'icon-sm': 'h-9 w-9 rounded-xl',
};

/**
 * Button styling for an element that is not a `<button>`.
 *
 * Navigation must be an anchor, but `<Link><Button/></Link>` nests one
 * interactive element inside another — invalid HTML, and keyboards and screen
 * readers disagree about what the control is. A `<Link>` wearing these classes
 * is one element with the right semantics and identical styling.
 */
export function buttonClasses({
  variant = 'glass',
  size = 'md',
  className,
}: { variant?: ButtonVariant; size?: ButtonSize; className?: string } = {}) {
  return cn(
    'group/btn relative isolate inline-flex select-none items-center justify-center overflow-hidden font-medium',
    'transition-[background,border-color,box-shadow,color,transform] duration-[160ms] ease-swift',
    'disabled:pointer-events-none disabled:opacity-45',
    BUTTON_VARIANTS[variant],
    BUTTON_SIZES[size],
    className,
  );
}
