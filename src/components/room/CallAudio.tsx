'use client';

import * as React from 'react';
import { Volume2 } from 'lucide-react';
import type { PeerStream } from '@/hooks/useWebRTC';

/**
 * The audio sinks for remote call participants.
 *
 * Deliberately a separate component from `CallDock`, mounted OUTSIDE the
 * collapsible side panel: the dock (and with it the only element that held a
 * remote stream) is unmounted by "Hide side panel", which killed the other
 * person's voice while every piece of call state still reported an active call.
 * Audio must not depend on any panel being open.
 *
 * A dedicated `<audio>` per peer — rather than relying on the video tile — is
 * also what makes a VOICE-ONLY call work: that tile is `opacity-0` with no video
 * track, and on iOS Safari a `<video>` fed an audio-only MediaStream does not
 * reliably play at all.
 */
function PeerAudio({
  peer,
  register,
  onBlockedChange,
}: {
  peer: PeerStream;
  register: (id: string, el: HTMLAudioElement | null) => void;
  onBlockedChange: (id: string, blocked: boolean) => void;
}) {
  const ref = React.useRef<HTMLAudioElement>(null);

  React.useEffect(() => {
    register(peer.id, ref.current);
    return () => register(peer.id, null);
  }, [peer.id, register]);

  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Attaching the stream IS the job. `version` is in the deps because the hook
    // reuses one MediaStream object per peer and a programmatic `addTrack` fires
    // no event — without it, audio added after the first negotiation (an
    // audio→video upgrade, a late renegotiation) would never be attached.
    if (el.srcObject !== peer.stream) el.srcObject = peer.stream;
    let cancelled = false;
    // `autoPlay` returns a promise nobody was awaiting, so a refused unmuted
    // autoplay was a completely silent failure — the dock still said
    // "Connected". Now a refusal surfaces a one-tap fix.
    void el.play().then(
      () => {
        if (!cancelled) onBlockedChange(peer.id, false);
      },
      () => {
        if (!cancelled) onBlockedChange(peer.id, true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [peer.id, peer.stream, peer.version, onBlockedChange]);

  // A peer leaving must not leave its "blocked" flag pinned on forever.
  React.useEffect(() => () => onBlockedChange(peer.id, false), [peer.id, onBlockedChange]);

  // Never muted: this element is the only thing carrying the other person's
  // voice. The video tiles are muted instead, so nothing plays twice.
  // eslint-disable-next-line jsx-a11y/media-has-caption
  return <audio ref={ref} autoPlay playsInline />;
}

export function CallAudio({ streams }: { streams: PeerStream[] }) {
  const elements = React.useRef(new Map<string, HTMLAudioElement>());
  const [blockedIds, setBlockedIds] = React.useState<string[]>([]);

  const register = React.useCallback((id: string, el: HTMLAudioElement | null) => {
    if (el) elements.current.set(id, el);
    else elements.current.delete(id);
  }, []);

  const onBlockedChange = React.useCallback((id: string, blocked: boolean) => {
    setBlockedIds((prev) => {
      const has = prev.includes(id);
      if (blocked === has) return prev; // no-op updates would loop the effect
      return blocked ? [...prev, id] : prev.filter((p) => p !== id);
    });
  }, []);

  // The click itself is the user activation the autoplay policy was waiting for.
  const resume = React.useCallback(() => {
    elements.current.forEach((el, id) => {
      void el.play().then(
        () => onBlockedChange(id, false),
        () => undefined,
      );
    });
  }, [onBlockedChange]);

  return (
    <>
      {streams.map((peer) => (
        <PeerAudio key={peer.id} peer={peer} register={register} onBlockedChange={onBlockedChange} />
      ))}
      {blockedIds.length > 0 && (
        // Overlay, not layout: `fixed` keeps this out of the room's grid so the
        // watch/chat zones are untouched.
        <button
          onClick={resume}
          className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full bg-electric-500/90 px-4 py-2.5 text-[0.8125rem] font-medium text-white shadow-lg backdrop-blur-sm transition-colors hover:bg-electric-500"
        >
          <Volume2 size={14} />
          Tap to enable call audio
        </button>
      )}
    </>
  );
}
