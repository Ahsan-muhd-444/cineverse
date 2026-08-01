# Shared uploads

A local video file picked in one browser is a `blob:` URL — it exists only on
that device. This pipeline uploads it to shared storage so **both** members of a
room stream the same file, and the normal sync engine drives playback.

It applies **only** to user-selected local files. YouTube is untouched: nothing
here downloads, proxies, scrapes, or caches YouTube media.

## Two transports

The **server** chooses, per file. The client never guesses from size - the
ceilings, the storage capability and the enablement state all live server-side.

| | `single` | `multipart` |
| --- | --- | --- |
| Requests | one | one per part (16 MiB default) |
| Ceiling | 500 MiB | 3 GiB |
| Resumable | no | yes |
| Needs object storage | no | **yes** |
| Byte path | browser to bucket (presigned POST), or browser to this server (dev fs) | browser to bucket (presigned PUT per part) |

`single` is unchanged from before this feature existed. Everything below about
parts, pausing and resuming applies to `multipart` only.

## Flow - single

```
1. member picks a file
2. upload:intent   (Socket.IO, membership-gated)  -> validate + mint token + target
3. send the bytes  (HTTP: PUT to our endpoint in dev, presigned POST to the bucket in prod)
4. upload:complete (Socket.IO, membership-gated)  -> verify object, playable read URL
5. source:set      (existing event)               -> { type:'url', quality:'Uploaded' }
```

## Flow - multipart

```
1. member picks a file
2. upload:intent        -> validate, plan parts, CreateMultipartUpload, mint session token
3. upload:status        -> what the PROVIDER already has (empty on a fresh start)
4. upload:part-targets  -> presigned PUTs for <=20 parts at a time
5. browser PUTs file.slice(start,end) straight to the bucket, N at a time
   (repeat 4-5 until every part is provider-confirmed; upload:renew near expiry)
6. upload:complete      -> ListParts, exact agreement, CompleteMultipartUpload,
                           HEAD the assembled object, then publish a source
7. source:set           -> { type:'url', quality:'Uploaded' }
```

Bytes never travel through Socket.IO, are never base64-encoded, and are never
buffered whole. `File.slice()` returns a *view*, created immediately before a part
upload and dropped immediately after, so the browser's live footprint is bounded
by `partSize x concurrency` (~48 MiB at the defaults) whether the file is 100 MB
or 3 GB. Node never sees a byte of a multipart upload.

**Progressive playback is not part of this.** The movie becomes playable only
after multipart completion and final verification - there is no partial-object
streaming.

### Containers, not codecs

The allowlist is `video/mp4`, `video/webm`, `video/ogg`, and nothing here
transcodes. A **valid container can still hold a codec a particular browser
cannot decode** - an H.265/HEVC MP4 plays in Safari and fails in Firefox. That is
a playback failure, not an upload failure, and it looks like a black player with
working sync. Test with H.264 + AAC for the widest support.

## Storage providers

`server/storage/index.js` picks a provider from the environment. Everything else
talks only to the `MediaStorage` shape:

```js
// Every adapter
createUploadTarget(grant)   -> UploadTarget   // grant = the COMPLETE single-shot grant
createReadUrl(key)          -> string
statObject(key)             -> { size, contentType? } | null
deleteObject?(key)          -> boolean

// Object storage only (adapter sets `multipart: true` and `direct: true`)
createMultipartUpload({ key, mimeType })                          -> { uploadId }
createPartUploadTarget({ key, uploadId, partNumber, expiresIn })  -> { method, url }
listMultipartParts({ key, uploadId, expectedPartCount })          -> [{ partNumber, etag, size }]
completeMultipartUpload({ key, uploadId, parts })                 -> void
abortMultipartUpload({ key, uploadId })                           -> boolean
```

`expectedPartCount` is **mandatory** for session-driven listing: it is the signed
plan, so a provider can never report more parts than this server planned.

### S3-compatible (production) — `server/storage/s3.js`

Used as soon as `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID` and
`S3_SECRET_ACCESS_KEY` are all set. Works with Cloudflare R2, AWS S3, Supabase
Storage and MinIO.

Single-shot presigning is implemented with `node:crypto`. Multipart control
operations (`CreateMultipartUpload`, `UploadPart` presigning, `ListParts`,
`Complete`, `Abort`) use the **official AWS SDK** - so constructing this adapter
*does* load `@aws-sdk/client-s3`. Hand-rolling them was rejected: they need signed
query parameters, XML request/response bodies, `ListParts` pagination, and correct
handling of `CompleteMultipartUpload`'s "HTTP 200 with an `<Error>` body", which a
naive `res.ok` check reads as success and then attaches a corrupt object to the
room.

The SDK is server-only - reached from `server.js`, outside the Next build - so it
never enters the browser bundle. The browser only ever receives opaque, expiring
URLs. Credentials stay server-side, and video bytes never touch the Node process.

**Uploads use a presigned POST, not a PUT.** A presigned PUT cannot enforce a
size limit — the cap lives only in our token, which S3 never sees, so an
approved client could request intent for a small file and then PUT a much larger
one. The POST policy instead pins, and the bucket itself enforces:

```json
["content-length-range", <declared size>, <declared size>]
["eq", "$key", "<server-generated key>"]
["eq", "$Content-Type", "<validated mime type>"]
```

Both ends of the range are the **exact declared size**, not `1..maxBytes`. An
earlier version used the deployment-wide maximum as the upper bound, so a client
declaring 100 MiB received a policy authorizing a 3 GiB body.

**Multipart parts use presigned PUTs, not POSTs**, because S3 has no per-part
`content-length-range`. The size guarantee for multipart comes from three other
places: the signed plan the client slices against, `ListParts` size verification
at completion (every non-final part exactly `partSize`, the last exactly
`lastPartSize`), and the final `HEAD` against the exact expected total.

A body outside that range (or with the wrong key/type) is rejected by S3 at
upload time. As defence in depth, `upload:complete` then **HEADs** the object to
confirm it landed and re-checks its size/type; anything oversized or wrong is
`deleteObject`'d and rejected rather than attached to the room.

Reads use a presigned GET (default 6h, `UPLOAD_READ_TTL_SECONDS`) so the bucket
can stay private. Set `S3_PUBLIC_BASE_URL` to serve through a CDN or custom
domain instead; the bucket must then be public-read.

**Required CORS on the bucket** (the browser uploads to it directly):

```json
[
  {
    "AllowedOrigins": ["https://your-app.example"],
    "AllowedMethods": ["POST", "PUT", "GET", "HEAD"],
    "AllowedHeaders": ["content-type"],
    "ExposeHeaders": ["ETag", "content-length", "content-range", "accept-ranges"],
    "MaxAgeSeconds": 3000
  }
]
```

Three things this list gets wrong easily:

- **`PUT` is required** for multipart part uploads. Without it every part fails
  CORS preflight and the upload cannot start at all.
- **`ETag` must be in `ExposeHeaders`.** A part is only acknowledged once the
  browser can read the ETag the provider returned; if it is not exposed,
  `xhr.getResponseHeader('ETag')` is `null`, the engine fails the part with
  `MISSING_ETAG`, and retrying will never help. This is the single most common
  multipart misconfiguration.
- Provider syntax differs (R2 and Supabase have their own CORS editors). Verify
  the actual header casing through a real browser request rather than assuming.

`DELETE` and server-side `HEAD` are server-to-bucket and need no CORS entry. The
browser never calls a control API - it only PUTs/POSTs bytes and GETs the movie.

**Expiry is a bucket lifecycle rule**, not an app timer — it survives restarts
and costs nothing to run. Expire objects under `rooms/` after a day or two:

```json
{ "Rules": [
  { "ID": "expire-room-uploads", "Status": "Enabled",
    "Filter": { "Prefix": "rooms/" }, "Expiration": { "Days": 1 } },
  { "ID": "abort-incomplete-multipart", "Status": "Enabled",
    "Filter": { "Prefix": "rooms/" },
    "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 1 } }
] }
```

The **second rule is not optional** for multipart. An abandoned multipart upload
keeps its uploaded parts indefinitely, is billed for them, and is invisible in a
normal object listing. The server aborts sessions it knows about (cancel, kick,
room close, grace expiry), but a server crash loses that bookkeeping - the
lifecycle rule is the only backstop. Cloudflare R2 supports the same
`AbortIncompleteMultipartUpload` rule; check your provider's own documentation for
the exact syntax rather than assuming AWS wording.

### Filesystem (development only) — `server/storage/local.js`

The zero-configuration fallback so a fresh clone works. Writes to `./.uploads`
(`UPLOAD_DIR`) and streams back through the app's own endpoints with HTTP Range
support, which is what makes seeking work in a `<video>` element.

This is **not production persistence**:

- an ephemeral host (Render, Fly, containers) loses the disk on every restart;
- bytes are served by the Node process instead of a CDN;
- expiry is a best-effort in-process sweeper (`UPLOAD_TTL_HOURS`, default 6,
  running every 30 minutes), not a storage lifecycle rule.

## HTTP endpoints

Both exist **only** for the dev filesystem adapter. With object storage
configured they return `404 NOT_ENABLED` and are never part of the flow.

| Endpoint | Purpose |
| --- | --- |
| `PUT /api/uploads/put?token=…` | Store bytes. Authorized by the token alone. |
| `GET /api/uploads/file/<key>` | Stream bytes. Range-aware (206 + `Content-Range`). |

### Connection lifecycle

One rule across both endpoints: **a request whose body we are not going to read
is answered and the connection is closed.** Only `PUT` reads a body, and only a
successful `PUT` keeps the connection alive.

This is not politeness. Node waits for a declared body before recycling a
socket, so a client that sent `Content-Length: 3GiB`, shipped a 1 KiB prefix and
collected a `401` (or a `405` on the read route) used to keep the connection
forever — 20 such requests held 19 sockets. The reason is written, a **bounded**
prefix of the body is discarded (256 KiB / 250 ms, whichever comes first) so the
close can be a FIN rather than an RST, and then the socket goes. A
multi-gigabyte body is never read.

The read route never consumes a body at all, so one is refused outright:

| Request | Result |
| --- | --- |
| `GET`/`HEAD`, no body (or `Content-Length: 0`) | normal read, ordinary keep-alive |
| `GET`/`HEAD` with `Content-Length > 0` or any `Transfer-Encoding` | `400 REQUEST_BODY_NOT_ALLOWED`, connection closed |
| any other method | `405 METHOD_NOT_ALLOWED`, connection closed |

The body check happens before the key is decoded, so nothing is stat-ed, opened
or streamed for a request that is being refused. A malformed `Content-Length`
(`""`, `"1,2"`, `"1e9"`) counts as a body — the safe reading.

## Authorization

Uploads are never open. The chain is:

1. `upload:intent` requires `memberContext(socket)` — an **approved member** of
   the room. A lobby guest, a kicked socket, or a socket in no room is rejected
   with `UNAUTHORIZED`.
2. The server mints a short-lived HMAC token (15 min) pinning `{transport, key,
   mimeType, expectedBytes, maxBytes, roomCode}`. The signing secret
   (`UPLOAD_SECRET`, random per boot when unset) never reaches the browser.
   `roomCode` is **canonical uppercase** and must equal the room segment of the
   key exactly — validated on the way in and stored as given, never case-folded,
   so a grant cannot be accepted in one representation and compared in another.
3. The HTTP endpoint trusts **only** that token — not the path, not
   `Content-Length`, not `Content-Type`.
4. `upload:complete` re-verifies the token and confirms it was minted for *this*
   room, so a member of room A cannot attach an object minted for room B.

## Validation

Enforced server-side in `server/uploads.js`, which is the single source of
truth — the client never duplicates these rules, it just renders the error code.

| Rule | Behaviour |
| --- | --- |
| MIME allowlist | `video/mp4`, `video/webm`, `video/ogg` only → else `UNSUPPORTED_TYPE` |
| Size | `0 < size <= MAX_UPLOAD_BYTES` (default 500MB) → else `BAD_SIZE` / `TOO_LARGE` |
| File name | basename only, `[A-Za-z0-9._-]`, no leading dots, extension forced to match the MIME type |
| Object key | server-generated `rooms/<roomCode>/<randomId>/<sanitizedFileName>` |
| Key/MIME agreement | the key's extension must match the signed MIME → else `KEY_TYPE_MISMATCH` |
| Byte cap | re-enforced on the **actual** stream, so a lying `Content-Length` cannot smuggle a larger file |
| Key reads | strict pattern match + path containment check before touching disk |

Multipart adds a second grant contract (`validateMultipartUploadGrant`), which
re-derives the plan rather than trusting it:

| Rule | Behaviour |
| --- | --- |
| Transport | must be `multipart` → else `BAD_TRANSPORT` |
| Room/key | `roomFromKey(key) === roomCode`, exact and uppercase → else `ROOM_KEY_MISMATCH` |
| Member | a bounded, non-empty **stable** member id (never a socket id) |
| Plan | `planParts(expectedBytes, partSize)` must reproduce the claimed `partCount`, and the derived `lastPartSize` is what completion checks against |
| Part size | inside the configured 8–64 MiB bounds → else `BAD_PART_SIZE` |
| Part count | `<= 10,000` → else `BAD_PART_COUNT` |
| Expiry | a positive safe integer, strictly in the future at verification |
| Provider parts | every non-final part exactly `partSize`, the last exactly `lastPartSize`, no duplicates, nothing out of plan, opaque ETags |
| Client manifest | must agree with provider state part-for-part and ETag-for-ETag |
| Final object | `HEAD` must report the **exact** expected total, or the object is deleted |

A signature proves origin, not validity: `verifyMultipartToken` re-runs the whole
validator after checking the HMAC, so a leaked secret still cannot produce a
session the rest of the system honours.

## Socket contract

Every event requires live `memberContext(socket)` and has its **own** rate-limit
bucket (`server/rate-limit.js`), separate from chat, sync and WebRTC — a 3 GiB
upload is long-lived and chatty, and sharing a bucket with `syncBackground` would
starve drift correction and controller heartbeats. Room code and member id always
come from the authenticated context, never from the payload.

| Event | Request | Acknowledgement |
| --- | --- | --- |
| `upload:intent` | `{fileName, mimeType, size, lastModified?}` | `{ok, mode:'single'\|'multipart', …}` — see below |
| `upload:part-targets` | `{token, partNumbers[1..20]}` | `{ok, targets:[{partNumber, method:'PUT', url, headers, expectedBytes, expiresAt}]}` |
| `upload:status` | `{token}` | `{ok, status, completedParts, uploadedBytes, expectedBytes, partCount, expiresAt}` |
| `upload:renew` | `{token}` | `{ok, token, expiresAt}` |
| `upload:complete` | `{mode:'multipart', token, label, parts:[{partNumber, etag}]}` | `{ok, source, key, expectedBytes}` |
| `upload:abort` | `{token}` | `{ok, alreadyGone?}` |
| `upload:room-progress` | `{mode, token, label, uploadedBytes, totalBytes, status}` | `{ok, throttled?}` |

A multipart intent returns the **plan, not the URLs**: `{token, key, uploadId,
partSize, partCount, lastPartSize, concurrency, retries, maxPartBatch, expiresAt,
partUrlTtlSeconds}`. A 3 GiB / 16 MiB upload is 192 parts; returning 192 signed
URLs would mint 192 write capabilities the client mostly does not need yet, all
expiring together.

`upload:complete` is dispatched on the **declared** `mode`, never inferred from a
single-shot token failing to verify — inferring it would answer with the wrong
error and let a client probe which token shapes exist.

### Completion is idempotent

A client whose ack was lost retries. Re-running the provider `Complete` would fail
(the multipart upload no longer exists) and a naive error would tell the user their
finished 3 GB upload failed. Instead: if the session is already `completed`, or the
provider reports `NoSuchUpload`, the **object itself** decides — `HEAD` it, verify
the exact key/size/type, and return the same logical result. Exactly one source,
never duplicate progress.

### Server-side session state

`server/uploads-sessions.js` keeps a small coordination registry: room, member,
key, upload id, expected bytes, part count, status, timestamps. It is **not** the
security authority — the signed token says what a caller may do and `ListParts`
says what has landed. It exists for active-upload limits, for knowing what to abort
when a member is removed, and for clearing partner progress.

The **raw token is never stored** (SHA-256 lookup keys only): it is a six-hour
capability for writing gigabytes, and a copy in a long-lived process map would turn
any heap dump into a working credential.

The registry also **fails closed at capacity**: at its `maxSessions` bound it
reclaims only tombstones whose token has already expired, and if that frees
nothing the registration is refused with `SESSION_REGISTRY_FULL` — an active
upload or an unexpired tombstone is never evicted to make room. A multipart intent
that is refused this way **aborts the provider upload it just created**, so a full
registry cannot leave an orphan in the bucket.

Defaults: **1 active multipart upload per member, 2 per room**
(`UPLOAD_MAX_ACTIVE_PER_MEMBER` / `_PER_ROOM`). A second upload is refused with
`UPLOAD_ALREADY_ACTIVE` **before** the provider session is created, so hitting the
limit cannot orphan a multipart upload in the bucket.

### Renewal revokes the old token

`upload:renew` mints a new token for the same plan and marks the old one
`superseded` — a terminal tombstone kept until the old token's original expiry.
Every service entry point consults the lifecycle authority **after** cryptographic
authorization, so the superseded token can no longer request part targets, read
status, renew, complete, emit progress, or abort the renewed session; all six
answer `SESSION_SUPERSEDED`. Deletion alone would leave the old token
cryptographically valid and lifecycle-absent, which is the hole this closes.

Renewal is **atomic and registry-bounded**. The superseded tombstone keeps its
slot until the old token expires, so a renewal nets one extra record; the registry
therefore applies the same fail-closed bound `register()` does. If installing the
new token would exceed `maxSessions` (after pruning dead tombstones), the renewal
is refused with `SESSION_REGISTRY_FULL` and the old token is left **untouched and
active** — never a half-renamed session. A tight-registry renewal loop can add at
most one record and then keeps returning `SESSION_REGISTRY_FULL`, so the map is
hard-bounded.

### Renewal cannot outlive the absolute deadline

Each session carries an **immutable absolute deadline**, fixed when the intent is
created (`now + UPLOAD_SESSION_MAX_LIFETIME_SECONDS`, default 24h) and signed into
the token as a claim that every renewal **re-signs unchanged**. A renewal's new
expiry is `min(now + UPLOAD_SESSION_TTL_SECONDS, absoluteExpiresAt)`. Once the
clamp collapses onto the deadline — a renewal can no longer move the expiry
forward — `upload:renew` returns `SESSION_EXPIRED` and issues **no replacement
token**. The current token stays valid until it lapses, and the ~60s sweeper then
aborts its provider upload. Without this, a 6-hour session renewed every 5 hours
would live indefinitely; the deadline makes the lifetime finite and operator-set.
`UPLOAD_SESSION_MAX_LIFETIME_SECONDS` is validated at startup and must be at least
one `UPLOAD_SESSION_TTL_SECONDS` (a deadline shorter than a single session is a
boot error).

### What survives a restart, and what does not

Refresh and a temporary network interruption are resumable: the same process
holds the same seat, the client re-reads `upload:status` and continues the missing
parts.

A **CineVerse server process restart is not resumable.** The multipart token binds
a process-local stable member id (see `server/seats.js`), which is regenerated on
restart, so a resumed operation authorizes as `WRONG_MEMBER`. The token plus
provider state is therefore enough to resume across a **client** refresh, **never**
across a **server** restart — the client must start the upload over. (Binding
authorization to a secret-derived, seat-stable value would make restart resumable;
that is a deliberate future option, not a claim the current build meets.) The
bucket's incomplete-multipart lifecycle rule is the backstop that reaps the
abandoned provider session.

### Lifecycle policy

| Event | Upload |
| --- | --- |
| temporary disconnect | **preserved** through the reconnect grace; partner sees `reconnecting` |
| reconnect inside grace | client calls `upload:status` and continues the missing parts |
| grace expiry | provider session aborted (best effort), progress cleared |
| explicit leave or kick | provider session aborted (best effort), progress cleared |
| room closure | every registered active session aborted, all progress cleared |
| session expiry | a ~60s sweeper tombstones the session `expired`, aborts its provider upload once, and clears + re-broadcasts room progress |
| server restart | **membership is invalidated** (see above); bucket lifecycle rule reaps the provider session |

Surviving a blip is the entire point of a resumable transport, so a dropped socket
does **not** abort. A surrendered seat does: the session token is bound to that
stable member id, so nobody can authorize it any more.

## Partner-side progress

The other member sees name, label, bytes and a server-computed percentage —
throttled to one ordinary update every 2s per member, with state transitions
(`paused`, `retrying`, `reconnecting`, `finalizing`) sent immediately. Active
progress is carried in the room snapshot, so a member who joins mid-upload sees it.

Never broadcast: tokens, upload ids, object keys, part URLs, ETags, local paths,
**speed or ETA**. The last two are the uploader's local estimates; relaying them
would cost realtime traffic for a number the partner cannot act on.

## Read URL expiry

A presigned GET lives `UPLOAD_READ_TTL_SECONDS` (default 6h). A room session that
runs longer than that will find the URL expired mid-film, and **the current
architecture does not refresh it automatically** — the source is a plain URL in
room state, and re-signing it would mean a source-rotation mechanism this feature
does not introduce. Six hours comfortably exceeds a normal session; set
`S3_PUBLIC_BASE_URL` (CDN, public-read bucket) if you need indefinite playback.

## Environment

See `.env.example`. Nothing is required — with no configuration at all, uploads
use the dev filesystem adapter and are capped at 500 MiB.

**3 GiB requires explicit configuration**: `MAX_UPLOAD_BYTES=3221225472`, a
complete S3 block, and a stable `UPLOAD_SECRET` of at least 32 bytes. Multipart
enablement is *derived* from real capabilities, not a flag — object storage
configured, adapter `direct` and `multipart` with all five operations present,
strong stable secret, socket contract mounted. If any of those is missing the
startup log says which one, and files over 500 MiB are refused rather than routed
to a transport that cannot carry them.

The dev filesystem adapter can **never** become a 3 GB transport: its ceiling is a
hard 500 MiB that no environment variable can raise, only lower.

## Toolchain

**Node ≥ 22.18.0** (`.nvmrc` pins `22.18.0`, `package.json` `engines` enforces the
floor, `npm ci --engine-strict` fails below it). The unit suites import the `.ts`
runtime modules directly and rely on Node's **native, unflagged** type stripping,
which is stable from 22.18.0 — there is no `--experimental-strip-types` flag and no
`tsx` step. An older Node would fail to run a single test, which is why the engine
floor, `.nvmrc`, and CI all name the same version.

CI runs two jobs: `verify` (typecheck → **`npm test`** → build → realtime E2E) and
`browser` (build → `npm run test:browser:direct`). Both pin Node from `.nvmrc`.

## Testing the browser path

Two runners exercise the real browser against a real cross-origin bucket, with no
S3 credentials — the mock bucket is selected only under `NODE_ENV=test` +
`UPLOAD_TEST_MODE=1` + `UPLOAD_TEST_BUCKET_ORIGIN` (production refuses the flag):

- `npm run test:browser` — Playwright Test (worker-based).
- `npm run test:browser:direct` — a single-process runner
  (`scripts/browser/run-direct.mjs`) using the Playwright **browser API only**, no
  workers. Use this where a sandbox blocks the worker runner's IPC; it boots the
  app + bucket, drives Chromium, writes an atomic JSON artifact to
  `.artifacts/browser/direct-results.json`, and exits non-zero on any failure.

The direct runner falls back from bundled Chromium to a system Chrome/Chromium, and
applies `--no-sandbox` only when `BROWSER_TEST_NO_SANDBOX=1` (or running as root on
Linux) — never silently on a desktop.
