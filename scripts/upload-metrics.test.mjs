/**
 * Byte aggregation, formatting, speed sampling and ETA.
 *
 * Pure arithmetic, which is exactly why it lives outside the engine: every rule
 * here exists because the naive version renders something wrong on a real 3 GB
 * upload — 103%, `Infinity B/s`, a rate averaged across a four-minute pause, or a
 * part counted twice after a retry.
 *
 * Run: node --test --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/upload-metrics.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeEtaSeconds,
  computePercentage,
  computeUploadedBytes,
  createSpeedSampler,
  formatBytes,
  formatEta,
  formatSpeed,
  partRangeFor,
} from '../src/lib/uploadMetrics.ts';

const KB = 1024;
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/* ============================================== aggregation */

test('uploaded bytes are confirmed parts plus live attempts', () => {
  assert.equal(
    computeUploadedBytes({ completedBytes: 32 * MIB, activeBytes: 4 * MIB, totalBytes: 100 * MIB }),
    36 * MIB,
  );
  // Completed parts alone would make a 16 MiB part look frozen for its whole
  // upload; active bytes alone would lose everything on a resume.
  assert.equal(computeUploadedBytes({ completedBytes: 32 * MIB, activeBytes: 0, totalBytes: 100 * MIB }), 32 * MIB);
  assert.equal(computeUploadedBytes({ completedBytes: 0, activeBytes: 1024, totalBytes: 100 * MIB }), 1024);
});

test('uploaded bytes never exceed the total, and never go negative', () => {
  // A provider double-listing or a rounding artefact must not render as 103%.
  assert.equal(computeUploadedBytes({ completedBytes: 200 * MIB, activeBytes: 50 * MIB, totalBytes: 100 * MIB }), 100 * MIB);
  assert.equal(computeUploadedBytes({ completedBytes: -5, activeBytes: -5, totalBytes: 100 }), 0);
  assert.equal(computeUploadedBytes({ completedBytes: NaN, activeBytes: Infinity, totalBytes: 100 }), 0);
  assert.equal(computeUploadedBytes({ completedBytes: 10, activeBytes: 0, totalBytes: 0 }), 0);
});

test('percentage is a clamped whole number', () => {
  assert.equal(computePercentage(0, 100), 0);
  assert.equal(computePercentage(50, 100), 50);
  assert.equal(computePercentage(100, 100), 100);
  assert.equal(computePercentage(150, 100), 100, 'never over 100');
  assert.equal(computePercentage(-5, 100), 0);
  assert.equal(computePercentage(10, 0), 0, 'no division by zero');
  assert.equal(computePercentage(NaN, 100), 0);
  // 3 GiB at 41% is the case from the spec.
  assert.equal(computePercentage(1.24 * GIB, 3 * GIB), 41);
});

/* ============================================== formatting */

test('bytes format with rising precision', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(734), '734 B');
  assert.equal(formatBytes(2 * KB), '2 KB');
  assert.equal(formatBytes(9.4 * MIB), '9.4 MB');
  assert.equal(formatBytes(734 * MIB), '734 MB');
  // Two decimals on GB: the total of a 3 GB upload stays a stable "3.00 GB".
  assert.equal(formatBytes(3 * GIB), '3.00 GB');
  assert.equal(formatBytes(1.24 * GIB), '1.24 GB');
  assert.equal(formatBytes(-1), '0 B');
  assert.equal(formatBytes(NaN), '0 B');
});

test('exactly 3 GiB reads as the product limit', () => {
  // The interface says "3 GB" for a 3 GiB ceiling deliberately.
  assert.equal(formatBytes(3 * 1024 * 1024 * 1024), '3.00 GB');
  assert.equal(formatBytes(3_221_225_472), '3.00 GB');
});

test('speed is never zero, negative or infinite', () => {
  assert.equal(formatSpeed(null), null);
  assert.equal(formatSpeed(0), null);
  assert.equal(formatSpeed(-1), null);
  assert.equal(formatSpeed(Infinity), null);
  assert.equal(formatSpeed(NaN), null);
  assert.equal(formatSpeed(18.6 * MIB), '18.6 MB/s');
});

test('ETA copy shows seconds only where they help', () => {
  assert.equal(formatEta(null), null);
  assert.equal(formatEta(-1), null);
  assert.equal(formatEta(Infinity), null);
  assert.equal(formatEta(45), 'About 45 sec remaining');
  assert.equal(formatEta(0), 'About 1 sec remaining', 'never "0 sec"');
  assert.equal(formatEta(97), 'About 1 min 37 sec remaining');
  assert.equal(formatEta(180), 'About 3 min remaining');
  // Above ten minutes the seconds are noise that changes every tick.
  assert.equal(formatEta(20 * 60 + 30), 'About 20 min remaining');
  assert.equal(formatEta(72 * 60), 'About 1 hr 12 min remaining');
  assert.equal(formatEta(120 * 60), 'About 2 hr remaining');
});

/* ============================================== speed sampling */

test('a rate needs a meaningful span before it is reported', () => {
  const sampler = createSpeedSampler({ windowMs: 8000, minSpanMs: 1000 });
  assert.deepEqual(sampler.read(), { current: null, smoothed: null, stable: false });

  sampler.sample(0, 1000);
  assert.equal(sampler.read().stable, false, 'one sample is not a rate');

  sampler.sample(1 * MIB, 1500);
  assert.equal(sampler.read().stable, false, 'under the minimum span');

  sampler.sample(2 * MIB, 3000);
  const reading = sampler.read();
  assert.equal(reading.stable, true);
  assert.equal(Math.round(reading.current / MIB), 1, '2 MiB over 2s');
});

test('duplicate and backwards timestamps are ignored', () => {
  const sampler = createSpeedSampler({ minSpanMs: 500 });
  sampler.sample(0, 1000);
  sampler.sample(MIB, 1000); // same instant — would divide by zero
  sampler.sample(MIB, 900); // earlier than the last
  assert.equal(sampler.read().stable, false);

  sampler.sample(MIB, 2000);
  assert.equal(sampler.read().stable, true);
});

test('a byte count that goes backwards restarts the baseline', () => {
  // This is what a retry cleanup looks like: the aborted attempt's transient
  // bytes are removed, so the aggregate legitimately drops.
  const sampler = createSpeedSampler({ minSpanMs: 500 });
  sampler.sample(10 * MIB, 1000);
  sampler.sample(20 * MIB, 2000);
  assert.equal(sampler.read().stable, true);

  sampler.sample(12 * MIB, 3000);
  const after = sampler.read();
  assert.equal(after.stable, false, 'no negative rate across the discontinuity');
  assert.ok(after.current === null || after.current > 0);
});

test('an explicit reset clears history without stopping the clock', () => {
  const sampler = createSpeedSampler({ minSpanMs: 500 });
  sampler.sample(0, 1000);
  sampler.sample(10 * MIB, 2000);
  assert.equal(sampler.read().stable, true);

  sampler.reset();
  assert.equal(sampler.read().stable, false);
  assert.equal(sampler.suspended(), false, 'reset is not a pause');

  sampler.sample(10 * MIB, 3000);
  sampler.sample(20 * MIB, 4000);
  assert.equal(sampler.read().stable, true);
});

test('paused and offline time are excluded, not averaged', () => {
  const sampler = createSpeedSampler({ minSpanMs: 500 });
  sampler.sample(0, 1000);
  sampler.sample(10 * MIB, 2000);
  const running = sampler.read().current;
  assert.ok(running > 0);

  sampler.suspend();
  // Four minutes of pause. Samples during it must not register at all, or the
  // rate collapses to ~0 and the ETA becomes hours.
  sampler.sample(10 * MIB, 100_000);
  sampler.sample(10 * MIB, 240_000);
  assert.equal(sampler.read().stable, false);
  assert.equal(sampler.suspended(), true);

  sampler.resume();
  assert.equal(sampler.suspended(), false);
  sampler.sample(10 * MIB, 241_000);
  sampler.sample(20 * MIB, 242_000);
  const resumed = sampler.read().current;
  // The resumed rate reflects the resumed transfer, not the gap.
  assert.ok(Math.abs(resumed - running) / running < 0.5, `resumed ${resumed} vs ${running}`);
});

test('the window slides so an old burst stops inflating the rate', () => {
  const sampler = createSpeedSampler({ windowMs: 4000, minSpanMs: 500 });
  // A fast burst…
  sampler.sample(0, 0);
  sampler.sample(40 * MIB, 1000);
  const fast = sampler.read().current;
  // …then four seconds of much slower transfer.
  for (let t = 2000; t <= 6000; t += 1000) sampler.sample(40 * MIB + (t / 1000) * MIB, t);
  const slow = sampler.read().current;
  assert.ok(slow < fast, `${slow} should fall below ${fast}`);
});

test('smoothing moves toward the instantaneous rate without jumping to it', () => {
  const sampler = createSpeedSampler({ minSpanMs: 500, smoothing: 0.3 });
  sampler.sample(0, 0);
  sampler.sample(10 * MIB, 1000);
  const first = sampler.read();
  assert.equal(Math.round(first.smoothed / MIB), 10);

  // The rate halves; the smoothed value should fall but stay above the new one.
  for (let t = 2000; t <= 5000; t += 1000) sampler.sample(10 * MIB + ((t - 1000) / 1000) * 5 * MIB, t);
  const later = sampler.read();
  assert.ok(later.smoothed < first.smoothed);
  assert.ok(later.smoothed > later.current * 0.9);
});

/* ============================================== ETA */

test('ETA is null until there is a rate to divide by', () => {
  assert.equal(computeEtaSeconds(0, 100 * MIB, null), null);
  assert.equal(computeEtaSeconds(0, 100 * MIB, 0), null);
  assert.equal(computeEtaSeconds(0, 100 * MIB, -1), null);
  assert.equal(computeEtaSeconds(0, 100 * MIB, NaN), null);
  assert.equal(computeEtaSeconds(0, 100 * MIB, Infinity), null);
});

test('ETA divides the remainder by the smoothed rate', () => {
  assert.equal(computeEtaSeconds(0, 100 * MIB, 10 * MIB), 10);
  assert.equal(computeEtaSeconds(50 * MIB, 100 * MIB, 10 * MIB), 5);
  // Everything uploaded: zero remaining, not a negative estimate.
  assert.equal(computeEtaSeconds(100 * MIB, 100 * MIB, 10 * MIB), 0);
  assert.equal(computeEtaSeconds(150 * MIB, 100 * MIB, 10 * MIB), 0);
});

/* ============================================== client-side plan */

test('client part ranges match the server plan exactly', () => {
  // 17 MiB in 8 MiB parts: two full parts and a 1 MiB tail.
  assert.deepEqual(partRangeFor(1, 8 * MIB, 17 * MIB), { partNumber: 1, start: 0, end: 8 * MIB, size: 8 * MIB });
  assert.deepEqual(partRangeFor(2, 8 * MIB, 17 * MIB), { partNumber: 2, start: 8 * MIB, end: 16 * MIB, size: 8 * MIB });
  assert.deepEqual(partRangeFor(3, 8 * MIB, 17 * MIB), { partNumber: 3, start: 16 * MIB, end: 17 * MIB, size: MIB });
  // Past the end, or a nonsense part number.
  assert.equal(partRangeFor(4, 8 * MIB, 17 * MIB), null);
  assert.equal(partRangeFor(0, 8 * MIB, 17 * MIB), null);
  assert.equal(partRangeFor(1.5, 8 * MIB, 17 * MIB), null);
  assert.equal(partRangeFor(1, 0, 17 * MIB), null);
});

test('a 3 GiB plan at 16 MiB parts covers every byte exactly once', () => {
  const total = 3 * GIB;
  const partSize = 16 * MIB;
  const partCount = Math.ceil(total / partSize);
  assert.equal(partCount, 192);

  let covered = 0;
  let previousEnd = 0;
  for (let n = 1; n <= partCount; n += 1) {
    const range = partRangeFor(n, partSize, total);
    assert.ok(range, `part ${n}`);
    // Contiguous: no gap and no overlap, or the assembled movie is corrupt in a
    // way no size check could detect.
    assert.equal(range.start, previousEnd, `part ${n} starts where ${n - 1} ended`);
    previousEnd = range.end;
    covered += range.size;
  }
  assert.equal(covered, total);
  assert.equal(previousEnd, total);
});
