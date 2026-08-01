# CineVerse — Project Knowledge

Why the difficult parts are built the way they are. Every entry here exists
because getting it wrong produced a real, observed failure — this is the file
that stops those being reintroduced.

## Playback sync is the product

Three mechanisms, in `src/hooks/useSyncedPlayback.ts` and `src/lib/socket.ts`:

1. **Clock alignment** (`calibrateClock`) — NTP-lite: sample RTT, keep the
   low-latency half, take the median offset. `serverNow()` = `Date.now() + offset`.
2. **Control events** (`sync:control`) — carry the initiator's playhead and the
   server timestamp; the receiver adds transit time back (scaled by rate) before
   seeking.
3. **Drift correction** every 2.5s — under 0.25s ignore, 0.25–1.2s nudge the rate
   ±6% relative to the room's base rate (invisible), over 1.2s hard-seek. The
   playing side heartbeats every 3s.

`PlayerHandle` is the narrow interface both the HTML5 `<video>` and the YouTube
iframe implement, so the sync layer never knows which engine is on screen.
Optional capabilities (`canRateNudge`, `isBuffering`) let the drift loop back off
for engines with a fixed rate set.

### Deterministic sync authority

Reports are **not** last-writer-wins. Each room carries `controllerId`,
`controlSeq`, `sourceVersion`, `lastControlAt`, `lastControllerReportAt`.

- `source:set` bumps `sourceVersion` + `controlSeq` and resets playback.
- `sync:control` bumps `controlSeq`, makes the sender the controller, and **acks
  the epoch** so the client's heartbeats become trusted.
- `sync:report` is accepted only if it matches the current epoch, comes from the
  controller (or the deterministic fallback once the controller is gone or stale
  past `CONTROLLER_TTL = 12s`), is finite, and does not rewind while playing.
- Heartbeats never pause the room.

**A rejected `sync:control` must not be believed.** The client leaves its epoch
refs untouched and immediately pulls authoritative state, because the local
engine has already moved — the user pressed the button — and would otherwise sit
alone with its own idea of the playhead.

## Two control models for media — do not merge them

- **YouTube** uses **native YouTube controls** as the visible UI. CineVerse
  renders only the iframe: no custom control bar, centre button, opaque cover,
  reveal timer, "Starting…" screen or click-swallow layer. It owns only room sync,
  mirroring native play/pause/seek/rate via `onUserIntent` with echo suppression
  and poll-based seek detection.
- **HTML5 / catalog / URL / local** use CineVerse's own control bar.

### YouTube specifics that took real debugging

- **Never pause or seek-to-~0 a never-played CUED player.** It turns YouTube's
  thumbnail into a black frame — the "blank startup" bug. Guarded by
  `hasPlayedRef` + `isCued()`.
- The iframe is created **once per `videoId`**; callbacks live in refs so chat,
  presence, typing and drift re-renders never rebuild the player.
- The API loader (`src/components/room/youtubeApi.ts`) caches only the
  **in-flight** promise. Caching a resolved one meant that after a refresh, when
  the `YT` global was gone, the stale promise resolved instantly and the player
  never came back.
- **Fullscreen belongs to CineVerse, not to YouTube.** `fs:0`, `disablekb:1`, no
  `fullscreen` in the iframe `allow` list, no `allowfullscreen` attribute, and
  `Permissions-Policy: fullscreen=(self)`. A cross-origin iframe that takes the
  screen cannot be overlaid by the parent, so the shell would lose its chrome.
  Verified in a real browser: the generated iframe has no fullscreen permission.
- The editable-target keyboard guard runs **before** the YouTube branch —
  otherwise typing "f" in chat toggled fullscreen.

## Identity: seats, not sockets

`socket.id` is transport only and changes on every refresh. Membership is keyed
by a **stable member id**, proven by a per-tab, per-room `seatId` held in
`sessionStorage` (not `localStorage` — two tabs would collide).

- A refresh reclaims the seat inside `ROOM_RECONNECT_GRACE_MS` (default 30s).
- A kick tombstones the **seat**, so the stable identity cannot walk back in.
- WebRTC routes by member id, and only `connected` members are handed to the call
  layer — a member inside their grace window is still listed in presence (so the
  People list does not churn) but has no live transport to signal to.
- Rate limits key on the member id, so refreshing cannot reset an abuse counter.

## Authorization: one authority

`socket.data.roomCode` ∩ `room.members`. Never a cached boolean, never Socket.IO
channel membership.

- `memberContext(socket)` → `{room, member}` only if approved.
- `hostContext(socket)` → member **and** host.
- `admitSocket` is the only admission path; `departRoom` the only departure path
  (idempotent); `closeRoom` ends a session when the last member leaves a room
  that still has lobby guests. A lobby entry is never promoted.
- `rtc:signal` requires both parties to be members of the same room.
- `lobby:enter` is permanently rejected — admission is server-completed.

Every room-scoped event requires `memberContext`; host-only events require
`hostContext`; and every mutation is authorization-first, rate-limit-second,
side-effect-third.

## Abuse limits

In-memory token buckets (`server/rate-limit.js`) — lazy refill, no timer per
bucket, LRU-bounded map with a TTL sweep. Keys are layered:
`socket:<id>:<policy>`, `ip:<addr>:<policy>` (×12 budget, loopback exempt),
`member:<room>:<memberId>:<policy>`.

Two sizing rules that are load-bearing:

- **Chat traffic must never spend playback capacity.** `chat:typing` and
  `chat:seen` use `chatBackground`; only `sync:request`/`sync:report` use
  `syncBackground`. Sharing one bucket let a fast typist suppress the active
  controller's heartbeats and trigger a stale-controller handoff. The client also
  batches typing into one packet per burst.
- **The attachment bucket must fit the largest valid attachment.** A bucket
  smaller than the accepted file size makes large-but-valid files permanently
  unsendable, since `cost > capacity` can never be satisfied by waiting.
  `buildRuntimePolicy` derives the capacity from `maxAttachmentCost`.

Loopback is exempt from per-IP limits because a reverse proxy on the same host
without `RATE_LIMIT_TRUST_PROXY` makes every real user appear as 127.0.0.1 —
enforcing a shared bucket there is a self-inflicted outage.

## Memory bounds

Attachments travel as data URLs and live in the room's history, so a 200-message
cap alone was not enough. Rooms carry a **byte** budget too, and attachment size
is computed from the payload — never from the client-declared `size`. Decoded
length is derived from base64 length and padding rather than by decoding, so an
oversized payload cannot force a large allocation just to be rejected.

The Socket.IO frame limit is **derived** from the attachment limit
(`realtimeMaxBufferBytes`), with envelope headroom on top. Written down twice,
the two drift, and a valid attachment gets dropped by the transport before any
handler can answer it. The headroom is also what lets a slightly oversized
payload reach the handler and come back as a clean `TOO_LARGE`.

## Acknowledgements and optimistic state

Every user-initiated action settles exactly once — the server's verdict or a
timeout. The subtle case is ordering: two quick source changes A then B, with A
rejected after B was accepted, must leave B alone. A monotonic attempt counter
bumped by both optimistic attempts and authoritative broadcasts makes "may this
revert still apply?" decidable (`src/lib/acks.ts`).

A join that is rate-limited is transient, not terminal: it shows a waiting state
and retries with the server's own backoff, bounded. Rendering it as a permanent
"could not join that room" told users to give up when waiting two seconds would
have worked.

WebRTC signalling is acknowledged too. A dropped ICE candidate is ignored — they
are bursty and individually expendable. A dropped offer or answer is re-sent a
bounded number of times, because nothing else in the negotiation loop will retry
it; an unreachable peer is dropped immediately.

## Security headers

Built in `server/headers.js` and applied to everything this process serves,
including uploaded-video streams and the health endpoints. The CSP describes what
the app actually does: YouTube's iframe and API, same-origin WebSockets, data:
and blob: media, and the configured object-storage origin.

Two deliberate loosenings, recorded so they are decisions rather than oversights:
`script-src 'unsafe-inline'` (Next's App Router streams hydration data in inline
scripts; removing it needs per-request nonces through middleware), and
`img-src`/`media-src https:` (the product is "paste a link and watch it
together", so a host allow-list cannot be complete).

`Cross-Origin-Embedder-Policy: require-corp` is deliberately **not** set — it
would block the YouTube iframe and every cross-origin poster.

## Conventions

- Server sanitizes all input via `clean(v, max)`.
- Ack failures return `{ ok: false, error: 'CODE' }` — never leave a callback
  hanging.
- Every server timer is `unref()`d and cleared on shutdown.
- Keep diffs minimal and the architecture intact; this repo uses an
  implement-then-review flow, so optimize for production quality over speed.
