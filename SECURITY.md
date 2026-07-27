# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's
[private vulnerability reporting](https://github.com/Ahsan-muhd-444/cineverse/security/advisories/new)
instead, and expect a reply within a few days.

## What this application does and does not store

Worth being precise about, because it shapes the threat model.

**Nothing is written to disk.** There is no database. Room state — the member
list, the playhead, recent chat — lives in the server process's memory and is
discarded shortly after the last person leaves.

**Chat attachments are not persisted.** Images, files and voice notes travel
through the socket as data URLs and are held only in the room's in-memory
history buffer (the most recent 200 messages). They are never written to disk
and never served from a URL.

**Calls are peer-to-peer.** WebRTC audio and video flow directly between
browsers and are encrypted by SRTP. The server relays only the signalling
handshake — it never sees call media.

**There are no accounts.** Display names and preferences are kept in the
browser's `localStorage` and never sent anywhere except as your name in a room.

## Known limitations

These are deliberate trade-offs for a small, ephemeral, account-free app, not
oversights:

- **Room passphrases are compared in plain text in memory.** They exist to keep
  a stranger with a guessed room code out, not to protect secrets. Do not reuse
  a password you use elsewhere.
- **Room codes are six characters** from a 32-character alphabet. Guessable in
  principle, given enough attempts. Use the passphrase or waiting room for
  anything you would mind a stranger seeing.
- **Public STUN servers only.** No TURN relay is configured, so a call may fail
  to connect behind a symmetric NAT. Watching together still works — only the
  call is affected.
- **Any participant can change the film and control playback.** That is the
  point of the product. Host controls cover the door, not the remote.

## Dependencies

Dependencies are pinned to exact versions in `package.json`. Please include the
output of `npm audit` in any report about a dependency.
