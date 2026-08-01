'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowLeft,
  Clapperboard,
  Copy,
  Film,
  Heart,
  Lightbulb,
  LightbulbOff,
  LogOut,
  Maximize2,
  MessageSquare,
  PanelRightClose,
  PanelRightOpen,
  Settings,
  TriangleAlert,
  Users,
  X,
} from 'lucide-react';
import { useRoom } from '@/hooks/useRoom';
import { useWebRTC } from '@/hooks/useWebRTC';
import { useSyncedPlayback, type PlayerHandle } from '@/hooks/useSyncedPlayback';
import { Player } from './Player';
import { Chat } from './Chat';
import { CallDock } from './CallDock';
import { SourcePicker, type UploadOptions } from './SourcePicker';
import { ConnectionPill, Participants, ReactionLayer, RoomClock, RoomSettingsModal } from './SidePanels';
import { Button, buttonClasses } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { GlassCard } from '@/components/ui/GlassCard';
import { Avatar, Badge, Segmented, useToast } from '@/components/ui/Bits';
import { Aurora } from '@/components/fx/Ambient';
import { Wordmark } from '@/components/layout/Header';
import { findMovie } from '@/lib/catalog';
import { getSettings, saveProgress, setSettings, type AppSettings } from '@/lib/storage';
import { cn, copyToClipboard } from '@/lib/utils';
import { connectedMemberIds } from '@/lib/rtc';
import { useRoomUploader } from '@/hooks/useRoomUploader';
import { useViewportLock } from '@/hooks/useViewportLock';
import { PartnerUploadRow } from '@/components/room/SharedUploadProgress';
import type { MediaSource } from '@/lib/types';

const FLY_EMOJIS = ['❤️', '😂', '🔥', '😮', '🍿', '👏'];

/* ==========================================================================
   Gates — everything that happens before you are in the room
   ========================================================================== */

function Gate({
  title,
  body,
  children,
  icon,
}: {
  title: string;
  body?: string;
  children?: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <div className="relative grid min-h-dvh place-items-center px-5">
      {/* One warm field, matching the simplified product backdrop. The gate
          previously mounted its own aurora + cursor Spotlight + page-wide
          vignette, which is the stack that was removed everywhere else — a
          light chasing the cursor on a sign-in card reads as a landing page,
          and the vignette darkened the form rather than the video. */}
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-ink-900">
        <Aurora intensity={0.6} />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 22, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
        className="w-full max-w-md"
      >
        <GlassCard tone="deep" className="p-8" glow>
          <div className="mb-6 flex justify-center">
            {/* Same brand treatment as the header mark — gold symbol on a
                near-black tile — so the room gate and the header read as one
                product. Dimensions and icon unchanged. */}
            <span className="grid h-14 w-14 place-items-center rounded-2xl border border-gold-400/25 bg-ink-850">
              {icon || <Clapperboard size={22} className="text-gold-400" />}
            </span>
          </div>
          <h1 className="text-center font-display text-2xl font-semibold tracking-tight text-primary balance">
            {title}
          </h1>
          {/* Gate body explains what is being asked of the visitor — that is
              instructional, so it takes an informational tier (was 0.45). */}
          {body && <p className="mx-auto mt-3 max-w-sm text-center text-sm leading-relaxed text-supporting pretty">{body}</p>}
          {children && <div className="mt-7">{children}</div>}
        </GlassCard>
      </motion.div>
    </div>
  );
}

/* ==========================================================================
   The room
   ========================================================================== */

export function RoomExperience({ code }: { code: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const toast = useToast();

  const room = useRoom(code, params.get('k') || undefined);
  // The room is an app screen: the page behind it must not scroll, and the
  // on-screen keyboard must shrink the room rather than hide the composer.
  useViewportLock();
  const handleRef = React.useRef<PlayerHandle | null>(null);

  const [nameDraft, setNameDraft] = React.useState('');
  const [passwordDraft, setPasswordDraft] = React.useState('');
  const [localFile, setLocalFile] = React.useState<File | null>(null);
  const [sourceOpen, setSourceOpen] = React.useState(false);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [panel, setPanel] = React.useState<'chat' | 'people'>('chat');
  const [panelOpen, setPanelOpen] = React.useState(true);
  /**
   * MOBILE ONLY (below `lg`): the room is one of two stable zones.
   *
   *  - `watch` — the player sits at its natural 16:9 height and the chat takes
   *    everything left over.
   *  - `chat` — the player shrinks to a short sticky mini player (still playing,
   *    still synced) so the chat owns the screen.
   *
   * Desktop ignores this completely: every class it drives carries an `lg:`
   * reset, so the `lg` layout is unchanged whatever this holds.
   */
  const [mobileMode, setMobileMode] = React.useState<'watch' | 'chat'>('watch');

  /** Picking the Chat tab is also the request to enter the mobile chat zone. */
  const selectPanel = React.useCallback((next: 'chat' | 'people') => {
    setPanel(next);
    if (next === 'chat') setMobileMode('chat');
  }, []);
  const [appSettings, setAppSettings] = React.useState<AppSettings>(getSettings);
  const [unread, setUnread] = React.useState(0);

  // Only CONNECTED members are call-routable. A member inside their reconnect
  // grace window stays in `room.members` for presence (so the People list never
  // churns on a refresh), but their media transport is gone — feeding that id to
  // WebRTC would rebuild a peer connection to nobody and strand a stale entry.
  // Peer ids are STABLE member ids, so identity comparisons use room.myId;
  // socket.id would break the moment anyone refreshes.
  const callMemberIds = React.useMemo(() => connectedMemberIds(room.members), [room.members]);
  const call = useWebRTC(room.socket, callMemberIds, room.phase === 'ready', room.myId);

  const sync = useSyncedPlayback(room.socket, handleRef, {
    enabled: room.phase === 'ready',
    onRemoteAction: (action, by) => {
      if (action === 'play') toast(`${by} pressed play`);
      if (action === 'pause') toast(`${by} paused`);
    },
  });

  /* ---------------- seed from ?film= ---------------- */

  React.useEffect(() => {
    if (room.phase !== 'ready' || room.source) return;
    const filmId = params.get('film');
    if (!filmId) return;
    const movie = findMovie(filmId);
    if (movie) {
      room.setSource({ type: 'catalog', value: movie.src, label: movie.title });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.phase, room.source, params]);

  /* ---------------- pull the room's position when media is ready ---------------- */

  const handleReady = React.useCallback(() => {
    sync.resync();
  }, [sync]);

  /* ---------------- unread badge ---------------- */

  React.useEffect(() => {
    if (!room.messages.length) return;
    const last = room.messages[room.messages.length - 1];
    if (last.authorId === room.myId || last.kind === 'system') return;
    if (panel !== 'chat' || !panelOpen) setUnread((n) => n + 1);
  }, [room.messages, room.myId, panel, panelOpen]);

  React.useEffect(() => {
    if (panel === 'chat' && panelOpen) setUnread(0);
  }, [panel, panelOpen]);

  /* ---------------- shared cinema lights ---------------- */

  const lightsOff = room.settings.lightsMode === 'off';
  const prevLights = React.useRef(room.settings.lightsMode);
  React.useEffect(() => {
    // Announce a change (from either side) with a small toast; skip first render.
    if (prevLights.current !== room.settings.lightsMode) {
      prevLights.current = room.settings.lightsMode;
      toast(room.settings.lightsMode === 'off' ? 'Cinema lights off' : 'Cinema lights on');
    }
  }, [room.settings.lightsMode, toast]);

  /* ---------------- continue watching ---------------- */

  const onProgress = React.useCallback(
    (position: number, duration: number) => {
      const filmId = params.get('film');
      const label = room.source?.label;
      const movie = filmId ? findMovie(filmId) : undefined;
      const id = movie?.id || (label ? label.toLowerCase().replace(/\s+/g, '-') : null);
      if (!id || !duration) return;
      saveProgress({ movieId: id, position, duration, updatedAt: Date.now() });
    },
    [params, room.source],
  );

  /* ---------------- actions ---------------- */

  const copyInvite = React.useCallback(async () => {
    const url = `${window.location.origin}/room/${code}`;
    const ok = await copyToClipboard(url);
    toast(ok ? 'Invite link copied' : url, ok ? 'success' : 'default');
  }, [code, toast]);

  /*
   * A monotonically increasing count of DELIBERATE source choices.
   *
   * A 3 GB upload can take half an hour, and in that time the user may well put on
   * a YouTube video instead. When the upload finally lands, applying its source
   * would silently yank the room off whatever they are now watching — so the
   * upload captures this number when it starts and its result is only applied if
   * the number has not moved.
   */
  const sourceGeneration = React.useRef(0);

  const chooseSource = (source: MediaSource) => {
    sourceGeneration.current += 1;
    room.setSource(source);
    if (source.type !== 'local') setLocalFile(null);
  };

  /** A completed upload whose result arrived after a newer choice was made. */
  const [strandedUpload, setStrandedUpload] = React.useState<MediaSource | null>(null);

  /** Other members' uploads — never our own, which the picker already shows. */
  const partnerUploads = React.useMemo(
    () => room.uploads.filter((entry) => entry.memberId !== room.myId),
    [room.uploads, room.myId],
  );

  /*
   * The ROOM-SCOPED uploader, created with the room rather than with a file.
   *
   * That ordering is what makes refresh recovery reachable: the controller reads
   * the persisted session on mount, so the picker can offer "Resume upload of …"
   * BEFORE a file is chosen. It also survives a retryable failure, so "Try again"
   * resumes the same session instead of minting a new intent.
   */
  const uploadGenerationRef = React.useRef(0);
  const uploader = useRoomUploader(
    room.socket,
    code,
    React.useCallback((source: MediaSource) => {
      // A completed upload only wins if the user has not chosen something newer.
      if (sourceGeneration.current !== uploadGenerationRef.current) {
        setStrandedUpload(source);
        return;
      }
      chooseSource(source);
    }, []),
  );

  /** Hand the picker a file: start a new upload, or resume a recovered session. */
  const uploadLocalVideo = React.useCallback(
    async (file: File, _options: UploadOptions) => {
      uploadGenerationRef.current = sourceGeneration.current;
      return uploader.choose(file);
    },
    [uploader],
  );

  const updateAppSettings = (patch: Partial<AppSettings>) => setAppSettings(setSettings(patch));

  const peerNames = React.useMemo(
    () =>
      Object.fromEntries(room.members.map((m) => [m.id, { name: m.name, color: m.color }])) as Record<
        string,
        { name: string; color: string }
      >,
    [room.members],
  );

  /* ---------------- gates ---------------- */

  if (room.phase === 'connecting') {
    return (
      // A retry in progress says WHY it is waiting — a bare spinner during a
      // rate-limited backoff is indistinguishable from a hang.
      <Gate title="Finding your room" body={room.error || `Connecting to ${code}…`}>
        <div className="flex justify-center">
          <span className="h-6 w-6 animate-spin rounded-full border-2 border-white/20 border-t-white" />
        </div>
      </Gate>
    );
  }

  if (room.phase === 'identify') {
    return (
      <Gate title="Who is arriving?" body={`Room ${code} is expecting you.`}>
        <div className="space-y-4">
          <Input
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            placeholder="Your name"
            maxLength={24}
            autoFocus
            onKeyDown={(e) => e.key === 'Enter' && nameDraft.trim() && room.identify(nameDraft)}
          />
          <Button
            variant="primary"
            size="lg"
            className="w-full"
            disabled={!nameDraft.trim()}
            onClick={() => room.identify(nameDraft)}
          >
            Take my seat
          </Button>
        </div>
      </Gate>
    );
  }

  if (room.phase === 'password') {
    return (
      <Gate title="This room is private" body="Enter the passphrase they shared with you." icon={<Film size={22} />}>
        <div className="space-y-4">
          <Input
            type="password"
            value={passwordDraft}
            onChange={(e) => setPasswordDraft(e.target.value)}
            placeholder="Passphrase"
            error={room.error}
            autoFocus
            onKeyDown={(e) => e.key === 'Enter' && room.submitPassword(passwordDraft)}
          />
          <Button variant="primary" size="lg" className="w-full" onClick={() => room.submitPassword(passwordDraft)}>
            Unlock
          </Button>
        </div>
      </Gate>
    );
  }

  if (room.phase === 'waiting') {
    return (
      <Gate title="Waiting to be let in" body="The host has been told you are here. Hang tight.">
        <div className="flex items-center justify-center gap-1.5">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="h-2 w-2 animate-bounce rounded-full bg-white/50"
              style={{ animationDelay: `${i * 160}ms` }}
            />
          ))}
        </div>
      </Gate>
    );
  }

  if (room.phase === 'denied' || room.phase === 'kicked' || room.phase === 'unreachable') {
    const copy = {
      denied: { title: 'Not this time', body: room.error || 'The host did not let you in.' },
      kicked: { title: 'You left the room', body: 'The host removed you from this room.' },
      unreachable: { title: 'That room is not open', body: room.error || 'Ask for a fresh link, or open your own.' },
    }[room.phase];

    return (
      <Gate title={copy.title} body={copy.body}>
        <div className="flex flex-col gap-3">
          <Link href="/#launchpad" className={buttonClasses({ variant: 'primary', size: 'lg', className: 'w-full' })}>
            Open my own room
          </Link>
          <Link href="/" className={buttonClasses({ variant: 'ghost', size: 'lg', className: 'w-full' })}>
            <ArrowLeft size={16} />
            Back home
          </Link>
        </div>
      </Gate>
    );
  }

  /* ---------------- the room itself ---------------- */

  return (
    <div
      className={cn(
        // Viewport-LOCKED on desktop so the room never grows with chat content —
        // the message list scrolls internally instead of the page. Mobile keeps
        // its natural min-h-dvh column (player on top, chat below).
        // The room is an APP SCREEN, not a document: locked to the visible
        // viewport at every size. Mobile used to keep its natural `min-h-dvh`
        // column, so a growing chat grew the PAGE — the composer scrolled off
        // screen and the whole room stretched. `h-dvh` + `overflow-hidden` here,
        // with `min-h-0` all the way down, makes the message list the only
        // scroller on phones exactly as it already was on desktop.
        // Height comes from `--room-viewport-h` (the VISUAL viewport, published by
        // useViewportLock) so the on-screen keyboard shrinks the room instead of
        // pushing the composer behind it. `100dvh` is the fallback where
        // visualViewport is unavailable.
        // `w-full max-w-full` + `overscroll-x-none`: the width is the phone's
        // width, full stop. An accidental sideways swipe while a film is playing
        // must move nothing — there is no hidden width to reveal and no
        // horizontal rubber-band. Deliberately NO `touch-action` here: that would
        // be inherited by the YouTube iframe and break dragging its seek bar,
        // which is the only playback control a YouTube source has.
        'relative flex h-[var(--room-viewport-h,100dvh)] w-full min-h-0 max-w-full flex-col overflow-hidden overscroll-x-none transition-colors duration-500',
        lightsOff ? 'bg-black' : 'bg-ink-950',
      )}
    >
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden transition-opacity duration-500">
        <Aurora intensity={lightsOff ? 0.12 : 0.45} />
        <div className={cn('absolute inset-0 transition-colors duration-500', lightsOff ? 'bg-black/75' : 'bg-ink-950/55')} />
      </div>

      {/* The ready room previously had no page-level heading at all — the gates
          own an h1, but once you are inside, the document outline started at the
          player's h2. Visually hidden so it names the page for assistive tech
          without putting a title next to the video. */}
      <h1 className="sr-only">CineVerse room {code}</h1>

      {/* ---------- top bar ---------- */}
      <header
        className={cn(
          'relative z-40 shrink-0 border-b border-white/[0.07] backdrop-blur-2xl transition-colors duration-500',
          lightsOff ? 'bg-black/70' : 'bg-ink-900/60',
        )}
      >
        <div className="flex items-center gap-3 px-4 py-3 sm:px-6">
          <Wordmark compact className="shrink-0" />

          <div className="hidden items-center gap-2 sm:flex">
            <span className="rounded-xl bg-white/[0.06] px-2.5 py-1.5 font-mono text-[0.8125rem] font-medium tracking-[0.18em] text-white/80">
              {code}
            </span>
            <button
              onClick={copyInvite}
              className="inline-flex h-11 items-center gap-1.5 rounded-xl px-3 text-[0.75rem] text-secondary transition-colors duration-[160ms] ease-swift hover:bg-white/[0.07] hover:text-primary"
            >
              <Copy size={12} />
              Invite
            </button>
          </div>

          {room.source && (
            <p className="ml-1 hidden min-w-0 max-w-[22ch] truncate text-[0.8125rem] text-secondary lg:block">
              {room.source.label}
            </p>
          )}

          <div className="ml-auto flex items-center gap-2">
            <div className="hidden items-center gap-2 sm:flex">
              <RoomClock />
              <ConnectionPill quality={room.quality} latency={room.latency} />
            </div>

            <div className="flex -space-x-2">
              {room.members.slice(0, 3).map((member) => (
                <Avatar key={member.id} name={member.name} color={member.color} size={30} className="ring-2 ring-ink-900" />
              ))}
            </div>

            <button
              onClick={() => room.setLights(lightsOff ? 'on' : 'off')}
              aria-label={lightsOff ? 'Turn cinema lights on' : 'Turn cinema lights off'}
              aria-pressed={lightsOff}
              title={lightsOff ? 'Lights on' : 'Lights off'}
              className={cn(
                // 44x44 interactive region (WCAG 2.5.5) as a real button, not
                // an overlapping pseudo-element: these five controls sit 8px
                // apart, so expanded hit areas would intersect. Icon stays 16px.
                'grid h-11 w-11 place-items-center rounded-xl transition-colors duration-[160ms] ease-swift',
                lightsOff
                  ? 'bg-amber-400/15 text-amber-300 hover:bg-amber-400/25'
                  : 'text-secondary hover:bg-white/[0.07] hover:text-primary',
              )}
            >
              {lightsOff ? <LightbulbOff size={16} /> : <Lightbulb size={16} />}
            </button>

            <button
              onClick={() => setSettingsOpen(true)}
              aria-label="Room settings"
              className="grid h-11 w-11 place-items-center rounded-xl text-secondary transition-colors duration-[160ms] ease-swift hover:bg-white/[0.07] hover:text-primary"
            >
              <Settings size={16} />
            </button>

            <button
              onClick={() => setPanelOpen((v) => !v)}
              aria-label={panelOpen ? 'Hide side panel' : 'Show side panel'}
              className="hidden h-11 w-11 place-items-center rounded-xl text-secondary transition-colors duration-[160ms] ease-swift hover:bg-white/[0.07] hover:text-primary lg:grid"
            >
              {panelOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
            </button>

            <button
              onClick={() => {
                // Explicit leave gives the seat up immediately — unlike a
                // refresh, which relies on the server's reconnect grace.
                room.leave();
                router.push('/');
              }}
              aria-label="Leave room"
              className="grid h-11 w-11 place-items-center rounded-xl text-secondary transition-colors duration-[160ms] ease-swift hover:bg-rose-500/15 hover:text-rose-300"
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </header>

      {/* A room action the server refused (too fast, not the host, no answer).
          Deliberately a thin inline strip rather than a modal: it must not
          interrupt the film, and it must not be confused with the terminal
          room screens that `room.error` drives. */}
      {room.notice && (
        <div
          role="status"
          className="relative z-40 flex shrink-0 items-center gap-2 border-b border-amber-400/20 bg-amber-400/[0.08] px-4 py-2 text-[0.8125rem] text-amber-200 sm:px-6"
        >
          <TriangleAlert size={14} className="shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">{room.notice}</span>
          <button
            onClick={room.dismissNotice}
            aria-label="Dismiss"
            className="shrink-0 rounded-lg px-2 py-0.5 text-amber-200/70 transition-colors hover:bg-amber-400/15 hover:text-amber-100"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* ---------- stage ---------- */}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row">
        <main
          id="main"
          className={cn(
            'flex min-w-0 flex-col p-3 sm:p-5 lg:min-h-0 lg:flex-1 lg:justify-center',
            mobileMode === 'chat'
              ? // Chat zone (mobile): a short sticky strip that holds nothing but
                // the mini player and the way back, so the film keeps playing
                // while the chat below gets the rest of the screen. Every class
                // here is undone at `lg`.
                'sticky top-0 z-20 h-[clamp(96px,16dvh,160px)] shrink-0 flex-row items-center gap-3 lg:static lg:z-auto lg:h-auto lg:shrink lg:flex-col lg:items-stretch lg:gap-0'
              : // Watch zone (mobile): natural height. With the player's 17rem
                // floor gone that is exactly its 16:9 box — no empty black band.
                'flex-none',
          )}
        >
          {/* Reserve derived from measurement, not guesswork. At 1440x900:
                header 69 + stage padding 40 + under-player row 56 = 165px of
                real chrome, plus ~37px for the conditional notice strip that
                can appear above the stage = ~202px. 13rem (208px) covers the
                worst case with the notice visible and still returns 32px of
                height the old 15rem reserve was holding empty — the reason the
                screen looked like it was floating. The notice matters because
                this formula keys off 100dvh, not off the stage's real height,
                so an unaccounted strip would push the player into a clip. */}
          <div
            className={cn(
              'relative mx-auto w-full lg:mx-auto lg:h-auto lg:w-full lg:max-w-[min(100%,calc((100dvh-13rem)*16/9))]',
              // Mini player: the strip's fixed height is the box, so the shell
              // is height-driven and 16:9 shrinks its WIDTH — never letterboxed.
              //
              // `lg:shrink` is load-bearing, not decoration. `mobileMode` is NOT
              // mobile-only state: the desktop Chat tab and the first click into
              // the desktop composer both set it to 'chat', and nothing on
              // desktop ever sets it back. Without this reset the wrapper would
              // keep `flex-shrink: 0` on desktop, and because the stage's height
              // reserve is deliberately tight (13rem against ~202px of measured
              // chrome), a short viewport showing the notice strip would push the
              // overflow onto the under-player row and clip it.
              mobileMode === 'chat' && 'mx-0 h-full w-auto shrink-0 lg:shrink',
            )}
          >
            <Player
              compact={mobileMode === 'chat'}
              source={room.source}
              localFile={localFile}
              handleRef={handleRef}
              onUserControl={sync.emitControl}
              isApplying={sync.isApplying}
              onRequestSource={() => setSourceOpen(true)}
              onReady={handleReady}
              onProgress={onProgress}
              drift={sync.drift}
              needsPlaybackGesture={sync.needsPlaybackGesture}
              onJoinPlayback={sync.joinPlaybackAfterGesture}
              overlay={<ReactionLayer socket={room.socket} />}
              emptyState={
                <div className="px-5 text-center sm:px-6">
                  <span className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl glass-soft text-decorative sm:mb-5 sm:h-16 sm:w-16 sm:rounded-3xl">
                    <Film size={22} />
                  </span>
                  <h2 className="font-display text-base font-semibold text-primary sm:text-xl">
                    The screen is dark
                  </h2>
                  <p className="mx-auto mt-2 hidden max-w-sm text-[0.875rem] leading-relaxed text-supporting pretty sm:block">
                    Pick something from Open Cinema, paste a video link, or load a file you both
                    have. Whatever you choose appears on their screen too.
                  </p>
                  <p className="mx-auto mt-1.5 max-w-[20rem] text-[0.8125rem] leading-relaxed text-supporting pretty sm:hidden">
                    Open Cinema, a video link, or a file you both have.
                  </p>
                  <Button
                    variant="primary"
                    className="mt-5 sm:mt-7"
                    size="md"
                    onClick={() => setSourceOpen(true)}
                  >
                    <Film size={16} />
                    Choose what to watch
                  </Button>
                </div>
              }
            />

            {/* local file prompt for the partner */}
            {room.source?.type === 'local' && !localFile && (
              <div
                className={cn(
                  'absolute inset-x-4 bottom-20 z-40 mx-auto max-w-md rounded-2xl glass-deep p-4 text-center',
                  // It is taller than the mini player, so in the chat zone it
                  // would spill out of the strip. It comes back with the watch
                  // zone, which is where "Load my copy" is actionable anyway.
                  mobileMode === 'chat' && 'hidden lg:block',
                )}
              >
                <p className="text-[0.8125rem] text-primary">
                  Your partner is playing <span className="font-medium">{room.source.label}</span>
                </p>
                <p className="mt-1 text-[0.75rem] text-supporting">
                  Open your own copy of the same file to stay in sync.
                </p>
                <Button variant="glass" size="sm" className="mt-3" onClick={() => setSourceOpen(true)}>
                  Load my copy
                </Button>
              </div>
            )}

            {/* Chat zone only: the whole mini player is "take me back to
                watching". A cross-origin YouTube iframe swallows pointer events,
                so the tap has to be caught by an overlay rather than by an
                onClick on the wrapper. Rendered ONLY in chat mode and hidden at
                `lg`, so it can never sit over a live player in the watch zone or
                on desktop. */}
            {mobileMode === 'chat' && (
              <button
                type="button"
                onClick={() => setMobileMode('watch')}
                aria-label="Back to watch mode"
                className="absolute inset-0 z-40 rounded-xl lg:hidden"
              />
            )}
          </div>

          {/* Chat zone only: the visible way back, beside the mini player. */}
          {mobileMode === 'chat' && (
            <div className="flex min-w-0 flex-1 items-center justify-end lg:hidden">
              <Button
                variant="glass"
                size="sm"
                className="!h-11"
                aria-label="Back to watch mode"
                onClick={() => setMobileMode('watch')}
              >
                <Maximize2 size={14} />
                Watch
              </Button>
            </div>
          )}

          {/* under-player bar */}
          <div
            className={cn(
              'mt-3 flex flex-wrap items-center gap-2',
              // Watch-zone chrome. The chat strip has no room for it, and it
              // returns the moment you tap Watch.
              mobileMode === 'chat' && 'hidden lg:flex',
            )}
          >
            {/* Local min-height only: the shared sm Button stays 36px for the
                rest of the app, but room actions meet the 44px standard. */}
            <Button variant="glass" size="sm" className="!h-11" onClick={() => setSourceOpen(true)}>
              <Film size={14} />
              {room.source ? 'Change film' : 'Choose a film'}
            </Button>

            <Button variant="ghost" size="sm" className="!h-11 sm:hidden" onClick={copyInvite}>
              <Copy size={14} />
              {code}
            </Button>

            {/* The explicit way into the chat zone from the watch zone. Subtle
                on purpose — the panel tabs below do the same thing. */}
            <Button
              variant="ghost"
              size="sm"
              className="!h-11 lg:hidden"
              aria-label="Open chat"
              onClick={() => {
                selectPanel('chat');
                setPanelOpen(true);
              }}
            >
              <MessageSquare size={14} />
              Chat
            </Button>

            <div className="ml-auto flex items-center gap-1">
              {FLY_EMOJIS.map((emoji) => (
                <button
                  key={emoji}
                  onClick={() => room.fly(emoji)}
                  aria-label={`Send ${emoji} to the screen`}
                  className="grid h-11 w-11 place-items-center rounded-xl text-lg transition-[transform,background-color] duration-[160ms] ease-swift hover:scale-[1.06] hover:bg-white/[0.07]"
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>

          {/* mobile panel toggle */}
          <div className={cn('mt-3 lg:hidden', mobileMode === 'chat' && 'hidden')}>
            <Segmented
              label="Side panel"
              value={panel}
              onChange={(next) => {
                selectPanel(next);
                setPanelOpen(true);
              }}
              className="w-full"
              options={[
                {
                  value: 'chat',
                  label: (
                    <span className="inline-flex items-center gap-1.5">
                      Chat
                      {unread > 0 && (
                        <span className="grid h-4 min-w-4 place-items-center rounded-full bg-gold-400 px-1 text-[0.5625rem] font-semibold text-ink-950">
                          {unread}
                        </span>
                      )}
                    </span>
                  ),
                  icon: <MessageSquare size={13} />,
                },
                { value: 'people', label: `People · ${room.members.length}`, icon: <Users size={13} /> },
              ]}
            />
          </div>
        </main>

        {/* ---------- side panel ---------- */}
        <AnimatePresence initial={false}>
          {panelOpen && (
            <motion.aside
              initial={{ opacity: 0, width: 0 }}
              animate={{ opacity: 1, width: 'auto' }}
              exit={{ opacity: 0, width: 0 }}
              transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
              className={cn(
                // A stable architectural rail rather than a transparent stack:
                // one predictable dark base and one neutral left border, so a
                // bright frame behind it can never change how the chat reads.
                // Deliberately a touch darker than the raised panel surface, and
                // structurally attached to the viewport edge — no outer margin,
                // no floating card, no blur, no extra shadow.
                'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-ink-950 border-white/[0.07] transition-[filter] duration-500 lg:h-full lg:flex-none lg:shrink-0 lg:border-l',
                lightsOff && 'brightness-[0.9]',
              )}
              aria-label="Room side panel"
            >
              {/* Fixed-width, viewport-height inner wrapper. The aside animates
                  width to `auto` (an inline style that would otherwise override a
                  Tailwind width class); pinning the width on this inner div keeps
                  the panel a stable 23rem/25rem, and h-full keeps it height-locked
                  so the chat list — not the panel — is what scrolls. */}
              <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col lg:h-full lg:w-[23rem] xl:w-[25rem]">
                <div className="hidden shrink-0 items-center gap-2 border-b border-white/[0.07] p-3 lg:flex">
                  <Segmented
                    label="Side panel"
                    value={panel}
                    onChange={selectPanel}
                    size="sm"
                    options={[
                      {
                        value: 'chat',
                        label: (
                          <span className="inline-flex items-center gap-1.5">
                            Chat
                            {unread > 0 && (
                              <span className="grid h-4 min-w-4 place-items-center rounded-full bg-gold-400 px-1 text-[0.5625rem] font-semibold text-ink-950">
                                {unread}
                              </span>
                            )}
                          </span>
                        ),
                        icon: <MessageSquare size={12} />,
                      },
                      {
                        value: 'people',
                        label: `People · ${room.members.length}`,
                        icon: <Users size={12} />,
                      },
                    ]}
                  />
                  {room.isHost && <Badge tone="warn">Host</Badge>}
                </div>

                <div className="shrink-0 border-b border-white/[0.07] p-3">
                  <CallDock
                    call={call}
                    myName={room.me?.name || 'You'}
                    myColor={room.me?.color}
                    peerNames={peerNames}
                  />
                </div>

                {/*
                  Shared uploads in progress. `shrink-0` keeps it out of the
                  bounded chat scroller, and rows appear only while an upload is
                  live — the server clears them on completion, cancel, failure and
                  member removal, so this cannot become a phantom.
                */}
                {(partnerUploads.length > 0 || strandedUpload) && (
                  <div className="shrink-0 space-y-2 border-b border-white/[0.07] p-3">
                    {partnerUploads.map((progress) => (
                      <PartnerUploadRow key={progress.memberId} progress={progress} />
                    ))}
                    {strandedUpload && (
                      <div className="rounded-xl border border-gold-400/25 bg-gold-400/[0.06] px-3 py-2.5">
                        <p className="text-xs text-primary">
                          “{strandedUpload.label}” finished uploading after you picked something else.
                        </p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          <Button
                            variant="glass"
                            size="sm"
                            className="!h-11"
                            onClick={() => {
                              chooseSource(strandedUpload);
                              setStrandedUpload(null);
                            }}
                          >
                            Play uploaded movie
                          </Button>
                          <Button variant="ghost" size="sm" className="!h-11" onClick={() => setStrandedUpload(null)}>
                            Dismiss
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                <div
                  className={cn(
                    // `min-h-0` + `overflow-hidden` at EVERY size, so the Chat's
                    // own message list is the only thing that scrolls. The old
                    // `min-h-[22rem]` floor was what let a busy chat push the
                    // panel past the bottom of a phone screen and take the
                    // composer with it.
                    'min-h-0 flex-1 overflow-hidden',
                    panel === 'chat' ? 'flex flex-col' : 'hidden',
                  )}
                >
                  <Chat
                    messages={room.messages}
                    myId={room.myId}
                    typing={room.typing}
                    seenAt={room.seenAt}
                    onSend={room.send}
                    onTyping={room.setTyping}
                    onReact={room.react}
                    // Reaching for the composer IS the request for the chat
                    // zone — the mini player keeps the film running above it.
                    onComposerFocus={() => setMobileMode('chat')}
                  />
                </div>

                <div
                  className={cn(
                    // Same rule for the People tab: bounded, and it scrolls
                    // internally rather than growing the screen.
                    'min-h-0 flex-1 overflow-y-auto overscroll-contain',
                    panel === 'people' ? 'block' : 'hidden',
                  )}
                >
                  <Participants
                    members={room.members}
                    lobby={room.lobby}
                    myId={room.myId}
                    hostId={room.hostId}
                    isHost={room.isHost}
                    onDecide={room.decide}
                    onKick={room.kick}
                    onTransferHost={room.transferHost}
                  />
                </div>
              </div>
            </motion.aside>
          )}
        </AnimatePresence>
      </div>

      {/* ---------- modals ---------- */}
      <SourcePicker
        open={sourceOpen}
        onClose={() => setSourceOpen(false)}
        onChoose={chooseSource}
        onLocalFile={setLocalFile}
        // Hosted uploads are gated by the server's deployment verdict. When
        // disabled (a demo deploy with no object storage) the picker shows a clear
        // message instead of an upload control, and no `onUpload` is wired so a
        // file can't start an intent the server would only reject.
        uploadsDisabled={room.uploadAvailability?.enabled === false}
        onUpload={room.uploadAvailability?.enabled === false ? undefined : uploadLocalVideo}
        // The live engine state and controls, so the picker can show a recovery
        // card before a file is chosen and offer a same-session retry after a
        // transient failure.
        uploadSnapshot={uploader.snapshot}
        onUploadPause={uploader.pause}
        onUploadResume={uploader.resume}
        onUploadCancel={uploader.cancel}
        onUploadRetry={uploader.retry}
        currentLabel={room.source?.label}
      />

      <RoomSettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        settings={room.settings}
        isHost={room.isHost}
        onUpdate={room.updateSettings}
        appSettings={appSettings}
        onAppSettingChange={updateAppSettings}
      />

      {/* a quiet flourish: someone just joined */}
      <AnimatePresence>
        {room.members.length > 1 && (
          <motion.div
            key="together"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 0 }}
            transition={{ duration: 2.4 }}
            className="pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2"
          >
            <span className="inline-flex items-center gap-2 rounded-full glass-deep px-4 py-2 text-[0.75rem] text-white/80">
              <Heart size={12} className="text-rose-400" fill="currentColor" />
              You are watching together
            </span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
