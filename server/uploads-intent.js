/**
 * The upload-intent operation.
 *
 * Extracted from the Socket.IO handler so the thing that is TESTED is the thing
 * that RUNS. Previously the sequence lived inline in server.js and tests
 * re-implemented it; a test can only reproduce a bug it also reproduces
 * faithfully, and the grant defect this module exists to fix was invisible
 * precisely because the test copy passed a different argument than the handler.
 *
 * The handler keeps membership, rate limiting and ack plumbing. Everything that
 * decides WHAT a client is authorized to do lives here:
 *
 *   1. validate the declared metadata
 *   2. select a transport
 *   3. derive a grant bound to THAT transport
 *   4. mint the matching token
 *   5. create a target (single) or initiate a provider session (multipart)
 *   6. return the acknowledgement payload
 *
 * Pure with respect to the network: storage, the clock and the session registry
 * are injected.
 *
 * Error vocabulary, deliberately split:
 *   - a CLIENT metadata problem keeps its stable code (BAD_SIZE, TOO_LARGE,
 *     UNSUPPORTED_TYPE) so the UI copy stays correct;
 *   - a SERVER-created grant that cannot be valid is CONFIGURATION_ERROR, never
 *     the misleading STORAGE_UNAVAILABLE it used to surface as when
 *     `issueUploadToken` threw and the handler's catch-all swallowed the reason.
 */

const { validateUploadIntent, buildObjectKey, issueUploadToken, TOKEN_TTL_MS } = require('./uploads');
const { selectUploadMode, planParts, issueMultipartToken, MAX_PART_TARGET_BATCH } = require('./uploads-multipart');
const { HARD_LOCAL_UPLOAD_BYTES, validateSingleUploadGrant } = require('./upload-limits');
const { isUsableUploadId } = require('./uploads-multipart-service');

/**
 * @param {object}  args
 * @param {object}  args.payload       client-supplied { fileName, mimeType, size }
 * @param {object}  args.uploadConfig  the frozen runtime upload configuration
 * @param {object}  args.storage       MediaStorage adapter
 * @param {string}  args.secret        UPLOAD_SECRET
 * @param {string}  args.roomCode      canonical uppercase room code
 * @param {string}  [args.memberId]    STABLE member id (required for multipart)
 * @param {object}  [args.sessions]    active-session registry
 * @param {number}  [args.now]
 * @returns {Promise<object>} the ack payload
 */
async function createUploadIntent({
  payload = {},
  uploadConfig,
  storage,
  secret,
  roomCode,
  memberId,
  sessions,
  now = Date.now(),
}) {
  /* 0. deployment availability ------------------------------------------- */
  /*
   * A deployment with hosted uploads turned OFF (production with no object
   * storage) refuses every intent before any metadata or storage work. This is
   * an EXPLICIT-false check: a config that predates the flag (older tests, the
   * staging preflight) leaves `uploadsEnabled` undefined and is unaffected, so
   * only a server that deliberately disabled uploads rejects here.
   */
  if (uploadConfig && uploadConfig.uploadsEnabled === false) {
    return { ok: false, error: 'UPLOADS_DISABLED' };
  }

  /* 1. metadata ---------------------------------------------------------- */
  const verdict = validateUploadIntent(
    { fileName: payload.fileName, mimeType: payload.mimeType, size: payload.size },
    { maxBytes: uploadConfig.effectiveMaxBytes },
  );
  if (!verdict.ok) {
    /*
     * Both ceilings, always. A client rejected with TOO_LARGE needs to know the
     * deployment maximum to say "bigger than 3 GB", and the single-shot ceiling to
     * explain WHY a 900 MB file was refused on a deployment with no bucket. One
     * number cannot express both, and the copy is wrong without them.
     */
    return {
      ok: false,
      error: verdict.error,
      maxBytes: uploadConfig.effectiveMaxBytes,
      singleShotMaxBytes: uploadConfig.singleShotMaxBytes,
    };
  }

  /* 2. transport --------------------------------------------------------- */
  const transport = selectUploadMode({
    size: verdict.size,
    singleShotMaxBytes: uploadConfig.singleShotMaxBytes,
    multipartMaxBytes: uploadConfig.multipartMaxBytes,
    multipartEnabled: uploadConfig.multipartEnabled,
    multipartMisconfigured: uploadConfig.multipartMisconfigured,
  });
  if (transport.error) {
    return {
      ok: false,
      error: transport.error,
      maxBytes: uploadConfig.effectiveMaxBytes,
      singleShotMaxBytes: uploadConfig.singleShotMaxBytes,
    };
  }

  // Server-generated key: a client-provided path is never used. The room segment
  // is canonicalised here, which is also what makes the grant's room claim and
  // the key's room segment agree by construction.
  const key = buildObjectKey(roomCode, verdict.fileName, verdict.mimeType);

  return transport.mode === 'multipart'
    ? createMultipartIntent({ verdict, key, uploadConfig, storage, secret, roomCode, memberId, sessions, now })
    : createSingleIntent({ verdict, key, uploadConfig, storage, secret, roomCode, memberId, sessions, now });
}

/* -------------------------------------------------------------------------- */
/*  Single-shot                                                               */
/* -------------------------------------------------------------------------- */

async function createSingleIntent({ verdict, key, uploadConfig, storage, secret, roomCode, memberId, sessions, now = Date.now() }) {
  /*
   * Bound to the SELECTED transport, never to the deployment.
   *
   * `verdict.maxBytes` is `effectiveMaxBytes` - up to 3 GiB with object storage
   * configured. Using it here was the defect: a client declaring 100 MiB got a
   * grant, a token and a POST policy that all authorized 3 GiB. The grant is
   * the single-shot ceiling, and the expected size is what the client declared.
   */
  const grant = {
    transport: 'single',
    key,
    mimeType: verdict.mimeType,
    roomCode,
    expectedBytes: verdict.size,
    maxBytes: uploadConfig.singleShotMaxBytes,
  };

  /*
   * Validate the SERVER's own grant before any storage call.
   *
   * This used to be left to `issueUploadToken`, which throws — and the handler's
   * catch-all turned every such throw into STORAGE_UNAVAILABLE, telling the user
   * that shared uploads were down when in fact the server had built an
   * impossible grant (a non-canonical room code, a ceiling above the hard local
   * limit). A server-side impossibility is CONFIGURATION_ERROR.
   */
  const check = validateSingleUploadGrant(grant);
  if (!check.ok || grant.maxBytes > HARD_LOCAL_UPLOAD_BYTES) {
    return { ok: false, error: 'CONFIGURATION_ERROR' };
  }

  const token = issueUploadToken(grant, secret, TOKEN_TTL_MS, now);

  /*
   * A lifecycle entry, so single-shot progress has an END — and FAIL-CLOSED.
   *
   * Single-shot uploads have no provider session and no part plan, but their
   * `upload:room-progress` can still be replayed after completion just like a
   * multipart one. A `single` record gives that progress a tombstone to
   * terminate against and the sweeper a record to clean up. It is `single`, so it
   * does NOT count against the multipart active-upload limits.
   *
   * This registers BEFORE creating any upload target, and refuses on a full
   * registry: proceeding without a lifecycle record leaves a valid token whose
   * completed/aborted progress replay is accepted as merely "absent" — the exact
   * authority gap the tombstone exists to close. Because registration comes
   * first, a refusal creates no upload target and no provider operation to strand.
   */
  if (sessions && memberId) {
    const registered = sessions.register({
      token,
      transport: 'single',
      roomCode,
      memberId,
      key,
      expectedBytes: verdict.size,
      expiresAt: now + TOKEN_TTL_MS,
      label: verdict.fileName,
      now,
    });
    if (!registered.ok) return { ok: false, error: registered.error };
  }

  // The COMPLETE grant, so the storage adapter can run the shared validator
  // before it signs anything. Reached only once a lifecycle slot is secured.
  let target;
  try {
    target = await storage.createUploadTarget({ ...grant, token });
  } catch {
    /*
     * ROLL BACK the lifecycle record. Registration is fail-closed and comes first,
     * but if signing the target then throws, the token never leaves the server —
     * so there is nothing to replay and NO tombstone is warranted. A tombstone
     * would fill the global registry with capabilities nobody ever received, and
     * enough of them would eventually trip SESSION_REGISTRY_FULL for real uploads.
     * Hard-delete the just-created record and report the storage failure.
     */
    if (sessions && memberId) sessions.remove(token);
    return { ok: false, error: 'STORAGE_UNAVAILABLE' };
  }

  return {
    ok: true,
    mode: 'single',
    key,
    token,
    method: target.method,
    uploadUrl: target.url,
    headers: target.headers || {},
    // Present for presigned POST (object storage); absent for a PUT.
    fields: target.fields || undefined,
    direct: Boolean(target.direct),
    fileName: verdict.fileName,
    expectedBytes: grant.expectedBytes,
    maxBytes: grant.maxBytes,
    // The single token's expiry, so the client's tab-scoped cleanup record can
    // drop itself once the token can no longer close the session.
    expiresAt: now + TOKEN_TTL_MS,
  };
}

/* -------------------------------------------------------------------------- */
/*  Multipart                                                                 */
/* -------------------------------------------------------------------------- */

async function createMultipartIntent({
  verdict,
  key,
  uploadConfig,
  storage,
  secret,
  roomCode,
  memberId,
  sessions,
  now,
}) {
  // A multipart session is bound to a STABLE member id. Without one there is
  // nothing to bind it to, and a socket id would break the moment the uploader
  // reconnects — which is exactly when resume matters.
  if (typeof memberId !== 'string' || memberId.length === 0) {
    return { ok: false, error: 'CONFIGURATION_ERROR' };
  }
  if (
    !storage ||
    typeof storage.createMultipartUpload !== 'function' ||
    typeof storage.createPartUploadTarget !== 'function'
  ) {
    return { ok: false, error: 'CONFIGURATION_ERROR' };
  }

  const plan = planParts(verdict.size, uploadConfig.partSizeBytes);
  // A size the configured part layout cannot describe is a configuration fault,
  // not a client error: the ceiling and the part size are both operator choices.
  if (!plan) return { ok: false, error: 'CONFIGURATION_ERROR' };

  /*
   * Admission BEFORE provider initiation.
   *
   * Checking after would leave an orphaned multipart upload in the bucket every
   * time a member hit their limit — the exact "silently orphan the first upload"
   * failure the limit exists to prevent.
   */
  if (sessions) {
    const admission = sessions.canStart(roomCode, memberId);
    if (!admission.ok) {
      return { ok: false, error: admission.error, maxActive: sessions.limits.maxPerMember };
    }
  }

  let uploadId;
  try {
    const initiated = await storage.createMultipartUpload({ key, mimeType: verdict.mimeType });
    uploadId = initiated?.uploadId;
  } catch {
    return { ok: false, error: 'STORAGE_UNAVAILABLE' };
  }
  if (!isUsableUploadId(uploadId)) return { ok: false, error: 'STORAGE_UNAVAILABLE' };

  /*
   * From here on the provider holds an open multipart upload. Anything that
   * fails must ABORT it best-effort, or the bucket accumulates an invisible
   * session per failure — billable, and only cleaned up by a lifecycle rule.
   */
  /*
   * The IMMUTABLE absolute deadline is fixed HERE, once, and re-signed unchanged
   * by every renewal. The first token's expiry is a single TTL, clamped to that
   * deadline (config guarantees the deadline is at least one TTL, so this is
   * normally just `now + TTL`). A renewal loop can extend the session up to
   * `absoluteExpiresAt` and no further.
   */
  const absoluteExpiresAt = now + uploadConfig.sessionMaxLifetimeSeconds * 1000;
  const expiresAt = Math.min(now + uploadConfig.sessionTtlSeconds * 1000, absoluteExpiresAt);
  let token;
  try {
    token = issueMultipartToken(
      {
        key,
        uploadId,
        roomCode,
        memberId,
        mimeType: verdict.mimeType,
        expectedBytes: verdict.size,
        maxBytes: uploadConfig.multipartMaxBytes,
        partSize: plan.partSize,
        partCount: plan.partCount,
        expiresAt,
        absoluteExpiresAt,
      },
      secret,
      now,
    );
  } catch {
    await abortQuietly(storage, key, uploadId);
    return { ok: false, error: 'CONFIGURATION_ERROR' };
  }

  try {
    if (sessions) {
      const registered = sessions.register({
        token,
        roomCode,
        memberId,
        key,
        uploadId,
        expectedBytes: verdict.size,
        partCount: plan.partCount,
        expiresAt,
        label: verdict.fileName,
        now,
      });
      /*
       * Registration is fail-closed now. A full registry must NOT strand the
       * provider multipart upload just created: abort it best-effort before
       * refusing, or every rejected intent leaves an invisible, billable session
       * behind for the bucket's lifecycle rule to eventually reap.
       */
      if (!registered.ok) {
        await abortQuietly(storage, key, uploadId);
        return { ok: false, error: registered.error };
      }
    }

    return {
      ok: true,
      mode: 'multipart',
      token,
      key,
      uploadId,
      fileName: verdict.fileName,
      mimeType: verdict.mimeType,
      expectedBytes: verdict.size,
      maxBytes: uploadConfig.multipartMaxBytes,
      partSize: plan.partSize,
      partCount: plan.partCount,
      lastPartSize: plan.lastPartSize,
      concurrency: uploadConfig.partConcurrency,
      retries: uploadConfig.partRetries,
      maxPartBatch: MAX_PART_TARGET_BATCH,
      expiresAt,
      partUrlTtlSeconds: uploadConfig.partUrlTtlSeconds,
    };
  } catch {
    // Registration or payload construction failed after the provider committed:
    // do not leave the multipart upload behind.
    await abortQuietly(storage, key, uploadId);
    return { ok: false, error: 'STORAGE_UNAVAILABLE' };
  }
}

async function abortQuietly(storage, key, uploadId) {
  if (!storage || typeof storage.abortMultipartUpload !== 'function') return;
  try {
    await storage.abortMultipartUpload({ key, uploadId });
  } catch {
    /* best effort — the bucket's incomplete-multipart rule is the backstop */
  }
}

module.exports = { createUploadIntent };
