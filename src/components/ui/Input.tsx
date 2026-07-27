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
        <label htmlFor={inputId} className="mb-2 block text-[0.8125rem] font-medium text-white/70">
          {label}
        </label>
      )}

      <div
        className={cn(
          'group relative flex items-center gap-3 rounded-2xl px-4',
          'glass-soft transition-all duration-400 ease-glide',
          'focus-within:border-white/25 focus-within:bg-white/[0.07] focus-within:shadow-glow-royal',
          error && 'border-rose-400/50 focus-within:shadow-[0_0_0_1px_rgba(251,113,133,0.5)]',
        )}
      >
        {icon && <span className="shrink-0 text-white/40 transition-colors group-focus-within:text-electric-400">{icon}</span>}
        <input
          ref={ref}
          id={inputId}
          aria-invalid={Boolean(error) || undefined}
          aria-describedby={describedBy}
          className={cn(
            'h-12 w-full bg-transparent text-[0.9375rem] text-white outline-none',
            'placeholder:text-white/30',
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
        <p id={`${inputId}-hint`} className="mt-2 text-xs text-white/40">
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
                'relative flex h-14 flex-1 items-center justify-center rounded-2xl font-display text-2xl font-semibold tabular-nums transition-all duration-300 ease-glide sm:h-16 sm:text-3xl',
                'glass-soft',
                char.trim() ? 'text-white' : 'text-white/20',
                active && 'border-electric-400/60 bg-white/[0.09] shadow-glow-electric',
              )}
            >
              {char.trim() || '·'}
              {active && (
                <span className="absolute bottom-2 h-0.5 w-5 animate-pulse rounded-full bg-electric-400" />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
