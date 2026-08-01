# CineVerse — Engineering Playbook

How to change this codebase without breaking it. Short, and all of it earned.

## Before you start

Read `CLAUDE.md` and the relevant section of `PROJECT_KNOWLEDGE.md`. Most of the
tempting "obvious" fixes in this repo have already been tried and reverted; the
comments in the code say which, and why.

## The rules that are not negotiable

1. **One process.** Next and Socket.IO share a Node process. Serverless is not an
   option — the realtime layer needs a long-lived server.
2. **Authorization first, rate limit second, side effect third.** Every
   room-scoped handler. No exceptions, including new ones you add.
3. **Never trust a cached authorization.** Re-derive from
   `socket.data.roomCode` ∩ `room.members` through `memberContext`/`hostContext`.
4. **Every ack settles.** A handler that can reject must ack with
   `{ ok: false, error: 'CODE' }`. A client that waits must have a timeout.
5. **Optimistic state reverts or resyncs** when the server refuses — and the
   revert must be order-aware (see `src/lib/acks.ts`).
6. **Every timer is cleaned up.** `unref()` server-side; cleared on unmount
   client-side; cleared on shutdown for anything the server owns.
7. **Never widen a limit by writing it down twice.** Derive it. The transport
   frame size comes from the attachment limit; the attachment bucket capacity
   comes from the maximum attachment cost.
8. **Never hide a failing test.** Not by deleting it, not by loosening the
   assertion, not by adding a sleep, not by retrying.
9. **Never let a test runner discover its own work with a wildcard.** `node
   --test 'scripts/*.test.mjs'` exits **0 with zero tests** when the pattern does
   not expand (older runtimes) or matches nothing. Enumerate the files, assert
   the count is nonzero, print it. See `scripts/release-gate-lib.mjs`.
10. **Never trust an exit code alone.** A child can exit 0 having written no
    result, a truncated one, one reporting zero checks, or one whose counts
    contradict each other. Validate the artifact and require it to agree with the
    exit code; a disagreement means the harness is wrong and neither signal can
    be believed. See `scripts/e2e-stress-lib.mjs`.
11. **Parse configuration strictly.** `Number(raw) || fallback` turns `-1` into
    `-1` and `0` into the fallback. A loop that runs `-1` times exits 0 having
    proved nothing. Throw before anything is spawned.
12. **Flush artifacts before settling, on `close` not `exit`.** `exit` fires when
    the child dies, while its pipes may still hold unread data — the lines lost
    are the last ones, which is what you opened the log for. Wait for `close`,
    then `await finished(sink)`. See `scripts/child-process-lib.mjs`.
13. **A failed log write fails the harness.** `finished(sink).catch(() => {})`
    turns disk-full into a silently missing artifact. If a diagnostic was
    promised and not written, say so loudly.
14. **`child.killed` is not proof of exit.** It records that a signal was
    *delivered*; a process that caught it and kept running still reports `true`.
    Use a bounded wait on the exit event, then escalate to `SIGKILL`.
15. **`forced` is not proof of exit either.** It means SIGKILL was *attempted* —
    a process stuck in uninterruptible I/O can survive it. Assert on `exited`
    (the observed termination) AND on port release, separately. One shared
    implementation: `shutdownServer` in `scripts/child-process-lib.mjs`.
16. **Never test child output by `process.exit()` after a big write.** The child
    truncates *itself* — `exit()` can discard its own pending stdout — so the
    test fails for a reason unrelated to the parent's flushing. Await the drain,
    set `process.exitCode`, and let Node exit naturally. Prove flush ordering
    with a fake-child `exit → data → close` sequence instead; pipe scheduling
    makes real-child large-output tests non-deterministic proof.

## Adding a realtime event

```js
socket.on('thing:do', (payload = {}, ack) => {
  const ctx = memberContext(socket);              // 1. authorize
  if (!ctx) return ackWith(ack, { ok: false, error: 'UNAUTHORIZED' });
  const verdict = limitMember(ctx, POLICY.roomMutation);  // 2. rate limit
  if (!verdict.ok) return rateLimitedAck(ack, verdict);
  // 3. validate, then mutate, then broadcast
  ackWith(ack, { ok: true });
});
```

Pick the policy by what the event *is*, not by what is convenient. If it is
background protocol traffic, it needs its own bucket — sharing one lets a chatty
feature starve a critical one, which is exactly how typing came to suppress
playback heartbeats.

Client-side, use `emitAction` (fire, report a rejection) or a promise with a
timeout (when the caller needs the verdict).

## Testing expectations

| Kind | Where | Needs |
| --- | --- | --- |
| Pure logic | `scripts/*.test.mjs` | nothing — `node --test` |
| Protocol behaviour | `scripts/e2e-realtime.js` | a running server |
| Process lifetime | `scripts/process-smoke.mjs` | a production build |
| Cleanup / leaks | `scripts/soak.mjs` | a production build |
| Lifecycle races | `scripts/e2e-stress.mjs` | a production build |

Extract the decision into a pure function and test that. This repo has no DOM or
React test environment, so a rule that only exists inside a component is a rule
nobody can verify — which is why the join-failure classification, the signal
failure policy, the attempt ordering and the keyboard guards all live in
`src/lib` and `src/hooks` as plain functions.

Write the test so its **name states the regression**. "a LATE rejection for A
does not clobber a newer attempt B" survives a refactor; "test source 2" does not.

### Timing in the realtime suite

Never assert on a server timer by sleeping past it and hoping. A fixed margin
over a 500 ms grace window is a race that passes on an idle laptop and fails on a
loaded CI box — and when it fails you get one lost FAIL line, not a diagnosis.

Wait for the **state**, bounded. `scripts/e2e-realtime.js` provides
`presenceMatching(socket, predicate)` and `messageMatching(socket, predicate)`
for exactly this:

```js
// Wrong: hope 1200ms is enough for a 500ms timer plus delivery, then assert on
// whatever happened to arrive. This failed 1 cold run in 41.
const p = lastPresenceOver(member, GRACE_MS + 700);
host.disconnect();
assert((await p).hostId === memberId);

// Right: resolve the instant succession lands; on timeout return the last
// payload seen, so the failure says what the server actually reported.
const p = presenceMatching(member, (x) => x && x.hostId === memberId);
host.disconnect();
assert((await p).hostId === memberId);
```

This is faster in the happy path, not slower — it stops waiting as soon as the
expected state exists.

If a check does need a window (counting events that must NOT arrive), make the
window generous and assert the absence — absence gets safer with a longer wait,
presence gets flakier.

**A generic timeout is not a neutral choice.** `waitFor`'s default is sized for
an immediate broadcast. Any event that is produced by the reconnect-grace timer —
host succession, seat expiry, orphaned-room close — needs a grace-aware deadline
(`GRACE_MS + …`), because the clock does not start until the timer fires. Two
separate intermittent failures in this suite were exactly this mistake.

**Always pass a `detail`.** A failing check with an empty detail tells you it
failed and nothing else. Report what the server actually said, including the
"nothing came back" case:

```js
check('…', probe && probe.exists === false,
  probe ? `exists=${probe.exists}` : 'probe returned null');
```

## Things that look like bugs but are not

- **Rooms stay in `/healthz` after everyone leaves.** Empty rooms are reaped 15
  minutes later, so a brief disconnect does not destroy the session.
- **A member is listed while `connected: false`.** That is the reconnect grace.
  Presence keeps them; WebRTC does not.
- **Chat typing indicators occasionally clip under heavy load.** The
  `chatBackground` bucket is small on purpose. Cosmetic, and it can no longer
  touch playback.
- **`/healthz` returns 200 during shutdown.** Deliberate — see
  `server/lifecycle.js`.

## Verifying UI in the in-app browser

It does not composite frames. Two consequences, both of which have wasted time
before:

- `requestFullscreen()` always rejects. Verify by counting calls, not by
  observing fullscreen.
- **framer-motion animations never run**, so an animated overlay sits at its
  `initial` opacity and its exit never completes. Never assert on presence or
  opacity of an animated element; assert on the state that drives it
  (`aria-expanded`, a class, a data attribute).
- Background tabs have throttled timers, so idle-timeout behaviour appears late.

## Shipping

`npm run release:gate`, twice, from a cold state. It builds, tests, starts a real
production server, exercises it, and shuts it down. If it fails, fix the cause —
it does not retry, and neither should you.
