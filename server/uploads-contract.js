/**
 * The upload socket contract: its event list, its registration, and the
 * capability descriptor multipart readiness is derived from.
 *
 * `contractMounted: true` used to be a free-standing boolean literal in
 * server.js — a claim the readiness check trusted with nothing behind it. This
 * module makes the claim answerable: `registerUploadSocketHandlers` is the ONE
 * place the handlers are attached, `UPLOAD_CONTRACT` is the descriptor of what it
 * attaches, and a test spies `socket.on` while registering to prove the two
 * agree. Readiness then derives from the descriptor's event list, so a build that
 * dropped a handler reports multipart as unavailable instead of advertising a
 * transport nothing answers.
 *
 * The handlers keep ONLY membership, rate limiting, broadcast and ack plumbing.
 * Every decision about WHAT a client may do lives in the extracted services, so
 * the tested path is the running path. Movie bytes never appear here.
 */

const {
  requestPartTargets,
  readUploadStatus,
  renewUploadSession,
  completeMultipartUpload,
  abortMultipartUpload,
  abortSingleUpload,
  buildRoomProgress,
} = require('./uploads-multipart-service');

/** The events a fully-mounted multipart contract must handle, in call order. */
const UPLOAD_EVENTS = Object.freeze([
  'upload:intent',
  'upload:part-targets',
  'upload:status',
  'upload:renew',
  'upload:complete',
  'upload:abort',
  'upload:room-progress',
]);

/**
 * The frozen capability descriptor. `mounted: true` means THIS module registers
 * the handlers; the readiness check additionally requires the event list to be
 * complete, and the registration test proves the list is truthful.
 */
const UPLOAD_CONTRACT = Object.freeze({
  version: 1,
  mounted: true,
  events: UPLOAD_EVENTS,
});

/**
 * Attach every upload handler to one socket.
 *
 * @param {object} socket  the Socket.IO socket
 * @param {object} deps    the connection-scoped helpers and shared state:
 *   io, storage, secret, uploadConfig, sessions, POLICY,
 *   memberContext, limitMember, ackWith, rateLimitedAck,
 *   nowMs, clean, verifyUploadToken, finalizeUpload, createUploadIntent,
 *   publishUploadProgress, clearUploadProgress, progressThrottleMs
 * @returns {object} UPLOAD_CONTRACT (so a caller can read what it just mounted)
 */
function registerUploadSocketHandlers(socket, deps) {
  const {
    io,
    storage,
    secret,
    uploadConfig,
    sessions,
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
    progressThrottleMs,
    // TEST-ONLY: consume a one-shot injected upload:abort refusal, so a browser
    // test can prove the client keeps its authority on a rejected abort ack.
    // Undefined (and thus inert) outside the mock-bucket test gate.
    testAbortFault,
    // TEST-ONLY: consume a one-shot injected BARE completion failure (a terminal
    // code with NO server classification), so a browser test can exercise the
    // CLIENT-origin terminal cleanup path (the server never closed the lifecycle,
    // so the client must abort it). Inert outside the test gate.
    testCompleteFault,
  } = deps;

  socket.on('upload:intent', async (payload = {}, ack) => {
    const ctx = memberContext(socket);
    if (!ctx) return ackWith(ack, { ok: false, error: 'UNAUTHORIZED' });
    // Rejected BEFORE a key or token is minted, so a flood can neither issue
    // capabilities nor litter storage with unused keys (or open provider
    // multipart sessions that a lifecycle rule then has to reap).
    const intentRate = limitMember(ctx, POLICY.uploadIntent, 1, 3);
    if (!intentRate.ok) return rateLimitedAck(ack, intentRate);
    const { room, member } = ctx;

    // Room code and STABLE member id come from the authenticated context, never
    // the payload, or a member of room A could mint a session under room B.
    try {
      const result = await createUploadIntent({
        payload,
        uploadConfig,
        storage,
        secret,
        roomCode: room.code,
        memberId: member.id,
        sessions,
        now: nowMs(),
      });
      ackWith(ack, result);
    } catch {
      ackWith(ack, { ok: false, error: 'STORAGE_UNAVAILABLE' });
    }
  });

  socket.on('upload:part-targets', async (payload = {}, ack) => {
    const ctx = memberContext(socket);
    if (!ctx) return ackWith(ack, { ok: false, error: 'UNAUTHORIZED' });
    const verdict = limitMember(ctx, POLICY.uploadPartTargets, 1, 2);
    if (!verdict.ok) return rateLimitedAck(ack, verdict);
    const { room, member } = ctx;

    try {
      const result = await requestPartTargets({
        token: payload.token,
        partNumbers: payload.partNumbers,
        storage,
        secret,
        roomCode: room.code,
        memberId: member.id,
        uploadConfig,
        sessions,
        now: nowMs(),
      });
      // Part URLs are write capabilities: acked to the one member who asked,
      // never logged and never broadcast.
      ackWith(ack, result);
    } catch {
      ackWith(ack, { ok: false, error: 'STORAGE_UNAVAILABLE' });
    }
  });

  socket.on('upload:status', async (payload = {}, ack) => {
    const ctx = memberContext(socket);
    if (!ctx) return ackWith(ack, { ok: false, error: 'UNAUTHORIZED' });
    const verdict = limitMember(ctx, POLICY.uploadStatus, 1, 2);
    if (!verdict.ok) return rateLimitedAck(ack, verdict);
    const { room, member } = ctx;

    try {
      const result = await readUploadStatus({
        token: payload.token,
        storage,
        secret,
        roomCode: room.code,
        memberId: member.id,
        sessions,
        now: nowMs(),
      });
      ackWith(ack, result);
    } catch {
      ackWith(ack, { ok: false, error: 'STORAGE_UNAVAILABLE' });
    }
  });

  socket.on('upload:renew', (payload = {}, ack) => {
    const ctx = memberContext(socket);
    if (!ctx) return ackWith(ack, { ok: false, error: 'UNAUTHORIZED' });
    const verdict = limitMember(ctx, POLICY.uploadRenew, 1, 2);
    if (!verdict.ok) return rateLimitedAck(ack, verdict);
    const { room, member } = ctx;

    // Pure: no provider call. The plan is re-signed exactly as it was, with a
    // later expiry, so a six-hour ceiling cannot be walked forward by looping.
    const result = renewUploadSession({
      token: payload.token,
      secret,
      roomCode: room.code,
      memberId: member.id,
      uploadConfig,
      sessions,
      now: nowMs(),
    });
    ackWith(ack, result);
  });

  socket.on('upload:complete', async (payload = {}, ack) => {
    const ctx = memberContext(socket);
    if (!ctx) return ackWith(ack, { ok: false, error: 'UNAUTHORIZED' });
    // Finalizing hits object storage (ListParts/Complete/HEAD), so it is
    // throttled too; a rejected complete never finalizes or publishes.
    const completeVerdict = limitMember(ctx, POLICY.uploadComplete, 1, 3);
    if (!completeVerdict.ok) return rateLimitedAck(ack, completeVerdict);
    const { room, member } = ctx;

    /*
     * TEST-ONLY: a one-shot BARE completion failure. It returns a client-terminal
     * code with NO classification and does NOT touch the session — so the server
     * lifecycle stays active and the CLIENT must run its own abort cleanup. The
     * room bar is deliberately NOT cleared (the session is still live).
     */
    if (typeof testCompleteFault === 'function' && testCompleteFault()) {
      return ackWith(ack, { ok: false, error: 'SIZE_MISMATCH' });
    }

    /*
     * EXPLICIT dispatch on the declared mode.
     *
     * Never inferred from "the single-shot token did not verify" — that would
     * make a corrupt or expired single token silently take the multipart path
     * and answer with the wrong error, and it would let a client probe which
     * token shapes exist.
     */
    if (payload.mode === 'multipart') {
      try {
        const result = await completeMultipartUpload({
          token: payload.token,
          parts: payload.parts,
          label: payload.label,
          storage,
          secret,
          roomCode: room.code,
          memberId: member.id,
          sessions,
          clean,
          now: nowMs(),
        });
        /*
         * Clear the bar on the CLASSIFICATION, not on `ok` alone. A success or a
         * TERMINAL failure (manifest mismatch, wrong final size) is over — the
         * service already tore the session down, so the room stops showing it. A
         * RETRYABLE failure keeps the session and its bar so the client can try
         * again; clearing it there would make a transient hiccup look fatal.
         */
        if (result.ok || result.terminal) clearUploadProgress(io, room, member.id);
        ackWith(ack, result);
      } catch {
        ackWith(ack, { ok: false, error: 'STORAGE_UNAVAILABLE' });
      }
      return;
    }

    // Re-verify the capability rather than trusting a bare key, and confirm the
    // token was issued for THIS room — a member of room A must not attach an
    // object minted for room B. These auth failures mutate no lifecycle.
    const claims = verifyUploadToken(payload.token, secret);
    if (!claims) return ackWith(ack, { ok: false, error: 'BAD_TOKEN' });
    if (claims.roomCode !== room.code) return ackWith(ack, { ok: false, error: 'WRONG_ROOM' });

    try {
      const result = await finalizeUpload({ storage, claims, label: payload.label, clean });
      if (result.ok) {
        // A completed single-shot upload is terminal: tombstone it so its
        // progress cannot be replayed, and clear the bar. A FAILURE leaves the
        // grant active — a single-shot client may re-PUT and complete again with
        // the same still-valid token.
        if (sessions) sessions.markTerminal(payload.token, 'completed', nowMs());
        clearUploadProgress(io, room, member.id);
      }
      ackWith(ack, result);
    } catch {
      ackWith(ack, { ok: false, error: 'STORAGE_UNAVAILABLE' });
    }
  });

  socket.on('upload:abort', async (payload = {}, ack) => {
    const ctx = memberContext(socket);
    if (!ctx) return ackWith(ack, { ok: false, error: 'UNAUTHORIZED' });
    const verdict = limitMember(ctx, POLICY.uploadAbort, 1, 2);
    if (!verdict.ok) return rateLimitedAck(ack, verdict);
    const { room, member } = ctx;

    // TEST-ONLY: a one-shot injected refusal. The client must NOT treat this
    // resolved `{ok:false}` as a successful cancel — the session stays active.
    if (typeof testAbortFault === 'function' && testAbortFault()) {
      return ackWith(ack, { ok: false, error: 'RATE_LIMITED', retryAfterMs: 50 });
    }

    /*
     * Single-shot cancellation has NO provider multipart upload to tear down — it
     * only closes the lifecycle so a progress replay is refused and the room bar
     * cleared. The registry record is the authority (a single-shot token carries no
     * member claim), so the caller's stable member id must match the record's.
     */
    if (payload.mode === 'single') {
      const result = abortSingleUpload({
        token: payload.token,
        verifySingle: verifyUploadToken,
        secret,
        roomCode: room.code,
        memberId: member.id,
        sessions,
        now: nowMs(),
      });
      if (result.ok) clearUploadProgress(io, room, member.id);
      return ackWith(ack, result);
    }

    try {
      const result = await abortMultipartUpload({
        token: payload.token,
        storage,
        secret,
        roomCode: room.code,
        memberId: member.id,
        sessions,
        now: nowMs(),
      });
      // A cancelled upload must not leave the room showing a frozen bar. The
      // lifecycle is already tombstoned by the time this returns (before any
      // provider I/O), so clearing here is race-free.
      if (result.ok) clearUploadProgress(io, room, member.id);
      ackWith(ack, result);
    } catch {
      ackWith(ack, { ok: false, error: 'STORAGE_UNAVAILABLE' });
    }
  });

  socket.on('upload:room-progress', (payload = {}, ack) => {
    const ctx = memberContext(socket);
    if (!ctx) return ackWith(ack, { ok: false, error: 'UNAUTHORIZED' });
    const verdict = limitMember(ctx, POLICY.uploadRoomProgress, 1, 2);
    if (!verdict.ok) return rateLimitedAck(ack, verdict);
    const { room, member } = ctx;

    /*
     * The uploader's client is the only thing that knows its in-flight byte
     * count, so that number comes from it. Nothing else does: the identity is the
     * server's record of this socket, the percentage is computed server-side, the
     * total must equal the size the token pinned, and a TERMINAL session is
     * refused so a replay cannot resurrect a cleared bar.
     */
    const built = buildRoomProgress({
      mode: payload.mode,
      token: payload.token,
      label: payload.label,
      uploadedBytes: payload.uploadedBytes,
      totalBytes: payload.totalBytes,
      status: payload.status,
      secret,
      roomCode: room.code,
      memberId: member.id,
      memberName: member.name,
      verifySingle: verifyUploadToken,
      sessions,
      clean,
      now: nowMs(),
    });
    if (!built.ok) return ackWith(ack, { ok: false, error: built.error });

    /*
     * Throttle ORDINARY progress to one broadcast every 2s per member; send state
     * transitions immediately. A large upload emits progress constantly, and
     * relaying every tick would spend realtime budget on a number that changes
     * faster than anyone can read.
     */
    const now = nowMs();
    const last = member.lastUploadProgressAt || 0;
    if (!built.immediate && now - last < progressThrottleMs) {
      // Still remembered, so a mid-upload joiner's snapshot is current — just not
      // re-broadcast to everyone who already has it.
      room.uploadProgress.set(built.progress.memberId, built.progress);
      return ackWith(ack, { ok: true, throttled: true });
    }
    member.lastUploadProgressAt = now;
    publishUploadProgress(io, room, built.progress);
    ackWith(ack, { ok: true });
  });

  return UPLOAD_CONTRACT;
}

/**
 * Run one expiry sweep and abort the provider uploads it turns up.
 *
 * The registry's `sweep` tombstones expired active sessions and returns them; the
 * report used to claim session expiry cleaned up room progress, but nothing
 * actually did — this is that path. Multipart entries have their provider upload
 * aborted best-effort (a lifecycle rule is the real backstop), and the returned
 * list lets the caller clear and re-broadcast the room progress for each.
 *
 * Async only for the provider aborts; the clock is injected, so a test drives it
 * with a fake clock rather than waiting real minutes.
 *
 * @returns {Promise<Array<{roomCode,memberId,key,uploadId,tokenHash,transport}>>}
 */
async function runExpirySweep({ sessions, storage, now = Date.now() }) {
  const { expired } = sessions.sweep(now);
  for (const entry of expired) {
    if (entry.transport === 'multipart' && entry.uploadId && storage && typeof storage.abortMultipartUpload === 'function') {
      try {
        // eslint-disable-next-line no-await-in-loop
        await storage.abortMultipartUpload({ key: entry.key, uploadId: entry.uploadId });
      } catch {
        /* best effort — the bucket's incomplete-multipart rule still reaps it */
      }
    }
  }
  return expired;
}

module.exports = { UPLOAD_EVENTS, UPLOAD_CONTRACT, registerUploadSocketHandlers, runExpirySweep };
