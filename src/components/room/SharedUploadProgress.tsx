'use client';

/**
 * Live progress for a shared upload — presentational only.
 *
 * Every number and every state comes from an `UploadSnapshot`; this component
 * decides nothing about scheduling, retries or completion. That split is what
 * keeps the engine testable without a DOM and this file readable without knowing
 * how multipart works.
 *
 * The accessibility rules here are load-bearing rather than decorative. A 3 GB
 * upload emits thousands of progress events, and a naive `aria-live` region would
 * read every one of them aloud for twenty minutes. So: the bar carries the value,
 * announcements are throttled to 5% milestones plus state changes, and speed/ETA
 * are never announced at all.
 */

import * as React from 'react';
import { CloudUpload, Pause, Play, RotateCcw, X, FolderOpen, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';
import { formatBytes, formatEta, formatSpeed } from '@/lib/uploadMetrics';
import {
  UPLOAD_PHASE_LABEL,
  nextAnnouncement,
  progressValueText,
  visibleControls,
} from '@/lib/uploadAnnounce';
import type { UploadPhase, UploadSnapshot } from '@/lib/multipartUpload';
import type { PartnerUploadProgress } from '@/lib/types';

export interface SharedUploadProgressProps {
  snapshot: UploadSnapshot;
  onPause?: () => void;
  onResume?: () => void;
  onCancel?: () => void;
  onRetry?: () => void;
  /** Ask the user to reselect the same file (refresh recovery, or a mismatch). */
  onReselect?: () => void;
  className?: string;
}

/** Copy for the codes the engine and server can return. */
function describe(error: string | undefined): string | null {
  if (!error) return null;
  switch (error) {
    case 'UNSUPPORTED_TYPE':
      return 'That file type can’t be streamed in a browser. Use an MP4, WebM, or OGG video.';
    case 'TOO_LARGE':
      return 'That file is larger than this room allows.';
    case 'BAD_SIZE':
      return 'That file looks empty. Pick another one.';
    case 'MULTIPART_REQUIRED':
      return 'A file this large needs resumable uploads, which aren’t available on this deployment.';
    case 'CONFIGURATION_ERROR':
      return 'Shared uploads aren’t configured correctly on this server. Nothing you did wrong.';
    case 'UPLOAD_ALREADY_ACTIVE':
      return 'You already have an upload running. Cancel it first.';
    case 'ROOM_UPLOAD_LIMIT':
      return 'This room already has as many uploads running as it allows.';
    case 'MISSING_ETAG':
      return 'The storage bucket didn’t return an ETag for a part. Its CORS settings need to expose the ETag header.';
    case 'FILE_MISMATCH':
      return 'That isn’t the same file that started the upload.';
    case 'FILE_MISSING':
      return 'Pick the file again to continue.';
    case 'SIZE_MISMATCH':
      return 'The finished file wasn’t the size we expected. Try uploading again.';
    case 'BAD_CONTENT':
      return 'The uploaded file didn’t match what was expected. Try again with an MP4, WebM, or OGG video.';
    case 'NO_SUCH_UPLOAD':
      return 'This upload is no longer available on the server. Start it again.';
    case 'BAD_TOKEN':
    case 'WRONG_ROOM':
    case 'WRONG_MEMBER':
      return 'That upload expired. Pick the file again.';
    case 'RATE_LIMITED':
      return 'Too many upload requests just now. Give it a moment.';
    case 'NETWORK':
    case 'TIMEOUT':
      return 'The connection dropped. It will pick up where it left off.';
    case 'CANCEL_FAILED':
      return 'Couldn’t reach the server to cancel. Try cancelling again.';
    default:
      return 'The upload failed. Check your connection and try again.';
  }
}

export function SharedUploadProgress({
  snapshot,
  onPause,
  onResume,
  onCancel,
  onRetry,
  onReselect,
  className,
}: SharedUploadProgressProps) {
  const {
    phase,
    mode,
    fileName,
    uploadedBytes,
    totalBytes,
    percentage,
    smoothedBytesPerSecond,
    etaSeconds,
    completedParts,
    partCount,
    retry,
    error,
    recovery,
    cleanupPending,
    cleanupError,
  } = snapshot;

  const speed = formatSpeed(smoothedBytesPerSecond);
  const eta = formatEta(etaSeconds);
  const active = phase === 'uploading' || phase === 'retrying';
  const finished = phase === 'completed' || phase === 'cancelled' || phase === 'failed';

  /*
   * Announcements: state changes always, byte progress only every 5%.
   *
   * Screen readers queue live-region updates, so announcing every progress event
   * would put a reader minutes behind the actual upload and make the rest of the
   * page unusable. Speed and ETA are excluded entirely — they change constantly
   * and carry no information a listener can act on.
   */
  const [announcement, setAnnouncement] = React.useState('');
  const lastMilestone = React.useRef(-1);
  const lastPhase = React.useRef<UploadPhase | null>(null);

  React.useEffect(() => {
    const next = nextAnnouncement({
      phase,
      percentage,
      totalBytes,
      error,
      lastPhase: lastPhase.current,
      lastMilestone: lastMilestone.current,
      describeError: describe,
    });
    // A state change resets the milestone counter, so re-entering `uploading`
    // after a pause announces where progress actually is.
    if (phase !== lastPhase.current) lastMilestone.current = -1;
    lastPhase.current = phase;
    if (!next) return;
    if (next.milestone >= 0) lastMilestone.current = next.milestone;
    setAnnouncement(next.text);
  }, [phase, percentage, totalBytes, error]);

  const controls = visibleControls(snapshot);

  /* A pending refresh recovery is its own affordance, not a progress bar. */
  if (recovery && phase !== 'uploading' && phase !== 'finalizing') {
    return (
      <section
        className={cn('rounded-2xl border border-white/10 bg-white/[0.03] p-4', className)}
        aria-label="Resume upload"
      >
        <div className="flex items-start gap-3">
          <CloudUpload size={19} className="mt-0.5 shrink-0 text-violet-300" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-white" title={recovery.fileName}>
              Resume upload of “{recovery.fileName}”
            </p>
            <p className="mt-1 text-xs text-white/60">
              {formatBytes(recovery.uploadedBytes)} was already uploaded. Select the same file to continue.
            </p>
            {error === 'FILE_MISMATCH' && (
              <p className="mt-2 flex items-start gap-1.5 text-xs text-amber-300" role="alert">
                <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
                {describe(error)}
              </p>
            )}
          </div>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="glass" size="sm" className="!h-11" onClick={onReselect}>
            <FolderOpen size={14} aria-hidden="true" /> Choose the file
          </Button>
          <Button variant="ghost" size="sm" className="!h-11" onClick={onCancel}>
            Discard upload
          </Button>
        </div>
      </section>
    );
  }

  // The original upload error, surfaced on a failed/cancelling upload.
  const errorText = phase === 'failed' || phase === 'cancelling' ? describe(error) : null;
  const errorId = 'shared-upload-error';
  /*
   * A SEPARATE cleanup line while an abort is unresolved: the server session is
   * still active, so the only action is to retry the cancellation. Kept distinct
   * from the upload error above (e.g. failure SIZE_MISMATCH + cleanup RATE_LIMITED).
   */
  const cleanupText = cleanupPending ? describe(cleanupError) || 'Cancelling the upload…' : null;

  return (
    <section
      className={cn('rounded-2xl border border-white/10 bg-white/[0.03] p-4', className)}
      aria-label="Shared upload progress"
    >
      {/* Announcements only — the visible copy below is the same information. */}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>

      <div className="flex items-start gap-3">
        <CloudUpload size={19} className="mt-0.5 shrink-0 text-violet-300" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3">
            {/* Long names truncate visually but stay reachable via title. */}
            <p className="min-w-0 truncate text-sm font-medium text-white" title={fileName}>
              {fileName || 'Uploading'}
            </p>
            {/* Tabular numerals so the panel does not reflow on every tick. */}
            <span className="shrink-0 text-sm font-semibold tabular-nums text-white/80">{percentage}%</span>
          </div>

          <div
            className="mt-2 h-2 overflow-hidden rounded-full bg-white/10"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={totalBytes}
            aria-valuenow={uploadedBytes}
            aria-valuetext={progressValueText(uploadedBytes, totalBytes, percentage)}
          >
            <div
              className={cn(
                'h-full rounded-full transition-[width] duration-300 ease-out',
                phase === 'failed' ? 'bg-rose-400/80' : 'bg-gradient-to-r from-violet-400 to-cyan-300',
              )}
              style={{ width: `${percentage}%` }}
            />
          </div>

          <p className="mt-2 text-xs text-white/60 tabular-nums">
            {formatBytes(uploadedBytes)} of {formatBytes(totalBytes)} uploaded
            {partCount > 1 && phase !== 'completed' ? ` · ${completedParts} of ${partCount} parts` : ''}
          </p>

          <p className="mt-1 text-xs text-white/50">
            {/*
              One line for rate and time, and it says what is true rather than
              filling in a number: before the sampler is stable there is no honest
              speed to show, so it says so.
            */}
            {active ? (
              <>
                {speed || 'Calculating speed…'}
                {speed ? ' · ' : ''}
                {speed ? eta || 'Estimating time remaining…' : ''}
              </>
            ) : (
              UPLOAD_PHASE_LABEL[phase]
            )}
          </p>

          {phase === 'retrying' && retry && (
            <p className="mt-1 text-xs text-amber-300/90">
              Retrying part {retry.partNumber} in {Math.max(1, Math.round(retry.delayMs / 1000))} seconds…
            </p>
          )}

          {errorText && (
            <p id={errorId} className="mt-2 flex items-start gap-1.5 text-xs text-rose-300" role="alert">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
              {errorText}
            </p>
          )}

          {cleanupText && (
            <p className="mt-1 flex items-start gap-1.5 text-xs text-amber-300" role="alert">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden="true" />
              {cleanupText} The upload is still being cancelled — retry to finish.
            </p>
          )}
        </div>
      </div>

      {(controls.pause || controls.resume || controls.cancel) && (
        <div className="mt-3 flex flex-wrap gap-2">
          {/*
            Pause exists ONLY for multipart. A single HTTP request cannot resume,
            and a button that silently restarts a 400 MB upload would be a lie.
          */}
          {controls.pause && (
            <Button variant="glass" size="sm" className="!h-11" onClick={onPause}>
              <Pause size={14} aria-hidden="true" /> Pause
            </Button>
          )}
          {controls.resume && (
            <Button variant="glass" size="sm" className="!h-11" onClick={onResume}>
              <Play size={14} aria-hidden="true" /> Resume
            </Button>
          )}
          {controls.cancel && (
            <Button
              variant="ghost"
              size="sm"
              className="!h-11"
              onClick={onCancel}
              aria-label={cleanupPending ? 'Retry cancel' : 'Cancel upload'}
            >
              <X size={14} aria-hidden="true" /> {cleanupPending ? 'Retry cancel' : 'Cancel'}
            </Button>
          )}
        </div>
      )}

      {controls.retry && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            variant="glass"
            size="sm"
            className="!h-11"
            onClick={onRetry}
            // The error text is associated with the control that acts on it.
            aria-describedby={errorText ? errorId : undefined}
          >
            <RotateCcw size={14} aria-hidden="true" /> Try again
          </Button>
          {controls.reselect && onReselect && (
            <Button variant="ghost" size="sm" className="!h-11" onClick={onReselect}>
              <FolderOpen size={14} aria-hidden="true" /> Choose another file
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Partner-side view                                                        */
/* -------------------------------------------------------------------------- */

/**
 * What the OTHER member sees.
 *
 * Deliberately less than the uploader sees: no speed and no ETA. Those are local
 * estimates from the uploader's machine, they would need their own realtime
 * traffic to keep current, and a partner cannot act on either.
 */
export function PartnerUploadRow({ progress, className }: { progress: PartnerUploadProgress; className?: string }) {
  const verb =
    progress.status === 'paused'
      ? 'paused the upload'
      : progress.status === 'reconnecting'
        ? 'is reconnecting…'
        : progress.status === 'finalizing'
          ? 'is finalizing the upload…'
          : progress.status === 'retrying'
            ? 'hit a network problem…'
            : 'is uploading';

  return (
    <div className={cn('rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5', className)}>
      <p className="truncate text-xs text-white/70" title={progress.label}>
        <span className="font-medium text-white/90">{progress.memberName}</span> {verb}
        {progress.status === 'uploading' ? ` “${progress.label}”` : ''}
      </p>
      <div
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/10"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={progress.totalBytes}
        aria-valuenow={progress.uploadedBytes}
        aria-valuetext={`${progress.memberName}: ${formatBytes(progress.uploadedBytes)} of ${formatBytes(
          progress.totalBytes,
        )} uploaded, ${progress.percentage}%`}
      >
        <div
          className="h-full rounded-full bg-gradient-to-r from-violet-400/70 to-cyan-300/70 transition-[width] duration-500"
          style={{ width: `${progress.percentage}%` }}
        />
      </div>
      <p className="mt-1.5 text-[11px] text-white/50 tabular-nums">
        {formatBytes(progress.uploadedBytes)} of {formatBytes(progress.totalBytes)} · {progress.percentage}%
      </p>
    </div>
  );
}
