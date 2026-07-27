/**
 * Realtime smoke test.
 * Drives the Socket.IO layer with two simulated clients and asserts the
 * behaviours the room depends on: creation, joining, presence, playback sync,
 * chat, typing, reactions, waiting room, password gate, host controls.
 *
 *   node scripts/e2e-realtime.js  (server must already be running on :3000)
 */

const { io } = require('socket.io-client');

const URL = process.env.TEST_URL || 'http://localhost:3000';
const results = [];
let failures = 0;

function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail });
  if (!condition) failures += 1;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
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

async function main() {
  /* ---------- 1. clock handshake ---------- */
  const alice = await connect();
  const pong = await emit(alice, 'clock:ping', Date.now());
  check('clock handshake returns server time', pong && typeof pong.serverTime === 'number');

  /* ---------- 2. create + join ---------- */
  const created = await emit(alice, 'room:create', { code: 'TEST01' });
  check('room:create returns a code', created && created.ok && created.code, created && created.code);
  const code = created.code;

  const probe = await emit(alice, 'room:probe', { code });
  check('room:probe sees the new room', probe && probe.exists && !probe.hasPassword);

  const joinA = await emit(alice, 'room:join', { code, name: 'Alice' });
  check('first client joins and gets a snapshot', joinA && joinA.ok && joinA.snapshot);
  check('first client becomes host', joinA.snapshot.hostId === alice.id);

  const bob = await connect();
  const presencePromise = waitFor(alice, 'presence');
  const joinB = await emit(bob, 'room:join', { code, name: 'Bob' });
  check('second client joins', joinB && joinB.ok && !joinB.pending);

  const presence = await presencePromise;
  check('presence broadcasts both members', presence && presence.members.length === 2,
    presence && presence.members.map((m) => m.name).join(', '));

  /* ---------- 3. source ---------- */
  const sourcePromise = waitFor(bob, 'source:set');
  alice.emit('source:set', { type: 'url', value: 'https://example.com/film.mp4', label: 'Test Film' });
  const source = await sourcePromise;
  check('source propagates to the other seat', source && source.label === 'Test Film');

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

  /* ---------- 8. WebRTC signalling ---------- */
  const signalPromise = waitFor(bob, 'rtc:signal');
  alice.emit('rtc:signal', { to: bob.id, data: { type: 'offer', sdp: { type: 'offer', sdp: 'v=0' } } });
  const signal = await signalPromise;
  check('rtc signalling is relayed to the named peer', signal && signal.from === alice.id && signal.data.type === 'offer');

  const rtcStatePromise = waitFor(alice, 'rtc:state');
  bob.emit('rtc:state', { mic: true, cam: false, screen: false, inCall: true });
  const rtcState = await rtcStatePromise;
  check('media state broadcasts to the room', rtcState && rtcState.media.mic && rtcState.media.inCall);

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

  /* ---------- 11. password gate ---------- */
  const secret = await emit(alice, 'room:create', { code: 'SECRET', password: 'moonlight' });
  const secretCode = secret.code;
  const wrong = await emit(stranger, 'room:join', { code: secretCode, name: 'Stranger', password: 'nope' });
  check('wrong passphrase is rejected', wrong && !wrong.ok && wrong.error === 'BAD_PASSWORD');
  const right = await emit(stranger, 'room:join', { code: secretCode, name: 'Stranger', password: 'moonlight' });
  check('correct passphrase is accepted', right && right.ok);

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
  host.emit('lobby:decide', { socketId: guest.id, approve: true });
  const approved = await approvedPromise;
  check('host can admit a waiting guest', Boolean(approved));

  const entered = await emit(guest, 'lobby:enter', { name: 'Guest' });
  check('admitted guest receives the room snapshot', entered && entered.ok && entered.snapshot);
  check('admitted guest appears in presence', entered.snapshot.members.length === 2);

  /* ---------- 13. kick + host handover ---------- */
  const kickedPromise = waitFor(guest, 'room:kicked');
  host.emit('room:kick', { socketId: guest.id });
  check('host can remove someone', Boolean(await kickedPromise));

  const handoverPromise = waitFor(bob, 'presence');
  alice.emit('room:transfer-host', { socketId: bob.id });
  const handover = await handoverPromise;
  check('host seat can be handed over', handover && handover.hostId === bob.id);

  /* ---------- 14. departure ---------- */
  const leftPromise = waitFor(bob, 'peer:left');
  alice.disconnect();
  const left = await leftPromise;
  check('leaving is announced to the room', Boolean(left));

  [bob, stranger, host, guest].forEach((s) => s.disconnect());

  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error('harness error:', error);
  process.exit(1);
});
