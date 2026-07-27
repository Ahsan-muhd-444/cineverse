/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * CineVerse — application server.
 *
 * One Node process does two jobs:
 *   1. Serves the Next.js app (SSR + static assets).
 *   2. Runs the Socket.IO realtime layer: playback sync, chat, presence,
 *      WebRTC signalling and host controls.
 *
 * Keeping both in one process is deliberate — it means the app deploys as a
 * single free service and the WebSocket connection lives on the same origin,
 * so there is no cross-origin handshake before sync can start.
 */

const http = require('http');
const next = require('next');
const { Server } = require('socket.io');

const dev = process.env.NODE_ENV !== 'production';
const hostname = process.env.HOST || '0.0.0.0';
const port = parseInt(process.env.PORT || '3000', 10);

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

/* ==========================================================================
   Room model
   ========================================================================== */

/**
 * @typedef {Object} Member
 * @property {string} id            socket id
 * @property {string} name
 * @property {string} color         deterministic accent for avatars/bubbles
 * @property {boolean} isHost
 * @property {number} joinedAt
 * @property {{mic:boolean, cam:boolean, screen:boolean, inCall:boolean}} media
 * @property {number} lastSeenMessage
 */

/**
 * @typedef {Object} Room
 * @property {string} code
 * @property {string|null} password
 * @property {boolean} waitingRoom
 * @property {boolean} locked
 * @property {string|null} hostId
 * @property {{type:'url'|'youtube'|'local'|'catalog', value:string, label:string, poster?:string, quality?:string}|null} source
 * @property {boolean} playing
 * @property {number} time          last reported position, seconds
 * @property {number} updatedAt     Date.now() at the moment `time` was true
 * @property {number} rate
 * @property {Map<string, Member>} members
 * @property {Map<string, {name:string, socketId:string, at:number}>} lobby
 * @property {Array<Object>} messages   capped ring of recent chat
 * @property {number} createdAt
 * @property {NodeJS.Timeout|null} reaper
 */

/** @type {Map<string, Room>} */
const rooms = new Map();

const MAX_HISTORY = 200;
const EMPTY_ROOM_TTL = 15 * 60 * 1000;

const AVATAR_COLORS = [
  '#8b5cf6', '#22d3ee', '#3b6cf6', '#f472b6',
  '#34d399', '#fbbf24', '#fb7185', '#a78bfa',
];

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f]", "g");
const clean = (v, max = 200) => String(v ?? '').replace(CONTROL_CHARS, '').trim().slice(0, max);
const nowMs = () => Date.now();

function makeCode() {
  // Ambiguous glyphs (0/O, 1/I) removed — these codes get read aloud and typed by hand.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i += 1) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function createRoom(code, opts = {}) {
  const room = {
    code,
    password: opts.password ? String(opts.password).slice(0, 64) : null,
    waitingRoom: Boolean(opts.waitingRoom),
    locked: false,
    hostId: null,
    source: opts.source || null,
    playing: false,
    time: 0,
    updatedAt: nowMs(),
    rate: 1,
    members: new Map(),
    lobby: new Map(),
    messages: [],
    createdAt: nowMs(),
    reaper: null,
  };
  rooms.set(code, room);
  return room;
}

function getRoom(code) {
  return rooms.get(code) || null;
}

/** Server-authoritative playhead: extrapolate from the last report. */
function headPosition(room) {
  if (!room.playing) return room.time;
  return room.time + ((nowMs() - room.updatedAt) / 1000) * (room.rate || 1);
}

function publicMembers(room) {
  return [...room.members.values()].map((m) => ({
    id: m.id,
    name: m.name,
    color: m.color,
    isHost: m.id === room.hostId,
    joinedAt: m.joinedAt,
    media: m.media,
  }));
}

function publicLobby(room) {
  return [...room.lobby.values()].map((p) => ({ socketId: p.socketId, name: p.name, at: p.at }));
}

function roomSnapshot(room) {
  return {
    code: room.code,
    source: room.source,
    playing: room.playing,
    time: headPosition(room),
    rate: room.rate,
    serverTime: nowMs(),
    members: publicMembers(room),
    lobby: publicLobby(room),
    hostId: room.hostId,
    settings: {
      hasPassword: Boolean(room.password),
      waitingRoom: room.waitingRoom,
      locked: room.locked,
    },
    history: room.messages.slice(-60),
  };
}

function broadcastPresence(io, room) {
  io.to(room.code).emit('presence', {
    members: publicMembers(room),
    lobby: publicLobby(room),
    hostId: room.hostId,
  });
}

function pushMessage(room, message) {
  room.messages.push(message);
  if (room.messages.length > MAX_HISTORY) room.messages.splice(0, room.messages.length - MAX_HISTORY);
  return message;
}

function systemMessage(io, room, text) {
  const msg = pushMessage(room, {
    id: `sys_${nowMs()}_${Math.random().toString(36).slice(2, 8)}`,
    kind: 'system',
    text: clean(text, 240),
    ts: nowMs(),
  });
  io.to(room.code).emit('message', msg);
}

function scheduleReap(room) {
  if (room.reaper) clearTimeout(room.reaper);
  room.reaper = setTimeout(() => {
    const live = rooms.get(room.code);
    if (live && live.members.size === 0) rooms.delete(room.code);
  }, EMPTY_ROOM_TTL);
}

/* ==========================================================================
   Boot
   ========================================================================== */

app.prepare().then(() => {
  const server = http.createServer((req, res) => {
    // Tiny health endpoint so the host platform can probe without booting React.
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, rooms: rooms.size, uptime: process.uptime() }));
      return;
    }
    handle(req, res);
  });

  const io = new Server(server, {
    path: '/api/realtime',
    // Voice notes and shared images travel as data URLs; give them room.
    maxHttpBufferSize: 12e6,
    pingInterval: 10000,
    pingTimeout: 20000,
    cors: { origin: true, credentials: true },
  });

  io.on('connection', (socket) => {
    /** @type {string|null} */
    let code = null;
    let admitted = false;

    const me = () => {
      const room = code ? getRoom(code) : null;
      return room ? room.members.get(socket.id) || null : null;
    };
    const isHost = () => {
      const room = code ? getRoom(code) : null;
      return Boolean(room && room.hostId === socket.id);
    };

    /* ---------------- clock sync ---------------- */
    // Round-trip probe so clients can estimate offset + latency (NTP-lite).
    socket.on('clock:ping', (clientSent, ack) => {
      if (typeof ack === 'function') ack({ clientSent, serverTime: nowMs() });
    });

    /* ---------------- room lifecycle ---------------- */

    socket.on('room:create', (payload = {}, ack) => {
      let newCode = clean(payload.code, 8).toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (!newCode || rooms.has(newCode)) {
        do {
          newCode = makeCode();
        } while (rooms.has(newCode));
      }
      createRoom(newCode, {
        password: payload.password ? clean(payload.password, 64) : null,
        waitingRoom: Boolean(payload.waitingRoom),
        source: payload.source || null,
      });
      if (typeof ack === 'function') ack({ ok: true, code: newCode });
    });

    socket.on('room:probe', (payload = {}, ack) => {
      const target = clean(payload.code, 8).toUpperCase();
      const room = getRoom(target);
      if (typeof ack !== 'function') return;
      // `ok` reports whether the probe itself succeeded, not whether the room
      // exists — otherwise the client cannot tell "no such room" apart from
      // "the server is unreachable", and shows the wrong message.
      if (!room) return ack({ ok: true, exists: false });
      ack({
        ok: true,
        exists: true,
        hasPassword: Boolean(room.password),
        waitingRoom: room.waitingRoom,
        locked: room.locked,
        occupants: room.members.size,
      });
    });

    socket.on('room:join', (payload = {}, ack) => {
      const target = clean(payload.code, 8).toUpperCase();
      const name = clean(payload.name, 24) || 'Guest';
      if (!target) return typeof ack === 'function' && ack({ ok: false, error: 'MISSING_CODE' });

      // First person through the door creates the room and becomes host.
      let room = getRoom(target);
      const fresh = !room;
      if (!room) room = createRoom(target, {});

      if (room.locked && !fresh) {
        return typeof ack === 'function' && ack({ ok: false, error: 'LOCKED' });
      }
      if (room.password && clean(payload.password, 64) !== room.password) {
        return typeof ack === 'function' && ack({ ok: false, error: 'BAD_PASSWORD' });
      }

      // Waiting room applies to everyone except the very first arrival.
      if (room.waitingRoom && room.members.size > 0) {
        room.lobby.set(socket.id, { socketId: socket.id, name, at: nowMs() });
        code = target;
        socket.join(`${target}:lobby`);
        broadcastPresence(io, room);
        return typeof ack === 'function' && ack({ ok: true, pending: true, code: target });
      }

      admitTo(room, name);
      if (typeof ack === 'function') ack({ ok: true, pending: false, code: target, snapshot: roomSnapshot(room) });
    });

    function admitTo(room, name) {
      code = room.code;
      admitted = true;
      socket.leave(`${room.code}:lobby`);
      room.lobby.delete(socket.id);
      socket.join(room.code);
      if (room.reaper) {
        clearTimeout(room.reaper);
        room.reaper = null;
      }

      const color = AVATAR_COLORS[room.members.size % AVATAR_COLORS.length];
      room.members.set(socket.id, {
        id: socket.id,
        name,
        color,
        isHost: false,
        joinedAt: nowMs(),
        media: { mic: false, cam: false, screen: false, inCall: false },
        lastSeenMessage: 0,
      });
      if (!room.hostId || !room.members.has(room.hostId)) room.hostId = socket.id;

      broadcastPresence(io, room);
      systemMessage(io, room, `${name} joined the room`);
      // Tell the people already inside that a new peer exists, so they can
      // initiate WebRTC offers if a call is running.
      socket.to(room.code).emit('peer:joined', { id: socket.id, name, color });
    }

    socket.on('lobby:decide', ({ socketId, approve } = {}) => {
      const room = code ? getRoom(code) : null;
      if (!room || !isHost()) return;
      const pending = room.lobby.get(socketId);
      if (!pending) return;
      const target = io.sockets.sockets.get(socketId);
      room.lobby.delete(socketId);
      if (!target) return broadcastPresence(io, room);

      if (approve) {
        target.emit('lobby:approved', { code: room.code });
      } else {
        target.emit('lobby:denied', { code: room.code });
        target.leave(`${room.code}:lobby`);
      }
      broadcastPresence(io, room);
    });

    // The approved guest calls this to actually enter.
    socket.on('lobby:enter', ({ name } = {}, ack) => {
      const room = code ? getRoom(code) : null;
      if (!room) return typeof ack === 'function' && ack({ ok: false });
      admitTo(room, clean(name, 24) || 'Guest');
      if (typeof ack === 'function') ack({ ok: true, snapshot: roomSnapshot(room) });
    });

    socket.on('room:settings', (patch = {}) => {
      const room = code ? getRoom(code) : null;
      if (!room || !isHost()) return;
      if ('password' in patch) room.password = patch.password ? clean(patch.password, 64) : null;
      if ('waitingRoom' in patch) room.waitingRoom = Boolean(patch.waitingRoom);
      if ('locked' in patch) room.locked = Boolean(patch.locked);
      io.to(room.code).emit('room:settings', {
        hasPassword: Boolean(room.password),
        waitingRoom: room.waitingRoom,
        locked: room.locked,
      });
      systemMessage(io, room, 'Host updated the room settings');
    });

    socket.on('room:kick', ({ socketId } = {}) => {
      const room = code ? getRoom(code) : null;
      if (!room || !isHost() || socketId === socket.id) return;
      const victim = room.members.get(socketId);
      if (!victim) return;
      const target = io.sockets.sockets.get(socketId);
      room.members.delete(socketId);
      if (target) {
        target.emit('room:kicked', { code: room.code, at: nowMs() });
        target.leave(room.code);
      }
      io.to(room.code).emit('peer:left', { id: socketId });
      systemMessage(io, room, `${victim.name} was removed by the host`);
      broadcastPresence(io, room);
    });

    socket.on('room:transfer-host', ({ socketId } = {}) => {
      const room = code ? getRoom(code) : null;
      if (!room || !isHost() || !room.members.has(socketId)) return;
      room.hostId = socketId;
      const next = room.members.get(socketId);
      systemMessage(io, room, `${next.name} is now the host`);
      broadcastPresence(io, room);
    });

    /* ---------------- source + playback sync ---------------- */

    socket.on('source:set', (source = {}) => {
      const room = code ? getRoom(code) : null;
      if (!room || !admitted) return;
      room.source = {
        type: ['url', 'youtube', 'local', 'catalog'].includes(source.type) ? source.type : 'url',
        value: clean(source.value, 2048),
        label: clean(source.label, 120) || 'Untitled',
        poster: source.poster ? clean(source.poster, 2048) : undefined,
        quality: source.quality ? clean(source.quality, 12) : undefined,
        variants: Array.isArray(source.variants)
          ? source.variants.slice(0, 6).map((v) => ({ label: clean(v.label, 12), value: clean(v.value, 2048) }))
          : undefined,
      };
      room.playing = false;
      room.time = 0;
      room.updatedAt = nowMs();
      io.to(room.code).emit('source:set', room.source);
      const who = me();
      systemMessage(io, room, `${who ? who.name : 'Someone'} put on “${room.source.label}”`);
    });

    /**
     * A control event carries the initiator's playhead AND their clock reading.
     * Peers apply it relative to their own measured offset, so a 300ms link
     * doesn't turn into a 300ms desync.
     */
    socket.on('sync:control', (payload = {}) => {
      const room = code ? getRoom(code) : null;
      if (!room || !admitted) return;
      const action = ['play', 'pause', 'seek', 'rate'].includes(payload.action) ? payload.action : null;
      if (!action) return;

      const t = Number(payload.time);
      room.time = Number.isFinite(t) && t >= 0 ? t : 0;
      room.updatedAt = nowMs();
      if (action === 'play') room.playing = true;
      if (action === 'pause') room.playing = false;
      if (action === 'rate') room.rate = Math.min(4, Math.max(0.25, Number(payload.rate) || 1));

      const who = me();
      socket.to(room.code).emit('sync:control', {
        action,
        time: room.time,
        rate: room.rate,
        issuedAt: room.updatedAt,
        by: who ? who.name : 'Someone',
        byId: socket.id,
      });
    });

    // Cheap heartbeat from whoever is furthest along; keeps the server honest.
    socket.on('sync:report', ({ time, playing } = {}) => {
      const room = code ? getRoom(code) : null;
      if (!room || !admitted) return;
      const t = Number(time);
      if (!Number.isFinite(t)) return;
      room.time = t;
      room.playing = Boolean(playing);
      room.updatedAt = nowMs();
    });

    // Anyone can ask "where should I be right now?" — used for drift correction.
    socket.on('sync:request', (_p, ack) => {
      const room = code ? getRoom(code) : null;
      if (!room) return typeof ack === 'function' && ack(null);
      if (typeof ack === 'function') {
        ack({ time: headPosition(room), playing: room.playing, rate: room.rate, serverTime: nowMs() });
      }
    });

    /* ---------------- chat ---------------- */

    socket.on('chat:send', (payload = {}, ack) => {
      const room = code ? getRoom(code) : null;
      const author = me();
      if (!room || !author) return typeof ack === 'function' && ack({ ok: false });

      const kind = ['text', 'image', 'gif', 'file', 'voice'].includes(payload.kind) ? payload.kind : 'text';
      const message = {
        id: `m_${nowMs()}_${Math.random().toString(36).slice(2, 8)}`,
        kind,
        authorId: socket.id,
        author: author.name,
        color: author.color,
        ts: nowMs(),
        text: kind === 'text' ? clean(payload.text, 2000) : clean(payload.text, 300),
        replyTo: payload.replyTo ? clean(payload.replyTo, 64) : null,
      };

      if (kind !== 'text') {
        const data = String(payload.data || '');
        if (data.length > 11_000_000) return typeof ack === 'function' && ack({ ok: false, error: 'TOO_LARGE' });
        message.data = data;
        message.fileName = clean(payload.fileName, 160);
        message.mimeType = clean(payload.mimeType, 100);
        message.size = Number(payload.size) || 0;
        if (kind === 'voice') message.duration = Number(payload.duration) || 0;
        if (kind === 'image' || kind === 'gif') {
          message.width = Number(payload.width) || 0;
          message.height = Number(payload.height) || 0;
        }
      }

      if (kind === 'text' && !message.text) return typeof ack === 'function' && ack({ ok: false });

      pushMessage(room, message);
      io.to(room.code).emit('message', message);
      if (typeof ack === 'function') ack({ ok: true, id: message.id });
    });

    socket.on('chat:typing', (isTyping) => {
      const room = code ? getRoom(code) : null;
      const author = me();
      if (!room || !author) return;
      socket.to(room.code).emit('chat:typing', { id: socket.id, name: author.name, isTyping: Boolean(isTyping) });
    });

    socket.on('chat:seen', ({ messageTs } = {}) => {
      const room = code ? getRoom(code) : null;
      const author = me();
      if (!room || !author) return;
      author.lastSeenMessage = Number(messageTs) || nowMs();
      socket.to(room.code).emit('chat:seen', { id: socket.id, name: author.name, at: author.lastSeenMessage });
    });

    socket.on('chat:react', ({ messageId, emoji } = {}) => {
      const room = code ? getRoom(code) : null;
      const author = me();
      if (!room || !author) return;
      io.to(room.code).emit('chat:react', {
        messageId: clean(messageId, 64),
        emoji: clean(emoji, 8),
        by: author.name,
        byId: socket.id,
      });
    });

    // Floating hearts / reactions over the player.
    socket.on('room:reaction', ({ emoji } = {}) => {
      const room = code ? getRoom(code) : null;
      const author = me();
      if (!room || !author) return;
      io.to(room.code).emit('room:reaction', { emoji: clean(emoji, 8), by: author.name, byId: socket.id });
    });

    /* ---------------- WebRTC signalling ---------------- */

    socket.on('rtc:signal', ({ to, data } = {}) => {
      if (!code || !to) return;
      const room = getRoom(code);
      if (!room || !room.members.has(to)) return;
      io.to(to).emit('rtc:signal', { from: socket.id, data });
    });

    socket.on('rtc:state', (state = {}) => {
      const room = code ? getRoom(code) : null;
      const author = me();
      if (!room || !author) return;
      author.media = {
        mic: Boolean(state.mic),
        cam: Boolean(state.cam),
        screen: Boolean(state.screen),
        inCall: Boolean(state.inCall),
      };
      io.to(room.code).emit('rtc:state', { id: socket.id, media: author.media });
    });

    socket.on('rtc:call', ({ mode } = {}) => {
      const room = code ? getRoom(code) : null;
      const author = me();
      if (!room || !author) return;
      socket.to(room.code).emit('rtc:call', {
        from: socket.id,
        name: author.name,
        mode: mode === 'video' ? 'video' : 'audio',
      });
    });

    socket.on('rtc:hangup', () => {
      const room = code ? getRoom(code) : null;
      if (!room) return;
      socket.to(room.code).emit('rtc:hangup', { from: socket.id });
    });

    /* ---------------- teardown ---------------- */

    socket.on('disconnect', () => {
      const room = code ? getRoom(code) : null;
      if (!room) return;
      room.lobby.delete(socket.id);
      const gone = room.members.get(socket.id);
      room.members.delete(socket.id);

      if (gone) {
        socket.to(room.code).emit('peer:left', { id: socket.id });
        systemMessage(io, room, `${gone.name} left the room`);
      }
      // Hand the crown to whoever has been here longest.
      if (room.hostId === socket.id) {
        const next = [...room.members.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
        room.hostId = next ? next.id : null;
        if (next) systemMessage(io, room, `${next.name} is now the host`);
      }
      broadcastPresence(io, room);
      if (room.members.size === 0) scheduleReap(room);
    });
  });

  server.listen(port, hostname, () => {
    // eslint-disable-next-line no-console
    console.log(`\n  ✦ CineVerse ready on http://localhost:${port}  (${dev ? 'development' : 'production'})\n`);
  });
});
