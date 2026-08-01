'use client';

import * as React from 'react';
import { AlertTriangle, Film, FolderOpen, Link2, MonitorPlay, Search, Sparkles, UploadCloud, X, Youtube } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Segmented } from '@/components/ui/Bits';
import { CATALOG, posterArt } from '@/lib/catalog';
import type { MediaSource } from '@/lib/types';
import { cn } from '@/lib/utils';
import { extractYouTubeId, isYouTubeInput, normalizeMediaSource } from '@/lib/media';
import {
  RECOMMENDED_MOVIES,
  hasFullMovie,
  searchRecommended,
  toYouTubeSource,
  type RecommendedRegion,
} from '@/data/recommendedMovies';
import { describeUploadError, UploadError } from '@/lib/uploads';
import { SharedUploadProgress } from '@/components/room/SharedUploadProgress';
import type { UploadController, UploadSnapshot } from '@/lib/multipartUpload';

type Tab = 'catalog' | 'recommend' | 'link' | 'local';
type RecFilter = 'All' | RecommendedRegion;

export interface UploadOptions {
  onProgress?: (fraction: number) => void;
  /** Full live state: bytes, speed, ETA, parts, retry, phase. */
  onSnapshot?: (snapshot: UploadSnapshot) => void;
  /** Handed the controller so the picker can offer pause/resume/cancel. */
  onController?: (controller: UploadController) => void;
  signal?: AbortSignal;
}

export function SourcePicker({
  open,
  onClose,
  onChoose,
  onLocalFile,
  onUpload,
  uploadsDisabled,
  uploadSnapshot,
  onUploadPause,
  onUploadResume,
  onUploadCancel,
  onUploadRetry,
  currentLabel,
}: {
  open: boolean;
  onClose: () => void;
  onChoose: (source: MediaSource) => void;
  onLocalFile: (file: File) => void;
  /** Upload a local video to shared storage so BOTH members can stream it.
   *  Absent (or failing) uploads fall back to device-only playback. */
  onUpload?: (file: File, options: UploadOptions) => Promise<MediaSource>;
  /**
   * True when this deployment has hosted uploads turned off (a demo deploy with no
   * object storage). The local tab then shows a clear "not available yet" message
   * instead of an upload control that would only fail on submit.
   */
  uploadsDisabled?: boolean;
  /*
   * The ROOM-SCOPED engine state, supplied by the room rather than created here.
   * That is what lets a refresh-recovered session be shown BEFORE a file is
   * chosen — the picker no longer has to select a file to learn one exists.
   */
  uploadSnapshot?: UploadSnapshot | null;
  onUploadPause?: () => void;
  onUploadResume?: () => Promise<void> | void;
  onUploadCancel?: () => Promise<void> | void;
  onUploadRetry?: () => Promise<void> | void;
  currentLabel?: string;
}) {
  const [tab, setTab] = React.useState<Tab>('catalog');
  const [recFilter, setRecFilter] = React.useState<RecFilter>('All');
  const [recQuery, setRecQuery] = React.useState('');
  const recResults = React.useMemo(() => {
    let list = searchRecommended(recQuery);
    if (recFilter !== 'All') list = list.filter((m) => m.region === recFilter);
    return list;
  }, [recQuery, recFilter]);
  const [url, setUrl] = React.useState('');
  const [label, setLabel] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const fileInput = React.useRef<HTMLInputElement>(null);

  /* ---------------- local file upload ---------------- */

  const [pendingFile, setPendingFile] = React.useState<File | null>(null);
  const [progress, setProgress] = React.useState(0);
  const [uploading, setUploading] = React.useState(false);
  const [uploadError, setUploadError] = React.useState<string | null>(null);
  /*
   * The engine's own snapshot. It carries every number the progress panel needs
   * (bytes, speed, ETA, parts, retry, recovery) — the picker computes none of
   * them. The ROOM-SCOPED snapshot wins when supplied, because it exists before a
   * file is chosen and is therefore the only one that can carry a recovery offer.
   */
  const [localSnapshot, setLocalSnapshot] = React.useState<UploadSnapshot | null>(null);
  const snapshot = uploadSnapshot ?? localSnapshot;
  const controllerRef = React.useRef<UploadController | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);

  /** A refresh-recovered session, offered before any file is selected. */
  const recovery = snapshot?.recovery ?? null;
  /** A failed attempt that can resume in place rather than starting over. */
  const canRetryInPlace = snapshot?.phase === 'failed' && snapshot.retryable === true;

  const resetUpload = React.useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    controllerRef.current = null;
    setPendingFile(null);
    setProgress(0);
    setLocalSnapshot(null);
    setUploading(false);
    setUploadError(null);
  }, []);

  /*
   * Closing the picker must NOT discard a live or resumable upload.
   *
   * The controller is room-scoped now, so an upload keeps running while the modal
   * is shut. Only the picker's own transient view state is cleared, and only when
   * there is nothing to come back to — a recoverable session or a retryable
   * failure has to survive so reopening the picker still offers it.
   */
  React.useEffect(() => {
    if (open) return;
    if (recovery || canRetryInPlace) return;
    if (snapshot && (snapshot.phase === 'uploading' || snapshot.phase === 'retrying' || snapshot.phase === 'finalizing' || snapshot.phase === 'paused')) return;
    resetUpload();
  }, [open, recovery, canRetryInPlace, snapshot, resetUpload]);

  /** The escape hatch: keep the old behaviour when sharing isn't wanted or possible. */
  const playOnThisDevice = React.useCallback(
    (file: File) => {
      onLocalFile(file);
      onChoose({ type: 'local', value: file.name, label: file.name });
      resetUpload();
      onClose();
    },
    [onLocalFile, onChoose, onClose, resetUpload],
  );

  const startUpload = React.useCallback(
    async (file: File) => {
      if (!onUpload) return playOnThisDevice(file);

      const controller = new AbortController();
      abortRef.current = controller;
      setPendingFile(file);
      setUploadError(null);
      setProgress(0);
      setUploading(true);

      try {
        const source = await onUpload(file, {
          onProgress: setProgress,
          onSnapshot: setLocalSnapshot,
          onController: (engine) => {
            controllerRef.current = engine;
          },
          signal: controller.signal,
        });
        /*
         * The ROOM applies the source. When the room owns the uploader it already
         * did so through its completion callback (and knows whether a newer
         * choice has superseded it), so calling onChoose again here would emit a
         * duplicate. Only the standalone path needs it.
         */
        if (!uploadSnapshot && source && source.value) onChoose(source);
        resetUpload();
        onClose();
      } catch (err) {
        const code = err instanceof UploadError ? err.code : 'UPLOAD_FAILED';
        const maxBytes = err instanceof UploadError ? err.maxBytes : undefined;
        // A cancel is a deliberate action, not an error worth shouting about.
        setUploadError(code === 'ABORTED' ? null : describeUploadError(code, maxBytes));
        setUploading(false);
        abortRef.current = null;
      }
    },
    [onUpload, playOnThisDevice, onChoose, onClose, resetUpload, uploadSnapshot],
  );

  /**
   * Resume the SAME session after a transient failure.
   *
   * Deliberately NOT `startUpload`: that would call `upload:intent` again and
   * abandon every part the provider already holds. The room-scoped controller
   * still has the token, the File and the confirmed parts.
   */
  const retryInPlace = React.useCallback(async () => {
    setUploadError(null);
    setUploading(true);
    try {
      await onUploadRetry?.();
    } finally {
      setUploading(false);
    }
  }, [onUploadRetry]);

  const submitUrl = () => {
    const trimmed = url.trim();
    if (!trimmed) return setError('Paste a link first.');
    const youtube = isYouTubeInput(trimmed);
    // A YouTube-looking link must yield a real video ID — never silently fall
    // through to the generic HTML5 video path with an unplayable watch page.
    if (youtube && !extractYouTubeId(trimmed)) {
      return setError('That YouTube link looks invalid.');
    }
    if (!youtube && !/^https?:\/\//i.test(trimmed)) {
      return setError('That does not look like a web address.');
    }
    // Canonicalize before it leaves the picker: a YouTube link becomes
    // { type:'youtube', value:'<videoId>' }, a direct URL stays a url source.
    const source = normalizeMediaSource({
      type: youtube ? 'youtube' : 'url',
      value: trimmed,
      label: label.trim(),
    });
    onChoose(source);
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
          { value: 'recommend', label: 'Recommended', icon: <Sparkles size={13} /> },
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
              className="group relative overflow-hidden rounded-2xl border border-white/10 text-left transition-[border-color,box-shadow] duration-[180ms] ease-swift hover:border-white/30 hover:shadow-lift"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={posterArt(movie)}
                alt=""
                className="aspect-[2/3] w-full object-cover transition-transform duration-[200ms] ease-swift group-hover:scale-[1.02]"
                loading="lazy"
              />
              <span className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent" />
              <span className="absolute inset-x-0 bottom-0 p-3">
                <span className="block font-display text-[0.8125rem] font-semibold leading-tight text-white">
                  {movie.title}
                </span>
                <span className="mt-0.5 block text-[0.6875rem] text-muted">
                  {movie.year} · {movie.runtime}m
                </span>
              </span>
            </button>
          ))}
        </div>
      )}

      {tab === 'recommend' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {(['All', 'Punjabi', 'Bollywood', 'Hollywood'] as RecFilter[]).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setRecFilter(f)}
                aria-pressed={recFilter === f}
                className={cn(
                  'inline-flex min-h-9 items-center rounded-full border px-3 text-xs font-medium transition-colors duration-[160ms] ease-swift',
                  recFilter === f
                    ? 'border-gold-400/60 bg-gold-400/10 text-gold-300'
                    : 'border-white/10 text-secondary hover:border-white/25',
                )}
              >
                {f}
              </button>
            ))}
          </div>

          <Input
            icon={<Search size={16} />}
            placeholder="Search recommendations…"
            value={recQuery}
            onChange={(e) => setRecQuery(e.target.value)}
            aria-label="Search recommended movies"
          />

          {recResults.length === 0 ? (
            <p className="py-10 text-center text-sm text-supporting">No matches. Try another title or category.</p>
          ) : (
            <div className="max-h-[52vh] space-y-2 overflow-y-auto pr-1">
              {recResults.map((movie) => {
                const full = hasFullMovie(movie);
                return (
                  <div
                    key={movie.id}
                    className="group flex w-full items-stretch gap-3 overflow-hidden rounded-2xl border border-white/10 p-2 transition-[border-color,box-shadow] duration-[180ms] ease-swift hover:border-white/30 hover:shadow-lift"
                  >
                    <button
                      onClick={() => {
                        // Set the CURRENT room's source; the server broadcasts
                        // source:set so the partner lands on the same synced player.
                        // The full movie is chosen when officially available.
                        onChoose(toYouTubeSource(movie, full ? 'full' : 'trailer'));
                        onClose();
                      }}
                      className="flex min-w-0 flex-1 items-stretch gap-3 text-left"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={movie.posterUrl}
                        alt=""
                        loading="lazy"
                        className="aspect-video w-28 shrink-0 rounded-lg object-cover sm:w-32"
                      />
                      <span className="min-w-0 flex-1 py-0.5 pr-1">
                        <span className="flex items-center justify-between gap-2">
                          <span className="truncate font-display text-[0.8125rem] font-semibold text-white">{movie.title}</span>
                          <span className={cn('inline-flex shrink-0 items-center gap-1 text-[0.5625rem] font-medium uppercase tracking-wide', full ? 'text-gold-300' : 'text-rose-300')}>
                            <Youtube size={10} />
                            {full ? 'Full movie' : 'Trailer'}
                          </span>
                        </span>
                        <span className="mt-0.5 block text-[0.6875rem] text-muted">
                          {movie.year} · {movie.language} · {movie.genres.slice(0, 2).join(', ')}
                        </span>
                        <span className="mt-1 block truncate text-[0.625rem] text-muted">{full ? movie.fullMovieChannel : movie.sourceChannel}</span>
                      </span>
                    </button>
                    {full && (
                      <button
                        onClick={() => {
                          onChoose(toYouTubeSource(movie, 'trailer'));
                          onClose();
                        }}
                        className="shrink-0 self-center rounded-lg border border-white/10 px-2.5 py-2 text-[0.625rem] font-medium text-secondary transition-colors duration-[160ms] ease-swift hover:border-white/25 hover:text-primary"
                      >
                        Trailer
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <p className="text-[0.6875rem] leading-relaxed text-muted">
            Official trailers on YouTube — both of you see the same synced player. Nothing is uploaded.
          </p>
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
            icon={isYouTubeInput(url) ? <Youtube size={16} /> : <Link2 size={16} />}
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
          <div className="rounded-2xl bg-white/[0.04] p-4 text-[0.8125rem] leading-relaxed text-supporting">
            Direct video files play best. Most streaming services block embedding, so a Netflix or
            Prime link will not load here — use a direct file, a YouTube link, or the same local copy
            you both have.
          </div>
          <Button variant="primary" className="w-full" onClick={submitUrl}>
            Load this link
          </Button>
        </div>
      )}

      {tab === 'local' && uploadsDisabled && (
        <div className="space-y-5">
          <div className="flex w-full flex-col items-center justify-center gap-3 rounded-3xl border border-dashed border-white/12 px-6 py-14 text-center">
            <span className="grid h-12 w-12 place-items-center rounded-2xl glass-soft text-muted">
              <UploadCloud size={20} />
            </span>
            <span className="text-sm font-medium text-primary">Uploads are not available in this demo yet.</span>
            <span className="max-w-sm text-[0.8125rem] leading-relaxed text-supporting">
              Built-in movie recommendations are available. Hosted uploads will be enabled later.
            </span>
          </div>
        </div>
      )}

      {tab === 'local' && !uploadsDisabled && (
        <div className="space-y-5">
          <input
            ref={fileInput}
            type="file"
            accept="video/*"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              // Reset the input so re-picking the SAME file fires onChange again.
              e.target.value = '';
              if (!file) return;
              void startUpload(file);
            }}
          />

          {/*
            The panel appears whenever the ENGINE has something to show: a
            refresh-recovered session waiting for a reselection, a live upload, or
            a retryable failure. It no longer depends on a local file selection —
            that dependency is exactly what made recovery unreachable.
          */}
          {snapshot && (recovery || canRetryInPlace || uploading || snapshot.cleanupPending || snapshot.phase === 'uploading' || snapshot.phase === 'retrying' || snapshot.phase === 'paused' || snapshot.phase === 'finalizing' || snapshot.phase === 'reconnecting' || snapshot.phase === 'cancelling') ? (
            <div className="space-y-4">
              {snapshot ? (
                /*
                 * The full panel, driven entirely by the engine's snapshot. Pause
                 * and Resume appear only for multipart — the component decides that
                 * from `snapshot.mode`, so a single-request upload never shows a
                 * control that cannot work.
                 */
                <SharedUploadProgress
                  snapshot={snapshot}
                  onPause={() => (onUploadPause ? onUploadPause() : controllerRef.current?.pause())}
                  onResume={() => void (onUploadResume ? onUploadResume() : controllerRef.current?.resume())}
                  onCancel={() => {
                    // Cancel the ENGINE (which aborts the provider upload and
                    // clears persistence), then the picker's own view state.
                    void (onUploadCancel ? onUploadCancel() : controllerRef.current?.cancel());
                    resetUpload();
                  }}
                  onRetry={() => {
                    /*
                     * A retryable failure resumes the SAME session — same token,
                     * same confirmed parts, no new upload:intent. Only a terminal
                     * failure (or no resumable session) starts over.
                     */
                    if (canRetryInPlace && onUploadRetry) return void retryInPlace();
                    if (pendingFile) return void startUpload(pendingFile);
                    fileInput.current?.click();
                  }}
                  onReselect={() => fileInput.current?.click()}
                />
              ) : !pendingFile ? null : (
                /* Fallback for a caller that reports only a fraction. */
                <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-6">
                  <div className="flex items-center gap-3">
                    <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gold-400/12 text-gold-300">
                      <UploadCloud size={19} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[0.875rem] font-medium text-primary">{pendingFile.name}</p>
                      <p className="mt-0.5 text-[0.75rem] text-supporting">
                        Uploading so you can both watch it · {Math.round(progress * 100)}%
                      </p>
                    </div>
                    <button
                      onClick={resetUpload}
                      aria-label="Cancel upload"
                      className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-muted transition-colors duration-[160ms] ease-swift hover:bg-white/[0.07] hover:text-primary"
                    >
                      <X size={16} />
                    </button>
                  </div>

                  <div
                    role="progressbar"
                    aria-label="Upload progress"
                    aria-valuenow={Math.round(progress * 100)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-white/10"
                  >
                    <div
                      className="h-full rounded-full bg-gold-400 transition-[width] duration-300"
                      style={{ width: `${Math.max(2, progress * 100)}%` }}
                    />
                  </div>
                </div>
              )}

              {pendingFile && (
                <button
                  onClick={() => playOnThisDevice(pendingFile)}
                  className="inline-flex min-h-11 items-center text-[0.75rem] text-supporting underline-offset-4 transition-colors duration-[160ms] ease-swift hover:text-primary hover:underline"
                >
                  Play only on this device instead
                </button>
              )}
            </div>
          ) : (
            <>
              <button
                onClick={() => fileInput.current?.click()}
                className={cn(
                  'flex w-full flex-col items-center justify-center gap-3 rounded-3xl border border-dashed border-white/15 px-6 py-14',
                  'transition-colors duration-[160ms] ease-swift hover:border-gold-400/50 hover:bg-white/[0.04]',
                )}
              >
                <span className="grid h-12 w-12 place-items-center rounded-2xl glass-soft text-supporting">
                  <FolderOpen size={20} />
                </span>
                <span className="text-sm font-medium text-primary">Choose a video from this device</span>
                <span className="max-w-sm text-center text-[0.8125rem] leading-relaxed text-supporting">
                  {onUpload
                    ? 'It uploads to your room for a few hours so you can both stream the same film. MP4, WebM or OGG.'
                    : 'Sharing is not configured, so this plays on your device only — your partner needs their own copy.'}
                </span>
              </button>

              {uploadError && (
                <div className="rounded-2xl border border-rose-400/25 bg-rose-950/40 p-4">
                  <p className="flex items-start gap-2 text-[0.8125rem] leading-relaxed text-rose-100">
                    <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                    {uploadError}
                  </p>
                  {pendingFile && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <Button variant="glass" size="sm" className="!h-11" onClick={() => void startUpload(pendingFile)}>
                        <UploadCloud size={14} />
                        Try again
                      </Button>
                      <Button variant="ghost" size="sm" className="!h-11" onClick={() => playOnThisDevice(pendingFile)}>
                        <MonitorPlay size={14} />
                        Play only on this device
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
