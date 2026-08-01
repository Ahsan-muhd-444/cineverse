'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowRight, Copy, KeyRound, Link2, Loader2, LogIn, Shuffle, Sparkles, UserRound, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { GlassCard } from '@/components/ui/GlassCard';
import { CodeInput, Input } from '@/components/ui/Input';
import { Badge, Segmented, Switch, useToast } from '@/components/ui/Bits';
import {
  clearRecentRooms,
  forgetRoom,
  getProfile,
  getRecentRooms,
  rememberRoom,
  setProfile,
  type RecentRoom,
} from '@/lib/storage';
import { getSocket } from '@/lib/socket';
import { colorFrom, copyToClipboard, makeRoomCode, normalizeRoomCode } from '@/lib/utils';

type Mode = 'create' | 'join';

export function Launchpad({ initialMode = 'create' }: { initialMode?: Mode }) {
  const router = useRouter();
  const toast = useToast();

  const [mode, setMode] = React.useState<Mode>(initialMode);
  const [name, setName] = React.useState('');
  const [code, setCode] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [usePassword, setUsePassword] = React.useState(false);
  const [waitingRoom, setWaitingRoom] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [recent, setRecent] = React.useState<RecentRoom[]>([]);

  React.useEffect(() => {
    setName(getProfile().name);
    setRecent(getRecentRooms());
  }, []);

  const persistName = (value: string) => {
    const trimmed = value.trim().slice(0, 24);
    setName(value);
    if (trimmed) setProfile({ name: trimmed, avatarColor: colorFrom(trimmed) });
  };

  const enter = (roomCode: string, extra?: { password?: string }) => {
    rememberRoom(roomCode);
    const query = extra?.password ? `?k=${encodeURIComponent(extra.password)}` : '';
    router.push(`/room/${roomCode}${query}`);
  };

  const handleCreate = async () => {
    if (!name.trim()) {
      setError('Tell us what to call you first.');
      return;
    }
    setBusy(true);
    setError(null);

    const socket = getSocket();
    const desiredCode = code ? normalizeRoomCode(code) : makeRoomCode();

    const result = await new Promise<{ ok: boolean; code?: string }>((resolve) => {
      const timeout = setTimeout(() => resolve({ ok: false }), 8000);
      socket.emit(
        'room:create',
        {
          code: desiredCode,
          password: usePassword ? password : null,
          waitingRoom,
        },
        (res: { ok: boolean; code: string }) => {
          clearTimeout(timeout);
          resolve(res);
        },
      );
    });

    setBusy(false);
    if (!result.ok || !result.code) {
      setError('Could not reach the room service. Check your connection and try again.');
      return;
    }
    enter(result.code, usePassword && password ? { password } : undefined);
  };

  const handleJoin = async () => {
    const target = normalizeRoomCode(code);
    if (!name.trim()) {
      setError('Tell us what to call you first.');
      return;
    }
    if (target.length < 4) {
      setError('Room codes are six characters.');
      return;
    }

    setBusy(true);
    setError(null);
    const socket = getSocket();

    const probe = await new Promise<{ ok: boolean; exists?: boolean; hasPassword?: boolean; locked?: boolean }>(
      (resolve) => {
        const timeout = setTimeout(() => resolve({ ok: false }), 8000);
        socket.emit('room:probe', { code: target }, (res: { ok: boolean; exists: boolean }) => {
          clearTimeout(timeout);
          resolve(res);
        });
      },
    );

    setBusy(false);

    if (!probe.ok) {
      setError('Could not reach the room service. Check your connection and try again.');
      return;
    }
    if (!probe.exists) {
      setError(`Room ${target} is not open. Ask for a fresh link, or create it yourself.`);
      return;
    }
    if (probe.locked) {
      setError('That room is locked by its host right now.');
      return;
    }
    enter(target);
  };

  const shareLink = React.useCallback(
    async (roomCode: string) => {
      const url = `${window.location.origin}/room/${roomCode}`;
      const ok = await copyToClipboard(url);
      toast(ok ? 'Invite link copied' : url, ok ? 'success' : 'default');
    },
    [toast],
  );

  return (
    <GlassCard tone="deep" className="relative w-full overflow-visible p-6 sm:p-8" glow>
      <span
        aria-hidden
        // Royal-purple bloom removed: the launch form should be the clearest
        // object on the page through contrast and elevation, not a colour wash.
        className="pointer-events-none absolute inset-0"
      />

      <div className="relative flex items-center justify-between gap-4">
        <div>
          <h2 className="font-display text-display-sm text-white">Open the room</h2>
          <p className="mt-1.5 text-sm text-supporting">Takes about four seconds.</p>
        </div>
        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: 'create', label: 'Create', icon: <Sparkles size={13} /> },
            { value: 'join', label: 'Join', icon: <LogIn size={13} /> },
          ]}
        />
      </div>

      <div className="relative mt-7 space-y-5">
        <Input
          label="Your name"
          value={name}
          onChange={(e) => persistName(e.target.value)}
          placeholder="What should they see?"
          maxLength={24}
          icon={<UserRound size={16} />}
          autoComplete="nickname"
        />

        <AnimatePresence mode="wait" initial={false}>
          {mode === 'create' ? (
            <motion.div
              key="create"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
              className="space-y-5"
            >
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[0.8125rem] font-medium text-secondary">Room code</span>
                  <button
                    type="button"
                    onClick={() => setCode(makeRoomCode())}
                    className="inline-flex min-h-11 items-center gap-1.5 px-2 text-xs text-muted transition-colors duration-[160ms] ease-swift hover:text-primary"
                  >
                    <Shuffle size={12} />
                    Shuffle
                  </button>
                </div>
                <CodeInput value={code} onChange={setCode} />
                <p className="mt-2 text-xs text-supporting">Leave it blank and we will pick one for you.</p>
              </div>

              <div className="rounded-2xl glass-soft p-3.5">
                <Switch
                  checked={usePassword}
                  onChange={setUsePassword}
                  label="Password protect"
                  description="Anyone with the link still needs the passphrase."
                />
                <AnimatePresence>
                  {usePassword && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
                      className="overflow-hidden"
                    >
                      <div className="pt-3">
                        <Input
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                          placeholder="Room passphrase"
                          icon={<KeyRound size={15} />}
                          autoComplete="off"
                          maxLength={64}
                        />
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                <div className="mt-1 border-t border-white/[0.07] pt-1">
                  <Switch
                    checked={waitingRoom}
                    onChange={setWaitingRoom}
                    label="Waiting room"
                    description="You approve each person before they can see the screen."
                  />
                </div>
              </div>

              <Button variant="primary" size="lg" className="w-full" onClick={handleCreate} loading={busy}>
                {!busy && <Sparkles size={16} />}
                Create room
                <ArrowRight size={16} className="ml-auto opacity-70" />
              </Button>
            </motion.div>
          ) : (
            <motion.div
              key="join"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.32, ease: [0.16, 1, 0.3, 1] }}
              className="space-y-5"
            >
              <div>
                <span className="mb-2 block text-[0.8125rem] font-medium text-secondary">Room code</span>
                <CodeInput value={code} onChange={setCode} autoFocus />
              </div>

              <Button
                variant="primary"
                size="lg"
                className="w-full"
                onClick={handleJoin}
                loading={busy}
                disabled={code.length < 4}
              >
                {!busy && <LogIn size={16} />}
                Join room
                <ArrowRight size={16} className="ml-auto opacity-70" />
              </Button>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {error && (
            <motion.p
              role="alert"
              initial={{ opacity: 0, y: -6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="rounded-2xl border border-rose-400/25 bg-rose-500/10 px-4 py-3 text-[0.8125rem] text-rose-200"
            >
              {error}
            </motion.p>
          )}
        </AnimatePresence>

        {recent.length > 0 && (
          <div className="border-t border-white/[0.07] pt-5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <p className="text-eyebrow uppercase text-muted">Recent rooms</p>
              {/* On a shared or borrowed device these codes are the one thing
                  worth being able to wipe, so the control is always in reach. */}
              <button
                onClick={() => {
                  clearRecentRooms();
                  setRecent([]);
                }}
                className="min-h-11 rounded-lg px-2 text-[0.75rem] text-muted transition-colors duration-[160ms] ease-swift hover:text-primary"
              >
                Clear
              </button>
            </div>
            <p className="mb-3 text-[0.75rem] leading-relaxed text-supporting">
              Saved on this device only — never shared with anyone. They disappear on their own after 12 hours.
            </p>
            <div className="flex flex-wrap gap-2">
              {recent.slice(0, 4).map((room) => (
                <div key={room.code} className="group flex items-center gap-1 rounded-2xl glass-soft p-1 pl-3">
                  <button
                    onClick={() => enter(room.code)}
                    className="min-h-11 rounded-xl px-2 font-mono text-[0.8125rem] font-medium tracking-widest text-primary transition-colors duration-[160ms] ease-swift hover:bg-white/[0.06]"
                  >
                    {room.code}
                  </button>
                  <button
                    onClick={() => shareLink(room.code)}
                    aria-label={`Copy invite link for room ${room.code}`}
                    className="grid h-11 w-11 place-items-center rounded-xl text-muted transition-colors duration-[160ms] ease-swift hover:bg-white/10 hover:text-primary"
                  >
                    <Copy size={12} />
                  </button>
                  <button
                    onClick={() => setRecent(forgetRoom(room.code))}
                    aria-label={`Forget room ${room.code} on this device`}
                    className="grid h-11 w-11 place-items-center rounded-xl text-muted transition-colors duration-[160ms] ease-swift hover:bg-white/10 hover:text-rose-300"
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex items-center gap-2 pt-1">
          <Badge tone="neutral">
            <Link2 size={11} />
            Share the link, that is the whole invite
          </Badge>
        </div>
      </div>

      {busy && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center rounded-3xl bg-ink-950/70">
          <Loader2 className="animate-spin text-gold-400" size={22} />
        </div>
      )}
    </GlassCard>
  );
}
