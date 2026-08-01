# CineVerse — Project Health Report

State of the codebase as of **2026-07-29**, after the release-completion sprint.
Every number here came from a run recorded below. Where something was not
verified, it is listed under "Not verified" rather than assumed.

## Verdict

**Release-candidate ready.** No known P0 or P1 defect. The remaining risks are
P2/P3 and are listed with what would close them.

The one previously-unexplained realtime failure (a cold run reporting 228/229)
has been reproduced, identified and fixed — see "Intermittent realtime failure"
below. It was a race in the test harness, not in the product.

## Automated coverage

| Suite | Command | Result |
| --- | --- | --- |
| Typecheck (strict) | `npm run typecheck` | clean |
| Production build | `npm run build` | compiled; `/room/[code]` 45.1 kB, 210 kB first load |
| Unit | `npm test` | **367 / 369** across 20 enumerated suites (2 skipped on Windows) |
| Realtime E2E | `node scripts/e2e-realtime.js` | **232 / 232** |
| Process lifecycle | `node scripts/process-smoke.mjs` | **6 / 6**, 2 skipped on Windows |
| Soak | `npm run test:soak` | **15 / 15** |
| Release gate (cold ×2) | `npm run release:gate` | passed in 45.5s and 47.1s |

Unit suites: media, youtube-sync, youtube-api, playback-projection,
room-lifecycle, seats, rtc, uploads, uploads-storage, fullscreen, rate-limit,
acks, lifecycle, headers, config, a11y, release-gate-lib, succession, e2e-stress-lib,
child-process-lib.

## What changed in this sprint

**Realtime isolation.** Chat background traffic (`chat:typing`, `chat:seen`) has
its own bucket, so a fast typist can no longer drain the playback protocol's
budget and suppress the controller's heartbeats. `clock:ping` is rate-limited
pre-admission and acks `null` when throttled, which the calibration code already
skips safely.

**Transport limits.** `maxHttpBufferSize` is now derived from
`CHAT_ATTACHMENT_MAX_BYTES` instead of a hardcoded `12e6`, with envelope headroom
so a slightly oversized payload reaches the handler and returns `TOO_LARGE`
rather than being silently dropped. The attachment limit is clamped to 64 MiB and
the derived buffer to 96 MiB, so a bad env value cannot open a huge frame.

**Acknowledgements.** `lobby:decide`, `room:settings`, `room:lights` and
`room:transfer-host` previously returned nothing at all — a non-host or
rate-limited click did nothing, silently. All four now ack, and the client
surfaces the reason in a dismissible status strip. Source changes revert
order-aware, so a late rejection cannot undo a newer accepted change. A rejected
`sync:control` pulls authoritative state instead of leaving the client alone with
its own playhead. WebRTC signalling is acknowledged, with ICE losses ignored and
handshake losses retried then dropped.

**Process reliability.** `/readyz` added alongside `/healthz`; one idempotent
graceful shutdown for SIGTERM/SIGINT/uncaughtException; `unhandledRejection`
logged but not fatal.

**Security headers.** CSP, Permissions-Policy, COOP, nosniff, Referrer-Policy and
X-Frame-Options applied to everything the process serves.

**Configuration validation.** Invalid production config refuses to boot; partial
object-storage config is always fatal.

**Recovery.** A rate-limited or unanswered join is transient — a waiting state
with bounded backoff — not a permanent "could not join that room".

**Accessibility.** Popover roles and labels, Escape handling that ignores
modified keys, focus return to the opener, an announced incoming call, names for
icon- and colour-only controls, and a fullscreen exit button that stays reachable
by keyboard while the pointer chrome is idle-hidden.

## Verified in a real browser

Chromium, 1360×820, dev server on :3000, two tabs in the same room:

- App boots with the full CSP applied; **zero** blocked resources, Google Fonts
  stylesheet loads, Socket.IO connects (clock calibration reported "Excellent").
- YouTube: IFrame API loads under CSP, iframe renders, and the generated iframe
  has **no** `fullscreen` in its `allow` list and **no** `allowfullscreen`
  attribute — the fullscreen ownership model survived the header work.
- Two-browser: B receives A's YouTube source; People shows 2.
- B refreshes → same seat token, same member (no presence churn), same video
  rebuilt, YouTube API rehydrated, no error card; A unaffected.
- Chat burst of 14: 9 delivered, warning shown in a `role="status"` live region
  ("You're sending too quickly…"), rejected draft preserved in the composer.
- Host-action rejection: 18 rapid lights toggles produced the amber notice strip
  with the server's own retry hint ("Too fast — try again in 1s.").
- Keyboard: `f` typed in the chat box produced **0** fullscreen requests; `f` on
  the page produced 1.
- Emoji picker: opens (`aria-expanded=true`), plain Escape closes it and returns
  focus to the trigger, Ctrl+Escape is correctly ignored.

## Not verified

These are honest gaps, not assumed passes.

- **Real camera/microphone/screen-share.** The automation browser blocks media
  capture. WebRTC is covered at the signalling level by E2E and by unit tests for
  the negotiation policy, but accept/decline/mute/camera-off/hangup with real
  devices, and a refresh mid-call, need a manual two-machine pass.
- **Actual fullscreen.** The automation pane does not composite, so
  `requestFullscreen()` always rejects. Verified by counting calls; entering and
  exiting fullscreen visually is a manual check.
- **Idle-hide of cursor and chrome in fullscreen.** Depends on real fullscreen.
- **Animated overlay visuals.** framer-motion animations do not run in the
  automation pane, so overlays were verified through the state that drives them
  (`aria-expanded`), not their appearance.
- **Uploaded-video playback end to end.** The upload pipeline is covered by unit
  and E2E tests; playing a real uploaded file, seeking within it, and refreshing
  mid-playback is a manual check.
- **Clean exit code 0 on SIGTERM.** Windows terminates on `kill()` without
  running handlers, so the process smoke test skips that assertion here and
  reports it as skipped. The shutdown state machine itself is unit-tested
  (ordering, idempotence, step isolation, forced exit). Linux asserts it fully.
- **Screen-reader pass.** No NVDA/VoiceOver run was done. Roles, names and live
  regions were verified structurally.
- **Mobile browsers.** No device testing.

## Intermittent realtime failure — found and fixed

**Symptom.** One cold release-gate run reported `228/229` and correctly failed;
the failing check's identity was lost to console truncation.

**Reproduced.** 1 failure in 41 cold stress iterations (`scripts/e2e-stress.mjs`,
iteration 10), with the same 228/229 signature:

```text
FAILED CHECKS
#91 (16) lobby member is never promoted to host — host=m_91c8b27b196244504c
     [12232ms, section: 15. membership authorization]
```

The server log for that iteration is clean — no error, no restart. The check
immediately before it, `#90`, exercises the *same* succession mechanism in a
room with no lobby and passed.

**Root cause — the test, not the product.** The check read the last `presence`
payload to arrive inside a fixed 1200 ms window after disconnecting the host.
Succession is driven by the server's `ROOM_RECONNECT_GRACE_MS` (500 ms) timer:
when that timer, `finalizeRemoval` and the broadcast landed after the window
closed, the last payload in it was the *pre-departure* snapshot, which still
names the departing host. The assertion failed on a stale read, not a wrong
result — no lobby guest was ever promoted (`hostId` was a member id, and a lobby
guest is only ever identified by socket id).

**Fix.** Fixed windows replaced with bounded wait-for-state
(`presenceMatching`, `messageMatching`): they resolve the instant the expected
state arrives, spend the full timeout only when something is genuinely wrong,
and return the last payload seen on timeout so the failure detail still reports
what the server said. Applied to both succession checks and to the structurally
identical seat-expiry wait. The suite got *faster*, not slower.

**Regression protection.** The rule the flaky check was guarding — a waiting
guest can never inherit the room — is now a pure function (`server/succession.js`)
with 10 unit tests that cannot race a timer, plus a new E2E assertion (`#16b`)
that watches every presence during the handover rather than only the end state.

### A second instance of the same class

The stress harness then caught a different one, in the orphaned-waiting-room
family (`#105`, `#106`, `#109`). Same shape: the room close is driven by the
grace timer, but the check used `waitFor`'s **generic 4 s default**, which is
sized for immediate broadcasts. A focused probe measured the actual close
latency at **500–521 ms across 60 consecutive runs** (p50 506 ms), so the close
path itself is sound — the deadline was simply the wrong one for a timer-driven
event, and a scheduler stall overran it.

Fixed by making that wait grace-aware (`GRACE_MS + 6000`) rather than by
loosening an assertion. All three checks now also report the state they
observed; their details were **empty** on the failing run, which is what made
the first diagnosis slow. Every check line now carries elapsed milliseconds so
the gap between adjacent checks is directly readable.

## Residual risks

**P2 — `script-src 'unsafe-inline'`.** Next's App Router streams hydration data
in inline scripts, so the CSP cannot forbid them without per-request nonces
threaded through middleware. XSS protection is weaker than a nonce-based policy.
Closing it means adding `middleware.ts` and a nonce — a real change, not a
release-eve one.

**P2 — `img-src`/`media-src https:`.** Users paste arbitrary poster and video
URLs by design, so a host allow-list cannot be complete. Restricted to https (no
downgrade) and non-executable.

**P3 — Windows signal handling.** `npm start` and the gate work, but a clean
`SIGTERM` exit cannot be asserted on Windows. Linux is the release environment.

**P3 — Typing indicators may clip under heavy load.** `chatBackground` is a small
bucket on purpose. Cosmetic only, and it can no longer affect playback.

**P3 — Rooms are held for 15 minutes after emptying.** Deliberate, so a brief
disconnect does not destroy a session. Memory is bounded by the per-room byte
budget; the soak confirms rooms are reclaimed once the TTL passes.

**P3 — No TURN server configured by default.** Calls fall back to public STUN and
will fail behind symmetric NAT. The startup validator warns about this in
production.

## Operating notes

- `/healthz` = alive (200 even while draining); `/readyz` = should receive
  traffic (503 while draining or before the app is prepared).
- Set `RATE_LIMIT_TRUST_PROXY=1` **only** behind a proxy you control that always
  overwrites `x-forwarded-for`. Loopback is exempt from per-IP limits so a
  same-host proxy cannot throttle the whole deployment.
- Set `UPLOAD_SECRET` if you run more than one instance; otherwise upload tokens
  are random per boot and do not survive a restart.
- Configure object storage before any real use — the filesystem adapter is
  development-only and loses uploads on redeploy.
