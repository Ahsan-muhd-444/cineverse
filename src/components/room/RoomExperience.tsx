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
  LogOut,
  MessageSquare,
  PanelRightClose,
  PanelRightOpen,
  Settings,
  Users,
} from 'lucide-react';
import { useRoom } from '@/hooks/useRoom';
import { useWebRTC } from '@/hooks/useWebRTC';
import { useSyncedPlayback, type PlayerHandle } from '@/hooks/useSyncedPlayback';
import { Player } from './Player';
import { Chat } from './Chat';
import { CallDock } from './CallDock';
import { SourcePicker } from './SourcePicker';
import { ConnectionPill, Participants, ReactionLayer, RoomClock, RoomSettingsModal } from './SidePanels';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { GlassCard } from '@/components/ui/GlassCard';
import { Avatar, Badge, Segmented, useToast } from '@/components/ui/Bits';
import { Aurora, Spotlight } from '@/components/fx/Ambient';
import { Wordmark } from '@/components/layout/Header';
import { findMovie } from '@/lib/catalog';
import { getSettings, saveProgress, setSettings, type AppSettings } from '@/lib/storage';
import { cn, copyToClipboard } from '@/lib/utils';
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
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-ink-900">
        <Aurora />
        <Spotlight />
        <div className="absolute inset-0 vignette" />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 22, scale: 0.97 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
        className="w-full max-w-md"
      >
        <GlassCard tone="deep" className="p-8" glow>
          <div className="mb-6 flex justify-center">
            <span className="grid h-14 w-14 place-items-center rounded-2xl bg-[linear-gradient(135deg,#7c3aed,#3b6cf6_55%,#22d3ee)] shadow-[0_14px_40px_-12px_rgba(124,58,237,0.9)]">
              {icon || <Clapperboard size={22} className="text-white" />}
            </span>
          </div>
          <h1 className="text-center font-display text-2xl font-semibold tracking-tight text-white balance">
            {title}
          </h1>
          {body && <p className="mx-auto mt-3 max-w-sm text-center text-sm leading-relaxed text-white/45 pretty">{body}</p>}
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
  const handleRef = React.useRef<PlayerHandle | null>(null);

  const [nameDraft, setNameDraft] = React.useState('');
  const [passwordDraft, setPasswordDraft] = React.useState('');
  const [localFile, setLocalFile] = React.useState<File | null>(null);
  const [sourceOpen, setSourceOpen] = React.useState(false);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [panel, setPanel] = React.useState<'chat' | 'people'>('chat');
  const [panelOpen, setPanelOpen] = React.useState(true);
  const [appSettings, setAppSettings] = React.useState<AppSettings>(getSettings);
  const [unread, setUnread] = React.useState(0);

  const memberIds = React.useMemo(() => room.members.map((m) => m.id), [room.members]);
  const call = useWebRTC(room.socket, memberIds, room.phase === 'ready');

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
    if (last.authorId === room.socket.id || last.kind === 'system') return;
    if (panel !== 'chat' || !panelOpen) setUnread((n) => n + 1);
  }, [room.messages, room.socket.id, panel, panelOpen]);

  React.useEffect(() => {
    if (panel === 'chat' && panelOpen) setUnread(0);
  }, [panel, panelOpen]);

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

  const chooseSource = (source: MediaSource) => {
    room.setSource(source);
    if (source.type !== 'local') setLocalFile(null);
  };

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
      <Gate title="Finding your room" body={`Connecting to ${code}…`}>
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
          <Link href="/#launchpad">
            <Button variant="primary" size="lg" className="w-full">
              Open my own room
            </Button>
          </Link>
          <Link href="/">
            <Button variant="ghost" size="lg" className="w-full">
              <ArrowLeft size={16} />
              Back home
            </Button>
          </Link>
        </div>
      </Gate>
    );
  }

  /* ---------------- the room itself ---------------- */

  return (
    <div className="relative flex min-h-dvh flex-col bg-ink-950">
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        <Aurora intensity={0.45} />
        <div className="absolute inset-0 bg-ink-950/55" />
      </div>

      {/* ---------- top bar ---------- */}
      <header className="relative z-40 border-b border-white/[0.07] bg-ink-900/60 backdrop-blur-2xl">
        <div className="flex items-center gap-3 px-4 py-3 sm:px-6">
          <Wordmark compact className="shrink-0" />

          <div className="hidden items-center gap-2 sm:flex">
            <span className="rounded-xl bg-white/[0.06] px-2.5 py-1.5 font-mono text-[0.8125rem] font-medium tracking-[0.18em] text-white/80">
              {code}
            </span>
            <button
              onClick={copyInvite}
              className="inline-flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-[0.75rem] text-white/45 transition-colors hover:bg-white/[0.07] hover:text-white"
            >
              <Copy size={12} />
              Invite
            </button>
          </div>

          {room.source && (
            <p className="ml-1 hidden min-w-0 max-w-[22ch] truncate text-[0.8125rem] text-white/45 lg:block">
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
              onClick={() => setSettingsOpen(true)}
              aria-label="Room settings"
              className="grid h-9 w-9 place-items-center rounded-xl text-white/50 transition-colors hover:bg-white/[0.07] hover:text-white"
            >
              <Settings size={16} />
            </button>

            <button
              onClick={() => setPanelOpen((v) => !v)}
              aria-label={panelOpen ? 'Hide side panel' : 'Show side panel'}
              className="hidden h-9 w-9 place-items-center rounded-xl text-white/50 transition-colors hover:bg-white/[0.07] hover:text-white lg:grid"
            >
              {panelOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
            </button>

            <button
              onClick={() => router.push('/')}
              aria-label="Leave room"
              className="grid h-9 w-9 place-items-center rounded-xl text-white/50 transition-colors hover:bg-rose-500/15 hover:text-rose-300"
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </header>

      {/* ---------- stage ---------- */}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <main id="main" className="flex min-w-0 flex-none flex-col p-3 sm:p-5 lg:flex-1 lg:justify-center">
          <div className="relative mx-auto w-full lg:max-w-[min(100%,calc((100dvh-15rem)*16/9))]">
            <Player
              source={room.source}
              localFile={localFile}
              handleRef={handleRef}
              onUserControl={sync.emitControl}
              onReady={handleReady}
              onProgress={onProgress}
              drift={sync.drift}
              overlay={<ReactionLayer socket={room.socket} />}
              emptyState={
                <div className="px-5 text-center sm:px-6">
                  <span className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-2xl glass-soft text-white/45 sm:mb-5 sm:h-16 sm:w-16 sm:rounded-3xl">
                    <Film size={22} />
                  </span>
                  <h2 className="font-display text-base font-semibold text-white sm:text-xl">
                    The screen is dark
                  </h2>
                  <p className="mx-auto mt-2 hidden max-w-sm text-[0.875rem] leading-relaxed text-white/40 pretty sm:block">
                    Pick something from Open Cinema, paste a video link, or load a file you both
                    have. Whatever you choose appears on their screen too.
                  </p>
                  <p className="mx-auto mt-1.5 max-w-[20rem] text-[0.8125rem] leading-relaxed text-white/40 pretty sm:hidden">
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
              <div className="absolute inset-x-4 bottom-20 z-40 mx-auto max-w-md rounded-2xl glass-deep p-4 text-center">
                <p className="text-[0.8125rem] text-white">
                  Your partner is playing <span className="font-medium">{room.source.label}</span>
                </p>
                <p className="mt-1 text-[0.75rem] text-white/45">
                  Open your own copy of the same file to stay in sync.
                </p>
                <Button variant="glass" size="sm" className="mt-3" onClick={() => setSourceOpen(true)}>
                  Load my copy
                </Button>
              </div>
            )}
          </div>

          {/* under-player bar */}
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button variant="glass" size="sm" onClick={() => setSourceOpen(true)}>
              <Film size={14} />
              {room.source ? 'Change film' : 'Choose a film'}
            </Button>

            <Button variant="ghost" size="sm" onClick={copyInvite} className="sm:hidden">
              <Copy size={14} />
              {code}
            </Button>

            <div className="ml-auto flex items-center gap-1">
              {FLY_EMOJIS.map((emoji) => (
                <button
                  key={emoji}
                  onClick={() => room.fly(emoji)}
                  aria-label={`Send ${emoji} to the screen`}
                  className="grid h-9 w-9 place-items-center rounded-xl text-lg transition-all duration-300 hover:scale-125 hover:bg-white/[0.07]"
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>

          {/* mobile panel toggle */}
          <div className="mt-3 lg:hidden">
            <Segmented
              value={panel}
              onChange={(next) => {
                setPanel(next);
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
                        <span className="grid h-4 min-w-4 place-items-center rounded-full bg-royal-500 px-1 text-[0.5625rem] text-white">
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
              className="flex min-h-0 flex-1 flex-col overflow-hidden border-white/[0.07] lg:w-[23rem] lg:flex-none lg:shrink-0 lg:border-l xl:w-[25rem]"
              aria-label="Room side panel"
            >
              <div className="flex min-h-0 flex-1 flex-col">
                <div className="hidden items-center gap-2 border-b border-white/[0.07] p-3 lg:flex">
                  <Segmented
                    value={panel}
                    onChange={setPanel}
                    size="sm"
                    options={[
                      {
                        value: 'chat',
                        label: (
                          <span className="inline-flex items-center gap-1.5">
                            Chat
                            {unread > 0 && (
                              <span className="grid h-4 min-w-4 place-items-center rounded-full bg-royal-500 px-1 text-[0.5625rem] text-white">
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

                <div className="border-b border-white/[0.07] p-3">
                  <CallDock
                    call={call}
                    myName={room.me?.name || 'You'}
                    myColor={room.me?.color}
                    peerNames={peerNames}
                  />
                </div>

                <div
                  className={cn(
                    'min-h-[22rem] flex-1 lg:min-h-0',
                    panel === 'chat' ? 'flex flex-col' : 'hidden',
                  )}
                >
                  <Chat
                    messages={room.messages}
                    myId={room.socket.id || ''}
                    typing={room.typing}
                    seenAt={room.seenAt}
                    onSend={room.send}
                    onTyping={room.setTyping}
                    onReact={room.react}
                  />
                </div>

                <div
                  className={cn(
                    'min-h-[22rem] flex-1 overflow-y-auto lg:min-h-0',
                    panel === 'people' ? 'block' : 'hidden',
                  )}
                >
                  <Participants
                    members={room.members}
                    lobby={room.lobby}
                    myId={room.socket.id || ''}
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
