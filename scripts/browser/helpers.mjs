/**
 * Shared helpers for the real-browser multipart suite.
 *
 * These drive the ACTUAL room UI — the join gate, the source picker, the file
 * input — not a standalone copy of the engine. The `installProbe` init script
 * gives independent browser-side evidence of the memory bound: it counts
 * `Blob.slice` calls and tracks concurrent PUT XHRs to the bucket, so the
 * assertions do not rely on the engine's own counters.
 */

export const MIB = 1024 * 1024;
export const FIXTURE_BYTES = 17 * MIB; // 3 parts at 8 MiB: 8 + 8 + 1
export const PART_SIZE = 8 * MIB;
export const PART_COUNT = 3;
export const BUCKET_ORIGIN = `http://127.0.0.1:${Number(process.env.BROWSER_TEST_BUCKET_PORT) || 4998}`;

let roomSeq = 0;
/** A fresh 6-char A–Z room code per test, so tests never collide. */
export function freshRoomCode(prefix = 'MP') {
  roomSeq += 1;
  const n = roomSeq.toString(36).toUpperCase().padStart(2, '0');
  return `${prefix}${n}${'ABCDEF'.slice(0, 6 - prefix.length - n.length)}`.slice(0, 8);
}

/** POST a bucket control command (reset, arm faults, toggle CORS, slow parts). */
export async function bucketControl(request, path, body = {}) {
  const res = await request.post(`${BUCKET_ORIGIN}${path}`, { data: body });
  return res.ok();
}

export async function bucketInspect(request) {
  const res = await request.get(`${BUCKET_ORIGIN}/_control/inspect`);
  return res.json();
}

/**
 * Install the browser-side probe BEFORE any app script runs. Records:
 *   - every Blob/File slice (count + sizes) → proves no re-slicing / bounded size
 *   - concurrent PUT XHRs to the bucket (peak) → proves the concurrency bound
 */
export async function installProbe(page) {
  await page.addInitScript((bucketOrigin) => {
    const probe = { sliceCount: 0, sliceSizes: [], maxConcurrentXhr: 0, activeXhr: 0, totalPutXhr: 0 };
    // eslint-disable-next-line no-underscore-dangle
    window.__uploadProbe = probe;

    const origSlice = Blob.prototype.slice;
    Blob.prototype.slice = function patchedSlice(start, end, ...rest) {
      probe.sliceCount += 1;
      if (Number.isFinite(start) && Number.isFinite(end)) probe.sliceSizes.push(end - start);
      return origSlice.call(this, start, end, ...rest);
    };

    const OrigXHR = window.XMLHttpRequest;
    window.XMLHttpRequest = function TrackedXHR() {
      const xhr = new OrigXHR();
      const open = xhr.open.bind(xhr);
      xhr.open = function patchedOpen(method, url, ...r) {
        xhr.__isBucketPut = method === 'PUT' && String(url).startsWith(bucketOrigin);
        return open(method, url, ...r);
      };
      const send = xhr.send.bind(xhr);
      xhr.send = function patchedSend(...args) {
        if (xhr.__isBucketPut) {
          probe.activeXhr += 1;
          probe.totalPutXhr += 1;
          probe.maxConcurrentXhr = Math.max(probe.maxConcurrentXhr, probe.activeXhr);
          xhr.addEventListener('loadend', () => {
            if (xhr.__counted) return;
            xhr.__counted = true;
            probe.activeXhr -= 1;
          });
        }
        return send(...args);
      };
      return xhr;
    };
  }, BUCKET_ORIGIN);
}

export async function readProbe(page) {
  return page.evaluate(() => window.__uploadProbe);
}

/** Join a room as `name`, waiting until the room UI is interactive. */
export async function joinRoom(page, code, name) {
  await page.goto(`/room/${code}`, { waitUntil: 'domcontentloaded' });
  const nameField = page.getByPlaceholder('Your name');
  await nameField.waitFor({ state: 'visible', timeout: 60_000 });
  await nameField.fill(name);
  await page.getByRole('button', { name: 'Take my seat' }).click();
  // The room is ready once a source-picker entry point is present.
  await page.getByRole('button', { name: /Choose what to watch|Choose a film/ }).first().waitFor({ timeout: 60_000 });
}

/** Open the source picker on its Local file tab. */
export async function openLocalFileTab(page) {
  await page.getByRole('button', { name: /Choose what to watch|Choose a film/ }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ state: 'visible' });
  await dialog.getByRole('tab', { name: /Local file/i }).click();
  return dialog;
}

/** Hand the hidden picker file input a generated fixture, starting the upload. */
export async function selectFixture(page, { name = 'movie.mp4', size = FIXTURE_BYTES, lastModified } = {}) {
  const input = page.locator('input[type="file"][accept="video/*"]');
  await input.setInputFiles({
    name,
    mimeType: 'video/mp4',
    buffer: Buffer.alloc(size, 7),
    lastModified,
  });
}

/** The shared-upload progress panel inside the picker (role progressbar). */
export function progressBar(page) {
  return page.getByRole('dialog').locator('[role="progressbar"]').first();
}

/** Wait for the uploader's progress panel to reach a phase-labelled state. */
export async function expectPhaseText(page, pattern, timeout = 40_000) {
  await page.getByRole('dialog').getByText(pattern).first().waitFor({ timeout });
}
