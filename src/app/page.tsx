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
import { Button } from '@/components/ui/Button';

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
                <p className="text-eyebrow uppercase text-electric-300/70">The launchpad</p>
                <h2 className="mt-4 font-display text-display-lg text-gradient-soft balance">
                  Two seats. One playhead. Zero setup.
                </h2>
                <p className="mt-5 max-w-md text-[1.0625rem] leading-relaxed text-white/45 pretty">
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
                      <dt className="text-eyebrow uppercase text-white/30">{stat.k}</dt>
                      <dd className="mt-2 font-display text-2xl font-semibold text-white">{stat.v}</dd>
                      <dd className="mt-1 text-xs text-white/35">{stat.d}</dd>
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
                <p className="text-eyebrow uppercase text-royal-400/80">Open Cinema</p>
                <h2 className="mt-4 max-w-xl font-display text-display-md text-white balance">
                  Something ready to play, right now
                </h2>
                <p className="mt-3 max-w-lg text-[0.9375rem] leading-relaxed text-white/45 pretty">
                  Openly licensed films that stream instantly — so a new room never starts with an
                  empty screen. Bring your own whenever you like.
                </p>
              </div>
              <Link href="/browse">
                <Button variant="glass">
                  Browse everything
                  <ArrowRight size={15} />
                </Button>
              </Link>
            </div>
          </div>

          <div className="mt-10">
            <MovieRow row={ROWS[0]} />
          </div>
        </section>

        <Showcase />
        <HowItWorks />

        {/* ---------- Closing ---------- */}
        <section className="relative py-28">
          <div className="container">
            <div className="relative overflow-hidden rounded-5xl glass-deep glass-lit px-8 py-20 text-center sm:px-16">
              <span
                aria-hidden
                className="pointer-events-none absolute -top-40 left-1/2 h-80 w-[70%] -translate-x-1/2 rounded-full bg-[radial-gradient(circle,rgba(124,58,237,0.5),transparent_70%)] blur-[80px]"
              />
              <div className="relative">
                <h2 className="mx-auto max-w-2xl font-display text-display-lg text-gradient balance">
                  The film is ready when you are
                </h2>
                <p className="mx-auto mt-5 max-w-md text-[1.0625rem] leading-relaxed text-white/50 pretty">
                  Open a room and send the link. They will be sitting next to you in about ten
                  seconds.
                </p>
                <div className="mt-10 flex flex-col justify-center gap-3 sm:flex-row">
                  <Link href="/#launchpad">
                    <Button variant="primary" size="lg" className="w-full sm:w-auto">
                      Create a watch room
                    </Button>
                  </Link>
                  <Link href="/join">
                    <Button variant="outline" size="lg" className="w-full sm:w-auto">
                      I have a code
                    </Button>
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
