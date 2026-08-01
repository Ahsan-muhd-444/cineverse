/**
 * Provider-listing hardening for S3 multipart.
 *
 * Separate from uploads-s3-multipart.test.mjs because these cases are about
 * DEFENDING against a provider (or a proxy rewriting XML) that returns
 * something we did not expect: wrong types, duplicate parts, or a pagination
 * cursor that never terminates. No bucket, no credentials.
 *
 * Every control character here is built from its code point rather than typed
 * literally. A literal C1 byte in a source file is invisible in review, which
 * is exactly the property that makes it dangerous inside an ETag.
 *
 * Run: node --test --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/uploads-s3-listing.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createS3Multipart } = require('../server/storage/s3-multipart.js');
const { normalizeEtag } = require('../server/upload-limits.js');

const CONFIG = { endpoint: 'https://e.example', bucket: 'b', accessKeyId: 'k', secretAccessKey: 's', region: 'auto' };
const KEY = 'rooms/ABC123/0123456789abcdef/movie.mp4';
const UPLOAD_ID = 'upload-abc';

function harness(replies) {
  const sent = [];
  const queue = [...replies];
  const client = {
    async send(command) {
      sent.push(command);
      const next = queue.shift();
      if (typeof next === 'function') return next(command);
      if (next instanceof Error) throw next;
      return next ?? {};
    },
  };
  return { api: createS3Multipart(CONFIG, {}, { client, getSignedUrl: async () => 'https://s' }), sent };
}
const part = (n) => ({ PartNumber: n, ETag: `"etag-${n}"`, Size: 8 * 1024 * 1024 });
const list = (api) => api.listMultipartParts({ key: KEY, uploadId: UPLOAD_ID });

/** `a<char>b` for a given code point. */
const ctrl = (code) => `a${String.fromCharCode(code)}b`;

/* ------------------------------------------------------------ typing */

test('a numeric-string part number is rejected, not coerced', async () => {
  const { api } = harness([{ Parts: [{ PartNumber: '1', ETag: '"e"', Size: 1 }], IsTruncated: false }]);
  await assert.rejects(() => list(api), /malformed part number/);
});

test('a numeric-string size is rejected, not coerced', async () => {
  const { api } = harness([{ Parts: [{ PartNumber: 1, ETag: '"e"', Size: '1' }], IsTruncated: false }]);
  await assert.rejects(() => list(api), /malformed size/);
});

test('part number 10001 is rejected; 10000 is accepted', async () => {
  const bad = harness([{ Parts: [{ PartNumber: 10001, ETag: '"e"', Size: 1 }], IsTruncated: false }]);
  await assert.rejects(() => list(bad.api), /malformed part number/);

  const ok = harness([{ Parts: [{ PartNumber: 10000, ETag: '"e"', Size: 1 }], IsTruncated: false }]);
  assert.equal((await list(ok.api))[0].partNumber, 10000);
});

test('CR, LF, C0 and C1 control characters in an ETag are rejected', async () => {
  const bad = [
    ctrl(0x0d), // CR
    ctrl(0x0a), // LF
    `a${String.fromCharCode(0x0d)}${String.fromCharCode(0x0a)}b`, // CRLF, header-injection shape
    ctrl(0x00), // NUL
    ctrl(0x09), // TAB
    ctrl(0x1f), // unit separator
    ctrl(0x7f), // DEL
    ctrl(0x85), // C1 NEL — a line break to some parsers
    ctrl(0x9b), // C1 CSI
  ];
  for (const etag of bad) {
    assert.equal(normalizeEtag(etag), null, `shared validator must reject ${JSON.stringify(etag)}`);
    const { api } = harness([{ Parts: [{ PartNumber: 1, ETag: etag, Size: 1 }], IsTruncated: false }]);
    await assert.rejects(() => list(api), /malformed etag/, `adapter must reject ${JSON.stringify(etag)}`);
  }
});

/* -------------------------------------------------------- duplicates */

test('duplicate part numbers are rejected within a page', async () => {
  const { api } = harness([{ Parts: [part(1), part(1)], IsTruncated: false }]);
  await assert.rejects(() => list(api), /more than once/);
});

test('duplicate part numbers are rejected across pages', async () => {
  const { api } = harness([
    { Parts: [part(1), part(2)], IsTruncated: true, NextPartNumberMarker: '2' },
    { Parts: [part(2)], IsTruncated: false },
  ]);
  await assert.rejects(() => list(api), /more than once/);
});

/* -------------------------------------------------------- pagination */

test('a repeated continuation marker is rejected rather than looping forever', async () => {
  const replies = Array.from({ length: 40 }, (_, i) => ({
    Parts: [part(i + 1)],
    IsTruncated: true,
    NextPartNumberMarker: '7',
  }));
  const { api, sent } = harness(replies);
  await assert.rejects(() => list(api), /repeated continuation marker/);
  assert.ok(sent.length < 10, `must stop quickly, sent ${sent.length}`);
});

test('a backwards continuation marker is rejected', async () => {
  const { api } = harness([
    { Parts: [part(1), part(2), part(3)], IsTruncated: true, NextPartNumberMarker: '3' },
    { Parts: [part(4)], IsTruncated: true, NextPartNumberMarker: '2' },
  ]);
  await assert.rejects(() => list(api), /moved backwards/);
});

test('an endlessly truncated listing is bounded by a page cap', async () => {
  // Distinct, strictly increasing markers every time: only the page cap can
  // stop this. Without it the loop runs until the process dies.
  let n = 0;
  const replies = Array.from({ length: 200 }, () => () => {
    n += 1;
    return { Parts: [part(n)], IsTruncated: true, NextPartNumberMarker: String(n) };
  });
  const { api, sent } = harness(replies);
  await assert.rejects(() => list(api), /refusing to loop/);
  assert.ok(sent.length <= 33, `page cap must bound the loop, sent ${sent.length}`);
});

test('accumulating more than 10000 parts is rejected', async () => {
  // 1000 parts per page, strictly increasing markers, never terminating. Either
  // the part-count guard or the part-number range fires — both are termination.
  let base = 0;
  const replies = Array.from({ length: 32 }, () => () => {
    const parts = Array.from({ length: 1000 }, (_, i) => part(base + i + 1));
    base += 1000;
    return { Parts: parts, IsTruncated: true, NextPartNumberMarker: String(base) };
  });
  const { api } = harness(replies);
  await assert.rejects(() => list(api), /more than 10000 parts|malformed part number/);
});

/* ------------------------------------------------- shared validator */

test('the adapter preserves every ETag the shared validator accepts', async () => {
  for (const etag of ['"d41d8cd98f00b204e9800998ecf8427e"', 'W/"weak"', 'a1b2-99', 'x'.repeat(1024)]) {
    assert.equal(normalizeEtag(etag), etag);
    const { api } = harness([{ Parts: [{ PartNumber: 1, ETag: etag, Size: 1 }], IsTruncated: false }]);
    assert.equal((await list(api))[0].etag, etag, 'byte-for-byte');
  }
  assert.equal(normalizeEtag('x'.repeat(1025)), null);
  const { api } = harness([{ Parts: [{ PartNumber: 1, ETag: 'x'.repeat(1025), Size: 1 }], IsTruncated: false }]);
  await assert.rejects(() => list(api), /malformed etag/);
});

test('a well-behaved multi-page listing still works', async () => {
  const { api } = harness([
    { Parts: [part(1), part(2)], IsTruncated: true, NextPartNumberMarker: '2' },
    { Parts: [part(3)], IsTruncated: true, NextPartNumberMarker: '3' },
    { Parts: [part(4)], IsTruncated: false },
  ]);
  assert.deepEqual((await list(api)).map((p) => p.partNumber), [1, 2, 3, 4]);
});


/* ------------------------------------------ plan-aware listing (item 7) */

test('ListPartsCommand always requests MaxParts: 1000', async () => {
  const { api, sent } = harness([{ Parts: [part(1)], IsTruncated: false }]);
  await api.listMultipartParts({ key: KEY, uploadId: UPLOAD_ID });
  assert.equal(sent[0].input.MaxParts, 1000, 'page size must be explicit, not a provider default');
});

test('a part beyond the planned count is rejected', async () => {
  const { api } = harness([{ Parts: [part(1), part(2), part(3)], IsTruncated: false }]);
  await assert.rejects(
    () => api.listMultipartParts({ key: KEY, uploadId: UPLOAD_ID, expectedPartCount: 2 }),
    /beyond the planned 2/,
  );
});

test('accumulated parts may not exceed the planned count', async () => {
  const { api } = harness([
    { Parts: [part(1), part(2)], IsTruncated: true, NextPartNumberMarker: '2' },
    { Parts: [part(3)], IsTruncated: false },
  ]);
  await assert.rejects(
    () => api.listMultipartParts({ key: KEY, uploadId: UPLOAD_ID, expectedPartCount: 2 }),
    /beyond the planned 2|more than 2 parts/,
  );
});



test('a listing that matches the plan exactly still succeeds', async () => {
  const { api } = harness([{ Parts: [part(1), part(2), part(3)], IsTruncated: false }]);
  const parts = await api.listMultipartParts({ key: KEY, uploadId: UPLOAD_ID, expectedPartCount: 3 });
  assert.deepEqual(parts.map((p) => p.partNumber), [1, 2, 3]);
});

test('384 planned parts arriving in many short pages still succeeds', async () => {
  /*
   * MaxParts is a REQUESTED page size, not a guarantee. A provider may return
   * short pages for any reason, so bounding the loop by ceil(planned/1000)+2
   * rejected perfectly valid listings: 384 parts in five pages needed only 3
   * allowed pages under the old rule. The bound is now planned+1.
   */
  const PLANNED = 384;
  const pages = [];
  let next = 1;
  while (next <= PLANNED) {
    const size = Math.min(90 + (next % 7), PLANNED - next + 1); // deliberately short, uneven
    const parts = Array.from({ length: size }, (_, i) => part(next + i));
    next += size;
    pages.push({ Parts: parts, IsTruncated: next <= PLANNED, NextPartNumberMarker: String(next - 1) });
  }
  assert.ok(pages.length >= 4, `fixture must use several pages, got ${pages.length}`);

  const { api, sent } = harness(pages);
  const listed = await api.listMultipartParts({ key: KEY, uploadId: UPLOAD_ID, expectedPartCount: PLANNED });
  assert.equal(listed.length, PLANNED);
  assert.deepEqual(listed.map((p) => p.partNumber).slice(0, 3), [1, 2, 3]);
  assert.equal(listed[listed.length - 1].partNumber, PLANNED);
  assert.equal(sent.length, pages.length);
});

test('one part per page still completes for a large plan', async () => {
  // The pathological-but-legal extreme: planned+1 pages must be permitted.
  const PLANNED = 40;
  const pages = Array.from({ length: PLANNED }, (_, i) => ({
    Parts: [part(i + 1)],
    IsTruncated: i + 1 < PLANNED,
    NextPartNumberMarker: String(i + 1),
  }));
  const { api } = harness(pages);
  const listed = await api.listMultipartParts({ key: KEY, uploadId: UPLOAD_ID, expectedPartCount: PLANNED });
  assert.equal(listed.length, PLANNED);
});

test('the page loop is still bounded when a provider never terminates', async () => {
  // Strictly advancing markers, empty pages: only the planned+1 cap can stop it.
  let n = 0;
  const replies = Array.from({ length: 500 }, () => () => {
    n += 1;
    return { Parts: [], IsTruncated: true, NextPartNumberMarker: String(n) };
  });
  const { api, sent } = harness(replies);
  await assert.rejects(
    () => api.listMultipartParts({ key: KEY, uploadId: UPLOAD_ID, expectedPartCount: 8 }),
    /refusing to loop/,
  );
  assert.ok(sent.length <= 9, `planned+1 page cap, sent ${sent.length}`);
});
