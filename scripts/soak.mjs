/**
 * Bounded soak test: does CineVerse leak?
 *
 *   npm run test:soak            (needs a production build)
 *   SOAK_ROOMS=12 SOAK_MEMBERS=4 npm run test:soak
 *
 * Not a benchmark and not a load test — it makes no claim about throughput.
 * It asserts CLEANUP: that after a burst of realistic traffic and then silence,
 * the things that grow have come back down. Exact memory thresholds are
 * deliberately avoided (they encode the machine, not the code); what is
 * asserted is gross unbounded growth and broken teardown.
 *
 * Kept out of the fast unit suite because it takes ~a minute and owns a server.
 */

import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { positiveInteger, nonNegativeInteger } from './e2e-stress-lib.mjs';
import { shutdownServer } from './child-process-lib.mjs';

const require = createRequire(import.meta.url);
const { io } = require('socket.io-client');
const { createRateLimiter, buildRuntimePolicy } = require('../server/rate-limit.js');
const { pushMessageBounded, attachmentMaxBytes } = require('../server/chat-limits.js');

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..');
const isWindows = process.platform === 'win32';

// Strictly parsed, and fatal BEFORE a server is spawned. `Number('-1') || 8`
// yields -1, and a soak that exercises -1 rooms would report success having
// tested nothing at all.
let ROOMS;
let MEMBERS;
let ROUNDS;
let SETTLE_MS;
/** Empty-room reap delay for the child server — shortened from the real 15
 *  minutes so the run can actually observe rooms being reclaimed. */
let REAP_MS;
try {
  ROOMS = positiveInteger(process.env.SOAK_ROOMS, 8, 'SOAK_ROOMS');
  MEMBERS = positiveInteger(process.env.SOAK_MEMBERS, 3, 'SOAK_MEMBERS');
  ROUNDS = positiveInteger(process.env.SOAK_ROUNDS, 3, 'SOAK_ROUNDS');
  SETTLE_MS = nonNegativeInteger(process.env.SOAK_SETTLE_MS, 4000, 'SOAK_SETTLE_MS');
  REAP_MS = nonNegativeInteger(process.env.SOAK_REAP_MS, 2000, 'SOAK_REAP_MS');
} catch (err) {
  console.error(`\nInvalid soak configuration: ${err.message}\n`);
  process.exit(1);
}
/** Must match the grace passed to the child server below. A room only starts
 *  its reap timer once the last member's grace has expired. */
const GRACE_MS = 500;

let failures = 0;
const results = [];
function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition) });
  if (!condition) failures += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/* ========================================================================== */
/*  Part 1 — in-process invariants                                            */
/*  The bounded structures, exercised far harder than a network run could.    */
/* ========================================================================== */

function soakInProcess() {
  console.log('\n— bounded structures (in-process) —\n');

  /* ---- the limiter map cannot be grown without bound ---- */
  const policy = buildRuntimePolicy(attachmentMaxBytes({}));
  const limiter = createRateLimiter({ maxKeys: 5000, ttlMs: 60_000 });
  for (let i = 0; i < 50_000; i += 1) {
    limiter.consume({ key: `ip:10.0.${i % 255}.${i % 251}:${i}`, policy: policy.roomJoin, now: i });
  }
  check('a 50k-key flood cannot grow the limiter past its cap', limiter.size() <= 5000, `size=${limiter.size()}`);

  /* ---- a disconnected socket's buckets are released immediately ---- */
  const perSocket = createRateLimiter();
  for (let i = 0; i < 200; i += 1) {
    perSocket.consume({ key: `socket:sock-${i}:chatText`, policy: policy.chatText, now: 0 });
    perSocket.consume({ key: `socket:sock-${i}:roomJoin`, policy: policy.roomJoin, now: 0 });
  }
  const before = perSocket.size();
  let removed = 0;
  for (let i = 0; i < 200; i += 1) removed += perSocket.clearPrefix(`socket:sock-${i}:`);
  check('every disconnected socket releases its buckets', perSocket.size() === 0,
    `${before} -> ${perSocket.size()} (removed ${removed})`);

  /* ---- member/IP buckets survive a reconnect, then expire on their own ---- */
  const surviving = createRateLimiter({ ttlMs: 1000 });
  surviving.consume({ key: 'member:ROOM:m_1:chatText', policy: policy.chatText, now: 0 });
  surviving.consume({ key: 'ip:203.0.113.9:roomJoin', policy: policy.roomJoin, now: 0 });
  surviving.clearPrefix('socket:gone:');
  check('member and IP buckets deliberately survive a disconnect', surviving.size() === 2, `size=${surviving.size()}`);
  surviving.sweep(5000);
  check('…and are reclaimed by the sweep once their TTL passes', surviving.size() === 0, `size=${surviving.size()}`);

  /* ---- room history stays inside its byte budget under attachment pressure ---- */
  const room = { messages: [], messageBytes: 0 };
  const budget = 2 * 1024 * 1024;
  for (let i = 0; i < 400; i += 1) {
    pushMessageBounded(
      room,
      { id: `m${i}`, kind: 'image', author: 'Soak', data: 'x'.repeat(64 * 1024) },
      { maxMessages: 200, maxBytes: budget },
    );
  }
  check('400 large attachments stay inside the history byte budget',
    room.messageBytes <= budget && room.messages.length <= 200,
    `${Math.round(room.messageBytes / 1024)}KiB / ${room.messages.length} messages`);

  const recomputed = room.messages.reduce((sum, m) => sum + (m.__bytes || 0), 0);
  check('byte accounting has not drifted after hundreds of evictions',
    Math.abs(recomputed - room.messageBytes) < 2, `${recomputed} vs ${room.messageBytes}`);
}

/* ========================================================================== */
/*  Part 2 — live traffic                                                     */
/* ========================================================================== */

const connect = (url) =>
  new Promise((resolve, reject) => {
    const socket = io(url, { path: '/api/realtime', transports: ['websocket'] });
    const timer = setTimeout(() => reject(new Error('connect timeout')), 10_000);
    socket.on('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on('connect_error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

const emit = (socket, event, payload) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 8000);
    socket.emit(event, payload, (res) => {
      clearTimeout(timer);
      resolve(res);
    });
  });

async function health(base) {
  const res = await fetch(`${base}/healthz`, { cache: 'no-store' });
  return res.json();
}

async function soakLive(base) {
  console.log('\n— live traffic —\n');

  const baseline = await health(base);
  console.log(`  baseline: rooms=${baseline.rooms} heap=${Math.round((baseline.heapUsed || 0) / 1048576)}MB ` +
    `buckets=${baseline.buckets}`);

  let peak = { rooms: 0, buckets: 0, heapUsed: 0 };
  // Belt and braces: a soak that silently exercised nothing — every join
  // rejected, say — must not be able to report a clean run.
  let liveRooms = 0;
  let liveMembers = 0;
  const sockets = [];

  for (let round = 1; round <= ROUNDS; round += 1) {
    const roundSockets = [];
    for (let r = 0; r < ROOMS; r += 1) {
      const code = `SOAK${String(round)}${String(r).padStart(2, '0')}`.slice(0, 8);
      const members = [];
      for (let m = 0; m < MEMBERS; m += 1) {
        const socket = await connect(base);
        roundSockets.push(socket);
        sockets.push(socket);
        const join = await emit(socket, 'room:join', {
          code,
          name: `Soak${r}-${m}`,
          seatId: `seat-${code}-${m}`,
        });
        members.push({ socket, id: join && join.memberId });
        if (join && join.memberId) liveMembers += 1;
      }
      if (members.some((m) => m.id)) liveRooms += 1;

      const [first, ...rest] = members;
      // A realistic mix: source change, chat, a small attachment, reactions,
      // playback protocol traffic, and an ICE burst between peers.
      await emit(first.socket, 'source:set', { type: 'youtube', value: 'dQw4w9WgXcQ', label: `Soak ${r}` });
      const control = await emit(first.socket, 'sync:control', { action: 'play', time: 0 });
      for (let i = 0; i < 5; i += 1) {
        await emit(first.socket, 'chat:send', { kind: 'text', text: `soak message ${i} in ${code}` });
      }
      await emit(first.socket, 'chat:send', {
        kind: 'image',
        data: `data:image/png;base64,${'A'.repeat(120 * 1024)}`,
        fileName: 'soak.png',
        mimeType: 'image/png',
      });
      rest.forEach((peer) => {
        peer.socket.emit('chat:react', { messageId: 'nope', emoji: '🔥' });
        peer.socket.emit('room:reaction', { emoji: '✨' });
        peer.socket.emit('chat:typing', true);
        for (let i = 0; i < 15; i += 1) {
          peer.socket.emit('rtc:signal', {
            to: first.id,
            data: { type: 'ice', candidate: { candidate: `a=candidate:${i}`, sdpMid: '0' } },
          });
        }
      });
      if (control && control.ok) {
        first.socket.emit('sync:report', {
          time: 5,
          playing: true,
          controlSeq: control.controlSeq,
          sourceVersion: control.sourceVersion,
        });
      }
      await emit(rest[0] ? rest[0].socket : first.socket, 'sync:request', null);
    }

    const during = await health(base);
    peak = {
      rooms: Math.max(peak.rooms, during.rooms),
      buckets: Math.max(peak.buckets, during.buckets || 0),
      heapUsed: Math.max(peak.heapUsed, during.heapUsed || 0),
    };
    console.log(`  round ${round}: rooms=${during.rooms} heap=${Math.round((during.heapUsed || 0) / 1048576)}MB ` +
      `buckets=${during.buckets}`);

    /* ---- reconnect churn: drop half the sockets and let them come back ---- */
    const half = roundSockets.filter((_, i) => i % 2 === 0);
    half.forEach((s) => s.disconnect());
    await sleep(400);
    // Everyone else leaves explicitly, so rooms actually empty out.
    roundSockets.filter((s) => s.connected).forEach((s) => s.disconnect());
    await sleep(SETTLE_MS / ROUNDS);
  }

  check('the soak actually exercised live rooms and members', liveRooms > 0 && liveMembers > 0,
    `rooms=${liveRooms} members=${liveMembers}`);
  check('every room was created and tracked', peak.rooms >= ROOMS, `peak rooms=${peak.rooms}`);

  /* ---- silence, then measure ---- */
  sockets.forEach((s) => {
    try {
      s.disconnect();
    } catch {
      /* already gone */
    }
  });
  // Reaping is TWO chained timers — the reconnect grace, then the empty-room
  // TTL — so a fixed sleep here is the same race that produced two intermittent
  // failures in the realtime suite. Wait for the state, generously bounded, and
  // report how long it actually took.
  const reapDeadline = Date.now() + GRACE_MS + REAP_MS + 20_000;
  const settleBegan = Date.now();
  let after = await health(base);
  while (after.rooms > 0 && Date.now() < reapDeadline) {
    await sleep(250);
    after = await health(base);
  }
  const settleMs = Date.now() - settleBegan;

  console.log(`  settled:  rooms=${after.rooms} heap=${Math.round((after.heapUsed || 0) / 1048576)}MB ` +
    `buckets=${after.buckets}  (after ${settleMs}ms)`);

  // With the shortened reap delay, an empty room really must go away. If this
  // fails, rooms are being retained after everyone left — a slow leak that in
  // production takes hours to become visible.
  check('empty rooms are reaped once their TTL passes', after.rooms === 0,
    `peak=${peak.rooms} settled=${after.rooms} in ${settleMs}ms`);

  check('limiter buckets stay bounded under sustained churn',
    (after.buckets || 0) < 20_000, `buckets=${after.buckets}`);

  // Deliberately generous. This is a leak detector, not a memory budget: a 4x
  // heap growth after everything disconnected is a broken teardown; 30% is
  // ordinary allocator behaviour and must not fail a release.
  const grew = (after.heapUsed || 0) / Math.max(1, baseline.heapUsed || 1);
  check('heap does not grow without bound after activity stops', grew < 4,
    `${grew.toFixed(2)}x baseline (${Math.round((after.heapUsed || 0) / 1048576)}MB)`);

  check('the server is still healthy after the whole run', after.ok === true, JSON.stringify(after));
}

/* ========================================================================== */

async function main() {
  soakInProcess();

  if (!fs.existsSync(path.join(ROOT, '.next', 'BUILD_ID'))) {
    console.error('\nNo production build found (.next/BUILD_ID). Run `npm run build` first.\n');
    process.exit(1);
  }

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  fs.mkdirSync(path.join(ROOT, '.artifacts'), { recursive: true });
  const server = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      HOST: '127.0.0.1',
      // Opt in to the heap/bucket counters this script asserts on.
      EXPOSE_PROCESS_METRICS: '1',
      // The real reap delay is 15 minutes. Shortened here so "empty rooms are
      // eventually reaped" is an assertion rather than an article of faith.
      ROOM_EMPTY_TTL_MS: String(REAP_MS),
      ROOM_RECONNECT_GRACE_MS: String(GRACE_MS),
    },
  });
  // Streamed to disk as it arrives; the in-memory copy is bounded and kept only
  // so a startup failure can be printed inline.
  const serverLog = fs.createWriteStream(path.join(ROOT, '.artifacts', 'soak-server.log'), { flags: 'w' });
  let log = '';
  const capture = (d) => {
    const text = d.toString();
    serverLog.write(text);
    log = `${log}${text}`.slice(-64_000);
  };
  server.stdout.on('data', capture);
  server.stderr.on('data', capture);
  const exited = new Promise((resolve) => server.on('exit', resolve));
  const closed = new Promise((resolve) => server.on('close', resolve));

  try {
    const deadline = Date.now() + 120_000;
    let ready = false;
    while (Date.now() < deadline && !ready) {
      try {
        ready = (await fetch(`${base}/readyz`, { cache: 'no-store' })).status === 200;
      } catch {
        /* not up yet */
      }
      if (!ready) await sleep(300);
    }
    if (!ready) throw new Error(`server never became ready:\n${log}`);

    let uncaught = false;
    server.stderr.on('data', (d) => {
      if (/uncaughtException|unhandledRejection/.test(d.toString())) uncaught = true;
    });

    await soakLive(base);
    check('no uncaught errors were logged during the run', !uncaught);
  } finally {
    // `server.killed` only records that a signal was DELIVERED — it stays true
    // for a process that caught it and kept running, and `forced` only means
    // SIGKILL was attempted. `exited` is the only observed-termination signal.
    const stop = await shutdownServer(server, {
      exited,
      closed,
      sink: serverLog,
      label: 'soak server.log',
      signal: isWindows ? 'SIGINT' : 'SIGTERM',
    });
    if (!stop.graceful) console.log('  server ignored graceful shutdown — forced');
    if (stop.logError) check('the soak server log was preserved', false, stop.logError);
    // A missing `close` means the log may be truncated — a lifecycle failure in
    // its own right, and never something to wait forever for.
    check('the soak server stdio closed so its log is complete', stop.closeObserved,
      stop.closeObserved ? 'closed' : 'no close event within the deadline — the log may be truncated');

    // Exit and port release are SEPARATE facts. A port can stop answering while
    // the process is still alive, so neither alone is proof of a clean shutdown.
    await sleep(300);
    const stillServing = await fetch(`${base}/healthz`, { cache: 'no-store' }).then(() => true, () => false);
    check('the soak server exited and released its port', stop.exited && !stillServing,
      `exited=${stop.exited} graceful=${stop.graceful} forced=${stop.forced} serving=${stillServing}`);
  }

  console.log(`\n${results.length - failures}/${results.length} soak checks passed\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error('soak harness error:', err.message);
  process.exit(1);
});
