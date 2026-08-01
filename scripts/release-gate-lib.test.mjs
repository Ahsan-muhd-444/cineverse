/**
 * Unit tests for release-gate unit-test DISCOVERY (scripts/release-gate-lib.mjs).
 *
 * The bug being locked out: the gate used to pass Node the literal string
 * `scripts/*.test.mjs` with `shell:false` and trust Node to expand it. When the
 * pattern does not expand — an older runtime, or a pattern matching nothing —
 * `node --test` exits 0 having run zero tests, and the gate reports PASS while
 * testing nothing. A test runner that can pass without running tests is worse
 * than none, because it is believed.
 *
 * These tests build real directory trees on disk rather than mocking `fs`, so
 * they exercise the actual traversal, ordering and error behaviour.
 *
 * Run:  node --test --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/release-gate-lib.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { discoverUnitTests, unitTestArgs, verifyE2eResultFile, TEST_FILE_SUFFIX } from './release-gate-lib.mjs';
import { validateE2eResult } from './e2e-stress-lib.mjs';

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..');

/** Build a throwaway tree: { 'scripts/a.test.mjs': '', 'scripts/sub/b.test.mjs': '' } */
function fixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-gate-'));
  for (const relative of files) {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, '// fixture\n');
  }
  return root;
}

const cleanup = [];
test.after(() => {
  for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
});
function tempTree(files) {
  const root = fixture(files);
  cleanup.push(root);
  return root;
}

/* ---------------- discovery finds everything ---------------- */

test('every *.test.mjs file is discovered', () => {
  const root = tempTree([
    'scripts/alpha.test.mjs',
    'scripts/beta.test.mjs',
    'scripts/gamma.test.mjs',
  ]);
  assert.deepEqual(discoverUnitTests(root), [
    'scripts/alpha.test.mjs',
    'scripts/beta.test.mjs',
    'scripts/gamma.test.mjs',
  ]);
});

test('suites in subdirectories are found too', () => {
  // Moving suites into a folder must not silently shrink the gate.
  const root = tempTree(['scripts/top.test.mjs', 'scripts/unit/nested.test.mjs', 'scripts/unit/deep/deeper.test.mjs']);
  assert.deepEqual(discoverUnitTests(root), [
    'scripts/top.test.mjs',
    'scripts/unit/deep/deeper.test.mjs',
    'scripts/unit/nested.test.mjs',
  ]);
});

/* ---------------- and nothing else ---------------- */

test('unrelated .mjs files are excluded', () => {
  const root = tempTree([
    'scripts/real.test.mjs',
    'scripts/release-gate.mjs',
    'scripts/soak.mjs',
    'scripts/helper.mjs',
    'scripts/notatest.mjs',
  ]);
  assert.deepEqual(discoverUnitTests(root), ['scripts/real.test.mjs']);
});

test('lookalike names are not mistaken for tests', () => {
  const root = tempTree([
    'scripts/keep.test.mjs',
    'scripts/thing.test.js',
    'scripts/thing.test.mts',
    'scripts/test.mjs',
    'scripts/atest.mjs',
  ]);
  const found = discoverUnitTests(root);
  assert.deepEqual(found, ['scripts/keep.test.mjs'], `got ${found.join(', ')}`);
});

test('vendored directories are never walked', () => {
  const root = tempTree(['scripts/mine.test.mjs', 'scripts/node_modules/pkg/theirs.test.mjs']);
  assert.deepEqual(discoverUnitTests(root), ['scripts/mine.test.mjs']);
});

/* ---------------- deterministic ---------------- */

test('ordering is deterministic and sorted', () => {
  const root = tempTree(['scripts/zulu.test.mjs', 'scripts/alpha.test.mjs', 'scripts/mike.test.mjs']);
  const first = discoverUnitTests(root);
  const second = discoverUnitTests(root);
  assert.deepEqual(first, second, 'repeated discovery must not vary');
  assert.deepEqual(first, [...first].sort(), 'and must be sorted');
});

test('separators are POSIX-style on every platform', () => {
  const root = tempTree(['scripts/unit/nested.test.mjs']);
  assert.deepEqual(discoverUnitTests(root), ['scripts/unit/nested.test.mjs']);
});

/* ---------------- an empty run is an ERROR, never a pass ---------------- */

test('discovery THROWS when there are no test files', () => {
  const root = tempTree(['scripts/release-gate.mjs', 'scripts/soak.mjs']);
  assert.throws(() => discoverUnitTests(root), /No unit test files/);
});

test('discovery throws when the directory does not exist at all', () => {
  const root = tempTree(['README.md']);
  assert.throws(() => discoverUnitTests(root), /does not exist/);
});

/* ---------------- paths survive being passed as argv ---------------- */

test('a path containing spaces stays ONE argument', () => {
  // With shell:false there is no quoting to get wrong — but only because each
  // path is its own array element rather than a joined command string.
  const root = tempTree(['scripts/has a space.test.mjs', 'scripts/plain.test.mjs']);
  const files = discoverUnitTests(root);
  assert.equal(files.length, 2);
  const spaced = files.find((f) => f.includes(' '));
  assert.equal(spaced, 'scripts/has a space.test.mjs');

  const args = unitTestArgs(files);
  assert.equal(args.filter((a) => a === spaced).length, 1, 'present exactly once, unsplit');
  assert.equal(args.some((a) => a.includes('"') || a.includes("'")), false, 'never pre-quoted');
});

test('the argv keeps the runner flags and then one entry per file', () => {
  const files = ['scripts/a.test.mjs', 'scripts/b.test.mjs'];
  const args = unitTestArgs(files);
  assert.equal(args[0], '--test');
  assert.deepEqual(args.slice(-2), files);
  assert.equal(args.length, files.length + 2);
  assert.equal(args.some((a) => a.includes('*')), false, 'no wildcard may survive into argv');
});

/* ---------------- the real project ---------------- */

test('the actual repository yields a nonzero number of suites', () => {
  const files = discoverUnitTests(REPO_ROOT);
  assert.ok(files.length > 0, 'the gate must never run an empty suite');
  // A floor, not the exact count: the number rises as suites are added, and
  // hardcoding it would make every new test file a failing build.
  assert.ok(files.length >= 10, `expected the full suite, found ${files.length}`);
  assert.ok(files.includes('scripts/release-gate-lib.test.mjs'), 'including this one');
  assert.equal(files.every((f) => f.endsWith(TEST_FILE_SUFFIX)), true);
});

/* ---------------- the gate must verify its own result artifact ---------------- */

/** Write `content` (or nothing) and run the gate's artifact check over it. */
function verifyWith(content) {
  const root = tempTree(['scripts/placeholder.test.mjs']);
  const file = path.join(root, 'e2e-result.json');
  if (content !== undefined) fs.writeFileSync(file, content);
  return () => verifyE2eResultFile(file, fs, validateE2eResult);
}

test('a MISSING e2e-result.json fails the gate step, even though the child exited 0', () => {
  assert.throws(verifyWith(undefined), /wrote no e2e-result\.json/);
});

test('a MALFORMED e2e-result.json fails the gate step', () => {
  assert.throws(verifyWith('{ "total": 230, "passed": '), /unreadable/);
});

test('an e2e-result.json reporting ZERO checks fails the gate step', () => {
  assert.throws(
    verifyWith(JSON.stringify({ total: 0, passed: 0, failed: 0, failures: [] })),
    /zero checks/,
  );
});

test('an INCONSISTENT e2e-result.json fails the gate step', () => {
  assert.throws(
    verifyWith(JSON.stringify({ total: 230, passed: 100, failed: 0, failures: [] })),
    /inconsistent counts/,
  );
});

test('a result recording failures fails the gate step despite the zero exit', () => {
  // Exit 0 is asserted by the caller, so a result claiming failures is a
  // contradiction the gate must not wave through.
  assert.throws(
    verifyWith(JSON.stringify({ total: 230, passed: 229, failed: 1, failures: [{ index: 91 }] })),
    /exit\/result mismatch/,
  );
});

test('a VALID non-empty successful result passes and is returned', () => {
  const parsed = verifyWith(JSON.stringify({ total: 232, passed: 232, failed: 0, failures: [] }))();
  assert.equal(parsed.total, 232);
  assert.equal(parsed.passed, 232);
});

test('the real discovery excludes the gate scripts themselves', () => {
  const files = discoverUnitTests(REPO_ROOT);
  for (const script of ['scripts/release-gate.mjs', 'scripts/release-gate-lib.mjs', 'scripts/soak.mjs', 'scripts/unit-tests.mjs']) {
    assert.equal(files.includes(script), false, `${script} is not a test suite`);
  }
});
