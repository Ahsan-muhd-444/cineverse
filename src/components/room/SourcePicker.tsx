'use client';

import * as React from 'react';
import { Film, FolderOpen, Link2, Youtube } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Segmented } from '@/components/ui/Bits';
import { CATALOG, posterArt } from '@/lib/catalog';
import type { MediaSource } from '@/lib/types';
import { cn, isYouTubeUrl } from '@/lib/utils';

type Tab = 'catalog' | 'link' | 'local';

export function SourcePicker({
  open,
  onClose,
  onChoose,
  onLocalFile,
  currentLabel,
}: {
  open: boolean;
  onClose: () => void;
  onChoose: (source: MediaSource) => void;
  onLocalFile: (file: File) => void;
  currentLabel?: string;
}) {
  const [tab, setTab] = React.useState<Tab>('catalog');
  const [url, setUrl] = React.useState('');
  const [label, setLabel] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const fileInput = React.useRef<HTMLInputElement>(null);

  const submitUrl = () => {
    const trimmed = url.trim();
    if (!trimmed) return setError('Paste a link first.');
    const youtube = isYouTubeUrl(trimmed);
    if (!youtube && !/^https?:\/\//i.test(trimmed)) {
      return setError('That does not look like a web address.');
    }
    onChoose({
      type: youtube ? 'youtube' : 'url',
      value: trimmed,
      label: label.trim() || (youtube ? 'YouTube video' : 'Shared link'),
    });
    setError(null);
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title="What are we watching?"
      description={
        currentLabel ? `Currently playing “${currentLabel}”. Choosing something new resets both sides.` : undefined
      }
    >
      <Segmented
        value={tab}
        onChange={setTab}
        className="mb-6"
        options={[
          { value: 'catalog', label: 'Open Cinema', icon: <Film size={13} /> },
          { value: 'link', label: 'Link', icon: <Link2 size={13} /> },
          { value: 'local', label: 'Local file', icon: <FolderOpen size={13} /> },
        ]}
      />

      {tab === 'catalog' && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {CATALOG.map((movie) => (
            <button
              key={movie.id}
              onClick={() => {
                onChoose({
                  type: 'catalog',
                  value: movie.src,
                  label: movie.title,
                  poster: posterArt(movie, 'backdrop'),
                });
                onClose();
              }}
              className="group relative overflow-hidden rounded-2xl border border-white/10 text-left transition-all duration-500 hover:border-white/30 hover:shadow-lift"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={posterArt(movie)}
                alt=""
                className="aspect-[2/3] w-full object-cover transition-transform duration-700 group-hover:scale-105"
                loading="lazy"
              />
              <span className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent" />
              <span className="absolute inset-x-0 bottom-0 p-3">
                <span className="block font-display text-[0.8125rem] font-semibold leading-tight text-white">
                  {movie.title}
                </span>
                <span className="mt-0.5 block text-[0.625rem] text-white/45">
                  {movie.year} · {movie.runtime}m
                </span>
              </span>
            </button>
          ))}
        </div>
      )}

      {tab === 'link' && (
        <div className="space-y-5">
          <Input
            label="Video link"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              setError(null);
            }}
            placeholder="https://… .mp4, .webm, .m3u8 or a YouTube URL"
            icon={isYouTubeUrl(url) ? <Youtube size={16} /> : <Link2 size={16} />}
            error={error}
            data-autofocus
            onKeyDown={(e) => e.key === 'Enter' && submitUrl()}
          />
          <Input
            label="What should we call it?"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Optional"
            maxLength={60}
          />
          <div className="rounded-2xl bg-white/[0.04] p-4 text-[0.8125rem] leading-relaxed text-white/45">
            Direct video files play best. Most streaming services block embedding, so a Netflix or
            Prime link will not load here — use a direct file, a YouTube link, or the same local copy
            you both have.
          </div>
          <Button variant="primary" className="w-full" onClick={submitUrl}>
            Load this link
          </Button>
        </div>
      )}

      {tab === 'local' && (
        <div className="space-y-5">
          <input
            ref={fileInput}
            type="file"
            accept="video/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              onLocalFile(file);
              onChoose({ type: 'local', value: file.name, label: file.name });
              onClose();
            }}
          />
          <button
            onClick={() => fileInput.current?.click()}
            className={cn(
              'flex w-full flex-col items-center justify-center gap-3 rounded-3xl border border-dashed border-white/15 px-6 py-14',
              'transition-all duration-500 hover:border-electric-400/50 hover:bg-white/[0.04]',
            )}
          >
            <span className="grid h-12 w-12 place-items-center rounded-2xl glass-soft text-white/60">
              <FolderOpen size={20} />
            </span>
            <span className="text-sm font-medium text-white">Choose a video from this device</span>
            <span className="max-w-sm text-center text-[0.8125rem] leading-relaxed text-white/40">
              Nothing uploads. The file stays on your machine — your partner picks their own copy and
              the two playheads are kept in step.
            </span>
          </button>
        </div>
      )}
    </Modal>
  );
}
