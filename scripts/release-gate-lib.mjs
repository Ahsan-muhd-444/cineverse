/**
 * Helpers for the release gate, kept in their own module so they can be
 * imported by a test WITHOUT running the gate.
 *
 * `release-gate.mjs` calls `main()` on import, so importing it from a test would
 * build the project and start a server as a side effect of loading the file.
 *
 * ---------------------------------------------------------------------------
 * Why discovery is explicit rather than a wildcard argument
 *
 * The gate used to hand Node the literal string `scripts/*.test.mjs` with
 * `shell:false`, relying on Node's own glob expansion for `--test`. Two ways
 * that reports success having run nothing:
 *
 *   - glob support for `--test` positional arguments is recent. This project
 *     declares `engines: node >=18.18.0`, and on those runtimes the pattern is
 *     not expanded;
 *   - even where it IS supported, a pattern matching zero files exits 0 with
 *     `# tests 0`. Rename the suffix, move the files into a subdirectory, and
 *     the gate goes green while testing nothing.
 *
 * Verified on this machine (Node v24.18.0): `node --test scripts/*.spec.mjs`
 * — a pattern matching nothing — exits 0 having run 0 tests.
 *
 * A test runner that can pass without running tests is worse than no test
 * runner, because it is trusted. So the files are enumerated here, the count is
 * asserted to be nonzero, and each path is passed as its own argv entry.
 * ---------------------------------------------------------------------------
 */

import fs from 'node:fs';
import path from 'node:path';

/** Directories never worth walking when looking for this project's tests. */
const SKIP_DIRECTORIES = new Set(['node_modules', '.next', '.git', '.uploads']);

export const TEST_FILE_SUFFIX = '.test.mjs';

/**
 * Every unit-test file under `scripts/`, as paths relative to `root`.
 *
 * Recursive, so moving suites into subdirectories later cannot silently shrink
 * the gate. Sorted, so a failure is always reported in the same order and two
 * runs are comparable. Throws when nothing is found — an empty test run is a
 * configuration error, never a pass.
 *
 * @param {string} root repository root
 * @param {string} [dir] directory to search, relative to root
 * @returns {string[]} relative paths, e.g. ['scripts/a11y.test.mjs', …]
 */
export function discoverUnitTests(root, dir = 'scripts') {
  const absolute = path.join(root, dir);
  if (!fs.existsSync(absolute)) {
    throw new Error(`Cannot discover unit tests: ${dir} does not exist under ${root}`);
  }

  const found = [];
  const walk = (relativeDir) => {
    const entries = fs.readdirSync(path.join(root, relativeDir), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name)) continue;
        walk(path.join(relativeDir, entry.name));
      } else if (entry.isFile() && entry.name.endsWith(TEST_FILE_SUFFIX)) {
        // POSIX separators keep the printed command readable and identical on
        // both platforms; Node accepts either on Windows.
        found.push(path.join(relativeDir, entry.name).split(path.sep).join('/'));
      }
    }
  };
  walk(dir);

  if (found.length === 0) {
    throw new Error(`No unit test files (*${TEST_FILE_SUFFIX}) were discovered in ${dir}/`);
  }
  return found.sort();
}

/**
 * The full argv for running the discovered suites.
 *
 * Each file is its own element. That is what makes a path containing a space
 * safe: with `shell:false` there is no quoting to get wrong, because there is no
 * shell to re-split the string.
 */
export function unitTestArgs(files) {
  return ['--test', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', ...files];
}

/**
 * Require the realtime step to have left a usable result artifact.
 *
 * The child exiting 0 is one signal; this is the other. Demanding both — and
 * demanding they agree — is what turns "the gate writes four artifacts" from a
 * claim in a summary into an enforced contract. Uses the same validator as the
 * stress harness so the two can never drift.
 *
 * @throws when the artifact is missing, unparseable, empty or inconsistent
 * @returns {{total:number, passed:number, failed:number}} the verified result
 */
export function verifyE2eResultFile(resultFile, { readFileSync, existsSync }, validate) {
  if (!existsSync(resultFile)) {
    throw new Error('realtime E2E exited 0 but wrote no e2e-result.json');
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(resultFile, 'utf8'));
  } catch (err) {
    throw new Error(`e2e-result.json is unreadable: ${err.message}`);
  }
  const verdict = validate(parsed, 0);
  if (!verdict.ok) throw new Error(`e2e-result.json rejected: ${verdict.reason}`);
  return parsed;
}
