/**
 * Real-browser multipart SCENARIOS: pause/resume, retry, cancel, offline and
 * refresh recovery — driven through the actual room UI.
 *
 * Each arms the mock bucket (slow parts, injected faults) so the intervention
 * happens while a part is genuinely in flight, then asserts the observable
 * outcome in the browser and the provider's consistency.
 */

import { test, expect } from '@playwright/test';
import {
  FIXTURE_BYTES,
  bucketControl,
  bucketInspect,
  installProbe,
  joinRoom,
  openLocalFileTab,
  selectFixture,
  progressBar,
  readProbe,
  freshRoomCode,
} from './helpers.mjs';

test.beforeEach(async ({ request }) => {
  await bucketControl(request, '/_control/reset');
});

test('pause during an active part, then resume to completion', async ({ browser, request }) => {
  await bucketControl(request, '/_control/slow', { ms: 400 });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await installProbe(page);
  try {
    await joinRoom(page, freshRoomCode('PR'), 'Pauser');
    await openLocalFileTab(page);
    await selectFixture(page);

    const bar = progressBar(page);
    await bar.waitFor({ state: 'visible', timeout: 30_000 });

    const pause = page.getByRole('dialog').getByRole('button', { name: 'Pause' });
    await pause.click();
    // Paused state: a Resume control appears, and no part XHR is left in flight.
    const resume = page.getByRole('dialog').getByRole('button', { name: 'Resume' });
    await expect(resume).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(600); // let any aborted attempt settle
    let probe = await readProbe(page);
    expect(probe.activeXhr).toBe(0);
    const uploadedWhilePaused = probe.totalPutXhr;

    await resume.click();
    // The upload finishes; the picker closes on success.
    await expect(page.getByRole('dialog')).toBeHidden({ timeout: 60_000 });

    probe = await readProbe(page);
    // Resume re-queued only the missing parts — total PUTs stays small (a couple
    // may be re-sent if aborted mid-flight, but nowhere near a full restart).
    expect(probe.totalPutXhr).toBeGreaterThanOrEqual(uploadedWhilePaused);
    expect(probe.totalPutXhr).toBeLessThanOrEqual(5);
    expect(probe.maxConcurrentXhr).toBeLessThanOrEqual(3);

    const inspect = await bucketInspect(request);
    expect(inspect.openUploads).toBe(0);
    expect(inspect.objects.length).toBe(1);
  } finally {
    await ctx.close();
  }
});

test('a retryable part failure is retried and the upload still completes', async ({ browser, request }) => {
  // Part 2 fails once with a 500; the engine must retry it, not abandon the upload.
  await bucketControl(request, '/_control/fail', { fault: 'part:2:once' });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await installProbe(page);
  try {
    await joinRoom(page, freshRoomCode('RT'), 'Retrier');
    await openLocalFileTab(page);
    await selectFixture(page);

    await expect(page.getByRole('dialog')).toBeHidden({ timeout: 60_000 });
    const probe = await readProbe(page);
    // Part 2 was sent twice (fail + retry), so total PUTs is parts + 1.
    expect(probe.totalPutXhr).toBe(4);
    const inspect = await bucketInspect(request);
    expect(inspect.objects.length).toBe(1);
    expect(inspect.openUploads).toBe(0);
  } finally {
    await ctx.close();
  }
});

test('an expired part URL (403) is refreshed and the upload still completes', async ({ browser, request }) => {
  await bucketControl(request, '/_control/fail', { fault: 'part:1:expire' });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    await joinRoom(page, freshRoomCode('EX'), 'Refresher');
    await openLocalFileTab(page);
    await selectFixture(page);
    await expect(page.getByRole('dialog')).toBeHidden({ timeout: 60_000 });
    const inspect = await bucketInspect(request);
    expect(inspect.objects.length).toBe(1);
  } finally {
    await ctx.close();
  }
});

test('cancel aborts the provider upload and publishes nothing', async ({ browser, request }) => {
  await bucketControl(request, '/_control/slow', { ms: 400 });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await installProbe(page);
  try {
    await joinRoom(page, freshRoomCode('CX'), 'Canceller');
    await openLocalFileTab(page);
    await selectFixture(page);

    const bar = progressBar(page);
    await bar.waitFor({ state: 'visible', timeout: 30_000 });
    await page.getByRole('dialog').getByRole('button', { name: /Cancel upload|Cancel/ }).first().click();

    // The picker returns to the file-selection view.
    await expect(page.getByText('Choose a video from this device')).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(600);
    const probe = await readProbe(page);
    expect(probe.activeXhr).toBe(0);
    // The provider multipart upload was aborted; no object exists.
    const inspect = await bucketInspect(request);
    expect(inspect.openUploads).toBe(0);
    expect(inspect.objects.length).toBe(0);
  } finally {
    await ctx.close();
  }
});

test('going offline suspends the upload; coming back online completes it', async ({ browser, request }) => {
  await bucketControl(request, '/_control/slow', { ms: 500 });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await installProbe(page);
  try {
    await joinRoom(page, freshRoomCode('OF'), 'Offliner');
    await openLocalFileTab(page);
    await selectFixture(page);

    const bar = progressBar(page);
    await bar.waitFor({ state: 'visible', timeout: 30_000 });

    // Drop the network mid-upload.
    await ctx.setOffline(true);
    // The engine suspends: a reconnecting affordance appears (state copy), and no
    // part XHR keeps hammering a dead network.
    await expect(page.getByRole('dialog').getByText(/Reconnecting|network problem/i)).toBeVisible({ timeout: 20_000 });

    // Restore the network; the upload resumes from provider-confirmed parts.
    await ctx.setOffline(false);
    await expect(page.getByRole('dialog')).toBeHidden({ timeout: 90_000 });

    const inspect = await bucketInspect(request);
    expect(inspect.objects.length).toBe(1);
    expect(inspect.openUploads).toBe(0);
  } finally {
    await ctx.close();
  }
});

test('a same-tab refresh recovers the session and resumes from the same file', async ({ browser, request }) => {
  await bucketControl(request, '/_control/slow', { ms: 500 });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const code = freshRoomCode('RF');
  try {
    await joinRoom(page, code, 'Refresher');
    await openLocalFileTab(page);
    await selectFixture(page);
    await progressBar(page).waitFor({ state: 'visible', timeout: 30_000 });

    // Let at least one part land, then refresh the tab (sessionStorage survives).
    await page.waitForTimeout(900);
    await page.reload({ waitUntil: 'domcontentloaded' });
    // Re-enter the room (the seat is reclaimed within the grace window).
    const nameField = page.getByPlaceholder('Your name');
    if (await nameField.isVisible().catch(() => false)) {
      await nameField.fill('Refresher');
      await page.getByRole('button', { name: 'Take my seat' }).click();
    }

    // The recovery affordance offers to resume, and asks for the same file.
    await page.getByRole('button', { name: /Choose what to watch|Choose a film/ }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('tab', { name: /Local file/i }).click();
    await expect(dialog.getByText(/Resume upload of|already uploaded/i)).toBeVisible({ timeout: 20_000 });

    // Reselect the SAME file (same name/size/type) to continue.
    await selectFixture(page);
    await expect(page.getByRole('dialog')).toBeHidden({ timeout: 90_000 });
    const inspect = await bucketInspect(request);
    expect(inspect.objects.length).toBe(1);
  } finally {
    await ctx.close();
  }
});
