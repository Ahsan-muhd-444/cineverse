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
  Square,
  Trash2,
  X,
} from 'lucide-react';
import type { ChatMessage } from '@/lib/types';
import { Avatar, EmptyState } from '@/components/ui/Bits';
import { cn, fileToDataUrl, formatBytes, formatTime } from '@/lib/utils';

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

  return (
    <AnimatePresence>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={onClose} />
          <motion.div
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
                    tab === t ? 'bg-white/12 text-white' : 'text-white/45 hover:text-white',
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
                    <p className="mb-2 text-eyebrow uppercase text-white/30">{group.label}</p>
                    <div className="grid grid-cols-6 gap-1">
                      {group.emojis.map((emoji) => (
                        <button
                          key={emoji}
                          onClick={() => onPick(emoji)}
                          className="grid h-9 place-items-center rounded-xl text-xl transition-all duration-200 hover:scale-125 hover:bg-white/10"
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
                        background: `linear-gradient(150deg, hsl(${gif.hue} 80% 55% / 0.5), hsl(${gif.hue + 40} 80% 40% / 0.25))`,
                      }}
                    >
                      <span className="absolute inset-0 grid place-items-center text-3xl transition-transform duration-500 group-hover:scale-125">
                        {gif.emoji}
                      </span>
                      <span className="absolute inset-x-0 bottom-0 bg-black/45 py-1 text-[0.625rem] text-white/80 backdrop-blur-sm">
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
        className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white/15 text-white transition-colors hover:bg-white/25"
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

      <span className="shrink-0 font-mono text-[0.6875rem] text-white/50">{formatTime(duration)}</span>
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

const QUICK_REACTIONS = ['❤️', '😂', '😮', '🔥', '👏'];

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
  const [showActions, setShowActions] = React.useState(false);

  if (message.kind === 'system') {
    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        className="my-3 flex justify-center"
      >
        <span className="rounded-full bg-white/[0.06] px-3 py-1 text-[0.6875rem] text-white/40">{message.text}</span>
      </motion.div>
    );
  }

  const seen = showReceipt && lastSeen >= message.ts;

  return (
    <motion.div
      layout="position"
      initial={{ opacity: 0, y: 12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ type: 'spring', stiffness: 420, damping: 34 }}
      className={cn('group/msg flex gap-2.5', mine ? 'flex-row-reverse' : 'flex-row', grouped ? 'mt-1' : 'mt-4')}
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
    >
      <div className="w-8 shrink-0">
        {!grouped && !mine && <Avatar name={message.author || '?'} color={message.color} size={32} />}
      </div>

      <div className={cn('min-w-0 max-w-[82%]', mine ? 'items-end' : 'items-start', 'flex flex-col')}>
        {!grouped && (
          <span className={cn('mb-1 px-1 text-[0.6875rem] text-white/35', mine && 'text-right')}>
            {mine ? 'You' : message.author} ·{' '}
            {new Date(message.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        )}

        <div
          className={cn(
            'relative overflow-hidden rounded-2xl border px-3.5 py-2.5 text-[0.875rem] leading-relaxed backdrop-blur-xl',
            mine
              ? 'border-royal-400/25 bg-[linear-gradient(135deg,rgba(124,58,237,0.35),rgba(59,108,246,0.22))] text-white'
              : 'border-white/10 bg-white/[0.07] text-white/90',
            grouped && (mine ? 'rounded-tr-md' : 'rounded-tl-md'),
            message.kind === 'image' || message.kind === 'gif' ? 'p-1.5' : '',
          )}
        >
          {message.kind === 'text' && (
            <p
              className={cn(
                'whitespace-pre-wrap break-words',
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
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white/12">
                <FileText size={16} />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[0.8125rem] font-medium">{message.fileName}</span>
                <span className="block text-[0.6875rem] text-white/45">{formatBytes(message.size || 0)}</span>
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
                className="flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.07] px-2 py-0.5 text-[0.6875rem] transition-colors hover:bg-white/15"
              >
                <span>{emoji}</span>
                <span className="text-white/50">{users.length}</span>
              </button>
            ))}
          </div>
        )}

        {mine && showReceipt && (
          <span className="mt-1 flex items-center gap-1 px-1 text-[0.625rem] text-white/30">
            {seen ? <CheckCheck size={11} className="text-electric-400" /> : <Check size={11} />}
            {seen ? 'Seen' : 'Sent'}
          </span>
        )}
      </div>

      {/* hover reactions */}
      <AnimatePresence>
        {showActions && (
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            className="flex items-center self-center rounded-full glass-deep p-0.5"
          >
            {QUICK_REACTIONS.map((emoji) => (
              <button
                key={emoji}
                onClick={() => onReact(emoji)}
                aria-label={`React with ${emoji}`}
                className="grid h-6 w-6 place-items-center rounded-full text-xs transition-transform hover:scale-125"
              >
                {emoji}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
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
  onSend: (payload: Partial<ChatMessage> & { kind: ChatMessage['kind'] }) => void;
  onTyping: (isTyping: boolean) => void;
  onReact: (messageId: string, emoji: string) => void;
}) {
  const [draft, setDraft] = React.useState('');
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [uploading, setUploading] = React.useState(false);
  const [atBottom, setAtBottom] = React.useState(true);

  const listRef = React.useRef<HTMLDivElement>(null);
  const bottomRef = React.useRef<HTMLDivElement>(null);
  const typingTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
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

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    onSend({ kind: 'text', text });
    setDraft('');
    onTyping(false);
  };

  const handleDraft = (value: string) => {
    setDraft(value);
    onTyping(true);
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => onTyping(false), 1400);
  };

  const attach = async (file: File, kind: 'image' | 'file') => {
    if (file.size > 8 * 1024 * 1024) {
      onSend({ kind: 'text', text: `(tried to send ${file.name} — files must be under 8 MB)` });
      return;
    }
    setUploading(true);
    try {
      const data = await fileToDataUrl(file);
      onSend({
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
        onSend({
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
    <div className="flex h-full min-h-0 flex-col">
      {/* ---------- messages ---------- */}
      <div
        ref={listRef}
        onScroll={onScroll}
        className="relative min-h-0 flex-1 overflow-y-auto px-3 py-2"
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
              <span className="text-[0.6875rem] text-white/35">
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
            className="mx-auto -mt-10 mb-2 rounded-full glass-deep px-3 py-1.5 text-[0.6875rem] text-white/70"
          >
            Jump to latest
          </motion.button>
        )}
      </AnimatePresence>

      {/* ---------- composer ---------- */}
      <div className="relative border-t border-white/[0.07] p-3">
        {recorder.recording ? (
          <div className="flex items-center gap-3 rounded-2xl border border-rose-400/30 bg-rose-500/10 px-4 py-3">
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-400 opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-rose-400" />
            </span>
            <span className="font-mono text-sm text-rose-100">{formatTime(recorder.elapsed)}</span>
            <span className="text-[0.6875rem] text-white/45">Recording…</span>
            <div className="ml-auto flex gap-1.5">
              <button
                onClick={recorder.cancel}
                aria-label="Discard recording"
                className="grid h-9 w-9 place-items-center rounded-xl text-white/60 transition-colors hover:bg-white/10 hover:text-white"
              >
                <Trash2 size={15} />
              </button>
              <button
                onClick={toggleRecording}
                aria-label="Send voice note"
                className="grid h-9 w-9 place-items-center rounded-xl bg-white text-black transition-transform hover:scale-105"
              >
                <Send size={15} />
              </button>
            </div>
          </div>
        ) : (
          <div className="relative flex items-end gap-1.5 rounded-2xl glass-soft p-1.5 transition-all duration-400 focus-within:border-white/25 focus-within:shadow-glow-royal">
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

            <button
              onClick={() => setPickerOpen((v) => !v)}
              aria-label="Emoji and GIFs"
              aria-expanded={pickerOpen}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-xl text-white/45 transition-colors hover:bg-white/10 hover:text-white"
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
              className="max-h-28 min-h-[2.25rem] flex-1 resize-none bg-transparent py-2 text-[0.875rem] text-white outline-none placeholder:text-white/30"
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
                className="grid h-9 w-9 place-items-center rounded-xl text-white/45 transition-colors hover:bg-white/10 hover:text-white"
              >
                <ImagePlus size={16} />
              </button>
              <button
                onClick={() => fileInput.current?.click()}
                aria-label="Attach a file"
                className="hidden h-9 w-9 place-items-center rounded-xl text-white/45 transition-colors hover:bg-white/10 hover:text-white sm:grid"
              >
                <Paperclip size={16} />
              </button>
              <button
                onClick={toggleRecording}
                aria-label="Record a voice note"
                className="grid h-9 w-9 place-items-center rounded-xl text-white/45 transition-colors hover:bg-white/10 hover:text-white"
              >
                <Mic size={16} />
              </button>

              <motion.button
                whileTap={{ scale: 0.9 }}
                onClick={submit}
                disabled={!draft.trim() || uploading}
                aria-label="Send message"
                className={cn(
                  'grid h-9 w-9 place-items-center rounded-xl transition-all duration-300',
                  draft.trim()
                    ? 'bg-[linear-gradient(120deg,#7c3aed,#22d3ee)] text-white shadow-[0_8px_24px_-8px_rgba(124,58,237,0.9)]'
                    : 'text-white/25',
                )}
              >
                <Send size={15} />
              </motion.button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
