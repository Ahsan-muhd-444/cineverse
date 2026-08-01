/**
 * In-memory token-bucket rate limiting.
 *
 * CineVerse is deliberately a single long-lived Node process with all room state
 * in memory, so the limiter matches: no Redis, no dependencies, no timer per
 * bucket. One Map of `{tokens, updatedAt}`, refilled lazily on read.
 *
 * Token buckets (rather than fixed windows) are the right shape here because
 * real traffic is bursty-but-bounded: a flurry of ICE candidates, a few quick
 * chat messages, a scrub across the seek bar. A bucket absorbs the burst up to
 * `capacity` and then meters the sustained rate, where a fixed window would
 * either reject the legitimate burst or allow double-rate traffic across a
 * window boundary.
 *
 * `now` is injected everywhere so the whole thing is deterministic under test
 * (see scripts/rate-limit.test.mjs).
 */

// One-way dependency: attachment sizing knows nothing about rate limiting, so
// the policy table can safely derive its capacity from it.
const { maxAttachmentCost } = require('./chat-limits');

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_KEYS = 20_000;

/**
 * Policy table. Deliberately in code, not env: these are tuned against the
 * app's real event cadence, and exposing every bucket as a knob invites
 * misconfiguration. Only the genuinely operational limits live in env.
 *
 * Sizing notes (why these are not tighter):
 *  - `rtcSignal` must absorb full ICE-candidate bursts from BOTH peers.
 *  - `syncBackground` covers sync:request/report — periodic PLAYBACK protocol
 *    traffic (~every 2.5–3s per client), never user actions. Chat background
 *    traffic and clock pings have their own buckets so they cannot starve it.
 *  - `syncControl` must survive an enthusiastic scrub across the seek bar.
 *  - `roomJoin` must survive a refresh loop; seat reclaim is a join.
 */
const RATE_POLICIES = Object.freeze({
  roomCreate: { capacity: 4, refillTokens: 4, refillMs: 60_000 },
  roomProbe: { capacity: 30, refillTokens: 30, refillMs: 60_000 },
  roomJoin: { capacity: 20, refillTokens: 20, refillMs: 60_000 },
  // Pre-admission clock calibration: one burst of 7 samples on connect, then
  // one probe every 5s. Bounded so an unauthenticated socket can't flood acks.
  clockPing: { capacity: 20, refillTokens: 20, refillMs: 10_000 },
  chatText: { capacity: 8, refillTokens: 8, refillMs: 5_000 },
  // Typing indicators + read receipts. DELIBERATELY separate from
  // syncBackground: sharing one bucket let a fast typist drain the playback
  // protocol's budget, silently dropping drift requests and — worse — the
  // active controller's heartbeats, which can trigger stale-controller handoff.
  // Chat activity must never spend playback capacity.
  chatBackground: { capacity: 12, refillTokens: 12, refillMs: 5_000 },
  chatAttachment: { capacity: 16, refillTokens: 16, refillMs: 60_000 },
  reaction: { capacity: 20, refillTokens: 20, refillMs: 5_000 },
  roomMutation: { capacity: 12, refillTokens: 12, refillMs: 10_000 },
  syncControl: { capacity: 20, refillTokens: 20, refillMs: 10_000 },
  syncBackground: { capacity: 40, refillTokens: 40, refillMs: 10_000 },
  uploadIntent: { capacity: 5, refillTokens: 5, refillMs: 60_000 },
  // Its own bucket: every legitimate intent is followed by a complete, so
  // sharing the intent budget would halve the real upload allowance.
  uploadComplete: { capacity: 12, refillTokens: 12, refillMs: 60_000 },
  /* ---- resumable multipart ----
     All separate from each other AND from sync/chat. A 3 GiB upload is a long
     lived, chatty operation; if any of it drew on syncBackground it could
     starve drift correction and controller heartbeats, which is the failure
     chatBackground was already split out to prevent. */
  // 3 GiB / 16 MiB = 192 parts, signed 20 at a time = ~10 calls, plus re-signs
  // for expired URLs and retried parts. 60/min leaves generous headroom while
  // still bounding how many URLs one member can mint.
  uploadPartTargets: { capacity: 60, refillTokens: 60, refillMs: 60_000 },
  // Resume/status polling: called on resume and after reconnects, not in a loop.
  uploadStatus: { capacity: 20, refillTokens: 20, refillMs: 60_000 },
  // Session renewal. A 6-hour session needs one renewal near expiry, so this is
  // sized for retries and reconnects, not for a loop — and each renewal is capped
  // by the session's IMMUTABLE absolute deadline (fixed at intent, re-signed
  // unchanged), so a renewal flood cannot extend a session past that ceiling.
  uploadRenew: { capacity: 10, refillTokens: 10, refillMs: 60_000 },
  uploadAbort: { capacity: 10, refillTokens: 10, refillMs: 60_000 },
  // Throttled to one broadcast per 2s in the handler; the bucket is the backstop
  // for a client that ignores its own throttle, plus room for the immediate
  // sends allowed on state transitions.
  uploadRoomProgress: { capacity: 40, refillTokens: 40, refillMs: 60_000 },
  rtcSignal: { capacity: 160, refillTokens: 160, refillMs: 30_000 },
  rtcCallState: { capacity: 20, refillTokens: 20, refillMs: 10_000 },
});

/**
 * Build the runtime policy table, naming each policy (so buckets are namespaced
 * per event class) and sizing the attachment bucket to the configured file
 * limit.
 *
 * The attachment capacity MUST cover the largest valid attachment: the token
 * bucket correctly refuses any `cost > capacity` outright, so a bucket smaller
 * than the accepted file size would make large-but-valid attachments
 * permanently unsendable — passing validation, then failing the limiter forever.
 * Deriving it here keeps the two limits in step even when
 * CHAT_ATTACHMENT_MAX_BYTES is reconfigured.
 */
function buildRuntimePolicy(maxDecodedAttachmentBytes, options = {}) {
  const attachmentCapacity = maxAttachmentCost(maxDecodedAttachmentBytes);
  /*
   * TEST-ONLY relaxation of the `upload*` buckets.
   *
   * The production per-minute upload budgets (5 intents/min, 10 aborts/min, …) are
   * deliberately tight. A high-cycle BROWSER STRESS run — dozens of
   * intent/complete/abort round-trips in seconds — would legitimately trip them,
   * which is not what that gate is testing. The caller sets `relaxUpload` ONLY
   * under the same NODE_ENV=test + UPLOAD_TEST_MODE flag that already switches to
   * the mock bucket, so production is never affected. It scales the upload buckets
   * only; every other limit (chat, sync, rtc) is untouched.
   */
  const uploadRelax = Number.isFinite(options.relaxUpload) && options.relaxUpload > 1 ? options.relaxUpload : 1;
  const isUploadBucket = (name) => name.startsWith('upload');
  return Object.fromEntries(
    Object.entries(RATE_POLICIES).map(([name, policy]) => [
      name,
      {
        ...policy,
        name,
        ...(name === 'chatAttachment'
          ? {
              // One max-sized attachment consumes nearly the whole bucket, so
              // the practical rate is ~one huge file per refill window while
              // small images and voice notes still cost only a token or two.
              capacity: Math.max(policy.capacity, attachmentCapacity),
              refillTokens: Math.max(policy.refillTokens, attachmentCapacity),
            }
          : {}),
        ...(uploadRelax > 1 && isUploadBucket(name)
          ? { capacity: policy.capacity * uploadRelax, refillTokens: policy.refillTokens * uploadRelax }
          : {}),
      },
    ]),
  );
}

/**
 * @param {{maxKeys?: number, ttlMs?: number}} [options]
 */
function createRateLimiter(options = {}) {
  const maxKeys = Number.isFinite(options.maxKeys) && options.maxKeys > 0 ? options.maxKeys : DEFAULT_MAX_KEYS;
  const defaultTtlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : DEFAULT_TTL_MS;

  /** @type {Map<string, {tokens:number, updatedAt:number, ttlMs:number}>} */
  const buckets = new Map();

  /**
   * Take `cost` tokens from `key`'s bucket.
   * @returns {{ok:boolean, remaining:number, retryAfterMs:number}}
   */
  function consume({ key, policy, cost = 1, now = Date.now() }) {
    const capacity = policy.capacity;
    const refillPerMs = policy.refillTokens / policy.refillMs;
    const ttlMs = policy.ttlMs ?? defaultTtlMs;

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { tokens: capacity, updatedAt: now, ttlMs };
    } else {
      // Lazy refill — no timers, so an idle bucket costs nothing until touched.
      const elapsed = Math.max(0, now - bucket.updatedAt);
      bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerMs);
      bucket.updatedAt = now;
      bucket.ttlMs = ttlMs;
      // Re-insert to keep Map order ~LRU, so eviction drops the coldest keys.
      buckets.delete(key);
    }

    // A cost that exceeds capacity can never be satisfied; reject without
    // draining the bucket, and hint the full refill window.
    if (cost > capacity) {
      buckets.set(key, bucket);
      evictIfNeeded(now);
      return { ok: false, remaining: Math.floor(bucket.tokens), retryAfterMs: policy.refillMs };
    }

    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      buckets.set(key, bucket);
      evictIfNeeded(now);
      return { ok: true, remaining: Math.floor(bucket.tokens), retryAfterMs: 0 };
    }

    const shortfall = cost - bucket.tokens;
    buckets.set(key, bucket);
    evictIfNeeded(now);
    return {
      ok: false,
      remaining: Math.floor(bucket.tokens),
      retryAfterMs: Math.max(1, Math.ceil(shortfall / refillPerMs)),
    };
  }

  /** Drop every bucket whose key starts with `prefix` (e.g. one socket's). */
  function clearPrefix(prefix) {
    let removed = 0;
    for (const key of [...buckets.keys()]) {
      if (key.startsWith(prefix)) {
        buckets.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /** Drop buckets untouched for longer than their TTL. */
  function sweep(now = Date.now()) {
    let removed = 0;
    for (const [key, bucket] of buckets) {
      if (now - bucket.updatedAt > bucket.ttlMs) {
        buckets.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /** Hard bound on the map, so a key-space flood can't exhaust memory. */
  function evictIfNeeded(now) {
    if (buckets.size <= maxKeys) return;
    sweep(now);
    // Still over: drop least-recently-used keys (Map order is LRU here).
    while (buckets.size > maxKeys) {
      const oldest = buckets.keys().next().value;
      if (oldest === undefined) break;
      buckets.delete(oldest);
    }
  }

  return { consume, clearPrefix, sweep, size: () => buckets.size };
}

/* -------------------------------------------------------------------------- */
/*  Client identity                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Whether an address is loopback — i.e. the "client" is this machine.
 *
 * Loopback is EXEMPT from per-IP limits. Two reasons:
 *  - it is the dev/test case, where every connection shares one address;
 *  - more importantly, a reverse proxy on the same host with
 *    RATE_LIMIT_TRUST_PROXY unset makes every real user appear as 127.0.0.1.
 *    Enforcing a shared IP bucket there would throttle the whole deployment —
 *    a self-inflicted outage far worse than the abuse it prevents. Per-SOCKET
 *    limits still apply, which is the primary defence anyway.
 */
function isLoopbackIp(ip) {
  const value = String(ip || '');
  return value === '::1' || value === 'localhost' || /^127\./.test(value);
}

/**
 * Normalize an address so one client maps to ONE key: strips the IPv4-mapped
 * IPv6 prefix, an interface suffix, brackets and whitespace, and lowercases.
 */
function normalizeIp(raw) {
  let ip = String(raw || '').trim();
  if (!ip) return '';
  if (ip.startsWith('[')) ip = ip.slice(1);
  const bracket = ip.indexOf(']');
  if (bracket >= 0) ip = ip.slice(0, bracket);
  // ::ffff:1.2.3.4 and the rarer ::1.2.3.4 are the same host as 1.2.3.4.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1];
  const zone = ip.indexOf('%');
  if (zone >= 0) ip = ip.slice(0, zone);
  return ip.toLowerCase();
}

/**
 * The client address to key limits on.
 *
 * `x-forwarded-for` is attacker-controlled unless a trusted proxy sets it, so
 * it is IGNORED by default — otherwise a flooder rotates the header and gets an
 * unlimited key space. Deployments behind a known proxy opt in with
 * RATE_LIMIT_TRUST_PROXY=1 (see .env.example).
 */
function socketClientIp(socket, env = process.env) {
  const trustProxy = String(env.RATE_LIMIT_TRUST_PROXY || '') === '1';
  if (trustProxy) {
    const header = socket?.handshake?.headers?.['x-forwarded-for'];
    const raw = Array.isArray(header) ? header[0] : header;
    if (raw) {
      const first = String(raw).split(',')[0];
      const normalized = normalizeIp(first);
      if (normalized) return normalized;
    }
  }
  return normalizeIp(socket?.handshake?.address || socket?.conn?.remoteAddress || '') || 'unknown';
}

/**
 * How much larger the per-IP budget is than the per-socket one.
 *
 * A single address legitimately carries many clients — NAT, a household, an
 * office, a café. The IP bucket is a backstop against one host opening many
 * sockets, NOT a per-user limit, so it must be generously larger or ordinary
 * shared-connection users get throttled.
 */
const IP_BUDGET_MULTIPLIER = 12;

module.exports = {
  RATE_POLICIES,
  DEFAULT_TTL_MS,
  DEFAULT_MAX_KEYS,
  IP_BUDGET_MULTIPLIER,
  buildRuntimePolicy,
  createRateLimiter,
  normalizeIp,
  isLoopbackIp,
  socketClientIp,
};
