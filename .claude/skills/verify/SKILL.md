---
name: verify
description: Build, launch, and drive livecodata in a real browser to verify changes end-to-end.
---

# Verifying livecodata

## Build & launch

- `npm run build` → static app in `public/`.
- `npm run serve` (PORT env, default 8787) → serves `public/` **and** the
  multiplayer WebSocket room endpoint at `/ws`. One process is enough for
  solo and multiplayer verification.
- `npm run watch` → esbuild dev server (no `/ws`; pass `?server=ws://host:8787/ws`
  to point the page at a separately-run `npm run serve`).

## Driving the app (Playwright + preinstalled Chromium)

- `npm i playwright-core` in a scratch dir; launch with
  `executablePath: '/opt/pw-browsers/chromium'`, `args: ['--no-sandbox']`.
- The editor is CodeMirror **in vim mode**: click `.cm-content`, `Escape`,
  then vim keys (`ggO` + type + `Escape`), then click `.run-btn` (or
  Ctrl-Enter) to run.
- Useful selectors: `.run-btn`, `.multiplayer-chip` (room status/peers),
  `.table-tab` / `.table-tab-add` (table panel tabs, "+ table"),
  `.session-range` (session scrubber), `.session-select` (past sessions),
  `#tap-beat-btn` / `#tap-clear-btn` / `#tap-bpm` (tap-beat controls).

## Multiplayer flows worth driving

- Two isolated contexts at `/?room=<name>`: chip goes green `⇄ <room> · 2`.
- Run code in A → B's editor updates; `+ table` in B → tab appears in A.
- Tap-beat is synced the same way: tap in A (select the "taps" tab) → rows
  appear live in B without B ever tapping; clear in either clears both.
- Late joiner receives full history on join (code + tables + taps).
- Kill the server: chip degrades to `⇄ <room> …`, edits keep working
  locally; restart the server (rooms are memory-only) and both clients
  rejoin, re-upload logs, and converge — offline edits reach peers.

## Gotchas

- `/favicon.ico` 404s in the page console — pre-existing, benign.
- Each page load is a distinct replica (`src` id is per-load, not persisted).
- Playwright's `.click()` waits for actionability and can take 500ms-2s+ on
  this WebGL/physics-heavy page — enough to blow past the tap-beat's 2000ms
  reset-gap and make taps look like they're not accumulating. Use
  `page.evaluate(() => el.click())` (a plain JS dispatch, no actionability
  wait) when timing between taps matters.
