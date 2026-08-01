import type { Metadata } from 'next';
import { AmbientBackdrop } from '@/components/fx/Ambient';
import { Header } from '@/components/layout/Header';
import { Footer } from '@/components/layout/Footer';
import { Explorer } from '@/components/browse/Explorer';
import { RecommendedMovies } from '@/components/recommend/RecommendedMovies';

export const metadata: Metadata = {
  title: 'Browse',
  description: 'Open Cinema — openly licensed films ready to stream into any CineVerse room.',
};

export default function BrowsePage() {
  return (
    <>
      <AmbientBackdrop withParticles={false} />
      <Header />

      <main id="main" className="pt-32 sm:pt-40">
        <div className="container mb-12">
          <p className="text-eyebrow uppercase text-gold-400">Open Cinema</p>
          <h1 className="mt-4 max-w-2xl font-display text-display-lg text-primary balance">
            Pick something, then pick someone
          </h1>
          <p className="mt-5 max-w-xl text-[1.0625rem] leading-relaxed text-supporting pretty">
            Every title here streams instantly and is licensed to share. Choosing one opens a fresh
            room with the film already loaded — all that is left is sending the link.
          </p>
        </div>

        <Explorer />

        {/* Built-in legal-YouTube recommendations, below the openly-licensed catalog. */}
        <RecommendedMovies />
      </main>

      <Footer />
    </>
  );
}
