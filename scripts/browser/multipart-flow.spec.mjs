/**
 * The real-browser multipart flow: two members, the actual room UI, a real
 * cross-origin bucket.
 *
 * This is the proof the engine's unit tests cannot give — real `File.slice`, real
 * cross-origin XHR PUTs, a real ETag read from a response header, the real
 * SharedUploadProgress component, and the source reaching a second browser. The
 * injected probe gives independent evidence of the memory bound.
 */

import { test, expect } from '@playwright/test';
import {
  BUCKET_ORIGIN,
  FIXTURE_BYTES,
  PART_COUNT,
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

test('two members: multipart upload, live progress, partner progress, published source', async ({ browser, request }) => {
  // Slow the parts so the progress UI and partner row are observable mid-flight.
  await bucketControl(request, '/_control/slow', { ms: 300 });
  const code = freshRoomCode('FL');

  const uploaderCtx = await browser.newContext();
  const partnerCtx = await browser.newContext();
  const uploader = await uploaderCtx.newPage();
  const partner = await partnerCtx.newPage();
  await installProbe(uploader);

  try {
    await joinRoom(uploader, code, 'Uploader');
    await joinRoom(partner, code, 'Partner');

    await openLocalFileTab(uploader);
    await selectFixture(uploader);

    /* ---- the uploader sees a correct progressbar ---- */
    const bar = progressBar(uploader);
    await bar.waitFor({ state: 'visible', timeout: 30_000 });
    await expect(bar).toHaveAttribute('aria-valuemin', '0');
    await expect(bar).toHaveAttribute('aria-valuemax', String(FIXTURE_BYTES));
    const valueText = await bar.getAttribute('aria-valuetext');
    expect(valueText).toMatch(/of .* uploaded/i);
    // aria-valuenow is a real byte count within the total.
    const valueNow = Number(await bar.getAttribute('aria-valuenow'));
    expect(valueNow).toBeGreaterThanOrEqual(0);
    expect(valueNow).toBeLessThanOrEqual(FIXTURE_BYTES);

    /* ---- the partner sees throttled progress, not the uploader's speed/ETA ---- */
    const partnerRow = partner.getByText(/Uploader is uploading/i);
    await partnerRow.waitFor({ timeout: 30_000 });
    const partnerPanel = await partner.getByText(/Uploader is uploading/i).locator('xpath=ancestor::*[1]').innerText();
    expect(partnerPanel).not.toMatch(/\/s\b/); // no speed
    expect(partnerPanel).not.toMatch(/remaining/i); // no ETA

    /* ---- completion: the picker closes and the source is published to both ---- */
    await expect(uploader.getByRole('dialog')).toBeHidden({ timeout: 60_000 });
    // The uploader's screen is no longer dark.
    await expect(uploader.getByText('The screen is dark')).toBeHidden({ timeout: 20_000 });
    // The source reached the partner too.
    await expect(partner.getByText('The screen is dark')).toBeHidden({ timeout: 20_000 });
    // The partner progress row clears on completion.
    await expect(partner.getByText(/Uploader is uploading/i)).toBeHidden({ timeout: 20_000 });

    /* ---- memory-bound evidence, measured in the real browser ---- */
    const probe = await readProbe(uploader);
    expect(probe.totalPutXhr).toBe(PART_COUNT); // one PUT per part, no re-sends
    expect(probe.sliceCount).toBe(PART_COUNT); // one File.slice per part, no re-slicing
    expect(probe.maxConcurrentXhr).toBeGreaterThanOrEqual(1);
    expect(probe.maxConcurrentXhr).toBeLessThanOrEqual(3); // never exceeds concurrency
    expect(Math.max(...probe.sliceSizes)).toBeLessThanOrEqual(8 * 1024 * 1024); // bounded slice size
    expect(probe.activeXhr).toBe(0); // nothing left in flight

    /* ---- the provider is consistent: no orphan upload, exactly one object ---- */
    const inspect = await bucketInspect(request);
    expect(inspect.openUploads).toBe(0);
    expect(inspect.objects.length).toBe(1);
  } finally {
    await uploaderCtx.close();
    await partnerCtx.close();
  }
});

test('the browser reads the ETag header only when CORS exposes it (MISSING_ETAG otherwise)', async ({ browser, request }) => {
  const uploaderCtx = await browser.newContext();
  const uploader = await uploaderCtx.newPage();
  try {
    /* ---- negative: the bucket does NOT expose ETag ---- */
    await bucketControl(request, '/_control/cors', { exposeEtag: false });
    const code = freshRoomCode('CN');
    await joinRoom(uploader, code, 'NoEtag');
    await openLocalFileTab(uploader);
    await selectFixture(uploader);

    // The part PUT succeeds at the HTTP level, but the browser cannot read the
    // ETag, so the engine fails the upload with MISSING_ETAG — the single most
    // common multipart misconfiguration. This can ONLY be proven in a real
    // browser, under the actual CORS security model.
    await expect(uploader.getByText(/didn.t return an ETag|ETag header/i)).toBeVisible({ timeout: 40_000 });
    // No object was published.
    let inspect = await bucketInspect(request);
    expect(inspect.objects.length).toBe(0);

    /* ---- positive: expose ETag, and the same upload completes ---- */
    await bucketControl(request, '/_control/cors', { exposeEtag: true });
    await bucketControl(request, '/_control/reset');
    await bucketControl(request, '/_control/cors', { exposeEtag: true });
    const code2 = freshRoomCode('CY');
    await uploader.reload();
    await joinRoom(uploader, code2, 'WithEtag');
    await openLocalFileTab(uploader);
    await selectFixture(uploader);
    await expect(uploader.getByRole('dialog')).toBeHidden({ timeout: 60_000 });
    inspect = await bucketInspect(request);
    expect(inspect.objects.length).toBe(1);
  } finally {
    await uploaderCtx.close();
  }
});

test('rendered SharedUploadProgress exposes correct progressbar semantics and controls', async ({ browser, request }) => {
  await bucketControl(request, '/_control/slow', { ms: 500 });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  try {
    const code = freshRoomCode('A1');
    await joinRoom(page, code, 'A11y');
    await openLocalFileTab(page);
    await selectFixture(page);

    const bar = progressBar(page);
    await bar.waitFor({ state: 'visible', timeout: 30_000 });
    // The rendered ARIA contract (item 10), on the ACTUAL component.
    await expect(bar).toHaveAttribute('role', 'progressbar');
    await expect(bar).toHaveAttribute('aria-valuemin', '0');
    await expect(bar).toHaveAttribute('aria-valuemax', String(FIXTURE_BYTES));
    expect(await bar.getAttribute('aria-valuenow')).not.toBeNull();
    expect(await bar.getAttribute('aria-valuetext')).toMatch(/of .* uploaded, \d+%/i);

    // The multipart Pause control is present and keyboard-operable.
    const pause = page.getByRole('dialog').getByRole('button', { name: 'Pause' });
    await expect(pause).toBeVisible();
    await pause.focus();
    await expect(pause).toBeFocused();
    await page.keyboard.press('Enter'); // pause via keyboard
    // Pausing surfaces a Resume control (focus can move to it).
    const resume = page.getByRole('dialog').getByRole('button', { name: 'Resume' });
    await expect(resume).toBeVisible({ timeout: 10_000 });

    // A live region carries state changes for a screen reader.
    const liveRegion = page.getByRole('dialog').locator('[aria-live="polite"]');
    await expect(liveRegion).toHaveCount(1);
  } finally {
    await ctx.close();
  }
});
