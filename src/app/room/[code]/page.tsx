import type { Metadata } from 'next';
import { Suspense } from 'react';
import { RoomExperience } from '@/components/room/RoomExperience';
import { normalizeRoomCode } from '@/lib/utils';

export async function generateMetadata({ params }: { params: { code: string } }): Promise<Metadata> {
  const code = normalizeRoomCode(params.code);
  return {
    title: `Room ${code}`,
    description: `Take your seat in CineVerse room ${code} — synced playback, live chat, and calls.`,
    robots: { index: false, follow: false },
  };
}

export default function RoomPage({ params }: { params: { code: string } }) {
  const code = normalizeRoomCode(params.code);

  return (
    <Suspense
      fallback={
        <div className="grid min-h-dvh place-items-center bg-ink-900">
          <span className="h-7 w-7 animate-spin rounded-full border-2 border-white/20 border-t-white" />
        </div>
      }
    >
      <RoomExperience code={code} />
    </Suspense>
  );
}
