'use client';

import * as React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Check,
  CheckCheck,
  Download,
  FileText,
  ImagePlus,
  Mic,
  Paperclip,
  Play,
  Send,
  Smile,
  SmilePlus,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import type { ChatMessage } from '@/lib/types';
import { Avatar, EmptyState } from '@/components/ui/Bits';
import { cn, fileToDataUrl, formatBytes, formatTime } from '@/lib/utils';
import { describeReaction, isDismissKey } from '@/lib/a11y';

/* ==========================================================================
   Emoji + GIF pickers
   ========================================================================== */

const EMOJI_GROUPS: { label: string; emojis: string[] }[] = [
  { label: 'Reactions', emojis: ['😂', '🥹', '😍', '🤯', '😱', '🥶', '😭', '🤣', '😳', '🙃', '😴', '🤌'] },
  { label: 'Hearts', emojis: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '💖', '💘', '💌', '💋', '🫶'] },
  { label: 'Cinema', emojis: ['🍿', '🎬', '🎞️', '📽️', '🎟️', '🌙', '✨', '🔥', '💫', '🎧', '🕯️', '🥂'] },
  { label: 'Hands', emojis: ['👏', '🙌', '👌', '🤝', '✌️', '🤞', '👀', '💯', '⭐', '🎉', '😇', '🫂'] },
];

/** A tiny, dependency-free GIF board built from openly hosted animated art. */
const GIF_LIBRARY = [
  { label: 'Popcorn', emoji: '🍿', hue: 38 },
  { label: 'Heart eyes', emoji: '😍', hue: 340 },
  { label: 'Crying', emoji: '😭', hue: 205 },
  { label: 'Shook', emoji: '😱', hue: 275 },
  { label: 'Clapping', emoji: '👏', hue: 25 },
  { label: 'Fire', emoji: '🔥', hue: 12 },
  { label: 'Sparkles', emoji: '✨', hue: 50 },
  { label: 'Hug', emoji: '🫂', hue: 300 },
];

function EmojiPicker({
  open,
  onClose,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (emoji: string) => void;
}) {
  const [tab, setTab] = React.useState<'emoji' | 'gif'>('emoji');
  const panelRef = React.useRef<HTMLDivElement>(null);
  // The caller passes an inline `onClose`, so its identity changes every render.
  // Depending on it directly made this effect tear down and re-register
  // continuously: the Escape listener was missing for part of every frame, and
  // the cleanup kept yanking focus back to the opener. Holding it in a ref keeps
  // the effect keyed on `open` alone, which is the only thing that matters.
  const onCloseRef = React.useRef(onClose);
  React.useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Escape closes the picker and hands focus back to whatever opened it —
  // otherwise a keyboard user closes the popover and lands nowhere.
  React.useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (!isDismissKey(e)) return;
      // Local overlay only: never let this bubble up and leave the room.
      e.stopPropagation();
      onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    const raf = requestAnimationFrame(() => panelRef.current?.querySelector('button')?.focus());
    return () => {
      window.removeEventListener('keydown', onKey);
      cancelAnimationFrame(raf);
      if (document.body.contains(opener)) opener?.focus?.();
    };
  }, [open]);

  return (
    <AnimatePresence>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={onClose} />
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-label="Emoji and GIF picker"
            initial={{ opacity: 0, y: 10, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
            className="absolute bottom-full left-0 z-40 mb-2 w-[min(20rem,calc(100vw-3rem))] overflow-hidden rounded-3xl glass-deep"
          >
            <div className="flex gap-1 border-b border-white/[0.07] p-2">
              {(['emoji', 'gif'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={cn(
                    'flex-1 rounded-xl px-3 py-1.5 text-xs font-medium capitalize transition-colors',
                    tab === t ? 'bg-white/[0.10] text-primary after:absolute after:inset-x-3 after:bottom-1 after:h-0.5 after:rounded-full after:bg-gold-400' : 'text-secondary hover:text-primary',
                  )}
                >
                  {t === 'gif' ? 'GIFs' : 'Emoji'}
                </button>
              ))}
            </div>

            <div className="max-h-64 overflow-y-auto p-3">
              {tab === 'emoji' ? (
                EMOJI_GROUPS.map((group) => (
                  <div key={group.label} className="mb-3 last:mb-0">
                    <p className="mb-2 text-eyebrow uppercase text-muted">{group.label}</p>
                    <div className="grid grid-cols-6 gap-1">
                      {group.emojis.map((emoji) => (
                        <button
                          key={emoji}
                          onClick={() => onPick(emoji)}
                          className="grid h-11 place-items-center rounded-xl text-xl transition-[transform,background-color] duration-[160ms] ease-swift hover:scale-[1.06] hover:bg-white/10"
                        >
                          {emoji}
                        </button>
                      ))}
                    </div>
                  </div>
                ))
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  {GIF_LIBRARY.map((gif) => (
                    <button
                      key={gif.label}
                      onClick={() => onPick(`${gif.emoji}${gif.emoji}${gif.emoji}`)}
                      className="group relative aspect-[4/3] overflow-hidden rounded-2xl border border-white/10"
                      style={{
                        // Was 80% saturation at 55% lightness — six neon tiles
                        // shouting next to a film. Now a muted tonal field over
                        // a warm-dark base: the hue still distinguishes cards,
                        // it just stops competing with the screen.
                        background: `linear-gradient(150deg, hsl(${gif.hue} 26% 26% / 0.9), hsl(${gif.hue + 30} 20% 15% / 0.95))`,
                      }}
                    >
                      <span className="absolute inset-0 grid place-items-center text-3xl transition-transform duration-[200ms] ease-swift group-hover:scale-[1.04]">
                        {gif.emoji}
                      </span>
                      <span className="absolute inset-x-0 bottom-0 bg-black/60 py-1 text-[0.6875rem] text-white backdrop-blur-sm">
                        {gif.label}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

/* ==========================================================================
   Voice note
   ========================================================================== */

function VoiceNote({ src, duration }: { src: string; duration: number }) {
  const audioRef = React.useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = React.useState(false);
  const [progress, setProgress] = React.useState(0);

  const bars = React.useMemo(
    () => Array.from({ length: 32 }, (_, i) => 0.25 + Math.abs(Math.sin(i * 1.7)) * 0.75),
    [],
  );

  return (
    <div className="flex items-center gap-3">
      <audio
        ref={audioRef}
        src={src}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setProgress(0);
        }}
        onTimeUpdate={(e) => {
          const el = e.currentTarget;
          if (el.duration) setProgress(el.currentTime / el.duration);
        }}
      />
      <button
        onClick={() => (playing ? audioRef.current?.pause() : audioRef.current?.play())}
        aria-label={playing ? 'Pause voice note' : 'Play voice note'}
        className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/25"
      >
        {playing ? <Square size={12} fill="currentColor" /> : <Play size={13} fill="currentColor" className="ml-0.5" />}
      </button>

      <div className="flex h-8 flex-1 items-center gap-[2px]">
        {bars.map((height, i) => {
          const active = i / bars.length <= progress;
          return (
            <span
              key={i}
              className={cn(
                'flex-1 rounded-full transition-colors duration-150',
                active ? 'bg-white' : 'bg-white/30',
                playing && 'animate-equalize',
              )}
              style={{ height: `${height * 100}%`, animationDelay: `${i * 40}ms` }}
            />
          );
        })}
      </div>

      <span className="shrink-0 font-mono text-[0.6875rem] text-muted">{formatTime(duration)}</span>
    </div>
  );
}

function useRecorder() {
  const [recording, setRecording] = React.useState(false);
  const [elapsed, setElapsed] = React.useState(0);
  const elapsedRef = React.useRef(0);
  const recorderRef = React.useRef<MediaRecorder | null>(null);
  const chunksRef = React.useRef<Blob[]>([]);
  const timerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const resolverRef = React.useRef<((value: { blob: Blob; duration: number } | null) => void) | null>(null);

  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => e.data.size && chunksRef.current.push(e.data);
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
        resolverRef.current?.({ blob, duration: elapsedRef.current });
        resolverRef.current = null;
      };
      recorder.start();
      recorderRef.current = recorder;
      setRecording(true);
      setElapsed(0);
      elapsedRef.current = 0;
      timerRef.current = setInterval(() => {
        elapsedRef.current += 0.1;
        setElapsed(elapsedRef.current);
      }, 100);
      return true;
    } catch {
      return false;
    }
  };

  const stop = () =>
    new Promise<{ blob: Blob; duration: number } | null>((resolve) => {
      if (!recorderRef.current || recorderRef.current.state === 'inactive') return resolve(null);
      resolverRef.current = resolve;
      if (timerRef.current) clearInterval(timerRef.current);
      setRecording(false);
      recorderRef.current.stop();
    });

  const cancel = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    resolverRef.current = null;
    setRecording(false);
    if (recorderRef.current?.state !== 'inactive') recorderRef.current?.stop();
  };

  return { recording, elapsed, start, stop, cancel };
}

/* ==========================================================================
   Message bubble
   ========================================================================== */

const QUICK_REACTIONS = ['❤️', '😂', '🔥', '😮', '🍿', '👏'];

/** True when a message is only emoji (and short) — those get rendered large. */
function isEmojiOnly(text?: string): boolean {
  if (!text) return false;
  const stripped = text.replace(/\s/g, '');
  if (!stripped || stripped.length > 12) return false;
  return !/[0-9A-Za-zÀ-ɏЀ-ӿ؀-ۿ]/.test(stripped);
}

function Bubble({
  message,
  mine,
  grouped,
  onReact,
  lastSeen,
  showReceipt,
}: {
  message: ChatMessage;
  mine: boolean;
  grouped: boolean;
  onReact: (emoji: string) => void;
  lastSeen: number;
  showReceipt: boolean;
}) {
  const [pickerOpen, setPickerOpen] = React.useState(false);
  // Whether the picker opens above the trigger (default) or below — flipped when
  // the message sits near the top of the list, where "above" would be clipped
  // by the scroll container.
  const [dropUp, setDropUp] = React.useState(true);
  const reactRef = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);

  const togglePicker = React.useCallback(() => {
    const el = reactRef.current;
    if (el) {
      const list = el.closest('[role="log"]');
      const listTop = list ? list.getBoundingClientRect().top : 0;
      setDropUp(el.getBoundingClientRect().top - listTop > 56);
    }
    setPickerOpen((v) => !v);
  }, []);

  // Close the anchored reaction picker on an outside click or Escape, and give
  // focus back to the trigger so a keyboard user is not dropped at the top of
  // the document.
  React.useEffect(() => {
    if (!pickerOpen) return;
    const trigger = triggerRef.current;
    const onDown = (e: MouseEvent) => {
      if (reactRef.current && !reactRef.current.contains(e.target as Node)) setPickerOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (!isDismissKey(e)) return;
      e.stopPropagation();
      setPickerOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      if (document.body.contains(trigger)) trigger?.focus?.();
    };
  }, [pickerOpen]);

  const isLongMessage = Boolean(message.text && message.text.length > 120);

  if (message.kind === 'system') {
    return (
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
        className="my-3 flex items-center gap-3 px-2"
      >
        {/* Editorial timeline annotation: hairline rules either side of quiet
            centred text, rather than a filled pill that read as a disabled
            control. */}
        <span aria-hidden className="h-px flex-1 bg-white/[0.07]" />
        <span className="shrink-0 text-center text-[0.6875rem] text-supporting">{message.text}</span>
        <span aria-hidden className="h-px flex-1 bg-white/[0.07]" />
      </motion.div>
    );
  }

  const seen = showReceipt && lastSeen >= message.ts;

  return (
    <motion.div
      layout="position"
      // Opacity plus a short rise. The spring's scale made every arriving
      // message pop, which is a lot of movement beside a film.
      initial={{ opacity: 0, y: 7 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
      className={cn('group/msg flex min-w-0 items-end gap-2', mine ? 'flex-row-reverse' : 'flex-row', grouped ? 'mt-1' : 'mt-4')}
    >
      <div className="w-8 shrink-0 self-start">
        {!grouped && !mine && <Avatar name={message.author || '?'} color={message.color} size={32} />}
      </div>

      <div
        className={cn(
          'flex min-w-0 max-w-[82%] flex-col lg:max-w-[min(78%,18rem)]',
          mine ? 'items-end' : 'items-start',
        )}
      >
        {!grouped && (
          <span className={cn('mb-1 px-1 text-[0.6875rem] text-muted', mine && 'text-right')}>
            {mine ? 'You' : message.author} ·{' '}
            {new Date(message.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        )}

        <div
          className={cn(
            // No backdrop blur and no persistent shadow: every bubble reading
            // as its own glass card is what made the rail feel busy. Outgoing is
            // identified by a slightly lifted neutral surface and a warm hairline
            // — not by being the brightest thing on screen.
            'relative min-w-0 max-w-full overflow-hidden rounded-[1.15rem] border px-3 py-2 text-[0.875rem] leading-relaxed',
            mine
              ? 'border-gold-400/25 bg-white/[0.085] text-primary'
              : 'border-white/[0.07] bg-white/[0.035] text-primary',
            grouped && (mine ? 'rounded-tr-md' : 'rounded-tl-md'),
            // Wall-of-text messages read calmer a touch smaller and tighter.
            isLongMessage && 'px-2.5 text-[0.8125rem]',
            message.kind === 'image' || message.kind === 'gif' ? 'p-1.5' : '',
          )}
        >
          {message.kind === 'text' && (
            <p
              className={cn(
                'min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere] [word-break:break-word]',
                // A message that is nothing but emoji reads better oversized.
                isEmojiOnly(message.text) && 'py-1 text-3xl leading-tight',
              )}
            >
              {message.text}
            </p>
          )}

          {(message.kind === 'image' || message.kind === 'gif') && message.data && (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={message.data}
                alt={message.fileName || 'Shared image'}
                className="max-h-64 w-full rounded-xl object-cover"
                loading="lazy"
              />
              {message.text && <p className="px-2 pb-1 pt-2">{message.text}</p>}
            </>
          )}

          {message.kind === 'voice' && message.data && (
            <div className="w-56 sm:w-64">
              <VoiceNote src={message.data} duration={message.duration || 0} />
            </div>
          )}

          {message.kind === 'file' && message.data && (
            <a
              href={message.data}
              download={message.fileName}
              className="flex items-center gap-3 pr-1 transition-opacity hover:opacity-80"
            >
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-white/12">
                <FileText size={16} />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[0.8125rem] font-medium">{message.fileName}</span>
                <span className="block text-[0.6875rem] text-muted">{formatBytes(message.size || 0)}</span>
              </span>
              <Download size={14} className="ml-1 shrink-0 opacity-60" />
            </a>
          )}
        </div>

        {/* reactions */}
        {message.reactions && Object.keys(message.reactions).length > 0 && (
          <div className={cn('mt-1 flex flex-wrap gap-1', mine && 'justify-end')}>
            {Object.entries(message.reactions).map(([emoji, users]) => (
              <button
                key={emoji}
                onClick={() => onReact(emoji)}
                aria-label={describeReaction(emoji, users.length)}
                className="flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.07] px-2 py-0.5 text-[0.6875rem] transition-colors hover:bg-white/15"
              >
                <span aria-hidden>{emoji}</span>
                <span aria-hidden className="text-secondary">{users.length}</span>
              </button>
            ))}
          </div>
        )}

        {mine && showReceipt && (
          <span className="mt-1 flex items-center gap-1 px-1 text-[0.6875rem] text-muted">
            {/* Cyan stays on the READ indicator only — a read receipt is a
                realtime state. "Sent" remains neutral, and no bubble, glow or
                background carries the colour. */}
            {seen ? <CheckCheck size={12} className="text-electric-400" /> : <Check size={12} />}
            {seen ? 'Seen' : 'Sent'}
          </span>
        )}
      </div>

      {/* react: a subtle trigger (hover/focus only); the emoji bar opens on click,
          absolutely positioned so it never shifts the message row. */}
      <div ref={reactRef} className="relative self-center">
        <button
          ref={triggerRef}
          onClick={togglePicker}
          aria-label="React to message"
          aria-haspopup="menu"
          aria-expanded={pickerOpen}
          className={cn(
            'grid h-11 w-11 place-items-center rounded-full text-muted outline-none transition-opacity duration-200 hover:bg-white/10 hover:text-primary focus-visible:opacity-100',
            pickerOpen ? 'bg-white/10 text-white opacity-100' : 'opacity-0 group-hover/msg:opacity-100',
          )}
        >
          <SmilePlus size={14} />
        </button>

        {pickerOpen && (
          <div
            role="menu"
            className={cn(
              'absolute z-50 flex items-center gap-0.5 rounded-full glass-deep p-1 shadow-lg',
              dropUp ? 'bottom-full mb-1.5' : 'top-full mt-1.5',
              // Grow INWARD over the bubble, away from the panel edge: my
              // messages have the trigger on the left (row-reversed), so the
              // picker anchors left and grows right; others anchor right and
              // grow left. The old inverse anchoring clipped at the panel edge.
              mine ? 'left-0' : 'right-0',
            )}
          >
            {QUICK_REACTIONS.map((emoji) => (
              <button
                key={emoji}
                role="menuitem"
                onClick={() => {
                  onReact(emoji);
                  setPickerOpen(false);
                }}
                aria-label={`React with ${emoji}`}
                className="grid h-11 w-11 place-items-center rounded-full text-base transition-transform duration-[160ms] ease-swift hover:scale-[1.06]"
              >
                {emoji}
              </button>
            ))}
          </div>
        )}
      </div>
    </motion.div>
  );
}

/* ==========================================================================
   Panel
   ========================================================================== */

export function Chat({
  messages,
  myId,
  typing,
  seenAt,
  onSend,
  onTyping,
  onReact,
}: {
  messages: ChatMessage[];
  myId: string;
  typing: string[];
  seenAt: Record<string, number>;
  onSend: (
    payload: Partial<ChatMessage> & { kind: ChatMessage['kind'] },
  ) => void | Promise<{ ok: true; id?: string } | { ok: false; error: string; retryAfterMs?: number }>;
  onTyping: (isTyping: boolean) => void;
  onReact: (messageId: string, emoji: string) => void;
}) {
  const [draft, setDraft] = React.useState('');
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const [sendError, setSendError] = React.useState<string | null>(null);

  /** Send, and surface a server rejection instead of dropping it silently. */
  const trySend = React.useCallback(
    async (payload: Partial<ChatMessage> & { kind: ChatMessage['kind'] }) => {
      setSendError(null);
      const result = await onSend(payload);
      if (!result || result.ok) return true;
      setSendError(
        result.error === 'RATE_LIMITED'
          ? 'You’re sending too quickly. Try again in a moment.'
          : result.error === 'TOO_LARGE'
            ? 'That attachment is too large.'
            : result.error === 'BAD_DATA'
              ? 'That file could not be read.'
              : 'Message could not be sent.',
      );
      return false;
    },
    [onSend],
  );

  // Clear a stale error once anything succeeds or the room moves on.
  React.useEffect(() => {
    if (!sendError) return;
    const id = setTimeout(() => setSendError(null), 6000);
    return () => clearTimeout(id);
  }, [sendError]);
  const [atBottom, setAtBottom] = React.useState(true);

  const listRef = React.useRef<HTMLDivElement>(null);
  const bottomRef = React.useRef<HTMLDivElement>(null);
  const typingTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // Whether a typing session is currently open, so only ONE `typing:true` is
  // sent per burst instead of one per keystroke.
  const typingActiveRef = React.useRef(false);
  const imageInput = React.useRef<HTMLInputElement>(null);
  const fileInput = React.useRef<HTMLInputElement>(null);
  const recorder = useRecorder();

  const lastSeen = React.useMemo(() => {
    const others = Object.entries(seenAt).filter(([id]) => id !== myId);
    return others.reduce((max, [, at]) => Math.max(max, at), 0);
  }, [seenAt, myId]);

  /* Auto-scroll, but only when the reader is already at the bottom. */
  React.useEffect(() => {
    if (atBottom) bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, typing, atBottom]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 90);
  };

  /** End the current typing session, if one is open. */
  const stopTyping = React.useCallback(() => {
    if (typingTimer.current) {
      clearTimeout(typingTimer.current);
      typingTimer.current = null;
    }
    if (!typingActiveRef.current) return;
    typingActiveRef.current = false;
    onTyping(false);
  }, [onTyping]);

  const submit = async () => {
    const text = draft.trim();
    if (!text) return;
    // Clear optimistically so typing feels instant, but restore the draft if the
    // server refused — a rejected message must never just vanish.
    setDraft('');
    stopTyping();
    const ok = await trySend({ kind: 'text', text });
    if (!ok) setDraft((current) => current || text);
  };

  /**
   * Typing is a SESSION, not a per-keystroke event. Emitting `typing:true` on
   * every character let a fast typist drain the server's background budget —
   * which, before the buckets were split, could suppress playback heartbeats.
   * One `true` opens the session; the idle timer closes it with one `false`.
   */
  const handleDraft = (value: string) => {
    setDraft(value);
    if (!typingActiveRef.current) {
      typingActiveRef.current = true;
      onTyping(true);
    }
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => {
      typingActiveRef.current = false;
      onTyping(false);
    }, 1400);
  };

  // Never leave a typing indicator stuck on for others after unmount.
  React.useEffect(() => stopTyping, [stopTyping]);

  const attach = async (file: File, kind: 'image' | 'file') => {
    if (file.size > 8 * 1024 * 1024) {
      onSend({ kind: 'text', text: `(tried to send ${file.name} — files must be under 8 MB)` });
      return;
    }
    setUploading(true);
    try {
      const data = await fileToDataUrl(file);
      await trySend({
        kind: file.type.startsWith('image/') ? 'image' : kind,
        data,
        fileName: file.name,
        mimeType: file.type,
        size: file.size,
      });
    } finally {
      setUploading(false);
    }
  };

  const toggleRecording = async () => {
    if (recorder.recording) {
      const result = await recorder.stop();
      if (!result) return;
      setUploading(true);
      try {
        const data = await fileToDataUrl(new File([result.blob], 'voice-note.webm', { type: result.blob.type }));
        await trySend({
          kind: 'voice',
          data,
          duration: result.duration,
          mimeType: result.blob.type,
          size: result.blob.size,
          fileName: 'voice-note.webm',
        });
      } finally {
        setUploading(false);
      }
    } else {
      const ok = await recorder.start();
      if (!ok) onSend({ kind: 'text', text: '(microphone unavailable — check browser permissions)' });
    }
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col lg:overflow-hidden">
      {/* ---------- messages (the ONLY scrolling region) ---------- */}
      <div
        ref={listRef}
        onScroll={onScroll}
        className="chat-scrollbar relative min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-3 py-2"
        role="log"
        aria-live="polite"
        aria-label="Room chat"
      >
        {messages.length === 0 ? (
          <EmptyState
            icon={<Smile size={20} />}
            title="Say something"
            body="Reactions, voice notes and photos all live here — right beside the film."
          />
        ) : (
          messages.map((message, i) => {
            const previous = messages[i - 1];
            const grouped =
              previous &&
              previous.kind !== 'system' &&
              message.kind !== 'system' &&
              previous.authorId === message.authorId &&
              message.ts - previous.ts < 90_000;
            return (
              <Bubble
                key={message.id}
                message={message}
                mine={message.authorId === myId}
                grouped={Boolean(grouped)}
                onReact={(emoji) => onReact(message.id, emoji)}
                lastSeen={lastSeen}
                showReceipt={i === messages.length - 1 && message.authorId === myId}
              />
            );
          })
        )}

        <AnimatePresence>
          {typing.length > 0 && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="mt-3 flex items-center gap-2.5 pl-10"
            >
              <span className="flex items-center gap-1 rounded-2xl border border-white/10 bg-white/[0.07] px-3 py-2.5">
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="h-1.5 w-1.5 animate-bounce rounded-full bg-white/60"
                    style={{ animationDelay: `${i * 140}ms` }}
                  />
                ))}
              </span>
              <span className="text-[0.6875rem] text-supporting">
                {typing.length === 1 ? `${typing[0]} is typing` : 'several people are typing'}
              </span>
            </motion.div>
          )}
        </AnimatePresence>

        <div ref={bottomRef} />
      </div>

      {/* ---------- jump to latest ---------- */}
      <AnimatePresence>
        {!atBottom && (
          <motion.button
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            onClick={() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' })}
            className="mx-auto -mt-10 mb-2 rounded-full elev-float px-3 py-1.5 text-[0.6875rem] text-secondary"
          >
            Jump to latest
          </motion.button>
        )}
      </AnimatePresence>

      {/* ---------- composer ---------- */}
      <div className="relative min-w-0 shrink-0 border-t border-white/[0.07] p-3">
        {/* Server refused this message (rate limit / oversized attachment).
            Only shown for real sends — never for typing, receipts or reactions. */}
        {sendError && (
          <p role="status" className="mb-2 px-1 text-[0.6875rem] leading-relaxed text-amber-300">
            {sendError}
          </p>
        )}
        {recorder.recording ? (
          <div className="flex items-center gap-3 rounded-2xl border border-rose-400/30 bg-rose-500/10 px-4 py-3">
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-rose-400" />
            </span>
            <span className="font-mono text-sm text-rose-100">{formatTime(recorder.elapsed)}</span>
            <span className="text-[0.6875rem] text-supporting">Recording…</span>
            <div className="ml-auto flex gap-1.5">
              <button
                onClick={recorder.cancel}
                aria-label="Discard recording"
                className="grid h-11 w-11 place-items-center rounded-xl text-white/60 transition-colors hover:bg-white/10 hover:text-white"
              >
                <Trash2 size={15} />
              </button>
              <button
                onClick={toggleRecording}
                aria-label="Send voice note"
                className="grid h-11 w-11 place-items-center rounded-xl bg-white text-black transition-transform hover:scale-105"
              >
                <Send size={15} />
              </button>
            </div>
          </div>
        ) : (
          // The OUTER wrapper owns popover positioning (no clipping); the inner
          // shell owns rounding + overflow containment. Keeping the picker
          // inside an overflow-hidden box would clip its bottom-full dropdown.
          <div className="relative min-w-0">
            <EmojiPicker
              open={pickerOpen}
              onClose={() => setPickerOpen(false)}
              onPick={(emoji) => {
                if (emoji.length > 2) {
                  // GIF board entries send as an oversized emoji burst.
                  onSend({ kind: 'text', text: emoji });
                  setPickerOpen(false);
                } else {
                  setDraft((d) => d + emoji);
                }
              }}
            />

            <div className="flex min-w-0 items-end gap-1.5 overflow-hidden rounded-2xl glass-soft p-1.5 transition-colors duration-300 focus-within:border-white/20">
            <button
              onClick={() => setPickerOpen((v) => !v)}
              aria-label="Emoji and GIFs"
              aria-expanded={pickerOpen}
              className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-muted transition-colors duration-[160ms] ease-swift hover:bg-white/10 hover:text-primary"
            >
              {pickerOpen ? <X size={16} /> : <Smile size={17} />}
            </button>

            <textarea
              value={draft}
              onChange={(e) => handleDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              rows={1}
              placeholder="Message…"
              aria-label="Write a message"
              className="max-h-28 min-h-11 min-w-0 flex-1 resize-none overflow-y-auto break-words bg-transparent py-3 text-[0.875rem] text-primary outline-none [overflow-wrap:anywhere] placeholder:text-muted"
            />

            <div className="flex shrink-0 items-center gap-0.5">
              <input
                ref={imageInput}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => e.target.files?.[0] && attach(e.target.files[0], 'image')}
              />
              <input
                ref={fileInput}
                type="file"
                className="hidden"
                onChange={(e) => e.target.files?.[0] && attach(e.target.files[0], 'file')}
              />

              <button
                onClick={() => imageInput.current?.click()}
                aria-label="Send an image"
                className="grid h-11 w-11 place-items-center rounded-xl text-muted transition-colors duration-[160ms] ease-swift hover:bg-white/10 hover:text-primary"
              >
                <ImagePlus size={16} />
              </button>
              <button
                onClick={() => fileInput.current?.click()}
                aria-label="Attach a file"
                className="hidden h-11 w-11 place-items-center rounded-xl text-muted transition-colors duration-[160ms] ease-swift hover:bg-white/10 hover:text-primary sm:grid"
              >
                <Paperclip size={16} />
              </button>
              <button
                onClick={toggleRecording}
                aria-label="Record a voice note"
                className="grid h-11 w-11 place-items-center rounded-xl text-muted transition-colors duration-[160ms] ease-swift hover:bg-white/10 hover:text-primary"
              >
                <Mic size={16} />
              </button>

              <motion.button
                whileTap={{ scale: 0.9 }}
                onClick={submit}
                disabled={!draft.trim() || uploading}
                aria-label="Send message"
                className={cn(
                  'grid h-11 w-11 place-items-center rounded-xl transition-all duration-300',
                  draft.trim()
                    ? 'bg-gold-500 text-ink-950 hover:bg-gold-400 active:bg-gold-600'
                    : 'text-muted',
                )}
              >
                <Send size={15} />
              </motion.button>
            </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
