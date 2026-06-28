import { EditorView, basicSetup } from 'codemirror'
import { javascript, javascriptLanguage } from '@codemirror/lang-javascript'
import { oneDark } from '@codemirror/theme-one-dark'
import { keymap, hoverTooltip } from '@codemirror/view'
import { Prec } from '@codemirror/state'
import { vim } from '@replit/codemirror-vim'
import { buildTablePreview } from './preview.js'
import { isExprDot } from './completion.js'
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

// Methods offered after a dot on an Expr (field("x").add(1).gt(2)…). Every Expr
// method returns an Expr, so a chain rooted at field()/lit()/idx() stays Expr.
const EXPR_METHOD_DOCS: Record<string, DocEntry> = {
  add:  { sig: '.add(x)',           detail: 'expr  +',   info: 'Add. x is another Expr or a number.' },
  sub:  { sig: '.sub(x)',           detail: 'expr  −',   info: 'Subtract x (Expr or number).' },
  mul:  { sig: '.mul(x)',           detail: 'expr  ×',   info: 'Multiply by x (Expr or number).' },
  div:  { sig: '.div(x)',           detail: 'expr  ÷',   info: 'Divide by x (Expr or number).' },
  mod:  { sig: '.mod(x)',           detail: 'expr  %',   info: 'Modulo (remainder) by x.' },
  eq:   { sig: '.eq(x)',            detail: 'expr  ===', info: 'Strict-equal test. Returns a boolean Expr (use in filter / cond).' },
  ne:   { sig: '.ne(x)',            detail: 'expr  !==', info: 'Not-equal test. Returns a boolean Expr.' },
  gt:   { sig: '.gt(x)',            detail: 'expr  >',   info: 'Greater-than test. Returns a boolean Expr.' },
  gte:  { sig: '.gte(x)',           detail: 'expr  >=',  info: 'Greater-than-or-equal test. Returns a boolean Expr.' },
  lt:   { sig: '.lt(x)',            detail: 'expr  <',   info: 'Less-than test. Returns a boolean Expr.' },
  lte:  { sig: '.lte(x)',           detail: 'expr  <=',  info: 'Less-than-or-equal test. Returns a boolean Expr.' },
  and:  { sig: '.and(expr)',        detail: 'expr  &&',  info: 'Logical AND of two boolean Exprs.' },
  or:   { sig: '.or(expr)',         detail: 'expr  ||',  info: 'Logical OR of two boolean Exprs.' },
  not:  { sig: '.not()',            detail: 'expr  !',   info: 'Logical negation of a boolean Expr.' },
  cond: { sig: '.cond(then, else)', detail: 'ternary',   info: 'If this Expr is truthy yield `then`, else `else` (each an Expr or literal).' },
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
      // Pick the method set by the chain's root: Expr methods after field()/lit()/
      // idx() (and their chains), Table methods otherwise.
      const docs = isExprDot(context.state.doc.toString() as string, dot.from as number)
        ? EXPR_METHOD_DOCS : TABLE_METHOD_DOCS
      return {
        from: dot.from + 1,
        options: Object.keys(docs).map((label) => {
          const d = docs[label]
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

export const defaultProgram = `// livecodata — House of Cards
// A 2-story house of playing cards collapses when a ball drops on it.
// Press "Run ▶" (or Cmd/Ctrl-Enter), then hit Play under the scene.
// Tips: Ctrl-Space completes views, Table verbs, and Expr methods (the methods
// after field()/lit()/idx() — e.g. field("v").add(1).gt(2)); hover a "view" name
// to preview its table; your caret selects that view's tab on the right.

// 1. The base scene. Cards are thin boxes: each leaning pair forms a "tent"
//    with tops meeting at a shared apex. Positions are derived from lean angle
//    and half-extents so the lowest corner of every card rests exactly on its
//    support surface — no initial interpenetration.
//    Note: hz ≥ 0.05 is required because the Jolt BoxShape always applies a
//    0.05 convex (corner-rounding) radius, which must not exceed any half-extent.
define("base", () => {
  const lean = 0.25              // radians from vertical (≈ 14°)
  const H    = 0.35              // card half-height
  const W    = 0.22              // card half-width
  const T    = 0.06              // card half-thickness (≥ 0.05 for Jolt)
  const sl = Math.sin(lean), cl = Math.cos(lean)
  const dx = H * sl              // card-center x offset from tent apex
  // Vertical distance from support surface to card center so the lowest
  // rotated corner rests exactly on the surface (accounts for tilt):
  const cy = W * sl + H * cl

  // Story 1 — two tents (left apex x = −0.60, right apex x = +0.60)
  const cy1   = -1.0 + cy         // card center y, story 1
  const topY1 = cy1 + H * cl      // tent apex y, story 1

  // Bridge card — flat card spanning both story-1 tent apices
  const bridgeCY  = topY1 + T     // bridge center y (rests on tent tops)
  const bridgeTop = bridgeCY + T  // bridge top surface y

  // Story 2 — one tent centered on the bridge
  const cy2   = bridgeTop + cy
  const topY2 = cy2 + H * cl

  return rows([
    { id: "floor", type: "create", shape: "box", color: 0x1a2e1a,
      motion: "static", px: 0, py: -1.2, pz: 0, hx: 4, hy: 0.2, hz: 4 },

    // Tent A — left pair
    { id: "a1", type: "create", shape: "box", color: 0xfdf6e3,
      motion: "dynamic", friction: 0.8, restitution: 0,
      px: -0.60 - dx, py: cy1, pz: 0, hx: W, hy: H, hz: T, rz: -lean },
    { id: "a2", type: "create", shape: "box", color: 0xfdf6e3,
      motion: "dynamic", friction: 0.8, restitution: 0,
      px: -0.60 + dx, py: cy1, pz: 0, hx: W, hy: H, hz: T, rz:  lean },

    // Tent B — right pair
    { id: "b1", type: "create", shape: "box", color: 0xfdf6e3,
      motion: "dynamic", friction: 0.8, restitution: 0,
      px:  0.60 - dx, py: cy1, pz: 0, hx: W, hy: H, hz: T, rz: -lean },
    { id: "b2", type: "create", shape: "box", color: 0xfdf6e3,
      motion: "dynamic", friction: 0.8, restitution: 0,
      px:  0.60 + dx, py: cy1, pz: 0, hx: W, hy: H, hz: T, rz:  lean },

    // Bridge — horizontal card connecting the two story-1 apices
    { id: "bridge", type: "create", shape: "box", color: 0xe74c3c,
      motion: "dynamic", friction: 0.8, restitution: 0,
      px: 0, py: bridgeCY, pz: 0, hx: 0.65, hy: T, hz: W },

    // Tent C — story 2, sitting on the bridge
    { id: "c1", type: "create", shape: "box", color: 0xfdf6e3,
      motion: "dynamic", friction: 0.8, restitution: 0,
      px: -dx, py: cy2, pz: 0, hx: W, hy: H, hz: T, rz: -lean },
    { id: "c2", type: "create", shape: "box", color: 0xfdf6e3,
      motion: "dynamic", friction: 0.8, restitution: 0,
      px:  dx, py: cy2, pz: 0, hx: W, hy: H, hz: T, rz:  lean },

    // Crown — flat card on top of tent C
    { id: "crown", type: "create", shape: "box", color: 0xe74c3c,
      motion: "dynamic", friction: 0.8, restitution: 0,
      px: 0, py: topY2 + T, pz: 0, hx: 0.28, hy: T, hz: W },

    // Ball — falls onto the crown and topples the structure (hits ≈ 0.5 s in)
    { id: "ball", type: "create", shape: "sphere", color: 0xf39c12,
      motion: "dynamic", restitution: 0.2, r: 0.12,
      px: 0.05, py: 1.8, pz: 0 },
  ])
})

// 2. Bake a JoltPhysics simulation: 360 frames = 6 s at 60 fps. simulate()
//    ADDS to the table — a per-frame "update" row for each moving body and a
//    "collision" row whenever two bodies first touch. The ball hits the crown
//    at ≈ frame 27 (0.45 s); the full cascade takes another 2–3 s to settle.
//    Tagged "events": the engine auto-builds an "events" view that concats all
//    group members (index-sorted), so sim rows and effects rows merge without
//    a manual .concat.
define("sim", "events", (rand, table) =>
  physics(table("base")).simulate({ steps: 360, gravity: -9.81 })
)

// 3. Bake the sparse "events" stream into a dense per-frame cache for playback.
define("scene", (rand, table) => table("events").rasterize(6))

// 4. Graph the crown card's height over time — starts high, plummets on impact.
define("crown_height", (rand, table) =>
  table("events")
    .filter(r => r.id === "crown" && r.type === "update")
    .map(r => ({ index: r.index, height: r.py }))
    .graph("height")
)

// 5. Post-processing: bloom flares on each floor collision and an afterimage
//    trail so tumbling cards leave light streaks in the frame buffer.
//    Reads "sim" directly (not "events") to avoid a dependency cycle — sim is
//    a sibling group member, not the already-merged events table.
define("effects", "events", (rand, table) =>
  rows([
    { id: "bloom",  type: "addEffect", effect: "bloom", index: 0,
      params: { strength: 0.7, radius: 0.4, threshold: 0.5 } },
    { id: "trails", type: "addEffect", effect: "afterimage", input: "bloom",
      index: 0, params: { damp: 0.88 } },
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
