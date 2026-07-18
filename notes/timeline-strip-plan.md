# Timeline strip: interactive beat-grid table editing

Replace the transport's plain range slider with a **timeline strip** — a
beat-grid visual that still scrubs, but also renders the rows of the
currently open editable table as draggable handles, so `beat`/`end` edits
happen directly on the timeline instead of by typing numbers into cells.

## Where things stand today

- The scrub UI is `<input type="range" id="scrub-bar">` in
  `src/ui/playback-controls.tsx` — a filled gradient, no beat grid, no
  content markers.
- The timeline is an editable table named `timeline`
  (`schemas.timeline` in `src/dsl.ts`: `beat, end, event, from, to,
  outFrom, outTo, rate, loop, disabled`). `src/timeline.ts` compiles its
  rows into `TimelineSegment[]` (playback→source linear pieces) and
  `placeBeat()` already inverts the map.
- Every other beat table (`three`, `hydra`, `post`, user tables) keys rows
  by a 1-indexed `beat` column, optionally with `dur`.
- Edits append events to `EditableTableStore` (`setCell`/`setRow`) and are
  **pending until Run/Apply** — only `evaluate()` re-cooks and calls
  `playback.load()`. The Run button lights via `hasPendingEdits()`.
- The open table is `tablePanel.current()`; `editableData()` in
  `ui/table-panel.tsx` distinguishes genuinely editable tables from cooked
  views and log tables. Row identity is the storage index (stable under
  the `displayOrder` beat-sort), which is exactly what `set-cell`/`set-row`
  events key on — so handles keyed by storage index survive re-sorting
  mid-drag.

## Design

One new component pair, following the repo's model/view split:

- **`src/timeline-strip.ts`** — the pure model. No DOM. Everything unit-
  testable:
  - `StripGeometry`: px↔beat mapping for a strip of width `w` over
    `0..maxBeats` playback beats (beat b at x = `((b - 1) / maxBeats) * w`
    for 1-indexed positions; the playhead `pos` is 0-based elapsed beats).
  - `gridLines(maxBeats, w)`: minor tick per beat, major every 4, labels at
    a density that never collides (drop labels below ~24px spacing).
  - `handlesFor(name, rows, columns, timeline)` → `Handle[]`: derive one
    descriptor per visible row that has a numeric `beat`:
    - `timeline` table: a **span** handle `beat..end` on the playback axis
      (identity — timeline rows already live in playback coordinates), with
      `loop` picking a lane (pass) when a multi-pass timeline exists.
    - any other table: a **point** handle (or span when `dur` is numeric)
      at the row's *source* beat, mapped onto the playback axis through
      `placeBeat(segments, beat)` — one ghost per placement, the first
      placement primary. With no active timeline this degenerates to
      identity, the common case.
    - rows with `disabled: true` render dimmed but stay draggable.
  - `hitTest(handles, x, y)`: which handle/edge is under the pointer —
    edges (`start`/`end`) win over body within a few px, body over
    background; background means scrub.
  - `snap(beat, opts)`: quarter-beat snap by default, integer beats with
    Shift, free with Alt.
  - `dragUpdate(handle, mode, dBeats)` → `{ row, values }`: the single
    `setRow` payload for a drag — `mode: 'move'` shifts `beat` (+`end`
    together for spans, so duration is preserved), `'start'`/`'end'` move
    one edge with a minimum span. For non-timeline tables under an active
    timeline, the drop position maps back through
    `timeline.sourceBeatAt()` so the row's stored source beat matches
    where the handle visually landed.

- **`src/ui/timeline-strip.tsx`** — the humble Solid view. Replaces
  `#scrub-bar` inside `PlaybackControls`. A sized `<div>` with an absolute-
  positioned layer stack (DOM, not canvas — handles are few and CSS
  handles hover/focus states for free):
  1. beat grid (ticks + labels),
  2. timeline coverage shading (from `timelineSegments` of the *store's*
     current timeline rows: covered spans tinted per event kind, gaps =
     unmapped/identity),
  3. handles layer for the open table,
  4. playhead line + elapsed tint (replacing the gradient fill).

  Pointer handling: `setPointerCapture`; background drag calls
  `engine.scrub()` / `engine.endScrub()` exactly as the range input does
  today; handle drags preview locally (a signal overrides that handle's
  position) and commit **one `store.setRow` on pointerup** — one history
  event per gesture, no event-log spam mid-drag, matching "the edit is the
  event".

### Wiring

`PlaybackControls` gains props it doesn't have today. Rather than fatten
it, `app.tsx` mounts `<TimelineStrip>` next to it inside
`#playback-controls`, passing:

- `vs` + `engine` from the `PlaybackController` (playhead, `maxBeats`,
  scrub),
- `store`, `current: tablePanel.current`, and the panel's `tick`
  equivalent — simplest is for the strip to own a local `tick` bumped via
  `store.onChange` (like the panel does), so it re-reads the fold after
  every local or merged edit,
- a `onSelectRow(row)` callback that focuses the corresponding row/cell in
  the table panel (new small `TablePanelController` method wrapping
  `setFocusedCell` + scroll-into-view), so clicking a handle lands you on
  the row; conversely the panel's `focusedCell` highlights the matching
  handle.

The strip reads **store rows** (pending state, live), while segment
shading of *playback* and `maxBeats` come from the **applied** cook — this
is the same live/applied split the grid already has. Handles whose store
position differs from the applied cook render in a "pending" style
(dashed outline), and Apply remains the existing Ctrl-Enter / Run button
flow. No auto-apply in v1.

### Coordinate rules (the part worth getting right)

- Positions are 1-indexed beats; the axis is `0..maxBeats` elapsed beats,
  so beat b sits at elapsed `b - 1`. All conversions live in the model,
  next to tests.
- `timeline` rows: playback axis, identity. A `loop` column offsets onto
  pass lanes: when `loops > 1`, the strip grows one lane per pass (thin
  horizontal bands), each spanning the same `0..span` axis — matching how
  `compile()` extends the playback axis by `beat + L * span`.
- Content tables: stored beats are source beats. Rendering maps source →
  playback via `placeBeat`; dragging maps playback → source via
  `sourceBeatAt` at the drop point. A source beat played several times
  (loop event) shows every placement; dragging any ghost edits the one
  underlying row.
- Beats past `maxBeats` (later passes of content, no timeline): wrap to
  `((beat - 1) % loopBeats)` with a small "pass n" badge rather than
  rendering off-strip.

## Implementation phases

Each phase lands independently green; PR per phase or one PR with this
order of commits.

1. **Strip model + tests** — `src/timeline-strip.ts`,
   `test/timeline-strip.test.ts`. Geometry, grid, `handlesFor`, `hitTest`,
   `snap`, `dragUpdate`, timeline round-trip mapping. Pin behavioral
   contracts only (a drag payload, a placement through a loop event, snap
   boundaries), not pixel layouts.
2. **Strip view, scrub parity** — `src/ui/timeline-strip.tsx` + CSS;
   remove `#scrub-bar`. Beat grid, playhead, elapsed tint, background
   scrub with global pointerup, mobile touch tolerances (larger hit
   areas ≤ 767px). Timeline coverage shading.
3. **Read-only handles + selection sync** — handles for
   `tablePanel.current()` with hover tooltips (row summary), click →
   focus row in panel, panel focus → highlighted handle. Presence-colored
   outline when a peer's `lastEdit` touches the row (reuse
   `lastEditors`).
4. **Dragging** — pointer capture, local preview, snap modifiers, single
   `setRow` commit on release, edge drags for spans, Escape cancels.
   Pending-style handles; Run/Apply flow untouched.
5. **Timeline-aware placement + pass lanes** — `placeBeat` ghosts for
   content tables under an active timeline, inverse-map on drop,
   multi-pass lanes for the `timeline` table's `loop` column.
6. **Polish (optional, judge by feel)** — double-click empty strip adds a
   row at that beat (`addRow` + `setRow`), arrow-key nudge on a selected
   handle (±snap step), `dur` edge-drag for content spans.

Verify each UI phase in the real app via the `verify` skill (drag a
timeline row, Apply, confirm playback follows; drag while a peer window
watches for sync).

## Risks / decisions taken

- **Event-log volume**: commit once per gesture, not per pointermove.
  Peers see the handle jump on release; live mid-drag mirroring would need
  presence-channel preview and is out of scope.
- **DOM vs canvas**: tables are small (tens of rows); DOM handles win on
  a11y/hover/focus. The grid + shading underlay can become one canvas
  later if profiling ever cares.
- **Which tables get handles**: any editable, non-log table with a numeric
  `beat` column — not just `timeline`. Cooked read-only views get grid +
  playhead but no handles (nothing to write to).
- **Replay/scrubbed sessions**: while `setReplayView` is active the store
  is read-only-ish (edits fork); handles stay visible but the first drag
  forks exactly like a grid edit — no special casing needed.
