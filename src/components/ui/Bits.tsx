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
          style={{ boxShadow: `0 0 0 2px ${color}` }}
        />
      )}
      <span
        className="grid h-full w-full place-items-center rounded-full font-semibold text-black/85"
        style={{
          fontSize: size * 0.38,
          background: `linear-gradient(140deg, ${color}, ${color}99)`,
          boxShadow: `0 0 0 1px rgba(255,255,255,0.14), 0 6px 20px -6px ${color}aa`,
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
}: {
  children: React.ReactNode;
  tone?: 'neutral' | 'royal' | 'electric' | 'success' | 'warn' | 'danger';
  className?: string;
}) {
  const tones = {
    neutral: 'bg-white/[0.07] text-white/70 border-white/10',
    royal: 'bg-royal-500/15 text-royal-200 border-royal-500/30',
    electric: 'bg-electric-500/15 text-electric-300 border-electric-500/30',
    success: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
    warn: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
    danger: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  } as const;

  return (
    <span
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
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <span className="min-w-0">
        <span className="block text-sm font-medium text-white">{label}</span>
        {description && <span className="mt-0.5 block text-xs leading-relaxed text-white/45 pretty">{description}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-all duration-400 ease-glide',
          checked
            ? 'bg-[linear-gradient(100deg,#7c3aed,#22d3ee)] shadow-[0_0_18px_-2px_rgba(124,58,237,0.7)]'
            : 'bg-white/12 border border-white/12',
        )}
      >
        <motion.span
          layout
          transition={{ type: 'spring', stiffness: 550, damping: 34 }}
          className={cn(
            'absolute top-1/2 block h-4.5 w-4.5 -translate-y-1/2 rounded-full bg-white shadow-md',
            checked ? 'left-[calc(100%-1.375rem)]' : 'left-[0.1875rem]',
          )}
          style={{ height: 18, width: 18 }}
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
}: {
  value: T;
  onChange: (next: T) => void;
  options: { value: T; label: React.ReactNode; icon?: React.ReactNode }[];
  size?: 'sm' | 'md';
  className?: string;
}) {
  const groupId = React.useId();
  return (
    <div
      role="tablist"
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
              size === 'sm' ? 'h-8 px-3 text-xs' : 'h-10 px-4 text-[0.8125rem]',
              active ? 'text-white' : 'text-white/50 hover:text-white/80',
            )}
          >
            {active && (
              <motion.span
                layoutId={`seg-${groupId}`}
                transition={{ type: 'spring', stiffness: 400, damping: 32 }}
                className="absolute inset-0 rounded-xl bg-white/10 shadow-inner-hairline"
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
              'glass-deep text-[0.6875rem] font-medium text-white/90',
              positions[side],
            )}
          >
            {label}
            {shortcut && (
              <kbd className="rounded-md border border-white/15 bg-white/10 px-1.5 py-0.5 font-mono text-[0.625rem] text-white/70">
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
        <div className="mb-5 grid h-14 w-14 place-items-center rounded-2xl glass-soft text-white/40">{icon}</div>
      )}
      <h3 className="font-display text-lg font-semibold text-white">{title}</h3>
      {body && <p className="mt-2 max-w-sm text-sm leading-relaxed text-white/45 pretty">{body}</p>}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}
