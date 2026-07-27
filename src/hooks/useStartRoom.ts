'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { getSocket } from '@/lib/socket';
import { getProfile, rememberRoom, setProfile } from '@/lib/storage';
import { colorFrom, makeRoomCode } from '@/lib/utils';
import type { Movie } from '@/lib/types';

/**
 * Creates a room seeded with a film and drops you into it.
 * Used from every poster on the site, so the path from "that one" to
 * "we are watching it" is a single click.
 */
export function useStartRoom() {
  const router = useRouter();
  const [starting, setStarting] = React.useState<string | null>(null);

  const start = React.useCallback(
    async (movie: Movie) => {
      setStarting(movie.id);

      // Make sure there is *a* name; the room will ask to confirm it on arrival.
      const profile = getProfile();
      if (!profile.name) setProfile({ name: 'Guest', avatarColor: colorFrom('Guest') });

      const socket = getSocket();
      const result = await new Promise<{ ok: boolean; code?: string }>((resolve) => {
        const timeout = setTimeout(() => resolve({ ok: false }), 8000);
        socket.emit(
          'room:create',
          {
            code: makeRoomCode(),
            source: { type: 'catalog', value: movie.src, label: movie.title, poster: movie.id },
          },
          (res: { ok: boolean; code: string }) => {
            clearTimeout(timeout);
            resolve(res);
          },
        );
      });

      setStarting(null);
      if (result.ok && result.code) {
        rememberRoom(result.code, movie.title);
        router.push(`/room/${result.code}?film=${encodeURIComponent(movie.id)}`);
      } else {
        router.push(`/#launchpad`);
      }
    },
    [router],
  );

  return { start, starting };
}
