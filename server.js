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
const crypto = require('crypto');
const next = require('next');
const { Server } = require('socket.io');
const { createStorage } = require('./server/storage');
const { handleUploadRequest, rejectUploadRequest } = require('./server/uploads-http');
const { verifyUploadToken } = require('./server/uploads');
const { finalizeUpload } = require('./server/uploads-finalize');
const { createUploadRuntimeConfig } = require('./server/uploads-multipart');
const { createUploadIntent } = require('./server/uploads-intent');
const { getUploadAvailability } = require('./server/upload-availability');
const { createUploadSessionRegistry } = require('./server/uploads-sessions');
const { UPLOAD_CONTRACT, registerUploadSocketHandlers, runExpirySweep } = require('./server/uploads-contract');
const { validateRtcSignal } = require('./server/rtc');
const { chooseSuccessor } = require('./server/succession');
const { buildSecurityHeaders } = require('./server/headers');
const { validateConfig, reportConfig } = require('./server/config');
const {
  createLifecycle,
  healthResponse,
  readinessResponse,
  closeQuietly,
  runShutdown,
  describeFatal,
} = require('./server/lifecycle');
const {
  reconnectGraceMs,
  newMemberId,
  canReclaimSeat,
  shouldFinalizeDisconnect,
  isSeatKicked,
} = require('./server/seats');
const {
  IP_BUDGET_MULTIPLIER,
  buildRuntimePolicy,
  createRateLimiter,
  socketClientIp,
  isLoopbackIp,
} = require('./server/rate-limit');
const {
  attachmentMaxBytes,
  historyMaxBytes,
  realtimeMaxBufferBytes,
  validateAttachment,
  attachmentCost,
  pushMessageBounded,
} = require('./server/chat-limits');

const dev = process.env.NODE_ENV !== 'production';
const hostname = process.env.HOST || '0.0.0.0';
const port = parseInt(process.env.PORT || '3000', 10);

/* --------------------------------------------------------------------------
   Configuration check, before anything is allocated.

   Fail fast in production: booting on a broken config is worse than not
   booting, because the failure mode is silent (a partial S3 config quietly
   serves from the dev filesystem and loses every upload on redeploy). In
   development the same problems are printed but not fatal, so a fresh clone
   with no .env still runs.
   -------------------------------------------------------------------------- */
{
  const report = validateConfig(process.env, { production: !dev });
  if (report.warnings.length || report.errors.length) {
    // eslint-disable-next-line no-console
    console.log('\n  ✦ CineVerse configuration');
    reportConfig(report);
  }
  if (!report.ok) {
    if (!dev) {
      // eslint-disable-next-line no-console
      console.error('\n  Refusing to start with an invalid configuration.\n');
      process.exit(1);
    }
    // eslint-disable-next-line no-console
    console.warn('  (development: continuing anyway)\n');
  }
}

/* --------------------------------------------------------------------------
   Shared uploads for local files.

   Storage is chosen from the environment (S3-compatible when configured, a
   dev-only filesystem adapter otherwise). The signing secret never leaves the
   server; without UPLOAD_SECRET it is random per boot, which is correct for
   ephemeral rooms — tokens simply do not survive a restart.
   -------------------------------------------------------------------------- */
const storage = createStorage();
const uploadSecret = process.env.UPLOAD_SECRET || crypto.randomBytes(32).toString('hex');

/*
 * THE upload configuration - derived once, frozen, and the only thing any
 * upload path consults. `effectiveMaxBytes` is what the runtime actually
 * honours: without object storage it is the local ceiling, never the requested
 * maximum, so the process can never advertise a size it would reject.
 */
/*
 * Object storage is DERIVED from the adapter the environment selected, not from a
 * second read of the S3 env: `direct` + `multipart` is exactly what an
 * object-storage adapter advertises (S3 and the test mock both do; the dev
 * filesystem adapter does not). That keeps the runtime config and the running
 * adapter from ever disagreeing about whether a bucket is present.
 */
const objectStorageAvailable = storage.direct === true && storage.multipart === true;

/*
 * Whether hosted (shared) uploads are available on THIS deployment. In production
 * this is false unless a real S3 bucket + a strong UPLOAD_SECRET + an explicit
 * MAX_UPLOAD_BYTES are all configured — the dev filesystem adapter is never used
 * for real user videos. It gates `upload:intent` (see createUploadIntent) AND is
 * surfaced in the room snapshot so the picker can say "not available in this demo"
 * before a file is chosen. Mode/enabled only — no secret is ever echoed.
 */
const uploadAvailability = getUploadAvailability(process.env);
console.log(`[cineverse] hosted uploads ${uploadAvailability.enabled ? 'ENABLED' : 'DISABLED'} (mode: ${uploadAvailability.mode})`);

/*
 * A TEST-ONLY single-shot ceiling override, honoured only under the same
 * NODE_ENV=test + UPLOAD_TEST_MODE gate that selects the mock bucket. It lets a
 * small legal fixture route to multipart in a real browser without a 3 GB file.
 * It can only ever LOWER the ceiling (createUploadRuntimeConfig clamps it).
 */
const testSingleShot =
  process.env.NODE_ENV === 'test' && process.env.UPLOAD_TEST_MODE
    ? Number(process.env.UPLOAD_TEST_SINGLE_SHOT_MAX_BYTES) || undefined
    : undefined;

const uploadConfig = Object.freeze({
  ...createUploadRuntimeConfig(process.env, {
    // Readiness is DERIVED, not asserted: object storage + a strong stable secret +
    // an adapter that really can do multipart + a COMPLETE socket contract. The
    // contract is the frozen descriptor of the events `registerUploadSocketHandlers`
    // attaches below; a build that dropped a handler yields an incomplete descriptor
    // and multipart is reported unavailable, rather than a bare boolean claiming a
    // transport nothing answers. scripts/uploads-contract.test.mjs proves the
    // descriptor matches what is actually registered.
    storage,
    objectStorage: objectStorageAvailable,
    contract: UPLOAD_CONTRACT,
    singleShotMaxBytes: testSingleShot,
  }).config,
  // The deployment-level on/off switch (see uploadAvailability above). Folded onto
  // the frozen runtime config so the ONE object every upload path already consults
  // also carries enablement — createUploadIntent refuses on an explicit `false`.
  uploadsEnabled: uploadAvailability.enabled,
});

/*
 * Active multipart sessions. Coordination only — the signed token says what a
 * caller may do and the provider says what has landed. This is what lets the
 * server bound concurrent uploads and abort the right sessions when a member is
 * kicked or a room closes. Raw tokens are never stored (SHA-256 keys).
 */
const uploadSessions = createUploadSessionRegistry({
  maxPerMember: uploadConfig.maxActivePerMember,
  maxPerRoom: uploadConfig.maxActivePerRoom,
});

/* Startup log copy. Says so out loud when the configured ceiling is not the
   one in force, rather than printing a limit nothing will honour. */
const mb = (bytes) => `${Math.round(bytes / 1024 / 1024)}MB`;
const uploadLimitLabel = [
  `configured ${mb(uploadConfig.configuredMaxBytes)}`,
  `active single-request ${mb(uploadConfig.singleShotMaxBytes)}`,
  uploadConfig.multipartEnabled
    ? `multipart ${mb(uploadConfig.multipartMaxBytes)}`
    : `multipart unavailable (${uploadConfig.multipartReadiness.reason})`,
].join(' | ');
const UPLOAD_TTL_MS = (Number(process.env.UPLOAD_TTL_HOURS) > 0 ? Number(process.env.UPLOAD_TTL_HOURS) : 6) * 3600_000;

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();

// Readiness + shutdown state. Created before boot so the fatal-error handlers
// below can begin a shutdown even if `app.prepare()` itself blows up.
const lifecycle = createLifecycle();

/* ==========================================================================
   Room model
   ========================================================================== */

/**
 * @typedef {Object} Member
 * @property {string} id            STABLE member/seat id — survives reconnects
 * @property {string} socketId      current live transport id (changes on refresh)
 * @property {string} seatId        client-held secret proving ownership of the seat
 * @property {string} name
 * @property {string} color         deterministic accent for avatars/bubbles
 * @property {boolean} isHost
 * @property {number} joinedAt
 * @property {boolean} connected    false while inside the reconnect grace window
 * @property {number|null} disconnectedAt
 * @property {NodeJS.Timeout|null} graceTimer
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
// How long an empty room lingers before it is reaped, so a room survives
// everyone briefly dropping out. Configurable only so the soak test can prove
// that reaping actually happens without waiting a quarter of an hour; the
// default is the real product behaviour.
const EMPTY_ROOM_TTL = Math.max(1000, Number(process.env.ROOM_EMPTY_TTL_MS) || 15 * 60 * 1000);
// How long a member who dropped keeps their seat. A refresh reclaims it well
// inside this window, so presence never churns for a normal reload.
const RECONNECT_GRACE_MS = reconnectGraceMs();
// Abuse throttling + chat memory bounds. Both are process-local, matching the
// single-process, in-memory design of the rest of the room state.
const limiter = createRateLimiter();
const ATTACHMENT_MAX_BYTES = attachmentMaxBytes();
const HISTORY_MAX_BYTES = historyMaxBytes();
// The realtime frame allowance is DERIVED from the attachment limit rather than
// written down separately, so the two cannot drift: every attachment the app
// accepts is guaranteed to fit through the transport, and a slightly oversized
// one still reaches the handler to be answered with TOO_LARGE.
const REALTIME_MAX_BUFFER_BYTES = realtimeMaxBufferBytes(ATTACHMENT_MAX_BYTES);
// How long the active controller may go silent (while the room is playing)
// before its heartbeats stop being trusted and a deterministic fallback member
// may take over. Explicit sync:control always wins over fallback promotion.
const CONTROLLER_TTL = 12_000;
/**
 * Minimum gap between ORDINARY shared-upload progress broadcasts, per member.
 *
 * A 3 GB upload reports progress continuously; relaying every tick would spend
 * realtime budget on a number changing faster than anyone can read. State
 * transitions (paused, retrying, reconnecting, finalizing) bypass this — those
 * are the updates a partner actually needs promptly.
 */
const UPLOAD_PROGRESS_THROTTLE_MS = 2000;

const AVATAR_COLORS = [
  '#8b5cf6', '#22d3ee', '#3b6cf6', '#f472b6',
  '#34d399', '#fbbf24', '#fb7185', '#a78bfa',
];

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f]", "g");
const clean = (v, max = 200) => String(v ?? '').replace(CONTROL_CHARS, '').trim().slice(0, max);
const nowMs = () => Date.now();

/* --------------------------------------------------------------------------
   YouTube source normalization (defensive mirror of src/lib/media.ts).
   No network access: purely parses a URL/ID. Keeps rooms storing a canonical
   { type:'youtube', value:'<videoId>' } even if a client sends a full URL.
   -------------------------------------------------------------------------- */
const YT_BARE_ID = /^[\w-]{11}$/;
const YT_URL_PATTERNS = [
  /(?:youtube\.com\/watch\?(?:.*&)?v=)([\w-]{11})/i,
  /(?:youtu\.be\/)([\w-]{11})/i,
  /(?:youtube\.com\/embed\/)([\w-]{11})/i,
  /(?:youtube\.com\/shorts\/)([\w-]{11})/i,
  /(?:youtube\.com\/live\/)([\w-]{11})/i,
  /(?:youtube\.com\/v\/)([\w-]{11})/i,
];
function extractYouTubeId(value) {
  const s = String(value || '').trim();
  if (YT_BARE_ID.test(s)) return s;
  for (const p of YT_URL_PATTERNS) {
    const m = s.match(p);
    if (m) return m[1];
  }
  return null;
}
const looksYouTube = (value) => /(?:youtube\.com|youtu\.be)/i.test(String(value || ''));

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
    lightsMode: 'on', // shared cinema ambience: 'on' | 'off'
    hostId: null,
    source: opts.source || null,
    playing: false,
    time: 0,
    updatedAt: nowMs(),
    rate: 1,
    // Deterministic playback authority. The controller is whoever issued the
    // latest explicit control; only the controller's heartbeats are trusted, and
    // only when they carry the current control epoch (controlSeq + sourceVersion).
    controllerId: null,
    controlSeq: 0,
    sourceVersion: 0,
    lastControlAt: nowMs(),
    lastControllerReportAt: 0,
    // Keyed by STABLE memberId, not socket id — that is what lets a refresh
    // reclaim the same seat instead of arriving as a new participant.
    members: new Map(),
    // seatId (client-held secret) -> memberId. The seat token is the proof of
    // ownership on reconnect; it is never broadcast to the room.
    seats: new Map(),
    // Seats the host kicked. Tombstoned for the room's life so the stable
    // identity can't be used to walk back in past a kick.
    kickedSeats: new Set(),
    lobby: new Map(),
    // memberId -> the SAFE progress payload for that member's active upload.
    // Secret-free by construction (see buildRoomProgress) so it can go straight
    // into a room snapshot for a member who joins mid-upload.
    uploadProgress: new Map(),
    messages: [],
    // Running total of the history's in-memory footprint, so attachments are
    // bounded by BYTES as well as by message count.
    messageBytes: 0,
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

/**
 * The room's view of its members. Exposes the STABLE member id and never the
 * socket id or the secret seat token — RTC routing is mapped server-side, so
 * clients never need transport ids.
 */
function publicMembers(room) {
  return [...room.members.values()].map((m) => ({
    id: m.id,
    name: m.name,
    color: m.color,
    isHost: m.id === room.hostId,
    joinedAt: m.joinedAt,
    connected: m.connected,
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
      lightsMode: room.lightsMode === 'off' ? 'off' : 'on',
    },
    // Active shared uploads, so a member who joins mid-upload sees the same
    // partner progress everyone else already has. Nothing secret is in here.
    uploads: [...room.uploadProgress.values()],
    // Whether this deployment accepts hosted uploads at all, so the source picker
    // can show "not available in this demo" up front instead of only discovering it
    // when a chosen file is rejected. Enabled + mode only — no secret, no config.
    uploadAvailability: { enabled: uploadAvailability.enabled, mode: uploadAvailability.mode },
    history: room.messages.slice(-60),
  };
}

/* --------------------------------------------------------------------------
   Shared-upload progress + session lifecycle.

   Progress is room state, not a fire-and-forget event: a member joining
   mid-upload must see it, and it must be CLEARED on every exit path or the room
   keeps showing a phantom upload nobody can cancel.
   -------------------------------------------------------------------------- */

/** Broadcast one member's upload progress and remember it for the snapshot. */
function publishUploadProgress(io, room, progress) {
  room.uploadProgress.set(progress.memberId, progress);
  io.to(room.code).emit('upload:progress', progress);
}

/** Forget and un-broadcast a member's upload progress. */
function clearUploadProgress(io, room, memberId) {
  if (!room.uploadProgress.delete(memberId)) return;
  io.to(room.code).emit('upload:progress', { memberId, cleared: true });
}

/**
 * Best-effort abort of provider multipart sessions.
 *
 * Fire-and-forget on purpose: the callers are synchronous room-lifecycle
 * functions (a kick, a grace expiry, a room close) and none of them should wait
 * on a bucket round-trip. A failure here is survivable — the bucket's
 * incomplete-multipart lifecycle rule is the real backstop — but leaving the
 * session registered is not, so the registry entry is already gone by now.
 */
function abortSessionsQuietly(list) {
  if (!list.length || typeof storage.abortMultipartUpload !== 'function') return;
  for (const session of list) {
    Promise.resolve()
      .then(() => storage.abortMultipartUpload({ key: session.key, uploadId: session.uploadId }))
      .catch(() => {});
  }
}

function broadcastPresence(io, room) {
  io.to(room.code).emit('presence', {
    members: publicMembers(room),
    lobby: publicLobby(room),
    hostId: room.hostId,
  });
}

/**
 * Append to the room's history, evicting oldest entries until BOTH the message
 * count and the byte budget hold. Count alone let a handful of multi-megabyte
 * data-URL attachments pin hundreds of MB in this process.
 */
function pushMessage(room, message) {
  pushMessageBounded(room, message, { maxMessages: MAX_HISTORY, maxBytes: HISTORY_MAX_BYTES });
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
   Membership + authorization
   --------------------------------------------------------------------------
   `socket.data.roomCode` is the server's record of the single room a connection
   is an APPROVED member of. `room.members` is the matching per-room record.
   Authorization is always the live intersection of the two — never a cached
   boolean, and never Socket.IO channel membership alone (a kicked socket can
   linger in a channel; it must not linger in `room.members`).
   ========================================================================== */

const ackWith = (ack, payload) => {
  if (typeof ack === 'function') ack(payload);
};

/* --------------------------------------------------------------------------
   Rate limiting helpers.

   Limits are always applied AFTER authorization and BEFORE any mutation or
   broadcast, so a throttled event has no side effects at all. Room-scoped
   limits key on the STABLE member id, not the socket id — otherwise a refresh
   would reset every abuse counter.
   -------------------------------------------------------------------------- */

/** Pre-admission limit: per-socket (primary) AND, more generously, per-IP. */
function limitPreAdmission(socket, policy, cost = 1) {
  const now = nowMs();
  const perSocket = limiter.consume({ key: `socket:${socket.id}:${policy.name}`, policy, cost, now });
  if (!perSocket.ok) return perSocket;

  // Loopback is exempt — behind a same-host reverse proxy without
  // RATE_LIMIT_TRUST_PROXY, every user looks like 127.0.0.1 and a shared bucket
  // would throttle the entire deployment. Per-socket limits still hold.
  const ip = socketClientIp(socket);
  if (isLoopbackIp(ip)) return perSocket;

  // Backstop against one host opening many sockets — sized well above the
  // per-socket budget so ordinary NAT/household sharing is never throttled.
  return limiter.consume({
    key: `ip:${ip}:${policy.name}`,
    policy: {
      ...policy,
      capacity: policy.capacity * IP_BUDGET_MULTIPLIER,
      refillTokens: policy.refillTokens * IP_BUDGET_MULTIPLIER,
    },
    cost,
    now,
  });
}

/** Room-scoped limit for an approved member; optionally also a whole-room cap. */
function limitMember(ctx, policy, cost = 1, roomCostMultiplier = 0) {
  const now = nowMs();
  const verdict = limiter.consume({
    key: `member:${ctx.room.code}:${ctx.member.id}:${policy.name}`,
    policy,
    cost,
    now,
  });
  if (!verdict.ok || !roomCostMultiplier) return verdict;
  // Stops many members collectively exhausting one room's expensive operations.
  return limiter.consume({
    key: `room:${ctx.room.code}:${policy.name}`,
    policy: {
      ...policy,
      capacity: policy.capacity * roomCostMultiplier,
      refillTokens: policy.refillTokens * roomCostMultiplier,
    },
    cost,
    now,
  });
}

const rateLimitedAck = (ack, verdict) =>
  ackWith(ack, { ok: false, error: 'RATE_LIMITED', retryAfterMs: verdict.retryAfterMs });

// Named policies, with the attachment bucket sized to the configured file
// limit so a valid attachment is never permanently unsendable. The upload buckets
// are relaxed ONLY under the mock-bucket test flag (never production), so the
// high-cycle browser stress gate is not throttled by the tight per-minute budgets.
const relaxUploadLimits = process.env.NODE_ENV === 'test' && process.env.UPLOAD_TEST_MODE ? 1000 : 1;
const POLICY = buildRuntimePolicy(ATTACHMENT_MAX_BYTES, { relaxUpload: relaxUploadLimits });

// TEST-ONLY: a count of one-shot upload:abort refusals to inject, armed via
// POST /__test__/abort-fault. Inert unless the mock-bucket test gate is on.
let testAbortFaults = 0;
const consumeAbortFault =
  relaxUploadLimits > 1
    ? () => {
        if (testAbortFaults > 0) {
          testAbortFaults -= 1;
          return true;
        }
        return false;
      }
    : undefined;

// TEST-ONLY: a count of one-shot BARE completion failures (a client-terminal code
// with no server classification), armed via POST /__test__/complete-fault. Lets a
// browser test exercise the CLIENT-origin terminal cleanup path.
let testCompleteFaults = 0;
const consumeCompleteFault =
  relaxUploadLimits > 1
    ? () => {
        if (testCompleteFaults > 0) {
          testCompleteFaults -= 1;
          return true;
        }
        return false;
      }
    : undefined;

/**
 * The room + member this socket is currently an approved participant of, or null.
 *
 * Authorization is the LIVE intersection: the room exists, the socket claims a
 * member id, that member is still in the room, the member's current transport is
 * THIS socket, and the member is connected. A stale member id alone authorizes
 * nothing — so an old socket that dropped (and is inside its grace window)
 * cannot act, and neither can a socket whose seat was reclaimed by a newer tab.
 */
function memberContext(socket) {
  const roomCode = socket.data.roomCode;
  const room = roomCode ? getRoom(roomCode) : null;
  if (!room) return null;
  const memberId = socket.data.memberId;
  if (!memberId) return null;
  const member = room.members.get(memberId);
  if (!member) return null;
  if (member.socketId !== socket.id) return null;
  if (!member.connected) return null;
  return { room, member };
}

/** As memberContext, but only when this socket is also the room's current host. */
function hostContext(socket) {
  const ctx = memberContext(socket);
  if (!ctx || ctx.room.hostId !== ctx.member.id) return null;
  return ctx;
}

/** The live socket for a member, if they are connected. */
function socketForMember(io, member) {
  if (!member || !member.connected) return null;
  return io.sockets.sockets.get(member.socketId) || null;
}

/**
 * Move a socket into a room as an approved member. The single admission path,
 * used both for a direct join and for a host-approved lobby admission, so the
 * two can never drift apart.
 */
function admitSocket(io, socket, room, name, seatId) {
  socket.leave(`${room.code}:lobby`);
  room.lobby.delete(socket.id);
  socket.join(room.code);
  if (room.reaper) {
    clearTimeout(room.reaper);
    room.reaper = null;
  }

  const memberId = newMemberId();
  const color = AVATAR_COLORS[room.members.size % AVATAR_COLORS.length];
  room.members.set(memberId, {
    id: memberId,
    socketId: socket.id,
    seatId: seatId || null,
    name,
    color,
    isHost: false,
    joinedAt: nowMs(),
    connected: true,
    disconnectedAt: null,
    graceTimer: null,
    media: { mic: false, cam: false, screen: false, inCall: false },
    lastSeenMessage: 0,
  });
  if (seatId) room.seats.set(seatId, memberId);

  socket.data.roomCode = room.code;
  socket.data.memberId = memberId;
  socket.data.seatId = seatId || null;
  socket.data.pendingCode = null;

  if (!room.hostId || !room.members.has(room.hostId)) room.hostId = memberId;

  broadcastPresence(io, room);
  systemMessage(io, room, `${name} joined the room`);
  // Tell the people already inside so they can open WebRTC offers if a call runs.
  socket.to(room.code).emit('peer:joined', { id: memberId, name, color });
  return memberId;
}

/**
 * Reattach a NEW socket to an existing seat after a refresh or a network blip.
 *
 * This is deliberately quiet: no "joined" message, no host change, no colour or
 * joinedAt reset, and no waiting-room round trip — from the room's point of view
 * nothing happened, which is exactly the point. Any older socket still holding
 * the seat is evicted first so only one transport can act as this member.
 */
function reclaimSeat(io, socket, room, member, name) {
  // Cancel the pending removal from the disconnect that started the grace window.
  if (member.graceTimer) {
    clearTimeout(member.graceTimer);
    member.graceTimer = null;
  }
  if (room.reaper) {
    clearTimeout(room.reaper);
    room.reaper = null;
  }

  // A different socket may still be attached (e.g. a second tab racing, or a
  // half-open connection). Detach it so `memberContext` only ever authorizes one.
  const previous = member.socketId && member.socketId !== socket.id
    ? io.sockets.sockets.get(member.socketId)
    : null;
  if (previous) {
    previous.leave(room.code);
    previous.data.roomCode = null;
    previous.data.memberId = null;
  }

  socket.leave(`${room.code}:lobby`);
  room.lobby.delete(socket.id);
  socket.join(room.code);

  member.socketId = socket.id;
  member.connected = true;
  member.disconnectedAt = null;
  // A returning member may have edited their display name in the meantime.
  if (name) member.name = name;

  socket.data.roomCode = room.code;
  socket.data.memberId = member.id;
  socket.data.seatId = member.seatId;
  socket.data.pendingCode = null;

  // Presence still refreshes so peers see `connected` flip back to true.
  broadcastPresence(io, room);
  return member.id;
}

/**
 * End a room session and evict anyone still waiting in its lobby. Called when
 * the final approved member leaves a room that still has pending guests: with no
 * host left to approve them, the session is over. A lobby entry is NEVER
 * promoted to member or host — the room is closed and deleted instead, so it
 * cannot later be reclaimed by a guest walking into the now-empty room.
 */
function closeRoom(io, room) {
  for (const socketId of room.lobby.keys()) {
    const pending = io.sockets.sockets.get(socketId);
    if (!pending) continue;
    pending.leave(`${room.code}:lobby`);
    // Only clear the socket's room state if it still points at THIS room.
    if (pending.data.pendingCode === room.code) pending.data.pendingCode = null;
    if (pending.data.roomCode === room.code) pending.data.roomCode = null;
    pending.emit('room:closed', { code: room.code });
  }
  room.lobby.clear();
  // The session is over: nobody remains who could resume an upload, so every
  // registered provider session is aborted rather than left half-written.
  abortSessionsQuietly(uploadSessions.takeForRoom(room.code));
  room.uploadProgress.clear();
  if (room.reaper) {
    clearTimeout(room.reaper);
    room.reaper = null;
  }
  // Never leave a grace timer pointing at a deleted room.
  room.members.forEach((m) => {
    if (m.graceTimer) clearTimeout(m.graceTimer);
  });
  rooms.delete(room.code);
}

/**
 * The deterministic fallback controller for a room: the host if still present,
 * otherwise the oldest approved member. Never a lobby/pending socket. Used when
 * the active controller leaves or goes stale.
 */
function fallbackController(room) {
  // Prefer a CONNECTED member — someone inside their reconnect grace window
  // cannot report a playhead, so handing them control would stall the room.
  const host = room.hostId ? room.members.get(room.hostId) : null;
  if (host && host.connected) return host.id;
  const oldest = [...room.members.values()]
    .filter((m) => m.connected)
    .sort((a, b) => a.joinedAt - b.joinedAt)[0];
  return oldest ? oldest.id : null;
}

/**
 * The one way a socket leaves whatever room or lobby it currently belongs to.
 * Used for voluntary room switching, disconnect and kicking. Idempotent: once
 * the socket's room state is cleared the next call is a no-op, so departure
 * events are never emitted twice.
 *
 * @param {object} [opts]
 * @param {string|false} [opts.systemText] Departure notice; false to stay silent.
 */
/**
 * Remove a member for good. This is the ONLY place a seat is actually given up —
 * an explicit leave, a kick, a room switch, or an expired reconnect grace.
 * Everything the room needs to hear about a departure happens exactly once here.
 */
function finalizeRemoval(io, room, member, opts = {}) {
  if (member.graceTimer) {
    clearTimeout(member.graceTimer);
    member.graceTimer = null;
  }
  room.members.delete(member.id);
  if (member.seatId) room.seats.delete(member.seatId);

  /*
   * The seat is gone for good, so any upload it owned is unresumable: the
   * session token is bound to this stable member id, and nobody else can
   * authorize it. Abort the provider session rather than leaving a partial
   * multipart upload accruing storage, and clear the progress so the room stops
   * showing an upload with no owner.
   *
   * This is the LEAVE/KICK/GRACE-EXPIRY path. A temporary disconnect goes
   * through beginReconnectGrace instead, which deliberately keeps the session.
   */
  abortSessionsQuietly(uploadSessions.takeForMember(room.code, member.id));
  clearUploadProgress(io, room, member.id);

  // The departing socket has already left the channel, so this reaches the rest.
  // `reason: 'left'` is the seat being given up for good — the call layer may
  // end the call. A dropped transport says 'transport' instead (see
  // beginReconnectGrace), because that peer is coming back.
  io.to(room.code).emit('peer:left', { id: member.id, reason: 'left' });
  const text = 'systemText' in opts ? opts.systemText : `${member.name} left the room`;
  if (text) systemMessage(io, room, text);

  // Hand the crown to a connected member, preferring whoever has been here
  // longest. The rule lives in server/succession.js so it can be asserted
  // directly instead of only through a timing-sensitive end-to-end check.
  if (room.hostId === member.id) {
    const nextId = chooseSuccessor(room, member.id);
    room.hostId = nextId;
    const next = nextId ? room.members.get(nextId) : null;
    if (next) systemMessage(io, room, `${next.name} is now the host`);
  }
  // If the active playback controller left, hand control to the deterministic
  // fallback (host, else oldest member) rather than trusting whoever reports next.
  if (room.controllerId === member.id) {
    room.controllerId = fallbackController(room);
    room.lastControllerReportAt = 0;
  }

  // With no approved members left, either close the room (when guests are still
  // waiting — they must never inherit a hostless room) or hold it briefly so a
  // dropped viewer can reconnect into it.
  if (room.members.size === 0 && room.lobby.size > 0) {
    closeRoom(io, room);
    return;
  }
  broadcastPresence(io, room);
  if (room.members.size === 0) scheduleReap(room);
}

/**
 * Immediate departure: explicit leave, kick, or a switch to another room. The
 * seat is given up right away — no grace. (A dropped connection goes through
 * `beginReconnectGrace` instead, so a refresh keeps its seat.)
 */
function departRoom(io, socket, opts = {}) {
  const roomCode = socket.data.roomCode || socket.data.pendingCode;
  const memberId = socket.data.memberId;
  // Clear the socket's own room state up front so a re-entrant call short-circuits.
  socket.data.roomCode = null;
  socket.data.pendingCode = null;
  socket.data.memberId = null;

  if (!roomCode) return null;
  const room = getRoom(roomCode);
  if (!room) return null;

  const wasPending = room.lobby.delete(socket.id);
  socket.leave(room.code);
  socket.leave(`${room.code}:lobby`);

  const member = memberId ? room.members.get(memberId) : null;
  // Only the CURRENT transport for a seat may surrender it: a socket that was
  // already superseded by a reclaim must not remove the seat it no longer owns.
  if (!member || member.socketId !== socket.id) {
    if (wasPending) broadcastPresence(io, room);
    if (room.members.size === 0 && room.lobby.size === 0) scheduleReap(room);
    return null;
  }

  finalizeRemoval(io, room, member, opts);
  return { room, member };
}

/**
 * A socket dropped (refresh, tab close, network blip). Hold the seat instead of
 * removing it: no "left" message, no host handoff, no room close. If a socket
 * returns with the same seat token inside the window it reclaims everything; if
 * the window expires, the member is removed exactly once.
 *
 * `peer:left` IS emitted — that is WebRTC transport cleanup (their peer
 * connection really is gone), and it is deliberately separate from presence,
 * which keeps the member listed as `connected: false`.
 */
function beginReconnectGrace(io, socket) {
  const roomCode = socket.data.roomCode || socket.data.pendingCode;
  const memberId = socket.data.memberId;
  socket.data.roomCode = null;
  socket.data.pendingCode = null;
  socket.data.memberId = null;

  if (!roomCode) return;
  const room = getRoom(roomCode);
  if (!room) return;

  const wasPending = room.lobby.delete(socket.id);
  socket.leave(room.code);
  socket.leave(`${room.code}:lobby`);

  const member = memberId ? room.members.get(memberId) : null;
  if (!member || member.socketId !== socket.id) {
    // A lobby guest, or a socket already replaced by a newer one: nothing held.
    if (wasPending) broadcastPresence(io, room);
    if (room.members.size === 0 && room.lobby.size === 0) scheduleReap(room);
    return;
  }

  // Grace disabled (0) keeps the original immediate-removal behaviour.
  if (RECONNECT_GRACE_MS <= 0) {
    finalizeRemoval(io, room, member);
    return;
  }

  member.connected = false;
  member.disconnectedAt = nowMs();
  // Their media transport is gone, and a refreshing/unloading client cannot
  // reliably emit `rtc:state` false on its way out — so the server clears it
  // rather than leaving the room showing a stale "in call, mic on" indicator.
  member.media = { mic: false, cam: false, screen: false, inCall: false };

  /*
   * An upload IS held through the grace window. The whole point of a resumable
   * transport is surviving a blip: the provider keeps the parts, the token stays
   * valid, and the client calls upload:status when it reconnects. The room is
   * told the uploader is reconnecting so the partner sees why progress stopped
   * instead of watching a frozen bar.
   */
  {
    const held = room.uploadProgress.get(member.id);
    if (held && held.status !== 'reconnecting') {
      publishUploadProgress(io, room, { ...held, status: 'reconnecting' });
    }
  }

  // Playback authority is NOT held through the grace window: a disconnected
  // member cannot heartbeat, so the room's playhead would stall until the
  // controller TTL expired. The seat is kept, but control moves on now.
  if (room.controllerId === member.id) {
    room.controllerId = fallbackController(room);
    room.lastControllerReportAt = 0;
  }

  if (member.graceTimer) clearTimeout(member.graceTimer);
  member.graceTimer = setTimeout(() => {
    const live = rooms.get(room.code);
    if (!live) return;
    const current = live.members.get(member.id);
    // A reconnect inside the window flips `connected` back on — the late timer
    // from the old disconnect must then do nothing.
    if (!shouldFinalizeDisconnect({ member: current, now: nowMs(), graceMs: RECONNECT_GRACE_MS })) return;
    finalizeRemoval(io, live, current);
  }, RECONNECT_GRACE_MS);
  if (typeof member.graceTimer.unref === 'function') member.graceTimer.unref();

  // Peers tear down their (now dead) media connection; presence keeps the seat.
  // `reason: 'transport'` is what tells the call layer this is a blip, not a
  // departure: it closes that one peer connection but keeps the call up so the
  // member can be re-offered when they reclaim their seat.
  io.to(room.code).emit('peer:left', { id: member.id, reason: 'transport' });
  broadcastPresence(io, room);
}

/* ==========================================================================
   Boot
   ========================================================================== */

app.prepare().then(() => {
  // Built once — the policy depends only on the environment, and rebuilding a
  // string per request for every asset would be pure waste.
  const SECURITY_HEADERS = buildSecurityHeaders({ dev });

  const server = http.createServer((req, res) => {
    // Applied to EVERYTHING this process serves — Next routes, uploaded video
    // streams, health endpoints — so there is no unprotected path.
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);

    // Liveness and readiness are separate questions, and conflating them is how
    // a load balancer keeps routing to a process that is draining. Both answer
    // without booting React, and neither exposes room codes, names or files.
    const path = req.url ? req.url.split('?')[0] : '';
    if (path === '/healthz') {
      // Heap and bucket counts are what the soak test asserts on, and they are
      // operational detail rather than something every deployment should
      // publish — so they are opt-in, never on by default.
      const metrics =
        process.env.EXPOSE_PROCESS_METRICS === '1'
          ? { heapUsed: process.memoryUsage().heapUsed, rss: process.memoryUsage().rss, buckets: limiter.size() }
          : {};
      const { status, body } = healthResponse(lifecycle, { rooms: rooms.size, uptime: process.uptime(), ...metrics });
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
      return;
    }
    if (path === '/readyz') {
      const { status, body } = readinessResponse(lifecycle, { uptime: process.uptime() });
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
      return;
    }
    // TEST-ONLY readiness readout of the upload registry, behind the same
    // NODE_ENV=test + UPLOAD_TEST_MODE gate that selects the mock bucket (never
    // served in production). The browser stress gate reads `activeSessions` to
    // assert a churn run leaves zero sessions counting against the limits.
    if (path === '/__test__/uploads' && relaxUploadLimits > 1) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ activeSessions: uploadSessions.activeCount(), totalRecords: uploadSessions.size() }));
      return;
    }
    // TEST-ONLY: arm N one-shot upload:abort refusals, so a browser test can prove
    // the client retains its authority when a cancel is REJECTED (rate-limited).
    // Same gate; never served in production.
    if (path === '/__test__/abort-fault' && req.method === 'POST' && relaxUploadLimits > 1) {
      testAbortFaults = 1; // one-shot: the NEXT upload:abort is refused
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, armed: testAbortFaults }));
      return;
    }
    if (path === '/__test__/complete-fault' && req.method === 'POST' && relaxUploadLimits > 1) {
      testCompleteFaults = 1; // one-shot: the NEXT upload:complete fails bare
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, armed: testCompleteFaults }));
      return;
    }
    // Uploaded-video bytes. Handled before Next so the stream never enters the
    // React router; returns false for anything it does not own.
    if (req.url && req.url.startsWith('/api/uploads/')) {
      handleUploadRequest(req, res, { storage, secret: uploadSecret })
        .then((handled) => {
          if (!handled) handle(req, res);
        })
        .catch(() => {
          /*
           * An UNEXPECTED failure in the upload handler is the same
           * socket-retention hazard as every other rejection: the request may
           * still be carrying an unread multi-gigabyte body, and answering with a
           * plain keep-alive 500 leaves Node waiting for it. Route it through the
           * one bounded-close helper so the reason is delivered where deliverable,
           * the connection is closed, and a body is never drained without bound.
           */
          if (!res.writableEnded) rejectUploadRequest(req, res, 500, 'UPLOAD_ERROR');
        });
      return;
    }
    handle(req, res);
  });

  const io = new Server(server, {
    path: '/api/realtime',
    // Voice notes and shared images travel as data URLs; sized from the
    // configured attachment limit so the transport can never reject something
    // the application would have accepted.
    maxHttpBufferSize: REALTIME_MAX_BUFFER_BYTES,
    pingInterval: 10000,
    pingTimeout: 20000,
    cors: { origin: true, credentials: true },
  });

  io.on('connection', (socket) => {
    // Server-controlled room state lives on socket.data, not in closures, so
    // there is a single authority every handler reads from.
    socket.data.roomCode = null; // room this socket is an approved member of
    socket.data.pendingCode = null; // room this socket is waiting in a lobby for
    socket.data.kickedFrom = null; // rooms this live connection may not rejoin

    /* ---------------- clock sync ---------------- */
    // Round-trip probe so clients can estimate offset + latency (NTP-lite).
    socket.on('clock:ping', (clientSent, ack) => {
      // Deliberately NOT membership-gated — calibration happens before joining.
      // But it is bounded, or an unauthenticated socket could flood acks.
      const verdict = limitPreAdmission(socket, POLICY.clockPing);
      if (!verdict.ok) {
        // null, NOT a RATE_LIMITED object: calibrateClock skips a null sample
        // (`if (!reply) continue`), whereas an object without `serverTime`
        // would feed undefined into the offset maths and poison the clock.
        return ackWith(ack, null);
      }
      ackWith(ack, { clientSent, serverTime: nowMs() });
    });

    /* ---------------- room lifecycle ---------------- */

    socket.on('room:create', (payload = {}, ack) => {
      // Before any room is allocated: creation is the cheapest way to burn
      // server memory, so it is the tightest pre-admission limit.
      const verdict = limitPreAdmission(socket, POLICY.roomCreate);
      if (!verdict.ok) return rateLimitedAck(ack, verdict);
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
      ackWith(ack, { ok: true, code: newCode });
    });

    socket.on('room:probe', (payload = {}, ack) => {
      // Probing is how a room code would be brute-forced; throttle it.
      const verdict = limitPreAdmission(socket, POLICY.roomProbe);
      if (!verdict.ok) return rateLimitedAck(ack, verdict);
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
      // Per-tab, per-room secret that proves ownership of a seat across refreshes.
      const seatId = clean(payload.seatId, 64) || null;
      if (!target) return ackWith(ack, { ok: false, error: 'MISSING_CODE' });

      // Idempotent: re-joining the room we already belong to just returns the
      // current snapshot — no departure, no duplicate "joined" message.
      if (socket.data.roomCode === target && socket.data.memberId) {
        const current = getRoom(target);
        const mine = current && current.members.get(socket.data.memberId);
        if (mine && mine.socketId === socket.id) {
          return ackWith(ack, {
            ok: true,
            pending: false,
            code: target,
            memberId: mine.id,
            snapshot: roomSnapshot(current),
          });
        }
      }

      // Throttled only AFTER the idempotent same-room rejoin above, so a no-op
      // rejoin never spends a token. A genuine join (including a seat reclaim
      // after refresh) is comparatively expensive and password-guessable.
      const joinVerdict = limitPreAdmission(socket, POLICY.roomJoin);
      if (!joinVerdict.ok) return rateLimitedAck(ack, joinVerdict);

      // A live connection the host kicked may not walk straight back in.
      if (socket.data.kickedFrom && socket.data.kickedFrom.has(target)) {
        return ackWith(ack, { ok: false, error: 'KICKED' });
      }

      // First person through the door creates the room and becomes host.
      let room = getRoom(target);
      const fresh = !room;
      if (!room) room = createRoom(target, {});

      // A kicked seat stays kicked: the stable identity must not re-open the
      // hole that per-connection kick tracking closes.
      if (isSeatKicked(seatId, room.kickedSeats)) {
        return ackWith(ack, { ok: false, error: 'KICKED' });
      }

      /* ---- reclaim an existing seat (refresh / brief network drop) ---- */
      const heldMemberId = seatId ? room.seats.get(seatId) : null;
      const held = heldMemberId ? room.members.get(heldMemberId) : null;
      if (canReclaimSeat({ seatId, member: held, kickedSeats: room.kickedSeats })) {
        // Leave whatever OTHER room this socket was in first.
        if (socket.data.roomCode && socket.data.roomCode !== target) departRoom(io, socket);
        // Deliberately bypasses the lock/passphrase/waiting-room gates: this seat
        // was already admitted, and the seat token is unguessable proof of that.
        // A kick is the one thing that overrides it (checked above).
        reclaimSeat(io, socket, room, held, name);
        socket.to(room.code).emit('peer:joined', { id: held.id, name: held.name, color: held.color });
        return ackWith(ack, {
          ok: true,
          pending: false,
          reclaimed: true,
          code: target,
          memberId: held.id,
          snapshot: roomSnapshot(room),
        });
      }

      // Validate the DESTINATION before leaving the current room, so a rejected
      // join (locked / wrong passphrase) leaves the socket exactly where it was —
      // you can test another room's gate without losing your seat in this one.
      // Departure on navigation is handled explicitly by `room:leave`.
      if (room.locked && !fresh) return ackWith(ack, { ok: false, error: 'LOCKED' });
      if (room.password && clean(payload.password, 64) !== room.password) {
        return ackWith(ack, { ok: false, error: 'BAD_PASSWORD' });
      }

      // Destination accepted → now cleanly leave whatever room/lobby we were in,
      // so no stale membership, channel subscription or presence is left behind.
      if (socket.data.roomCode !== target && (socket.data.roomCode || socket.data.pendingCode)) {
        departRoom(io, socket);
      }

      // Waiting room applies to everyone except the very first arrival. A pending
      // guest is NOT a member: their entry stays keyed by socket id, and their
      // seat token is only remembered so approval can bind it to the new seat.
      if (room.waitingRoom && room.members.size > 0) {
        room.lobby.set(socket.id, { socketId: socket.id, name, at: nowMs(), seatId });
        socket.data.pendingCode = target;
        socket.data.seatId = seatId;
        socket.join(`${target}:lobby`);
        broadcastPresence(io, room);
        return ackWith(ack, { ok: true, pending: true, code: target });
      }

      const memberId = admitSocket(io, socket, room, name, seatId);
      ackWith(ack, { ok: true, pending: false, code: target, memberId, snapshot: roomSnapshot(room) });
    });

    socket.on('lobby:decide', ({ socketId, approve } = {}, ack) => {
      const ctx = hostContext(socket);
      if (!ctx) return ackWith(ack, { ok: false, error: 'UNAUTHORIZED' });
      // Admission runs admitSocket + two broadcasts, so it is a mutation like any
      // other and is throttled before it takes effect.
      const decideVerdict = limitMember(ctx, POLICY.roomMutation);
      if (!decideVerdict.ok) return rateLimitedAck(ack, decideVerdict);
      const { room } = ctx;
      const pending = room.lobby.get(socketId);
      // Already decided, gone, or never waiting — no replay. Acked so the host's
      // button stops spinning instead of waiting for a reply that never comes.
      if (!pending) return ackWith(ack, { ok: false, error: 'NOT_FOUND' });
      room.lobby.delete(socketId);
      const target = io.sockets.sockets.get(socketId);
      if (!target) {
        broadcastPresence(io, room);
        return ackWith(ack, { ok: true, gone: true });
      }
      target.leave(`${room.code}:lobby`);

      if (approve) {
        // Admission is completed entirely on the server. The guest never has to
        // — and, with lobby:enter gone, no longer can — admit itself. Their seat
        // token is bound here, so a refresh after approval reclaims the approved
        // seat instead of going back to the lobby.
        const memberId = admitSocket(io, target, room, pending.name, pending.seatId || null);
        target.emit('lobby:approved', { code: room.code, memberId, snapshot: roomSnapshot(room) });
      } else {
        target.data.pendingCode = null;
        target.emit('lobby:denied', { code: room.code });
        broadcastPresence(io, room);
      }
      ackWith(ack, { ok: true });
    });

    // Admission used to finish here on the client's say-so, which let a pending
    // or even denied guest admit itself. It is now server-driven; reject always
    // so a modified or stale client cannot use this path.
    socket.on('lobby:enter', (_payload, ack) => {
      ackWith(ack, { ok: false, error: 'UNAUTHORIZED' });
    });

    socket.on('room:settings', (patch = {}, ack) => {
      const ctx = hostContext(socket);
      if (!ctx) return ackWith(ack, { ok: false, error: 'UNAUTHORIZED' });
      const settingsVerdict = limitMember(ctx, POLICY.roomMutation);
      if (!settingsVerdict.ok) return rateLimitedAck(ack, settingsVerdict);
      const { room } = ctx;
      if ('password' in patch) room.password = patch.password ? clean(patch.password, 64) : null;
      if ('waitingRoom' in patch) room.waitingRoom = Boolean(patch.waitingRoom);
      if ('locked' in patch) room.locked = Boolean(patch.locked);
      io.to(room.code).emit('room:settings', {
        hasPassword: Boolean(room.password),
        waitingRoom: room.waitingRoom,
        locked: room.locked,
        lightsMode: room.lightsMode === 'off' ? 'off' : 'on',
      });
      systemMessage(io, room, 'Host updated the room settings');
      ackWith(ack, { ok: true });
    });

    // Shared cinema ambience — any approved member can dim the room for everyone.
    // It is not a security setting, so it is intentionally not host-gated.
    socket.on('room:lights', ({ mode } = {}, ack) => {
      const ctx = memberContext(socket);
      if (!ctx) return ackWith(ack, { ok: false, error: 'UNAUTHORIZED' });
      const { room } = ctx;
      const next = mode === 'off' ? 'off' : 'on';
      // No-op / no echo storm. Still an `ok` — the room already is what was asked
      // for, so the client has nothing to revert.
      if (room.lightsMode === next) return ackWith(ack, { ok: true, unchanged: true });
      const lightsVerdict = limitMember(ctx, POLICY.roomMutation, 1, 2);
      if (!lightsVerdict.ok) return rateLimitedAck(ack, lightsVerdict);
      room.lightsMode = next;
      io.to(room.code).emit('room:settings', {
        hasPassword: Boolean(room.password),
        waitingRoom: room.waitingRoom,
        locked: room.locked,
        lightsMode: next,
      });
      ackWith(ack, { ok: true });
    });

    // `socketId` is the STABLE member id now (the participant list sends member.id).
    socket.on('room:kick', ({ socketId: targetId } = {}, ack) => {
      const ctx = hostContext(socket);
      if (!ctx) return ackWith(ack, { ok: false, error: 'UNAUTHORIZED' });
      const { room } = ctx;
      const kickVerdict = limitMember(ctx, POLICY.roomMutation);
      if (!kickVerdict.ok) return rateLimitedAck(ack, kickVerdict);
      if (targetId === ctx.member.id) return ackWith(ack, { ok: false, error: 'SELF' });
      const victim = room.members.get(targetId);
      if (!victim) return ackWith(ack, { ok: false, error: 'NOT_FOUND' });
      const target = socketForMember(io, victim);

      // Tombstone the SEAT for this room, so reconnecting with the same seat
      // token cannot bypass the kick — the stable identity must not re-open the
      // hole that per-connection tracking closes.
      if (victim.seatId) room.kickedSeats.add(victim.seatId);

      if (target) {
        // Also block this live connection from walking straight back in.
        if (!target.data.kickedFrom) target.data.kickedFrom = new Set();
        target.data.kickedFrom.add(room.code);
        target.emit('room:kicked', { code: room.code, at: nowMs() });
        // Centralized departure revokes membership, so every subsequent room-scoped
        // event from that socket now fails the live authorization check.
        departRoom(io, target, { systemText: `${victim.name} was removed by the host` });
      } else {
        // Kicking someone who is mid-grace: remove the seat directly.
        finalizeRemoval(io, room, victim, { systemText: `${victim.name} was removed by the host` });
      }
      ackWith(ack, { ok: true });
    });

    socket.on('room:transfer-host', ({ socketId: targetId } = {}, ack) => {
      const ctx = hostContext(socket);
      if (!ctx) return ackWith(ack, { ok: false, error: 'UNAUTHORIZED' });
      if (!ctx.room.members.has(targetId)) return ackWith(ack, { ok: false, error: 'NOT_FOUND' });
      const transferVerdict = limitMember(ctx, POLICY.roomMutation);
      if (!transferVerdict.ok) return rateLimitedAck(ack, transferVerdict);
      const { room } = ctx;
      room.hostId = targetId;
      const next = room.members.get(targetId);
      systemMessage(io, room, `${next.name} is now the host`);
      broadcastPresence(io, room);
      ackWith(ack, { ok: true });
    });

    // Explicit departure the client emits when it navigates away from a room, so
    // a socket never lingers as a phantom member until it finally disconnects.
    // Idempotent, and scoped to a code so it can't clobber a concurrent join to
    // a different room: only leave if we are still in the room named.
    socket.on('room:leave', ({ code: leaveCode } = {}) => {
      const current = socket.data.roomCode || socket.data.pendingCode;
      if (!current) return;
      const target = leaveCode ? clean(leaveCode, 8).toUpperCase() : null;
      if (target && target !== current) return; // already moved on — nothing to leave
      departRoom(io, socket);
    });

    /* ==================== shared uploads ====================
       Every upload event is registered by ONE module (server/uploads-contract.js),
       which also exports the frozen UPLOAD_CONTRACT descriptor multipart readiness
       is derived from. The handlers keep only membership, rate limiting, broadcast
       and ack plumbing; every decision lives in the extracted services, so the
       tested path is the running path. Movie bytes never appear in any of it.
       ======================================================== */
    registerUploadSocketHandlers(socket, {
      io,
      storage,
      secret: uploadSecret,
      uploadConfig,
      sessions: uploadSessions,
      POLICY,
      memberContext,
      limitMember,
      ackWith,
      rateLimitedAck,
      nowMs,
      clean,
      verifyUploadToken,
      finalizeUpload,
      createUploadIntent,
      publishUploadProgress,
      clearUploadProgress,
      progressThrottleMs: UPLOAD_PROGRESS_THROTTLE_MS,
      testAbortFault: consumeAbortFault,
      testCompleteFault: consumeCompleteFault,
    });

    /* ---------------- source + playback sync ---------------- */

    socket.on('source:set', (source = {}, ack) => {
      const ctx = memberContext(socket);
      if (!ctx) return ackWith(ack, { ok: false, error: 'UNAUTHORIZED' });
      // Replacing the source resets playback for everyone, so it is capped both
      // per member and per room. Acked so a rejected change can be reverted
      // client-side instead of leaving the picker optimistically wrong.
      const verdict = limitMember(ctx, POLICY.roomMutation, 1, 2);
      if (!verdict.ok) return rateLimitedAck(ack, verdict);
      const { room, member } = ctx;

      let type = ['url', 'youtube', 'local', 'catalog'].includes(source.type) ? source.type : 'url';
      let value = clean(source.value, 2048);
      // Defensive normalization: a YouTube link (however typed) is stored as a
      // canonical youtube source keyed by video ID, never as a generic url.
      if (type === 'youtube' || (type === 'url' && looksYouTube(value))) {
        const id = extractYouTubeId(value);
        if (id) {
          type = 'youtube';
          value = id;
        } else if (type === 'youtube') {
          // Claimed YouTube but unparseable — fall back to a plain url source.
          type = 'url';
        }
      }

      room.source = {
        type,
        value,
        label: clean(source.label, 120) || 'Untitled',
        poster: source.poster ? clean(source.poster, 2048) : undefined,
        quality: source.quality ? clean(source.quality, 12) : undefined,
        variants: Array.isArray(source.variants)
          ? source.variants.slice(0, 6).map((v) => ({ label: clean(v.label, 12), value: clean(v.value, 2048) }))
          : undefined,
      };
      // A new source opens a fresh control epoch: bump the source version and
      // control sequence, make the setter the controller, and reset playback.
      room.sourceVersion += 1;
      room.controlSeq += 1;
      room.controllerId = member.id;
      room.lastControlAt = nowMs();
      room.lastControllerReportAt = 0;
      room.playing = false;
      room.time = 0;
      room.rate = 1;
      room.updatedAt = nowMs();
      io.to(room.code).emit('source:set', room.source);
      systemMessage(io, room, `${member.name} put on “${room.source.label}”`);
      ackWith(ack, { ok: true });
    });

    /**
     * A control event carries the initiator's playhead AND their clock reading.
     * Peers apply it relative to their own measured offset, so a 300ms link
     * doesn't turn into a 300ms desync.
     */
    socket.on('sync:control', (payload = {}, ack) => {
      const ctx = memberContext(socket);
      if (!ctx) return ackWith(ack, { ok: false, error: 'UNAUTHORIZED' });
      const { room, member } = ctx;
      const action = ['play', 'pause', 'seek', 'rate'].includes(payload.action) ? payload.action : null;
      if (!action) return ackWith(ack, { ok: false, error: 'BAD_ACTION' });
      // Generous enough for an enthusiastic scrub across the seek bar.
      const controlVerdict = limitMember(ctx, POLICY.syncControl);
      if (!controlVerdict.ok) return rateLimitedAck(ack, controlVerdict);

      // An explicit control opens the next epoch and makes this member the
      // controller — this is what lets a different member take over playback.
      room.controlSeq += 1;
      room.controllerId = member.id;
      room.lastControlAt = nowMs();
      room.lastControllerReportAt = nowMs();

      const t = Number(payload.time);
      room.time = Number.isFinite(t) && t >= 0 ? t : 0;
      room.updatedAt = nowMs();
      if (action === 'play') room.playing = true;
      if (action === 'pause') room.playing = false;
      if (action === 'rate') room.rate = Math.min(4, Math.max(0.25, Number(payload.rate) || 1));

      socket.to(room.code).emit('sync:control', {
        action,
        time: room.time,
        rate: room.rate,
        issuedAt: room.updatedAt,
        by: member.name,
        byId: member.id,
        controlSeq: room.controlSeq,
        sourceVersion: room.sourceVersion,
      });
      // The sender needs the accepted epoch so its heartbeats carry the right
      // controlSeq/sourceVersion and are trusted.
      ackWith(ack, {
        ok: true,
        controlSeq: room.controlSeq,
        sourceVersion: room.sourceVersion,
        serverTime: room.updatedAt,
      });
    });

    // Heartbeat from the ACTIVE controller only. Rejected unless it references the
    // current control epoch and comes from the controller (or the deterministic
    // fallback once the controller has gone stale). Never rewinds or pauses.
    socket.on('sync:report', (payload = {}) => {
      const ctx = memberContext(socket);
      if (!ctx) return;
      const { room, member } = ctx;
      // Periodic protocol traffic (~every 3s per client) — dropped silently.
      if (!limitMember(ctx, POLICY.syncBackground).ok) return;

      // Must reference the current source + control epoch.
      if (Number(payload.sourceVersion) !== room.sourceVersion) return;
      if (Number(payload.controlSeq) !== room.controlSeq) return;

      // Only the active controller may heartbeat. If it has gone stale (silent
      // past the TTL while playing) or left, the deterministic fallback member —
      // and only that member — may be promoted and take over. Identity is the
      // stable member id, so a controller that refreshes keeps control.
      if (member.id !== room.controllerId) {
        const controller = room.controllerId ? room.members.get(room.controllerId) : null;
        const controllerGone = !controller || !controller.connected;
        const since = room.lastControllerReportAt || room.lastControlAt;
        const stale = room.playing && nowMs() - since > CONTROLLER_TTL;
        if (!(controllerGone || stale) || member.id !== fallbackController(room)) return;
        room.controllerId = member.id;
      }

      const t = Number(payload.time);
      if (!Number.isFinite(t) || t < 0) return;

      // A buffering/stale heartbeat must never rewind the room while it plays.
      if (room.playing && t < headPosition(room) - 1.5) return;

      room.time = t;
      // Heartbeats keep the room playing; they never pause it (only sync:control
      // pause does), so an arbitrary `playing:false` report is not trusted.
      room.playing = true;
      room.updatedAt = nowMs();
      room.lastControllerReportAt = nowMs();
    });

    // An approved member asks "where should I be right now?" — drift correction.
    socket.on('sync:request', (_p, ack) => {
      const ctx = memberContext(socket);
      if (!ctx) return ackWith(ack, null);
      // Drift correction polls every ~2.5s; null (not RATE_LIMITED) keeps the
      // client's existing "no answer, try later" path working unchanged.
      if (!limitMember(ctx, POLICY.syncBackground).ok) return ackWith(ack, null);
      const { room } = ctx;
      ackWith(ack, {
        time: headPosition(room),
        playing: room.playing,
        rate: room.rate,
        serverTime: nowMs(),
        controlSeq: room.controlSeq,
        sourceVersion: room.sourceVersion,
        controllerId: room.controllerId,
      });
    });

    /* ---------------- chat ---------------- */

    socket.on('chat:send', (payload = {}, ack) => {
      const ctx = memberContext(socket);
      if (!ctx) return ackWith(ack, { ok: false, error: 'UNAUTHORIZED' });
      const { room, member: author } = ctx;

      const kind = ['text', 'image', 'gif', 'file', 'voice'].includes(payload.kind) ? payload.kind : 'text';

      // Attachments are validated and PRICED before anything is stored or
      // broadcast. Size comes from the payload itself — `payload.size` is
      // client-declared and must never drive limits or memory accounting.
      let attachment = null;
      if (kind !== 'text') {
        const data = String(payload.data || '');
        const verdict = validateAttachment(data, { maxDecodedBytes: ATTACHMENT_MAX_BYTES });
        if (!verdict.ok) return ackWith(ack, { ok: false, error: verdict.error });
        attachment = { data, ...verdict };
      }

      const policy = kind === 'text' ? POLICY.chatText : POLICY.chatAttachment;
      // One token per 256 KiB, so a big upload costs far more than chatter.
      const cost = kind === 'text' ? 1 : attachmentCost(attachment.encodedBytes);
      const limit = limitMember(ctx, policy, cost);
      if (!limit.ok) return rateLimitedAck(ack, limit);

      const message = {
        id: `m_${nowMs()}_${Math.random().toString(36).slice(2, 8)}`,
        kind,
        authorId: author.id,
        author: author.name,
        color: author.color,
        ts: nowMs(),
        text: kind === 'text' ? clean(payload.text, 2000) : clean(payload.text, 300),
        replyTo: payload.replyTo ? clean(payload.replyTo, 64) : null,
      };

      if (attachment) {
        message.data = attachment.data;
        message.fileName = clean(payload.fileName, 160);
        message.mimeType = clean(payload.mimeType, 100);
        // The SERVER's measurement, not the client's claim.
        message.size = attachment.decodedBytes;
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
      const ctx = memberContext(socket);
      if (!ctx) return;
      // Chat background traffic has its OWN bucket — typing must never spend
      // the playback protocol's budget. Dropped silently when over.
      if (!limitMember(ctx, POLICY.chatBackground).ok) return;
      socket.to(ctx.room.code).emit('chat:typing', {
        id: ctx.member.id,
        name: ctx.member.name,
        isTyping: Boolean(isTyping),
      });
    });

    socket.on('chat:seen', ({ messageTs } = {}) => {
      const ctx = memberContext(socket);
      if (!ctx) return;
      if (!limitMember(ctx, POLICY.chatBackground).ok) return;
      ctx.member.lastSeenMessage = Number(messageTs) || nowMs();
      socket.to(ctx.room.code).emit('chat:seen', {
        id: ctx.member.id,
        name: ctx.member.name,
        at: ctx.member.lastSeenMessage,
      });
    });

    socket.on('chat:react', ({ messageId, emoji } = {}) => {
      const ctx = memberContext(socket);
      if (!ctx) return;
      // Fire-and-forget: a throttled reaction is dropped silently rather than
      // nagging the user about a tap that didn't land.
      if (!limitMember(ctx, POLICY.reaction).ok) return;
      io.to(ctx.room.code).emit('chat:react', {
        messageId: clean(messageId, 64),
        emoji: clean(emoji, 8),
        by: ctx.member.name,
        byId: ctx.member.id,
      });
    });

    // Floating hearts / reactions over the player.
    socket.on('room:reaction', ({ emoji } = {}) => {
      const ctx = memberContext(socket);
      if (!ctx) return;
      // Also capped per ROOM, so several members can't collectively spam the
      // screen with floating emoji.
      if (!limitMember(ctx, POLICY.reaction, 1, 3).ok) return;
      io.to(ctx.room.code).emit('room:reaction', { emoji: clean(emoji, 8), by: ctx.member.name, byId: ctx.member.id });
    });

    /* ---------------- WebRTC signalling ---------------- */

    // `to` is a STABLE member id; the server maps it to that member's current
    // socket, so signalling keeps working across the peer's refresh.
    socket.on('rtc:signal', ({ to, data } = {}, ack) => {
      const ctx = memberContext(socket);
      if (!ctx) return ackWith(ack, { ok: false, error: 'UNAUTHORIZED' });
      if (!to || typeof to !== 'string') return ackWith(ack, { ok: false, error: 'NO_RECIPIENT' });
      // Sender and recipient must both be approved members of the same room.
      const recipient = ctx.room.members.get(to);
      if (!recipient) return ackWith(ack, { ok: false, error: 'NOT_MEMBER' });
      if (!recipient.connected) return ackWith(ack, { ok: false, error: 'PEER_OFFLINE' });
      // Relay only well-formed, bounded signalling — never arbitrary payloads.
      const verdict = validateRtcSignal(data);
      if (!verdict.ok) return ackWith(ack, { ok: false, error: verdict.error });
      // Deliberately generous: ICE candidates legitimately arrive in bursts from
      // both peers, so this catches only sustained floods.
      const rateVerdict = limitMember(ctx, POLICY.rtcSignal);
      if (!rateVerdict.ok) return rateLimitedAck(ack, rateVerdict);
      io.to(recipient.socketId).emit('rtc:signal', { from: ctx.member.id, data });
      ackWith(ack, { ok: true });
    });

    socket.on('rtc:state', (state = {}) => {
      const ctx = memberContext(socket);
      if (!ctx) return;
      if (!limitMember(ctx, POLICY.rtcCallState).ok) return;
      ctx.member.media = {
        mic: Boolean(state.mic),
        cam: Boolean(state.cam),
        screen: Boolean(state.screen),
        inCall: Boolean(state.inCall),
      };
      // Targeted rather than a full presence re-broadcast: this fires on every
      // mute/camera/screen toggle, and clients merge it into the member they
      // already hold (see `useRoom`'s rtc:state handler). The next presence —
      // join, leave, disconnect — carries the same `media` from `publicMembers`,
      // so the two can never drift.
      io.to(ctx.room.code).emit('rtc:state', { id: ctx.member.id, media: ctx.member.media });
    });

    socket.on('rtc:call', ({ mode } = {}) => {
      const ctx = memberContext(socket);
      if (!ctx) return;
      if (!limitMember(ctx, POLICY.rtcCallState).ok) return;
      socket.to(ctx.room.code).emit('rtc:call', {
        from: ctx.member.id,
        name: ctx.member.name,
        mode: mode === 'video' ? 'video' : 'audio',
      });
    });

    socket.on('rtc:hangup', () => {
      const ctx = memberContext(socket);
      if (!ctx) return;
      if (!limitMember(ctx, POLICY.rtcCallState).ok) return;
      socket.to(ctx.room.code).emit('rtc:hangup', { from: ctx.member.id });
    });

    /* ---------------- teardown ---------------- */

    socket.on('disconnect', () => {
      // A dropped transport is NOT a departure: hold the seat for the grace
      // window so a refresh reclaims it silently. Only an expired window (or an
      // explicit leave/kick) actually removes the member.
      beginReconnectGrace(io, socket);
      // Per-socket buckets die with the connection. Member/IP buckets are
      // deliberately LEFT to expire on their own TTL — otherwise reconnecting
      // would reset every abuse counter, which is exactly what stable seats and
      // IP keying exist to prevent.
      limiter.clearPrefix(`socket:${socket.id}:`);
    });
  });

  /* ---------------- rate-limiter upkeep ----------------
     Buckets refill lazily and carry a TTL, so this only reclaims memory for
     keys nobody has touched. unref'd: never a reason to hold the process open. */
  const limiterSweeper = setInterval(() => limiter.sweep(nowMs()), 2 * 60 * 1000);
  if (typeof limiterSweeper.unref === 'function') limiterSweeper.unref();
  const ownedTimers = [limiterSweeper];

  /* ---------------- upload session expiry ----------------
     Makes session expiry OBSERVABLE. An abandoned upload (client crashed, tab
     closed without a clean abort) leaves an active session whose token will
     eventually expire; this timer tombstones it, aborts its provider multipart
     upload best-effort, and clears the phantom room progress it left behind.
     unref'd, so it never holds the process open, and cleared on shutdown. */
  const uploadSweeper = setInterval(() => {
    runExpirySweep({ sessions: uploadSessions, storage, now: nowMs() })
      .then((expired) => {
        for (const entry of expired) {
          const room = getRoom(entry.roomCode);
          if (room) clearUploadProgress(io, room, entry.memberId);
        }
      })
      .catch(() => {});
  }, 60 * 1000);
  if (typeof uploadSweeper.unref === 'function') uploadSweeper.unref();
  ownedTimers.push(uploadSweeper);

  /* ---------------- uploaded-media expiry ----------------
     Only the dev filesystem adapter needs an in-process sweeper. Object storage
     expires uploads with a bucket lifecycle rule instead, which survives
     restarts and costs nothing to run (see docs/uploads.md). */
  if (typeof storage.sweep === 'function') {
    const sweep = () => {
      storage.sweep(UPLOAD_TTL_MS).catch(() => {});
    };
    sweep();
    const sweeper = setInterval(sweep, 30 * 60 * 1000);
    // Never hold the process open just to run a cleanup timer.
    if (typeof sweeper.unref === 'function') sweeper.unref();
    ownedTimers.push(sweeper);
  }

  /* ---------------- graceful shutdown ----------------
     ONE idempotent path for every way this process can end. Readiness drops
     first (so a load balancer stops sending work), then connections are closed,
     then storage. Rooms are in-memory and ephemeral by design — nothing is
     persisted on the way out, and pretending otherwise would be a lie about
     what CineVerse is. */
  const shutdown = (reason) =>
    runShutdown({
      lifecycle,
      reason,
      steps: [
        () => {
          // eslint-disable-next-line no-console
          console.log(`\n  ✦ CineVerse shutting down (${reason})\n`);
          // Tell anyone still connected, so clients show "reconnecting" rather
          // than guessing at a silent socket.
          io.emit('server:shutdown', { reason: 'restart' });
        },
        // Socket.IO first: it owns the upgraded connections on top of the HTTP
        // server, so closing the other way round leaves sockets orphaned.
        () => closeQuietly(io),
        () => closeQuietly(server),
        () => ownedTimers.forEach(clearInterval),
        () => (typeof storage.close === 'function' ? storage.close() : undefined),
      ],
    });

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    // Logged, not fatal: a rejected promise inside one socket handler must not
    // take down everyone else's room. It is still a defect — the structured
    // context is here so it can be found and fixed.
    // eslint-disable-next-line no-console
    console.error('[unhandledRejection]', JSON.stringify(describeFatal('unhandledRejection', reason)));
  });

  process.on('uncaughtException', (err) => {
    // The opposite call: after an uncaught exception the process state is
    // unknown, so it must NOT keep serving. Log it fully, drain, exit nonzero.
    // eslint-disable-next-line no-console
    console.error('[uncaughtException]', JSON.stringify(describeFatal('uncaughtException', err)));
    shutdown('uncaughtException');
  });

  server.listen(port, hostname, () => {
    // Ready only once the app is prepared AND the socket is actually listening.
    lifecycle.markReady();
    // eslint-disable-next-line no-console
    console.log(`\n  ✦ CineVerse ready on http://localhost:${port}  (${dev ? 'development' : 'production'})\n`);
    // eslint-disable-next-line no-console
    console.log(`  ✦ uploads: ${storage.name} (max ${uploadLimitLabel})\n`);
  });
});
