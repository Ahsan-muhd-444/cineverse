/**
 * Unit tests for child-process log handling (scripts/child-process-lib.mjs).
 *
 * The property under test is that a diagnostic artifact is COMPLETE. The bug
 * being locked out: flushing the log sink from the child's `exit` event. `exit`
 * fires when the process dies, while its stdout/stderr pipes may still hold
 * unread data — so the lines lost are the LAST ones, which is exactly the
 * failing assertion and the summary you opened the log to read.
 *
 * The tail-marker tests below fail if the implementation regresses to `exit`.
 *
 * Run:  node --test --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/child-process-lib.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runLoggedChild, closeLogSink, stopChild } from './child-process-lib.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-proc-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

let n = 0;
const logPath = () => path.join(TMP, `log-${(n += 1)}.txt`);

/** Spawn `node -e <source>` with its output teed into a fresh log file. */
function runSource(source, options = {}) {
  const file = logPath();
  const sink = fs.createWriteStream(file);
  const child = spawn(process.execPath, ['-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => sink.write(d));
  child.stderr.on('data', (d) => sink.write(d));
  return { file, promise: runLoggedChild(child, sink, 'test child', options), child };
}

/**
 * A backpressure-aware writer for child sources.
 *
 * `process.exit()` after a large write is NOT a valid way to test the parent:
 * it can discard the child's own pending stdout before those bytes ever leave
 * the child, so the test would fail for a reason that has nothing to do with
 * whether the parent flushed on `exit` or `close`. Await the drain and set
 * `process.exitCode` instead, letting Node exit once its output is flushed.
 */
const CHILD_WRITER = `
  const write = (stream, value) =>
    new Promise((resolve, reject) => {
      stream.once('error', reject);
      if (stream.write(value)) resolve();
      else stream.once('drain', resolve);
    });
`;

/* ---------------- the tail must survive ---------------- */

test('a large stdout payload and its final marker are preserved', async () => {
  const marker = 'FINAL_STDOUT_MARKER_9d41c2';
  const { file, promise } = runSource(`${CHILD_WRITER}
    (async () => {
      await write(process.stdout, 'x'.repeat(2000000));
      await write(process.stdout, '\\n${marker}\\n');
      process.exitCode = 0;
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `);
  await promise;
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes(marker), 'the final marker was lost — the log was truncated');
  assert.ok(text.length > 2_000_000, `expected the bulk output too, got ${text.length} bytes`);
  assert.ok(text.trimEnd().endsWith(marker), 'the marker must be the LAST thing in the log');
});

test('a large stderr payload and its final marker are preserved', async () => {
  const marker = 'FINAL_STDERR_MARKER_7b0e55';
  const { file, promise } = runSource(`${CHILD_WRITER}
    (async () => {
      await write(process.stderr, 'e'.repeat(1000000));
      await write(process.stderr, '\\n${marker}\\n');
      process.exitCode = 1;
    })().catch(() => { process.exitCode = 1; });
  `, { allowNonZero: true });
  const { code } = await promise;
  assert.equal(code, 1);
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes(marker), 'the final stderr marker was lost');
  assert.ok(text.length > 1_000_000, `expected the bulk output too, got ${text.length} bytes`);
});

test('both streams can write concurrently without truncation', async () => {
  const { file, promise } = runSource(`${CHILD_WRITER}
    (async () => {
      for (let i = 0; i < 400; i += 1) {
        await write(process.stdout, 'OUT' + i + '\\n');
        await write(process.stderr, 'ERR' + i + '\\n');
      }
      await write(process.stdout, 'DONE_OUT\\n');
      await write(process.stderr, 'DONE_ERR\\n');
      process.exitCode = 0;
    })().catch((error) => { console.error(error); process.exitCode = 1; });
  `);
  await promise;
  const text = fs.readFileSync(file, 'utf8');
  assert.equal((text.match(/^OUT\d+$/gm) || []).length, 400, 'stdout lines lost');
  assert.equal((text.match(/^ERR\d+$/gm) || []).length, 400, 'stderr lines lost');
  assert.ok(text.includes('DONE_OUT') && text.includes('DONE_ERR'));
});

/* ---------------- deterministic close-ordering ---------------- */

/**
 * A stand-in for a ChildProcess whose events we can order exactly.
 *
 * The real-child tests above prove large output and final markers survive, but
 * they are NOT proof that `close` was used: pipe scheduling may well deliver
 * everything before `exit` fires, so an `exit`-based implementation could pass
 * them by luck. Only a controlled event order can decide it.
 */
function fakeChild() {
  const child = new EventEmitter();
  child.pid = 12345;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

test('data arriving AFTER exit but before close is still preserved', async () => {
  const file = logPath();
  const sink = fs.createWriteStream(file);
  const child = fakeChild();
  child.stdout.on('data', (chunk) => sink.write(chunk));
  child.stderr.on('data', (chunk) => sink.write(chunk));

  const completion = runLoggedChild(child, sink, 'ordered child');

  child.stdout.emit('data', Buffer.from('before-exit\n'));
  child.emit('exit', 0, null);
  // Deliberately after `exit`: this is the data an exit-based flush loses.
  child.stdout.emit('data', Buffer.from('FINAL_STDOUT_AFTER_EXIT\n'));
  child.stderr.emit('data', Buffer.from('FINAL_STDERR_AFTER_EXIT\n'));
  child.emit('close', 0, null);

  await completion;
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /before-exit/);
  assert.match(text, /FINAL_STDOUT_AFTER_EXIT/);
  assert.match(text, /FINAL_STDERR_AFTER_EXIT/);
});

test('an exit-based implementation would FAIL that ordering — the test has teeth', async () => {
  // Same event order, run against a deliberately WRONG implementation that ends
  // the sink on `exit`. If this ever stops losing the tail, the ordering test
  // above has become vacuous and is no longer guarding anything.
  const file = logPath();
  const sink = fs.createWriteStream(file);
  const child = fakeChild();
  child.stdout.on('data', (chunk) => { if (!sink.writableEnded) sink.write(chunk); });

  const exitBased = new Promise((resolve) => { child.once('exit', () => { sink.end(); resolve(); }); });

  child.stdout.emit('data', Buffer.from('before-exit\n'));
  child.emit('exit', 0, null);
  child.stdout.emit('data', Buffer.from('FINAL_STDOUT_AFTER_EXIT\n'));
  child.emit('close', 0, null);
  await exitBased;
  await new Promise((r) => setTimeout(r, 20));

  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /before-exit/, 'the pre-exit data should survive either way');
  assert.doesNotMatch(text, /FINAL_STDOUT_AFTER_EXIT/,
    'flushing on exit must lose the tail — otherwise the ordering test proves nothing');
});

/* ---------------- failure paths still flush ---------------- */

test('a nonexistent executable rejects AND closes its sink', async () => {
  const file = logPath();
  const sink = fs.createWriteStream(file);
  const child = spawn(path.join(TMP, 'definitely-not-a-real-binary'), [], { stdio: ['ignore', 'pipe', 'pipe'] });
  await assert.rejects(runLoggedChild(child, sink, 'missing binary'));
  assert.equal(sink.closed || sink.destroyed || sink.writableEnded, true, 'the sink was left open');
});

test('a log-stream error REJECTS rather than passing silently', async () => {
  // A sink pointed at a directory cannot be written; the command "succeeded",
  // but the artifact it promised does not exist, so the harness must fail.
  const badPath = path.join(TMP, 'a-directory');
  fs.mkdirSync(badPath, { recursive: true });
  const sink = fs.createWriteStream(badPath);
  const child = spawn(process.execPath, ['-e', "process.stdout.write('hello')"], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => sink.write(d));
  await assert.rejects(runLoggedChild(child, sink, 'unwritable'), /could not be written/);
});

test('a nonzero exit rejects by default and resolves under allowNonZero', async () => {
  const failing = (options) => runSource("process.stdout.write('bye'); process.exit(3);", options);
  await assert.rejects(failing().promise, /exited code=3/);
  const { code } = await failing({ allowNonZero: true }).promise;
  assert.equal(code, 3, 'allowNonZero must surface the code instead of throwing');
});

test('settlement happens exactly once', async () => {
  const file = logPath();
  const sink = fs.createWriteStream(file);
  const child = spawn(process.execPath, ['-e', "process.stdout.write('x'); process.exit(0);"], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => sink.write(d));

  let settlements = 0;
  const promise = runLoggedChild(child, sink, 'once').then(
    () => { settlements += 1; },
    () => { settlements += 1; },
  );
  await promise;
  // Re-emitting both events must not settle again.
  child.emit('close', 0, null);
  child.emit('error', new Error('late error'));
  child.emit('close', 1, null);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(settlements, 1, `settled ${settlements} times`);
});

/* ---------------- forced shutdown ---------------- */

test('graceful shutdown reports { exited:true, graceful:true, forced:false }', async () => {
  const signals = [];
  let resolveExit;
  const exited = new Promise((resolve) => { resolveExit = resolve; });
  const polite = {
    kill(signal) {
      signals.push(signal);
      resolveExit({ code: 0, signal: null });
    },
  };
  const outcome = await stopChild(polite, exited, { graceMs: 5000 });
  assert.deepEqual(outcome, { exited: true, graceful: true, forced: false });
  assert.deepEqual(signals, ['SIGTERM'], 'SIGKILL must never be sent to a cooperative child');
});

test('successful SIGKILL escalation reports { exited:true, graceful:false, forced:true }', async () => {
  // Driven by a stub rather than a real process, so the ESCALATION RULE is
  // tested identically on every platform. Windows has no real signals — a
  // `kill()` there terminates unconditionally — so a real child cannot express
  // "ignored the polite signal" at all. See the platform-gated test below.
  const signals = [];
  let resolveExit;
  const exited = new Promise((resolve) => { resolveExit = resolve; });
  const stubborn = {
    kill(signal) {
      signals.push(signal);
      if (signal === 'SIGKILL') resolveExit({ code: null, signal });
      // anything else: deliberately ignored
    },
  };

  const outcome = await stopChild(stubborn, exited, { graceMs: 300, forceMs: 2000 });
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'], 'must escalate, and only after the grace window');
  assert.deepEqual(outcome, { exited: true, graceful: false, forced: true });
});

test('an UNRESOLVED exit after the force timeout reports exited:false', async () => {
  // The worst case: SIGKILL was attempted and the process was STILL never
  // observed to die — uninterruptible I/O, a zombie, a broken exit promise.
  // `forced:true` means only "SIGKILL was attempted"; `exited:false` is the
  // field that tells the truth here.
  const signals = [];
  const neverExits = new Promise(() => {});
  const immortal = { kill(signal) { signals.push(signal); } };

  const outcome = await stopChild(immortal, neverExits, { graceMs: 200, forceMs: 300 });
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(outcome, { exited: false, graceful: false, forced: true });
});

test('a harness cannot pass on port-release alone while exited:false', async () => {
  // Simulates the trap: the HTTP port stopped answering (listener closed), yet
  // the process itself was never observed to exit. The soak/stress/gate
  // assertion shape is `stop.exited && !stillServing` — both facts required.
  const neverExits = new Promise(() => {});
  const zombie = { kill() {} };
  const stop = await stopChild(zombie, neverExits, { graceMs: 100, forceMs: 100 });

  const stillServing = false; // the port IS released…
  const wouldPass = stop.exited && !stillServing;
  assert.equal(stop.exited, false, '…but exit was never observed');
  assert.equal(wouldPass, false, 'port release alone must not satisfy the shutdown assertion');
});

test('escalation waits out the full grace window before forcing', async () => {
  const at = [];
  const began = Date.now();
  let resolveExit;
  const exited = new Promise((resolve) => { resolveExit = resolve; });
  const child = {
    kill(signal) {
      at.push({ signal, ms: Date.now() - began });
      if (signal === 'SIGKILL') resolveExit(null);
    },
  };
  await stopChild(child, exited, { graceMs: 400, forceMs: 1000 });
  assert.ok(at[1].ms >= 380, `forced after only ${at[1].ms}ms — the grace window was not honoured`);
});

test('a real child that ignores SIGTERM is force-killed', { skip: process.platform === 'win32'
  ? 'Windows has no real signals: kill() terminates unconditionally, so a child cannot ignore SIGTERM'
  : false }, async () => {
  const child = spawn(
    process.execPath,
    ['-e', "process.on('SIGTERM', () => {}); process.on('SIGINT', () => {}); setInterval(() => {}, 1000);"],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const exited = new Promise((resolve) => child.on('exit', resolve));
  await new Promise((r) => setTimeout(r, 300)); // let the handlers install

  const outcome = await stopChild(child, exited, { graceMs: 1200, forceMs: 3000 });
  assert.equal(outcome.graceful, false, 'it should NOT have exited on the polite signal');
  assert.equal(outcome.forced, true);
  assert.equal(outcome.exited, true, 'SIGKILL must have been observed to land');
  await exited;
  assert.equal(child.exitCode === null ? child.signalCode !== null : true, true, 'the child must be gone');
});

test('a well-behaved child exits gracefully and is never force-killed', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], { stdio: 'ignore' });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  await new Promise((r) => setTimeout(r, 200));
  const outcome = await stopChild(child, exited, { graceMs: 8000 });
  assert.deepEqual(outcome, { exited: true, graceful: true, forced: false });
});

test('killed is not evidence of exit — the bounded wait is', { skip: process.platform === 'win32'
  ? 'Windows kill() terminates unconditionally, so killed and exited always agree there'
  : false }, async () => {
  const child = spawn(
    process.execPath,
    ['-e', "process.on('SIGTERM', () => {}); process.on('SIGINT', () => {}); setInterval(() => {}, 1000);"],
    { stdio: 'ignore' },
  );
  const exited = new Promise((resolve) => child.on('exit', resolve));
  await new Promise((r) => setTimeout(r, 300));
  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 400));
  // The signal was delivered, so `killed` is true — while the process runs on.
  // This is precisely why `if (!server.killed)` was the wrong shutdown check.
  assert.equal(child.killed, true, 'killed reflects delivery, not death');
  assert.equal(child.exitCode, null, 'and the process is demonstrably still alive');
  await stopChild(child, exited, { graceMs: 500 });
});

/* ---------------- sink helper ---------------- */

test('closeLogSink surfaces a write failure instead of swallowing it', async () => {
  const dir = path.join(TMP, 'another-directory');
  fs.mkdirSync(dir, { recursive: true });
  await assert.rejects(closeLogSink(fs.createWriteStream(dir), 'bad.log'), /could not be written/);
});

test('closeLogSink resolves for a healthy sink and leaves the bytes on disk', async () => {
  const file = logPath();
  const sink = fs.createWriteStream(file);
  sink.write('kept\n');
  await closeLogSink(sink, 'good.log');
  assert.equal(fs.readFileSync(file, 'utf8'), 'kept\n');
});

test('closeLogSink tolerates a null sink', async () => {
  await closeLogSink(null, 'none');
});
