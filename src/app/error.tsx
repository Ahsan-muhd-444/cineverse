'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { Button, buttonClasses } from '@/components/ui/Button';

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error(error);
  }, [error]);

  return (
    <main className="grid min-h-dvh place-items-center bg-ink-900 px-5 text-center">
      <div>
        {/* Rose eyebrow: restrained, and it genuinely denotes an error state. */}
        <p className="font-mono text-eyebrow uppercase text-rose-300">Something broke</p>
        <h1 className="mt-5 font-display text-display-md text-primary balance">The projector jammed</h1>
        <p className="mx-auto mt-4 max-w-sm text-[0.9375rem] leading-relaxed text-supporting pretty">
          An unexpected error interrupted the session. Trying again usually clears it.
        </p>
        <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
          {/* Reset is a real action, so it stays a button. Navigation is a link. */}
          <Button variant="primary" size="lg" onClick={reset}>
            Try again
          </Button>
          <Link href="/" className={buttonClasses({ variant: 'glass', size: 'lg', className: 'w-full sm:w-auto' })}>
            Back to the lobby
          </Link>
        </div>
      </div>
    </main>
  );
}
