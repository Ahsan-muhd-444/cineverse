# CineVerse — Design Specification

**Author:** Design Direction · **Date:** 2026-07-29 · **Implementer:** Claude Code
**Scope:** visual and UX only. No functional, architectural, API or flow changes.

---

## 0. Verdict

CineVerse is not a poorly designed product. It has a real token layer, a considered
type scale, custom easings, and genuine craft in the room layout. The problem is
**not absence of design — it is absence of restraint and enforcement.**

Three specific things stop it from reading as premium:

1. **Three accent colours compete simultaneously.** Royal purple, abyss blue and
   electric cyan appear together in the headline gradient and in a *spinning conic
   border*. That combination is the visual signature of gaming and crypto
   products. It is the single largest obstacle to "expensive".
2. **Text has nine opacity levels and no hierarchy.** Measured on the live page:
   white at 1.0, 0.7, 0.6, 0.5, 0.45, 0.4, 0.35, 0.3, 0.2. Users cannot perceive
   nine levels; they perceive "some text is faded". Five of those tiers fail
   WCAG AA.
3. **The decorative layer competes with the content layer.** Aurora + grain +
   cursor spotlight + vignette + four glass variants + an animated gradient border
   all render at once. Premium interfaces are quiet. The film is the subject.

The fix is largely **subtractive** and concentrates in two files.

---

## 1. Audit — measured findings, ranked

All figures below were measured against the running application (1440×900 and
375×812), not estimated.

### P0 — Blocks the "premium" goal

| # | Finding | Evidence | Why it matters |
|---|---|---|---|
| **P0-1** | Three decorative accents used together | `text-gradient` runs white → lilac → royal → electric → white (5 stops); `gradient-border` is a conic royal→abyss→electric spinning at 6s | Multi-hue neon gradients read as gamer/crypto, never as luxury. Premium brands use **one** accent. |
| **P0-2** | Nine white-alpha text tiers, no semantics | 17 distinct text colours on landing; 9 are white-alpha. Counts: `0.5`×48, `0.45`×27, `0.35`×13, `0.3`×10, `0.2`×6, `0.4`×5 | No perceivable hierarchy. Reads as inconsistency, not intent. |
| **P0-3** | Five text tiers fail WCAG AA | Measured contrast on `#090909`: `0.45`→**4.49**, `0.4`→**3.76**, `0.35`→**3.12**, `0.3`→**2.58**, `0.2`→**1.76** (AA normal = 4.5) | ~61 nodes at or below threshold. Legal/ethical exposure and it looks washed out on any non-OLED screen. |
| **P0-4** | Touch targets below 44px | Room has **14 controls at 36×36**; panel tabs 32px tall; "Invite" 69×**30** | WCAG 2.5.5 / Apple HIG minimum is 44. Small controls feel cheap and mis-tap on mobile. |

### P1 — Undermines polish

| # | Finding | Evidence | Why it matters |
|---|---|---|---|
| **P1-1** | Elevation system defined but unused | 6 shadows defined in config; **1 distinct box-shadow actually renders** on the landing page | Everything sits on one plane. No depth, no focus. |
| **P1-2** | Four glass variants + ambient stack | `.glass`, `.glass-soft`, `.glass-deep`, `.glass-lit` + aurora + grain + spotlight + vignette | Classic "random glassmorphism". Blur is expensive and, when everywhere, communicates nothing. |
| **P1-3** | Type scale has 14 sizes incl. artefacts | Landing: 14 distinct sizes; room contains a fractional **11.4px** and a one-off **10px** | Scales should have ~9 deliberate steps. Fractional sizes are accidents. |
| **P1-4** | Non-standard font weight | `650` used 4× (in `display-lg`) | Only renders on variable fonts; silently falls back elsewhere, so the intended weight is not what ships. |
| **P1-5** | Room page has no `h1` | Only heading in-room is an `h2` ("The screen is dark") at 20px | Breaks document outline for screen readers and flattens visual hierarchy. |

### P2 — Consistency debt

| # | Finding | Evidence |
|---|---|---|
| **P2-1** | Off-grid spacing | 24 distinct spacing values; off-4pt: `6px`×16, `10px`×14, `14px`×13, `2px`×5 |
| **P2-2** | Radius one-off | 5 radii in use: `9999`, `12`, `16`, `24` — plus a single **44px** outlier |
| **P2-3** | Eyebrow legibility | `eyebrow` = 11px at `0.22em` tracking, frequently rendered at low alpha (60 uses of 11px) |

### P3 — Refinement

- Empty / loading / error states are not visually unified.
- Hover states are inconsistent (some scale, some brighten, some do both).
- `prefers-reduced-motion` is correctly handled — **keep as is**, this is already right.

---

## 2. The design system

### 2.1 Colour

**Keep** the `ink` scale — it is well constructed. **Replace** the accent strategy.

#### Accent — one, warm, cinematic

Royal/abyss/electric as a decorative trio must go. The replacement is a single
warm gold: it evokes projector light, the marquee and awards-season prestige, and
it is the opposite of the purple-blue SaaS default.

```
--gold-200: #F5E4B8   /* tint, rare */
--gold-300: #EBD08A   /* hover text/icon */
--gold-400: #DDB25C   /* PRIMARY accent — icons, links, focus, key numerals */
--gold-500: #C9963E   /* filled button rest */
--gold-600: #A87A2B   /* filled button pressed */
```

`gold-400` on `ink-900` measures **≈9.8:1** — safe for text and icons.

#### Status — functional only, never decorative

```
--status-live:    #22D3EE   /* retained electric — sync/live ONLY */
--status-success: #4ADE80
--status-warning: #FBBF24
--status-danger:  #F87171
```

**Rule:** status colours may appear as a dot, a 2px bar, a border or label text.
They may never appear in a gradient, a glow, or a background fill larger than 4px.

#### Text — five semantic tiers, all informational tiers pass AA

| Token | Value | Contrast | Use |
|---|---|---|---|
| `--text-primary` | `rgb(255 255 255 / 1)` | 19.9:1 | Headings, key values, active states |
| `--text-secondary` | `rgb(255 255 255 / 0.72)` | 10.1:1 | Body copy, chat messages |
| `--text-tertiary` | `rgb(255 255 255 / 0.58)` | 6.8:1 | Metadata, labels, timestamps |
| `--text-muted` | `rgb(255 255 255 / 0.50)` | 5.3:1 | **AA floor.** Placeholders, disabled labels |
| `--text-faint` | `rgb(255 255 255 / 0.34)` | 3.0:1 | **Non-informational only** — dividers, decorative glyphs. Never carries meaning. |

**Rule:** every `text-white/NN` in the codebase maps to one of these five. Nothing
between tiers. Nothing below `--text-faint`.

Migration map: `0.7`→secondary · `0.6`,`0.55`→tertiary · `0.5`,`0.45`→muted ·
`0.4`,`0.35`,`0.3`,`0.25`,`0.2`→ raise to muted if it carries meaning, else faint.

#### Surfaces

```
--surface-0: #090909   /* page canvas (ink-900) */
--surface-1: #101012   /* cards, panels */
--surface-2: #16161A   /* raised / hover */
--surface-3: #1C1C21   /* modals, popovers */
--hairline:  rgb(255 255 255 / 0.08)
--hairline-strong: rgb(255 255 255 / 0.14)
```

### 2.2 Typography

Nine steps. Delete everything else.

| Token | Size / line-height / tracking | Weight | Use |
|---|---|---|---|
| `display-xl` | `clamp(2.75rem, 6.5vw, 4.5rem)` / 0.96 / −0.035em | 700 | Landing hero only |
| `display-lg` | `clamp(2.25rem, 4.5vw, 3.25rem)` / 1.0 / −0.03em | 700 | Section heroes |
| `display-md` | `clamp(1.75rem, 3vw, 2.25rem)` / 1.1 / −0.025em | 600 | Page titles |
| `title-lg` | `1.5rem` / 1.25 / −0.02em | 600 | Card / modal titles |
| `title-md` | `1.25rem` / 1.3 / −0.015em | 600 | Panel headers |
| `title-sm` | `1.0625rem` / 1.4 / −0.01em | 600 | Row titles, empty-state titles |
| `body` | `0.9375rem` / 1.55 / 0 | 400 | Default UI + chat |
| `caption` | `0.8125rem` / 1.45 / 0 | 400/500 | Metadata, timestamps |
| `micro` | `0.6875rem` / 1 / 0.14em | 600 | Eyebrows, uppercase labels |

**Rules**
- Weights: **400 / 500 / 600 / 700 only.** Remove `650`.
- `micro` tracking reduced `0.22em → 0.14em` (0.22 is decorative and hurts scanning).
- `micro` must never render below `--text-tertiary`.
- No fractional sizes. Remove the `11.4px` occurrence.
- One `h1` per page — including the room.

### 2.3 Spacing — 4pt grid

```
4 · 8 · 12 · 16 · 24 · 32 · 48 · 64 · 96
```

Map `6→8`, `10→12`, `14→16`. `2px` permitted **only** for optical icon alignment,
never for layout gaps or padding.

Section rhythm: mobile `48`, desktop `96`. Card padding: `20` mobile / `24` desktop.

### 2.4 Radius

```
--r-xs:  8px    chips, badges, tags
--r-sm:  12px   inputs, small buttons, chat bubbles
--r-md:  16px   buttons, list rows, video surface
--r-lg:  24px   cards, panels
--r-full: 9999px pills, avatars, icon buttons
```

Delete the `44px` outlier and the unused `4xl`/`5xl`. Nested radius rule: inner =
outer − padding (never equal).

### 2.5 Elevation — four levels, actually applied

```
--e0: none                                            /* flush surfaces */
--e1: 0 1px 0 0 rgb(255 255 255 / 0.05) inset,
      0 8px 24px -12px rgb(0 0 0 / 0.70)              /* cards at rest */
--e2: 0 1px 0 0 rgb(255 255 255 / 0.06) inset,
      0 20px 48px -20px rgb(0 0 0 / 0.80)             /* hover, side panel */
--e3: 0 1px 0 0 rgb(255 255 255 / 0.08) inset,
      0 40px 90px -32px rgb(0 0 0 / 0.85)             /* modals, popovers */
```

**Rule:** elevation belongs to interactive or floating surfaces only. Static text
blocks get `--e0`. Never stack elevation with a glow.

### 2.6 Motion

```
--t-instant: 120ms   hover tint, focus ring
--t-quick:   180ms   buttons, tabs, icon states
--t-base:    240ms   panels, popovers, tooltips
--t-slow:    420ms   section entrance, modal
--ease-standard: cubic-bezier(0.2, 0, 0, 1)
--ease-enter:    cubic-bezier(0.16, 1, 0.3, 1)
--ease-exit:     cubic-bezier(0.4, 0, 1, 1)
```

**Rules**
- Hover = colour/opacity/border change. **No scale on large surfaces** (cards may
  translate ≤2px; nothing scales more than 1.02).
- Infinite animation is permitted **only** for: the aurora (≤0.05 opacity), live
  status dots, and genuine loading indicators. Remove the 6s spinning conic border.
- `prefers-reduced-motion` handling already exists and is correct — **preserve it**.

### 2.7 Focus

Current implementation (2px canvas offset + 2px ring) is structurally right.
Change only the ring colour to `--gold-400` for brand coherence. Retain
`:focus-visible` semantics so pointer users never see it.

---

## 3. Component specifications

### 3.1 Buttons

| Size | Height | Padding X | Radius | Type |
|---|---|---|---|---|
| sm | 36px | 14px | `--r-sm` | caption 500 |
| md | 44px | 20px | `--r-md` | body 500 |
| lg | 52px | 28px | `--r-md` | body 600 |

**Variants**
- **Primary** — `--gold-500` fill, `#0B0B0C` text, `--e1`. Hover `--gold-400`,
  `--e2`. Active `--gold-600`, no shadow. This is the only filled accent in the UI.
- **Secondary** — `--surface-2` + `--hairline`, `--text-primary`. Hover:
  `--hairline-strong`, background `--surface-3`.
- **Ghost** — transparent, `--text-secondary`. Hover: `--surface-1`, text primary.
- **Danger** — transparent + `--status-danger` border/text; hover fills at 12%.

**Rule:** exactly one primary button per view. Two primaries = no primary.

### 3.2 Icon buttons — the touch-target fix

Visual box stays `40×40` (desktop density is fine). Hit area expands to **44×44**
via a transparent pseudo-element:

```
position: relative;
&::after { content:''; position:absolute; inset:-2px; }   /* 44×44 hit area */
```

This satisfies WCAG 2.5.5 **without changing layout, spacing or alignment** — the
critical constraint. Applies to all 14 room controls and the reaction row.

### 3.3 Inputs

Height `44`, radius `--r-sm`, background `--surface-1`, border `--hairline`,
text `--text-primary`, placeholder `--text-muted`.
Focus: border `--gold-400` + the standard focus ring; background lifts to
`--surface-2`. Error: border `--status-danger` + caption message below, never a
red glow.

### 3.4 Chat

- Own messages: `--gold-400` at 10% + `--hairline`, radius `--r-sm` with the
  bottom-right corner at `--r-xs` (subtle tail).
- Others: `--surface-1` + `--hairline`, mirrored tail.
- Author `caption 600 --text-secondary`; timestamp `caption --text-tertiary`;
  body `body --text-secondary`.
- System messages: centered `caption --text-tertiary`, no bubble, no border.
- Bubble max-width and the viewport-locked scroller are already correct — preserve.

### 3.5 Video area — the hero

**Non-negotiable rules:**
- The video surface gets **no glass, no gradient, no coloured border, no glow**.
  Pure black, radius `--r-md`, `--e2`.
- Custom controls (HTML5 path only) sit on a bottom scrim:
  `linear-gradient(to top, rgb(0 0 0 / 0.85), transparent 60%)` — never a glass bar.
- Lights-off dims **chrome only** to 40% opacity. The player never dims.
- **Do not propose or add any overlay on the YouTube iframe.** See §5 guardrails.

### 3.6 Side panel & tabs

Panel: `--surface-1`, `--hairline` left border, `--e2`. Tabs: 44px tall, active =
`--text-primary` + 2px `--gold-400` underline; inactive = `--text-tertiary`.
Count badges: `--surface-2`, `micro`, `--text-secondary`.

### 3.7 Empty · loading · error — one pattern

Centred column, max-width 320px, gap 12:
icon 28px `--text-faint` → title `title-sm --text-primary` → one line
`body --text-tertiary` → at most one action (secondary button).
Loading uses the existing `.skeleton` shimmer. Errors add a `--status-danger` icon
and keep the same layout. **No illustrations, no gradients, no glass.**

---

## 4. Screen notes

**Landing** — Reduce hero to: eyebrow → `display-xl` headline → one
`body --text-secondary` line → single primary CTA. Replace the 5-stop rainbow
`text-gradient` with `--text-primary`, or at most a vertical white→white/70 fade.
Section rhythm to 96px. Cards get `--e1`, hover `--e2` + 2px lift.

**Room** — Add a visually-hidden `h1` ("Room {CODE}") for outline correctness.
Header icon buttons to the 44px hit-area pattern. Reaction row: 40px visual,
44px hits, `--surface-1` at rest.

**Browse** — Poster grid is the content; chrome recedes. Card hover = 2px lift +
`--e2` only. Title `title-sm`, meta `caption --text-tertiary`.

**Mobile** — All targets ≥44px. Section padding 48px. Chat composer pinned with
safe-area inset. Player remains full-bleed.

---

## 5. Guardrails — do not violate

These are product constraints from `CLAUDE.md`, not preferences:

1. **Never render any overlay, control bar, cover, reveal timer or click-swallow
   layer over the YouTube iframe.** YouTube uses its own native controls by
   design. Styling changes stop at the iframe boundary.
2. **Do not change any `aria-label`, `role`, or accessible name.** The realtime
   E2E suite and `scripts/a11y.test.mjs` assert on them.
3. **Do not alter the lights-mode contract** (`lightsMode` dims shell, never player).
4. **Do not touch** `.sr-range`, the seek/volume screen-reader affordances.
5. **Do not add dependencies.** No icon packs, no animation libraries.
6. **Do not change** the viewport-locked chat scroll architecture — the message
   list must remain the only scroller on desktop.
7. **Preserve** `prefers-reduced-motion` handling exactly as implemented.

---

## Claude Code Implementation Plan

Ordered by value-to-risk. **Every task is visual only — no logic, props, state,
event handlers, API calls, or accessible names may change.** After each task:
`npm run typecheck` and `npm test` must pass, and `npm run release:gate` must pass
before the final task is considered done.

---

### ☐ Task 1 — Token foundation *(highest value, 2 files)*

**Files:** `tailwind.config.ts`, `src/app/globals.css`

**Do:**
1. Add the five `--text-*` tokens (§2.1) as CSS variables and matching Tailwind
   `textColor` entries (`text-primary` … `text-faint`).
2. Add the `gold` colour scale; add `status-live/success/warning/danger`.
3. Add `--surface-0…3`, `--hairline`, `--hairline-strong`.
4. Replace `boxShadow` entries with `e0…e3` (§2.5). Keep old keys as aliases for
   one commit so nothing breaks mid-migration.
5. Replace `fontSize` with the nine-step scale (§2.2); remove weight `650`; reduce
   `eyebrow`/`micro` tracking to `0.14em`.
6. Add motion tokens (§2.6).
7. Change the `:focus-visible` ring colour to `--gold-400`.
8. Delete the `4xl`/`5xl` radii.

**Unchanged:** all class names currently in components still resolve (aliases).
**Acceptance:** app renders identically except focus-ring hue; typecheck clean;
no visual regression in the room; `npm test` green.

---

### ☐ Task 2 — Remove the multi-accent decoration *(the "premium" unlock)*

**Files:** `src/app/globals.css`, plus any component using `.text-gradient` /
`.gradient-border` (likely `src/components/home/Hero.tsx`,
`src/components/ui/GlassCard.tsx`, `src/components/ui/Bits.tsx`)

**Do:**
1. Rewrite `.text-gradient` to a single-hue vertical fade
   (`#fff` → `rgb(255 255 255 / 0.72)`). Remove royal/electric stops.
2. Remove `.gradient-border`'s conic royal→abyss→electric and its 6s spin. Replace
   the hover affordance with `border-color: --hairline-strong` + `--e2`.
3. Retire `--angle` / `border-spin` / `@property` if no longer referenced.
4. Reduce `.cv-aurora` opacity so it reads as atmosphere, not colour: single gold
   tint at ≤5%.
5. Keep `.cv-grain` at current opacity; remove `.cv-spotlight` from any view where
   it overlaps the player.

**Unchanged:** DOM structure, class names on elements, hover/focus *behaviour*.
**Acceptance:** no purple-to-cyan gradient anywhere; no spinning border; the room
and landing still show ambient depth; reduced-motion still honoured.

---

### ☐ Task 3 — Text-tier migration *(fixes contrast + hierarchy together)*

**Files:** sweep `src/components/**`, `src/app/**`

**Do:** replace every `text-white/NN` with the semantic token per the §2.1
migration map. Where a value below 0.5 carries meaning, raise it to
`text-muted`. Only decorative glyphs may use `text-faint`.

**Unchanged:** element structure, copy, aria attributes.
**Acceptance:** zero occurrences of `text-white/20|25|30|35|40|45|55|60|65|70`
remain; every text node that conveys information measures ≥4.5:1 on `#090909`;
`scripts/a11y.test.mjs` still passes.

---

### ☐ Task 4 — Touch targets to 44px

**Files:** `src/components/ui/Button.tsx`, `src/components/layout/Header.tsx`,
`src/components/room/RoomExperience.tsx`, `src/components/room/SidePanels.tsx`

**Do:** apply the §3.2 pseudo-element hit-area expansion to every icon button
(14 in-room controls, 6 reaction buttons, header actions). Raise panel tabs and
the "Invite" control to a 44px hit area. **Do not change visual box sizes or
spacing** — expansion is via `::after` only.

**Unchanged:** layout, alignment, labels, handlers.
**Acceptance:** at 375×812 every interactive element reports ≥44×44 hit area; no
layout shift versus before; realtime E2E green.

---

### ☐ Task 5 — Button, input and panel primitives

**Files:** `src/components/ui/Button.tsx`, `Input.tsx`, `GlassCard.tsx`, `Modal.tsx`

**Do:** implement §3.1 / §3.3 variants and sizes using the new tokens. Collapse
`.glass-soft` and `.glass-lit` usage into `--surface-*` + `--hairline`; reserve
true backdrop-blur for `Modal` and the side panel only.

**Unchanged:** every component's prop signature and behaviour.
**Acceptance:** one primary button per view; inputs 44px; blur used in ≤2 places;
no prop changes; typecheck clean.

---

### ☐ Task 6 — Video area and room chrome

**Files:** `src/components/room/Player.tsx`, `src/components/room/RoomExperience.tsx`

**Do:** apply §3.5 — black player surface, `--r-md`, `--e2`, scrim-based controls
for the HTML5 path. Add a visually-hidden `h1` for the room. Verify lights-off
dims chrome only.

**Unchanged:** **the YouTube branch must not gain any overlay** (guardrail §5.1);
`PlayerHandle`, sync, and all playback logic untouched.
**Acceptance:** YouTube path renders the bare iframe exactly as before; HTML5
controls legible over bright frames; lights-off leaves the video at full
brightness; room exposes exactly one `h1`.

---

### ☐ Task 7 — Chat, empty, loading and error states

**Files:** `src/components/room/Chat.tsx`, `src/components/room/SidePanels.tsx`

**Do:** apply §3.4 bubble spec and the §3.7 unified state pattern.
**Unchanged:** the viewport-locked scroll architecture, attachment handling,
reaction picker behaviour, live-region roles.
**Acceptance:** message list remains the only desktop scroller; `role="status"`
error strip unchanged in behaviour; all three states share one layout.

---

### ☐ Task 8 — Spacing and radius normalisation *(lowest risk, do last)*

**Files:** `src/components/**`

**Do:** map `6→8`, `10→12`, `14→16`; remove the 44px radius outlier; apply the
§2.3 section rhythm.
**Acceptance:** no off-grid gap/padding except deliberate 2px optical nudges;
≤5 distinct radii; no horizontal overflow at 375px.

---

### Definition of done

- `npm run typecheck` clean · `npm test` green · `npm run release:gate` passes twice
- No diff in any `aria-label`, `role`, prop signature, handler or network call
- 375px: no horizontal scroll, all targets ≥44px
- Every informational text node ≥4.5:1
- One accent hue in the entire product; zero spinning/looping decoration
- Dev server restored on port 3000
