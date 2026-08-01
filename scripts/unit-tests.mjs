/**
 * `npm test` — run every unit suite, explicitly.
 *
 * Exists for the same reason the release gate no longer globs: a wildcard that
 * fails to expand, or expands to nothing, makes `node --test` exit 0 having run
 * nothing. Interactively that reads as "all green". Discovery here is shared
 * with the gate, so the two can never disagree about what "the unit suite" is.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { discoverUnitTests, unitTestArgs } from './release-gate-lib.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..');

const files = discoverUnitTests(ROOT);
console.log(`discovered ${files.length} unit-test files`);

spawn(process.execPath, unitTestArgs(files), { cwd: ROOT, stdio: 'inherit', shell: false }).on('exit', (code) =>
  process.exit(code ?? 1),
);
