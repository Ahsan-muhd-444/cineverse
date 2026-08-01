'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { getSocket } from '@/lib/socket';
import { getProfile, rememberRoom, setProfile } from '@/lib/storage';
import { colorFrom, makeRoomCode } from '@/lib/utils';
import { toYouTubeSource, type RecommendedMovie } from '@/data/recommendedMovies';

/**
 * Creates a room seeded with a recommended movie's OFFICIAL YouTube source and drops
 * you into it — so a partner joining the room lands on the same synced player.
 *
 * Mirrors `useStartRoom`, but seeds a canonical youtube source
 * (`{ type:'youtube', value:'<videoId>' }`). `room:create` stores the seeded source
 * WITHOUT re-normalizing, so the value must already be the bare 11-char id —
 * `toYouTubeSource` guarantees exactly that. Bytes stay on YouTube; the server only
 * syncs playback state between the two members.
 */
export function useStartRecommendation() {
  const router = useRouter();
  const [starting, setStarting] = React.useState<string | null>(null);

  const start = React.useCallback(
    async (movie: RecommendedMovie, kind: 'trailer' | 'full' = 'trailer') => {
      setStarting(movie.id);

      // Ensure there is *a* name; the room confirms it on arrival.
      const profile = getProfile();
      if (!profile.name) setProfile({ name: 'Guest', avatarColor: colorFrom('Guest') });

      const socket = getSocket();
      const result = await new Promise<{ ok: boolean; code?: string }>((resolve) => {
        const timeout = setTimeout(() => resolve({ ok: false }), 8000);
        socket.emit('room:create', { code: makeRoomCode(), source: toYouTubeSource(movie, kind) }, (res: { ok: boolean; code: string }) => {
          clearTimeout(timeout);
          resolve(res);
        });
      });

      setStarting(null);
      if (result.ok && result.code) {
        rememberRoom(result.code, movie.title);
        router.push(`/room/${result.code}`);
      } else {
        router.push(`/#launchpad`);
      }
    },
    [router],
  );

  return { start, starting };
}
