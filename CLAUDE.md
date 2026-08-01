# CLAUDE.md — CineVerse

Project brief for AI sessions. Source code is the ultimate source of truth; this
file exists so a new session starts informed without re-reading everything.

## What it is

A private cinema for two: perfectly-synced playback + live chat + peer-to-peer
calls, in an ephemeral room opened in one click. No sign-up, no database, no
accounts. Room state lives only while someone is in it.

Stack: **Next.js 14 (App Router)** + **custom `server.js`** (Next + Socket.IO in
one Node process) + TypeScript (strict) + Tailwind. Personal prefs
(name, favorites, resume positions) are `localStorage`-only.

## Run / verify (Windows note)

`node`/`npm`/`npx` are NOT on this machine's PATH. Prefix commands with:

```bash
$env:Path = "C:\Program Files\nodejs;$env:Path"
```

| Task | Command |
| --- | --- |
| Typecheck (strict, no emit) | `npm run typecheck` |
| Dev / start (single process) | `npm run dev` / `npm start` |
| Build | `npm run build` |
| Unit suites | `npm test` |
| Realtime E2E (needs running server) | `node scripts/e2e-realtime.js` (honors `TEST_URL`) |
| Process lifecycle smoke (needs a build) | `node scripts/process-smoke.mjs` |
| Cold realtime stress (needs a build) | `npm run test:e2e:stress` |
| Memory/cleanup soak (needs a build) | `npm run test:soak` |
| **Full release gate, from cold** | `npm run release:gate` |

`npm run release:gate` owns its own production server on a free port: build →
unit → wait for `/readyz` → E2E → process smoke → clean shutdown. It needs no
running dev server and cleans up in `finally`. `npm start` goes through
`scripts/start.mjs` so it works on Windows as well as Linux.

E2E connects to a live server. Start `server.js` on a spare port, set
`TEST_URL=http://localhost:<port>`, then run the script (trust the runner's
printed count, not this note).

Every check is numbered and timestamped, and a `FAILED CHECKS` footer prints
before a nonzero exit — including from the harness-exception path. Set
`E2E_RESULT_FILE=<path>` for a machine-readable result (written atomically, with
tokens/seat ids/SDP/attachment payloads scrubbed). The release gate writes these
to `.artifacts/release-gate/<timestamp>-<pid>/` automatically.

**Assertions on grace-timer-driven events** (host succession, seat expiry,
orphaned-room close) must use a grace-aware wait — `presenceMatching`,
`messageMatching`, or an explicit `GRACE_MS + …` timeout. A fixed window or
`waitFor`'s generic default is a race: two separate intermittent failures in
this suite were caused by asserting on whatever had arrived by an arbitrary
deadline. Use `npm run test:e2e:stress` to hunt that class of bug.

Newer pure-logic suites: `scripts/acks.test.mjs` (ack normalization + optimistic
attempt ordering + WebRTC signal-failure policy), `scripts/lifecycle.test.mjs`
(readiness + shutdown), `scripts/headers.test.mjs` (CSP, both directions),
`scripts/config.test.mjs` (env validation), `scripts/a11y.test.mjs`.

Pure-logic unit suites (no server, `node --test`): `scripts/media.test.mjs`
(YouTube parsing/normalization), `scripts/youtube-sync.test.mjs` (native-control
echo suppression + seek detection), `scripts/playback-projection.test.mjs`
(rate-aware projection + seek-hold), `scripts/room-lifecycle.test.mjs`
(reconnect guard predicates). They import `.ts` via Node type-stripping; run with
`--disable-warning=MODULE_TYPELESS_PACKAGE_JSON`.

> **NEVER run `next build` while a dev server is running in this directory.**
> Dev and prod share `.next`; the build clobbers the dev chunks under the live
> server and localhost:3000 degrades to an unstyled 404-chunk shell. Stop the
> dev server first, and after validation builds clear `.next` and restart dev.

## Layout

```
server.js                 Next + Socket.IO; ALL room state (in-memory Map<code,Room>)
src/
├── app/                  Routes: home, browse, join, room/[code], error, 404
├── components/{ui,fx,home,browse,room,layout}/
│   room/                 Player, YouTubeEngine, youtubeSync, Chat, RoomExperience,
│                         SidePanels, CallDock, SourcePicker
├── hooks/                useRoom, useSyncedPlayback, playbackProjection,
│                         roomLifecycle, useWebRTC, useStartRoom
└── lib/                  types, catalog, media (YouTube parse/normalize),
                          storage (localStorage), socket (clock), utils
```

Heaviest files: `components/room/{Player,Chat,RoomExperience,YouTubeEngine}.tsx`.

## Playback sync (don't break this — it's the whole product)

Three mechanisms, in `src/hooks/useSyncedPlayback.ts` + `src/lib/socket.ts`:

1. **Clock alignment** (`calibrateClock`) — NTP-lite: sample RTT, keep the
   low-latency half, median offset. `serverNow()` = `Date.now() + offset`.
2. **Control events** (`sync:control`) — carry the initiator's playhead + the
   server timestamp; receiver adds transit time back (scaled by rate) before
   seeking. Rate-aware projection lives in `src/hooks/playbackProjection.ts`
   (`projectPlaybackState` scales elapsed time by playback rate).
3. **Drift correction** (every 2.5s) — `<0.25s` ignore, `0.25–1.2s` nudge rate
   ±6% relative to the room's base rate (invisible), `>1.2s` hard-seek. Playing
   side heartbeats every 3s.

`PlayerHandle` (getTime/seek/play/pause/setRate/ready) is the narrow interface
both the HTML5 `<video>` and YouTube IFrame engines implement, so the sync layer
never knows which is on screen. Optional handle capabilities `canRateNudge()` and
`isBuffering()` let the drift loop back off for engines with a fixed rate set
(YouTube: no micro rate-nudge, bounded seek instead, and no correction while
buffering). HTML5 omits them and keeps the original smooth rate-nudge behavior.

**Deterministic sync authority (server).** Any member can control, but reports
are NOT last-writer-wins. Each room carries `controllerId`, `controlSeq`,
`sourceVersion`, `lastControlAt`, `lastControllerReportAt`. `source:set` bumps
`sourceVersion`+`controlSeq` and resets playback; `sync:control` bumps
`controlSeq`, makes the sender the controller, and **acks the epoch** (client
adopts `controlSeq`/`sourceVersion` so its heartbeats are trusted). `sync:report`
is accepted ONLY if it matches the current `sourceVersion`+`controlSeq`, comes
from the `controllerId` (or the deterministic fallback once the controller is
gone/stale past `CONTROLLER_TTL=12s`), is finite, and does NOT rewind while
playing (`t < headPosition-1.5` rejected). Heartbeats never pause. On controller
departure (`departRoom`) control passes to `fallbackController` (host, else
oldest member — never a lobby socket). Client skips reporting while buffering.

## Media sources & YouTube

`src/lib/media.ts` is the single source of truth for YouTube parsing/normalization
(`extractYouTubeId`, `normalizeMediaSource`, `resolveYouTubeId`,
`shouldRecreateYouTubePlayer`). A YouTube source is canonical: `{ type:'youtube',
value:'<videoId>' }` — never a full URL. `SourcePicker` normalizes on input;
`server.js` `source:set` normalizes defensively (mirrored regex, no network);
`Player` resolves the ID with a legacy fallback for old full-URL rooms.

**Two control models — do NOT merge them:**
- **YouTube** uses **native YouTube controls** (`playerVars.controls:1, fs:1`) as
  the visible UI. CineVerse renders ONLY the iframe — no custom control bar,
  center button, opaque cover, reveal timer, "Starting…" screen, or click-swallow
  layer over it. CineVerse owns only room sync: it drives the player via the
  handle and mirrors native play/pause/seek/rate into the room via `onUserIntent`,
  with echo suppression (`isApplying` + an 800ms post-command window) and
  poll-based seek detection (`src/components/room/youtubeSync.ts`, tested).
- **HTML5 / catalog / URL / local** use CineVerse's custom control bar (the big
  `Player.tsx` return below the YouTube early-return).

**YouTubeEngine stability contract:** the iframe is created once per `videoId`
(effect deps `[videoId, handleRef]`, plus `key={ytId}`); YouTube replaces a
DISPOSABLE child node (never the React-owned `mountRef`), and the generated iframe
is force-styled to fill + given full `allow` (incl. `fullscreen`) + `allowfullscreen`
immediately AND on ready. Callbacks (`onReady`/`onPhase`/`onError`/`onUserIntent`)
live in refs, so chat/presence/typing/drift re-renders never rebuild the player.
Commands before ready coalesce into one "latest intent" applied on ready.
**Never pause/seek-to-~0 a never-played CUED player** (`hasPlayedRef`+`isCued()`
guards) — it turns YouTube's thumbnail into a black frame (the "blank startup"
bug). `onPhase` drives ONLY a "Loading YouTube…" affordance + an 8s no-blank
timeout → error card; it must never render controls. YouTube fullscreen is
native (cross-origin iframe → parent cannot overlay it).

## Room membership & authorization (server.js)

**Single authority = `socket.data.roomCode` ∩ `room.members`.** Never trust a
cached boolean, and never rely on Socket.IO channel membership alone for auth.

- `memberContext(socket)` → `{room, member}` only if approved; else `null`.
- `hostContext(socket)` → member **and** `room.hostId === socket.id`.
- `admitSocket(io, socket, room, name)` → the ONE admission path (direct join +
  lobby approval).
- `departRoom(io, socket, opts)` → the ONE departure path (switch, disconnect,
  kick, explicit `room:leave`). Idempotent — clears `socket.data` first, so no
  duplicate `peer:left`.
- `closeRoom(io, room)` → when the LAST approved member leaves a room that still
  has lobby guests, the session ends: guests get `room:closed`, lobby cleared,
  room deleted. A lobby entry is NEVER promoted to member/host. (Empty room with
  NO lobby still gets the reap grace for reconnection.)

Rules that must hold: every room-scoped event requires `memberContext`;
host-only events require `hostContext`; `rtc:signal` requires both sender and
recipient are members of the SAME room. Admission is server-completed —
`lobby:enter` is permanently rejected for every membership state. Kicks record a
connection-scoped `socket.data.kickedFrom` set that blocks immediate rejoin (no
durable bans — reconnect = new socket = clean, by design). `clock:ping`/
`room:create`/`room:probe` are intentionally pre-admission and unguarded.

**Room switching:** `room:join` validates the destination (lock/passphrase)
BEFORE leaving the current room, so a rejected join keeps your seat (you can test
another room's gate). Departure on navigation is driven by an explicit
`room:leave` (emitted by `useRoom` on unmount), scoped to a code so it can't race
a concurrent join to a different room. Only a SUCCESSFUL join leaves the old room.

`headPosition(room)` extrapolates the server-authoritative playhead while playing.
`departRoom` also reassigns playback control (see sync-authority) alongside host
succession.

## Room UI (RoomExperience, Chat)

**Shared cinema lights.** `room.lightsMode: 'on'|'off'` in `RoomSettings`, synced
via a `room:lights` event (ANY approved member can toggle — ambience, not
security, so `memberContext`-gated not host-only) and carried in every
`room:settings` broadcast + the snapshot. Lights-off dims the room shell/header/
panel + reduces aurora — **never the player/iframe**. E2e covers default/toggle/
invalid-coercion.

**Viewport-locked chat (desktop).** The room root is `lg:h-dvh lg:overflow-hidden`
(mobile keeps `min-h-dvh` scroll). Bounded height propagates root→stage→aside→
inner→chat container→`Chat` root so the message list (`[role="log"]`) is the ONLY
scroller (`.chat-scrollbar` in globals.css). Bubbles cap at
`lg:max-w-[min(78%,18rem)]` with `[overflow-wrap:anywhere]`; the side-panel width
is pinned on a fixed-width inner wrapper (framer animates the aside to `width:auto`,
which would otherwise override a Tailwind width). Reactions are **click-to-open**
(a `SmilePlus` trigger opens an absolutely-positioned picker; outside-click/Esc
close) — never a hover bar. Composer popover (`EmojiPicker`) lives OUTSIDE the
`overflow-hidden` input shell so it isn't clipped.

## Conventions & guardrails

- Server sanitizes all input via `clean(v, max)` (strips control chars, trims,
  caps length). Keep it on every new client-supplied field.
- Chat attachments travel as data URLs through the socket. `maxHttpBufferSize` is
  **derived** from `CHAT_ATTACHMENT_MAX_BYTES` via `realtimeMaxBufferBytes()` —
  never write it down separately, or a valid attachment gets dropped by the
  transport before any handler can answer it. Rooms reaped 15 min after emptying
  (`ROOM_EMPTY_TTL_MS`, exposed only so the soak test can observe it).
- Ack failures return `{ ok: false, error: 'CODE' }` — never leave a client ack
  callback hanging. Every user-initiated client action settles exactly once (the
  server's verdict or a timeout), and optimistic state reverts ORDER-AWARE via
  the attempt tracker in `src/lib/acks.ts` — a late rejection must never undo a
  newer accepted change.
- Startup config is validated in `server/config.js`: production refuses to boot
  on an invalid value, and a PARTIAL object-storage block is always fatal (the
  fallback silently loses uploads). Secrets are never echoed.
- Health: `/healthz` = alive (200 even while draining), `/readyz` = should
  receive traffic (503 while draining). One idempotent shutdown handles SIGTERM /
  SIGINT / uncaughtException; `unhandledRejection` is logged, not fatal.
- Security headers live in `server/headers.js` and apply to everything this
  process serves. The CSP must keep working for YouTube, the WebSocket, data:/
  blob: media and the configured storage origin — never tighten it without
  running `scripts/headers.test.mjs` and a browser smoke check. COEP
  `require-corp` is deliberately absent.
- Keep diffs minimal and architecture intact. Preserve reusable components and
  existing style. This repo uses an implement-then-review flow (a second model
  reviews before merge) — optimize for production quality, not quick fixes.
- Serverless is unsupported: Socket.IO needs a long-lived process.

## Deployment mode & built-in recommendations

**Current mode: demo/beta WITHOUT hosted uploads.** The large-upload pipeline
(multipart → S3, single-shot → dev filesystem) is fully built and tested, but
enablement is decided by `server/upload-availability.js`
`getUploadAvailability(env)` → `{ enabled, mode:'s3'|'local-dev'|'disabled' }`:
- **production** requires a COMPLETE S3 config **and** a strong `UPLOAD_SECRET`
  **and** an explicit `MAX_UPLOAD_BYTES`, else uploads are **disabled** — the dev
  filesystem adapter is NEVER used for real user videos;
- **development/test** keeps the local dev-upload path (`mode:'local-dev'`).
The verdict gates `upload:intent` (`createUploadIntent` refuses on
`uploadConfig.uploadsEnabled === false` with `UPLOADS_DISABLED`, explicit-false
only so older configs/tests/preflight are unaffected) AND rides in every room
snapshot (`RoomSnapshot.uploadAvailability`), so `SourcePicker` shows *"Uploads
are not available in this demo yet."* up front instead of a control that would
only fail on submit. **All S3/multipart code, staging scripts, tests and docs are
kept** — only enablement changed. Covered by `scripts/upload-availability.test.mjs`.

**Built-in recommendations.** `src/data/recommendedMovies.ts` is a curated catalog
(≥12 Punjabi, ≥15 Bollywood, ≥15 Hollywood; 40–50 total) of **official** YouTube
trailers — every `youtubeVideoId` is on a rights-holder/studio/label channel and
verified LIVE via oEmbed by `npm run validate:youtube-catalog` (reachable +
embeddable + channel match; non-zero exit on any failure). The pure shape half
(`validateRecommendedCatalog`) also runs offline in the unit suite
(`scripts/recommended-movies.test.mjs`). A card maps to the canonical youtube
source via `toYouTubeSource` → `{ type:'youtube', value:'<videoId>' }`; clicking
one seeds a fresh room (`useStartRecommendation`) or sets the current room's
source (SourcePicker **Recommended** tab → `source:set`), so both members watch
the same synced player — YouTube bytes never touch this server. Posters are the
official YouTube thumbnail for that upload (`i.ytimg.com`) — YouTube trailer
artwork, not a movie poster, with a generated fallback image on load failure; swap
for TMDb later without a shape change. UI: `src/components/recommend/`
(`RecommendedMovies` section on home + browse, `RecommendationCard`).

**Future work (NOT done, do not claim otherwise):** (1) **real S3 staging** for
genuine 3 GiB hosted uploads — preflight + matrix tooling exists under
`scripts/staging-*.mjs`, blocked only on a paid bucket; (2) **MKV → MP4 background
conversion** so non-browser-playable uploads become streamable. Neither is
production-ready; the allowlist stays MP4/WebM/OGG.
