/**
 * Upload progress arithmetic: byte aggregation, formatting, speed and ETA.
 *
 * Pure and dependency-free (the clock is injected) so every rule here is
 * unit-testable without a browser, a file or a socket — see
 * scripts/upload-metrics.test.mjs. The engine in multipartUpload.ts owns
 * scheduling and retries; this module owns "what number do we show".
 *
 * The rules exist because the naive versions are all subtly wrong on a 3 GB
 * upload: counting a part twice after a retry, showing 103%, computing speed
 * across a 4-minute pause, or dividing by a zero rate and rendering `Infinity`.
 */

/* -------------------------------------------------------------------------- */
/*  Byte aggregation                                                          */
/* -------------------------------------------------------------------------- */

export interface UploadedBytesInput {
  /** Bytes in parts the PROVIDER has confirmed. Counted exactly once each. */
  completedBytes: number;
  /** Bytes reported by in-flight part attempts, summed. */
  activeBytes: number;
  totalBytes: number;
}

/**
 * Uploaded bytes = provider-confirmed parts + live progress of active attempts.
 *
 * Both halves are needed. Completed parts alone makes a 16 MiB part look frozen
 * for its whole upload; active bytes alone loses everything on a resume. The cap
 * is not cosmetic: an aborted attempt's bytes are removed by the engine, but a
 * provider double-listing or a rounding artefact must never render as 103%.
 */
export function computeUploadedBytes({ completedBytes, activeBytes, totalBytes }: UploadedBytesInput): number {
  const completed = Number.isFinite(completedBytes) && completedBytes > 0 ? completedBytes : 0;
  const active = Number.isFinite(activeBytes) && activeBytes > 0 ? activeBytes : 0;
  const total = Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : 0;
  return Math.min(completed + active, total);
}

/** Whole percent, clamped. Never 101, never NaN. */
export function computePercentage(uploadedBytes: number, totalBytes: number): number {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return 0;
  const fraction = uploadedBytes / totalBytes;
  if (!Number.isFinite(fraction)) return 0;
  return Math.min(100, Math.max(0, Math.round(fraction * 100)));
}

/* -------------------------------------------------------------------------- */
/*  Formatting                                                                */
/* -------------------------------------------------------------------------- */

const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;

/**
 * Binary units with familiar labels.
 *
 * The product says "3 GB" for a 3 GiB limit deliberately: users read GB, the
 * limit is a power of two, and inventing "3 GiB" in the interface would be
 * precise and unhelpful. Precision rises with magnitude so the number stays
 * readable AND stops flickering — two decimals on GB means a 3 GB upload's total
 * is a stable "3.00 GB" while the uploaded figure still visibly moves.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < KB) return `${Math.round(bytes)} B`;
  if (bytes < MB) return `${Math.round(bytes / KB)} KB`;
  if (bytes < GB) {
    const mb = bytes / MB;
    // One decimal below 100 MB, whole numbers above: "9.4 MB", "734 MB".
    return mb < 100 ? `${mb.toFixed(1)} MB` : `${Math.round(mb)} MB`;
  }
  return `${(bytes / GB).toFixed(2)} GB`;
}

/** Speed, in the same unit family. Never negative, never Infinity. */
export function formatSpeed(bytesPerSecond: number | null): string | null {
  if (bytesPerSecond === null || !Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return null;
  return `${formatBytes(bytesPerSecond)}/s`;
}

/**
 * Human ETA.
 *
 * Seconds are shown only under ten minutes, where they are genuinely useful;
 * above that they are noise that changes every tick. Nothing is rendered at all
 * unless the caller has a stable rate — see `SpeedSampler.stable`.
 */
export function formatEta(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return null;
  const total = Math.round(seconds);
  if (total < 60) return `About ${Math.max(1, total)} sec remaining`;

  const minutes = Math.floor(total / 60);
  const restSeconds = total % 60;
  if (minutes < 60) {
    if (minutes < 10 && restSeconds > 0) return `About ${minutes} min ${restSeconds} sec remaining`;
    return `About ${minutes} min remaining`;
  }

  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes > 0 ? `About ${hours} hr ${restMinutes} min remaining` : `About ${hours} hr remaining`;
}

/* -------------------------------------------------------------------------- */
/*  Speed sampling                                                            */
/* -------------------------------------------------------------------------- */

export interface SpeedSamplerOptions {
  /** Rolling window in ms. 5–10s is long enough to be steady, short enough to react. */
  windowMs?: number;
  /** Minimum span before a rate is considered meaningful. */
  minSpanMs?: number;
  /** EMA weight for each new instantaneous reading. */
  smoothing?: number;
}

export interface SpeedReading {
  /** Rate over the current window, or null before the window is meaningful. */
  current: number | null;
  /** Exponentially smoothed rate — what the interface should display. */
  smoothed: number | null;
  /** Whether there is enough history to show a rate or an ETA at all. */
  stable: boolean;
}

export interface SpeedSampler {
  /** Record the AGGREGATE uploaded byte count at time `t`. */
  sample(totalUploadedBytes: number, t: number): void;
  read(): SpeedReading;
  /**
   * Forget history without forgetting that we are running. Used after a retry
   * cleanup removes transient bytes: the byte total legitimately goes DOWN, and
   * carrying samples across that discontinuity would compute a negative rate or
   * a wild spike.
   */
  reset(): void;
  /**
   * Stop the clock. Paused and offline time must not count as slow transfer —
   * a 4-minute pause would otherwise show as 0 B/s and an ETA of hours.
   */
  suspend(): void;
  /** Resume with a clean baseline, so the gap is excluded rather than averaged. */
  resume(): void;
  suspended(): boolean;
}

export function createSpeedSampler(options: SpeedSamplerOptions = {}): SpeedSampler {
  const windowMs = options.windowMs && options.windowMs > 0 ? options.windowMs : 8000;
  const minSpanMs = options.minSpanMs && options.minSpanMs > 0 ? options.minSpanMs : 1000;
  const smoothing = options.smoothing && options.smoothing > 0 && options.smoothing <= 1 ? options.smoothing : 0.3;

  let samples: Array<{ t: number; bytes: number }> = [];
  let smoothed: number | null = null;
  let isSuspended = false;

  const clear = () => {
    samples = [];
    smoothed = null;
  };

  return {
    sample(totalUploadedBytes, t) {
      if (isSuspended) return;
      if (!Number.isFinite(totalUploadedBytes) || !Number.isFinite(t)) return;

      const last = samples[samples.length - 1];
      if (last) {
        // A duplicate timestamp would divide by zero; a byte count that went
        // backwards means the engine removed a failed attempt's bytes, and the
        // old baseline is no longer comparable.
        if (t <= last.t) return;
        if (totalUploadedBytes < last.bytes) {
          clear();
          samples.push({ t, bytes: totalUploadedBytes });
          return;
        }
      }

      samples.push({ t, bytes: totalUploadedBytes });
      const cutoff = t - windowMs;
      // Keep one sample older than the cutoff so the window always has a base.
      while (samples.length > 2 && samples[1].t <= cutoff) samples.shift();

      const first = samples[0];
      const span = t - first.t;
      if (span < minSpanMs) return;
      const delta = totalUploadedBytes - first.bytes;
      if (delta <= 0) return;

      const instantaneous = (delta / span) * 1000;
      if (!Number.isFinite(instantaneous) || instantaneous <= 0) return;
      smoothed = smoothed === null ? instantaneous : smoothed + smoothing * (instantaneous - smoothed);
    },

    read() {
      if (samples.length < 2) return { current: null, smoothed: null, stable: false };
      const first = samples[0];
      const last = samples[samples.length - 1];
      const span = last.t - first.t;
      const delta = last.bytes - first.bytes;
      if (span < minSpanMs || delta <= 0) {
        return { current: null, smoothed: smoothed && smoothed > 0 ? smoothed : null, stable: false };
      }
      const current = (delta / span) * 1000;
      const safeCurrent = Number.isFinite(current) && current > 0 ? current : null;
      const safeSmoothed = smoothed !== null && Number.isFinite(smoothed) && smoothed > 0 ? smoothed : safeCurrent;
      return { current: safeCurrent, smoothed: safeSmoothed, stable: safeSmoothed !== null };
    },

    reset: clear,
    suspend() {
      isSuspended = true;
      clear();
    },
    resume() {
      isSuspended = false;
      clear();
    },
    suspended: () => isSuspended,
  };
}

/**
 * Seconds remaining, or null when it cannot be honestly estimated.
 *
 * Null rather than a guess: a large number computed from one unstable sample
 * looks authoritative and is wrong, and "Estimating time remaining…" is the more
 * useful thing to say.
 */
export function computeEtaSeconds(
  uploadedBytes: number,
  totalBytes: number,
  smoothedBytesPerSecond: number | null,
): number | null {
  if (smoothedBytesPerSecond === null || !Number.isFinite(smoothedBytesPerSecond) || smoothedBytesPerSecond <= 0) {
    return null;
  }
  const remaining = totalBytes - uploadedBytes;
  if (!Number.isFinite(remaining) || remaining <= 0) return 0;
  const seconds = remaining / smoothedBytesPerSecond;
  return Number.isFinite(seconds) ? seconds : null;
}

/* -------------------------------------------------------------------------- */
/*  Part planning (client side)                                               */
/* -------------------------------------------------------------------------- */

export interface PartRange {
  partNumber: number;
  start: number;
  end: number;
  size: number;
}

/**
 * The byte range of one part, from the SERVER's plan.
 *
 * The client re-derives ranges rather than receiving 192 of them, but it must
 * derive exactly what the server signed: `File.slice(start, end)` has to produce
 * the bytes the completed object expects at that offset, or the assembled movie
 * is silently corrupt.
 */
export function partRangeFor(partNumber: number, partSize: number, totalBytes: number): PartRange | null {
  if (!Number.isSafeInteger(partNumber) || partNumber < 1) return null;
  if (!Number.isSafeInteger(partSize) || partSize <= 0) return null;
  const start = (partNumber - 1) * partSize;
  if (start >= totalBytes) return null;
  const end = Math.min(start + partSize, totalBytes);
  return { partNumber, start, end, size: end - start };
}
