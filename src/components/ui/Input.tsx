'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

export interface FieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string | null;
  icon?: React.ReactNode;
  trailing?: React.ReactNode;
}

export const Input = React.forwardRef<HTMLInputElement, FieldProps>(function Input(
  { className, label, hint, error, icon, trailing, id, ...props },
  ref,
) {
  const reactId = React.useId();
  const inputId = id || reactId;
  const describedBy = error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined;

  return (
    <div className="w-full">
      {label && (
        <label htmlFor={inputId} className="mb-2 block text-[0.8125rem] font-medium text-secondary">
          {label}
        </label>
      )}

      <div
        className={cn(
          'group relative flex items-center gap-3 rounded-2xl px-4',
          // Inset surface, neutral border at rest, stronger neutral on hover.
          'glass-soft transition-colors duration-[160ms] ease-swift hover:border-white/20',
          // The WRAPPER must show the field is unavailable, not just the value.
          // Relational selector, so no prop or handler changes: quieter border,
          // flatter surface, no hover strengthening and no gold focus.
          'has-[:disabled]:cursor-not-allowed has-[:disabled]:border-white/[0.06]',
          'has-[:disabled]:bg-white/[0.015] has-[:disabled]:hover:border-white/[0.06]',
          'has-[:disabled]:focus-within:border-white/[0.06]',
          // Focus reads through BORDER and RING contrast, not a coloured bloom.
          // Was a royal-purple outer glow plus a cyan icon; cyan now means
          // "live" and nothing else, so form focus is gold.
          'focus-within:border-gold-400/70',
          error && 'border-rose-400/55 focus-within:border-rose-400/80',
        )}
      >
        {icon && <span className="shrink-0 text-muted transition-colors group-focus-within:text-gold-400">{icon}</span>}
        <input
          ref={ref}
          id={inputId}
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={describedBy}
          className={cn(
            'h-12 w-full bg-transparent text-[0.9375rem] text-primary outline-none',
            // Placeholder raised from 0.30 (2.6:1 — unreadable) to the muted
            // tier at 5.3:1. A placeholder is informational.
            'placeholder:text-muted',
            // Disabled must not rely on opacity alone: the value stays legible
            // and the surface communicates the state instead.
            'disabled:cursor-not-allowed disabled:text-supporting',
            className,
          )}
          {...props}
        />
        {trailing && <span className="shrink-0">{trailing}</span>}
      </div>

      {error ? (
        <p id={`${inputId}-error`} role="alert" className="mt-2 text-xs text-rose-300">
          {error}
        </p>
      ) : hint ? (
        // Hint text carries instructions, so it takes an informational tier
        // (was 0.40 — 3.76:1, below AA).
        <p id={`${inputId}-hint`} className="mt-2 text-xs text-supporting">
          {hint}
        </p>
      ) : null}
    </div>
  );
});

/** Six big glass slots — the room code deserves to feel like an event. */
export function CodeInput({
  value,
  onChange,
  length = 6,
  autoFocus,
  'aria-label': ariaLabel = 'Room code',
}: {
  value: string;
  onChange: (next: string) => void;
  length?: number;
  autoFocus?: boolean;
  'aria-label'?: string;
}) {
  const ref = React.useRef<HTMLInputElement>(null);
  const [focused, setFocused] = React.useState(false);
  const chars = value.padEnd(length, ' ').slice(0, length).split('');

  return (
    <div
      className="relative"
      onClick={() => ref.current?.focus()}
      role="presentation"
    >
      <input
        ref={ref}
        value={value}
        autoFocus={autoFocus}
        aria-label={ariaLabel}
        inputMode="text"
        autoCapitalize="characters"
        autoComplete="off"
        spellCheck={false}
        maxLength={length}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) => onChange(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, length))}
        className="absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0"
      />
      <div className="flex gap-2 sm:gap-2.5">
        {chars.map((char, i) => {
          const active = focused && i === Math.min(value.length, length - 1);
          return (
            <div
              key={i}
              className={cn(
                'relative flex h-14 flex-1 items-center justify-center rounded-2xl font-display text-2xl font-semibold tabular-nums sm:h-16 sm:text-3xl',
                // Only colour and border actually change; `transition-all` also
                // animated layout properties on every keystroke.
                'transition-[color,background-color,border-color] duration-[160ms] ease-swift',
                'glass-soft',
                // The empty placeholder dot is decoration; the typed character
                // is the value and must be fully legible.
                char.trim() ? 'text-primary' : 'text-decorative',
                // Selection is a product state, not a realtime one — gold.
                // Border and surface carry it; the outer cyan bloom is gone.
                active && 'border-gold-400/70 bg-white/[0.06]',
              )}
            >
              {char.trim() || '·'}
              {active && (
                <span className="absolute bottom-2 h-0.5 w-5 animate-pulse rounded-full bg-gold-400" />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
