import Link from 'next/link';
import { AmbientBackdrop } from '@/components/fx/Ambient';
import { buttonClasses } from '@/components/ui/buttonStyles';

export default function NotFound() {
  return (
    <>
      <AmbientBackdrop />
      <main id="main" className="grid min-h-dvh place-items-center px-5 text-center">
        <div>
          <p className="font-mono text-eyebrow uppercase text-muted">Error 404</p>
          <h1 className="mt-5 font-display text-display-lg text-primary balance">This reel does not exist</h1>
          <p className="mx-auto mt-5 max-w-sm text-[0.9375rem] leading-relaxed text-supporting pretty">
            The page you were looking for is not here. The room you wanted might have closed — rooms
            disappear once everybody leaves.
          </p>
          <div className="mt-9 flex flex-col justify-center gap-3 sm:flex-row">
            <Link href="/" className={buttonClasses({ variant: 'primary', size: 'lg', className: 'w-full sm:w-auto' })}>
              Back to the lobby
            </Link>
            <Link href="/join" className={buttonClasses({ variant: 'glass', size: 'lg', className: 'w-full sm:w-auto' })}>
              Join with a code
            </Link>
          </div>
        </div>
      </main>
    </>
  );
}
