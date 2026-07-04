import { EditorView, basicSetup } from 'codemirror'
import { javascript, javascriptLanguage } from '@codemirror/lang-javascript'
import { oneDark } from '@codemirror/theme-one-dark'
import { keymap, hoverTooltip } from '@codemirror/view'
import { Prec } from '@codemirror/state'
import { vim } from '@replit/codemirror-vim'
import { buildTablePreview } from './preview.js'
import type { Table } from './dsl.js'

interface DocEntry {
  sig: string
  detail: string
  info: string
}

const DSL_BUILTIN_DOCS: Record<string, DocEntry> = {
  define:     { sig: 'define(name, fn)',             detail: 'register view',    info: 'Register a named view. fn receives (rand, table) and must return a Table. Views are cooked lazily; deps tracked via table().' },
  table:      { sig: 'table(name)',                  detail: 'resolve view',     info: 'Resolve a named view at top-level (no dependency tracking). Returns the cooked Table for that view.' },
  math:       { sig: 'math(index => value)',         detail: 'sample function',  info: 'Sample a numeric function of the row index. Chain .range(n) to emit n rows of { index, value }.' },
  rows:       { sig: 'rows([{...}, ...])',           detail: 'wrap array',       info: 'Wrap a literal array of plain objects into a Table.' },
  csv:        { sig: 'csv(string)',                  detail: 'parse CSV',        info: 'Parse a CSV string (header row + data rows) into a Table.' },
  json:       { sig: 'json(array | string)',         detail: 'parse JSON',       info: 'Wrap a JS array or parse a JSON string into a Table.' },
  grid:       { sig: 'grid(cols, rows)',             detail: 'XZ lattice',       info: 'Generate a cols×rows lattice of XZ positions as a Table (fields: col, row, x, z).' },
  physics:    { sig: 'physics(table)',               detail: 'physics scene',    info: 'Load a base scene table into the JoltPhysics engine. Chain .simulate() to run the simulation.' },
  field:      { sig: 'field(name)',                   detail: 'expr: read field',  info: 'A chainable expression reading row[name]. Chain .add/.sub/.mul/.div/.mod, .eq/.gt/…, .and/.or/.not, .cond(a,b). Use in filter(expr), map(template), emit(template), derive — these are diffable (no opaque closures).' },
  lit:        { sig: 'lit(value)',                   detail: 'expr: literal',     info: 'A constant expression. Usually you can pass a raw value directly to an Expr method.' },
  idx:        { sig: 'idx()',                         detail: 'expr: row index',   info: 'An expression yielding the row index (0-based).' },
  midi:       { sig: 'midi(note, channel?)',         detail: 'expr: live MIDI',   info: 'A live value from the streaming MIDI table — the most recent event for `note` (e.g. "c4", "c#4", or "cc1" for control change) at-or-before the playhead. Normalized 0–1 (note velocity / CC value). Chainable like any Expr: midi("c4").mul(2). Use in setField/map/derive; it resolves each frame, so notes you play while looping replay at the loop position they were heard. Optional 1-based `channel` filters to one channel.' },
  beats:      { sig: 'beats(count, { fit }?)',       detail: 'beat timeline',     info: 'A looping timeline `count` beats long at the tapped tempo (🥁 Tap under the scene). Use as the "timeline" view: define("timeline", () => beats(16)). { fit: seconds } stretches a scene across the beat window.' },
  tempo:      { sig: 'tempo(fallback?)',             detail: 'beat length (s)',   info: 'Seconds per beat derived from the tap-beat table (🥁 Tap), or `fallback` (default 0.5s = 120 BPM) until two taps are recorded.' },
  taps:       { sig: 'taps()',                       detail: 'tap-beat table',    info: 'The tap-beat table: one row per wall-time button press ({ beat, time }).' },
  linear:     { sig: 'linear',                       detail: 'easing curve',     info: 'Linear easing (t → t). Pass as the ease field of a color-pulse row.' },
  easeIn:     { sig: 'easeIn',                       detail: 'easing curve',     info: 'Quadratic ease-in (t → t²). Starts slow, ends fast.' },
  easeOut:    { sig: 'easeOut',                      detail: 'easing curve',     info: 'Quadratic ease-out (t → 1-(1-t)²). Starts fast, ends slow.' },
  easeInOut:  { sig: 'easeInOut',                    detail: 'easing curve',     info: 'Quadratic ease-in-out. Slow at both ends, fast in the middle.' },
}

const TABLE_METHOD_DOCS: Record<string, DocEntry> = {
  map:         { sig: '.map(row => row | template)',          detail: 'transform rows',   info: 'Transform every row. Pass a function, or a declarative template of Expr/literals (e.g. { y: field("v").mul(2) }) — the template form is diffable.' },
  filter:      { sig: '.filter(row => bool | Expr)',          detail: 'keep rows',        info: 'Keep rows where the predicate holds. Pass a function, or an Expr predicate (e.g. field("type").eq("collision")) — the Expr form is diffable.' },
  filterMap:   { sig: '.filterMap(row => row | null)',        detail: 'filter + map',     info: 'Map and filter in one pass — return a new row to keep it, null/undefined to drop it. (For a diffable form, use .filter(Expr).emit(template).)' },
  emit:        { sig: '.emit(template | [templates])',        detail: 'fan out rows',     info: 'Declarative flatMap: emit one or many rows per source row from Expr/literal templates. The diffable counterpart of filterMap; pair with .filter(Expr).' },
  concat:      { sig: '.concat(other)',                       detail: 'combine tables',   info: 'Append the rows of another Table (or array) to this one.' },
  slice:       { sig: '.slice(start, end?)',                  detail: 'subset rows',      info: 'Return a sub-range of rows, like Array.slice.' },
  fold:        { sig: '.fold(init, (acc, row) => acc)',       detail: 'reduce to value',  info: 'Reduce all rows to a single accumulated value, like Array.reduce.' },
  scan:        { sig: '.scan(init, (acc, row) => row)',       detail: 'running accumul.', info: 'Running accumulator — emit one output row per input row, carrying state forward.' },
  join:        { sig: '.join(other, on)',                     detail: 'key join',         info: 'Key-based join: merge rows where the `on` field (or key fn) matches. Like SQL LEFT JOIN.' },
  zip:         { sig: '.zip(other)',                          detail: 'positional join',  info: 'Merge rows positionally — row 0 with row 0, row 1 with row 1, etc.' },
  orderBy:     { sig: '.orderBy(field | fn, dir?)',           detail: 'sort rows',        info: 'Sort rows by a field name or comparator function. Optional dir: "asc" (default) or "desc".' },
  derive:      { sig: '.derive({ field: row => val })',       detail: 'add fields',       info: 'Add or overwrite fields on every row using derivation functions.' },
  assign:      { sig: '.assign({ field: value })',            detail: 'set fields',       info: 'Merge a fixed object of field values into every row.' },
  setField:    { sig: '.setField(name, value)',               detail: 'set one field',    info: 'Set one field on every row from an Expr or value. With a live source — .setField("amount", midi("c4")) — the field becomes a per-frame binding that follows the note as the loop replays; a constant Expr is baked in immediately.' },
  mapField:    { sig: '.mapField(field, val => val)',         detail: 'transform field',  info: 'Apply a function to one field of every row, replacing it in place.' },
  rescale:     { sig: '.rescale(field, [min, max]?)',         detail: 'normalize field',  info: 'Normalize a numeric field to [0, 1] (or a custom range) across all rows.' },
  lag:         { sig: '.lag(n)',                              detail: 'shift rows',       info: 'Shift rows forward by n positions, padding the start with null rows.' },
  groupBy:     { sig: '.groupBy(field | fn)',                 detail: 'group rows',       info: 'Group rows by a key field or function. Chain .agg() or .count() to aggregate.' },
  agg:         { sig: '.agg({ field: rows => val })',         detail: 'aggregate groups', info: 'Aggregate each group into one row. Called after .groupBy().' },
  count:       { sig: '.count()',                             detail: 'count groups',     info: 'Emit one row per group with a `count` field. Called after .groupBy().' },
  trigger:     { sig: '.trigger(pred, emit)',                 detail: 'event detection',  info: 'When pred(row) is true, call emit(row) and include returned rows in the output.' },
  triggerEach: { sig: '.triggerEach(pred, objs, make)',       detail: 'fan-out events',   info: 'Fan out: for each object in objs when pred fires, call make(row, obj) to emit rows.' },
  crossings:   { sig: '.crossings(field, level)',             detail: 'threshold events', info: 'Emit one row each time the named field crosses the given numeric level.' },
  range:       { sig: '.range(count)',                        detail: 'generate rows',    info: 'Emit count rows from a math() builder — each row has { index, value }.' },
  rasterize:   { sig: '.rasterize(maxFrame)',                 detail: 'bake frame cache', info: 'Bake sparse event rows (from simulate) into a dense per-frame world state Table indexed 0…maxFrame.' },
  simulate:    { sig: '.simulate({ steps, gravity, ... })',   detail: 'run physics',      info: 'Step the JoltPhysics world. Options: steps (frames), gravity, fps, sampleEvery, collisions.' },
  graph:       { sig: '.graph(...columns)',                   detail: 'draw graph',       info: 'Mark this Table to be drawn on the graph panel. Pass column name(s) to plot.' },
  save:        { sig: '.save(name)',                          detail: 'save as view',     info: 'Sugar for define(name, () => this) — register the current Table as a named view.' },
}

function makeInfoNode(sig: string, info: string): HTMLElement {
  const el = document.createElement('div')
  el.className = 'cm-completion-info'
  const sigEl = document.createElement('code')
  sigEl.textContent = sig
  const desc = document.createElement('p')
  desc.textContent = info
  el.appendChild(sigEl)
  el.appendChild(desc)
  return el
}

const DSL_BUILTINS = Object.keys(DSL_BUILTIN_DOCS)
const TABLE_METHODS = Object.keys(TABLE_METHOD_DOCS)

function viewAtPos(text: string, pos: number): string | null {
  const re = /\bdefine\(\s*"([^"]+)"/g
  let m: RegExpExecArray | null
  let name: string | null = null
  while ((m = re.exec(text))) {
    if (m.index <= pos) name = m[1]
    else break
  }
  return name
}

function dslCompletions(getViews?: () => Map<string, Table> | undefined) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (context: any) => {
    if (context.matchBefore(/\b(?:table|define)\(\s*"[^"]*/)) {
      const open = context.matchBefore(/"[^"]*/)
      const names = [...(getViews?.() ?? new Map()).keys()]
      if (!names.length) return null
      return {
        from: open ? open.from + 1 : context.pos,
        options: names.map((n: string) => ({ label: n, type: 'variable' })),
        validFor: /^[^"]*$/,
      }
    }
    const dot = context.matchBefore(/\.\w*/)
    if (dot) {
      return {
        from: dot.from + 1,
        options: TABLE_METHODS.map((label) => {
          const d = TABLE_METHOD_DOCS[label]
          return { label, type: 'method', detail: d.detail, info: () => makeInfoNode(d.sig, d.info) }
        }),
        validFor: /^\w*$/,
      }
    }
    const word = context.matchBefore(/\w+/)
    if (!word && !context.explicit) return null
    return {
      from: word ? word.from : context.pos,
      options: DSL_BUILTINS.map((label) => {
        const d = DSL_BUILTIN_DOCS[label]
        return { label, type: 'function', detail: d.detail, info: () => makeInfoNode(d.sig, d.info) }
      }),
      validFor: /^\w*$/,
    }
  }
}

export const defaultProgram = `// livecodata — define tables as views; the engine cooks them each run.
// Press "Run ▶" (or Cmd/Ctrl-Enter), then hit Play under the scene.
// Tips: Ctrl-Space completes views & Table verbs; hover a "view" name to preview
// its table; your caret selects that view's tab on the right.

// 1. The base scene: a static floor and three shapes to drop on it. Each create
//    row carries physics fields — motion, spawn position (px/py/pz) and rotation
//    (rx/ry/rz). The floor's physics half-extents (hx/hy/hz) are wider than the
//    drawn mesh, so things land instead of rolling off.
define("base", () =>
  rows([
    { id: "floor", type: "create", shape: "box", color: 0x222244,
      motion: "static", px: 0, py: -1.2, pz: 0, hx: 3, hy: 0.2, hz: 3 },
    { id: "ball",  type: "create", shape: "sphere",   color: 0x4a9eff,
      motion: "dynamic", px: -0.5, py: 3.0, pz: 0.0 },
    { id: "box1",  type: "create", shape: "box",      color: 0xff6b6b,
      motion: "dynamic", px: 0.4,  py: 4.5, pz: 0.2, rx: 0.4, ry: 0.3 },
    { id: "cyl",   type: "create", shape: "cylinder", color: 0x51cf66,
      motion: "dynamic", px: 0.0,  py: 6.0, pz: -0.3 },
  ])
)

// 2. Bake a JoltPhysics simulation in the background: step the world for 240
//    frames (~4 s at 60 fps). simulate() ADDS to the table — a per-frame "update"
//    row for each moving body (index in seconds; the cache interpolates between
//    them) plus a "collision" row whenever two bodies first touch.
//    The 3rd arg tags this view into the "events" group: the engine auto-builds
//    a view named "events" that concats every group member (index-sorted), so
//    the motion rows here and the effect rows in step 5 merge into one "events"
//    table — no manual .concat. "events" is the single sparse stream of
//    everything that happens: object motion *and* the post-processing chain.
define("sim", "events", (rand, table) =>
  physics(table("base")).simulate({ steps: 240, gravity: -9.81 })
)

// 3. The frame cache: bake the sparse "events" into dense per-frame world state
//    that playback indexes straight into. rasterize(seconds) sets the duration.
define("scene", (rand, table) => table("events").rasterize(4))

// 4. Collisions are just rows — pull them into their own view to inspect, and
//    graph the ball's height over time as it bounces and settles.
define("collisions", (rand, table) =>
  table("events").filter(r => r.type === "collision")
)

define("ball_height", (rand, table) =>
  table("events")
    .filter(r => r.id === "ball" && r.type === "update")
    .map(r => ({ index: r.index, height: r.py }))
    .graph("height")
)

// 5. Post-processing effects layer over the rendered scene as a chain of
//    Three.js passes. Each effect event has an event type (addEffect /
//    updateEffect / removeEffect), an id, an effect type ("bloom", "afterimage",
//    "dotscreen", "rgbshift", "film", "glitch", "halftone"), an optional input
//    (another effect's id, or omitted to read the base render output), params,
//    and an index (seconds). An updateEffect with a dur eases its params over
//    time, just like a color pulse. Here bloom feeds an afterimage trail, and
//    the bloom flashes on each real landing — data-driven from "sim"'s collision
//    rows (filter the sibling member, not "events", or we'd cycle), so the flash
//    fires exactly when a shape hits the floor, not at a guessed time. Like step
//    2 this view is tagged into the "events" group, so its rows merge into "events".
define("effects", "events", (rand, table) =>
  rows([
    { id: "bloom",  type: "addEffect", effect: "bloom", index: 0,
      params: { strength: 0.8, radius: 0.5, threshold: 0.6 } },
    { id: "trails", type: "addEffect", effect: "afterimage", input: "bloom",
      index: 0, params: { damp: 0.82 } },
  ]).concat(
    // Declarative, diffable form: filter(Expr) + emit(template). Values are Expr
    // nodes (field("index").add(0.05)) so the engine can hash this view and reuse
    // it — editing here never re-bakes the physics in "sim".
    table("sim")
      .filter(field("type").eq("collision").and(field("other").eq("floor")))
      .emit([
        { id: "bloom", type: "updateEffect", index: field("index"), dur: 0.05,
          params: { strength: 2.6 } },
        { id: "bloom", type: "updateEffect", index: field("index").add(0.05), dur: 0.5,
          ease: easeOut, params: { strength: 0.8 } },
      ])
  )
)

// 6. Beat-synced looping (optional). Tap the 🥁 Tap button under the scene a few
//    times to set the tempo, then measure the timeline in beats — its length
//    follows the tapped tempo. "Loop" (next to Play) is on by default. beats(16)
//    loops every 16 beats; { fit: 4 } stretches this 4-second sim across the window:
//
// define("timeline", () => beats(16, { fit: 4 }))

// 7. Live MIDI (optional). Connect a MIDI device and play while it loops: each
//    note is recorded against the loop position it was heard at (see the "midi"
//    table), and midi("c4") reads its live value back every time the loop returns
//    there. Bind it to any field with setField — here c4's velocity lifts a sphere
//    every time the loop passes the moment you played it:
//
 define("scene", () =>
   rows([{ id: "s", type: "create", index: 0, shape: "sphere", color: 0x4a9eff,
           px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 }])
     .setField("py", midi("cc49").mul(3))
     .rasterize(4))
`

function dslHover(getViews?: () => Map<string, Table> | undefined, getPlayIndex?: () => number) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return hoverTooltip((view: any, pos: number) => {
    const line = view.state.doc.lineAt(pos) as { text: string; from: number }
    const re = /"([^"]+)"/g
    let m: RegExpExecArray | null
    while ((m = re.exec(line.text))) {
      const start = line.from + m.index
      const end = start + m[0].length
      if (pos < start || pos > end) continue
      const table = (getViews?.() ?? new Map()).get(m[1])
      if (!table) return null
      return {
        pos: start, end, above: true,
        create: () => ({ dom: buildTablePreview(table, { playIndex: getPlayIndex?.() }) }),
      }
    }
    return null
  })
}

export interface EditorOptions {
  onRun?: (code: string, opts: { setError: (msg: string | null) => void }) => void
  getViews?: () => Map<string, Table>
  onCaretView?: (name: string) => void
  getPlayIndex?: () => number
}

export interface EditorAPI {
  run(): void
  getCode(): string
  setCode(code: string): void
  setError(msg: string | null): void
}

export function initEditor(parent: HTMLElement, { onRun, getViews, onCaretView, getPlayIndex }: EditorOptions = {}): EditorAPI {
  parent.innerHTML = ''

  const header = document.createElement('div')
  header.className = 'editor-header'

  const titleEl = document.createElement('span')
  titleEl.className = 'editor-title'
  titleEl.textContent = 'DSL'
  header.appendChild(titleEl)

  const runBtn = document.createElement('button')
  runBtn.className = 'run-btn'
  runBtn.textContent = 'Run ▶'
  header.appendChild(runBtn)

  parent.appendChild(header)

  const host = document.createElement('div')
  host.className = 'editor-host'
  parent.appendChild(host)

  const errEl = document.createElement('div')
  errEl.className = 'editor-error'
  errEl.style.display = 'none'
  parent.appendChild(errEl)

  function setError(msg: string | null): void {
    if (msg) {
      errEl.textContent = msg
      errEl.style.display = 'block'
    } else {
      errEl.textContent = ''
      errEl.style.display = 'none'
    }
  }

  function run(): void {
    onRun?.(view.state.doc.toString(), { setError })
  }

  let lastCaretView: string | null = null

  const view = new EditorView({
    doc: defaultProgram,
    extensions: [
      vim(),
      basicSetup,
      javascript(),
      javascriptLanguage.data.of({ autocomplete: dslCompletions(getViews) }),
      EditorView.updateListener.of((u) => {
        if (!onCaretView || !(u.selectionSet || u.docChanged)) return
        const name = viewAtPos(u.state.doc.toString(), u.state.selection.main.head)
        if (name && name !== lastCaretView) {
          lastCaretView = name
          onCaretView(name)
        }
      }),
      dslHover(getViews, getPlayIndex),
      oneDark,
      Prec.highest(keymap.of([
        { key: 'Mod-Enter', run: () => { run(); return true } },
      ])),
      EditorView.theme({
        '&': { height: '100%' },
        '.cm-scroller': { overflow: 'auto' },
      }),
    ],
    parent: host,
  })

  runBtn.onclick = run

  function setCode(code: string): void {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: code } })
  }

  return { run, getCode: () => view.state.doc.toString(), setCode, setError }
}
