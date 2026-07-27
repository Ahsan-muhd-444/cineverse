# Contributing

Thanks for wanting to help. This is a small project, so the process is short.

## Getting set up

```bash
git clone https://github.com/Ahsan-muhd-444/cineverse.git
cd cineverse
npm install
npm run dev          # http://localhost:3000
```

There is nothing else to configure. No database, no API keys, no accounts.

## Testing a change to the room

Two browser tabs will not do. Tabs in the same profile share a Socket.IO
connection, so they behave as one participant. Use two different browsers, or
one normal window and one private window.

Before opening a pull request:

```bash
npm run typecheck                 # strict TypeScript
npm run build                     # production build
node scripts/e2e-realtime.js      # 39 realtime checks, needs a running server
```

The realtime suite drives the Socket.IO layer with simulated clients and covers
room creation, presence, playback propagation, drift extrapolation, chat,
typing, read receipts, the password gate, the waiting room, locking, kicking
and host handover. If you touch `server.js`, add a check there too.

## Working on the sync engine

This is the part most worth being careful with. Three things keep two players
together, and they interact:

1. **Clock alignment** (`src/lib/socket.ts`) — each client measures its offset
   from the server before anything else happens.
2. **Control events** (`server.js` + `src/hooks/useSyncedPlayback.ts`) — carry
   the initiator's playhead and a server timestamp so transit time is added
   back rather than becoming desync.
3. **Drift correction** — runs every 2.5 s and corrects gently or hard
   depending on the size of the error.

A change that looks harmless in one of these often shows up as a stutter in
another. Test with a real video, not a short clip, and watch both sides.

One rule worth stating explicitly: `emitControl` must never be suppressed by the
apply-guard. That guard exists to stop the *media element's own events* echoing
back — a real user press has to get through. Getting this wrong silently drops
the first play after any seek.

## Style

- TypeScript everywhere in `src/`, `strict` on. No `any` without a comment
  saying why.
- Tailwind for styling. Shared visual language lives in `tailwind.config.ts` and
  `src/app/globals.css` — reach for an existing token before adding one.
- Comments should explain *why*, not restate the code.
- Keep components in the folder that matches their role: `ui/` is generic,
  everything else is feature-specific.

## Accessibility

Non-negotiable, and easy to check:

- Everything reachable and operable by keyboard.
- Visible focus states — never remove the ring without replacing it.
- `aria-label` on any icon-only control.
- `prefers-reduced-motion` respected; new animations must degrade.
- No horizontal scroll at 360 px.

## Reporting bugs

Use the issue template. For anything sync-related, please say which two devices
and browsers were involved and what you were watching — those details decide
whether it reproduces.
