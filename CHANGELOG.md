# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-07-27

First release. A complete rebuild of an earlier single-file watch-together page
into a production application.

### Added

**Sync engine**

- NTP-style clock alignment per client, using the median offset of the
  lowest-latency samples.
- Control events carrying the initiator's playhead plus a server timestamp, so
  network transit is compensated rather than becoming desync.
- Continuous drift correction: errors under 250 ms ignored, up to ~1.2 s
  absorbed by a 6% playback-rate nudge, larger errors hard-seeked.
- Heartbeat from the playing client so the server's extrapolation stays honest.

**Rooms**

- Six-character room codes with shareable invite links.
- Optional passphrase, waiting room with host approval, and room locking.
- Removing a participant, handing over the host seat, automatic host succession
  when the host leaves.
- Rooms held in memory and reclaimed shortly after the last person leaves.

**Player**

- Auto-hiding animated controls, floating seek bar with hover time preview and
  buffered range, volume, fullscreen, subtitles, picture-in-picture, quality
  selector and playback speed.
- Full keyboard control and a touch-aware tap surface.
- One `PlayerHandle` interface implemented by both the HTML5 and YouTube
  engines, so sync behaves identically across sources.

**Chat and presence**

- Typing indicators, read receipts, message reactions and floating on-screen
  reactions.
- Image, file and voice-note sharing, with waveform playback for voice notes.
- Emoji picker and a GIF board.

**Calls**

- Peer-to-peer voice and video over WebRTC with echo cancellation, noise
  suppression and automatic gain control.
- Screen sharing with clean fallback to camera when sharing stops.
- Microphone and camera toggles, live connection quality and packet-loss
  reporting.

**Catalog**

- Built-in Open Cinema collection of openly licensed films that stream
  instantly.
- Search, genre filters, trending, most watched, continue watching, favorites
  and watch later.
- Film detail sheet with overview, cast, director, rating and runtime.
- Poster art generated locally as SVG, so no remote image can break the grid.

**Design and accessibility**

- Dark-first glass design system: aurora light fields, cursor spotlight,
  particle drift, animated gradient borders, spring motion.
- High-contrast mode, reduced-effects mode, and global `prefers-reduced-motion`
  support.
- Focus trapping in dialogs, skip-to-content link, labelled icon controls and a
  live region for chat.

**Project**

- Realtime test suite covering 39 behaviours of the Socket.IO layer.
- GitHub Actions CI running type check, production build and the realtime suite.
- `render.yaml` blueprint for one-click deployment.

### Fixed

Found during verification of the initial build:

- The playback echo-guard was suppressing genuine user input, silently dropping
  the first play press after any programmatic seek and letting drift correction
  pull playback back to a stale paused state.
- The server's input sanitiser was stripping spaces and hyphens out of chat
  messages and display names.
- On phone widths the player's empty state overflowed its 16:9 box, clipping the
  button used to choose a film.
- Decorative full-bleed layers could create a few pixels of horizontal scroll on
  narrow screens.
- Tapping the picture on a touch screen toggled playback instead of revealing
  the auto-hidden controls.

[1.0.0]: https://github.com/Ahsan-muhd-444/cineverse/releases/tag/v1.0.0
