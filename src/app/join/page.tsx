import type { Metadata } from 'next';
import Link from 'next/link';
import { AmbientBackdrop } from '@/components/fx/Ambient';
import { Header } from '@/components/layout/Header';
import { Launchpad } from '@/components/home/Launchpad';

export const metadata: Metadata = {
  title: 'Join a room',
  description: 'Enter a six-character room code and take your seat.',
};

export default function JoinPage() {
  return (
    <>
      <AmbientBackdrop />
      <Header />

      <main id="main" className="grid min-h-dvh place-items-center px-5 py-32">
        <div className="w-full max-w-lg">
          <div className="mb-9 text-center">
            <h1 className="font-display text-display-md text-primary balance">Take your seat</h1>
            <p className="mx-auto mt-4 max-w-sm text-[0.9375rem] leading-relaxed text-supporting pretty">
              Enter the six characters they sent you. If they shared a link instead, just open it —
              it does this part for you.
            </p>
          </div>

          <Launchpad initialMode="join" />

          <p className="mt-8 text-center text-sm text-supporting">
            Nobody sent you a code?{' '}
            {/* Gold, not cyan — this is a product action, and the 44px minimum
                comes from the link itself rather than a wrapper. */}
            <Link
              href="/#launchpad"
              className="inline-flex min-h-11 items-center px-1 font-medium text-gold-400 underline-offset-4 hover:underline"
            >
              Open your own room
            </Link>
          </p>
        </div>
      </main>
    </>
  );
}
