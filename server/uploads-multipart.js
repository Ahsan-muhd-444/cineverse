/**
 * Resumable multipart upload core — configuration, part planning and the
 * multipart session token.
 *
 * Pure and dependency-free (node:crypto only) so every rule here is unit
 * testable without booting a server or touching a bucket — see
 * scripts/uploads-multipart.test.mjs.
 *
 * Why this module exists at all: the original pipeline minted ONE presigned
 * POST and let the browser send the whole file in a single request. That shape
 * cannot carry a 3 GiB movie — the browser has to hold the body, a single
 * failure restarts from zero, and there is no way to resume. Raising
 * MAX_UPLOAD_BYTES alone would only move the failure later.
 *
 * The multipart shape instead:
 *   - the SERVER owns the plan (part size, part count) and signs it into a
 *     token, so the client cannot renegotiate its own limits;
 *   - the browser PUTs each part straight to object storage;
 *   - a part can be retried, re-signed, paused or resumed independently.
 *
 * Bytes never enter this process. This module only ever sees numbers.
 */

const crypto = require('crypto');
// The key/MIME rules live in uploads.js and are already the gate for the
// single-shot path. Reused rather than re-expressed: two copies of "what is a
// valid object key" is exactly how a bypass appears later.
const { isValidKey, isAllowedMime } = require('./uploads');
const {
  HARD_MAX_BYTES,
  DEFAULT_MAX_BYTES,
  HARD_LOCAL_UPLOAD_BYTES,
  S3_MAX_PART_COUNT,
  MAX_ETAG_LENGTH,
  ROOM_CODE_PATTERN,
  extensionFor,
  roomFromKey,
  normalizeEtag,
  isPositiveSafeInteger,
  isBoundedString,
  isStrongUploadSecret,
} = require('./upload-limits');

/** S3 multipart floor for every part except the last. */
const S3_MIN_PART_BYTES = 5 * 1024 * 1024;

/** Most part numbers a single `upload:part-targets` call may ask to sign. */
const MAX_PART_TARGET_BATCH = 20;

const MIB = 1024 * 1024;

const DEFAULTS = Object.freeze({
  /**
   * The CODE default stays the pre-existing 500 MiB, not 3 GiB.
   *
   * docs/uploads.md recommends `MAX_UPLOAD_BYTES=3221225472` in the environment
   * of a deployment that HAS object storage. Making that the fallback too would
   * mean every existing deployment WITHOUT a bucket suddenly fails to boot,
   * since "max above the local ceiling with no object storage" is fatal.
   * Keeping the historical default means this change moves nobody's limit; an
   * explicit request for 3 GiB without a bucket is still a hard error, which is
   * the rule that actually matters.
   *
   * Shared with the single-shot path via uploads.js so the two can never drift.
   */
  maxUploadBytes: DEFAULT_MAX_BYTES,
  localMaxUploadBytes: DEFAULT_MAX_BYTES,
  partSizeBytes: 16 * MIB,
  partConcurrency: 3,
  partRetries: 5,
  sessionTtlSeconds: 6 * 60 * 60,
  /*
   * The IMMUTABLE absolute lifetime of a session, from intent to its last legal
   * renewal. `sessionTtlSeconds` is how long ONE token lives; this is the ceiling
   * a renewal loop can NEVER walk past — fixed when the intent is created and
   * re-signed unchanged on every renewal. Without it a 6h session renewed every
   * 5h would live for days. 24h comfortably covers a 3 GiB upload on a slow-real
   * line (~3.5h) with room for reconnects, while bounding the window a leaked
   * token stays renewable.
   */
  sessionMaxLifetimeSeconds: 24 * 60 * 60,
  partUrlTtlSeconds: 15 * 60,
  /*
   * Concurrent multipart uploads. One per member because a second upload from
   * the same person almost always means "I picked the wrong file" — and starting
   * it must not silently orphan the first, so the answer is a clear
   * UPLOAD_ALREADY_ACTIVE the UI can turn into "cancel the current upload first".
   * Two per room lets both members upload at once without a room becoming a
   * bulk-upload endpoint.
   */
  maxActivePerMember: 1,
  maxActivePerRoom: 2,
});

const BOUNDS = Object.freeze({
  partSizeMin: 8 * MIB,
  partSizeMax: 64 * MIB,
  concurrencyMin: 1,
  concurrencyMax: 6,
  retriesMin: 0,
  retriesMax: 10,
  // A 3 GiB upload on a slow-but-real line (≈2 Mbit/s) needs ~3.5 hours; the
  // floor keeps a session from expiring underneath an upload that is working.
  sessionTtlMin: 15 * 60,
  sessionTtlMax: 24 * 60 * 60,
  // The absolute lifetime ceiling. Floor matches a single session's minimum TTL
  // (a shorter absolute deadline than one session would be self-defeating); the
  // 72h cap keeps even a generous deployment's renewable window finite.
  sessionMaxLifetimeMin: 15 * 60,
  sessionMaxLifetimeMax: 72 * 60 * 60,
  partUrlTtlMin: 60,
  partUrlTtlMax: 60 * 60,
  activePerMemberMin: 1,
  activePerMemberMax: 3,
  activePerRoomMin: 1,
  activePerRoomMax: 6,
});

const isSet = (v) => v !== undefined && v !== null && String(v).trim() !== '';

/** Strict integer parse — "16MB", "1e3", 1.5 and NaN are all rejected. */
function intFromEnv(raw) {
  const text = String(raw).trim();
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Read and validate every multipart-upload setting.
 *
 * Returns `{ config, errors, warnings }`. The caller decides fatality; in
 * production server/config.js refuses to boot on any error, because a silently
 * wrong part size or an unenforced ceiling is exactly the class of bug that
 * only shows up on a customer's 3 GB file.
 */
function readMultipartConfig(env = process.env) {
  const errors = [];
  const warnings = [];
  const config = { ...DEFAULTS };

  const unitFor = (key) => {
    if (key.endsWith('SECONDS')) return 'seconds';
    if (key.endsWith('BYTES')) return 'bytes';
    return 'units';
  };
  const numeric = (key, target, { min, max }) => {
    if (!isSet(env[key])) return;
    const value = intFromEnv(env[key]);
    if (value === null) {
      errors.push(`${key} must be a whole number of ${unitFor(key)} (got "${env[key]}")`);
      return;
    }
    if (value < min || value > max) {
      errors.push(`${key} must be between ${min} and ${max} (got ${value})`);
      return;
    }
    config[target] = value;
  };

  // MAX_UPLOAD_BYTES is special: the upper bound is the product ceiling, and
  // exceeding it must never be rounded down silently into "supported".
  if (isSet(env.MAX_UPLOAD_BYTES)) {
    const value = intFromEnv(env.MAX_UPLOAD_BYTES);
    if (value === null || value < 1) {
      errors.push(`MAX_UPLOAD_BYTES must be a whole number of bytes >= 1 (got "${env.MAX_UPLOAD_BYTES}")`);
    } else if (value > HARD_MAX_BYTES) {
      errors.push(
        `MAX_UPLOAD_BYTES must not exceed ${HARD_MAX_BYTES} bytes (3 GiB) — got ${value}. ` +
          'The shared-upload pipeline is only validated to 3 GiB.',
      );
    } else {
      config.maxUploadBytes = value;
    }
  }

  if (isSet(env.LOCAL_UPLOAD_MAX_BYTES)) {
    const value = intFromEnv(env.LOCAL_UPLOAD_MAX_BYTES);
    if (value === null || value < 1) {
      errors.push(`LOCAL_UPLOAD_MAX_BYTES must be a whole number of bytes >= 1 (got "${env.LOCAL_UPLOAD_MAX_BYTES}")`);
    } else if (value > config.maxUploadBytes) {
      // Only an EXPLICIT local ceiling above the global one is a contradiction.
      errors.push(`LOCAL_UPLOAD_MAX_BYTES (${value}) must not exceed MAX_UPLOAD_BYTES (${config.maxUploadBytes})`);
    } else if (value > HARD_LOCAL_UPLOAD_BYTES) {
      // The dev filesystem adapter streams through Node. No environment
      // variable may raise that ceiling — only lower it.
      errors.push(
        `LOCAL_UPLOAD_MAX_BYTES (${value}) must not exceed the hard local ceiling of ` +
          `${HARD_LOCAL_UPLOAD_BYTES} bytes. Larger shared uploads require object storage.`,
      );
    } else {
      config.localMaxUploadBytes = value;
    }
  } else {
    // Unset: the local ceiling follows the configured maximum down, but is
    // never allowed above the hard local ceiling. Leaving it at its own default
    // would make a deliberately SMALL MAX_UPLOAD_BYTES look like a
    // misconfiguration.
    config.localMaxUploadBytes = Math.min(
      config.localMaxUploadBytes,
      config.maxUploadBytes,
      HARD_LOCAL_UPLOAD_BYTES,
    );
  }

  // No small-part escape hatch. An earlier revision let non-production relax the
  // floor to 1 KiB so tests could make many parts from a tiny file — but
  // `planParts()` still enforces the provider's own 5 MiB minimum, so that
  // configuration validated successfully and then failed to plan. Integration
  // tests use a small-but-legal fixture instead (17 MiB / 8 MiB parts = 3
  // parts), which exercises multi-part behaviour under the REAL constraints.
  numeric('UPLOAD_PART_SIZE_BYTES', 'partSizeBytes', { min: BOUNDS.partSizeMin, max: BOUNDS.partSizeMax });
  numeric('UPLOAD_PART_CONCURRENCY', 'partConcurrency', { min: BOUNDS.concurrencyMin, max: BOUNDS.concurrencyMax });
  numeric('UPLOAD_PART_RETRIES', 'partRetries', { min: BOUNDS.retriesMin, max: BOUNDS.retriesMax });
  numeric('UPLOAD_SESSION_TTL_SECONDS', 'sessionTtlSeconds', { min: BOUNDS.sessionTtlMin, max: BOUNDS.sessionTtlMax });
  numeric('UPLOAD_SESSION_MAX_LIFETIME_SECONDS', 'sessionMaxLifetimeSeconds', {
    min: BOUNDS.sessionMaxLifetimeMin,
    max: BOUNDS.sessionMaxLifetimeMax,
  });
  numeric('UPLOAD_PART_URL_TTL_SECONDS', 'partUrlTtlSeconds', { min: BOUNDS.partUrlTtlMin, max: BOUNDS.partUrlTtlMax });

  // An absolute lifetime shorter than a single session's TTL is self-defeating:
  // the very first token would already reach the deadline, so no session could
  // live out even one full TTL. The absolute ceiling must be at least one TTL.
  if (config.sessionMaxLifetimeSeconds < config.sessionTtlSeconds) {
    errors.push(
      `UPLOAD_SESSION_MAX_LIFETIME_SECONDS (${config.sessionMaxLifetimeSeconds}) must not be below ` +
        `UPLOAD_SESSION_TTL_SECONDS (${config.sessionTtlSeconds})`,
    );
  }
  numeric('UPLOAD_MAX_ACTIVE_PER_MEMBER', 'maxActivePerMember', {
    min: BOUNDS.activePerMemberMin,
    max: BOUNDS.activePerMemberMax,
  });
  numeric('UPLOAD_MAX_ACTIVE_PER_ROOM', 'maxActivePerRoom', {
    min: BOUNDS.activePerRoomMin,
    max: BOUNDS.activePerRoomMax,
  });
  // A room cap below the per-member cap is self-contradictory: the member limit
  // could never be reached, so one of the two numbers is a typo.
  if (config.maxActivePerRoom < config.maxActivePerMember) {
    errors.push(
      `UPLOAD_MAX_ACTIVE_PER_ROOM (${config.maxActivePerRoom}) must not be below ` +
        `UPLOAD_MAX_ACTIVE_PER_MEMBER (${config.maxActivePerMember})`,
    );
  }

  // A plan that cannot physically describe the ceiling is a config error, not a
  // runtime surprise on someone's 3 GB file.
  const worstCaseParts = Math.ceil(config.maxUploadBytes / config.partSizeBytes);
  if (worstCaseParts > S3_MAX_PART_COUNT) {
    errors.push(
      `UPLOAD_PART_SIZE_BYTES ${config.partSizeBytes} would need ${worstCaseParts} parts for ` +
        `MAX_UPLOAD_BYTES ${config.maxUploadBytes}, above the ${S3_MAX_PART_COUNT}-part limit`,
    );
  }

  if (config.partUrlTtlSeconds > config.sessionTtlSeconds) {
    warnings.push(
      'UPLOAD_PART_URL_TTL_SECONDS is longer than UPLOAD_SESSION_TTL_SECONDS — part URLs will outlive their session',
    );
  }

  return { config, errors, warnings };
}

/**
 * Whether this configuration requires object storage to be present.
 *
 * Above the local ceiling the dev filesystem adapter is not an option: it would
 * mean streaming gigabytes through Node, which is the exact thing this design
 * exists to avoid.
 */
function requiresObjectStorage(config) {
  // Against the HARD ceiling, not the configurable one. Comparing to
  // `localMaxUploadBytes` was the bypass: raising both values in lockstep made
  // this false, so startup allowed local-fs to serve a 3 GiB limit.
  return config.maxUploadBytes > HARD_LOCAL_UPLOAD_BYTES;
}

/** The largest upload an adapter will actually accept right now. */
function effectiveMaxBytes(config, { objectStorage }) {
  if (objectStorage) return Math.min(config.maxUploadBytes, HARD_MAX_BYTES);
  // Three-way minimum: the hard local ceiling is the term no environment can
  // move, so the Node adapter can never be handed a multi-gigabyte file.
  return Math.min(config.maxUploadBytes, config.localMaxUploadBytes, HARD_LOCAL_UPLOAD_BYTES);
}

/** The five provider operations a multipart session needs, in call order. */
const MULTIPART_STORAGE_METHODS = Object.freeze([
  'createMultipartUpload',
  'createPartUploadTarget',
  'listMultipartParts',
  'completeMultipartUpload',
  'abortMultipartUpload',
]);

/**
 * Is the running system actually able to carry a multipart upload?
 *
 * This replaces a hardcoded `multipartEnabled: false`. A literal is the wrong
 * shape for the question: enablement is a conjunction of capabilities, and the
 * ones that matter are the ones an operator can get half-right — a bucket with
 * no stable secret, an adapter that advertises multipart but is missing a
 * method, a build where the socket handlers were removed.
 *
 * `contradictory` is the case that must NOT quietly become a single request: an
 * adapter claiming `multipart: true` while missing operations is misconfigured,
 * not merely unavailable, and a large file must be refused with
 * CONFIGURATION_ERROR rather than routed to a transport that cannot carry it.
 *
 * @returns {{enabled:boolean, contradictory:boolean, reason:string|null, missing:string[]}}
 */
/**
 * The events a mounted contract descriptor must list for multipart to be ready.
 * Kept here (not imported from uploads-contract.js) so this module stays free of
 * the socket layer and importable by pure tests; the two lists are proven equal
 * by scripts/uploads-contract.test.mjs.
 */
const REQUIRED_CONTRACT_EVENTS = Object.freeze([
  'upload:intent',
  'upload:part-targets',
  'upload:status',
  'upload:renew',
  'upload:complete',
  'upload:abort',
  'upload:room-progress',
]);

/**
 * Is a contract descriptor complete enough to carry multipart?
 *
 * Not `contract.mounted` alone: a descriptor could claim mounted while listing an
 * incomplete event set (a build that dropped a handler). Readiness requires the
 * descriptor to be mounted AND to list every required event, and the
 * registration test proves the descriptor's list matches what actually gets
 * attached — so this is derived from a real capability, not a bare boolean.
 *
 * @returns {{ok:true} | {ok:false, reason:string}}
 */
function contractIsComplete(contract) {
  if (!contract || typeof contract !== 'object') return { ok: false, reason: 'the multipart socket contract is not mounted' };
  if (contract.mounted !== true) return { ok: false, reason: 'the multipart socket contract is not mounted' };
  const events = Array.isArray(contract.events) ? contract.events : [];
  const missing = REQUIRED_CONTRACT_EVENTS.filter((name) => !events.includes(name));
  if (missing.length > 0) return { ok: false, reason: `the socket contract is missing ${missing.join(', ')}` };
  return { ok: true };
}

function deriveMultipartReadiness({ objectStorage, secret, secretStrong, storage, contract } = {}) {
  const strong = secretStrong !== undefined ? Boolean(secretStrong) : isStrongUploadSecret(secret);
  const adapter = storage && typeof storage === 'object' ? storage : null;
  const claimsMultipart = Boolean(adapter && adapter.multipart === true);
  const missing = adapter
    ? MULTIPART_STORAGE_METHODS.filter((name) => typeof adapter[name] !== 'function')
    : [...MULTIPART_STORAGE_METHODS];

  /*
   * An adapter that ADVERTISES multipart but cannot perform it is
   * self-contradictory: either an operation is missing, or it wants the bytes to
   * come through this process. Absent support (`multipart` unset) is not a
   * contradiction — that is just the dev filesystem adapter being itself.
   */
  const contradictory = claimsMultipart && (missing.length > 0 || adapter.direct !== true);

  const fail = (reason) => ({ enabled: false, contradictory, reason, missing });

  if (!objectStorage) return fail('object storage is not configured');
  if (!adapter) return fail('no storage adapter');
  if (adapter.direct !== true) return fail('the storage adapter routes bytes through this process');
  if (!claimsMultipart) return fail('the storage adapter does not advertise multipart support');
  if (missing.length > 0) return fail(`the storage adapter is missing ${missing.join(', ')}`);
  // A per-boot random secret cannot resume a session across a deploy, and a weak
  // one is guessable while looking durable. Either way it must not sign a
  // six-hour capability for writing gigabytes.
  if (!strong) return fail(`UPLOAD_SECRET must be a stable value of at least 32 bytes`);
  // DERIVED from the registered contract descriptor, not a free-standing boolean.
  const contractOk = contractIsComplete(contract);
  if (!contractOk.ok) return fail(contractOk.reason);

  return { enabled: true, contradictory: false, reason: null, missing: [] };
}

/**
 * THE upload configuration. One object, derived once at startup, used by
 * configuration reporting, `upload:intent` validation, storage selection, the
 * local effective maximum, multipart planning and the startup log.
 *
 * Before this existed, `uploads.js::maxUploadBytes()` parsed MAX_UPLOAD_BYTES
 * independently of `readMultipartConfig()`. The two could disagree — most
 * sharply when a value was REJECTED here as invalid but silently accepted
 * there, so the process refused to boot on a number the runtime would have
 * honoured, or worse, booted while advertising a limit nothing enforced.
 *
 * `effectiveMaxBytes` is the number the runtime actually honours: with no
 * object storage it is the local ceiling, never the requested maximum. The
 * startup log prints THIS, so an operator is never told 3 GB by a process that
 * will reject anything over 500 MiB.
 */
function createUploadRuntimeConfig(env = process.env, opts = {}) {
  const report = readMultipartConfig(env);
  const objectStorage =
    opts.objectStorage !== undefined
      ? Boolean(opts.objectStorage)
      : // Lazy so this module stays importable by pure tests with no adapter.
        require('./storage').isS3Configured(env);

  const effective = effectiveMaxBytes(report.config, { objectStorage });

  /*
   * Transport ceilings, separate from the configured one.
   *
   * `effectiveMaxBytes` is the capability this deployment is configured for.
   * It is NOT what the running code can carry: the only implemented transport
   * is the legacy one-request POST/PUT, which must never receive a
   * multi-gigabyte body. `singleShotMaxBytes` is therefore clamped to the hard
   * local ceiling regardless of storage, and `multipartMaxBytes` records the
   * capacity waiting for the socket contract.
   */
  /*
   * DERIVED, not asserted. `multipartEnabled` used to be a hardcoded `false`
   * waiting for the socket contract; it is now the conjunction of the
   * capabilities the transport actually needs, so half a configuration can never
   * present itself as a working 3 GB pipeline.
   */
  const readiness = deriveMultipartReadiness({
    objectStorage,
    secret: env.UPLOAD_SECRET,
    secretStrong: opts.secretStrong,
    storage: opts.storage,
    // server.js passes the frozen UPLOAD_CONTRACT descriptor it actually mounts.
    // A build that dropped a handler yields an incomplete descriptor and is
    // honestly reported as "contract not mounted / missing events" rather than
    // advertising a transport nothing answers. `contractMounted` is still
    // accepted as a legacy boolean for callers that only care about the flag.
    contract:
      opts.contract !== undefined
        ? opts.contract
        : opts.contractMounted
          ? { mounted: true, events: REQUIRED_CONTRACT_EVENTS }
          : { mounted: false, events: [] },
  });

  /*
   * The single-shot ceiling can only be LOWERED, never raised.
   *
   * `opts.singleShotMaxBytes` exists for ONE caller: the test harness, which
   * lowers it so a small legal fixture routes to multipart without a 3 GB file.
   * It is clamped to the real ceiling, so it can only ever shrink the single-shot
   * window — never widen it past the hard local limit.
   */
  const naturalSingleShot = Math.min(effective, HARD_LOCAL_UPLOAD_BYTES);
  const singleShotMaxBytes =
    Number.isSafeInteger(opts.singleShotMaxBytes) && opts.singleShotMaxBytes > 0
      ? Math.min(opts.singleShotMaxBytes, naturalSingleShot)
      : naturalSingleShot;

  const config = Object.freeze({
    ...report.config,
    objectStorage,
    configuredMaxBytes: report.config.maxUploadBytes,
    effectiveMaxBytes: effective,
    singleShotMaxBytes,
    multipartMaxBytes: objectStorage ? effective : 0,
    multipartEnabled: readiness.enabled,
    // A misconfigured-but-advertised adapter must fail closed rather than fall
    // back to a single request that cannot carry the file.
    multipartMisconfigured: readiness.contradictory,
    multipartReadiness: Object.freeze({ ...readiness, missing: Object.freeze([...readiness.missing]) }),
  });

  return { config, errors: report.errors, warnings: report.warnings };
}

/**
 * Choose the transport for a validated file size — BEFORE any storage call.
 *
 * The configured ceiling and the ceilings the running system can actually
 * carry are different things. Today `configuredMaxBytes` may be 3 GiB while the
 * only implemented transport is the legacy one-request POST, which must never
 * be handed a multi-gigabyte file: the browser would have to hold the whole
 * body, and a single failure would restart from zero.
 *
 * Pure and import-safe so both the handler and its tests use the same rules.
 *
 * @returns {{mode:'single'|'multipart'} | {error:string}}
 */
function selectUploadMode({ size, singleShotMaxBytes, multipartMaxBytes, multipartEnabled, multipartMisconfigured }) {
  if (!Number.isSafeInteger(size) || size <= 0) return { error: 'BAD_SIZE' };

  const single = Number.isSafeInteger(singleShotMaxBytes) && singleShotMaxBytes >= 0 ? singleShotMaxBytes : 0;
  const multi = Number.isSafeInteger(multipartMaxBytes) && multipartMaxBytes >= 0 ? multipartMaxBytes : 0;

  // Multipart advertised but with no capacity behind it is a server-side
  // contradiction, not a client error — say so distinctly.
  if (multipartEnabled && multi <= 0) return { error: 'CONFIGURATION_ERROR' };

  /*
   * A contradictory adapter (advertises multipart, cannot perform it) fails
   * closed for anything the single-shot transport cannot carry. Falling through
   * to MULTIPART_REQUIRED would be a lie — the transport is not missing, it is
   * broken — and falling through to `single` would hand a multi-gigabyte body to
   * the one path that must never receive one.
   */
  if (multipartMisconfigured && size > single) return { error: 'CONFIGURATION_ERROR' };

  /*
   * CAPACITY, not enablement, defines "too large".
   *
   * `multipartMaxBytes` is what object storage could carry; `multipartEnabled`
   * is whether the socket contract exists yet. A 3 GiB file with a bucket
   * configured is within capacity, so the honest answer is MULTIPART_REQUIRED
   * ("this needs a transport we have not shipped"), not TOO_LARGE ("your file
   * is bigger than we support"). Gating the ceiling on enablement would tell
   * the operator their 3 GiB limit does not exist.
   */
  const ceiling = Math.max(single, multi);
  if (size > ceiling) return { error: 'TOO_LARGE' };

  if (size <= single) return { mode: 'single' };
  // Above the single-shot cap: only multipart can carry it.
  return multipartEnabled ? { mode: 'multipart' } : { error: 'MULTIPART_REQUIRED' };
}

/* -------------------------------------------------------------------------- */
/*  Part planning                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Deterministically split a byte count into parts.
 *
 * Deterministic matters: the client slices with `File.slice()` using exactly
 * this plan, and `upload:complete` re-derives it from the token. If the two
 * disagreed by one byte the completed object would be corrupt in a way no HEAD
 * check could detect.
 *
 * @returns {{partSize:number, partCount:number, lastPartSize:number} | null}
 */
function planParts(totalBytes, partSize) {
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) return null;
  if (!Number.isSafeInteger(partSize) || partSize <= 0) return null;

  const partCount = Math.ceil(totalBytes / partSize);
  if (partCount > S3_MAX_PART_COUNT) return null;

  const lastPartSize = totalBytes - (partCount - 1) * partSize;
  // Every part but the last must clear the provider floor. A single-part upload
  // is exempt: S3 allows a lone part of any size.
  if (partCount > 1 && partSize < S3_MIN_PART_BYTES) return null;

  return { partSize, partCount, lastPartSize };
}

/** Byte range for one 1-based part number, or null when out of range. */
function partRange(partNumber, plan, totalBytes) {
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > plan.partCount) return null;
  const start = (partNumber - 1) * plan.partSize;
  const end = Math.min(start + plan.partSize, totalBytes);
  return { start, end, size: end - start };
}

/**
 * Validate a batch of requested part numbers.
 * Bounded, unique, integral and in range — a client must not be able to make
 * the server sign 10,000 URLs, or sign part 0 / part -1 / part 1e9.
 */
function validatePartNumbers(input, partCount, maxBatch = MAX_PART_TARGET_BATCH) {
  if (!Array.isArray(input) || input.length === 0) return { ok: false, error: 'BAD_PARTS' };
  if (input.length > maxBatch) return { ok: false, error: 'TOO_MANY_PARTS' };

  const seen = new Set();
  for (const raw of input) {
    if (!Number.isInteger(raw) || raw < 1 || raw > partCount) return { ok: false, error: 'BAD_PARTS' };
    if (seen.has(raw)) return { ok: false, error: 'DUPLICATE_PART' };
    seen.add(raw);
  }
  return { ok: true, partNumbers: [...seen].sort((a, b) => a - b) };
}

/* ETag validation is shared with the storage adapter — see upload-limits.js. */

/**
 * Validate the completion manifest: exactly the planned parts, each exactly
 * once, each with a plausible ETag. No missing parts, no extras, no
 * re-ordering — S3 would happily assemble a corrupt object otherwise.
 */
function validateCompletionParts(parts, partCount) {
  if (!Array.isArray(parts)) return { ok: false, error: 'BAD_PARTS' };
  if (parts.length !== partCount) return { ok: false, error: 'PART_COUNT_MISMATCH' };

  const seen = new Map();
  for (const entry of parts) {
    if (!entry || typeof entry !== 'object') return { ok: false, error: 'BAD_PARTS' };
    const number = entry.partNumber;
    if (!Number.isInteger(number) || number < 1 || number > partCount) return { ok: false, error: 'BAD_PARTS' };
    if (seen.has(number)) return { ok: false, error: 'DUPLICATE_PART' };
    const etag = normalizeEtag(entry.etag);
    if (!etag) return { ok: false, error: 'BAD_ETAG' };
    seen.set(number, etag);
  }
  for (let n = 1; n <= partCount; n += 1) {
    if (!seen.has(n)) return { ok: false, error: 'MISSING_PART' };
  }

  const sorted = [...seen.keys()].sort((a, b) => a - b).map((partNumber) => ({ partNumber, etag: seen.get(partNumber) }));
  return { ok: true, parts: sorted };
}

/* -------------------------------------------------------------------------- */
/*  Multipart session token                                                   */
/* -------------------------------------------------------------------------- */

const TOKEN_VERSION = 1;
const b64url = (buf) => Buffer.from(buf).toString('base64url');

/**
 * Hard ceiling on the token string itself.
 *
 * Every claim is bounded below, so a legitimate token is ~400 bytes. Checking
 * the length FIRST means a multi-megabyte string from a hostile client is
 * rejected before it reaches JSON.parse or an HMAC over its whole length.
 */
const MAX_TOKEN_LENGTH = 2048;
const MAX_UPLOAD_ID_LENGTH = 512;
const MAX_ROOM_CODE_LENGTH = 12;
const MAX_MEMBER_ID_LENGTH = 128;

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/* -------------------------------------------------------------------------- */
/*  The multipart grant contract                                              */
/* -------------------------------------------------------------------------- */

/**
 * ONE definition of a valid multipart upload grant.
 *
 * The single-shot path already has `validateSingleUploadGrant`; this is its
 * multipart twin, and it exists because the multipart claim set had the same
 * class of hole the single-shot one did: `verifyMultipartToken` validated the
 * room and the key INDEPENDENTLY and never proved the key belonged to the
 * claimed room. A forged token (leaked secret) could therefore pair room A's
 * claim — which `authorizeSession` happily matches against the caller's own
 * room — with a key under room B's prefix.
 *
 * Everything is re-derived rather than trusted, including the part plan: the
 * client slices with `File.slice()` using exactly this plan, so a plan the
 * server would not itself have produced must never be honoured.
 *
 * @param {object} grant
 * @param {object} [opts]
 * @param {number} [opts.now]           clock, for the expiry check
 * @param {boolean} [opts.requireFuture] enforce `expiresAt > now` (verification)
 * @param {object} [opts.bounds]        part-size bounds (defaults to BOUNDS)
 * @returns {{ok:true, plan:{partSize:number,partCount:number,lastPartSize:number}}
 *          |{ok:false, error:string}}
 */
function validateMultipartUploadGrant(grant, opts = {}) {
  if (!grant || typeof grant !== 'object') return { ok: false, error: 'BAD_GRANT' };
  const bounds = opts.bounds || BOUNDS;

  if (grant.transport !== 'multipart') return { ok: false, error: 'BAD_TRANSPORT' };

  if (!isValidKey(grant.key)) return { ok: false, error: 'BAD_KEY' };
  if (!isAllowedMime(grant.mimeType)) return { ok: false, error: 'UNSUPPORTED_TYPE' };
  // The stored object's name must agree with the type it is signed for.
  if (!String(grant.key).toLowerCase().endsWith(extensionFor(grant.mimeType))) {
    return { ok: false, error: 'KEY_TYPE_MISMATCH' };
  }

  // Canonical uppercase, compared EXACTLY — never case-folded. See
  // ROOM_CODE_PATTERN in upload-limits.js for why folding was a defect.
  if (typeof grant.roomCode !== 'string' || !ROOM_CODE_PATTERN.test(grant.roomCode)) {
    return { ok: false, error: 'BAD_ROOM' };
  }
  const keyRoom = roomFromKey(grant.key);
  if (keyRoom === null || keyRoom !== grant.roomCode) return { ok: false, error: 'ROOM_KEY_MISMATCH' };

  // Opaque provider id and the STABLE member id (not a socket id) the session
  // is bound to. Both bounded so a forged token cannot carry a payload bomb.
  if (!isBoundedString(grant.uploadId, MAX_UPLOAD_ID_LENGTH)) return { ok: false, error: 'BAD_UPLOAD_ID' };
  if (!isBoundedString(grant.memberId, MAX_MEMBER_ID_LENGTH)) return { ok: false, error: 'BAD_MEMBER' };

  const { expectedBytes, maxBytes } = grant;
  if (!isPositiveSafeInteger(expectedBytes) || expectedBytes > HARD_MAX_BYTES) {
    return { ok: false, error: 'BAD_SIZE' };
  }
  if (!isPositiveSafeInteger(maxBytes) || maxBytes > HARD_MAX_BYTES) return { ok: false, error: 'BAD_LIMIT' };
  if (expectedBytes > maxBytes) return { ok: false, error: 'SIZE_EXCEEDS_LIMIT' };

  if (!isPositiveSafeInteger(grant.partSize)) return { ok: false, error: 'BAD_PART_SIZE' };
  if (grant.partSize < bounds.partSizeMin || grant.partSize > bounds.partSizeMax) {
    return { ok: false, error: 'BAD_PART_SIZE' };
  }
  if (!isPositiveSafeInteger(grant.partCount) || grant.partCount > S3_MAX_PART_COUNT) {
    return { ok: false, error: 'BAD_PART_COUNT' };
  }

  /*
   * Re-DERIVE the plan instead of checking the claimed numbers against each
   * other. `ceil(expectedBytes / partSize) === partCount` alone would accept a
   * plan whose final part is illegal, and `planParts` is the same function the
   * intent handler used to build the plan in the first place — so agreement here
   * means the client is slicing exactly what the server planned.
   */
  const plan = planParts(expectedBytes, grant.partSize);
  if (!plan) return { ok: false, error: 'PLAN_MISMATCH' };
  if (plan.partCount !== grant.partCount) return { ok: false, error: 'PLAN_MISMATCH' };
  // A claimed final-part size is honoured only if it is the one we derive.
  if (grant.lastPartSize !== undefined && grant.lastPartSize !== plan.lastPartSize) {
    return { ok: false, error: 'PLAN_MISMATCH' };
  }

  if (!isPositiveSafeInteger(grant.expiresAt)) return { ok: false, error: 'BAD_EXPIRY' };
  if (opts.requireFuture) {
    const now = Number.isFinite(opts.now) ? opts.now : Date.now();
    if (grant.expiresAt <= now) return { ok: false, error: 'EXPIRED' };
  }

  /*
   * The IMMUTABLE absolute deadline. Optional, for backward compatibility with a
   * token minted before this field existed; when present it must be a real bound
   * that the current expiry does not exceed. A renewal re-signs it UNCHANGED, so
   * this — not the per-token TTL — is what stops a renewal loop from extending a
   * session forever.
   */
  if (grant.absoluteExpiresAt !== undefined) {
    if (!isPositiveSafeInteger(grant.absoluteExpiresAt)) return { ok: false, error: 'BAD_ABSOLUTE_EXPIRY' };
    if (grant.expiresAt > grant.absoluteExpiresAt) return { ok: false, error: 'EXPIRY_EXCEEDS_LIFETIME' };
  }

  return { ok: true, plan };
}


/**
 * Mint a session token pinning the ENTIRE plan.
 *
 * Everything the server will later trust is inside the signature: which member,
 * which room, which object, which multipart upload, how big, what type, and the
 * exact part layout. A client that edits any of it invalidates the signature,
 * so `upload:part-targets` and `upload:complete` need no server-side session
 * store and survive a restart (given a stable UPLOAD_SECRET).
 */
function issueMultipartToken(payload, secret, now = Date.now()) {
  const expiresAt = payload.expiresAt ?? (Number.isSafeInteger(payload.ttlMs) ? now + payload.ttlMs : NaN);
  // The immutable absolute deadline, fixed at intent and re-signed unchanged on
  // every renewal. Optional so a caller that never renews need not supply it.
  const absoluteExpiresAt = Number.isSafeInteger(payload.absoluteExpiresAt) ? payload.absoluteExpiresAt : undefined;
  /*
   * Validate BEFORE signing. A signature turns a claim set into a capability, so
   * the issuer must never mint one nobody checked — and the plan is re-derived
   * here, which means an impossible plan can never reach a client.
   *
   * Tests that need a correctly-signed-but-invalid token use a test-only raw
   * signer rather than weakening this.
   */
  const grant = {
    transport: 'multipart',
    key: payload.key,
    uploadId: payload.uploadId,
    roomCode: payload.roomCode,
    memberId: payload.memberId,
    mimeType: payload.mimeType,
    expectedBytes: payload.expectedBytes,
    maxBytes: payload.maxBytes,
    partSize: payload.partSize,
    partCount: payload.partCount,
    expiresAt,
    absoluteExpiresAt,
  };
  const verdict = validateMultipartUploadGrant(grant);
  if (!verdict.ok) {
    throw new Error(`issueMultipartToken: refusing to sign an invalid grant (${verdict.error})`);
  }

  const body = {
    v: TOKEN_VERSION,
    // The transport the grant is valid for, so a multipart token can never be
    // read as a single-shot one (or the reverse) by a handler that forgot to ask.
    t: 'multipart',
    k: payload.key,
    u: payload.uploadId,
    r: payload.roomCode,
    s: payload.memberId,
    m: payload.mimeType,
    n: payload.expectedBytes,
    b: payload.maxBytes,
    p: payload.partSize,
    c: payload.partCount,
    e: expiresAt,
    // Only emitted when present, so a token without a deadline stays byte-for-byte
    // what it was before this field existed.
    ...(absoluteExpiresAt !== undefined ? { x: absoluteExpiresAt } : {}),
  };
  const encoded = b64url(JSON.stringify(body));
  const sig = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

/**
 * Verify a session token. Returns claims or null — never a partial result, and
 * never a reason (a caller that leaked "expired" vs "bad signature" would hand
 * an attacker an oracle).
 */
function verifyMultipartToken(token, secret, now = Date.now()) {
  /*
   * Structural checks BEFORE any hashing or parsing. A 50 MB "token" should cost
   * a length comparison, not an HMAC over 50 MB followed by a JSON.parse of
   * whatever it decodes to.
   */
  if (typeof token !== 'string') return null;
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encoded, sig] = parts;
  if (!encoded || !sig) return null;
  if (!BASE64URL.test(encoded) || !BASE64URL.test(sig)) return null;

  const expected = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  // Length check first: timingSafeEqual throws on a mismatch.
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let body;
  try {
    body = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object' || body.v !== TOKEN_VERSION) return null;

  /*
   * A valid signature proves ORIGIN, not validity.
   *
   * The SAME validator that gates issuance gates verification — including the
   * room/key agreement check and the re-derived part plan — so a leaked secret
   * still cannot produce a session the rest of the system honours. This replaces
   * a hand-written second copy of the rules that was missing exactly that
   * room/key check.
   */
  const grant = {
    transport: body.t,
    key: body.k,
    uploadId: body.u,
    roomCode: body.r,
    memberId: body.s,
    mimeType: body.m,
    expectedBytes: body.n,
    maxBytes: body.b,
    partSize: body.p,
    partCount: body.c,
    expiresAt: body.e,
    absoluteExpiresAt: body.x,
  };
  const verdict = validateMultipartUploadGrant(grant, { now, requireFuture: true });
  if (!verdict.ok) return null;

  return {
    version: body.v,
    transport: 'multipart',
    key: grant.key,
    uploadId: grant.uploadId,
    roomCode: grant.roomCode,
    memberId: grant.memberId,
    mimeType: grant.mimeType,
    expectedBytes: grant.expectedBytes,
    maxBytes: grant.maxBytes,
    partSize: verdict.plan.partSize,
    partCount: verdict.plan.partCount,
    // Derived, never trusted from the wire.
    lastPartSize: verdict.plan.lastPartSize,
    expiresAt: grant.expiresAt,
    // The immutable absolute deadline. A legacy token without one is treated as
    // having no renewal headroom (its own expiry is the ceiling).
    absoluteExpiresAt: Number.isSafeInteger(body.x) ? body.x : grant.expiresAt,
  };
}

/**
 * Authorize a verified token against the caller. The token proves the plan;
 * THIS proves the caller is still the person and room it was minted for.
 */
function authorizeSession(claims, { roomCode, memberId }) {
  if (!claims) return { ok: false, error: 'BAD_TOKEN' };
  if (claims.roomCode !== roomCode) return { ok: false, error: 'WRONG_ROOM' };
  if (claims.memberId !== memberId) return { ok: false, error: 'WRONG_MEMBER' };
  return { ok: true };
}

module.exports = {
  HARD_MAX_BYTES,
  HARD_LOCAL_UPLOAD_BYTES,
  DEFAULT_MAX_BYTES,
  S3_MIN_PART_BYTES,
  S3_MAX_PART_COUNT,
  MAX_PART_TARGET_BATCH,
  MAX_TOKEN_LENGTH,
  MAX_ETAG_LENGTH,
  MAX_UPLOAD_ID_LENGTH,
  MAX_MEMBER_ID_LENGTH,
  MULTIPART_STORAGE_METHODS,
  DEFAULTS,
  BOUNDS,
  readMultipartConfig,
  createUploadRuntimeConfig,
  deriveMultipartReadiness,
  contractIsComplete,
  REQUIRED_CONTRACT_EVENTS,
  requiresObjectStorage,
  effectiveMaxBytes,
  selectUploadMode,
  planParts,
  partRange,
  validatePartNumbers,
  normalizeEtag,
  validateCompletionParts,
  validateMultipartUploadGrant,
  issueMultipartToken,
  verifyMultipartToken,
  authorizeSession,
};
