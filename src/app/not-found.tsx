import Link from 'next/link';
import { AmbientBackdrop } from '@/components/fx/Ambient';
import { Button } from '@/components/ui/Button';

export default function NotFound() {
  return (
    <>
      <AmbientBackdrop />
      <main id="main" className="grid min-h-dvh place-items-center px-5 text-center">
        <div>
          <p className="font-mono text-eyebrow uppercase text-white/30">Error 404</p>
          <h1 className="mt-5 font-display text-display-lg text-gradient balance">This reel does not exist</h1>
          <p className="mx-auto mt-5 max-w-sm text-[0.9375rem] leading-relaxed text-white/45 pretty">
            The page you were looking for is not here. The room you wanted might have closed — rooms
            disappear once everybody leaves.
          </p>
          <div className="mt-9 flex flex-col justify-center gap-3 sm:flex-row">
            <Link href="/">
              <Button variant="primary" size="lg" className="w-full sm:w-auto">
                Back to the lobby
              </Button>
            </Link>
            <Link href="/join">
              <Button variant="glass" size="lg" className="w-full sm:w-auto">
                Join with a code
              </Button>
            </Link>
          </div>
        </div>
      </main>
    </>
  );
}
