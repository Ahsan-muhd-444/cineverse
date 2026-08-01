'use client';

import { io, type Socket } from 'socket.io-client';

let socket: Socket | null = null;
let detachWake: (() => void) | null = null;

/**
 * Reconnect the instant the tab comes back, instead of waiting out a backoff.
 *
 * A phone suspends the page when it is backgrounded: JavaScript stops, timers
 * stop, and the socket is closed by the OS. When the user returns, Socket.IO's
 * own retry is governed by a timer that was frozen with everything else, so the
 * connection can sit dead for seconds after the screen is already showing the
 * room. During that gap the reconnect grace is quietly running down.
 *
 * Every one of these events means "the user is looking at this again", so each
 * one asks the socket to connect NOW. `connect()` is a no-op when already
 * connected or connecting, so firing several at once is harmless.
 */
function attachWakeHandlers(live: Socket): () => void {
  if (typeof window === 'undefined') return () => {};

  const reconnectNow = () => {
    if (!live.connected) live.connect();
  };
  const onVisible = () => {
    if (document.visibilityState === 'visible') reconnectNow();
  };

  document.addEventListener('visibilitychange', onVisible);
  // `pageshow` also fires when the page is restored from the back/forward cache,
  // where no other event is guaranteed.
  window.addEventListener('pageshow', reconnectNow);
  window.addEventListener('focus', reconnectNow);
  window.addEventListener('online', reconnectNow);

  return () => {
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('pageshow', reconnectNow);
    window.removeEventListener('focus', reconnectNow);
    window.removeEventListener('online', reconnectNow);
  };
}

/** One connection per tab, shared by every hook that needs it. */
export function getSocket(): Socket {
  if (!socket) {
    socket = io({
      path: '/api/realtime',
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 4000,
      reconnectionAttempts: Infinity,
      timeout: 12000,
    });
    detachWake = attachWakeHandlers(socket);
  }
  return socket;
}

export function disposeSocket(): void {
  if (socket) {
    detachWake?.();
    detachWake = null;
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }
}

/* ==========================================================================
   Clock alignment
   --------------------------------------------------------------------------
   Two browsers never agree on Date.now(). Before we can sync playback we need
   to know, for each client, how far its clock sits from the server's and how
   long a round trip takes. This is a miniature NTP: sample several times, keep
   the samples with the lowest latency (those have the least noise), and use
   their median offset.
   ========================================================================== */

export interface ClockSync {
  offset: number; // serverTime - clientTime, in ms
  rtt: number; // round-trip time, in ms
}

const clock: ClockSync = { offset: 0, rtt: 0 };

export function getClock(): ClockSync {
  return clock;
}

/** Server's notion of "now", expressed in this client's timeline. */
export function serverNow(): number {
  return Date.now() + clock.offset;
}

export async function calibrateClock(socket: Socket, samples = 7): Promise<ClockSync> {
  const results: ClockSync[] = [];

  for (let i = 0; i < samples; i += 1) {
    const sent = Date.now();
    // eslint-disable-next-line no-await-in-loop
    const reply = await new Promise<{ serverTime: number } | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 2500);
      socket.emit('clock:ping', sent, (res: { serverTime: number }) => {
        clearTimeout(timer);
        resolve(res);
      });
    });
    if (!reply) continue;

    const received = Date.now();
    const rtt = received - sent;
    // Assume symmetric latency: the server's timestamp corresponds to sent + rtt/2.
    const offset = reply.serverTime - (sent + rtt / 2);
    results.push({ offset, rtt });
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 60));
  }

  if (results.length) {
    const best = results.sort((a, b) => a.rtt - b.rtt).slice(0, Math.max(1, Math.ceil(results.length / 2)));
    const offsets = best.map((r) => r.offset).sort((a, b) => a - b);
    clock.offset = offsets[Math.floor(offsets.length / 2)];
    clock.rtt = best.reduce((sum, r) => sum + r.rtt, 0) / best.length;
  }
  return { ...clock };
}
