/**
 * Accessibility decisions for the shared-upload interface.
 *
 * Scope, stated honestly: this repository has no DOM test environment, so these
 * cover the PURE decisions the component consumes — what gets announced, what is
 * deliberately not announced, and which control is legal in which state. The
 * rendered ARIA attributes and real focus movement are in the manual checklist.
 *
 * These rules are the ones that would otherwise be invisible until a screen-reader
 * user hit them: a live region that echoed every progress event would read a 3 GB
 * upload aloud for twenty minutes, and a Pause button on a single-shot upload
 * would silently restart it.
 *
 * Run: node --test --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/upload-a11y.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ANNOUNCE_STEP,
  UPLOAD_PHASE_LABEL,
  isAwaitingProvider,
  nextAnnouncement,
  progressValueText,
  visibleControls,
} from '../src/lib/uploadAnnounce.ts';

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

const input = (over = {}) => ({
  phase: 'uploading',
  percentage: 0,
  totalBytes: 3 * GIB,
  lastPhase: 'uploading',
  lastMilestone: -1,
  ...over,
});

/* ============================================== aria-valuetext */

test('the progress value text carries bytes AND percent', () => {
  // A percentage alone does not tell a listener whether "3%" means three minutes
  // or three hours of waiting.
  assert.equal(
    progressValueText(1.24 * GIB, 3 * GIB, 41),
    '1.24 GB of 3.00 GB uploaded, 41%',
  );
  assert.equal(progressValueText(0, 17 * MIB, 0), '0 B of 17.0 MB uploaded, 0%');
});

/* ============================================== announcements */

test('every phase has copy, and none of it overstates what happened', () => {
  const phases = ['idle', 'starting', 'uploading', 'paused', 'retrying', 'reconnecting', 'finalizing', 'completed', 'cancelled', 'failed'];
  for (const phase of phases) {
    assert.ok(UPLOAD_PHASE_LABEL[phase], phase);
  }
  // 'finalizing' must not read as done; 'completed' must.
  assert.doesNotMatch(UPLOAD_PHASE_LABEL.finalizing, /complete/i);
  assert.match(UPLOAD_PHASE_LABEL.completed, /complete/i);
});

test('a state change always announces', () => {
  for (const phase of ['starting', 'uploading', 'paused', 'reconnecting', 'cancelled', 'completed']) {
    // The previous phase must differ, or this is a progress tick rather than a
    // transition — which is the distinction the next test covers.
    const lastPhase = phase === 'uploading' ? 'starting' : 'uploading';
    const announcement = nextAnnouncement(input({ phase, lastPhase }));
    assert.ok(announcement, phase);
    assert.equal(announcement.text, UPLOAD_PHASE_LABEL[phase]);
    assert.equal(announcement.milestone, -1, 'a state change consumes no milestone');
  }
});

test('finalizing announces the byte total, not "complete"', () => {
  const announcement = nextAnnouncement(input({ phase: 'finalizing', lastPhase: 'uploading', percentage: 100 }));
  assert.equal(announcement.text, '3.00 GB uploaded. Finalizing upload.');
  assert.doesNotMatch(announcement.text, /complete\b/i);
});

test('a failure announces the reason, not the code', () => {
  const describeError = (code) => (code === 'MISSING_ETAG' ? 'The bucket did not return an ETag.' : null);
  const announcement = nextAnnouncement(
    input({ phase: 'failed', lastPhase: 'uploading', error: 'MISSING_ETAG', describeError }),
  );
  assert.equal(announcement.text, 'The bucket did not return an ETag.');
  // An unmapped code still says something useful rather than nothing.
  const fallback = nextAnnouncement(input({ phase: 'failed', lastPhase: 'uploading', error: 'WEIRD', describeError }));
  assert.equal(fallback.text, 'Upload failed.');
});

test('byte progress announces only on a new 5% milestone', () => {
  assert.equal(ANNOUNCE_STEP, 5);

  // 0–4% while nothing has been announced yet: 0% is the first milestone.
  assert.equal(nextAnnouncement(input({ percentage: 0, lastMilestone: -1 })).milestone, 0);
  assert.equal(nextAnnouncement(input({ percentage: 4, lastMilestone: 0 })), null);
  assert.equal(nextAnnouncement(input({ percentage: 5, lastMilestone: 0 })).text, '5% uploaded');
  assert.equal(nextAnnouncement(input({ percentage: 9, lastMilestone: 5 })), null);
  assert.equal(nextAnnouncement(input({ percentage: 41, lastMilestone: 40 })), null, '41% is inside the 40% step');
  assert.equal(nextAnnouncement(input({ percentage: 45, lastMilestone: 40 })).text, '45% uploaded');
  // Never backwards: a byte count that dropped after a retry cleanup must not
  // re-announce a milestone the listener already heard.
  assert.equal(nextAnnouncement(input({ percentage: 20, lastMilestone: 60 })), null);
});

test('a 3 GB upload announces at most 21 progress milestones', () => {
  // The number that matters: 0,5,…,100 is 21 announcements over twenty minutes,
  // not thousands.
  let lastMilestone = -1;
  const announced = [];
  for (let percent = 0; percent <= 100; percent += 1) {
    const announcement = nextAnnouncement(input({ percentage: percent, lastMilestone }));
    if (!announcement) continue;
    lastMilestone = announcement.milestone;
    announced.push(announcement.text);
  }
  assert.equal(announced.length, 21);
  assert.equal(announced[0], '0% uploaded');
  assert.equal(announced.at(-1), '100% uploaded');
});

test('speed and ETA are never announced', () => {
  // They change several times a second and a listener cannot act on either.
  let lastMilestone = -1;
  for (let percent = 0; percent <= 100; percent += 1) {
    const announcement = nextAnnouncement(input({ percentage: percent, lastMilestone }));
    if (!announcement) continue;
    lastMilestone = announcement.milestone;
    assert.doesNotMatch(announcement.text, /\/s|remaining|MB\/s|speed/i, announcement.text);
  }
});

test('nothing is announced while paused, reconnecting or finished', () => {
  for (const phase of ['paused', 'reconnecting', 'completed', 'cancelled', 'failed', 'idle', 'finalizing']) {
    // Same phase as last time, so this is a pure progress tick.
    assert.equal(
      nextAnnouncement(input({ phase, lastPhase: phase, percentage: 55, lastMilestone: 10 })),
      null,
      phase,
    );
  }
  // Retrying still announces progress: bytes are still moving.
  assert.ok(nextAnnouncement(input({ phase: 'retrying', lastPhase: 'retrying', percentage: 55, lastMilestone: 10 })));
});

/* ============================================== controls */

test('Pause is offered ONLY for a resumable multipart upload', () => {
  for (const phase of ['uploading', 'retrying']) {
    assert.equal(visibleControls({ phase, mode: 'multipart' }).pause, true, `multipart ${phase}`);
    // A single HTTP request cannot pause and resume. Offering the button would
    // either do nothing or silently restart the whole transfer.
    assert.equal(visibleControls({ phase, mode: 'single' }).pause, false, `single ${phase}`);
  }
  assert.equal(visibleControls({ phase: 'paused', mode: 'multipart' }).resume, true);
  assert.equal(visibleControls({ phase: 'paused', mode: 'single' }).resume, false);
});

test('Pause and Resume are never offered at the same time', () => {
  const phases = ['idle', 'starting', 'uploading', 'paused', 'retrying', 'reconnecting', 'finalizing', 'completed', 'cancelled', 'failed'];
  for (const phase of phases) {
    for (const mode of ['single', 'multipart', null]) {
      const controls = visibleControls({ phase, mode });
      assert.equal(controls.pause && controls.resume, false, `${mode}/${phase}`);
    }
  }
});

test('Cancel disappears once an upload is over, and Retry appears only on failure', () => {
  assert.equal(visibleControls({ phase: 'uploading', mode: 'multipart' }).cancel, true);
  assert.equal(visibleControls({ phase: 'finalizing', mode: 'multipart' }).cancel, true);
  assert.equal(visibleControls({ phase: 'completed', mode: 'multipart' }).cancel, false);
  assert.equal(visibleControls({ phase: 'cancelled', mode: 'multipart' }).cancel, false);
  // A failed upload offers Retry and a fresh file, not Cancel.
  const failed = visibleControls({ phase: 'failed', mode: 'multipart' });
  assert.deepEqual(failed, { pause: false, resume: false, cancel: false, retry: true, reselect: true });
  assert.equal(visibleControls({ phase: 'uploading', mode: 'multipart' }).retry, false);
});

test('a recovered session offers a reselection instead of transport controls', () => {
  const controls = visibleControls({
    phase: 'idle',
    mode: 'multipart',
    recovery: { fileName: 'movie.mp4', size: 3 * GIB, uploadedBytes: 1.24 * GIB },
  });
  // Nothing is in flight, so Pause and Resume would be meaningless.
  assert.deepEqual(controls, { pause: false, resume: false, cancel: true, retry: false, reselect: true });
});

test('awaiting-provider is its own state, distinct from completed', () => {
  assert.equal(isAwaitingProvider({ phase: 'finalizing' }), true);
  assert.equal(isAwaitingProvider({ phase: 'completed' }), false);
  assert.equal(isAwaitingProvider({ phase: 'uploading' }), false);
});
