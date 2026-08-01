/**
 * Produce a CLEAN source handoff — a copy of the repository with everything that
 * must never leave the machine excluded by an explicit denylist.
 *
 * The problem this solves: a naive "copy the folder" handoff shipped
 * `.claude/settings.local.json` (a local hook config), `.uploads/` (two dozen
 * generated test videos), build output and dependencies. None of that belongs in
 * a source deliverable, and the settings file plus any real bucket credentials are
 * actively sensitive.
 *
 * The rules are a DENYLIST, checked as the tree is walked, plus a post-copy
 * self-audit that fails loudly if any denied path slipped through. Nothing is
 * dropped silently: every exclusion is counted and the summary prints the totals.
 *
 *   node scripts/make-handoff.mjs [--out <dir>] [--force] [--dry-run]
 *
 * Default output: a sibling `cineverse-handoff/` next to the repo. `--force`
 * overwrites a non-empty output dir; `--dry-run` reports what would be copied
 * without writing anything.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const ARGS = process.argv.slice(2);
const DRY_RUN = ARGS.includes('--dry-run');
const FORCE = ARGS.includes('--force');
const OUT = (() => {
  const i = ARGS.indexOf('--out');
  if (i >= 0 && ARGS[i + 1]) return path.resolve(ARGS[i + 1]);
  return path.resolve(ROOT, '..', 'cineverse-handoff');
})();
/** Optional portable ZIP of the handoff output. Default: <out>.zip. */
const ZIP = (() => {
  const i = ARGS.indexOf('--zip');
  if (i >= 0 && ARGS[i + 1]) return path.resolve(ARGS[i + 1]);
  return ARGS.includes('--zip') ? `${OUT}.zip` : null;
})();

/* -------------------------------------------------------------------------- */
/*  The denylist                                                              */
/* -------------------------------------------------------------------------- */

/** Directory names excluded ANYWHERE in the tree (matched on the segment). */
const DENY_DIRS = new Set([
  '.git',
  '.claude', // local hook config + settings.local.json — never in source
  '.uploads', // dev-filesystem adapter output: generated test videos
  '.artifacts', // gate/browser result artifacts
  '.next', // build output
  'node_modules', // dependencies — reinstalled from package-lock
  '.turbo',
  '.vercel',
  'coverage',
]);

/** Exact filenames excluded anywhere. `.env.example` is a TEMPLATE and is kept. */
const DENY_FILES = new Set([
  '.env',
  '.env.local',
  '.env.development.local',
  '.env.production.local',
  '.env.test.local',
  '.DS_Store',
]);

/** Extensions excluded anywhere: generated media, build caches, credentials. */
const DENY_EXT = new Set([
  '.mp4',
  '.webm',
  '.ogv',
  '.mov',
  '.mkv',
  '.avi',
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.log',
  // Incremental TypeScript build cache — machine-specific, never source.
  '.tsbuildinfo',
]);

/** A file the denylist would drop, with the rule that dropped it. */
function denyReason(name, isDir) {
  if (isDir) return DENY_DIRS.has(name) ? `dir:${name}` : null;
  if (DENY_FILES.has(name)) return `file:${name}`;
  const ext = path.extname(name).toLowerCase();
  if (DENY_EXT.has(ext)) return `ext:${ext}`;
  return null;
}

/* -------------------------------------------------------------------------- */
/*  Walk + copy                                                               */
/* -------------------------------------------------------------------------- */

const stats = { copied: 0, bytes: 0, excluded: new Map() };
const note = (reason) => stats.excluded.set(reason, (stats.excluded.get(reason) || 0) + 1);

async function walk(rel) {
  const abs = path.join(ROOT, rel);
  const entries = await fsp.readdir(abs, { withFileTypes: true });
  for (const entry of entries) {
    const childRel = path.join(rel, entry.name);
    const reason = denyReason(entry.name, entry.isDirectory());
    if (reason) {
      note(reason);
      continue;
    }
    if (entry.isDirectory()) {
      await walk(childRel);
    } else if (entry.isFile()) {
      const src = path.join(ROOT, childRel);
      const size = (await fsp.stat(src)).size;
      stats.copied += 1;
      stats.bytes += size;
      if (!DRY_RUN) {
        const dest = path.join(OUT, childRel);
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.copyFile(src, dest);
      }
    }
    // Symlinks and other node types are skipped by omission — a source tree has
    // none that matter, and copying one blindly is how a path escape appears.
  }
}

/**
 * Post-copy self-audit: walk the OUTPUT and prove no denied path leaked. This is
 * the check that turns "I think it is clean" into "it is clean".
 */
async function audit(rel = '') {
  const abs = path.join(OUT, rel);
  const entries = await fsp.readdir(abs, { withFileTypes: true });
  const leaks = [];
  for (const entry of entries) {
    const reason = denyReason(entry.name, entry.isDirectory());
    if (reason) leaks.push(path.join(rel, entry.name));
    if (entry.isDirectory()) leaks.push(...(await audit(path.join(rel, entry.name))));
  }
  return leaks;
}

/* -------------------------------------------------------------------------- */
/*  Portable ZIP                                                              */
/* -------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Write a ZIP of `dir` with FORWARD-SLASH entry names.
 *
 * `Compress-Archive` (PowerShell) writes backslash entry names, which makes
 * Info-ZIP `unzip` warn and exit 1 on Linux. The ZIP spec mandates forward
 * slashes, so this writer emits them directly — a portable archive that extracts
 * cleanly everywhere. Deflate (method 8), UTF-8 names (flag bit 11); no external
 * dependency.
 */
async function writeZip(dir, zipPath) {
  const files = [];
  const collect = async (rel) => {
    const entries = await fsp.readdir(path.join(dir, rel), { withFileTypes: true });
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name; // ALWAYS forward slash
      if (entry.isDirectory()) await collect(childRel);
      else if (entry.isFile()) files.push(childRel);
    }
  };
  await collect('');
  files.sort();

  const local = [];
  const central = [];
  let offset = 0;
  const enc = new TextEncoder();

  for (const name of files) {
    const data = await fsp.readFile(path.join(dir, name));
    const crc = crc32(data);
    const deflated = zlib.deflateRawSync(data);
    const nameBytes = Buffer.from(enc.encode(name)); // forward-slash, UTF-8
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(0x0800, 6); // flags: bit 11 UTF-8 names
    lh.writeUInt16LE(8, 8); // deflate
    lh.writeUInt16LE(0, 10); // mod time
    lh.writeUInt16LE(0x21, 12); // mod date = 1980-01-01
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(deflated.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBytes.length, 26);
    lh.writeUInt16LE(0, 28);
    local.push(lh, nameBytes, deflated);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(deflated.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBytes.length, 28);
    cd.writeUInt32LE(0, 30); // extra + comment lengths (both 0)
    cd.writeUInt16LE(0, 34); // disk number start
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(0, 38); // external attrs
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBytes);
    offset += lh.length + nameBytes.length + deflated.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  await fsp.writeFile(zipPath, Buffer.concat([...local, centralBuf, eocd]));
  return { files: files.length };
}

/* -------------------------------------------------------------------------- */
/*  Main                                                                      */
/* -------------------------------------------------------------------------- */

async function main() {
  const log = (m) => console.log(`[handoff] ${m}`);

  if (path.resolve(OUT) === ROOT || OUT.startsWith(ROOT + path.sep)) {
    throw new Error(`refusing to write the handoff INSIDE the repo (${OUT}) — pick an --out outside it`);
  }

  if (!DRY_RUN) {
    if (fs.existsSync(OUT)) {
      const existing = await fsp.readdir(OUT);
      if (existing.length > 0 && !FORCE) {
        throw new Error(`output dir ${OUT} is not empty — pass --force to overwrite it`);
      }
      if (FORCE) await fsp.rm(OUT, { recursive: true, force: true });
    }
    await fsp.mkdir(OUT, { recursive: true });
  }

  log(`source: ${ROOT}`);
  log(`output: ${OUT}${DRY_RUN ? ' (dry run — nothing written)' : ''}`);
  await walk('');

  // The self-audit only runs on a real copy.
  let leaks = [];
  if (!DRY_RUN) {
    leaks = await audit();
    const manifest = [
      `# CineVerse source handoff`,
      `# files: ${stats.copied}`,
      `# bytes: ${stats.bytes}`,
      `# excluded (rule => count):`,
      ...[...stats.excluded.entries()].sort().map(([r, n]) => `#   ${r} => ${n}`),
      '',
    ].join('\n');
    await fsp.writeFile(path.join(OUT, 'HANDOFF_MANIFEST.txt'), manifest, 'utf8');
  }

  log(`copied ${stats.copied} files (${(stats.bytes / (1024 * 1024)).toFixed(1)} MiB)`);
  log('excluded:');
  for (const [reason, count] of [...stats.excluded.entries()].sort()) log(`  ${reason.padEnd(28)} ${count}`);

  if (leaks.length > 0) {
    log(`SELF-AUDIT FAILED — ${leaks.length} denied path(s) leaked into the handoff:`);
    for (const leak of leaks.slice(0, 20)) log(`  ! ${leak}`);
    process.exit(1);
  }
  if (!DRY_RUN) log('self-audit passed — no denied path is present in the handoff');

  if (ZIP && !DRY_RUN) {
    const { files } = await writeZip(OUT, ZIP);
    log(`zip: ${files} entries (forward-slash names) → ${ZIP}`);
  }
  log(DRY_RUN ? 'dry run complete' : `done → ${OUT}`);
}

main().catch((err) => {
  console.error(`[handoff] fatal: ${err?.message || err}`);
  process.exit(1);
});
