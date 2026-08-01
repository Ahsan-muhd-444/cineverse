/**
 * Produce an EXACT-size, browser-playable MP4 for the 3 GiB boundary test.
 *
 * A real movie can't land on exactly 3,221,225,472 bytes, and there is no ffmpeg
 * here to encode one. So this takes a real, browser-playable MP4 (H.264/AAC — the
 * 100 MB or 1 GB staging clip) and appends a single MP4 `free` box sized so the
 * file is EXACTLY the requested byte count. `free` is padding: every player reads
 * ftyp/moov/mdat and ignores it, so the video still plays — but the object that
 * lands in the bucket is byte-for-byte the target size, which is what the boundary
 * test checks (part plan, completion, `stat.size === expectedBytes`).
 *
 *   node scripts/staging-media.mjs --in <base.mp4> --out <out.mp4> --bytes 3221225472
 *
 * TEST-ONLY. Never committed, never in the handoff — generated at staging time and
 * deleted after. Not product code.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';

const args = process.argv.slice(2);
const arg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const IN = arg('--in');
const OUT = arg('--out');
const BYTES = Number(arg('--bytes'));
const SELFTEST = args.includes('--selftest');

const FREE_HEADER = 8; // 32-bit box: [4-byte size][4-byte 'free']

/**
 * Copy `inPath` to `outPath`, then append a `free` box so the total is exactly
 * `targetBytes`. Streams the padding in chunks — never buffers gigabytes.
 */
async function padToExactSize(inPath, outPath, targetBytes) {
  const base = (await fsp.stat(inPath)).size;
  const pad = targetBytes - base;
  if (!Number.isSafeInteger(targetBytes) || targetBytes <= 0) throw new Error(`bad target size ${targetBytes}`);
  if (pad < FREE_HEADER) {
    throw new Error(
      `base file (${base} B) is within ${FREE_HEADER} B of the target (${targetBytes} B) — use a smaller base clip`,
    );
  }
  if (pad > 0xffffffff) {
    // A 32-bit box tops out at ~4 GiB of padding; every real target here (3 GiB
    // minus a ≥100 MB base) is well under that, so this only guards a misuse.
    throw new Error(`padding ${pad} B exceeds a 32-bit free box; use a larger base clip`);
  }

  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(outPath);
    out.on('error', reject);
    const src = fs.createReadStream(inPath);
    src.on('error', reject);
    src.on('end', () => {
      // The `free` box header: 32-bit big-endian size (whole box), then 'free'.
      const header = Buffer.alloc(FREE_HEADER);
      header.writeUInt32BE(pad >>> 0, 0);
      header.write('free', 4, 'ascii');
      out.write(header);

      let remaining = pad - FREE_HEADER;
      const CHUNK = 8 * 1024 * 1024;
      const zeros = Buffer.alloc(CHUNK, 0);
      const writeMore = () => {
        while (remaining > 0) {
          const n = Math.min(CHUNK, remaining);
          const ok = out.write(n === CHUNK ? zeros : zeros.subarray(0, n));
          remaining -= n;
          if (!ok) {
            out.once('drain', writeMore);
            return;
          }
        }
        out.end();
      };
      writeMore();
    });
    out.on('finish', resolve);
    src.pipe(out, { end: false });
  });

  const finalSize = (await fsp.stat(outPath)).size;
  if (finalSize !== targetBytes) throw new Error(`size mismatch: wanted ${targetBytes}, got ${finalSize}`);
  return { base, pad, finalSize };
}

async function selftest() {
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'staging-media-'));
  const base = path.join(dir, 'base.bin');
  const out = path.join(dir, 'out.mp4');
  // A stand-in base — the padder only appends bytes, so a dummy proves the math.
  await fsp.writeFile(base, Buffer.from('ftypmock' + 'x'.repeat(1000)));
  const target = 50_000;
  const res = await padToExactSize(base, out, target);
  const size = (await fsp.stat(out)).size;
  const tail = await fsp.readFile(out);
  const boxAt = (await fsp.stat(base)).size;
  const boxSize = tail.readUInt32BE(boxAt);
  const boxType = tail.toString('ascii', boxAt + 4, boxAt + 8);
  await fsp.rm(dir, { recursive: true, force: true });
  const ok = size === target && res.finalSize === target && boxType === 'free' && boxSize === target - res.base;
  console.log(`[media selftest] exact size=${size === target} freeBox=${boxType === 'free'} boxSize=${boxSize} → ${ok ? 'PASS' : 'FAIL'}`);
  process.exit(ok ? 0 : 1);
}

if (SELFTEST) {
  await selftest();
} else {
  if (!IN || !OUT || !Number.isSafeInteger(BYTES)) {
    console.error('usage: node scripts/staging-media.mjs --in <base.mp4> --out <out.mp4> --bytes <exact-bytes>');
    console.error('   or: node scripts/staging-media.mjs --selftest');
    process.exit(2);
  }
  const res = await padToExactSize(IN, OUT, BYTES);
  console.log(`[media] ${OUT} → base ${res.base} B + free ${res.pad} B = ${res.finalSize} B (exact)`);
}
