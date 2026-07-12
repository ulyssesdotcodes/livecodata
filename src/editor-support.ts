// Editor support — the non-view half of the code editor: DSL documentation
// tables, completion sources, and the hover-preview tooltip logic. Anything
// that builds actual DOM (completion info cards, the preview card) is
// injected by the view (ui/editor.tsx) as a factory, keeping this module
// free of rendering concerns.

import { EditorView, hoverTooltip, Decoration, WidgetType, type DecorationSet } from '@codemirror/view'
import { StateField, StateEffect } from '@codemirror/state'
import { isExprDot } from './completion.js'
import { SAMPLES } from './samples.js'
import type { Table } from './dsl.js'

export interface DocEntry {
  sig: string
  detail: string
  info: string
}

export const DSL_BUILTIN_DOCS: Record<string, DocEntry> = {
  define:     { sig: 'define(name, fn)',             detail: 'register view',    info: 'Register a named view. fn receives (rand, table) and must return a Table. Views are cooked lazily; deps tracked via table().' },
  table:      { sig: 'table(name)',                  detail: 'resolve view',     info: 'Resolve a named view at top-level (no dependency tracking). Returns the cooked Table for that view.' },
  math:       { sig: 'math(beat => value)',          detail: 'sample function',  info: 'Sample a numeric function of elapsed beats. Chain .range(beats) to emit rows of { beat, value }.' },
  rows:       { sig: 'rows([{...}, ...])',           detail: 'wrap array',       info: 'Wrap a literal array of plain objects into a Table.' },
  data:       { sig: 'data(url)',                     detail: 'fetch dataset',    info: 'Load a pre-fetched CSV file by URL into a Table. Files in /data/ are served statically; the runtime fetches them before cooking.' },
  csv:        { sig: 'csv(string)',                  detail: 'parse CSV',        info: 'Parse a CSV string (header row + data rows) into a Table.' },
  json:       { sig: 'json(array | string)',         detail: 'parse JSON',       info: 'Wrap a JS array or parse a JSON string into a Table.' },
  grid:       { sig: 'grid(cols, rows)',             detail: 'XZ lattice',       info: 'Generate a cols×rows lattice of XZ positions as a Table (fields: col, row, x, z).' },
  physics:    { sig: 'physics(table)',               detail: 'physics scene',    info: 'Load a base scene table into the JoltPhysics engine. Chain .simulate() to run the simulation.' },
  editable:   { sig: 'editable(name, schema, seedRows?)', detail: 'user table', info: 'A user-editable table: rows are edited in the table panel, not computed — every edit is an appended event and the visible table is the fold (see the name·events tab). schema maps column name to "number" | "string" | "boolean" | "code"; code cells open in this editor. seedRows fill the table when first created.' },
  origami:    { sig: 'origami()', detail: 'folding paper', info: 'A sheet of paper folded by a static table of creases. Chain .steps(table) — each row is one crease through two points, each "edge@t" (a fraction along bottom/top/left/right of the ORIGINAL square), "name@t" (a fraction along an earlier row\'s crease), or raw "x,y"; move names the pieces it rotates, and a row with a line but no move is a construction line, referenceable but never folded — then .spawn({ id, color, … }) for the scene create row and .sequence() for the beat-timed keyframes. Folding is exact kinematics: each step rigidly rotates the faces it moves about its crease, so scrubbing shows the exact fold state at any beat.' },
  field:      { sig: 'field(name)',                   detail: 'expr: read field',  info: 'A chainable expression reading row[name]. Chain .add/.sub/.mul/.div/.mod, .eq/.gt/…, .and/.or/.not, .cond(a,b). Use in filter(expr), map(template), emit(template), derive — these are diffable (no opaque closures).' },
  lit:        { sig: 'lit(value)',                   detail: 'expr: literal',     info: 'A constant expression. Usually you can pass a raw value directly to an Expr method.' },
  idx:        { sig: 'idx()',                         detail: 'expr: row index',   info: 'An expression yielding the row index (0-based).' },
  midi:       { sig: 'midi(note, channel?)',         detail: 'expr: live MIDI',   info: 'A live value from the streaming MIDI table — the most recent event for `note` (e.g. "c4", "c#4", or "cc1" for control change) at-or-before the playhead. Normalized 0–1 (note velocity / CC value). Chainable like any Expr: midi("c4").mul(2). Use in setField/map/derive; it resolves each frame, so notes you play while looping replay at the loop position they were heard. Optional 1-based `channel` filters to one channel.' },
  beats:      { sig: 'beats(count, { fit }?)',       detail: 'beat timeline',     info: 'A timeline that loops every `count` beats. Tempo is automatic — the playhead always runs at the tapped tempo (Tap) — so this is a RETIME: define("timeline", () => beats(16)) just loops every 16 beats; { fit: beats } stretches a span of source beats across the window (e.g. beats(16, { fit: 8 }) plays 8 beats of content at half speed).' },
  tempo:      { sig: 'tempo(fallback?)',             detail: 'beat length (s)',   info: 'Seconds per beat derived from the tap-beat table (Tap), or `fallback` (default 0.5s = 120 BPM) until two taps are recorded.' },
  taps:       { sig: 'taps()',                       detail: 'tap-beat table',    info: 'The tap-beat table: one row per wall-time button press ({ beat, time }, time as an absolute UTC epoch ms).' },
  linear:     { sig: 'linear',                       detail: 'easing curve',     info: 'Linear easing (t → t). Pass as the ease field of a color-pulse row.' },
  easeIn:     { sig: 'easeIn',                       detail: 'easing curve',     info: 'Quadratic ease-in (t → t²). Starts slow, ends fast.' },
  easeOut:    { sig: 'easeOut',                      detail: 'easing curve',     info: 'Quadratic ease-out (t → 1-(1-t)²). Starts fast, ends slow.' },
  easeInOut:  { sig: 'easeInOut',                    detail: 'easing curve',     info: 'Quadratic ease-in-out. Slow at both ends, fast in the middle.' },
}

export const TABLE_METHOD_DOCS: Record<string, DocEntry> = {
  map:         { sig: '.map(row => row | template)',          detail: 'transform rows',   info: 'Transform every row. Pass a function, or a declarative template of Expr/literals (e.g. { y: field("v").mul(2) }) — the template form is diffable.' },
  filter:      { sig: '.filter(row => bool | Expr)',          detail: 'keep rows',        info: 'Keep rows where the predicate holds. Pass a function, or an Expr predicate (e.g. field("type").eq("collision")) — the Expr form is diffable.' },
  filterMap:   { sig: '.filterMap(row => row | null)',        detail: 'filter + map',     info: 'Map and filter in one pass — return a new row to keep it, null/undefined to drop it. (For a diffable form, use .filter(Expr).emit(template).)' },
  emit:        { sig: '.emit(template | [templates])',        detail: 'fan out rows',     info: 'Declarative flatMap: emit one or many rows per source row from Expr/literal templates. The diffable counterpart of filterMap; pair with .filter(Expr).' },
  concat:      { sig: '.concat(other)',                       detail: 'combine tables',   info: 'Append the rows of another Table (or array) to this one.' },
  slice:       { sig: '.slice(start, end?)',                  detail: 'subset rows',      info: 'Return a sub-range of rows, like Array.slice.' },
  fold:        { sig: '.fold(init, (acc, row) => acc)',       detail: 'reduce to value',  info: 'Reduce all rows to a single accumulated value, like Array.reduce.' },
  scan:        { sig: '.scan(init, (acc, row) => row)',       detail: 'running accumul.', info: 'Running accumulator — emit one output row per input row, carrying state forward.' },
  mapAccum:    { sig: '.mapAccum((state, row) => [row, state], init)', detail: 'map + hidden state', info: 'Like .map(), but threads extra state between rows; the final state is discarded and only the emitted rows are kept. Return [row(s), nextState] each step.' },
  join:        { sig: '.join(other, on)',                     detail: 'key join',         info: 'Key-based join: merge rows where the `on` field (or key fn) matches. Like SQL LEFT JOIN.' },
  zip:         { sig: '.zip(other)',                          detail: 'positional join',  info: 'Merge rows positionally — row 0 with row 0, row 1 with row 1, etc.' },
  orderBy:     { sig: '.orderBy(field | fn, dir?)',           detail: 'sort rows',        info: 'Sort rows by a field name or comparator function. Optional dir: "asc" (default) or "desc".' },
  derive:      { sig: '.derive({ field: row => val })',       detail: 'add fields',       info: 'Add or overwrite fields on every row using derivation functions.' },
  assign:      { sig: '.assign({ field: value })',            detail: 'set fields',       info: 'Merge a fixed object of field values into every row.' },
  setField:    { sig: '.setField(name, value)',               detail: 'set one field',    info: 'Set one field on every row from an Expr or value. With a live source — .setField("amount", midi("c4")) — the field becomes a per-frame binding that follows the note as the loop replays; a constant Expr is baked in immediately.' },
  mapField:    { sig: '.mapField(field, val => val)',         detail: 'transform field',  info: 'Apply a function to one field of every row, replacing it in place.' },
  rescale:     { sig: '.rescale(field, [min, max]?)',         detail: 'normalize field',  info: 'Normalize a numeric field to [0, 1] (or a custom range) across all rows.' },
  lag:         { sig: '.lag(n)',                              detail: 'shift rows',       info: 'Shift rows forward by n positions, padding the start with null rows.' },
  retime:      { sig: '.retime({ offset, scale } | beat => beat)', detail: 'move on beat axis', info: 'Shift a table along the beat axis. Declarative retime({ offset, scale }) moves every row by `offset` beats and stretches spacing about beat 1 by `scale` (durations too) — diffable. Or pass a function beat => newBeat to remap arbitrarily.' },
  shift:       { sig: '.shift(beats)',                        detail: 'delay by beats',   info: 'Shift every row later by `beats` (negative = earlier). Sugar for .retime({ offset: beats }).' },
  groupBy:     { sig: '.groupBy(field | fn)',                 detail: 'group rows',       info: 'Group rows by a key field or function. Chain .agg() or .count() to aggregate.' },
  agg:         { sig: '.agg({ field: rows => val })',         detail: 'aggregate groups', info: 'Aggregate each group into one row. Called after .groupBy().' },
  count:       { sig: '.count()',                             detail: 'count groups',     info: 'Emit one row per group with a `count` field. Called after .groupBy().' },
  trigger:     { sig: '.trigger(pred, emit)',                 detail: 'event detection',  info: 'When pred(row) is true, call emit(row) and include returned rows in the output.' },
  triggerEach: { sig: '.triggerEach(pred, objs, make)',       detail: 'fan-out events',   info: 'Fan out: for each object in objs when pred fires, call make(row, obj) to emit rows.' },
  crossings:   { sig: '.crossings(field, level)',             detail: 'threshold events', info: 'Emit one row each time the named field crosses the given numeric level.' },
  range:       { sig: '.range(beats)',                        detail: 'generate rows',    info: 'Emit rows over `beats` beats from a math() builder — each row has { beat, value }.' },
  rasterize:   { sig: '.rasterize(maxBeats?)',                detail: 'bake frame cache', info: 'Bake sparse event rows (keyed by `beat`) into a dense per-frame world state Table. Optional maxBeats sets the length; omitted, it sizes to the last event.' },
  simulate:    { sig: '.simulate({ steps, gravity, ... })',   detail: 'run physics',      info: 'Step the JoltPhysics world. Options: steps (frames), gravity, fps, sampleEvery, collisions.' },
  steps:       { sig: '.steps(table | rows)',                 detail: 'origami crease table', info: 'One table = the whole folding, as a static crease list. Each row with a line is a crease: `p1`/`p2` its segment — each point "edge@t" (a fraction along an edge of the ORIGINAL square: bottom/top/left/right), "name@t" (a fraction along an earlier row\'s segment), or raw "x,y". `move` names the pieces it rotates by sample points (";"-separated; only pieces touching the crease); a row with a line but NO move is a construction line, referenceable but never folded. `sign` is the crease\'s turning sense (flip it — or swap p1/p2 — if a flap tears away mid-fold), `deg` the full signed angle (±180 = flat), and `at`/`dur`/`to` its timing (1 folded, 0 open, −1 folded the other way; dur 0 = geometry only). Rows sharing a `step` name extend one fold across layers; a row with no line re-drives an earlier fold (keyframes).' },
  spawn:       { sig: '.spawn({ id, color, px, … })',         detail: 'origami create row', info: 'The origami sheet\'s scene create row (shape: "origami"), with every fold group initialised to 0 (flat). Props merge over defaults.' },
  sequence:    { sig: '.sequence(steps?)',                    detail: 'origami schedule',  info: 'Bake fold steps { fold, at, dur?, to?, ease? } into beat-timed update keyframes for the sheet spawned from this builder. With no argument, uses the timings from the .steps() rows. Steps may overlap; `to` below 1 part-folds, back to 0 unfolds; ease is an easing fn or name.' },
  graph:       { sig: '.graph(...columns)',                   detail: 'draw graph',       info: 'Mark this Table to be drawn on the graph panel. Pass column name(s) to plot.' },
  save:        { sig: '.save(name)',                          detail: 'save as view',     info: 'Sugar for define(name, () => this) — register the current Table as a named view.' },
}

// Methods offered after a dot on an Expr (field("x").add(1).gt(2)…). Every Expr
// method returns an Expr, so a chain rooted at field()/lit()/idx() stays Expr.
export const EXPR_METHOD_DOCS: Record<string, DocEntry> = {
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

export const DSL_BUILTINS = Object.keys(DSL_BUILTIN_DOCS)

export const defaultProgram = SAMPLES[0].code

export function viewAtPos(text: string, pos: number): string | null {
  const re = /\bdefine\(\s*"([^"]+)"/g
  let m: RegExpExecArray | null
  let name: string | null = null
  while ((m = re.exec(text))) {
    if (m.index <= pos) name = m[1]
    else break
  }
  return name
}

// The view supplies how a completion's info card is *built* (it owns DOM);
// this module decides *when* and with which docs it appears.
export type InfoNodeFactory = (sig: string, info: string) => () => { dom: HTMLElement; destroy?: () => void }

export function dslCompletions(getViews: (() => Map<string, Table> | undefined) | undefined, makeInfoNode: InfoNodeFactory) {
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
          return { label, type: 'method', detail: d.detail, info: makeInfoNode(d.sig, d.info) }
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
        return { label, type: 'function', detail: d.detail, info: makeInfoNode(d.sig, d.info) }
      }),
      validFor: /^\w*$/,
    }
  }
}

// ── Remote cursors (multiplayer presence) ────────────────────────────────────
// Collaborators editing the same code cell as this editor show up as colored
// carets with a name flag. Positions are plain doc offsets from the remote
// replica; the two docs can drift between Applies (program text only syncs on
// a Run), so offsets are clamped rather than trusted to line up exactly.

export interface RemoteCursor {
  client: string
  user: string
  color: string
  head: number
}

// The cell label of the main program itself — the "code" table's single row
// (see main.ts's CODE_SCHEMA), in the same table[row].col form editCell uses.
export const PROGRAM_CELL = 'code[0].code'

class RemoteCursorWidget extends WidgetType {
  constructor(private readonly user: string, private readonly color: string) { super() }

  override eq(other: RemoteCursorWidget): boolean {
    return other.user === this.user && other.color === this.color
  }

  override toDOM(): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'cm-remote-cursor'
    wrap.style.borderLeftColor = this.color
    const label = document.createElement('span')
    label.className = 'cm-remote-cursor-label'
    label.style.background = this.color
    label.textContent = this.user
    wrap.appendChild(label)
    return wrap
  }

  override ignoreEvent(): boolean { return true }
}

export const setRemoteCursorsEffect = StateEffect.define<RemoteCursor[]>()

export const remoteCursorField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes)
    for (const e of tr.effects) {
      if (!e.is(setRemoteCursorsEffect)) continue
      deco = Decoration.set(
        e.value.map((c) => Decoration.widget({
          widget: new RemoteCursorWidget(c.user, c.color),
          side: -1,
        }).range(Math.max(0, Math.min(c.head, tr.newDoc.length)))),
        true,
      )
    }
    return deco
  },
  provide: (f) => EditorView.decorations.from(f),
})

// Hovering a quoted view name pops a data preview of that view. The card
// itself comes from the injected builder (see ui/table-preview.tsx).
export function dslHover(
  getViews: (() => Map<string, Table> | undefined) | undefined,
  getPlayIndex: (() => number) | undefined,
  buildPreview: (table: Table, opts: { playIndex?: number | null }) => { dom: HTMLElement; destroy?: () => void },
) {
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
        create: () => buildPreview(table, { playIndex: getPlayIndex?.() }),
      }
    }
    return null
  })
}
