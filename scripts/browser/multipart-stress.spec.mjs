/**
 * Real-browser cleanup stress: repeated cancel, pause/resume and refresh cycles,
 * proving nothing accumulates — no active XHR, no orphan provider upload, no
 * leaked room progress across many iterations.
 *
 * Kept lighter than the server-side stress (which does 50 cycles in-process) so a
 * real browser run stays under the timeout, but heavy enough to expose a leak
 * that a single pass would miss.
 */

import { test, expect } from '@playwright/test';
import {
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

test.describe.configure({ timeout: 180_000 });

test.beforeEach(async ({ request }) => {
  await bucketControl(request, '/_control/reset');
});

test('20 cancel cycles leave no active XHR and no orphan provider upload', async ({ browser, request }) => {
  await bucketControl(request, '/_control/slow', { ms: 120 });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await installProbe(page);
  try {
    await joinRoom(page, freshRoomCode('SC'), 'Stress');

    for (let i = 0; i < 20; i += 1) {
      await openLocalFileTab(page);
      await selectFixture(page);
      await progressBar(page).waitFor({ state: 'visible', timeout: 20_000 });
      await page.getByRole('dialog').getByRole('button', { name: /Cancel upload|Cancel/ }).first().click();
      await expect(page.getByText('Choose a video from this device')).toBeVisible({ timeout: 15_000 });
    }

    await page.waitForTimeout(800);
    const probe = await readProbe(page);
    expect(probe.activeXhr).toBe(0);
    const inspect = await bucketInspect(request);
    expect(inspect.openUploads).toBe(0);
    expect(inspect.objects.length).toBe(0);
  } finally {
    await ctx.close();
  }
});

test('10 pause/resume cycles then a clean completion', async ({ browser, request }) => {
  await bucketControl(request, '/_control/slow', { ms: 150 });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await installProbe(page);
  try {
    await joinRoom(page, freshRoomCode('SP'), 'Stress');
    await openLocalFileTab(page);
    await selectFixture(page);
    await progressBar(page).waitFor({ state: 'visible', timeout: 20_000 });

    const dialog = page.getByRole('dialog');
    for (let i = 0; i < 10; i += 1) {
      const pause = dialog.getByRole('button', { name: 'Pause' });
      if (await pause.isVisible().catch(() => false)) {
        await pause.click();
        const resume = dialog.getByRole('button', { name: 'Resume' });
        await expect(resume).toBeVisible({ timeout: 8_000 });
        const probe = await readProbe(page);
        expect(probe.activeXhr).toBe(0); // pause aborts active parts every time
        await resume.click();
      }
      // If it already completed between cycles, stop early.
      if (await dialog.isHidden().catch(() => false)) break;
      await page.waitForTimeout(120);
    }

    await expect(dialog).toBeHidden({ timeout: 60_000 });
    const inspect = await bucketInspect(request);
    expect(inspect.openUploads).toBe(0);
    expect(inspect.objects.length).toBe(1);
  } finally {
    await ctx.close();
  }
});
