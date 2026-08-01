/**
 * The pure decisions behind the upload progress interface.
 *
 * Extracted from the component for the same reason the engine is: this repository
 * has no DOM test environment, so anything worth asserting has to be a function.
 * What lives here is exactly the part that is easy to get wrong and impossible to
 * eyeball — which control is legal in which state, and what a screen reader is
 * told versus what it is spared.
 *
 * The announcement rules exist because a 3 GB upload emits thousands of progress
 * events. A live region that echoed them would put a reader minutes behind the
 * upload and make the rest of the page unusable, so byte progress is announced at
 * 5% milestones and speed/ETA are never announced at all.
 */

import type { UploadPhase, UploadSnapshot } from './multipartUpload.ts';
import { formatBytes } from './uploadMetrics.ts';

/** One line of copy per state. Nothing implies more certainty than we have. */
export const UPLOAD_PHASE_LABEL: Record<UploadPhase, string> = {
  idle: 'Ready to upload',
  starting: 'Starting upload…',
  uploading: 'Uploading…',
  paused: 'Paused',
  retrying: 'Temporary network problem',
  reconnecting: 'Reconnecting…',
  finalizing: 'Finalizing upload…',
  completed: 'Upload complete',
  cancelling: 'Cancelling…',
  cancelled: 'Upload cancelled',
  failed: 'Upload failed',
};

/** Milestone granularity for screen-reader announcements, in percent. */
export const ANNOUNCE_STEP = 5;

/**
 * The `aria-valuetext` for the progress bar.
 *
 * Bytes AND percent: a percentage alone tells a listener nothing about whether
 * "3%" means three minutes or three hours of waiting.
 */
export function progressValueText(uploadedBytes: number, totalBytes: number, percentage: number): string {
  return `${formatBytes(uploadedBytes)} of ${formatBytes(totalBytes)} uploaded, ${percentage}%`;
}

export interface AnnouncementInput {
  phase: UploadPhase;
  percentage: number;
  totalBytes: number;
  error?: string;
  /** What was last announced, so nothing is repeated. */
  lastPhase: UploadPhase | null;
  lastMilestone: number;
  /** Copy for an error code, injected so this module owns no error vocabulary. */
  describeError?: (code: string | undefined) => string | null;
}

export interface Announcement {
  text: string;
  /** The milestone this announcement consumed, or -1 when it was a state change. */
  milestone: number;
}

/**
 * What, if anything, to announce right now.
 *
 * Returns null far more often than not — that is the feature. A state change
 * always speaks; byte progress speaks only when it crosses a new 5% mark; speed
 * and ETA never speak, because they change constantly and a listener cannot act
 * on either.
 */
export function nextAnnouncement(input: AnnouncementInput): Announcement | null {
  const { phase, percentage, totalBytes, error, lastPhase, lastMilestone } = input;

  // A state change resets the milestone counter, so entering `uploading` again
  // after a pause re-announces progress from where it actually is.
  if (phase !== lastPhase) {
    if (phase === 'finalizing') {
      // Every byte is up but the object does not exist yet. Saying "complete"
      // here would be wrong, and saying "100%" alone would imply it.
      return { text: `${formatBytes(totalBytes)} uploaded. Finalizing upload.`, milestone: -1 };
    }
    if (phase === 'failed') {
      const described = input.describeError?.(error);
      return { text: described || 'Upload failed.', milestone: -1 };
    }
    return { text: UPLOAD_PHASE_LABEL[phase], milestone: -1 };
  }

  // Byte progress, only while something is actually moving.
  if (phase !== 'uploading' && phase !== 'retrying') return null;
  const milestone = Math.floor(percentage / ANNOUNCE_STEP) * ANNOUNCE_STEP;
  if (milestone <= lastMilestone) return null;
  return { text: `${milestone}% uploaded`, milestone };
}

/* -------------------------------------------------------------------------- */
/*  Which controls are legal                                                  */
/* -------------------------------------------------------------------------- */

export interface UploadControlsVisible {
  pause: boolean;
  resume: boolean;
  cancel: boolean;
  retry: boolean;
  reselect: boolean;
}

/**
 * Which controls a given state may offer.
 *
 * `pause` is the one that matters: a single HTTP request cannot be paused and
 * resumed, so offering Pause for a single-shot upload would either do nothing or
 * silently restart a 400 MB transfer. It is absent for that mode rather than
 * present-and-lying.
 */
export function visibleControls(
  snapshot: Pick<UploadSnapshot, 'phase' | 'mode' | 'recovery' | 'cleanupPending'>,
): UploadControlsVisible {
  const { phase, mode } = snapshot;
  const resumable = mode === 'multipart';
  const finished = phase === 'completed' || phase === 'cancelled';

  /*
   * A lifecycle cleanup is UNRESOLVED (a user cancel, or a client-origin terminal
   * failure whose abort was refused). The server session is still active, so the
   * ONLY legal action is to retry the cancellation — never a fresh start, reselect
   * or new intent. This wins over every other control.
   */
  if (snapshot.cleanupPending) {
    return { pause: false, resume: false, cancel: true, retry: false, reselect: false };
  }

  // A recovered session waiting for a reselection is its own affordance: nothing
  // is in flight, so Pause and Resume make no sense.
  if (snapshot.recovery && phase !== 'uploading' && phase !== 'finalizing') {
    return { pause: false, resume: false, cancel: true, retry: false, reselect: true };
  }

  return {
    pause: resumable && (phase === 'uploading' || phase === 'retrying'),
    resume: resumable && phase === 'paused',
    cancel: !finished && phase !== 'failed' && phase !== 'cancelling',
    retry: phase === 'failed',
    // Reselecting is the answer to both "wrong file" and "the session outlived
    // the page".
    reselect: phase === 'failed',
  };
}

/**
 * Does this snapshot represent bytes-done-but-not-confirmed?
 *
 * Worth its own predicate because it is the single most misleading state to get
 * wrong: 100% of the bytes are uploaded, and the movie does not exist.
 */
export function isAwaitingProvider(snapshot: Pick<UploadSnapshot, 'phase'>): boolean {
  return snapshot.phase === 'finalizing';
}
