/**
 * The multipart upload OPERATIONS.
 *
 * Extracted from the Socket.IO handlers for the same reason the single-shot
 * intent was: the thing that is tested must be the thing that runs. A test that
 * re-implements a handler can only reproduce the bug it also reproduces
 * faithfully, and the last grant defect was invisible precisely because the test
 * copy passed a different argument than the handler did.
 *
 * The handlers in server.js keep membership, rate limiting and ack plumbing.
 * Everything that decides WHAT a caller may do lives here:
 *
 *   requestPartTargets   sign a bounded batch of part URLs
 *   readUploadStatus     provider-confirmed truth about what has landed
 *   renewUploadSession   extend a long upload without changing its plan
 *   completeMultipart    verify, assemble, verify again, publish
 *   abortMultipart       cancel, idempotently
 *   buildRoomProgress    server-computed, secret-free partner progress
 *
 * Storage, the clock and the sanitiser are injected, so every path here is
 * exercisable against the mock provider with no credentials and no network.
 *
 * Movie bytes never appear in this file. It handles numbers, plans, opaque
 * provider ids and presigned URLs.
 */

const {
  verifyMultipartToken,
  issueMultipartToken,
  authorizeSession,
  validatePartNumbers,
  validateCompletionParts,
  partRange,
  planParts,
  MAX_PART_TARGET_BATCH,
  BOUNDS,
} = require('./uploads-multipart');
const { normalizeEtag, isBoundedString } = require('./upload-limits');

const passthroughClean = (v) => String(v ?? '').trim().slice(0, 120);

/** The registry's terminal statuses, so the service reads them the same way. */
const TERMINAL_SESSION_STATUSES = new Set(['completed', 'aborted', 'expired', 'superseded']);

/** Progress states a client may report. */
const PROGRESS_STATUSES = Object.freeze(['uploading', 'paused', 'retrying', 'reconnecting', 'finalizing']);

/**
 * Verify a session token AND confirm the caller still owns it.
 *
 * Two separate facts: the signature proves the plan came from us, and this
 * proves the caller is still the same stable member in the same room. A socket
 * that reconnected into a different seat must not continue someone else's
 * upload, which is why the member id in the token is the STABLE one and never a
 * socket id.
 */
function authorize({ token, secret, roomCode, memberId, now = Date.now() }) {
  const claims = verifyMultipartToken(token, secret, now);
  if (!claims) return { ok: false, error: 'BAD_TOKEN' };
  const verdict = authorizeSession(claims, { roomCode, memberId });
  if (!verdict.ok) return verdict;
  return { ok: true, claims };
}

/**
 * The lifecycle-authority gate, consulted by EVERY entry point AFTER cryptographic
 * authorization.
 *
 * The signature proving a token authentic is not the same as the session still
 * being live: a renewal supersedes the old token (which stays cryptographically
 * valid), and a sweep expires an abandoned one. Neither is visible to
 * `verifyMultipartToken`, so without this a stale-but-signed token would slip
 * through. Returns an error result to short-circuit on, or null to proceed.
 *
 * @returns {{ok:false, error:string}|null}
 */
function lifecycleReject(sessions, token, now) {
  if (!sessions || typeof sessions.authorityCheck !== 'function') return null;
  const verdict = sessions.authorityCheck(token, now);
  return verdict.ok ? null : { ok: false, error: verdict.error };
}

/* -------------------------------------------------------------------------- */
/*  Part targets                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Sign presigned PUT targets for a bounded batch of parts.
 *
 * Never all of them. A 3 GiB/16 MiB upload is 192 parts; returning 192 signed
 * URLs from intent would mint 192 write capabilities the client mostly does not
 * need yet, all expiring together, and would put a large URL list on the wire
 * for every upload. The client asks for what it is about to send.
 */
async function requestPartTargets({
  token,
  partNumbers,
  storage,
  secret,
  roomCode,
  memberId,
  uploadConfig,
  sessions,
  now = Date.now(),
}) {
  const auth = authorize({ token, secret, roomCode, memberId, now });
  if (!auth.ok) return { ok: false, error: auth.error };
  const gate = lifecycleReject(sessions, token, now);
  if (gate) return gate;
  const claims = auth.claims;

  const batch = validatePartNumbers(partNumbers, claims.partCount, MAX_PART_TARGET_BATCH);
  if (!batch.ok) return { ok: false, error: batch.error };

  if (!storage || typeof storage.createPartUploadTarget !== 'function') {
    return { ok: false, error: 'CONFIGURATION_ERROR' };
  }

  const ttlSeconds = uploadConfig?.partUrlTtlSeconds ?? BOUNDS.partUrlTtlMin;
  const plan = { partSize: claims.partSize, partCount: claims.partCount };
  const expiresAt = now + ttlSeconds * 1000;
  const targets = [];

  for (const partNumber of batch.partNumbers) {
    // The byte range comes from the SIGNED plan, never from the request. It is
    // the same arithmetic the browser uses for File.slice(), so a part is always
    // exactly the bytes the completed object expects at that offset.
    const range = partRange(partNumber, plan, claims.expectedBytes);
    if (!range) return { ok: false, error: 'BAD_PARTS' };

    const target = await storage.createPartUploadTarget({
      key: claims.key,
      uploadId: claims.uploadId,
      partNumber,
      expiresIn: ttlSeconds,
      expectedBytes: range.size,
    });
    if (!target || typeof target.url !== 'string' || !target.url) {
      return { ok: false, error: 'STORAGE_UNAVAILABLE' };
    }
    targets.push({
      partNumber,
      method: 'PUT',
      url: target.url,
      // Only what the provider needs. A part upload carries no policy fields and
      // no auth header — the signature is in the URL.
      headers: target.headers && typeof target.headers === 'object' ? { ...target.headers } : {},
      expectedBytes: range.size,
      expiresAt,
    });
  }

  return { ok: true, targets };
}

/* -------------------------------------------------------------------------- */
/*  Provider-confirmed status                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Validate the provider's part list against the signed plan.
 *
 * The provider is not trusted to describe our own upload correctly. A duplicate,
 * an out-of-plan part number or a part whose stored size is not the planned one
 * means the object we would assemble is not the object the client is uploading —
 * and no HEAD at the end could detect a wrong-sized middle part, because the
 * total would still match if two errors cancelled.
 *
 * @returns {{ok:true, parts:Array}|{ok:false, error:string}}
 */
function reconcileProviderParts(providerParts, claims) {
  if (!Array.isArray(providerParts)) return { ok: false, error: 'PROVIDER_STATE_INVALID' };

  const seen = new Map();
  for (const part of providerParts) {
    if (!part || typeof part !== 'object') return { ok: false, error: 'PROVIDER_STATE_INVALID' };
    const { partNumber } = part;
    if (!Number.isSafeInteger(partNumber) || partNumber < 1 || partNumber > claims.partCount) {
      return { ok: false, error: 'PROVIDER_PART_OUT_OF_PLAN' };
    }
    if (seen.has(partNumber)) return { ok: false, error: 'PROVIDER_DUPLICATE_PART' };

    const etag = normalizeEtag(part.etag);
    if (!etag) return { ok: false, error: 'PROVIDER_BAD_ETAG' };

    // Every part but the last is exactly partSize; the last is exactly
    // lastPartSize. This is the only place a truncated or over-long part can be
    // caught, because S3 has no per-part content-length-range.
    const expected = partNumber === claims.partCount ? claims.lastPartSize : claims.partSize;
    if (!Number.isSafeInteger(part.size) || part.size !== expected) {
      return { ok: false, error: 'PROVIDER_PART_SIZE_MISMATCH' };
    }
    seen.set(partNumber, { partNumber, etag, size: part.size });
  }

  const parts = [...seen.keys()].sort((a, b) => a - b).map((n) => seen.get(n));
  return { ok: true, parts };
}

/**
 * What the PROVIDER says has landed. The only trustworthy basis for a resume:
 * local bookkeeping cannot survive a refresh, and after one it would be a guess.
 */
async function readUploadStatus({ token, storage, secret, roomCode, memberId, sessions, now = Date.now() }) {
  const auth = authorize({ token, secret, roomCode, memberId, now });
  if (!auth.ok) return { ok: false, error: auth.error };
  const gate = lifecycleReject(sessions, token, now);
  if (gate) return gate;
  const claims = auth.claims;

  if (!storage || typeof storage.listMultipartParts !== 'function') {
    return { ok: false, error: 'CONFIGURATION_ERROR' };
  }

  const session = sessions ? sessions.get(token) : null;
  // A finished session is reported as finished without asking the provider about
  // a multipart upload that no longer exists. Any terminal state qualifies —
  // completed, aborted, or expired.
  if (session && TERMINAL_SESSION_STATUSES.has(session.status)) {
    return {
      ok: true,
      status: session.status,
      completedParts: [],
      uploadedBytes: session.status === 'completed' ? claims.expectedBytes : 0,
      expectedBytes: claims.expectedBytes,
      partCount: claims.partCount,
      expiresAt: claims.expiresAt,
    };
  }

  let providerParts;
  try {
    providerParts = await storage.listMultipartParts({
      key: claims.key,
      uploadId: claims.uploadId,
      // MANDATORY: the provider can never report more parts than we planned.
      expectedPartCount: claims.partCount,
    });
  } catch (err) {
    if (isMissingUpload(err)) return { ok: false, error: 'NO_SUCH_UPLOAD' };
    return { ok: false, error: 'STORAGE_UNAVAILABLE' };
  }

  const reconciled = reconcileProviderParts(providerParts, claims);
  if (!reconciled.ok) return { ok: false, error: reconciled.error };

  const uploadedBytes = reconciled.parts.reduce((total, part) => total + part.size, 0);
  const status = uploadedBytes >= claims.expectedBytes ? 'finalizing' : 'uploading';

  return {
    ok: true,
    status,
    completedParts: reconciled.parts,
    // ONLY provider-confirmed bytes. The client adds its own in-flight progress
    // on top locally; the server never guesses at bytes nobody has stored.
    uploadedBytes,
    expectedBytes: claims.expectedBytes,
    partCount: claims.partCount,
    expiresAt: claims.expiresAt,
  };
}

/** Does this provider error mean "that multipart upload is not there"? */
function isMissingUpload(err) {
  const code = err?.name || err?.Code || err?.code || '';
  return code === 'NoSuchUpload' || err?.$metadata?.httpStatusCode === 404;
}

/* -------------------------------------------------------------------------- */
/*  Renewal                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Extend a session that is still valid but approaching expiry.
 *
 * Only `expiresAt` changes, and only UP TO the session's immutable absolute
 * deadline. The key, upload id, part plan AND absolute deadline are re-signed
 * exactly as they were, so a renewal can never renegotiate a limit or push the
 * session's lifetime past the ceiling fixed at intent time. Because the new token
 * is a new capability, the old hash stops addressing the session the moment this
 * returns — and it is registered atomically, so a caller never receives a token
 * the registry does not know about.
 */
function renewUploadSession({ token, secret, roomCode, memberId, uploadConfig, sessions, now = Date.now() }) {
  const auth = authorize({ token, secret, roomCode, memberId, now });
  if (!auth.ok) return { ok: false, error: auth.error };
  const gate = lifecycleReject(sessions, token, now);
  if (gate) return gate;
  const claims = auth.claims;

  const session = sessions ? sessions.get(token) : null;
  // Never renew something that is over. A completed session has nothing left to
  // upload, an aborted one has no provider upload to write to, and an expired or
  // superseded one is already dead. (The superseded/expired cases are also caught
  // by the gate above; this keeps completed/aborted explicit.)
  if (session && TERMINAL_SESSION_STATUSES.has(session.status)) {
    return { ok: false, error: 'SESSION_CLOSED' };
  }

  const ttlSeconds = uploadConfig?.sessionTtlSeconds ?? BOUNDS.sessionTtlMin;
  const ttlMs = ttlSeconds * 1000;
  /*
   * The renewed expiry is the smaller of "one more TTL" and the IMMUTABLE
   * absolute deadline the token was minted with. The deadline is REACHED when a
   * renewal can no longer move the expiry FORWARD — the clamp has collapsed onto
   * the ceiling, so `expiresAt <= claims.expiresAt`. At that point the session is
   * refused with SESSION_EXPIRED and NO replacement token is issued: the current
   * token stays valid until it lapses, and the normal sweeper then aborts its
   * provider upload. This is what bounds a renewal loop — a legit near-expiry
   * renewal always advances the expiry, so it is never caught by this. (`<= now`
   * is the defensive floor for a clock already past the deadline.)
   */
  const absoluteExpiresAt = claims.absoluteExpiresAt;
  const expiresAt = Math.min(now + ttlMs, absoluteExpiresAt);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt <= claims.expiresAt) {
    return { ok: false, error: 'SESSION_EXPIRED' };
  }

  let renewed;
  try {
    renewed = issueMultipartToken(
      {
        key: claims.key,
        uploadId: claims.uploadId,
        roomCode: claims.roomCode,
        memberId: claims.memberId,
        mimeType: claims.mimeType,
        expectedBytes: claims.expectedBytes,
        maxBytes: claims.maxBytes,
        partSize: claims.partSize,
        partCount: claims.partCount,
        expiresAt,
        // Re-signed UNCHANGED — the deadline is immutable across renewals.
        absoluteExpiresAt,
      },
      secret,
      now,
    );
  } catch {
    return { ok: false, error: 'CONFIGURATION_ERROR' };
  }

  /*
   * Register the renewed token ATOMICALLY, and honour the result: rekey is
   * fail-closed at capacity and refuses a terminal record, so a failed rekey must
   * NOT hand back a token the registry never accepted. The old token stays active
   * in that case (rekey left it untouched), so the client keeps a working
   * capability and simply retries later.
   */
  if (sessions && session) {
    const rekeyed = sessions.rekey(token, renewed, { expiresAt, now });
    if (!rekeyed.ok) return { ok: false, error: rekeyed.error };
  }
  return { ok: true, token: renewed, expiresAt };
}

/* -------------------------------------------------------------------------- */
/*  Completion                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Verify the final object and turn it into a room source.
 *
 * Shared by the normal completion path and the idempotent retry path, so both
 * apply exactly the same gate: the object must exist, be exactly the expected
 * size, and (when the provider reports one) carry the approved content type.
 */
async function verifyFinalObject({ storage, claims, label, clean }) {
  if (!storage || typeof storage.statObject !== 'function') {
    return { ok: false, error: 'STORAGE_UNVERIFIABLE' };
  }
  const stat = await storage.statObject(claims.key);
  if (!stat) return { ok: false, error: 'NOT_UPLOADED' };

  const size = Number(stat.size);
  if (!Number.isFinite(size) || size <= 0) return { ok: false, error: 'BAD_SIZE' };
  if (size !== claims.expectedBytes) return { ok: false, error: 'SIZE_MISMATCH' };

  if (stat.contentType && claims.mimeType) {
    const actual = String(stat.contentType).split(';')[0].trim().toLowerCase();
    if (actual !== String(claims.mimeType).toLowerCase()) return { ok: false, error: 'BAD_CONTENT' };
  }

  const value = await storage.createReadUrl(claims.key);
  return {
    ok: true,
    source: {
      type: 'url',
      value,
      label: clean(label, 120) || 'Uploaded video',
      quality: 'Uploaded',
    },
  };
}

async function tryDelete(storage, key) {
  if (!storage || typeof storage.deleteObject !== 'function') return;
  try {
    await storage.deleteObject(key);
  } catch {
    /* best effort — a bucket lifecycle rule still reaps it */
  }
}

async function tryAbort(storage, key, uploadId) {
  if (!storage || typeof storage.abortMultipartUpload !== 'function') return;
  try {
    await storage.abortMultipartUpload({ key, uploadId });
  } catch {
    /* best effort — the bucket's incomplete-multipart rule is the backstop */
  }
}

/*
 * Completion outcomes are CLASSIFIED, not just pass/fail.
 *
 * The handler used to clear progress on `result.ok` alone, which conflated two
 * very different failures: a transient provider hiccup (retry, keep the session
 * and its bar) and a manifest mismatch (over for good, tear it down). These three
 * shapes make the distinction explicit so the handler acts on the classification
 * instead of guessing.
 *
 *   retryable  the client may try again; the session stays active
 *   terminal   the session is finished; abort/delete happened, clear the bar
 *   auth       the caller is wrong, not the session — mutate nothing
 */
const retryableFail = (error) => ({ ok: false, error, retryable: true, terminal: false });
const terminalFail = (error) => ({ ok: false, error, retryable: false, terminal: true });
const authFail = (error) => ({ ok: false, error, retryable: false, terminal: false });

/**
 * Complete a multipart upload.
 *
 * The order matters, and every step is a gate rather than a formality:
 *
 *   1. the caller still owns the session;
 *   2. the client manifest is exactly the planned parts;
 *   3. the PROVIDER agrees, part for part, ETag for ETag, byte for byte;
 *   4. the provider assembles;
 *   5. the assembled object is exactly the expected size and type;
 *   6. only then does it become a source.
 *
 * Step 3 is the one that cannot be skipped in favour of trusting the client: the
 * client's ETags are what it believes the provider returned, and a client that
 * lies about one produces a corrupt object S3 will happily assemble.
 */
async function completeMultipartUpload({
  token,
  parts,
  label,
  storage,
  secret,
  roomCode,
  memberId,
  sessions,
  clean = passthroughClean,
  now = Date.now(),
}) {
  const auth = authorize({ token, secret, roomCode, memberId, now });
  if (!auth.ok) return authFail(auth.error);
  // A superseded or expired token may not complete the renamed/dead session.
  // Terminal to the CALLER (this capability is finished) but it mutates nothing.
  const gate = lifecycleReject(sessions, token, now);
  if (gate) return { ...gate, retryable: false, terminal: true };
  const claims = auth.claims;

  // A server-side misconfiguration, not a session outcome: mutate nothing.
  if (!storage || typeof storage.completeMultipartUpload !== 'function') return authFail('CONFIGURATION_ERROR');

  const markCompleted = () => sessions && sessions.markTerminal(token, 'completed', now);
  const succeed = (verified, replayed) => {
    markCompleted();
    return {
      ok: true,
      terminal: true,
      replayed: Boolean(replayed) || undefined,
      source: verified.source,
      key: claims.key,
      expectedBytes: claims.expectedBytes,
    };
  };
  // A terminal manifest/verification failure tears the session down: abort the
  // provider upload best-effort, tombstone the session, and let the handler
  // clear the bar. Everything the caller could fix on their own is already gone.
  const terminate = async (error, { abortProvider = true } = {}) => {
    if (abortProvider) await tryAbort(storage, claims.key, claims.uploadId);
    if (sessions) sessions.markTerminal(token, 'aborted', now);
    return terminalFail(error);
  };

  const session = sessions ? sessions.get(token) : null;
  /*
   * IDEMPOTENT completion, first branch: we already finished this one.
   *
   * A client whose ack was lost retries. Re-running the provider Complete would
   * fail (the multipart upload is gone) and a naive error would tell the user
   * their finished upload failed. Verify the object and return the same logical
   * result instead — exactly one source, no duplicate progress.
   */
  if (session && session.status === 'completed') {
    const verified = await verifyFinalObject({ storage, claims, label, clean });
    if (!verified.ok) return terminalFail(verified.error);
    return succeed(verified, true);
  }
  if (session && (session.status === 'aborted' || session.status === 'expired')) return terminalFail('SESSION_CLOSED');

  const manifest = validateCompletionParts(parts, claims.partCount);
  if (!manifest.ok) return terminate(manifest.error);

  let providerParts;
  try {
    providerParts = await storage.listMultipartParts({
      key: claims.key,
      uploadId: claims.uploadId,
      expectedPartCount: claims.partCount,
    });
  } catch (err) {
    if (isMissingUpload(err)) {
      /*
       * IDEMPOTENT completion, second branch: the provider says the multipart
       * upload no longer exists. Either a previous Complete succeeded and our ack
       * was lost, or it was aborted. The object itself decides which.
       */
      const verified = await verifyFinalObject({ storage, claims, label, clean });
      if (!verified.ok) return terminate('NO_SUCH_UPLOAD', { abortProvider: false });
      return succeed(verified, true);
    }
    // A transient listing failure: keep the session, let the client retry.
    return retryableFail('STORAGE_UNAVAILABLE');
  }

  const reconciled = reconcileProviderParts(providerParts, claims);
  if (!reconciled.ok) return terminate(reconciled.error);
  if (reconciled.parts.length !== claims.partCount) return terminate('MISSING_PART');

  // EXACT agreement between what the client says it uploaded and what the
  // provider says it stored. Same numbers, same opaque ETags, no exceptions.
  for (let i = 0; i < claims.partCount; i += 1) {
    const mine = manifest.parts[i];
    const theirs = reconciled.parts[i];
    if (mine.partNumber !== theirs.partNumber) return terminate('PART_MISMATCH');
    if (mine.etag !== theirs.etag) return terminate('ETAG_MISMATCH');
  }

  if (sessions && session) sessions.update(token, { status: 'finalizing' }, now);

  try {
    await storage.completeMultipartUpload({
      key: claims.key,
      uploadId: claims.uploadId,
      // Ascending part order — S3 assembles a corrupt object rather than failing
      // when the order is wrong, so the sort is load-bearing.
      parts: reconciled.parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag })),
    });
  } catch (err) {
    if (isMissingUpload(err)) {
      const verified = await verifyFinalObject({ storage, claims, label, clean });
      if (verified.ok) return succeed(verified, true);
      return terminate('NO_SUCH_UPLOAD', { abortProvider: false });
    }
    // A transient assembly failure: hand the session back to the client to retry.
    if (sessions && session) sessions.update(token, { status: 'uploading' }, now);
    return retryableFail('COMPLETE_FAILED');
  }

  // The assembled object is the last thing to verify, and a failure here deletes
  // it: a wrong-sized object must never be attachable to a room. The provider
  // upload is already consumed by Complete, so there is nothing left to abort.
  const verified = await verifyFinalObject({ storage, claims, label, clean });
  if (!verified.ok) {
    await tryDelete(storage, claims.key);
    if (sessions) sessions.markTerminal(token, 'aborted', now);
    return terminalFail(verified.error);
  }

  return succeed(verified);
}

/* -------------------------------------------------------------------------- */
/*  Abort                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Cancel an upload. Idempotent by contract: "there is nothing to abort" is
 * success, because a client retrying a cancel must not be told it failed.
 *
 * A COMPLETED session is not aborted. Its object is (or is about to be) a
 * published room source, and cancel must never delete something already playing.
 */
async function abortMultipartUpload({ token, storage, secret, roomCode, memberId, sessions, now = Date.now() }) {
  const auth = authorize({ token, secret, roomCode, memberId, now });
  if (!auth.ok) return { ok: false, error: auth.error };
  /*
   * CRITICAL: a superseded token must never reach the provider abort below.
   *
   * The old and new tokens share the same provider uploadId, so a stale holder
   * calling abort with the superseded token would tear down the multipart upload
   * the RENEWED session is still writing to. The gate refuses it outright.
   */
  const gate = lifecycleReject(sessions, token, now);
  if (gate) return gate;
  const claims = auth.claims;

  const session = sessions ? sessions.get(token) : null;
  // A completed upload is a published (or about-to-be-published) source and must
  // never be deleted by a cancel. An already-aborted/expired session is nothing
  // to abort again — idempotent success, no wasted provider round-trip.
  if (session && session.status === 'completed') return { ok: false, error: 'ALREADY_COMPLETED' };
  if (session && (session.status === 'aborted' || session.status === 'expired')) {
    return { ok: true, alreadyGone: true };
  }

  /*
   * ATOMIC: tombstone FIRST, before any provider I/O.
   *
   * The old order awaited the provider abort and only THEN marked the session
   * terminal — so during that round-trip the session still counted against the
   * member/room limits, and a fresh intent from the same member (Socket.IO
   * delivers it while this handler is parked on the provider await) raced in as
   * UPLOAD_ALREADY_ACTIVE. Marking terminal here frees the slot synchronously (and
   * the handler clears the room progress), so a reselect immediately after cancel
   * is admitted. A provider failure below must NEVER walk this back to active — the
   * capability is revoked the moment this returns, whatever the bucket does.
   */
  if (sessions) sessions.markTerminal(token, 'aborted', now);

  // No provider adapter (or none needed): the lifecycle is already closed.
  if (!storage || typeof storage.abortMultipartUpload !== 'function') {
    return { ok: true, alreadyGone: true };
  }

  // Best-effort provider abort, exactly once, AFTER the slot is freed. The
  // bucket's incomplete-multipart lifecycle rule is the final backstop, so a
  // transient failure is reported as `cleanupPending` rather than reactivating the
  // capability or failing the cancel.
  try {
    await storage.abortMultipartUpload({ key: claims.key, uploadId: claims.uploadId });
  } catch (err) {
    if (isMissingUpload(err)) return { ok: true, alreadyGone: true };
    return { ok: true, cleanupPending: true };
  }
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/*  Single-shot abort                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Cancel a SINGLE-SHOT upload's lifecycle.
 *
 * A single-shot token carries no member claim (it predates stable seats), so the
 * REGISTRY record is the authority: it must exist, be a `single` record, and match
 * the caller's room AND stable member id. There is NO provider multipart upload to
 * abort — the object either landed via one PUT or it did not — so this only
 * tombstones the lifecycle (refusing a later progress replay) and lets the handler
 * clear the room bar. Idempotent: a repeated cancel finds the aborted tombstone.
 *
 * @param {Function} verifySingle  the single-shot token verifier, injected so this
 *                                 module needs no dependency on the single token.
 * @returns {{ok:true, alreadyGone?:boolean}
 *          |{ok:false, error:'BAD_TOKEN'|'WRONG_ROOM'|'NO_SESSION'|'WRONG_TRANSPORT'|'WRONG_MEMBER'|'ALREADY_COMPLETED'}}
 */
function abortSingleUpload({ token, verifySingle, secret, roomCode, memberId, sessions, now = Date.now() }) {
  const claims = typeof verifySingle === 'function' ? verifySingle(token, secret, now) : null;
  if (!claims) return { ok: false, error: 'BAD_TOKEN' };
  if (claims.roomCode !== roomCode) return { ok: false, error: 'WRONG_ROOM' };

  const record = sessions ? sessions.get(token) : null;
  // A registry record is required: a single-shot token with no lifecycle entry has
  // nothing to abort, and its progress cannot have been broadcast in the first
  // place (registration is fail-closed, so a live upload always has a record).
  if (!record) return { ok: false, error: 'NO_SESSION' };
  if (record.transport !== 'single') return { ok: false, error: 'WRONG_TRANSPORT' };
  if (record.roomCode !== roomCode) return { ok: false, error: 'WRONG_ROOM' };
  if (record.memberId !== memberId) return { ok: false, error: 'WRONG_MEMBER' };

  // A completed single upload is a published source; cancel must not revoke it.
  if (record.status === 'completed') return { ok: false, error: 'ALREADY_COMPLETED' };
  // Idempotent: already terminal (aborted/expired) is success, no re-mutation.
  if (record.status !== 'uploading') return { ok: true, alreadyGone: true };

  sessions.markTerminal(token, 'aborted', now);
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/*  Partner progress                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Turn a client progress report into a SAFE broadcast payload.
 *
 * The uploader's client is the only thing that knows its in-flight byte count,
 * so the number has to come from it — but nothing else does. The identity is the
 * server's, the percentage is computed here, the total must equal the token's
 * pinned expected size, and no token, key, upload id, part URL or ETag is
 * anywhere in the result.
 *
 * @param {Function} verifySingle  single-shot verifier, injected so this module
 *                                 needs no dependency on the single-shot token
 * @returns {{ok:true, progress:object, immediate:boolean}|{ok:false, error:string}}
 */
function buildRoomProgress({
  mode,
  token,
  label,
  uploadedBytes,
  totalBytes,
  status,
  secret,
  roomCode,
  memberId,
  memberName,
  verifySingle,
  sessions,
  clean = passthroughClean,
  now = Date.now(),
}) {
  if (!PROGRESS_STATUSES.includes(status)) return { ok: false, error: 'BAD_STATUS' };

  let expectedBytes;
  if (mode === 'multipart') {
    const auth = authorize({ token, secret, roomCode, memberId, now });
    if (!auth.ok) return { ok: false, error: auth.error };
    expectedBytes = auth.claims.expectedBytes;
  } else if (mode === 'single') {
    // The single-shot token has no member claim (it predates stable seats), so
    // room agreement is the binding available — and the identity broadcast is
    // still the server's own record of who this socket is.
    const claims = typeof verifySingle === 'function' ? verifySingle(token, secret, now) : null;
    if (!claims) return { ok: false, error: 'BAD_TOKEN' };
    if (claims.roomCode !== roomCode) return { ok: false, error: 'WRONG_ROOM' };
    expectedBytes = claims.expectedBytes;
  } else {
    return { ok: false, error: 'BAD_MODE' };
  }

  /*
   * The lifecycle authority gate, AFTER the token is proven valid.
   *
   * A completed or aborted session still holds a valid token for a while, and
   * without this a member could re-emit progress after finishing and resurrect
   * the bar the room just cleared. The tombstone refuses it. An absent record is
   * allowed — a fresh session's first report, or a post-restart replay the signed
   * token still gates.
   */
  if (sessions && typeof sessions.progressVerdict === 'function') {
    const verdict = sessions.progressVerdict(token, now);
    if (!verdict.ok) return { ok: false, error: verdict.error };
  }

  // The client does not get to redefine the size of its own upload: a mismatch
  // means the report belongs to a different file than the token authorizes.
  if (!Number.isSafeInteger(totalBytes) || totalBytes !== expectedBytes) {
    return { ok: false, error: 'SIZE_MISMATCH' };
  }
  if (!Number.isSafeInteger(uploadedBytes) || uploadedBytes < 0) return { ok: false, error: 'BAD_PROGRESS' };

  const clamped = Math.min(uploadedBytes, expectedBytes);
  // Computed here, never accepted from the wire — a client could otherwise
  // report 100% while uploading nothing.
  const percentage = Math.min(100, Math.max(0, Math.round((clamped / expectedBytes) * 100)));

  return {
    ok: true,
    // A state change is worth interrupting the throttle for; ordinary byte
    // progress is not.
    immediate: status !== 'uploading',
    progress: {
      memberId,
      memberName,
      label: clean(label, 120) || 'a video',
      uploadedBytes: clamped,
      totalBytes: expectedBytes,
      percentage,
      status,
    },
  };
}

/**
 * Validate a provider-returned multipart upload id before it is signed into a
 * capability. An empty or absurd id would produce a token addressing nothing.
 */
function isUsableUploadId(uploadId) {
  return isBoundedString(uploadId, 512);
}

/** Re-derive the plan for a size, or null when this configuration cannot. */
function planFor(expectedBytes, partSizeBytes) {
  return planParts(expectedBytes, partSizeBytes);
}

module.exports = {
  PROGRESS_STATUSES,
  authorize,
  reconcileProviderParts,
  requestPartTargets,
  readUploadStatus,
  renewUploadSession,
  completeMultipartUpload,
  abortMultipartUpload,
  abortSingleUpload,
  buildRoomProgress,
  verifyFinalObject,
  isMissingUpload,
  isUsableUploadId,
  planFor,
};
