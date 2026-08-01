import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { AmbientBackdrop } from '@/components/fx/Ambient';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { Hero } from '@/components/home/Hero';
import { Launchpad } from '@/components/home/Launchpad';
import { HowItWorks, Showcase } from '@/components/home/Showcase';
import { MovieRow } from '@/components/browse/MovieRow';
import { ROWS } from '@/lib/catalog';
import { buttonClasses } from '@/components/ui/buttonStyles';
import { RecommendedMovies } from '@/components/recommend/RecommendedMovies';

export default function HomePage() {
  return (
    <>
      <AmbientBackdrop />
      <Header />

      <main id="main">
        <Hero />

        {/* ---------- Launchpad ---------- */}
        <section id="launchpad" className="relative scroll-mt-24 py-20 sm:py-24">
          <div className="container">
            <div className="grid items-center gap-14 lg:grid-cols-[1fr_0.95fr] lg:gap-20">
              <div>
                <p className="text-eyebrow uppercase text-gold-400">The launchpad</p>
                <h2 className="mt-4 font-display text-display-lg text-primary balance">
                  Two seats. One playhead. Zero setup.
                </h2>
                <p className="mt-5 max-w-md text-[1.0625rem] leading-relaxed text-supporting pretty">
                  Create the room, send the link, and the next thing either of you touches is the
                  play button. Everything after that stays in step on its own.
                </p>

                <dl className="mt-10 grid max-w-md grid-cols-2 gap-x-6 gap-y-7">
                  {[
                    { k: 'Sync accuracy', v: '< 250 ms', d: 'Continuous drift correction' },
                    { k: 'Setup time', v: '~4 s', d: 'Name, create, share' },
                    { k: 'Accounts needed', v: 'None', d: 'Nothing stored server-side' },
                    { k: 'Room lifetime', v: 'Yours', d: 'Gone when you both leave' },
                  ].map((stat) => (
                    <div key={stat.k}>
                      <dt className="text-eyebrow uppercase text-muted">{stat.k}</dt>
                      <dd className="mt-2 font-display text-2xl font-semibold text-primary">{stat.v}</dd>
                      <dd className="mt-1 text-xs text-supporting">{stat.d}</dd>
                    </div>
                  ))}
                </dl>
              </div>

              <Launchpad />
            </div>
          </div>
        </section>

        {/* ---------- Catalog teaser ---------- */}
        <section className="relative py-16">
          <div className="container">
            <div className="flex flex-wrap items-end justify-between gap-5">
              <div>
                <p className="text-eyebrow uppercase text-gold-400">Open Cinema</p>
                <h2 className="mt-4 max-w-xl font-display text-display-md text-white balance">
                  Something ready to play, right now
                </h2>
                <p className="mt-3 max-w-lg text-[0.9375rem] leading-relaxed text-supporting pretty">
                  Openly licensed films that stream instantly — so a new room never starts with an
                  empty screen. Bring your own whenever you like.
                </p>
              </div>
              <Link href="/browse" className={buttonClasses({ variant: 'glass' })}>
                Browse everything
                <ArrowRight size={15} />
              </Link>
            </div>
          </div>

          <div className="mt-10">
            <MovieRow row={ROWS[0]} />
          </div>
        </section>

        {/* ---------- Recommended movies (built-in legal YouTube catalog) ---------- */}
        <RecommendedMovies />

        <Showcase />
        <HowItWorks />

        {/* ---------- Closing ---------- */}
        <section className="relative py-28">
          <div className="container">
            {/* Was a 5xl-radius promo banner with `glass-lit` and a purple radial
                bloom — the one composition on the page that read as a template.
                Now a stable raised section: neutral hairline, moderate radius,
                warm-white headline, no gradient type. */}
            <div className="relative overflow-hidden rounded-3xl glass px-8 py-20 text-center sm:px-16">
              <div className="relative">
                <h2 className="mx-auto max-w-2xl font-display text-display-lg text-primary balance">
                  The film is ready when you are
                </h2>
                <p className="mx-auto mt-5 max-w-md text-[1.0625rem] leading-relaxed text-supporting pretty">
                  Open a room and send the link. They will be sitting next to you in about ten
                  seconds.
                </p>
                <div className="mt-10 flex flex-col justify-center gap-3 sm:flex-row">
                  <Link href="/#launchpad" className={buttonClasses({ variant: 'primary', size: 'lg', className: 'w-full sm:w-auto' })}>
                    Create a watch room
                  </Link>
                  <Link href="/join" className={buttonClasses({ variant: 'outline', size: 'lg', className: 'w-full sm:w-auto' })}>
                    I have a code
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>

      <Footer />
    </>
  );
}
