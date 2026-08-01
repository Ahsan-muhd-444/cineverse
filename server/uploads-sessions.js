/**
 * The upload lifecycle authority.
 *
 * More than a coordination registry now: it is the single place that knows
 * whether a token is still allowed to do anything. The signed token proves ORIGIN
 * and the provider's ListParts proves what LANDED, but neither can answer "has
 * this session already finished?" — and without that answer a member whose token
 * is still valid can re-emit `upload:room-progress` after completing or aborting,
 * and the room progress it just cleared reappears.
 *
 * So terminal states are TOMBSTONED, not deleted. A completed/aborted/expired
 * session keeps a record until its token would have expired anyway, and a replay
 * against that tombstone is refused. Deletion alone is not enough: absence is
 * ambiguous (a fresh active session and a long-gone one look identical), and a
 * tombstone is the only thing that distinguishes "never existed" from "already
 * over".
 *
 * Two transports live here:
 *   - multipart sessions carry a provider upload id and a part plan, and count
 *     against the active-upload limits;
 *   - single-shot grants carry almost nothing — they exist only so their progress
 *     has a lifecycle to end, and they never count against the multipart limits.
 *
 * A restart loses everything in this map, deliberately. Two consequences, stated
 * honestly:
 *   - A lost tombstone reopens a replay window, but one that also requires a
 *     still-valid token within the same short expiry.
 *   - Multipart UPLOAD MEMBERSHIP does NOT survive a server process restart. The
 *     session token binds a process-local member id (see server/seats.js), which
 *     is regenerated on restart, so a resumed operation authorizes as
 *     WRONG_MEMBER. Refresh and temporary network interruption ARE resumable
 *     (same process, same seat); a server restart invalidates active upload
 *     membership and the client must start over. The token plus provider state
 *     is enough to resume ONLY across a client refresh, never across a server
 *     restart — see docs/uploads.md.
 *
 * The RAW token is never stored — a SHA-256 hash is the key. A copy of a
 * six-hour write capability in a long-lived process map would turn any heap dump
 * or stray log into a working credential.
 *
 * Pure with respect to the clock (`now` is injected everywhere) so lifecycle,
 * limits and expiry are all assertable without waiting real minutes.
 */

const crypto = require('crypto');

/** Statuses that mean the upload is still in flight. */
const ACTIVE_STATUSES = Object.freeze(['uploading', 'paused', 'finalizing']);
/**
 * Statuses that mean the upload is over, one way or another. `superseded` is the
 * one a renewal produces: the OLD token's record, retained as a tombstone so a
 * stale holder of the pre-renewal capability cannot act on the renamed session.
 */
const TERMINAL_STATUSES = Object.freeze(['completed', 'aborted', 'expired', 'superseded']);
/** Every status a record may hold. */
const SESSION_STATUSES = Object.freeze([...ACTIVE_STATUSES, ...TERMINAL_STATUSES]);

const isActive = (status) => ACTIVE_STATUSES.includes(status);
const isTerminal = (status) => TERMINAL_STATUSES.includes(status);

/** Coarse lifecycle state, the vocabulary the review contract uses. */
function lifecycleOf(status) {
  if (status === 'uploading' || status === 'paused') return 'active';
  if (status === 'finalizing') return 'finalizing';
  return status; // completed | aborted | expired | superseded
}

/** Lookup key for a token. The raw token is never retained. */
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

/**
 * @param {object} [options]
 * @param {number} [options.maxPerMember=1] concurrent MULTIPART uploads per member
 * @param {number} [options.maxPerRoom=2]   concurrent MULTIPART uploads per room
 * @param {number} [options.maxSessions=2000] hard map bound
 */
function createUploadSessionRegistry(options = {}) {
  const maxPerMember = Number.isSafeInteger(options.maxPerMember) && options.maxPerMember > 0 ? options.maxPerMember : 1;
  const maxPerRoom = Number.isSafeInteger(options.maxPerRoom) && options.maxPerRoom > 0 ? options.maxPerRoom : 2;
  const maxSessions = Number.isSafeInteger(options.maxSessions) && options.maxSessions > 0 ? options.maxSessions : 2000;

  /** @type {Map<string, object>} tokenHash -> record */
  const sessions = new Map();

  const entries = () => [...sessions.values()];

  // Only MULTIPART sessions that are still in flight count against the limits.
  // A single-shot grant is one fast request; it must not block a multipart start,
  // and a multipart session must not block a single-shot upload.
  const countsForLimit = (s) => s.transport === 'multipart' && isActive(s.status);

  /**
   * Register a session. `transport` decides how it behaves: a multipart session
   * carries a provider upload id and plan and counts against the limits; a
   * single-shot grant carries only what its progress lifecycle needs.
   */
  function register({
    token,
    roomCode,
    memberId,
    key,
    uploadId,
    expectedBytes,
    partCount,
    expiresAt,
    label,
    transport = 'multipart',
    now = Date.now(),
  }) {
    const tokenHash = hashToken(token);
    const record = {
      tokenHash,
      transport: transport === 'single' ? 'single' : 'multipart',
      roomCode,
      memberId,
      key,
      uploadId,
      expectedBytes,
      partCount,
      expiresAt,
      status: 'uploading',
      createdAt: now,
      updatedAt: now,
      label: label === undefined ? undefined : String(label),
      uploadedBytes: 0,
    };

    /*
     * FAIL CLOSED at capacity.
     *
     * The old code silently evicted the oldest record — which could be an ACTIVE
     * upload or an unexpired tombstone — to make room. That trades a bounded map
     * for a correctness hole: a live upload loses its limit slot and its replay
     * protection so a stranger's registration can squeeze in. Now the only thing
     * eviction may reclaim is a tombstone that is ALREADY past its token's
     * expiry; if that does not free space, the new registration is refused and
     * every existing record is preserved untouched. A re-registration of the SAME
     * token (idempotent) is allowed to overwrite its own slot.
     */
    if (!sessions.has(tokenHash) && sessions.size >= maxSessions) {
      pruneExpiredTombstones(now);
      if (sessions.size >= maxSessions) return { ok: false, error: 'SESSION_REGISTRY_FULL' };
    }

    sessions.set(tokenHash, record);
    return { ok: true, ...record };
  }

  function getByHash(tokenHash) {
    const found = sessions.get(tokenHash);
    return found ? { ...found } : null;
  }

  const get = (token) => getByHash(hashToken(token));

  /** The coarse lifecycle state for a token, or 'absent'. */
  function lifecycle(token, now = Date.now()) {
    const record = sessions.get(hashToken(token));
    if (!record) return 'absent';
    if (isActive(record.status) && Number.isSafeInteger(record.expiresAt) && record.expiresAt <= now) {
      // Past expiry but the sweeper has not run yet: treat as expired.
      return 'expired';
    }
    return lifecycleOf(record.status);
  }

  /**
   * May this token still emit progress?
   *
   * The whole point of the tombstone: a completed or aborted session refuses
   * progress so a replay cannot resurrect the bar the room just cleared. An
   * absent record is allowed — after a restart the tombstone is gone and the
   * signed token is the remaining gate, and a genuinely fresh active session also
   * looks absent for its first report if it was never registered.
   *
   * @returns {{ok:true, absent?:boolean} | {ok:false, error:'SESSION_TERMINAL'|'SESSION_EXPIRED'}}
   */
  function progressVerdict(token, now = Date.now()) {
    const record = sessions.get(hashToken(token));
    if (!record) return { ok: true, absent: true };
    if (record.status === 'superseded') return { ok: false, error: 'SESSION_SUPERSEDED' };
    if (record.status === 'expired') return { ok: false, error: 'SESSION_EXPIRED' };
    if (isTerminal(record.status)) return { ok: false, error: 'SESSION_TERMINAL' };
    if (Number.isSafeInteger(record.expiresAt) && record.expiresAt <= now) {
      return { ok: false, error: 'SESSION_EXPIRED' };
    }
    return { ok: true };
  }

  /**
   * The lifecycle authority gate EVERY service entry point consults after
   * cryptographic authorization.
   *
   * Distinct from `progressVerdict`: a completed session must still be allowed to
   * re-complete (idempotent, returns the source), so this only refuses the states
   * that no operation may act on — a superseded token (its capability was revoked
   * by a renewal) and an expired one. Completed/aborted are left to each entry
   * point, which handles them with operation-specific semantics.
   *
   * Absence is accepted: after a process restart the tombstone is gone and the
   * signed token is the remaining gate (see the restart policy in the module
   * header). What absence must NOT do is make a KNOWN superseded token active —
   * and it cannot, because the superseded tombstone is retained until the token's
   * original expiry.
   *
   * @returns {{ok:true}|{ok:false, error:'SESSION_SUPERSEDED'|'SESSION_EXPIRED'}}
   */
  function authorityCheck(token, now = Date.now()) {
    const record = sessions.get(hashToken(token));
    if (!record) return { ok: true, absent: true };
    if (record.status === 'superseded') return { ok: false, error: 'SESSION_SUPERSEDED' };
    if (record.status === 'expired') return { ok: false, error: 'SESSION_EXPIRED' };
    if (isActive(record.status) && Number.isSafeInteger(record.expiresAt) && record.expiresAt <= now) {
      return { ok: false, error: 'SESSION_EXPIRED' };
    }
    return { ok: true };
  }

  /**
   * Patch a live session's mutable fields. A TERMINAL record is immutable — once
   * over it stays over, so a late update cannot walk it back to active.
   */
  function update(token, patch = {}, now = Date.now()) {
    const record = sessions.get(hashToken(token));
    if (!record || isTerminal(record.status)) return null;
    if (patch.status !== undefined) {
      if (!SESSION_STATUSES.includes(patch.status)) return null;
      record.status = patch.status;
    }
    if (patch.label !== undefined) record.label = String(patch.label);
    if (patch.uploadedBytes !== undefined && Number.isSafeInteger(patch.uploadedBytes) && patch.uploadedBytes >= 0) {
      record.uploadedBytes = Math.min(patch.uploadedBytes, record.expectedBytes ?? patch.uploadedBytes);
    }
    if (patch.expiresAt !== undefined && Number.isSafeInteger(patch.expiresAt)) record.expiresAt = patch.expiresAt;
    record.updatedAt = now;
    return { ...record };
  }

  /**
   * Move a session to a terminal state and KEEP it as a tombstone until its
   * token would have expired. Idempotent: re-marking an already-terminal session
   * returns it unchanged, which is what makes a duplicate completion/abort a
   * no-op rather than a second broadcast.
   *
   * @param {'completed'|'aborted'|'expired'} state
   */
  function markTerminal(token, state, now = Date.now()) {
    return markTerminalByHash(hashToken(token), state, now);
  }

  function markTerminalByHash(tokenHash, state, now = Date.now()) {
    if (!TERMINAL_STATUSES.includes(state)) return null;
    const record = sessions.get(tokenHash);
    if (!record) return null;
    if (isTerminal(record.status)) return { ...record, alreadyTerminal: true };
    record.status = state;
    record.updatedAt = now;
    return { ...record };
  }

  /**
   * Renew: same session, new token — ATOMIC and REGISTRY-BOUNDED.
   *
   * The old token is NOT deleted — deletion left it cryptographically valid and
   * lifecycle-absent, so a stale holder could still act on the renamed session.
   * Instead the old record becomes a `superseded` tombstone, retained until its
   * ORIGINAL expiry, and a fresh ACTIVE record is created under the new token
   * with the renewed expiry. The plan (key/uploadId/member/room/partCount) is
   * unchanged, and only the fresh record is active, so the session still counts
   * exactly once against the limits.
   *
   * The subtlety that made the old version wrong: because the superseded
   * tombstone KEEPS its slot, a renewal NETS one extra record. Left unbounded,
   * renewing in a loop walked the map straight past `maxSessions` — register →
   * renew → renew produced (superseded, superseded, active) = 3 records at a bound
   * of 2. So a renewal now honours the SAME fail-closed bound `register()` does:
   * prune dead tombstones, and if there is still no free slot for the new hash,
   * REFUSE — leaving the old token untouched and ACTIVE, returning
   * SESSION_REGISTRY_FULL. Only when a slot exists is the supersede-and-install
   * performed, and it is atomic: either both happen or neither does, so a refused
   * renewal never leaves a half-renamed session.
   *
   * This registry does NOT police how far the renewed `expiresAt` may move — the
   * caller (renewUploadSession) clamps it to the session's IMMUTABLE absolute
   * deadline, carried in the signed token and fixed at intent time, so a renewal
   * loop cannot extend a session indefinitely. See server/uploads-multipart.js.
   *
   * @returns {{ok:true, ...record}
   *          |{ok:false, error:'SESSION_NOT_RENEWABLE'|'SESSION_REGISTRY_FULL'}}
   */
  function rekey(oldToken, newToken, { expiresAt, now = Date.now() } = {}) {
    const oldHash = hashToken(oldToken);
    const record = sessions.get(oldHash);
    // Nothing to renew, or already over: a terminal record is never resurrected.
    if (!record || isTerminal(record.status)) return { ok: false, error: 'SESSION_NOT_RENEWABLE' };

    const newHash = hashToken(newToken);

    /*
     * The bound is checked BEFORE any mutation. Installing the new token adds a
     * slot on top of the old (about-to-be-superseded) one, so a free slot must
     * exist for it. Reclaim only DEAD tombstones first — exactly what register()
     * may free — and if that still leaves no room, refuse without touching the
     * old record. Re-keying onto an already-present hash needs no new slot.
     */
    if (!sessions.has(newHash)) {
      if (sessions.size >= maxSessions) pruneExpiredTombstones(now);
      if (sessions.size >= maxSessions) return { ok: false, error: 'SESSION_REGISTRY_FULL' };
    }

    // Atomic from here: revoke the old capability, install the new one.
    record.status = 'superseded';
    record.updatedAt = now;

    const fresh = {
      ...record,
      status: 'uploading',
      tokenHash: newHash,
      updatedAt: now,
      expiresAt: Number.isSafeInteger(expiresAt) ? expiresAt : record.expiresAt,
    };
    sessions.set(newHash, fresh);
    return { ok: true, ...fresh };
  }

  const remove = (token) => sessions.delete(hashToken(token));
  const removeByHash = (tokenHash) => sessions.delete(tokenHash);

  const countForMember = (roomCode, memberId) =>
    entries().filter((s) => s.roomCode === roomCode && s.memberId === memberId && countsForLimit(s)).length;

  const countForRoom = (roomCode) => entries().filter((s) => s.roomCode === roomCode && countsForLimit(s)).length;

  const listForRoom = (roomCode) => entries().filter((s) => s.roomCode === roomCode).map((s) => ({ ...s }));

  const listActiveForMember = (roomCode, memberId) =>
    entries()
      .filter((s) => s.roomCode === roomCode && s.memberId === memberId && countsForLimit(s))
      .map((s) => ({ ...s }));

  /**
   * Would a new MULTIPART upload be admitted right now?
   * @returns {{ok:true} | {ok:false, error:'UPLOAD_ALREADY_ACTIVE'|'ROOM_UPLOAD_LIMIT'}}
   */
  function canStart(roomCode, memberId) {
    if (countForMember(roomCode, memberId) >= maxPerMember) {
      return { ok: false, error: 'UPLOAD_ALREADY_ACTIVE' };
    }
    if (countForRoom(roomCode) >= maxPerRoom) return { ok: false, error: 'ROOM_UPLOAD_LIMIT' };
    return { ok: true };
  }

  /**
   * Tombstone every active session for a member and return them for aborting.
   *
   * Marks terminal rather than deleting: a kicked member who rejoins gets a new
   * member id, but a single-shot progress token carries no member claim, so a
   * deleted tombstone would let the old token replay progress. The tombstone
   * closes that window until the token expires.
   */
  function takeForMember(roomCode, memberId, now = Date.now()) {
    const taken = [];
    for (const [hash, s] of [...sessions]) {
      if (s.roomCode === roomCode && s.memberId === memberId && isActive(s.status)) {
        markTerminalByHash(hash, 'aborted', now);
        taken.push({ ...s });
      }
    }
    return taken;
  }

  /** Tombstone every active session in a room and return them for aborting. */
  function takeForRoom(roomCode, now = Date.now()) {
    const taken = [];
    for (const [hash, s] of [...sessions]) {
      if (s.roomCode === roomCode && isActive(s.status)) {
        markTerminalByHash(hash, 'aborted', now);
        taken.push({ ...s });
      }
    }
    return taken;
  }

  /**
   * The periodic clean-up, and the ONLY place session expiry becomes observable.
   *
   * An expired ACTIVE session is tombstoned `expired` and returned, so the caller
   * can abort its provider upload and clear its room progress — the report used to
   * claim this happened, but nothing actually did it. A terminal tombstone past
   * its token expiry is deleted outright: its whole job was to block a replay for
   * as long as the token could have been used, and the token is now dead.
   *
   * @returns {{removed:number, expired:Array<{roomCode,memberId,key,uploadId,tokenHash,transport}>}}
   */
  function sweep(now = Date.now()) {
    let removed = 0;
    const expired = [];
    for (const [hash, s] of [...sessions]) {
      const pastExpiry = Number.isSafeInteger(s.expiresAt) && s.expiresAt <= now;
      if (isActive(s.status) && pastExpiry) {
        markTerminalByHash(hash, 'expired', now);
        expired.push({
          roomCode: s.roomCode,
          memberId: s.memberId,
          key: s.key,
          uploadId: s.uploadId,
          tokenHash: hash,
          transport: s.transport,
        });
      } else if (isTerminal(s.status) && pastExpiry) {
        sessions.delete(hash);
        removed += 1;
      }
    }
    return { removed, expired };
  }

  /**
   * Reclaim ONLY tombstones whose token has already expired.
   *
   * This is the sole freeing mechanism available to `register` at capacity. It
   * deliberately never touches an active record or an unexpired tombstone — a
   * completed/aborted/superseded session must keep refusing replays until its
   * token could no longer be used, and an active upload must keep its slot.
   */
  function pruneExpiredTombstones(now) {
    let removed = 0;
    for (const [hash, s] of [...sessions]) {
      if (isTerminal(s.status) && Number.isSafeInteger(s.expiresAt) && s.expiresAt <= now) {
        sessions.delete(hash);
        removed += 1;
      }
    }
    return removed;
  }

  return {
    limits: Object.freeze({ maxPerMember, maxPerRoom, maxSessions }),
    hashToken,
    register,
    get,
    getByHash,
    lifecycle,
    progressVerdict,
    authorityCheck,
    pruneExpiredTombstones,
    update,
    markTerminal,
    markTerminalByHash,
    rekey,
    remove,
    removeByHash,
    countForMember,
    countForRoom,
    listForRoom,
    listActiveForMember,
    canStart,
    takeForMember,
    takeForRoom,
    sweep,
    size: () => sessions.size,
    // Records still in flight (any transport), i.e. not tombstoned. Exposed for a
    // test-only readiness readout that asserts a stress run leaves nothing active.
    activeCount: () => entries().filter((s) => isActive(s.status)).length,
  };
}

module.exports = {
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  SESSION_STATUSES,
  isActive,
  isTerminal,
  lifecycleOf,
  hashToken,
  createUploadSessionRegistry,
};
