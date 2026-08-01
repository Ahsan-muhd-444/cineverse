/**
 * Realtime smoke test.
 * Drives the Socket.IO layer with two simulated clients and asserts the
 * behaviours the room depends on: creation, joining, presence, playback sync,
 * chat, typing, reactions, waiting room, password gate, host controls.
 *
 *   node scripts/e2e-realtime.js  (server must already be running on :3000)
 */

const fs = require('node:fs');
const path = require('node:path');
const { io } = require('socket.io-client');
// The relay's own size cap, so the oversized-signal check can never drift from it.
const { MAX_SIGNAL_BYTES } = require('../server/rtc.js');

const URL = process.env.TEST_URL || 'http://localhost:3000';
const STARTED_AT = new Date();
const START_MS = Date.now();
const results = [];
let failures = 0;
// Which family of behaviour is currently under test. Recorded on every check so
// an intermittent failure can be placed without re-reading the whole log.
let currentSection = 'core room + playback';

/**
 * Values that must never reach a log file or a result artifact.
 *
 * Details are built from real acknowledgements, so they can carry seat tokens,
 * upload capabilities, SDP or candidate bodies. Artifacts are written to disk
 * and attached to bug reports; error codes and counts are what make a failure
 * diagnosable, and none of those are secret.
 */
const SENSITIVE_FIELD = /("?)(token|seatId|password|passphrase|credential|username|sdp|candidate|uploadUrl|fields|data)\1(\s*[:=]\s*)("[^"]*"|\{[^}]*\}|[^,}\s]+)/gi;

function redact(value) {
  return String(value ?? '')
    .replace(SENSITIVE_FIELD, '$1$2$1$3"[redacted]"')
    .replace(/data:[^\s",]*/g, 'data:[redacted]')
    // Long enough for any real detail; short enough that a stray payload cannot
    // be smuggled through in bulk.
    .slice(0, 400);
}

/** Start a new named section. Purely for diagnosis — asserts nothing. */
function section(name) {
  currentSection = name;
}

function check(name, condition, detail = '') {
  const entry = {
    index: results.length + 1,
    name,
    ok: Boolean(condition),
    detail: redact(detail),
    elapsedMs: Date.now() - START_MS,
    section: currentSection,
  };
  results.push(entry);
  if (!entry.ok) failures += 1;
  // Elapsed on EVERY line, not just failures: reconstructing which step was slow
  // is most of the work when an intermittent failure finally reproduces, and the
  // gap between two adjacent checks is the measurement that matters.
  console.log(
    `${entry.ok ? 'PASS' : 'FAIL'}  #${entry.index} [${entry.elapsedMs}ms] ${name}` +
      `${entry.detail ? `  — ${entry.detail}` : ''}`,
  );
}

/**
 * Print every failure again, together, immediately before exiting.
 *
 * A single FAIL line 200 lines up the scrollback is exactly what got lost the
 * last time this suite failed intermittently: the run was known to have failed
 * and nobody could say at what.
 */
function reportFailures() {
  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) return;
  console.log('\nFAILED CHECKS');
  for (const r of failed) {
    console.log(`#${r.index} ${r.name}${r.detail ? ` — ${r.detail}` : ''}  [${r.elapsedMs}ms, section: ${r.section}]`);
  }
}

/**
 * Write the machine-readable result, if asked for.
 *
 * Written for success as well as failure, so a stress run can report frequency
 * rather than only the first failure. The write is atomic — temp file then
 * rename — because a process killed mid-write would otherwise leave a truncated
 * file that still parses as JSON and quietly reports the wrong thing.
 */
function writeResultFile(harnessError) {
  const target = process.env.E2E_RESULT_FILE;
  if (!target) return;
  const finishedAt = new Date();
  const payload = {
    startedAt: STARTED_AT.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - START_MS,
    nodeVersion: process.version,
    platform: process.platform,
    testUrl: URL,
    total: results.length,
    passed: results.length - failures,
    failed: failures,
    failures: results
      .filter((r) => !r.ok)
      .map(({ index, name, detail, elapsedMs, section: s }) => ({ index, name, detail, elapsedMs, section: s })),
  };
  if (harnessError) {
    payload.harnessError = { message: redact(harnessError.message), stack: redact(harnessError.stack) };
  }
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`);
    fs.renameSync(temporary, target);
  } catch (err) {
    console.error(`could not write E2E_RESULT_FILE (${target}): ${err.message}`);
  }
}

/** The single exit path, so no route out of this process skips the diagnostics. */
function finish(harnessError) {
  reportFailures();
  writeResultFile(harnessError);
  process.exit(failures || harnessError ? 1 : 0);
}

const connect = () =>
  new Promise((resolve, reject) => {
    const socket = io(URL, { path: '/api/realtime', transports: ['websocket'] });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 8000);
  });

const emit = (socket, event, payload) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 6000);
    socket.emit(event, payload, (res) => {
      clearTimeout(timer);
      resolve(res);
    });
  });

const waitFor = (socket, event, timeout = 4000) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeout);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      // Some events are fire-and-forget with no body; `true` distinguishes
      // "arrived with no payload" from "timed out".
      resolve(payload ?? true);
    });
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Assert that `event` does NOT arrive at `socket` while (and shortly after)
 * `trigger` runs. Returns true when nothing was received — i.e. the emit was
 * correctly rejected by the server.
 */
const expectNo = async (socket, event, trigger, window = 400) => {
  let received = false;
  const onEvent = () => {
    received = true;
  };
  socket.on(event, onEvent);
  await trigger();
  await sleep(window);
  socket.off(event, onEvent);
  return !received;
};

// Must match the server's ROOM_RECONNECT_GRACE_MS. A dropped socket keeps its
// seat for this long, so anything asserting on a DEPARTURE must wait it out.
const GRACE_MS = Number(process.env.ROOM_RECONNECT_GRACE_MS || 500);

/**
 * Extra ceiling for waits that depend on the server FINALIZING a departure.
 *
 * A departure is grace timer -> finalizeRemoval -> broadcast. Under heavy load
 * (a release gate building, testing and serving at once) that chain has been
 * observed to take multiple seconds beyond the grace window, so this scenario
 * gets real scheduling headroom. It is deliberately NOT the default: slowing
 * every wait in the suite to cover the slowest one hides regressions elsewhere.
 */
const DEPARTURE_TIMEOUT_MS = GRACE_MS + 15_000;

/**
 * Resolve when a `presence` payload satisfies `predicate`.
 *
 * Returns a RESULT OBJECT, never a bare payload:
 *   { matched: true,  payload, elapsedMs }
 *   { matched: false, payload: null, elapsedMs, last }
 *
 * This shape exists because the previous version resolved with the last payload
 * it had seen when the timeout fired. A caller could not distinguish "the state
 * I waited for arrived" from "it never arrived, here is a stale snapshot" — so a
 * timeout was silently evaluated as though it were a real observation, and the
 * assertion then reported a pre-departure member list as if it were the outcome.
 * A timeout is now always visible to the caller.
 */
const presenceMatching = (socket, predicate, timeoutMs = GRACE_MS + 6000) =>
  new Promise((resolve) => {
    const began = Date.now();
    let latest = null;
    const finish = (value) => {
      clearTimeout(timer);
      socket.off('presence', onPresence);
      resolve(value);
    };
    const onPresence = (p) => {
      latest = p;
      if (predicate(p)) finish({ matched: true, payload: p, elapsedMs: Date.now() - began });
    };
    const timer = setTimeout(
      () => finish({ matched: false, payload: null, elapsedMs: Date.now() - began, last: latest }),
      timeoutMs,
    );
    socket.on('presence', onPresence);
  });

/** Human-readable diagnosis of a wait that never saw the state it wanted. */
const describeTimeout = (result, { scenario, expected }) => {
  const last = result.last;
  const members = last && Array.isArray(last.members) ? last.members.map((m) => m.name).join(',') : 'none observed';
  const host = last && last.hostId ? last.hostId : 'none observed';
  const lobby = last && Array.isArray(last.lobby) ? last.lobby.length : 'n/a';
  return (
    `TIMEOUT after ${result.elapsedMs}ms in ${scenario} — expected ${expected}; ` +
    `last presence: hostId=${host} members=[${members}] lobbyCount=${lobby}`
  );
};

/**
 * Resolve when a message satisfying `predicate` arrives, or on timeout.
 * Same reasoning as above, for assertions driven by a system message.
 */
const messageMatching = (socket, predicate, timeoutMs = GRACE_MS + 6000) =>
  new Promise((resolve) => {
    const finish = (value) => {
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve(value);
    };
    const onMessage = (m) => {
      if (predicate(m)) finish(m);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.on('message', onMessage);
  });

async function main() {
  section('1. clock handshake');
  /* ---------- 1. clock handshake ---------- */
  const alice = await connect();
  const pong = await emit(alice, 'clock:ping', Date.now());
  check('clock handshake returns server time', pong && typeof pong.serverTime === 'number');

  section('2. create + join');
  /* ---------- 2. create + join ---------- */
  const created = await emit(alice, 'room:create', { code: 'TEST01' });
  check('room:create returns a code', created && created.ok && created.code, created && created.code);
  const code = created.code;

  const probe = await emit(alice, 'room:probe', { code });
  check('room:probe sees the new room', probe && probe.exists && !probe.hasPassword);

  const joinA = await emit(alice, 'room:join', { code, name: 'Alice' });
  check('first client joins and gets a snapshot', joinA && joinA.ok && joinA.snapshot);
  // Identity is the STABLE member id now — never the socket id.
  const aliceId = joinA.memberId;
  check('first client becomes host', joinA.snapshot.hostId === aliceId);

  const bob = await connect();
  const presencePromise = waitFor(alice, 'presence');
  const joinB = await emit(bob, 'room:join', { code, name: 'Bob' });
  const bobId = joinB.memberId;
  check('second client joins', joinB && joinB.ok && !joinB.pending);

  const presence = await presencePromise;
  check('presence broadcasts both members', presence && presence.members.length === 2,
    presence && presence.members.map((m) => m.name).join(', '));

  section('3. source');
  /* ---------- 3. source ---------- */
  const sourcePromise = waitFor(bob, 'source:set');
  alice.emit('source:set', { type: 'url', value: 'https://example.com/film.mp4', label: 'Test Film' });
  const source = await sourcePromise;
  check('source propagates to the other seat', source && source.label === 'Test Film');
  check('a direct video URL stays a url source', source && source.type === 'url');

  // Server-side defensive normalization: a YouTube link (even mistyped as url)
  // is broadcast as a canonical youtube source keyed by the 11-char video ID.
  const ytPromise = waitFor(bob, 'source:set');
  alice.emit('source:set', { type: 'url', value: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30', label: 'Clip' });
  const yt = await ytPromise;
  check('a YouTube link is normalized to a youtube source', yt && yt.type === 'youtube', yt && yt.type);
  check('the youtube source stores the bare video ID', yt && yt.value === 'dQw4w9WgXcQ', yt && yt.value);

  // Reset back to a neutral URL source so later playback-sync checks are unaffected.
  const resetPromise = waitFor(bob, 'source:set');
  alice.emit('source:set', { type: 'url', value: 'https://example.com/film.mp4', label: 'Test Film' });
  await resetPromise;

  section('4-5. playback sync');
  /* ---------- 4. playback sync ---------- */
  const playPromise = waitFor(bob, 'sync:control');
  alice.emit('sync:control', { action: 'play', time: 42 });
  const play = await playPromise;
  check('play reaches the other seat', play && play.action === 'play' && play.time === 42);
  check('play carries an issue timestamp for latency compensation', play && typeof play.issuedAt === 'number');
  check('play is attributed to the person who pressed it', play && play.by === 'Alice', play && play.by);

  const pausePromise = waitFor(alice, 'sync:control');
  bob.emit('sync:control', { action: 'pause', time: 51.5 });
  const pause = await pausePromise;
  check('pause travels the other direction too', pause && pause.action === 'pause' && pause.time === 51.5);

  const seekPromise = waitFor(bob, 'sync:control');
  alice.emit('sync:control', { action: 'seek', time: 120 });
  const seek = await seekPromise;
  check('seek propagates', seek && seek.action === 'seek' && seek.time === 120);

  /* ---------- 5. server-authoritative playhead ---------- */
  alice.emit('sync:control', { action: 'play', time: 100 });
  await sleep(1200);
  const state = await emit(bob, 'sync:request', null);
  check(
    'server extrapolates the playhead while playing',
    state && state.playing && state.time > 100.9 && state.time < 101.6,
    state && `t=${state.time.toFixed(2)}`,
  );

  alice.emit('sync:control', { action: 'pause', time: 100 });
  await sleep(600);
  const paused = await emit(bob, 'sync:request', null);
  check('server freezes the playhead when paused', paused && !paused.playing && Math.abs(paused.time - 100) < 0.01);

  section('5b. deterministic playback authority');
  /* ---------- 5b. deterministic playback authority ---------- */
  // Alice takes control with a play; the ack carries the accepted epoch.
  const ctlA = await emit(alice, 'sync:control', { action: 'play', time: 10 });
  check('sync:control acks the control epoch',
    ctlA && ctlA.ok && typeof ctlA.controlSeq === 'number' && typeof ctlA.sourceVersion === 'number',
    ctlA && `seq=${ctlA.controlSeq} ver=${ctlA.sourceVersion}`);
  let seq = ctlA.controlSeq;
  const ver = ctlA.sourceVersion;

  // (1) A non-controller (Bob) heartbeat is ignored, even with the right epoch.
  bob.emit('sync:report', { time: 1, playing: true, controlSeq: seq, sourceVersion: ver });
  await sleep(150);
  let s = await emit(bob, 'sync:request', null);
  check('(auth) a non-controller heartbeat is ignored', s && s.time > 9 && s.time < 13, s && `t=${s.time.toFixed(2)}`);

  // (2) The controller's (Alice) heartbeat is accepted.
  alice.emit('sync:report', { time: 15, playing: true, controlSeq: seq, sourceVersion: ver });
  await sleep(150);
  s = await emit(bob, 'sync:request', null);
  check('(auth) the controller heartbeat is accepted', s && s.time >= 14.9 && s.time < 17, s && `t=${s.time.toFixed(2)}`);

  // (3)+(5) An explicit control by Bob makes Bob the controller (seq+1); Alice's
  // report with the old seq is now stale and ignored, Bob's is accepted.
  const ctlB = await emit(bob, 'sync:control', { action: 'seek', time: 50 });
  check('(auth) a new control increments the sequence', ctlB && ctlB.controlSeq === seq + 1,
    ctlB && `${ctlB.controlSeq} vs ${seq}`);
  const seq2 = ctlB.controlSeq;
  alice.emit('sync:report', { time: 200, playing: true, controlSeq: seq, sourceVersion: ver }); // stale seq
  await sleep(150);
  s = await emit(bob, 'sync:request', null);
  check('(auth) a report with a stale controlSeq is ignored', s && Math.abs(s.time - 50) < 3, s && `t=${s.time.toFixed(2)}`);
  bob.emit('sync:report', { time: 55, playing: true, controlSeq: seq2, sourceVersion: ver });
  await sleep(150);
  s = await emit(bob, 'sync:request', null);
  check('(auth) the new controller heartbeat is accepted after handoff', s && s.time >= 54.9 && s.time < 58,
    s && `t=${s.time.toFixed(2)}`);

  // (7) A backward report during playback (buffering/stale) is rejected.
  await sleep(300);
  const beforeBack = await emit(bob, 'sync:request', null);
  bob.emit('sync:report', { time: 2, playing: true, controlSeq: seq2, sourceVersion: ver });
  await sleep(150);
  s = await emit(bob, 'sync:request', null);
  check('(auth) a backward report during playback is rejected', s && s.time > beforeBack.time - 0.5,
    s && `t=${s.time.toFixed(2)} vs ${beforeBack.time.toFixed(2)}`);

  // (4) After a source change the sourceVersion bumps; a report from the old
  // source version is ignored.
  const authSrcPromise = waitFor(bob, 'source:set');
  alice.emit('source:set', { type: 'url', value: 'https://example.com/v2.mp4', label: 'V2' });
  await authSrcPromise;
  const afterSrc = await emit(bob, 'sync:request', null);
  check('(auth) source:set bumps sourceVersion and resets playback',
    afterSrc && afterSrc.sourceVersion === ver + 1 && !afterSrc.playing && Math.abs(afterSrc.time) < 0.1,
    afterSrc && `ver=${afterSrc.sourceVersion} t=${afterSrc.time} playing=${afterSrc.playing}`);
  const ctlNew = await emit(alice, 'sync:control', { action: 'play', time: 3 });
  alice.emit('sync:report', { time: 300, playing: true, controlSeq: ctlNew.controlSeq, sourceVersion: ver }); // old ver
  await sleep(150);
  s = await emit(bob, 'sync:request', null);
  check('(auth) a report with a stale sourceVersion is ignored', s && s.time < 10, s && `t=${s.time.toFixed(2)}`);
  // reset to the shared film so later checks are unaffected
  const authReset = waitFor(bob, 'source:set');
  alice.emit('source:set', { type: 'url', value: 'https://example.com/film.mp4', label: 'Test Film' });
  await authReset;

  // (6) Controller leaves -> deterministic fallback, in an isolated room.
  const fbHost = await connect();
  const fbCode = (await emit(fbHost, 'room:create', { code: 'FBCTL0' })).code;
  const fbHostId = (await emit(fbHost, 'room:join', { code: fbCode, name: 'FbHost' })).memberId;
  const fbGuest = await connect();
  await emit(fbGuest, 'room:join', { code: fbCode, name: 'FbGuest' });
  // Guest takes control, then leaves; control must fall back to the host.
  const fbCtl = await emit(fbGuest, 'sync:control', { action: 'play', time: 20 });
  const leftFb = waitFor(fbHost, 'peer:left');
  fbGuest.disconnect();
  await leftFb;
  await sleep(150);
  // The host (fallback) can now heartbeat with the current epoch and be accepted.
  const fbState = await emit(fbHost, 'sync:request', null);
  check('(auth) controller departure hands control to a deterministic fallback',
    fbState && fbState.controllerId === fbHostId, fbState && `controller=${fbState.controllerId} host=${fbHostId}`);
  fbHost.emit('sync:report', { time: 40, playing: true, controlSeq: fbState.controlSeq, sourceVersion: fbState.sourceVersion });
  await sleep(150);
  const fbAfter = await emit(fbHost, 'sync:request', null);
  check('(auth) the fallback controller heartbeat is accepted', fbAfter && fbAfter.time >= 39.9 && fbAfter.time < 43,
    fbAfter && `t=${fbAfter.time.toFixed(2)}`);
  fbHost.disconnect();

  section('6-7. chat');
  /* ---------- 6. chat ---------- */
  const msgPromise = waitFor(bob, 'message');
  const ack = await emit(alice, 'chat:send', { kind: 'text', text: 'popcorn ready 🍿' });
  check('chat send is acknowledged', ack && ack.ok);
  const msg = await msgPromise;
  check('chat message is delivered', msg && msg.text === 'popcorn ready 🍿' && msg.author === 'Alice');

  const typingPromise = waitFor(alice, 'chat:typing');
  bob.emit('chat:typing', true);
  const typing = await typingPromise;
  check('typing indicator relays', typing && typing.isTyping && typing.name === 'Bob');

  const seenPromise = waitFor(alice, 'chat:seen');
  bob.emit('chat:seen', { messageTs: msg.ts });
  const seen = await seenPromise;
  check('read receipt relays', seen && seen.at === msg.ts);

  const reactPromise = waitFor(alice, 'chat:react');
  bob.emit('chat:react', { messageId: msg.id, emoji: '❤️' });
  const react = await reactPromise;
  check('reaction relays', react && react.emoji === '❤️' && react.messageId === msg.id);

  const flyPromise = waitFor(bob, 'room:reaction');
  alice.emit('room:reaction', { emoji: '🔥' });
  const fly = await flyPromise;
  check('floating reaction relays', fly && fly.emoji === '🔥');

  /* ---------- 7. text sanitising ---------- */
  const longPromise = waitFor(bob, 'message');
  alice.emit('chat:send', { kind: 'text', text: 'x'.repeat(5000) });
  const long = await longPromise;
  check('over-long messages are truncated, not dropped', long && long.text.length === 2000, long && String(long.text.length));

  const spacedPromise = waitFor(bob, 'message');
  alice.emit('chat:send', { kind: 'text', text: 'hello there - friend' });
  const spaced = await spacedPromise;
  check('spaces and hyphens survive sanitising', spaced && spaced.text === 'hello there - friend', spaced && spaced.text);

  section('8. WebRTC signalling');
  /* ---------- 8. WebRTC signalling ---------- */
  const signalPromise = waitFor(bob, 'rtc:signal');
  alice.emit('rtc:signal', { to: bobId, data: { type: 'offer', sdp: { type: 'offer', sdp: 'v=0' } } });
  const signal = await signalPromise;
  check('rtc signalling is relayed to the named peer', signal && signal.from === aliceId && signal.data.type === 'offer');

  const rtcStatePromise = waitFor(alice, 'rtc:state');
  bob.emit('rtc:state', { mic: true, cam: false, screen: false, inCall: true });
  const rtcState = await rtcStatePromise;
  check('media state broadcasts to the room', rtcState && rtcState.media.mic && rtcState.media.inCall);

  section('8b. cinema lights');
  /* ---------- 8b. shared cinema lights ---------- */
  check('room defaults to lights on', joinA.snapshot.settings.lightsMode === 'on',
    joinA.snapshot.settings.lightsMode);

  // Await each broadcast on BOTH sockets so no stale room:settings delivery
  // lingers in either queue and races the later host-controls section.
  const bothSettings = () => Promise.all([waitFor(alice, 'room:settings'), waitFor(bob, 'room:settings')]);

  // Any member (here the non-host Bob) can dim the room for everyone.
  let settingsPair = bothSettings();
  bob.emit('room:lights', { mode: 'off' });
  const [lightsOffA, lightsOffB] = await settingsPair;
  check('a member can turn cinema lights off for everyone',
    lightsOffA && lightsOffA.lightsMode === 'off' && lightsOffB && lightsOffB.lightsMode === 'off',
    lightsOffA && lightsOffA.lightsMode);

  settingsPair = bothSettings();
  bob.emit('room:lights', { mode: 'on' });
  const [lightsOnA] = await settingsPair;
  check('cinema lights can be turned back on', lightsOnA && lightsOnA.lightsMode === 'on');

  // An invalid value is coerced to a safe 'on', never left undefined/garbage.
  settingsPair = bothSettings();
  bob.emit('room:lights', { mode: 'off' });
  await settingsPair;
  settingsPair = bothSettings();
  bob.emit('room:lights', { mode: 'purple' });
  const [invalidLights] = await settingsPair;
  check('an invalid lights mode is coerced to on', invalidLights && invalidLights.lightsMode === 'on',
    invalidLights && invalidLights.lightsMode);

  section('9-10. host controls');
  /* ---------- 9. host controls ---------- */
  alice.emit('room:settings', { locked: true });
  const settings = await waitFor(bob, 'room:settings');
  check('host can lock the room', settings && settings.locked);

  const stranger = await connect();
  const blocked = await emit(stranger, 'room:join', { code, name: 'Stranger' });
  check('locked room refuses newcomers', blocked && !blocked.ok && blocked.error === 'LOCKED', blocked && blocked.error);

  alice.emit('room:settings', { locked: false });
  await sleep(150);

  /* ---------- 10. non-host cannot change settings ---------- */
  bob.emit('room:settings', { locked: true });
  await sleep(250);
  const stillOpen = await emit(stranger, 'room:probe', { code });
  check('non-host settings changes are ignored', stillOpen && !stillOpen.locked);

  section('11. password gate');
  /* ---------- 11. password gate ---------- */
  const secret = await emit(alice, 'room:create', { code: 'SECRET', password: 'moonlight' });
  const secretCode = secret.code;
  const wrong = await emit(stranger, 'room:join', { code: secretCode, name: 'Stranger', password: 'nope' });
  check('wrong passphrase is rejected', wrong && !wrong.ok && wrong.error === 'BAD_PASSWORD');
  const right = await emit(stranger, 'room:join', { code: secretCode, name: 'Stranger', password: 'moonlight' });
  check('correct passphrase is accepted', right && right.ok);

  section('12. waiting room');
  /* ---------- 12. waiting room ---------- */
  const gated = await emit(alice, 'room:create', { code: 'WAIT01', waitingRoom: true });
  const gatedCode = gated.code;
  const host = await connect();
  const hostJoin = await emit(host, 'room:join', { code: gatedCode, name: 'Host' });
  check('first arrival skips the waiting room', hostJoin && hostJoin.ok && !hostJoin.pending);

  const guest = await connect();
  const lobbyPromise = waitFor(host, 'presence');
  const guestJoin = await emit(guest, 'room:join', { code: gatedCode, name: 'Guest' });
  check('later arrivals are held in the lobby', guestJoin && guestJoin.ok && guestJoin.pending);
  const lobby = await lobbyPromise;
  check('host sees who is waiting', lobby && lobby.lobby.length === 1 && lobby.lobby[0].name === 'Guest');

  const approvedPromise = waitFor(guest, 'lobby:approved');
  // lobby:decide still addresses a PENDING guest by socket id — they are not a
  // member yet, so they have no stable member id until they are approved.
  host.emit('lobby:decide', { socketId: guest.id, approve: true });
  const approved = await approvedPromise;
  const guestMemberIdA = approved && approved.memberId;
  check('host can admit a waiting guest', Boolean(approved));
  // Admission is completed on the server: the approval itself carries the snapshot.
  check('admitted guest receives the room snapshot', approved && approved.snapshot);
  check('admitted guest appears in presence', approved && approved.snapshot && approved.snapshot.members.length === 2);

  const legacyEnter = await emit(guest, 'lobby:enter', { name: 'Guest' });
  check('legacy lobby:enter self-admission is rejected', legacyEnter && legacyEnter.ok === false);

  section('13. kick + host handover');
  /* ---------- 13. kick + host handover ---------- */
  const kickedPromise = waitFor(guest, 'room:kicked');
  host.emit('room:kick', { socketId: guestMemberIdA });
  check('host can remove someone', Boolean(await kickedPromise));

  const handoverPromise = waitFor(bob, 'presence');
  alice.emit('room:transfer-host', { socketId: bobId });
  const handover = await handoverPromise;
  check('host seat can be handed over', handover && handover.hostId === bobId);

  section('14. departure');
  /* ---------- 14. departure ---------- */
  const leftPromise = waitFor(bob, 'peer:left');
  alice.disconnect();
  const left = await leftPromise;
  check('leaving is announced to the room', Boolean(left));

  [bob, stranger, host, guest].forEach((s) => s.disconnect());

  section('15. membership authorization');
  /* ======================================================================
     15. membership authorization lifecycle
     ---------------------------------------------------------------------- */
  const pool = [];
  const spawn = async () => {
    const s = await connect();
    pool.push(s);
    return s;
  };

  /* ---- set-up: a gated room with an approved host + member + pending guest ---- */
  const lifeHost = await spawn();
  const lifeCreate = await emit(lifeHost, 'room:create', { code: 'LIFE01', waitingRoom: true });
  const lifeCode = lifeCreate.code;
  const lifeHostJoin = await emit(lifeHost, 'room:join', { code: lifeCode, name: 'LifeHost' });
  check('gated room: first arrival is admitted as host', lifeHostJoin && lifeHostJoin.ok && !lifeHostJoin.pending);

  // A second participant is held in the lobby, then approved.
  const lifeMember = await spawn();
  const lifeMemberJoin = await emit(lifeMember, 'room:join', { code: lifeCode, name: 'LifeMember' });
  check('gated room: second arrival is held pending', lifeMemberJoin && lifeMemberJoin.ok && lifeMemberJoin.pending);
  let memberJoinMsgs = 0;
  const countMemberJoin = (m) => {
    if (m && m.kind === 'system' && /LifeMember joined/.test(m.text || '')) memberJoinMsgs += 1;
  };
  lifeHost.on('message', countMemberJoin);
  const memberApproved = waitFor(lifeMember, 'lobby:approved');
  lifeHost.emit('lobby:decide', { socketId: lifeMember.id, approve: true });
  const lifeMemberApprovedPayload = await memberApproved;
  const lifeMemberId = lifeMemberApprovedPayload && lifeMemberApprovedPayload.memberId;
  await sleep(150);
  lifeHost.off('message', countMemberJoin);
  const afterAdmit = await emit(lifeHost, 'room:probe', { code: lifeCode });
  check('(5) approval creates exactly one membership entry', afterAdmit && afterAdmit.occupants === 2, afterAdmit && `occupants=${afterAdmit.occupants}`);
  check('(5) approval emits exactly one join notification', memberJoinMsgs === 1, `count=${memberJoinMsgs}`);
  const memberEnter = await emit(lifeMember, 'lobby:enter', {});
  check('(lobby:enter) approved member cannot use lobby:enter', memberEnter && memberEnter.ok === false);

  // (6) Replaying the approval for an already-admitted socket changes nothing.
  lifeHost.emit('lobby:decide', { socketId: lifeMember.id, approve: true });
  await sleep(200);
  const afterReplay = await emit(lifeHost, 'room:probe', { code: lifeCode });
  check('(6) approval cannot be replayed', afterReplay && afterReplay.occupants === 2, afterReplay && `occupants=${afterReplay.occupants}`);

  // A pending guest that never gets approved.
  const pending = await spawn();
  const pendingJoin = await emit(pending, 'room:join', { code: lifeCode, name: 'Pending' });
  check('gated room: guest is pending', pendingJoin && pendingJoin.ok && pendingJoin.pending);

  /* ---- (1) pending cannot self-admit ---- */
  const selfAdmit = await emit(pending, 'lobby:enter', { name: 'Pending' });
  check('(1) pending guest cannot self-admit', selfAdmit && selfAdmit.ok === false);

  /* ---- (2) pending cannot send protected room events ---- */
  const pendNoControl = await expectNo(lifeMember, 'sync:control', () => {
    pending.emit('sync:control', { action: 'play', time: 5 });
  });
  check('(2) pending guest sync:control is ignored', pendNoControl);
  const pendChat = await emit(pending, 'chat:send', { kind: 'text', text: 'let me in' });
  check('(2) pending guest chat:send is rejected', pendChat && pendChat.ok === false);
  const pendReq = await emit(pending, 'sync:request', null);
  check('(2) pending guest sync:request returns null', pendReq === null);

  /* ---- (3) pending does not receive primary room broadcasts ---- */
  const pendNoMessage = await expectNo(pending, 'message', () => {
    lifeHost.emit('chat:send', { kind: 'text', text: 'members only' });
  });
  check('(3) pending guest does not receive room chat', pendNoMessage);
  const pendNoSource = await expectNo(pending, 'source:set', () => {
    lifeHost.emit('source:set', { type: 'url', value: 'https://example.com/a.mp4', label: 'Members Film' });
  });
  check('(3) pending guest does not receive source broadcasts', pendNoSource);

  /* ---- (4) denied guest cannot enter afterward ---- */
  const denied = await spawn();
  await emit(denied, 'room:join', { code: lifeCode, name: 'Denied' });
  const denialSeen = waitFor(denied, 'lobby:denied');
  lifeHost.emit('lobby:decide', { socketId: denied.id, approve: false });
  await denialSeen;
  const deniedEnter = await emit(denied, 'lobby:enter', { name: 'Denied' });
  check('(4) denied guest cannot self-admit afterward', deniedEnter && deniedEnter.ok === false);
  const deniedNoControl = await expectNo(lifeMember, 'sync:control', () => {
    denied.emit('sync:control', { action: 'play', time: 9 });
  });
  check('(4) denied guest cannot control playback', deniedNoControl);

  /* ---- (7-11) kick revocation for the current socket session ---- */
  const kickedSeen = waitFor(lifeMember, 'room:kicked');
  lifeHost.emit('room:kick', { socketId: lifeMemberId });
  await kickedSeen;

  const kickNoSource = await expectNo(lifeHost, 'source:set', () => {
    lifeMember.emit('source:set', { type: 'url', value: 'https://example.com/ghost.mp4', label: 'Ghost' });
  });
  check('(7) kicked socket cannot change the source', kickNoSource);

  // Every synchronization action, each proven rejected on its own.
  for (const action of ['play', 'pause', 'seek', 'rate']) {
    // eslint-disable-next-line no-await-in-loop
    const blocked = await expectNo(lifeHost, 'sync:control', () => {
      lifeMember.emit('sync:control', { action, time: 3, rate: 2 });
    });
    check(`(8) kicked socket cannot issue sync:${action}`, blocked);
  }
  const kickReq = await emit(lifeMember, 'sync:request', null);
  check('(8) kicked socket sync:request returns null', kickReq === null);
  lifeMember.emit('sync:report', { time: 9999, playing: true });
  await sleep(150);
  const headAfterKick = await emit(lifeHost, 'sync:request', null);
  check('(8) kicked socket heartbeat is ignored', headAfterKick && Math.abs(headAfterKick.time - 9999) > 1,
    headAfterKick && `t=${headAfterKick.time}`);

  const kickChat = await emit(lifeMember, 'chat:send', { kind: 'text', text: 'still here' });
  check('(9) kicked socket chat is rejected', kickChat && kickChat.ok === false);
  const kickNoReaction = await expectNo(lifeHost, 'room:reaction', () => {
    lifeMember.emit('room:reaction', { emoji: '🔥' });
  });
  check('(9) kicked socket reactions are ignored', kickNoReaction);

  const kickNoRtc = await expectNo(lifeHost, 'rtc:signal', () => {
    lifeMember.emit('rtc:signal', { to: lifeHost.id, data: { type: 'offer' } });
  });
  check('(10) kicked socket cannot send WebRTC signals', kickNoRtc);

  const kickRejoin = await emit(lifeMember, 'room:join', { code: lifeCode, name: 'LifeMember' });
  check('(11) kicked live socket cannot immediately rejoin', kickRejoin && !kickRejoin.ok && kickRejoin.error === 'KICKED',
    kickRejoin && kickRejoin.error);

  /* ---- race: a protected event PROCESSED AFTER a kick is rejected ---- */
  // Deterministic ordering via the kick's ACK rather than the client's
  // room:kicked notification: the callback only fires once the server has
  // finished the kick, so the follow-up control is provably processed after
  // membership was revoked. We assert both no broadcast AND unchanged state.
  const raceHost = await spawn();
  const raceCode = (await emit(raceHost, 'room:create', { code: 'RACE01' })).code;
  await emit(raceHost, 'room:join', { code: raceCode, name: 'RaceHost' });
  const raceMember = await spawn();
  const raceMemberId = (await emit(raceMember, 'room:join', { code: raceCode, name: 'RaceMember' })).memberId;
  raceMember.emit('sync:control', { action: 'pause', time: 10 }); // known baseline
  await sleep(150);
  let raceBroadcast = false;
  const onRaceControl = () => {
    raceBroadcast = true;
  };
  raceHost.on('sync:control', onRaceControl);
  await new Promise((resolve) => {
    raceHost.emit('room:kick', { socketId: raceMemberId }, () => {
      // Server has finished the kick; this control is provably seen afterward.
      raceMember.emit('sync:control', { action: 'play', time: 77 });
      resolve();
    });
  });
  await sleep(300);
  raceHost.off('sync:control', onRaceControl);
  check('(race) control processed after a kick is not broadcast', !raceBroadcast);
  const raceState = await emit(raceHost, 'sync:request', null);
  check('(race) room state is unchanged after the rejected control',
    raceState && !raceState.playing && Math.abs(raceState.time - 10) < 0.2,
    raceState && `t=${raceState.time} playing=${raceState.playing}`);

  /* ---- (13-14) switching rooms removes the socket from the old room ---- */
  const roomA = await spawn();
  const aCreate = await emit(roomA, 'room:create', { code: 'SWAPA0' });
  const aCode = aCreate.code;
  await emit(roomA, 'room:join', { code: aCode, name: 'RoomAHost' });
  const roomB = await spawn();
  const bCreate = await emit(roomB, 'room:create', { code: 'SWAPB0' });
  const bCode = bCreate.code;
  await emit(roomB, 'room:join', { code: bCode, name: 'RoomBHost' });

  const switcher = await spawn();
  const switcherIdA = (await emit(switcher, 'room:join', { code: aCode, name: 'Switcher' })).memberId;
  const aLeftPromise = waitFor(roomA, 'peer:left');
  const aPresencePromise = waitFor(roomA, 'presence');
  await emit(switcher, 'room:join', { code: bCode, name: 'Switcher' });
  const aLeft = await aLeftPromise;
  check('(13) switching rooms leaves the old room', aLeft && aLeft.id === switcherIdA);
  const aPresence = await aPresencePromise;
  check('(14) old room presence drops the switcher',
    aPresence && aPresence.members.every((m) => m.id !== switcherIdA));

  /* ---- (17) repeated cleanup does not double-announce departure ---- */
  let aLeaveAgain = 0;
  const countLeave = (p) => {
    if (p && p.id === switcherIdA) aLeaveAgain += 1;
  };
  roomA.on('peer:left', countLeave);
  switcher.disconnect(); // switcher is now in room B; disconnect must not touch room A
  await sleep(400);
  roomA.off('peer:left', countLeave);
  check('(17) cleanup does not emit a second departure in the old room', aLeaveAgain === 0, `extra=${aLeaveAgain}`);

  /* ---- (15) host succession selects an approved active member ---- */
  const succHost = await spawn();
  const succCreate = await emit(succHost, 'room:create', { code: 'SUCC01' });
  const succCode = succCreate.code;
  const succHostMemberId = (await emit(succHost, 'room:join', { code: succCode, name: 'SuccHost' })).memberId;
  const succMember = await spawn();
  const succMemberId = (await emit(succMember, 'room:join', { code: succCode, name: 'SuccMember' })).memberId;
  // Succession happens only once the reconnect grace expires, so wait for the
  // promotion itself rather than for a fixed span of time.
  // Wait for the COMPLETE postcondition, not the first presence that happens to
  // name the right host: the departed host must be gone AND the approved member
  // present AND reported as host. A partial intermediate payload is not the
  // outcome under test.
  const succPresence = presenceMatching(
    succMember,
    (p) =>
      p &&
      p.hostId === succMemberId &&
      Array.isArray(p.members) &&
      p.members.some((m) => m.id === succMemberId) &&
      !p.members.some((m) => m.id === succHostMemberId),
    DEPARTURE_TIMEOUT_MS,
  );
  succHost.disconnect();
  const succ = await succPresence;
  check('(15) host succession promotes an approved member', succ.matched,
    succ.matched
      ? `host=${succ.payload.hostId} in ${succ.elapsedMs}ms`
      : describeTimeout(succ, { scenario: 'SUCC01 host succession', expected: `hostId=${succMemberId} and the departed host absent` }));

  /* ---- (16) lobby members are never promoted to host ---- */
  const lobHost = await spawn();
  const lobCreate = await emit(lobHost, 'room:create', { code: 'LOBBY1', waitingRoom: true });
  const lobCode = lobCreate.code;
  await emit(lobHost, 'room:join', { code: lobCode, name: 'LobHost' });
  const lobMember = await spawn();
  await emit(lobMember, 'room:join', { code: lobCode, name: 'LobMember' });
  const lobMemberApproved = waitFor(lobMember, 'lobby:approved');
  lobHost.emit('lobby:decide', { socketId: lobMember.id, approve: true });
  const lobApproval = await lobMemberApproved;
  const lobMemberId = lobApproval && lobApproval.memberId;
  const lobGuest = await spawn(); // stays in the lobby
  // A distinctive name, because identity is what this section is really about.
  // `hostId` is a STABLE MEMBER id and `lobGuest.id` is a SOCKET id, so
  // comparing them can never be true — the old assertion looked like a check
  // and was actually a tautology. Promotion of a lobby guest would show up as
  // that guest appearing in `members`, so that is what gets asserted.
  const LOBBY_GUEST_NAME = 'LobGuestNeverAdmit';
  await emit(lobGuest, 'room:join', { code: lobCode, name: LOBBY_GUEST_NAME });

  // Watch EVERY presence across the handover, not just the final one: a guest
  // briefly admitted and then dropped would be invisible in an end-state read.
  const admissionSightings = [];
  const watchLobbyGuest = (p) => {
    if (!p) return;
    const admitted = Array.isArray(p.members) && p.members.some((m) => m.name === LOBBY_GUEST_NAME);
    const missingFromLobby = !Array.isArray(p.lobby) || !p.lobby.some((e) => e.socketId === lobGuest.id);
    if (admitted || missingFromLobby) {
      admissionSightings.push({ admitted, missingFromLobby, hostId: p.hostId });
    }
  };
  lobMember.on('presence', watchLobbyGuest);
  // Full postcondition: departed host absent, approved member present AND host,
  // guest still not a member. Waiting on only `hostId` let a stale pre-departure
  // payload satisfy the follow-up assertions on timeout.
  const lobSuccession = presenceMatching(
    lobMember,
    (p) =>
      p &&
      p.hostId === lobMemberId &&
      Array.isArray(p.members) &&
      p.members.some((m) => m.id === lobMemberId) &&
      !p.members.some((m) => m.name === 'LobHost') &&
      !p.members.some((m) => m.name === LOBBY_GUEST_NAME),
    DEPARTURE_TIMEOUT_MS,
  );
  lobHost.disconnect();
  const lobSucc = await lobSuccession;
  lobMember.off('presence', watchLobbyGuest);
  const lobTimeout = describeTimeout(lobSucc, {
    scenario: 'LOBBY1 host succession',
    expected: `hostId=${lobMemberId}, LobHost departed, guest still pending`,
  });
  const lobPayload = lobSucc.matched ? lobSucc.payload : null;

  check('(16) host succession promotes the approved member, not the waiting guest',
    lobSucc.matched,
    lobSucc.matched ? `host=${lobPayload.hostId} in ${lobSucc.elapsedMs}ms` : lobTimeout);
  check('(16b) the waiting guest is still in the lobby after the handover',
    Boolean(lobPayload) && Array.isArray(lobPayload.lobby) && lobPayload.lobby.some((e) => e.socketId === lobGuest.id),
    lobPayload && Array.isArray(lobPayload.lobby) ? `lobby=${lobPayload.lobby.length}` : lobTimeout);
  check('(16c) the waiting guest never became a member',
    Boolean(lobPayload) && Array.isArray(lobPayload.members) && lobPayload.members.every((m) => m.name !== LOBBY_GUEST_NAME),
    lobPayload && Array.isArray(lobPayload.members)
      ? `members=${lobPayload.members.map((m) => m.name).join(',')}`
      : lobTimeout);
  check('(16d) the guest was never admitted at ANY point during the handover',
    admissionSightings.length === 0, `sightings=${JSON.stringify(admissionSightings)}`);

  /* ---- (18) same-room join is idempotent ---- */
  const idemHost = await spawn();
  const idemCreate = await emit(idemHost, 'room:create', { code: 'IDEM01' });
  const idemCode = idemCreate.code;
  await emit(idemHost, 'room:join', { code: idemCode, name: 'IdemHost' });
  let dupJoins = 0;
  const countJoin = (m) => {
    if (m && m.kind === 'system' && /joined the room/.test(m.text || '')) dupJoins += 1;
  };
  idemHost.on('message', countJoin);
  const rejoin = await emit(idemHost, 'room:join', { code: idemCode, name: 'IdemHost' });
  await sleep(250);
  idemHost.off('message', countJoin);
  check('(18) re-joining the same room returns a snapshot', rejoin && rejoin.ok && rejoin.snapshot);
  check('(18) re-joining the same room emits no duplicate join', dupJoins === 0, `dupes=${dupJoins}`);

  /* ---- (12) a normal approved member still has every feature ---- */
  const feature = await spawn();
  await emit(feature, 'room:join', { code: idemCode, name: 'Feature' });
  const featSource = waitFor(feature, 'source:set');
  idemHost.emit('source:set', { type: 'url', value: 'https://example.com/feature.mp4', label: 'Feature Film' });
  const featSourceGot = await featSource;
  check('(12) approved member receives source', featSourceGot && featSourceGot.label === 'Feature Film');
  const featPlay = waitFor(feature, 'sync:control');
  idemHost.emit('sync:control', { action: 'play', time: 12 });
  const featPlayGot = await featPlay;
  check('(12) approved member receives playback control', featPlayGot && featPlayGot.action === 'play');
  const featChat = await emit(idemHost, 'chat:send', { kind: 'text', text: 'hi feature' });
  check('(12) approved member chat is accepted', featChat && featChat.ok);
  const featReq = await emit(feature, 'sync:request', null);
  check('(12) approved member sync:request returns state', featReq && typeof featReq.time === 'number');

  /* ---- (19) password + lock behaviour is unchanged ---- */
  const pwCreate = await emit(idemHost, 'room:create', { code: 'PWLOCK', password: 'sesame' });
  const pwCode = pwCreate.code;
  const pwOwner = await spawn();
  const pwWrong = await emit(pwOwner, 'room:join', { code: pwCode, name: 'Owner', password: 'nope' });
  check('(19) wrong passphrase still rejected', pwWrong && !pwWrong.ok && pwWrong.error === 'BAD_PASSWORD');
  const pwRight = await emit(pwOwner, 'room:join', { code: pwCode, name: 'Owner', password: 'sesame' });
  check('(19) correct passphrase still accepted', pwRight && pwRight.ok);
  pwOwner.emit('room:settings', { locked: true });
  await sleep(150);
  const lockNewcomer = await spawn();
  const lockedOut = await emit(lockNewcomer, 'room:join', { code: pwCode, name: 'Late' });
  check('(19) locked room still refuses newcomers', lockedOut && !lockedOut.ok && lockedOut.error === 'LOCKED');

  /* ---- (20) clock + probe work before admission ---- */
  const preAdmit = await spawn();
  const preClock = await emit(preAdmit, 'clock:ping', Date.now());
  check('(20) clock calibration works before admission', preClock && typeof preClock.serverTime === 'number');
  const preProbe = await emit(preAdmit, 'room:probe', { code: idemCode });
  check('(20) room probe works before admission', preProbe && preProbe.ok && preProbe.exists === true);

  section('16. orphaned waiting-room lifecycle');
  /* ======================================================================
     16. orphaned waiting-room lifecycle (review finding 1)
     ---------------------------------------------------------------------- */
  const orphanHost = await spawn();
  const orphanCode = (await emit(orphanHost, 'room:create', { code: 'ORPH01', waitingRoom: true })).code;
  await emit(orphanHost, 'room:join', { code: orphanCode, name: 'OrphanHost' });
  orphanHost.emit('source:set', { type: 'url', value: 'https://example.com/orphan.mp4', label: 'Orphan Film' });
  const orphanGuest = await spawn();
  const orphanPend = await emit(orphanGuest, 'room:join', { code: orphanCode, name: 'OrphanGuest' });
  check('(orphan) guest is held pending', orphanPend && orphanPend.ok && orphanPend.pending);

  // The close is driven by the reconnect-grace TIMER, not by the disconnect, so
  // it must not be held to `waitFor`'s generic default — that deadline is meant
  // for immediate broadcasts and leaves no room for a slow scheduler. Measured
  // latency on an idle server is ~505ms; this allows an order of magnitude more.
  const orphanClosed = waitFor(orphanGuest, 'room:closed', GRACE_MS + 6000);
  orphanHost.disconnect(); // the final approved member leaves
  const orphanClosedGot = await orphanClosed;
  check('(orphan) pending guest is told the room closed', Boolean(orphanClosedGot),
    orphanClosedGot ? 'closed' : 'no room:closed within the grace window');
  const orphanProbe = await emit(orphanGuest, 'room:probe', { code: orphanCode });
  // Detail spells out what the server actually said: an empty detail here cost
  // real time diagnosing a previous failure.
  check('(orphan) the orphaned room is deleted', orphanProbe && orphanProbe.exists === false,
    orphanProbe ? `exists=${orphanProbe.exists} occupants=${orphanProbe.occupants ?? 0}` : 'probe returned null');
  const orphanReq = await emit(orphanGuest, 'sync:request', null);
  check('(orphan) evicted guest has no room authority', orphanReq === null);
  const orphanEnter = await emit(orphanGuest, 'lobby:enter', {});
  check('(orphan) evicted guest cannot self-admit', orphanEnter && orphanEnter.ok === false);

  // Guest visits another room, then re-uses the old code: it must be a brand-new
  // empty session, never the old one reclaimed through the stale lobby lifecycle.
  const elsewhere = await spawn();
  const elseCode = (await emit(elsewhere, 'room:create', { code: 'ELSE01' })).code;
  await emit(elsewhere, 'room:join', { code: elseCode, name: 'Elsewhere' });
  await emit(orphanGuest, 'room:join', { code: elseCode, name: 'OrphanGuest' });
  const reclaim = await emit(orphanGuest, 'room:join', { code: orphanCode, name: 'OrphanGuest' });
  check('(orphan) re-using the code yields a fresh session, not the old one',
    reclaim && reclaim.ok && reclaim.snapshot && reclaim.snapshot.members.length === 1 && !reclaim.snapshot.source,
    // Every outcome is describable, including "no snapshot at all" — which is
    // what a stale room looks like, because the guest lands back in its lobby.
    reclaim
      ? (reclaim.snapshot
        ? `members=${reclaim.snapshot.members.length} source=${Boolean(reclaim.snapshot.source)}`
        : `no snapshot (pending=${Boolean(reclaim.pending)} error=${reclaim.error || 'none'})`)
      : 'join returned null');

  section('17. explicit leave / room switching');
  /* ======================================================================
     17. explicit leave / room-switch safety (review finding 2)
     ---------------------------------------------------------------------- */
  const leaveHost = await spawn();
  const leaveCode = (await emit(leaveHost, 'room:create', { code: 'LEAVE1' })).code;
  await emit(leaveHost, 'room:join', { code: leaveCode, name: 'LeaveHost' });
  const leaver = await spawn();
  const leaverId = (await emit(leaver, 'room:join', { code: leaveCode, name: 'Leaver' })).memberId;

  const leaveGone = waitFor(leaveHost, 'peer:left');
  const leavePresence = waitFor(leaveHost, 'presence');
  leaver.emit('room:leave', { code: leaveCode });
  const leftPeer = await leaveGone;
  check('(leave) explicit leave emits peer:left', leftPeer && leftPeer.id === leaverId);
  const leavePres = await leavePresence;
  check('(leave) explicit leave drops the member from presence',
    leavePres && leavePres.members.every((m) => m.id !== leaverId));
  const leaverReq = await emit(leaver, 'sync:request', null);
  check('(leave) after leaving, the socket has no room authority', leaverReq === null);

  // A subsequent FAILED join restores authority nowhere.
  const lockHost = await spawn();
  const lockCode = (await emit(lockHost, 'room:create', { code: 'LOCKD1' })).code;
  await emit(lockHost, 'room:join', { code: lockCode, name: 'LockHost' });
  lockHost.emit('room:settings', { locked: true });
  await sleep(150);
  const failedJoin = await emit(leaver, 'room:join', { code: lockCode, name: 'Leaver' });
  check('(leave) a failed join after leaving is rejected', failedJoin && !failedJoin.ok && failedJoin.error === 'LOCKED');
  const leaverReq2 = await emit(leaver, 'sync:request', null);
  check('(leave) a failed join leaves no authority in any room', leaverReq2 === null);

  // Disconnect after an explicit leave must not double-announce the departure.
  let dupLeave = 0;
  const countDupLeave = (p) => {
    if (p && p.id === leaverId) dupLeave += 1;
  };
  leaveHost.on('peer:left', countDupLeave);
  leaver.disconnect();
  await sleep(400);
  leaveHost.off('peer:left', countDupLeave);
  check('(leave) disconnect after leave emits no duplicate departure', dupLeave === 0, `extra=${dupLeave}`);

  // A successful switch A -> B still works and leaves A cleanly.
  const swHost = await spawn();
  const swACode = (await emit(swHost, 'room:create', { code: 'SWTCHA' })).code;
  await emit(swHost, 'room:join', { code: swACode, name: 'SwHost' });
  const swBHost = await spawn();
  const swBCode = (await emit(swBHost, 'room:create', { code: 'SWTCHB' })).code;
  await emit(swBHost, 'room:join', { code: swBCode, name: 'SwBHost' });
  const swMover = await spawn();
  const swMoverIdA = (await emit(swMover, 'room:join', { code: swACode, name: 'SwMover' })).memberId;
  const swALeft = waitFor(swHost, 'peer:left');
  const swBjoin = await emit(swMover, 'room:join', { code: swBCode, name: 'SwMover' });
  check('(leave) a successful switch admits into the destination', swBjoin && swBjoin.ok && swBjoin.snapshot);
  const swLeft = await swALeft;
  check('(leave) a successful switch leaves the source room', swLeft && swLeft.id === swMoverIdA);
  const swAProbe = await emit(swHost, 'room:probe', { code: swACode });
  check('(leave) the source room keeps its host after a switch', swAProbe && swAProbe.occupants === 1);

  /* ---- test another room's gate without losing the current seat ---- */
  const stayHost = await spawn();
  const stayCode = (await emit(stayHost, 'room:create', { code: 'STAY01' })).code;
  await emit(stayHost, 'room:join', { code: stayCode, name: 'StayHost' });
  const stayer = await spawn();
  await emit(stayer, 'room:join', { code: stayCode, name: 'Stayer' });
  const gateHost = await spawn();
  const gateCode = (await emit(gateHost, 'room:create', { code: 'GATE01', password: 'open' })).code;
  await emit(gateHost, 'room:join', { code: gateCode, name: 'GateHost' });
  const wrongTry = await emit(stayer, 'room:join', { code: gateCode, name: 'Stayer', password: 'wrong' });
  check('(stay) a wrong passphrase for another room is rejected', wrongTry && !wrongTry.ok && wrongTry.error === 'BAD_PASSWORD');
  const stayerStill = await emit(stayer, 'sync:request', null);
  check('(stay) a rejected join keeps the socket in its current room', stayerStill && typeof stayerStill.time === 'number');
  const stayChat = await emit(stayer, 'chat:send', { kind: 'text', text: 'still seated' });
  check('(stay) the socket can still act in its current room after a rejected join', stayChat && stayChat.ok);

  section('18. shared upload pipeline');
  /* ======================================================================
     18. shared upload pipeline for local files
     ---------------------------------------------------------------------- */
  const upHost = await spawn();
  const upCode = (await emit(upHost, 'room:create', { code: 'UPLD01' })).code;
  const upHostJoin = await emit(upHost, 'room:join', { code: upCode, name: 'UpHost' });

  /* ---- deployment upload availability ----
     A production build with no object storage disables hosted uploads entirely
     (getUploadAvailability); the dev filesystem adapter is never used for real
     user videos. The verdict rides in every snapshot. Below, the pipeline
     mechanics assert the ENABLED behaviour where uploads are on, and the
     UPLOADS_DISABLED refusal where they are off — so this suite is correct against
     BOTH a demo deploy (as the release gate runs it) and a storage-backed one. */
  const availability = upHostJoin && upHostJoin.snapshot ? upHostJoin.snapshot.uploadAvailability : null;
  const uploadsEnabled = !(availability && availability.enabled === false);
  check('(upload) the room snapshot reports upload availability',
    availability && typeof availability.enabled === 'boolean' && typeof availability.mode === 'string',
    JSON.stringify(availability));
  console.log(`INFO  (upload) hosted uploads are ${uploadsEnabled ? 'ENABLED' : 'DISABLED'} on this deployment (mode ${availability ? availability.mode : '?'})`);

  const upGuest = await spawn();
  await emit(upGuest, 'room:join', { code: upCode, name: 'UpGuest' });

  /* ---- authorization ---- */
  const strayUploader = await spawn(); // connected, but in no room at all
  const strayIntent = await emit(strayUploader, 'upload:intent', {
    fileName: 'a.mp4',
    mimeType: 'video/mp4',
    size: 1024,
  });
  check('(upload) intent rejects a socket that is in no room',
    strayIntent && strayIntent.ok === false && strayIntent.error === 'UNAUTHORIZED',
    strayIntent && strayIntent.error);

  // A pending lobby guest is authenticated but NOT a member.
  const upGateHost = await spawn();
  const upGateCode = (await emit(upGateHost, 'room:create', { code: 'UPGATE', waitingRoom: true })).code;
  await emit(upGateHost, 'room:join', { code: upGateCode, name: 'UpGateHost' });
  const upPending = await spawn();
  await emit(upPending, 'room:join', { code: upGateCode, name: 'UpPending' });
  const pendingIntent = await emit(upPending, 'upload:intent', {
    fileName: 'a.mp4',
    mimeType: 'video/mp4',
    size: 1024,
  });
  check('(upload) intent rejects a pending non-member',
    pendingIntent && pendingIntent.ok === false && pendingIntent.error === 'UNAUTHORIZED',
    pendingIntent && pendingIntent.error);

  /* ---- validation ---- */
  const badType = await emit(upHost, 'upload:intent', {
    fileName: 'virus.exe',
    mimeType: 'application/x-msdownload',
    size: 1024,
  });
  check('(upload) intent rejects a disallowed MIME type',
    badType && badType.ok === false && badType.error === (uploadsEnabled ? 'UNSUPPORTED_TYPE' : 'UPLOADS_DISABLED'),
    badType && badType.error);

  const tooBig = await emit(upHost, 'upload:intent', {
    fileName: 'huge.mp4',
    mimeType: 'video/mp4',
    size: 50 * 1024 * 1024 * 1024, // 50GB
  });
  check('(upload) intent rejects an oversized file',
    tooBig && tooBig.ok === false && tooBig.error === (uploadsEnabled ? 'TOO_LARGE' : 'UPLOADS_DISABLED'),
    tooBig && tooBig.error);

  /* ---- the happy path ---- */
  const body = Buffer.alloc(4096, 7);
  const intent = await emit(upHost, 'upload:intent', {
    fileName: '../../etc/My Movie.mp4',
    mimeType: 'video/mp4',
    size: body.length,
  });
  check(`(upload) intent ${uploadsEnabled ? 'accepts an approved member' : 'is refused with UPLOADS_DISABLED (demo deploy)'}`,
    uploadsEnabled
      ? (intent && intent.ok === true && Boolean(intent.token) && Boolean(intent.uploadUrl))
      : (intent && intent.ok === false && intent.error === 'UPLOADS_DISABLED'),
    intent && (intent.error || 'ok'));
  if (uploadsEnabled) {
    check('(upload) the server generates a room-scoped key, ignoring the client path',
      intent && intent.key && intent.key.startsWith(`rooms/${upCode}/`) && !intent.key.includes('..'),
      intent && intent.key);
  }

  if (intent && intent.ok && !intent.direct) {
    // Dev filesystem adapter: bytes go through our own endpoint.
    const putUrl = new global.URL(intent.uploadUrl, URL).toString();

    const badTokenPut = await fetch(
      new global.URL('/api/uploads/put?token=forged.signature', URL).toString(),
      { method: 'PUT', body },
    );
    check('(upload) the byte endpoint rejects a forged token', badTokenPut.status === 401, `status=${badTokenPut.status}`);

    const put = await fetch(putUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'video/mp4' },
      body,
    });
    check('(upload) the byte endpoint accepts a valid token', put.ok, `status=${put.status}`);

    const complete = await emit(upHost, 'upload:complete', { token: intent.token, label: 'My Movie.mp4' });
    check('(upload) complete returns a playable url source',
      complete && complete.ok && complete.source && complete.source.type === 'url',
      complete && (complete.error || complete.source.type));
    check('(upload) the uploaded source is tagged as an upload',
      complete && complete.source && complete.source.quality === 'Uploaded',
      complete && complete.source && complete.source.quality);

    /* ---- the uploaded URL actually streams, including ranges ---- */
    const readUrl = new global.URL(complete.source.value, URL).toString();
    const get = await fetch(readUrl);
    const bytes = Buffer.from(await get.arrayBuffer());
    check('(upload) the uploaded video streams back', get.ok && bytes.length === body.length,
      `status=${get.status} len=${bytes.length}`);
    check('(upload) the stream advertises range support', get.headers.get('accept-ranges') === 'bytes',
      get.headers.get('accept-ranges'));

    // Range support is what makes seeking work in a <video> element.
    const ranged = await fetch(readUrl, { headers: { Range: 'bytes=100-199' } });
    const rangedBytes = Buffer.from(await ranged.arrayBuffer());
    check('(upload) a range request returns exactly that slice',
      ranged.status === 206 && rangedBytes.length === 100,
      `status=${ranged.status} len=${rangedBytes.length}`);
    check('(upload) the range response reports the full size',
      ranged.headers.get('content-range') === `bytes 100-199/${body.length}`,
      ranged.headers.get('content-range'));

    /* ---- a token minted for another room cannot be attached here ---- */
    const otherIntent = await emit(upGateHost, 'upload:intent', {
      fileName: 'other.mp4',
      mimeType: 'video/mp4',
      size: body.length,
    });
    const crossRoom = await emit(upHost, 'upload:complete', { token: otherIntent.token, label: 'other.mp4' });
    check('(upload) a token from another room is rejected',
      crossRoom && crossRoom.ok === false && crossRoom.error === 'WRONG_ROOM', crossRoom && crossRoom.error);

    /* ---- completing without uploading anything is rejected ---- */
    const ghostIntent = await emit(upHost, 'upload:intent', {
      fileName: 'ghost.mp4',
      mimeType: 'video/mp4',
      size: 1024,
    });
    const ghost = await emit(upHost, 'upload:complete', { token: ghostIntent.token, label: 'ghost.mp4' });
    check('(upload) complete is rejected when no object was stored',
      ghost && ghost.ok === false && ghost.error === 'NOT_UPLOADED', ghost && ghost.error);

    /* ---- the uploaded source flows through normal room sync ---- */
    const uploadedSourcePromise = waitFor(upGuest, 'source:set');
    upHost.emit('source:set', complete.source);
    const uploadedSource = await uploadedSourcePromise;
    check('(upload) the uploaded source reaches the other seat',
      uploadedSource && uploadedSource.type === 'url' && uploadedSource.value === complete.source.value,
      uploadedSource && uploadedSource.type);
    check('(upload) the uploaded source keeps its Uploaded tag through source:set',
      uploadedSource && uploadedSource.quality === 'Uploaded', uploadedSource && uploadedSource.quality);

    const uploadedPlay = waitFor(upGuest, 'sync:control');
    upHost.emit('sync:control', { action: 'play', time: 8 });
    const uploadedPlayGot = await uploadedPlay;
    check('(upload) playback sync still works on an uploaded source',
      uploadedPlayGot && uploadedPlayGot.action === 'play' && uploadedPlayGot.time === 8);
  } else {
    console.log(uploadsEnabled
      ? 'SKIP  (upload) byte-level checks — object storage is configured (direct upload)'
      : 'SKIP  (upload) byte-level + happy-path checks — hosted uploads are disabled on this deployment (covered by the browser suites + unit tests)');
  }

  const badKeyGet = await fetch(new global.URL('/api/uploads/file/../../server.js', URL).toString());
  check('(upload) the read endpoint refuses a traversal key', badKeyGet.status === 404, `status=${badKeyGet.status}`);

  /* ---- a GET carrying a body is refused before anything is opened ---- */
  {
    const bodied = await fetch(new global.URL(`/api/uploads/file/${'rooms/ABC123/0123456789abcdef/x.mp4'}`, URL).toString(), {
      method: 'POST',
    });
    check('(upload) the read endpoint refuses a non-GET method',
      bodied.status === 405, `status=${bodied.status}`);
  }

  section('18b. multipart socket contract');
  /* ======================================================================
     18b. the resumable multipart contract, over real Socket.IO

     SCOPE, stated honestly: this deployment has no object storage, so
     `multipartEnabled` is false and no multipart SESSION can be created here.
     What IS reachable — and what these checks cover — is the whole
     authorization and validation surface of every event, plus room progress
     end to end with a real token.

     The multipart byte flow (initiate -> targets -> parts -> status -> resume
     -> complete) is covered against the real extracted services in
     scripts/uploads-mock-flow.test.mjs, because the part bytes have to reach a
     provider and there is no bucket in this harness. Proving it over real HTTP
     needs staging credentials.
     ---------------------------------------------------------------------- */
  const mpHost = await spawn();
  const mpCode = (await emit(mpHost, 'room:create', { code: 'MPT001' })).code;
  await emit(mpHost, 'room:join', { code: mpCode, name: 'MP Host' });
  const mpGuest = await spawn();
  await emit(mpGuest, 'room:join', { code: mpCode, name: 'MP Guest' });
  const mpStranger = await spawn();

  const MULTIPART_EVENTS = [
    ['upload:part-targets', { token: 'x', partNumbers: [1] }],
    ['upload:status', { token: 'x' }],
    ['upload:renew', { token: 'x' }],
    ['upload:abort', { token: 'x' }],
    ['upload:room-progress', { mode: 'multipart', token: 'x', label: 'a', uploadedBytes: 0, totalBytes: 1, status: 'uploading' }],
  ];

  /* ---- every event exists AND is membership-gated ---- */
  for (const [event, payload] of MULTIPART_EVENTS) {
    // eslint-disable-next-line no-await-in-loop
    const ack = await emit(mpStranger, event, payload);
    check(`(multipart) ${event} refuses a socket that is in no room`,
      ack && ack.ok === false && ack.error === 'UNAUTHORIZED',
      ack ? JSON.stringify(ack) : 'no ack — the handler is missing');
  }

  /* ---- and every event answers a member with a REASON, never silence ---- */
  for (const [event, payload] of MULTIPART_EVENTS) {
    // eslint-disable-next-line no-await-in-loop
    const ack = await emit(mpHost, event, payload);
    check(`(multipart) ${event} rejects an unverifiable token with a code`,
      ack && ack.ok === false && typeof ack.error === 'string' && ack.error.length > 0,
      ack ? JSON.stringify(ack) : 'no ack');
  }

  /* ---- part-target batches are bounded even before a session exists ---- */
  const hugeBatch = await emit(mpHost, 'upload:part-targets', {
    token: 'x',
    partNumbers: Array.from({ length: 500 }, (_, i) => i + 1),
  });
  check('(multipart) a 500-part target request is refused',
    hugeBatch && hugeBatch.ok === false, hugeBatch ? JSON.stringify(hugeBatch) : 'no ack');

  /* ---- completion mode is dispatched explicitly, not inferred ---- */
  const mpComplete = await emit(mpHost, 'upload:complete', {
    mode: 'multipart',
    token: 'not-a-real-token',
    label: 'x.mp4',
    parts: [{ partNumber: 1, etag: '"a"' }],
  });
  check('(multipart) a multipart completion with a bad token is refused',
    mpComplete && mpComplete.ok === false && mpComplete.error === 'BAD_TOKEN',
    mpComplete ? JSON.stringify(mpComplete) : 'no ack');

  /* ---- a file above the single-shot ceiling with no bucket is refused ----
     This deployment has no object storage, so there is no multipart CAPACITY
     either: the honest answer is TOO_LARGE, not MULTIPART_REQUIRED. */
  const overCeiling = await emit(mpHost, 'upload:intent', {
    fileName: 'huge.mp4',
    mimeType: 'video/mp4',
    size: 900 * 1024 * 1024,
  });
  check('(multipart) a file above the single-shot ceiling is refused with a reason',
    overCeiling && overCeiling.ok === false &&
      (uploadsEnabled
        ? (overCeiling.error === 'TOO_LARGE' || overCeiling.error === 'MULTIPART_REQUIRED')
        : overCeiling.error === 'UPLOADS_DISABLED'),
    overCeiling ? JSON.stringify(overCeiling) : 'no ack');
  if (uploadsEnabled) {
    // The disabled refusal is a bare {ok:false,error} with no limits to report.
    check('(multipart) the refusal reports the limits the client should show',
      overCeiling && typeof overCeiling.maxBytes === 'number' &&
        typeof overCeiling.singleShotMaxBytes === 'number',
      overCeiling ? JSON.stringify(overCeiling) : 'no ack');
  }

  /* ---- room progress: server-computed, size-pinned, broadcast, cleared ---- */
  const progressIntent = await emit(mpHost, 'upload:intent', {
    fileName: 'progress.mp4',
    mimeType: 'video/mp4',
    size: 4096,
  });
  check(`(multipart) a single-shot intent ${uploadsEnabled ? 'still succeeds alongside the new events' : 'is refused with UPLOADS_DISABLED (demo deploy)'}`,
    uploadsEnabled
      ? (progressIntent && progressIntent.ok === true && progressIntent.mode === 'single')
      : (progressIntent && progressIntent.ok === false && progressIntent.error === 'UPLOADS_DISABLED'),
    progressIntent ? JSON.stringify(progressIntent.error || progressIntent.mode) : 'no ack');

  if (!uploadsEnabled) {
    console.log('SKIP  (multipart) room-progress broadcast checks — uploads disabled (the two-member browser scenario covers partner progress)');
  }

  if (progressIntent && progressIntent.ok) {
    const progressSeen = waitFor(mpGuest, 'upload:progress');
    const reported = await emit(mpHost, 'upload:room-progress', {
      mode: 'single',
      token: progressIntent.token,
      label: '  progress.mp4  ',
      uploadedBytes: 1024,
      totalBytes: 4096,
      status: 'uploading',
    });
    check('(multipart) a valid progress report is accepted',
      reported && reported.ok === true, reported ? JSON.stringify(reported) : 'no ack');

    const broadcast = await progressSeen;
    check('(multipart) the partner receives the progress',
      broadcast && broadcast.memberId && broadcast.percentage === 25,
      broadcast ? JSON.stringify(broadcast) : 'no broadcast');
    check('(multipart) the percentage is computed by the SERVER',
      broadcast && broadcast.percentage === 25 && broadcast.uploadedBytes === 1024,
      broadcast ? `${broadcast.percentage}%` : 'no broadcast');
    check('(multipart) the label is sanitised before broadcast',
      broadcast && broadcast.label === 'progress.mp4', broadcast && JSON.stringify(broadcast.label));
    check('(multipart) the broadcast carries the uploader name, not their token',
      broadcast && broadcast.memberName === 'MP Host' && !('token' in broadcast) &&
        !('key' in broadcast) && !('uploadId' in broadcast),
      broadcast ? Object.keys(broadcast).join(',') : 'no broadcast');

    /* the total must match the token: a client cannot redefine its own upload */
    const lying = await emit(mpHost, 'upload:room-progress', {
      mode: 'single',
      token: progressIntent.token,
      label: 'x',
      uploadedBytes: 1,
      totalBytes: 999999,
      status: 'uploading',
    });
    check('(multipart) a progress report whose total disagrees with the token is refused',
      lying && lying.ok === false && lying.error === 'SIZE_MISMATCH',
      lying ? JSON.stringify(lying) : 'no ack');

    /* an unknown status is refused rather than broadcast */
    const badStatus = await emit(mpHost, 'upload:room-progress', {
      mode: 'single',
      token: progressIntent.token,
      label: 'x',
      uploadedBytes: 1,
      totalBytes: 4096,
      status: 'completed',
    });
    check('(multipart) an out-of-contract progress status is refused',
      badStatus && badStatus.ok === false && badStatus.error === 'BAD_STATUS',
      badStatus ? JSON.stringify(badStatus) : 'no ack');

    /* a state change is sent immediately, bypassing the 2s byte throttle */
    const pausedSeen = waitFor(mpGuest, 'upload:progress');
    await emit(mpHost, 'upload:room-progress', {
      mode: 'single',
      token: progressIntent.token,
      label: 'progress.mp4',
      uploadedBytes: 1024,
      totalBytes: 4096,
      status: 'paused',
    });
    const pausedGot = await pausedSeen;
    check('(multipart) a state transition is broadcast immediately',
      pausedGot && pausedGot.status === 'paused', pausedGot ? pausedGot.status : 'no broadcast');

    /* a member joining mid-upload sees it in the snapshot */
    const mpLate = await spawn();
    const lateJoin = await emit(mpLate, 'room:join', { code: mpCode, name: 'MP Late' });
    const lateUploads = lateJoin && lateJoin.snapshot ? lateJoin.snapshot.uploads : null;
    check('(multipart) active progress is carried in the room snapshot',
      Array.isArray(lateUploads) && lateUploads.some((u) => u.status === 'paused'),
      JSON.stringify(lateUploads));
    mpLate.disconnect();

    /* a progress report from a member who never had the token is refused */
    const borrowed = await emit(mpGuest, 'upload:room-progress', {
      mode: 'multipart',
      token: progressIntent.token,
      label: 'x',
      uploadedBytes: 1,
      totalBytes: 4096,
      status: 'uploading',
    });
    check('(multipart) the guest cannot report progress against a multipart token it does not hold',
      borrowed && borrowed.ok === false, borrowed ? JSON.stringify(borrowed) : 'no ack');

    /* completing the upload clears the progress for everyone */
    const clearedSeen = waitFor(mpGuest, 'upload:progress');
    const putUrl = new global.URL(progressIntent.uploadUrl, URL).toString();
    const progressBody = Buffer.alloc(4096, 3);
    const put = await fetch(putUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(progressBody.length) },
      body: progressBody,
    });
    if (put.ok) {
      const done = await emit(mpHost, 'upload:complete', { token: progressIntent.token, label: 'progress.mp4' });
      check('(multipart) the upload completes and publishes a source',
        done && done.ok === true && done.source && done.source.quality === 'Uploaded',
        done ? JSON.stringify(done.error || done.source.quality) : 'no ack');
      const cleared = await clearedSeen;
      check('(multipart) completion clears the room progress',
        cleared && cleared.cleared === true, cleared ? JSON.stringify(cleared) : 'no broadcast');
    } else {
      check('(multipart) the byte endpoint accepted the progress fixture', false, `status=${put.status}`);
    }
  }

  /* ---- a kicked member's progress is cleared with their seat ---- */
  {
    const kickHost = await spawn();
    const kickCode = (await emit(kickHost, 'room:create', { code: 'MPT002' })).code;
    await emit(kickHost, 'room:join', { code: kickCode, name: 'Kick Host' });
    const kickVictim = await spawn();
    const victimJoin = await emit(kickVictim, 'room:join', { code: kickCode, name: 'Victim' });
    const victimId = victimJoin && victimJoin.memberId;

    const victimIntent = await emit(kickVictim, 'upload:intent', {
      fileName: 'victim.mp4',
      mimeType: 'video/mp4',
      size: 2048,
    });
    if (victimIntent && victimIntent.ok) {
      await emit(kickVictim, 'upload:room-progress', {
        mode: 'single',
        token: victimIntent.token,
        label: 'victim.mp4',
        uploadedBytes: 1024,
        totalBytes: 2048,
        status: 'uploading',
      });
      const clearedSeen = waitFor(kickHost, 'upload:progress', GRACE_MS + 6000);
      await emit(kickHost, 'room:kick', { socketId: victimId });
      const cleared = await clearedSeen;
      check('(multipart) a removed member’s upload progress is cleared',
        cleared && cleared.cleared === true && cleared.memberId === victimId,
        cleared ? JSON.stringify(cleared) : 'no broadcast');
    }
    [kickHost, kickVictim].forEach((sock) => sock.disconnect());
  }

  [mpHost, mpGuest, mpStranger].forEach((sock) => sock.disconnect());

  section('19. WebRTC signal relay');
  /* ======================================================================
     19. WebRTC signal relay validation
     ---------------------------------------------------------------------- */
  const rtcHost = await spawn();
  const rtcCode = (await emit(rtcHost, 'room:create', { code: 'RTC001' })).code;
  const rtcHostId = (await emit(rtcHost, 'room:join', { code: rtcCode, name: 'RtcHost' })).memberId;
  const rtcGuest = await spawn();
  const rtcGuestId = (await emit(rtcGuest, 'room:join', { code: rtcCode, name: 'RtcGuest' })).memberId;

  const goodOffer = { type: 'offer', sdp: { type: 'offer', sdp: 'v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\n' } };

  // (1) a socket in no room cannot relay a signal.
  const stray = await spawn();
  const strayRtc = await emit(stray, 'rtc:signal', { to: rtcGuestId, data: goodOffer });
  check('(rtc) signal from a non-member is rejected',
    strayRtc && strayRtc.ok === false && strayRtc.error === 'UNAUTHORIZED', strayRtc && strayRtc.error);

  // (2) a member cannot relay to someone who is not in the room.
  const wrongTarget = await emit(rtcHost, 'rtc:signal', { to: stray.id, data: goodOffer });
  check('(rtc) signal to a non-room member is rejected',
    wrongTarget && wrongTarget.ok === false && wrongTarget.error === 'NOT_MEMBER', wrongTarget && wrongTarget.error);

  // (2b) a missing recipient is rejected.
  const noTo = await emit(rtcHost, 'rtc:signal', { data: goodOffer });
  check('(rtc) signal with no recipient is rejected', noTo && noTo.ok === false && noTo.error === 'NO_RECIPIENT');

  // (3) an approved member → approved member signal is accepted AND relayed.
  const relayed = waitFor(rtcGuest, 'rtc:signal');
  const okSignal = await emit(rtcHost, 'rtc:signal', { to: rtcGuestId, data: goodOffer });
  check('(rtc) an approved member-to-member signal is accepted', okSignal && okSignal.ok === true, okSignal && okSignal.error);
  const relayedGot = await relayed;
  check('(rtc) the accepted signal is relayed to the recipient',
    relayedGot && relayedGot.from === rtcHostId && relayedGot.data && relayedGot.data.type === 'offer');

  // (4) an unsupported signal type is rejected.
  const badTypeSig = await emit(rtcHost, 'rtc:signal', { to: rtcGuestId, data: { type: 'bye' } });
  check('(rtc) an unsupported signal type is rejected',
    badTypeSig && badTypeSig.ok === false && badTypeSig.error === 'BAD_TYPE', badTypeSig && badTypeSig.error);

  // (5) an oversized signal is rejected. DERIVED from the server's own cap —
  // a hard-coded number here silently stops testing anything the moment the
  // cap is raised to fit a bigger SDP.
  const bigOffer = { type: 'offer', sdp: { type: 'offer', sdp: 'x'.repeat(MAX_SIGNAL_BYTES + 4096) } };
  const tooBigSig = await emit(rtcHost, 'rtc:signal', { to: rtcGuestId, data: bigOffer });
  check('(rtc) an oversized signal is rejected', tooBigSig && tooBigSig.ok === false && tooBigSig.error === 'TOO_LARGE',
    tooBigSig && tooBigSig.error);

  // (6) rtc:state from a non-member is ignored (no broadcast reaches members).
  const noState = await expectNo(rtcHost, 'rtc:state', () => {
    stray.emit('rtc:state', { mic: true, cam: true, screen: false, inCall: true });
  });
  check('(rtc) rtc:state from a non-member is ignored', noState);

  // (7) rtc:call from a non-member is ignored (no incoming-call reaches members).
  const noCall = await expectNo(rtcHost, 'rtc:call', () => {
    stray.emit('rtc:call', { mode: 'video' });
  });
  check('(rtc) rtc:call from a non-member is ignored', noCall);

  // A valid rtc:call from a member still reaches the other member.
  const callGot = waitFor(rtcGuest, 'rtc:call');
  rtcHost.emit('rtc:call', { mode: 'audio' });
  const call = await callGot;
  check('(rtc) a member rtc:call reaches the room', call && call.from === rtcHostId && call.mode === 'audio');

  section('20. stable seat identity + reconnect grace');
  /* ======================================================================
     20. stable seat identity + reconnect grace
     ----------------------------------------------------------------------
     Requires the server to run with a SHORT grace, e.g.
     ROOM_RECONNECT_GRACE_MS=500, so the expiry case is testable. The reclaim
     checks pass at any grace length.
     ---------------------------------------------------------------------- */
  const seatHost = await spawn();
  const seatCode = (await emit(seatHost, 'room:create', { code: 'SEAT01' })).code;
  const seatHostJoin = await emit(seatHost, 'room:join', { code: seatCode, name: 'SeatHost', seatId: 'seat-host' });
  check('(seat) join returns a stable member id',
    seatHostJoin && seatHostJoin.ok && typeof seatHostJoin.memberId === 'string', seatHostJoin && seatHostJoin.memberId);
  const hostMemberId = seatHostJoin.memberId;
  check('(seat) the member id is NOT the socket id', hostMemberId !== seatHost.id);

  const seatGuest = await spawn();
  const seatGuestJoin = await emit(seatGuest, 'room:join', { code: seatCode, name: 'SeatGuest', seatId: 'seat-guest' });
  const guestMemberId = seatGuestJoin.memberId;
  check('(seat) a second member joins with its own stable id', seatGuestJoin.ok && guestMemberId !== hostMemberId);

  /* ---- refresh: same seat, no churn ---- */
  // Let the ORIGINAL join broadcast drain first: the ack can beat the room-wide
  // `message` to the host, which would otherwise be miscounted as churn.
  await sleep(300);
  // Count join/left system messages seen by the host across the refresh.
  const churn = { joined: 0, left: 0 };
  const countChurn = (m) => {
    if (m && m.kind === 'system' && /SeatGuest joined/.test(m.text || '')) churn.joined += 1;
    if (m && m.kind === 'system' && /SeatGuest left/.test(m.text || '')) churn.left += 1;
  };
  seatHost.on('message', countChurn);

  seatGuest.disconnect(); // simulates the tab refreshing
  await sleep(Math.min(200, GRACE_MS / 2));

  const reborn = await spawn();
  const seatReclaim = await emit(reborn, 'room:join', { code: seatCode, name: 'SeatGuest', seatId: 'seat-guest' });
  await sleep(250);
  seatHost.off('message', countChurn);

  check('(seat) a refresh reclaims the same seat', seatReclaim && seatReclaim.ok && seatReclaim.reclaimed === true,
    seatReclaim && String(seatReclaim.reclaimed));
  check('(seat) the reclaimed member id is unchanged', seatReclaim && seatReclaim.memberId === guestMemberId,
    seatReclaim && `${seatReclaim.memberId} vs ${guestMemberId}`);
  check('(seat) the room still has exactly 2 members after a refresh',
    seatReclaim.snapshot && seatReclaim.snapshot.members.length === 2,
    seatReclaim.snapshot && String(seatReclaim.snapshot.members.length));
  check('(seat) a refresh emits NO duplicate "joined" message', churn.joined === 0, `joined=${churn.joined}`);
  check('(seat) a refresh emits NO "left" message', churn.left === 0, `left=${churn.left}`);
  check('(seat) the host is unchanged across a guest refresh',
    seatReclaim.snapshot && seatReclaim.snapshot.hostId === hostMemberId,
    seatReclaim.snapshot && seatReclaim.snapshot.hostId);
  check('(seat) the reclaimed socket has full room authority',
    (await emit(reborn, 'sync:request', null)) !== null);

  /* ---- media state + RTC routing across a mid-call refresh ---- */
  const mediaHost = await spawn();
  const mediaCode = (await emit(mediaHost, 'room:create', { code: 'SEAT05' })).code;
  await emit(mediaHost, 'room:join', { code: mediaCode, name: 'MHost', seatId: 'mh' });
  const caller = await spawn();
  const callerId = (await emit(caller, 'room:join', { code: mediaCode, name: 'Caller', seatId: 'seat-call' })).memberId;

  // The member goes "in call" with mic + camera live. (Media is announced on
  // `rtc:state`, which is separate from the `presence` broadcast.)
  const mediaOn = waitFor(mediaHost, 'rtc:state');
  caller.emit('rtc:state', { mic: true, cam: true, screen: false, inCall: true });
  const onState = await mediaOn;
  check('(seat) an in-call member advertises live media',
    onState && onState.id === callerId && onState.media.inCall === true && onState.media.mic === true &&
      onState.media.cam === true,
    onState && JSON.stringify(onState.media));

  // …then their tab refreshes mid-call.
  const gracePresence = waitFor(mediaHost, 'presence');
  caller.disconnect();
  const graceState = await gracePresence;
  const graceMember = graceState && graceState.members.find((m) => m.id === callerId);
  check('(seat) a disconnected member is still LISTED during grace',
    Boolean(graceMember), graceState && `members=${graceState.members.length}`);
  check('(seat) a disconnected member is marked connected:false',
    graceMember && graceMember.connected === false, graceMember && String(graceMember.connected));
  check('(seat) a disconnected member has its media state CLEARED (no stale in-call/mic/cam)',
    graceMember &&
      graceMember.media.inCall === false &&
      graceMember.media.mic === false &&
      graceMember.media.cam === false &&
      graceMember.media.screen === false,
    graceMember && JSON.stringify(graceMember.media));

  // RTC must refuse to route to them while their transport is gone.
  const offlineSignal = await emit(mediaHost, 'rtc:signal', {
    to: callerId,
    data: { type: 'offer', sdp: { type: 'offer', sdp: 'v=0\r\n' } },
  });
  check('(seat) an RTC signal to a disconnected member is refused',
    offlineSignal && offlineSignal.ok === false && offlineSignal.error === 'PEER_OFFLINE',
    offlineSignal && offlineSignal.error);

  // Reclaim the seat, and routing works again.
  const callerBack = await spawn();
  const backPresence = waitFor(mediaHost, 'presence');
  const backJoin = await emit(callerBack, 'room:join', { code: mediaCode, name: 'Caller', seatId: 'seat-call' });
  check('(seat) the mid-call refresher reclaims the same seat',
    backJoin && backJoin.reclaimed === true && backJoin.memberId === callerId);
  const backState = await backPresence;
  const backMember = backState && backState.members.find((m) => m.id === callerId);
  check('(seat) a reconnected member is marked connected:true again',
    backMember && backMember.connected === true, backMember && String(backMember.connected));
  const onlineSignal = await emit(mediaHost, 'rtc:signal', {
    to: callerId,
    data: { type: 'offer', sdp: { type: 'offer', sdp: 'v=0\r\n' } },
  });
  check('(seat) RTC routing to that member works again after reconnect',
    onlineSignal && onlineSignal.ok === true, onlineSignal && onlineSignal.error);

  /* ---- the HOST can refresh and stay host ---- */
  seatHost.disconnect();
  await sleep(Math.min(200, GRACE_MS / 2));
  const hostAgain = await spawn();
  const hostReclaim = await emit(hostAgain, 'room:join', { code: seatCode, name: 'SeatHost', seatId: 'seat-host' });
  check('(seat) a host refresh keeps the same member id', hostReclaim.memberId === hostMemberId);
  check('(seat) a host refresh does NOT hand off the crown',
    hostReclaim.snapshot && hostReclaim.snapshot.hostId === hostMemberId, hostReclaim.snapshot && hostReclaim.snapshot.hostId);

  /* ---- RTC routing follows the seat to its new socket ---- */
  const rtcAfter = waitFor(reborn, 'rtc:signal');
  const rtcSend = await emit(hostAgain, 'rtc:signal', {
    to: guestMemberId,
    data: { type: 'offer', sdp: { type: 'offer', sdp: 'v=0\r\n' } },
  });
  check('(seat) an RTC signal addressed to a stable member id is accepted', rtcSend && rtcSend.ok === true,
    rtcSend && rtcSend.error);
  const rtcGot = await rtcAfter;
  check('(seat) the RTC signal reaches the member on its NEW socket',
    rtcGot && rtcGot.from === hostMemberId, rtcGot && rtcGot.from);

  /* ---- grace expiry removes the member exactly once ---- */
  let expiredLeft = 0;
  const countExpired = (m) => {
    if (m && m.kind === 'system' && /SeatGuest left/.test(m.text || '')) expiredLeft += 1;
  };
  hostAgain.on('message', countExpired);
  // Assert the precondition (and let prior socket traffic drain) before the
  // disconnect, so the expiry assertions below measure only the grace window.
  const beforeExpiry = await emit(hostAgain, 'room:probe', { code: seatCode });
  check('(seat) both seats are occupied before the expiry test', beforeExpiry && beforeExpiry.occupants === 2,
    beforeExpiry && `occupants=${beforeExpiry.occupants}`);
  // Same fixed-window race as host succession: the removal is driven by the
  // grace timer, so wait for the departure ANNOUNCEMENT rather than for a
  // deadline that load can overrun.
  const departure = messageMatching(
    hostAgain,
    (m) => m && m.kind === 'system' && /SeatGuest left/.test(m.text || ''),
  );
  reborn.disconnect();
  await departure;
  // A short settle window ON TOP, so a DUPLICATE removal would still be seen.
  // Waiting longer here can only make the exactly-once assertion stricter.
  await sleep(300);
  hostAgain.off('message', countExpired);
  const afterExpiry = await emit(hostAgain, 'sync:request', null);
  check('(seat) after grace expires the member is removed exactly once', expiredLeft === 1, `left=${expiredLeft}`);
  const probeAfter = await emit(hostAgain, 'room:probe', { code: seatCode });
  check('(seat) the room is down to one member after expiry', probeAfter && probeAfter.occupants === 1,
    probeAfter && `occupants=${probeAfter.occupants}`);
  check('(seat) the surviving member still has authority', afterExpiry !== null);

  /* ---- explicit leave is immediate (no grace) ---- */
  const leaveHostS = await spawn();
  const leaveCodeS = (await emit(leaveHostS, 'room:create', { code: 'SEAT02' })).code;
  await emit(leaveHostS, 'room:join', { code: leaveCodeS, name: 'LHost', seatId: 'lh' });
  const quitter = await spawn();
  await emit(quitter, 'room:join', { code: leaveCodeS, name: 'Quitter', seatId: 'seat-quit' });
  const quitGone = waitFor(leaveHostS, 'peer:left');
  quitter.emit('room:leave', { code: leaveCodeS });
  check('(seat) explicit leave removes immediately, without waiting for grace', Boolean(await quitGone));
  // …and the seat is gone, so the same token joins as a NEW member.
  const rejoined = await emit(quitter, 'room:join', { code: leaveCodeS, name: 'Quitter', seatId: 'seat-quit' });
  check('(seat) after an explicit leave the same token gets a NEW seat',
    rejoined.ok && rejoined.reclaimed !== true, rejoined && String(rejoined.reclaimed));

  /* ---- a kicked seat cannot be reclaimed ---- */
  const kickHostS = await spawn();
  const kickCodeS = (await emit(kickHostS, 'room:create', { code: 'SEAT03' })).code;
  await emit(kickHostS, 'room:join', { code: kickCodeS, name: 'KHost', seatId: 'kh' });
  const doomed = await spawn();
  const doomedJoin = await emit(doomed, 'room:join', { code: kickCodeS, name: 'Doomed', seatId: 'seat-doomed' });
  const seatKickSeen = waitFor(doomed, 'room:kicked');
  await emit(kickHostS, 'room:kick', { socketId: doomedJoin.memberId });
  await seatKickSeen;
  // A brand-new connection presenting the SAME seat token must still be refused.
  const sneaky = await spawn();
  const sneakyJoin = await emit(sneaky, 'room:join', { code: kickCodeS, name: 'Doomed', seatId: 'seat-doomed' });
  check('(seat) a kicked seat cannot be reclaimed by a fresh connection',
    sneakyJoin && sneakyJoin.ok === false && sneakyJoin.error === 'KICKED', sneakyJoin && sneakyJoin.error);

  /* ---- a pending guest cannot refresh into membership ---- */
  const gateHostS = await spawn();
  const gateCodeS = (await emit(gateHostS, 'room:create', { code: 'SEAT04', waitingRoom: true })).code;
  await emit(gateHostS, 'room:join', { code: gateCodeS, name: 'GHost', seatId: 'gh' });
  const pendingS = await spawn();
  const pendJoin = await emit(pendingS, 'room:join', { code: gateCodeS, name: 'Pend', seatId: 'seat-pend' });
  check('(seat) a waiting-room guest is pending', pendJoin && pendJoin.ok && pendJoin.pending === true);
  pendingS.disconnect();
  await sleep(150);
  const pendAgain = await spawn();
  const pendRetry = await emit(pendAgain, 'room:join', { code: gateCodeS, name: 'Pend', seatId: 'seat-pend' });
  check('(seat) a pending guest cannot refresh into approved membership',
    pendRetry && pendRetry.ok && pendRetry.pending === true && !pendRetry.reclaimed,
    pendRetry && `pending=${pendRetry.pending} reclaimed=${pendRetry.reclaimed}`);
  check('(seat) the refreshed pending guest still has no room authority',
    (await emit(pendAgain, 'sync:request', null)) === null);

  /* ---- an APPROVED waiting-room member can refresh without re-queuing ---- */
  const approvedSeen = waitFor(pendAgain, 'lobby:approved');
  gateHostS.emit('lobby:decide', { socketId: pendAgain.id, approve: true });
  const approvedPayload = await approvedSeen;
  check('(seat) approval hands the guest a stable member id',
    approvedPayload && typeof approvedPayload.memberId === 'string', approvedPayload && approvedPayload.memberId);
  pendAgain.disconnect();
  await sleep(Math.min(200, GRACE_MS / 2));
  const approvedBack = await spawn();
  const approvedReclaim = await emit(approvedBack, 'room:join', { code: gateCodeS, name: 'Pend', seatId: 'seat-pend' });
  check('(seat) an approved member refreshes straight back in, not into the lobby',
    approvedReclaim && approvedReclaim.ok && approvedReclaim.reclaimed === true && !approvedReclaim.pending,
    approvedReclaim && `reclaimed=${approvedReclaim.reclaimed} pending=${approvedReclaim.pending}`);
  check('(seat) the approved member keeps the id it was granted',
    approvedReclaim.memberId === approvedPayload.memberId);

  section('21. abuse throttling + chat memory bounds');
  /* ======================================================================
     21. abuse throttling + chat memory bounds
     ---------------------------------------------------------------------- */
  const rlHost = await spawn();
  const rlCode = (await emit(rlHost, 'room:create', { code: 'RATE01' })).code;
  await emit(rlHost, 'room:join', { code: rlCode, name: 'RateHost', seatId: 'rl-host' });
  const rlGuest = await spawn();
  await emit(rlGuest, 'room:join', { code: rlCode, name: 'RateGuest', seatId: 'rl-guest' });

  /* ---- normal traffic is unaffected ---- */
  const normalChat = [];
  for (let i = 0; i < 4; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    normalChat.push(await emit(rlHost, 'chat:send', { kind: 'text', text: `hello ${i}` }));
  }
  check('(rate) ordinary chat messages all pass', normalChat.every((r) => r && r.ok),
    normalChat.map((r) => (r && r.ok ? 'ok' : (r && r.error) || 'null')).join(','));

  const normalSync = await emit(rlGuest, 'sync:request', null);
  check('(rate) background sync traffic at normal cadence is unaffected',
    normalSync && typeof normalSync.time === 'number');

  /* ---- chat flood is throttled ---- */
  const flood = [];
  for (let i = 0; i < 25; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    flood.push(await emit(rlHost, 'chat:send', { kind: 'text', text: `flood ${i}` }));
  }
  const limited = flood.filter((r) => r && r.error === 'RATE_LIMITED');
  check('(rate) a chat flood is RATE_LIMITED', limited.length > 0, `${limited.length}/25 limited`);
  check('(rate) the limiter reports a retry hint',
    limited.length > 0 && limited[0].retryAfterMs > 0, limited[0] && String(limited[0].retryAfterMs));

  // The OTHER member is unaffected — limits are per member, not global.
  const otherMember = await emit(rlGuest, 'chat:send', { kind: 'text', text: 'still fine' });
  check('(rate) another member is not affected by someone else’s flood',
    otherMember && otherMember.ok === true, otherMember && otherMember.error);

  /* ---- attachment size + memory bounds ---- */
  const b64 = (bytes) => 'A'.repeat(Math.ceil(bytes / 3) * 4);
  const small = await emit(rlGuest, 'chat:send', {
    kind: 'image', data: `data:image/png;base64,${b64(2048)}`, fileName: 'a.png', mimeType: 'image/png', size: 2048,
  });
  check('(rate) a small attachment passes', small && small.ok === true, small && small.error);

  // Over the 8 MiB decoded cap, but inside the derived maxHttpBufferSize — the
  // envelope headroom in realtimeMaxBufferBytes() is exactly what lets a
  // slightly-oversized payload reach the handler and come back as TOO_LARGE
  // instead of being silently dropped by the transport.
  const overCap = Math.floor(8.5 * 1024 * 1024);
  const huge = await emit(rlGuest, 'chat:send', {
    kind: 'image', data: `data:image/png;base64,${b64(overCap)}`, fileName: 'big.png',
    mimeType: 'image/png', size: overCap,
  });
  check('(rate) an oversized attachment is rejected as TOO_LARGE',
    huge && huge.ok === false && huge.error === 'TOO_LARGE', huge && huge.error);

  const malformed = await emit(rlGuest, 'chat:send', { kind: 'image', data: 'not-a-data-url' });
  check('(rate) a malformed attachment is rejected', malformed && malformed.ok === false, malformed && malformed.error);

  /* ---- a NEAR-LIMIT attachment must actually be sendable ----
     Regression guard: the attachment bucket used to be smaller than the largest
     accepted file, so anything over ~3 MiB passed validation and was then
     rejected by the limiter forever. */
  const nearLimitHost = await spawn();
  const nearCode = (await emit(nearLimitHost, 'room:create', { code: 'RATE03' })).code;
  await emit(nearLimitHost, 'room:join', { code: nearCode, name: 'NearHost', seatId: 'near' });
  // Just under the 8 MiB decoded cap (the helper rounds up, so leave headroom).
  const nearLimitBytes = Math.floor(7.9 * 1024 * 1024);
  const nearPayload = `data:image/png;base64,${b64(nearLimitBytes)}`;

  const nearFirst = await emit(nearLimitHost, 'chat:send', {
    kind: 'image', data: nearPayload, fileName: 'near.png', mimeType: 'image/png',
  });
  check('(rate) a valid near-limit attachment is ACCEPTED from a fresh bucket',
    nearFirst && nearFirst.ok === true, nearFirst && nearFirst.error);

  const nearSecond = await emit(nearLimitHost, 'chat:send', {
    kind: 'image', data: nearPayload, fileName: 'near2.png', mimeType: 'image/png',
  });
  check('(rate) a second immediate near-limit attachment is RATE_LIMITED (not TOO_LARGE)',
    nearSecond && nearSecond.ok === false && nearSecond.error === 'RATE_LIMITED',
    nearSecond && nearSecond.error);
  check('(rate) the throttled large attachment reports a retry hint',
    nearSecond && nearSecond.retryAfterMs > 0, nearSecond && String(nearSecond.retryAfterMs));

  // The room must not grow without bound: history is capped by BYTES too, so a
  // fresh joiner's snapshot stays small even after several large attachments.
  const attachRoom = await spawn();
  const attachCode = (await emit(attachRoom, 'room:create', { code: 'RATE02' })).code;
  await emit(attachRoom, 'room:join', { code: attachCode, name: 'AttachHost', seatId: 'ah' });
  let accepted = 0;
  for (let i = 0; i < 12; i += 1) {
    // ~1MB each, under the per-attachment cap but well over any sane history budget.
    // eslint-disable-next-line no-await-in-loop
    const res = await emit(attachRoom, 'chat:send', {
      kind: 'image', data: `data:image/png;base64,${b64(1024 * 1024)}`, fileName: `x${i}.png`, mimeType: 'image/png',
    });
    if (res && res.ok) accepted += 1;
  }
  const snapshotAfter = await emit(attachRoom, 'room:join', { code: attachCode, name: 'AttachHost', seatId: 'ah' });
  const historyBytes = snapshotAfter && snapshotAfter.snapshot
    ? Buffer.byteLength(JSON.stringify(snapshotAfter.snapshot.history || []), 'utf8')
    : -1;
  check('(rate) large attachments are eventually throttled or evicted, not retained without bound',
    historyBytes >= 0 && historyBytes < 40 * 1024 * 1024,
    `accepted=${accepted} historyBytes=${Math.round(historyBytes / 1024)}KiB`);

  /* ---- reaction flood is dropped silently ---- */
  let reactionsSeen = 0;
  const countReactions = () => { reactionsSeen += 1; };
  rlGuest.on('room:reaction', countReactions);
  for (let i = 0; i < 60; i += 1) rlHost.emit('room:reaction', { emoji: '🔥' });
  await sleep(500);
  rlGuest.off('room:reaction', countReactions);
  check('(rate) a reaction flood is throttled, not fully broadcast', reactionsSeen < 60,
    `${reactionsSeen}/60 relayed`);

  /* ---- source mutation flood does not broadcast every change ---- */
  let sourceBroadcasts = 0;
  const countSource = () => { sourceBroadcasts += 1; };
  rlGuest.on('source:set', countSource);
  const sourceAcks = [];
  for (let i = 0; i < 30; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    sourceAcks.push(await emit(rlHost, 'source:set', { type: 'url', value: `https://example.com/${i}.mp4`, label: `V${i}` }));
  }
  await sleep(300);
  rlGuest.off('source:set', countSource);
  check('(rate) a source mutation flood is throttled',
    sourceAcks.some((r) => r && r.error === 'RATE_LIMITED') && sourceBroadcasts < 30,
    `broadcasts=${sourceBroadcasts}/30`);

  /* ---- upload intent flood cannot mint unlimited tokens ---- */
  const tokens = [];
  for (let i = 0; i < 12; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await emit(rlGuest, 'upload:intent', { fileName: `f${i}.mp4`, mimeType: 'video/mp4', size: 1024 });
    tokens.push(res);
  }
  const issued = tokens.filter((r) => r && r.ok).length;
  const refused = tokens.filter((r) => r && r.error === 'RATE_LIMITED').length;
  check('(rate) an upload-intent flood stops issuing tokens', refused > 0 && issued < 12,
    `issued=${issued} refused=${refused}`);

  /* ---- WebRTC: a normal burst passes, an extreme flood is limited ---- */
  const candidate = { type: 'ice', candidate: { candidate: 'candidate:1 1 udp 2 10.0.0.1 1 typ host', sdpMid: '0' } };
  // Idempotent rejoin just to read the guest's stable member id for routing.
  const rlGuestId = (await emit(rlGuest, 'room:join', { code: rlCode, name: 'RateGuest', seatId: 'rl-guest' })).memberId;
  const realBurst = [];
  for (let i = 0; i < 20; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    realBurst.push(await emit(rlHost, 'rtc:signal', { to: rlGuestId, data: candidate }));
  }
  check('(rate) a normal ICE burst still succeeds', realBurst.every((r) => r && r.ok === true),
    `${realBurst.filter((r) => r && r.ok).length}/20 relayed`);

  const rtcFlood = [];
  for (let i = 0; i < 220; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    rtcFlood.push(await emit(rlHost, 'rtc:signal', { to: rlGuestId, data: candidate }));
  }
  check('(rate) an extreme RTC flood is eventually rate-limited',
    rtcFlood.some((r) => r && r.error === 'RATE_LIMITED'),
    `limited=${rtcFlood.filter((r) => r && r.error === 'RATE_LIMITED').length}/220`);

  /* ---- reconnect with the same seat still works under limits ---- */
  rlGuest.disconnect();
  await sleep(Math.min(200, GRACE_MS / 2));
  const rlBack = await spawn();
  const rlReclaim = await emit(rlBack, 'room:join', { code: rlCode, name: 'RateGuest', seatId: 'rl-guest' });
  check('(rate) reconnecting with the same seat is not blocked by limits',
    rlReclaim && rlReclaim.ok === true, rlReclaim && rlReclaim.error);

  /* ---- clock calibration: a normal burst passes, a flood is bounded ---- */
  const clockSocket = await spawn();
  const calibration = [];
  for (let i = 0; i < 7; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    calibration.push(await emit(clockSocket, 'clock:ping', Date.now()));
  }
  check('(rate) a normal 7-sample clock calibration is never throttled',
    calibration.every((r) => r && typeof r.serverTime === 'number'),
    `${calibration.filter((r) => r && typeof r.serverTime === 'number').length}/7 usable`);

  const clockFlood = [];
  for (let i = 0; i < 40; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    clockFlood.push(await emit(clockSocket, 'clock:ping', Date.now()));
  }
  check('(rate) an unauthenticated clock-ping flood is bounded',
    clockFlood.some((r) => r === null), `nulls=${clockFlood.filter((r) => r === null).length}/40`);
  // Explicitly acked with null (not a timeout) so calibrateClock skips the
  // sample rather than feeding undefined into the offset maths.
  check('(rate) a throttled clock ping is acked with null, never a partial object',
    clockFlood.every((r) => r === null || typeof r.serverTime === 'number'));

  const otherClock = await spawn();
  const otherPing = await emit(otherClock, 'clock:ping', Date.now());
  check('(rate) another socket still calibrates normally during that flood',
    otherPing && typeof otherPing.serverTime === 'number');

  /* ---- typing cannot starve playback sync ---- */
  const tsHost = await spawn();
  const tsCode = (await emit(tsHost, 'room:create', { code: 'RATE04' })).code;
  await emit(tsHost, 'room:join', { code: tsCode, name: 'TsHost', seatId: 'ts-h' });
  const tsGuest = await spawn();
  await emit(tsGuest, 'room:join', { code: tsCode, name: 'TsGuest', seatId: 'ts-g' });

  // Establish a source and take the control epoch as the active controller.
  const tsSourceSeen = waitFor(tsGuest, 'source:set');
  await emit(tsHost, 'source:set', { type: 'url', value: 'https://example.com/ts.mp4', label: 'TS' });
  await tsSourceSeen;
  const tsCtl = await emit(tsHost, 'sync:control', { action: 'play', time: 30 });
  check('(rate) the controller holds an accepted control epoch',
    tsCtl && tsCtl.ok === true && typeof tsCtl.controlSeq === 'number');

  // A sustained typing flood from that same controller.
  let typingRelayed = 0;
  const countTyping = () => { typingRelayed += 1; };
  tsGuest.on('chat:typing', countTyping);
  for (let i = 0; i < 60; i += 1) tsHost.emit('chat:typing', true);
  await sleep(400);
  tsGuest.off('chat:typing', countTyping);
  check('(rate) a typing flood is itself throttled', typingRelayed < 60, `${typingRelayed}/60 relayed`);

  // The playback protocol must be completely unaffected by that flood.
  tsHost.emit('sync:report', {
    time: 55, playing: true, controlSeq: tsCtl.controlSeq, sourceVersion: tsCtl.sourceVersion,
  });
  await sleep(200);
  const tsState = await emit(tsGuest, 'sync:request', null);
  check('(rate) sync:request still returns room state after a typing flood',
    tsState && typeof tsState.time === 'number', tsState === null ? 'null' : 'ok');
  check('(rate) the controller’s sync:report was ACCEPTED despite the typing flood',
    tsState && tsState.time >= 54.5, tsState && `t=${tsState.time.toFixed(2)}`);

  section('ack contract');
  /* ================= acknowledgement contract =================
     Every user-initiated room action must SETTLE. A control that silently does
     nothing — because the caller was not the host, or was throttled — leaves the
     UI spinning with no way to tell the two apart. These handlers used to return
     nothing at all. */

  const ackHost = await spawn();
  const ackCode = (await emit(ackHost, 'room:create', { code: 'ACKS01' })).code;
  await emit(ackHost, 'room:join', { code: ackCode, name: 'AckHost', seatId: 'seat-ack-host' });
  const ackGuest = await spawn();
  const ackGuestJoin = await emit(ackGuest, 'room:join', { code: ackCode, name: 'AckGuest', seatId: 'seat-ack-guest' });
  const ackGuestId = ackGuestJoin && ackGuestJoin.memberId;

  const settingsAck = await emit(ackHost, 'room:settings', { locked: true });
  check('(ack) room:settings answers the host', settingsAck && settingsAck.ok === true,
    settingsAck ? JSON.stringify(settingsAck) : 'no ack');

  const guestSettings = await emit(ackGuest, 'room:settings', { locked: false });
  check('(ack) a non-host room:settings is refused as UNAUTHORIZED, not ignored',
    guestSettings && guestSettings.ok === false && guestSettings.error === 'UNAUTHORIZED',
    guestSettings ? JSON.stringify(guestSettings) : 'no ack');
  await emit(ackHost, 'room:settings', { locked: false });

  const lightsAck = await emit(ackGuest, 'room:lights', { mode: 'off' });
  check('(ack) room:lights answers any member — ambience is not host-only',
    lightsAck && lightsAck.ok === true, lightsAck ? JSON.stringify(lightsAck) : 'no ack');

  const lightsNoop = await emit(ackGuest, 'room:lights', { mode: 'off' });
  check('(ack) a no-op lights toggle still acks ok, so nothing is left pending',
    lightsNoop && lightsNoop.ok === true && lightsNoop.unchanged === true,
    lightsNoop ? JSON.stringify(lightsNoop) : 'no ack');
  await emit(ackGuest, 'room:lights', { mode: 'on' });

  const transferMissing = await emit(ackHost, 'room:transfer-host', { socketId: 'nobody-at-all' });
  check('(ack) transferring host to a stranger reports NOT_FOUND',
    transferMissing && transferMissing.ok === false && transferMissing.error === 'NOT_FOUND',
    transferMissing ? JSON.stringify(transferMissing) : 'no ack');

  const decideMissing = await emit(ackHost, 'lobby:decide', { socketId: 'not-waiting', approve: true });
  check('(ack) deciding on a guest who is not waiting reports NOT_FOUND',
    decideMissing && decideMissing.ok === false && decideMissing.error === 'NOT_FOUND',
    decideMissing ? JSON.stringify(decideMissing) : 'no ack');

  const decideAsGuest = await emit(ackGuest, 'lobby:decide', { socketId: 'anyone', approve: true });
  check('(ack) a non-host cannot decide, and is told so',
    decideAsGuest && decideAsGuest.ok === false && decideAsGuest.error === 'UNAUTHORIZED',
    decideAsGuest ? JSON.stringify(decideAsGuest) : 'no ack');

  // A real approval still settles — the ack was added without changing the flow.
  await emit(ackHost, 'room:settings', { waitingRoom: true });
  const ackPending = await spawn();
  const ackPendingJoin = await emit(ackPending, 'room:join', { code: ackCode, name: 'Waiting', seatId: 'seat-ack-wait' });
  check('(ack) the third arrival lands in the lobby', ackPendingJoin && ackPendingJoin.pending === true,
    ackPendingJoin ? JSON.stringify(ackPendingJoin) : 'no ack');
  const approveAck = await emit(ackHost, 'lobby:decide', { socketId: ackPending.id, approve: true });
  check('(ack) approving a waiting guest acks ok', approveAck && approveAck.ok === true,
    approveAck ? JSON.stringify(approveAck) : 'no ack');
  const ackApproved = await waitFor(ackPending, 'lobby:approved', 2000);
  check('(ack) …and the guest is genuinely admitted', ackApproved && ackApproved.snapshot,
    ackApproved ? 'snapshot delivered' : 'never approved');

  /* ---- rtc:signal always settles, with a distinguishable reason ---- */
  const signalStranger = await emit(ackGuest, 'rtc:signal', {
    to: 'member-who-does-not-exist',
    data: { type: 'ice', candidate: { candidate: 'x', sdpMid: '0' } },
  });
  check('(ack) rtc:signal to a non-member is refused with NOT_MEMBER',
    signalStranger && signalStranger.ok === false && signalStranger.error === 'NOT_MEMBER',
    signalStranger ? JSON.stringify(signalStranger) : 'no ack');

  const signalReal = await emit(ackHost, 'rtc:signal', {
    to: ackGuestId,
    data: { type: 'ice', candidate: { candidate: 'a=candidate:1 1 udp 1 127.0.0.1 1 typ host', sdpMid: '0' } },
  });
  check('(ack) a well-formed rtc:signal to a live member is accepted',
    signalReal && signalReal.ok === true, signalReal ? JSON.stringify(signalReal) : 'no ack');

  /* ---- a rejected source change is reported, so the client can revert ---- */
  const sourceAck = await emit(ackHost, 'source:set', { type: 'youtube', value: 'dQw4w9WgXcQ', label: 'Ack test' });
  check('(ack) an accepted source change acks ok', sourceAck && sourceAck.ok === true,
    sourceAck ? JSON.stringify(sourceAck) : 'no ack');

  const outsider = await spawn();
  const outsiderSource = await emit(outsider, 'source:set', { type: 'url', value: 'https://example.com/x.mp4' });
  check('(ack) a source change from outside the room is refused, never silently dropped',
    outsiderSource && outsiderSource.ok === false && outsiderSource.error === 'UNAUTHORIZED',
    outsiderSource ? JSON.stringify(outsiderSource) : 'no ack');

  const outsiderControl = await emit(outsider, 'sync:control', { action: 'play', time: 5 });
  check('(ack) sync:control from outside the room is refused with a reason',
    outsiderControl && outsiderControl.ok === false && outsiderControl.error === 'UNAUTHORIZED',
    outsiderControl ? JSON.stringify(outsiderControl) : 'no ack');

  const badAction = await emit(ackHost, 'sync:control', { action: 'teleport', time: 5 });
  check('(ack) an unknown sync:control action is rejected as BAD_ACTION, not accepted',
    badAction && badAction.ok === false && badAction.error === 'BAD_ACTION',
    badAction ? JSON.stringify(badAction) : 'no ack');

  const goodControl = await emit(ackHost, 'sync:control', { action: 'play', time: 12 });
  check('(ack) an accepted sync:control returns the epoch the client must adopt',
    goodControl && goodControl.ok === true && typeof goodControl.controlSeq === 'number' &&
      typeof goodControl.sourceVersion === 'number',
    goodControl ? JSON.stringify(goodControl) : 'no ack');

  [ackHost, ackGuest, ackPending, outsider].forEach((s) => s.disconnect());

  /* ---- room creation is eventually limited, per key ---- */
  const creator = await spawn();
  const creations = [];
  for (let i = 0; i < 10; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    creations.push(await emit(creator, 'room:create', {}));
  }
  check('(rate) room creation is eventually rate-limited',
    creations.some((r) => r && r.error === 'RATE_LIMITED'),
    `created=${creations.filter((r) => r && r.ok).length}/10`);

  pool.forEach((s) => s.disconnect());

  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  finish(null);
}

main().catch((error) => {
  console.error('harness error:', error);
  // The checks that DID run before the harness blew up are the most valuable
  // thing in the log, so they are reported here too rather than lost.
  console.log(`\n${results.length - failures}/${results.length} checks passed before the harness error`);
  finish(error instanceof Error ? error : new Error(String(error)));
});
