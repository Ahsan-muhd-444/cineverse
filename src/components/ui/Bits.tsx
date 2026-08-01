'use client';

import * as React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Check } from 'lucide-react';
import { cn, initials } from '@/lib/utils';

/* ------------------------------------------------------------------ Skeleton */

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn('skeleton rounded-2xl', className)} />;
}

export function PosterSkeleton() {
  return (
    <div className="w-[168px] shrink-0 sm:w-[196px]">
      <Skeleton className="aspect-[2/3] w-full rounded-3xl" />
      <Skeleton className="mt-3 h-3.5 w-4/5 rounded-full" />
      <Skeleton className="mt-2 h-3 w-2/5 rounded-full" />
    </div>
  );
}

/* -------------------------------------------------------------------- Avatar */

export function Avatar({
  name,
  color = '#8b5cf6',
  size = 36,
  online,
  speaking,
  className,
}: {
  name: string;
  color?: string;
  size?: number;
  online?: boolean;
  speaking?: boolean;
  className?: string;
}) {
  return (
    <span className={cn('relative inline-flex shrink-0', className)} style={{ width: size, height: size }}>
      {speaking && (
        <span
          aria-hidden
          className="absolute inset-0 animate-pulse-ring rounded-full"
          // Speaking stays identifiable by the ring's motion and the member's
          // own colour, at a weight that does not read as neon.
          style={{ boxShadow: `0 0 0 2px ${color}cc` }}
        />
      )}
      <span
        // Full black rather than black/85: against the flat identity fill the
        // softened version measured 4.43:1, just under AA for this text size.
        className="grid h-full w-full place-items-center rounded-full font-semibold text-black"
        style={{
          fontSize: size * 0.38,
          // Identity colour stays the fill — it is how you tell people apart —
          // but flat and slightly muted rather than a saturated gradient, and
          // the coloured drop shadow is gone. Only a neutral hairline remains,
          // so a row of avatars no longer glows in six directions.
          backgroundColor: color,
          boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.18), 0 0 0 1px rgba(0,0,0,0.55)',
        }}
      >
        {initials(name) || '?'}
      </span>
      {online !== undefined && (
        <span
          aria-label={online ? 'Online' : 'Offline'}
          className={cn(
            'absolute -bottom-0.5 -right-0.5 rounded-full border-2 border-ink-900 transition-colors',
            online ? 'bg-emerald-400' : 'bg-white/25',
          )}
          style={{ width: size * 0.3, height: size * 0.3 }}
        />
      )}
    </span>
  );
}

/* --------------------------------------------------------------------- Badge */

export function Badge({
  children,
  tone = 'neutral',
  className,
  ...rest
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'royal' | 'gold' | 'electric' | 'success' | 'warn' | 'danger';
  className?: string;
} & React.HTMLAttributes<HTMLSpanElement>) {
  const tones = {
    neutral: 'bg-white/[0.07] text-secondary border-white/10',
    // Premium / selected label.
    gold: 'bg-gold-400/12 text-gold-300 border-gold-400/30',
    // `royal` is retained as a name so existing callers compile, but it now
    // renders the gold treatment — purple is no longer a product accent.
    royal: 'bg-gold-400/12 text-gold-300 border-gold-400/30',
    // KEPT CYAN — and only legitimate when the badge means live / syncing /
    // connected. Anything meaning merely "new" or "selected" should use `gold`.
    electric: 'bg-electric-500/15 text-electric-300 border-electric-500/30',
    success: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    warn: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
    danger: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  } as const;

  return (
    <span
      {...rest}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[0.6875rem] font-medium leading-none tracking-wide',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/* -------------------------------------------------------------------- Switch */

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-start justify-between gap-4 rounded-2xl px-1 py-2.5',
        // Disabled dims the CONTROL, never the row: blanket opacity made the
        // label and description unreadable, which is exactly the text a user
        // needs in order to understand why the setting is unavailable.
        disabled && 'cursor-not-allowed',
      )}
    >
      <span className="min-w-0">
        <span className="block text-sm font-medium text-primary">{label}</span>
        {/* A setting's description explains what the toggle does — informational,
            so it moves off 0.45 (4.49:1, just under AA) to the supporting tier. */}
        {description && <span className="mt-0.5 block text-xs leading-relaxed text-supporting pretty">{description}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors duration-[160ms] ease-swift',
          // The hairline is a RING, not a border. A border would shrink the
          // padding box the knob is positioned against, so a 3px inset would
          // render as 4px on two sides and 3px on the others. `ring-inset` is a
          // box-shadow: it paints the same hairline and costs no layout, which
          // is what keeps the knob's four insets identical and the travel a
          // round 20px.
          'ring-1 ring-inset',
          // The CONTROL state is a product state, so the track is gold whatever
          // the setting happens to govern. Cyan belongs to the resulting live
          // status shown elsewhere, never to the switch itself.
          checked ? 'bg-gold-500 ring-gold-400' : 'bg-white/[0.06] ring-white/15',
          // Unavailable is carried by the track and knob — a quieter surface,
          // a quieter hairline and no pointer — not by fading the whole setting.
          disabled && 'cursor-not-allowed !bg-white/[0.03] !ring-white/10',
        )}
      >
        {/*
          Deterministic geometry, no layout animation.

          This knob used to be a `motion.span` with `layout` + a spring, wearing
          `top-1/2 -translate-y-1/2`. Framer writes its own `transform` while a
          layout animation runs, which CLOBBERS the `-translate-y-1/2` that was
          doing the vertical centring — so the knob dropped half its height and
          read as a detached dot floating on the gold capsule.

          Fixed inset instead: 18px knob, 3px from the top and left, and the ONLY
          transform is the horizontal one. 44 - 3 - 18 - 3 = 20px of travel, so
          the off/on insets mirror exactly and nothing can move vertically.
        */}
        <span
          aria-hidden
          className={cn(
            'pointer-events-none absolute left-[3px] top-[3px] block h-[18px] w-[18px] rounded-full',
            'transition-transform duration-[160ms] ease-swift',
            checked ? 'translate-x-[20px]' : 'translate-x-0',
            // Warm white in BOTH states — a black knob on gold read as a hole
            // punched in the track rather than a control. On gold the knob keeps
            // its own dark hairline so the boundary, not the fill, carries the
            // separation; on the dark off-track the warm white already clears it.
            disabled ? 'bg-white/35' : 'bg-[#F7F3EA] shadow-sm',
            checked && !disabled && 'ring-1 ring-inset ring-ink-950/60',
          )}
        />
      </button>
    </label>
  );
}

/* ----------------------------------------------------------------- Segmented */

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = 'md',
  className,
  label,
}: {
  value: T;
  onChange: (next: T) => void;
  options: { value: T; label: React.ReactNode; icon?: React.ReactNode }[];
  size?: 'sm' | 'md';
  className?: string;
  /** Names the group itself — without it a tablist is announced as an
   *  unlabelled set of tabs, which says nothing about what it switches. */
  label?: string;
}) {
  const groupId = React.useId();
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn('relative inline-flex items-center gap-1 rounded-2xl p-1 glass-soft', className)}
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(option.value)}
            className={cn(
              'relative inline-flex items-center gap-1.5 rounded-xl font-medium transition-colors duration-300',
              // 44px minimum interactive height (project standard). The
              // visible active pill stays compact via inset-y, so the control
              // keeps its density while the target is thumb-sized.
              size === 'sm' ? 'h-11 px-3 text-xs' : 'h-11 px-4 text-[0.8125rem]',
              // Inactive reads as secondary, hover lifts to primary — the
              // restrained hierarchy, no colour required.
              active ? 'text-primary' : 'text-secondary hover:text-primary',
            )}
          >
            {active && (
              <motion.span
                layoutId={`seg-${groupId}`}
                transition={{ type: 'spring', stiffness: 400, damping: 32 }}
                // A neutral surface plus a small gold marker underneath, rather
                // than a filled gold tab: the accent points at the selection
                // instead of becoming it.
                className="absolute inset-y-1.5 inset-x-0 rounded-xl bg-white/[0.08] shadow-inner-hairline after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full after:bg-gold-400"
              />
            )}
            <span className="relative z-10 inline-flex items-center gap-1.5">
              {option.icon}
              {option.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------- Tooltip */

export function Tooltip({
  label,
  children,
  side = 'top',
  shortcut,
}: {
  label: string;
  children: React.ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
  shortcut?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const positions = {
    top: 'bottom-full left-1/2 -translate-x-1/2 mb-2.5',
    bottom: 'top-full left-1/2 -translate-x-1/2 mt-2.5',
    left: 'right-full top-1/2 -translate-y-1/2 mr-2.5',
    right: 'left-full top-1/2 -translate-y-1/2 ml-2.5',
  } as const;

  return (
    <span
      className="relative inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      <AnimatePresence>
        {open && (
          <motion.span
            role="tooltip"
            initial={{ opacity: 0, scale: 0.94, y: side === 'top' ? 4 : -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className={cn(
              'pointer-events-none absolute z-50 flex items-center gap-2 whitespace-nowrap rounded-xl px-2.5 py-1.5',
              // A tooltip is a floating surface, not an overlay: elevation 3.
              // This is the first consumer of `elev-float`, which was defined
              // in the foundation pass but had nothing assigned to it.
              'elev-float text-[0.6875rem] font-medium text-primary',
              positions[side],
            )}
          >
            {label}
            {shortcut && (
              <kbd className="rounded-md border border-white/15 bg-white/10 px-1.5 py-0.5 font-mono text-[0.625rem] text-secondary">
                {shortcut}
              </kbd>
            )}
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}

/* --------------------------------------------------------------------- Toast */

type Toast = { id: number; message: string; tone: 'default' | 'success' | 'error' };

const ToastContext = React.createContext<(message: string, tone?: Toast['tone']) => void>(() => {});

export const useToast = () => React.useContext(ToastContext);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<Toast[]>([]);

  const push = React.useCallback((message: string, tone: Toast['tone'] = 'default') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3600);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed inset-x-0 bottom-6 z-[200] flex flex-col items-center gap-2 px-4"
      >
        <AnimatePresence initial={false}>
          {toasts.map((toast) => (
            <motion.div
              key={toast.id}
              layout
              initial={{ opacity: 0, y: 24, scale: 0.94 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 12, scale: 0.96 }}
              transition={{ type: 'spring', stiffness: 400, damping: 32 }}
              className={cn(
                'pointer-events-auto flex items-center gap-2.5 rounded-2xl px-4 py-3 text-sm glass-deep',
                toast.tone === 'success' && 'text-emerald-200',
                toast.tone === 'error' && 'text-rose-200',
              )}
            >
              {toast.tone === 'success' && <Check size={15} className="shrink-0" />}
              {toast.message}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

/* ------------------------------------------------------------- Empty / Error */

export function EmptyState({
  icon,
  title,
  body,
  action,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  body?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-16 text-center', className)}>
      {icon && (
        <div className="mb-5 grid h-14 w-14 place-items-center rounded-2xl glass-soft text-decorative">{icon}</div>
      )}
      <h3 className="font-display text-lg font-semibold text-white">{title}</h3>
      {body && <p className="mt-2 max-w-sm text-sm leading-relaxed text-supporting pretty">{body}</p>}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}
