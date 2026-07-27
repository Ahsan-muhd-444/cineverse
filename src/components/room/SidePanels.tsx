'use client';

import * as React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Check,
  Crown,
  DoorOpen,
  Lock,
  MicOff,
  MonitorUp,
  ShieldCheck,
  UserMinus,
  Video,
  X,
} from 'lucide-react';
import type { LobbyEntry, Member, RoomSettings } from '@/lib/types';
import { Avatar, Badge, Switch, Tooltip } from '@/components/ui/Bits';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { cn } from '@/lib/utils';

/* ==========================================================================
   Participants
   ========================================================================== */

export function Participants({
  members,
  lobby,
  myId,
  hostId,
  isHost,
  onDecide,
  onKick,
  onTransferHost,
}: {
  members: Member[];
  lobby: LobbyEntry[];
  myId: string;
  hostId: string | null;
  isHost: boolean;
  onDecide: (socketId: string, approve: boolean) => void;
  onKick: (socketId: string) => void;
  onTransferHost: (socketId: string) => void;
}) {
  return (
    <div className="flex flex-col gap-4 p-4">
      {/* waiting room */}
      <AnimatePresence>
        {isHost && lobby.length > 0 && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <p className="mb-2 flex items-center gap-1.5 text-eyebrow uppercase text-amber-300/80">
              <DoorOpen size={11} />
              Waiting to be let in
            </p>
            <div className="space-y-2">
              {lobby.map((person) => (
                <div
                  key={person.socketId}
                  className="flex items-center gap-2.5 rounded-2xl border border-amber-400/25 bg-amber-500/10 p-2.5"
                >
                  <Avatar name={person.name} size={30} />
                  <span className="min-w-0 flex-1 truncate text-[0.8125rem] text-white">{person.name}</span>
                  <button
                    onClick={() => onDecide(person.socketId, false)}
                    aria-label={`Deny ${person.name}`}
                    className="grid h-8 w-8 place-items-center rounded-xl text-white/45 transition-colors hover:bg-white/10 hover:text-rose-300"
                  >
                    <X size={14} />
                  </button>
                  <button
                    onClick={() => onDecide(person.socketId, true)}
                    aria-label={`Admit ${person.name}`}
                    className="grid h-8 w-8 place-items-center rounded-xl bg-emerald-500/25 text-emerald-100 transition-colors hover:bg-emerald-500/40"
                  >
                    <Check size={14} />
                  </button>
                </div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div>
        <p className="mb-2.5 text-eyebrow uppercase text-white/30">
          In the room · {members.length}
        </p>
        <div className="space-y-1.5">
          {members.map((member) => {
            const isMe = member.id === myId;
            return (
              <div
                key={member.id}
                className="group flex items-center gap-3 rounded-2xl px-2 py-2 transition-colors hover:bg-white/[0.05]"
              >
                <Avatar
                  name={member.name}
                  color={member.color}
                  size={34}
                  online
                  speaking={member.media?.mic && member.media?.inCall}
                />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 truncate text-[0.8125rem] font-medium text-white">
                    {member.name}
                    {isMe && <span className="text-white/35">(you)</span>}
                    {member.id === hostId && <Crown size={11} className="shrink-0 text-amber-300" />}
                  </p>
                  <p className="mt-0.5 flex items-center gap-2 text-[0.6875rem] text-white/35">
                    {member.media?.inCall ? (
                      <>
                        <span className="text-emerald-300">In call</span>
                        {!member.media.mic && <MicOff size={9} />}
                        {member.media.cam && <Video size={9} />}
                        {member.media.screen && <MonitorUp size={9} className="text-electric-300" />}
                      </>
                    ) : (
                      'Watching'
                    )}
                  </p>
                </div>

                {isHost && !isMe && (
                  <div className="flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                    <Tooltip label="Make host">
                      <button
                        onClick={() => onTransferHost(member.id)}
                        aria-label={`Make ${member.name} the host`}
                        className="grid h-8 w-8 place-items-center rounded-xl text-white/40 transition-colors hover:bg-white/10 hover:text-amber-300"
                      >
                        <Crown size={13} />
                      </button>
                    </Tooltip>
                    <Tooltip label="Remove">
                      <button
                        onClick={() => onKick(member.id)}
                        aria-label={`Remove ${member.name}`}
                        className="grid h-8 w-8 place-items-center rounded-xl text-white/40 transition-colors hover:bg-white/10 hover:text-rose-300"
                      >
                        <UserMinus size={13} />
                      </button>
                    </Tooltip>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {members.length < 2 && (
        <div className="rounded-2xl border border-dashed border-white/12 p-4 text-center">
          <p className="text-[0.8125rem] text-white/50">Just you so far</p>
          <p className="mt-1 text-[0.6875rem] leading-relaxed text-white/30">
            Send the invite link and their seat fills in instantly.
          </p>
        </div>
      )}
    </div>
  );
}

/* ==========================================================================
   Room settings
   ========================================================================== */

export function RoomSettingsModal({
  open,
  onClose,
  settings,
  isHost,
  onUpdate,
  appSettings,
  onAppSettingChange,
}: {
  open: boolean;
  onClose: () => void;
  settings: RoomSettings;
  isHost: boolean;
  onUpdate: (patch: Partial<{ password: string | null; waitingRoom: boolean; locked: boolean }>) => void;
  appSettings: { highContrast: boolean; reduceEffects: boolean; chatSounds: boolean };
  onAppSettingChange: (patch: Partial<{ highContrast: boolean; reduceEffects: boolean; chatSounds: boolean }>) => void;
}) {
  const [password, setPassword] = React.useState('');
  const [passwordOn, setPasswordOn] = React.useState(settings.hasPassword);

  React.useEffect(() => setPasswordOn(settings.hasPassword), [settings.hasPassword]);

  return (
    <Modal open={open} onClose={onClose} title="Room settings" description="Host controls and your own preferences.">
      <div className="space-y-6">
        <section>
          <h3 className="mb-1 flex items-center gap-2 text-eyebrow uppercase text-white/30">
            <ShieldCheck size={11} />
            The door
          </h3>
          <div className={cn('rounded-2xl glass-soft p-3.5', !isHost && 'pointer-events-none opacity-50')}>
            <Switch
              checked={settings.locked}
              onChange={(locked) => onUpdate({ locked })}
              label="Lock the room"
              description="Nobody new can join, even with the link."
              disabled={!isHost}
            />
            <div className="border-t border-white/[0.07]">
              <Switch
                checked={settings.waitingRoom}
                onChange={(waitingRoom) => onUpdate({ waitingRoom })}
                label="Waiting room"
                description="You approve each arrival before they see the screen."
                disabled={!isHost}
              />
            </div>
            <div className="border-t border-white/[0.07]">
              <Switch
                checked={passwordOn}
                onChange={(on) => {
                  setPasswordOn(on);
                  if (!on) onUpdate({ password: null });
                }}
                label="Passphrase"
                description="Required in addition to the link."
                disabled={!isHost}
              />
              <AnimatePresence>
                {passwordOn && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="overflow-hidden"
                  >
                    <div className="flex gap-2 pt-3">
                      <Input
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="New passphrase"
                        icon={<Lock size={14} />}
                        maxLength={64}
                      />
                      <Button
                        variant="glass"
                        onClick={() => {
                          onUpdate({ password });
                          setPassword('');
                        }}
                        disabled={!password}
                      >
                        Set
                      </Button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
          {!isHost && (
            <p className="mt-2 px-1 text-[0.6875rem] text-white/30">Only the host can change these.</p>
          )}
        </section>

        <section>
          <h3 className="mb-1 text-eyebrow uppercase text-white/30">Your experience</h3>
          <div className="rounded-2xl glass-soft p-3.5">
            <Switch
              checked={appSettings.highContrast}
              onChange={(highContrast) => onAppSettingChange({ highContrast })}
              label="High contrast"
              description="Stronger borders and text, no ambient effects."
            />
            <div className="border-t border-white/[0.07]">
              <Switch
                checked={appSettings.reduceEffects}
                onChange={(reduceEffects) => onAppSettingChange({ reduceEffects })}
                label="Reduce motion and blur"
                description="Lighter on older laptops and battery."
              />
            </div>
            <div className="border-t border-white/[0.07]">
              <Switch
                checked={appSettings.chatSounds}
                onChange={(chatSounds) => onAppSettingChange({ chatSounds })}
                label="Chat sounds"
                description="A soft chime when a message arrives."
              />
            </div>
          </div>
        </section>

        <section>
          <h3 className="mb-3 text-eyebrow uppercase text-white/30">Keyboard</h3>
          <div className="grid grid-cols-2 gap-2 text-[0.75rem]">
            {[
              ['Space / K', 'Play or pause'],
              ['← / →', 'Skip 5 seconds'],
              ['J / L', 'Skip 10 seconds'],
              ['↑ / ↓', 'Volume'],
              ['M', 'Mute'],
              ['F', 'Fullscreen'],
              ['C', 'Subtitles'],
              ['P', 'Picture in picture'],
            ].map(([key, action]) => (
              <div key={key} className="flex items-center justify-between rounded-xl bg-white/[0.04] px-3 py-2">
                <span className="text-white/45">{action}</span>
                <kbd className="rounded-md border border-white/12 bg-white/[0.07] px-1.5 py-0.5 font-mono text-[0.625rem] text-white/70">
                  {key}
                </kbd>
              </div>
            ))}
          </div>
        </section>
      </div>
    </Modal>
  );
}

/* ==========================================================================
   Floating reactions
   ========================================================================== */

export function ReactionLayer({ socket }: { socket: { on: Function; off: Function } }) {
  const [items, setItems] = React.useState<{ id: number; emoji: string; x: number }[]>([]);

  React.useEffect(() => {
    const onReaction = ({ emoji }: { emoji: string }) => {
      const id = Date.now() + Math.random();
      setItems((prev) => [...prev, { id, emoji, x: 10 + Math.random() * 80 }]);
      setTimeout(() => setItems((prev) => prev.filter((i) => i.id !== id)), 3200);
    };
    socket.on('room:reaction', onReaction);
    return () => socket.off('room:reaction', onReaction);
  }, [socket]);

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
      <AnimatePresence>
        {items.map((item) => (
          <motion.span
            key={item.id}
            initial={{ opacity: 0, y: 0, scale: 0.4 }}
            animate={{ opacity: [0, 1, 1, 0], y: -260, scale: [0.4, 1.25, 1, 0.9], x: [0, 14, -10, 6] }}
            exit={{ opacity: 0 }}
            transition={{ duration: 3, ease: 'easeOut' }}
            className="absolute bottom-16 text-4xl drop-shadow-[0_4px_18px_rgba(0,0,0,0.6)]"
            style={{ left: `${item.x}%` }}
          >
            {item.emoji}
          </motion.span>
        ))}
      </AnimatePresence>
    </div>
  );
}

/* ==========================================================================
   Small status bits
   ========================================================================== */

export function ConnectionPill({ quality, latency }: { quality: string; latency: number }) {
  const tone =
    quality === 'excellent'
      ? 'success'
      : quality === 'good'
        ? 'electric'
        : quality === 'fair'
          ? 'warn'
          : quality === 'offline'
            ? 'danger'
            : 'warn';

  return (
    <Badge tone={tone as 'success' | 'electric' | 'warn' | 'danger'}>
      <span className="flex items-end gap-[2px]">
        {[3, 6, 9].map((h, i) => (
          <span
            key={h}
            className={cn(
              'w-[2px] rounded-full bg-current transition-opacity',
              quality === 'offline' || (quality === 'poor' && i > 0) || (quality === 'fair' && i > 1)
                ? 'opacity-25'
                : 'opacity-100',
            )}
            style={{ height: h }}
          />
        ))}
      </span>
      <span className="capitalize">{quality === 'offline' ? 'Reconnecting' : quality}</span>
      {latency > 0 && quality !== 'offline' && <span className="opacity-60">{latency}ms</span>}
    </Badge>
  );
}

export function RoomClock() {
  const [now, setNow] = React.useState<Date | null>(null);

  React.useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(id);
  }, []);

  if (!now) return null;
  return (
    <span className="font-mono text-[0.75rem] tabular-nums text-white/40">
      {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
    </span>
  );
}
