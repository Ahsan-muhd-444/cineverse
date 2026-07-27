'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/Button';

export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error(error);
  }, [error]);

  return (
    <main className="grid min-h-dvh place-items-center bg-ink-900 px-5 text-center">
      <div>
        <p className="font-mono text-eyebrow uppercase text-white/30">Something broke</p>
        <h1 className="mt-5 font-display text-display-md text-white balance">The projector jammed</h1>
        <p className="mx-auto mt-4 max-w-sm text-[0.9375rem] leading-relaxed text-white/45 pretty">
          An unexpected error interrupted the session. Trying again usually clears it.
        </p>
        <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
          <Button variant="primary" size="lg" onClick={reset}>
            Try again
          </Button>
          <Link href="/">
            <Button variant="glass" size="lg" className="w-full sm:w-auto">
              Back to the lobby
            </Button>
          </Link>
        </div>
      </div>
    </main>
  );
}
