# CineVerse — Handoff

What you need to run, verify and ship this. Written for someone who has never
seen the repo. Everything here was verified against the code and the test suites
on 2026-07-29; where something is unverified, it says so.

## What it is

A private cinema for two: perfectly-synced playback, live chat and peer-to-peer
calls in an ephemeral room opened in one click. No sign-up, no database, no
accounts. Room state exists only while someone is in it.

**Next.js 14 (App Router) + a custom `server.js` that runs Next and Socket.IO in
one Node process.** That is not incidental — Socket.IO needs a long-lived
process, so serverless is unsupported.

## Running it

`node`/`npm` are not on PATH on the original development machine. Prefix with:

```bash
$env:Path = "C:\Program Files\nodejs;$env:Path"
```

| Task | Command |
| --- | --- |
| Development server | `npm run dev` (port 3000) |
| Production server | `npm start` (builds are separate: `npm run build` first) |
| Typecheck | `npm run typecheck` |
| Unit tests | `npm test` |
| Realtime E2E (needs a running server) | `TEST_URL=http://localhost:3000 node scripts/e2e-realtime.js` |
| Cold realtime stress (needs a build) | `npm run test:e2e:stress` (`E2E_ITERATIONS=50`) |
| Process lifecycle smoke (needs a build) | `node scripts/process-smoke.mjs` |
| Memory/cleanup soak (needs a build) | `npm run test:soak` |
| **Everything, from cold** | `npm run release:gate` |

`npm start` goes through `scripts/start.mjs` rather than an inline
`NODE_ENV=production`, so it works on Windows as well as Linux.

> **Never run `next build` while the dev server is running in this directory.**
> They share `.next`; the build replaces the chunks under the live server and
> localhost:3000 degrades to an unstyled 404 shell. Stop dev first. The release
> gate asserts `.next/BUILD_ID` survives its own run, because a stray dev server
> started by a test does exactly this.

## The release gate

`npm run release:gate` is the single command that decides whether this ships. It:

1. typechecks;
2. builds for production and verifies `.next/BUILD_ID` exists;
3. **enumerates** the unit suites (never a wildcard — see below), prints how many
   it found, and runs them;
4. starts a **production** server on an OS-assigned free port with a short
   reconnect grace, and waits for `/readyz`;
5. runs the realtime E2E suite against it;
6. runs the process lifecycle smoke test;
7. re-checks the build survived;
8. shuts the server down and confirms the port was released.

It owns its own server, needs no dev server, cleans up in `finally`, and does
not retry anything. A flaky test that passes on a second attempt is a failing
test with the evidence discarded.

**Unit-test discovery is explicit.** The gate used to pass Node the literal
string `scripts/*.test.mjs` with `shell:false`. That is only safe if Node expands
it — and when it does not (older runtimes, or a pattern matching nothing) `node
--test` exits **0 having run zero tests**, so the gate goes green while testing
nothing. Files are now enumerated by `scripts/release-gate-lib.mjs`, the count is
printed, and an empty result throws. `npm test` uses the same discovery, so the
two can never disagree. A healthy run prints:

```text
  discovered 20 unit-test files
ℹ tests 369
```

## Diagnosing a realtime failure

The realtime suite numbers every check, records the section it belongs to and
the elapsed time, and prints a consolidated footer before exiting:

```text
FAILED CHECKS
#143 (seat) after grace expires the member is removed exactly once — left=0  [18234ms, section: 20. stable seat identity + reconnect grace]
```

The same footer is printed when the harness itself throws, along with the checks
that had already run.

Set `E2E_RESULT_FILE=/abs/path/result.json` for a machine-readable result —
written for success and failure, atomically (temp file then rename) so a killed
process cannot leave a partial file that still parses. Details are scrubbed of
tokens, seat ids, passwords, SDP and attachment payloads before they reach disk.

The release gate does this automatically. Every run tees the realtime step to
`.artifacts/release-gate/<timestamp>-<pid>/` — `e2e.log`, `e2e-result.json`,
`server.log`, `gate-summary.json` — while still streaming to the console, and a
failure prints:

```text
Release artifacts: .artifacts/release-gate/2026-…-1234
```

`.artifacts/` is git-ignored.

**To chase an intermittent failure**, use the stress harness rather than
re-running the gate. Each iteration is a genuinely cold production server on a
fresh ephemeral port, exercised once, then shut down and confirmed gone; it
reuses the existing build, never writes `.next`, and never touches port 3000:

```bash
npm run build
E2E_ITERATIONS=50 E2E_CONTINUE_AFTER_FAILURE=1 npm run test:e2e:stress
```

It stops at the first failure by default. `E2E_CONTINUE_AFTER_FAILURE=1` runs
everything and reports failing checks by frequency. Per-iteration logs land in
`.artifacts/e2e-stress/`. The release gate deliberately still runs the suite
**once** — it is a gate, not a retry loop.

An iteration passes only when the **result artifact** says so. A zero exit code
is not sufficient: a missing file, malformed JSON, a result reporting zero
checks, counts that do not add up, a failure list whose length disagrees with the
count, or any disagreement between the artifact and the exit code all fail the
iteration (`scripts/e2e-stress-lib.mjs`). The release gate applies the *same*
validator to its own `e2e-result.json`, so "the gate writes four artifacts" is an
enforced contract, not a claim in a summary.

`E2E_ITERATIONS`, the timeouts and every `SOAK_*` count are parsed strictly and
reject non-positive or fractional values **before** a server is started, because
`Number('-1') || 20` yields `-1` and a loop that runs `-1` times would otherwise
exit 0 having tested nothing.

**Logs are flushed on `close`, never `exit`.** `exit` fires when the child
process dies, while its stdout/stderr pipes may still hold unread data — so
ending the sink there truncates the *last* lines, which are the failing assertion
and the summary. `scripts/child-process-lib.mjs` settles only after stdio closes
and the sink has flushed, and a log that could not be written **fails** the
owning harness rather than leaving a silently missing artifact.

## Health and readiness

| Endpoint | Meaning | While shutting down |
| --- | --- | --- |
| `/healthz` | the process is alive | still **200** |
| `/readyz` | it should receive traffic | **503** |

`/healthz` staying 200 during a drain is deliberate: a liveness probe that fails
mid-drain gets the container killed before it has finished draining. Neither body
contains room codes, names, filenames or tokens.

## Shutdown

One idempotent path handles `SIGTERM`, `SIGINT` and `uncaughtException`:
readiness drops first, connected clients are told (`server:shutdown`), Socket.IO
closes, then HTTP, then the owned intervals, then storage. A forced exit fires if
teardown stalls. Normal signals exit `0`; a fatal error exits nonzero.

`unhandledRejection` is logged with full context but is **not** fatal — one
rejected promise in a socket handler must not end everyone else's film.

In-memory rooms are deliberately not persisted on the way out. Ephemeral rooms
are the product, not a limitation.

## Configuration

Every variable is optional and documented in `.env.example`. `server/config.js`
validates them at startup: in production an invalid value refuses to boot; in
development the same problems print as warnings. A **partially** configured
object-storage block is always fatal, because the fallback (writing to local
disk) silently loses every upload on the next redeploy.

Secrets are never echoed back — only whether they were set.

## Where things live

```
server.js                 Next + Socket.IO; ALL room state (in-memory Map)
server/
├── rate-limit.js         token buckets + policy table + client identity
├── chat-limits.js        attachment validation, history byte budget,
│                         and the DERIVED Socket.IO frame limit
├── config.js             startup configuration validation
├── headers.js            CSP + security headers
├── lifecycle.js          readiness + graceful shutdown state machine
├── seats.js              stable seat identity + reconnect grace
├── rtc.js                signal validation
├── uploads*.js           presigned upload flow
└── storage/              S3-compatible + dev filesystem adapters
src/
├── app/                  routes: home, browse, join, room/[code], error, 404
├── components/{ui,fx,home,browse,room,layout}/
├── hooks/                useRoom, useSyncedPlayback, useWebRTC, playbackProjection,
│                         roomLifecycle
└── lib/                  types, catalog, media, storage, socket, acks, a11y, rtc
scripts/                  unit suites (*.test.mjs), E2E, smoke, soak, release gate
```

## Deployment mode & future work

**Ships as demo/beta WITHOUT hosted uploads.** The multipart-to-S3 upload pipeline
is complete and tested, but `server/upload-availability.js` disables it in
production unless a real S3 bucket + strong `UPLOAD_SECRET` + `MAX_UPLOAD_BYTES`
are configured (it never falls back to the dev filesystem for real user videos).
When disabled, the source picker shows *"Uploads are not available in this demo
yet."*; no S3 = no broken upload buttons. Verify with
`scripts/upload-availability.test.mjs`.

**Built-in recommendations** (`src/data/recommendedMovies.ts`, UI in
`src/components/recommend/`) give a room something to play with zero setup: 40–50
official YouTube trailers (Punjabi / Bollywood / Hollywood), each verified live by
`npm run validate:youtube-catalog`. Clicking one opens a synced room on that
trailer; nothing is uploaded.

**Future work (not production-ready):** (1) real S3 staging for genuine 3 GiB
hosted uploads — tooling under `scripts/staging-*.mjs`, blocked on a paid bucket;
(2) MKV → MP4 background conversion. The upload allowlist stays MP4/WebM/OGG until
(2) lands.

## Reading order for a new maintainer

1. `CLAUDE.md` — the architectural contracts that must not be broken.
2. `PROJECT_KNOWLEDGE.md` — why the hard parts are the way they are.
3. `server.js` boot section — config check, headers, health, shutdown.
4. `src/hooks/useSyncedPlayback.ts` — the product, in one file.
5. `PROJECT_HEALTH_REPORT.md` — what is verified, and what is not.
