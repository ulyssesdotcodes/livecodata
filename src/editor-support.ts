// Editor support — the non-view half of the code editor: DSL documentation
// tables, completion sources, and the hover-preview tooltip logic. Anything
// that builds actual DOM (completion info cards, the preview card) is
// injected by the view (ui/editor.tsx) as a factory, keeping this module
// free of rendering concerns.

import { EditorView, hoverTooltip, showTooltip, Decoration, WidgetType, type DecorationSet, type Tooltip } from '@codemirror/view'
import { StateField, StateEffect, type Extension } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import { localCompletionSource } from '@codemirror/lang-javascript'
import type { CompletionContext, CompletionResult, Completion } from '@codemirror/autocomplete'
import { isExprDot, isThreeDot, cmCompletionType, completionBoost } from './completion.js'
import { SAMPLES } from './samples.js'
import type { Table } from './dsl.js'
import type { LangClient } from './lang-client.js'
import type { LangSignatureHelp, EditorLang } from './lang-service.js'

// Which language surface the editor is currently a window onto: the DSL
// program, or a hydra sketch cell (see editor.tsx's cell-target mode). The
// view owns the state; sources read it per query.
export type GetLang = () => EditorLang

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
  rotate:     { sig: 'rotate(rows, values)',         detail: 'cycle rows under values', info: 'One row per entry in `values` (output length matches `values`), cycling through `rows`: output row i is { ...rows[i % rows.length], ...values[i] }. `rows` is the short repeating base/pattern; `values` the longer array of overrides merged on top.' },
  data:       { sig: 'data(url)',                     detail: 'fetch dataset',    info: 'Load a pre-fetched CSV file by URL into a Table. Files in /data/ are served statically; the runtime fetches them before cooking.' },
  csv:        { sig: 'csv(string)',                  detail: 'parse CSV',        info: 'Parse a CSV string (header row + data rows) into a Table.' },
  json:       { sig: 'json(array | string)',         detail: 'parse JSON',       info: 'Wrap a JS array or parse a JSON string into a Table.' },
  grid:       { sig: 'grid(cols, rows)',             detail: 'XZ lattice',       info: 'Generate a cols×rows lattice of XZ positions as a Table (fields: col, row, x, z).' },
  camera:     { sig: 'camera([{ beat, px, py, pz, tx, ty, tz, fov? }, …])', detail: 'camera moves', info: 'Beat-timed camera keyframes. One row per keyframe: px/py/pz place the eye, tx/ty/tz the look-at target (default origin), fov the vertical field of view in degrees (lower = a longer lens). The first row becomes the scene\'s camera create event, the rest updates — all id "camera", shape "camera" — so it rides events → rasterize like any object and interpolates between keyframes. Concat it into your events stream. Later keyframes need only the fields they change.' },
  box:        { sig: 'box({ id, px, py, pz, hx, hy, hz, color, … })', detail: 'create a box', info: 'A ready-made create row for a box, as a Table — beat 1, at the origin, no rotation, so set only what you need. hx/hy/hz are half-extents (a box renders 2× each). id defaults to "box"; give distinct ids for several. color is a hex number (0x4a9eff). Concat with other primitives and .rasterize(). e.g. box({ id: "a", px: -1, color: 0x4a9eff }).' },
  sphere:     { sig: 'sphere({ id, px, py, pz, r, color, … })', detail: 'create a sphere', info: 'A create-row Table for a sphere — beat 1, at the origin. r is the radius (default in the renderer if unset). id defaults to "sphere". Concat with other primitives and .rasterize().' },
  cylinder:   { sig: 'cylinder({ id, px, py, pz, r, h, color, … })', detail: 'create a cylinder', info: 'A create-row Table for a cylinder — beat 1, at the origin. r is the radius, h the half-height (renders 2h tall). id defaults to "cylinder". Concat with other primitives and .rasterize().' },
  cone:       { sig: 'cone({ id, px, py, pz, r, h, color, … })', detail: 'create a cone', info: 'A create-row Table for a cone — beat 1, at the origin. r is the base radius, h the half-height (renders 2h tall). id defaults to "cone". Concat with other primitives and .rasterize().' },
  torus:      { sig: 'torus({ id, px, py, pz, r, color, … })', detail: 'create a torus', info: 'A create-row Table for a torus (ring) — beat 1, at the origin. r is the ring radius. id defaults to "torus". Concat with other primitives and .rasterize().' },
  text:       { sig: 'text({ id, text, size, px, py, pz, color, … })', detail: 'create 3D text', info: 'A create-row Table for extruded 3D text (shape "text") — beat 1, at the origin. text is the string (\\n splits into stacked lines), size the world-space cap height (default 0.5), color a hex number (default white). id defaults to "text". Only bundled-font (helvetiker: Latin + common punctuation) glyphs render. Concat with other primitives and .rasterize().' },
  object:     { sig: 'object(shape, { id, … })', detail: 'create any shape', info: 'The generic behind box()/sphere()/… — a create-row Table for any shape string ("box", "sphere", "cylinder", "cone", "torus", "text", or a future shape). Defaults to beat 1 at the origin; id defaults to the shape name. Prefer the named helpers so autocomplete shows the shapes.' },
  physics:    { sig: 'physics(table)',               detail: 'physics scene',    info: 'Load a base scene table into the JoltPhysics engine. Chain .simulate() to run the simulation.' },
  editable:   { sig: 'editable(name, schema, seedRows?)', detail: 'user table', info: 'A user-editable table: rows are edited in the table panel, not computed — every edit is an appended event and the visible table is the fold (see the name·events tab). schema maps column name to "number" | "string" | "boolean" | "code" (or a string[] for an enum dropdown); code cells open in this editor, and declare their language via { type: "code", language: "hydra" } so completions match (default the DSL). seedRows fill the table when first created.' },
  origami:    { sig: 'origami()', detail: 'folding paper', info: 'A sheet of paper folded by a table of fold steps, each solved exactly. Chain .steps(table) — one row per fold: p1/p2 two points "x,y" on the fold line (drawn on the current folded paper, unit-square frame), move sheet-space marker(s) for the flap(s) that swing, kind/pick to choose the move when a fold is ambiguous ("simple", "reverse", "sink", …), at/dur/to its timing. Then .spawn({ id, color, … }) for the scene create row and .sequence() for the beat-timed keyframes. Every row is verified: a fold that cannot lie flat fails with an error naming the step.' },
  field:      { sig: 'field(name)',                   detail: 'expr: read field',  info: 'A chainable expression reading row[name]. Chain .add/.sub/.mul/.div/.mod, .eq/.gt/…, .and/.or/.not, .cond(a,b). Use in filter(expr), map(template), emit(template), derive — these are diffable (no opaque closures).' },
  lit:        { sig: 'lit(value)',                   detail: 'expr: literal',     info: 'A constant expression. Usually you can pass a raw value directly to an Expr method.' },
  idx:        { sig: 'idx()',                         detail: 'expr: row index',   info: 'An expression yielding the row index (0-based).' },
  midi:       { sig: 'midi(note, channel?)',         detail: 'expr: live MIDI',   info: 'A live value from the streaming MIDI table — the most recent event for `note` (e.g. "c4", "c#4", or "cc1" for control change) at-or-before the playhead. Normalized 0–1 (note velocity / CC value). Chainable like any Expr: midi("c4").mul(2). Use in setField/map/derive; it resolves each frame, so notes you play while looping replay at the loop position they were heard. Optional 1-based `channel` filters to one channel.' },
  beats:      { sig: 'beats(count, { fit }?)',       detail: 'beat timeline',     info: 'A timeline that loops every `count` beats. Tempo is automatic — the playhead always runs at the tapped tempo (Tap) — so this is a RETIME: define("timeline", () => beats(16)) just loops every 16 beats; { fit: beats } stretches a span of source beats across the window (e.g. beats(16, { fit: 8 }) plays 8 beats of content at half speed).' },
  tempo:      { sig: 'tempo(fallback?)',             detail: 'beat length (s)',   info: 'Seconds per beat derived from the tap-beat table (Tap), or `fallback` (default 0.5s = 120 BPM) until two taps are recorded.' },
  taps:       { sig: 'taps()',                       detail: 'tap-beat table',    info: 'The tap-beat table: one row per wall-time button press ({ beat, time }, time as an absolute UTC epoch ms).' },
  schemas:    { sig: 'schemas.hydra / .sliders / .path / .steps', detail: 'canonical table schemas', info: 'The column schemas of the tables the runtime knows by name, ready to pass to editable() — right columns, enum dropdowns, and code languages included: editable("hydra", schemas.hydra). Frozen; spread to extend: { ...schemas.hydra, extra: "string" }.' },
  linear:     { sig: 'linear',                       detail: 'easing curve',     info: 'Linear easing (t → t). Pass as the ease field of a color-pulse row.' },
  easeIn:     { sig: 'easeIn',                       detail: 'easing curve',     info: 'Quadratic ease-in (t → t²). Starts slow, ends fast.' },
  easeOut:    { sig: 'easeOut',                      detail: 'easing curve',     info: 'Quadratic ease-out (t → 1-(1-t)²). Starts fast, ends slow.' },
  easeInOut:  { sig: 'easeInOut',                    detail: 'easing curve',     info: 'Quadratic ease-in-out. Slow at both ends, fast in the middle.' },
}

export const TABLE_METHOD_DOCS: Record<string, DocEntry> = {
  map:         { sig: '.map(row => row | template)',          detail: 'transform rows',   info: 'Transform every row. Pass a function, or a declarative template of Expr/literals (e.g. { y: field("v").mul(2) }) — the template form is diffable.' },
  filter:      { sig: '.filter(row => bool | Expr)',          detail: 'keep rows',        info: 'Keep rows where the predicate holds. Pass a function, or an Expr predicate (e.g. field("type").eq("collision")) — the Expr form is diffable.' },
  filterMap:   { sig: '.filterMap(row => row | null)',        detail: 'filter + map',     info: 'Map and filter in one pass — return a new row to keep it, null/undefined to drop it. (For a diffable form, use .filter(Expr).emit(template).)' },
  flatMap:     { sig: '.flatMap(row => row | row[] | null)',  detail: 'fan out rows',     info: 'Map each row to zero, one, or many rows and flatten the result — like Array.flatMap. Alias of filterMap. (For a diffable form, use .filter(Expr).emit(template).)' },
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
  pairBy:      { sig: '.pairBy(field, value, (first, second) => rows)', detail: 'transform matched pairs', info: 'Find rows where row[field] === value and cycle through them pairwise — match k paired as `second` with match k-1 as `first` (the last match wraps around to pair with the first). fn(first, second) returns the row(s) that replace `second`; non-matching rows pass through unchanged.' },
  range:       { sig: '.range(beats)',                        detail: 'generate rows',    info: 'Emit rows over `beats` beats from a math() builder — each row has { beat, value }.' },
  rasterize:   { sig: '.rasterize(maxBeats?)',                detail: 'bake frame cache', info: 'Bake sparse event rows (keyed by `beat`) into a dense per-frame world state Table. Optional maxBeats sets the length; omitted, it sizes to the last event.' },
  simulate:    { sig: '.simulate({ steps, gravity, ... })',   detail: 'run physics',      info: 'Step the JoltPhysics world. Options: steps (frames), gravity, fps, sampleEvery, collisions.' },
  steps:       { sig: '.steps(table | rows)',                 detail: 'origami fold table', info: 'One table = the whole folding, one row per fold, applied in order. p1/p2: two points "x,y" on the fold line, in the fixed unit-square frame the flat sheet started in. move: sample point(s) on the UNFOLDED sheet (";"-separated), one inside each flap that swings — a sheet point names exactly one ply, so single layers of a stack can be picked out. kind: "simple", "reverse", "sink", … chooses the move when several layer orders are valid; pick indexes among same-kind states. kind "crease" cuts every ply along the line WITHOUT folding (origami pre-creasing) — it takes no timeline slot and gives later folds and the soft motion extra bend lines. at/dur: when the swing starts and how long it lasts, in beats (defaults: the row\'s position, 0.75). to: how far to swing — 1 lands flat; only the last row may stop short (wings held half-raised).' },
  spawn:       { sig: '.spawn({ id, color, px, … })',         detail: 'origami create row', info: 'The origami sheet\'s scene create row (shape: "origami"), with the compiled fold program riding along and fold at 0 (flat sheet). Props merge over defaults.' },
  sequence:    { sig: '.sequence(steps?)',                    detail: 'origami schedule',  info: 'Bake the fold table\'s at/dur timings into beat-timed update keyframes driving one numeric field, fold: k means the first k folds have landed, fractions swing the next flap about its fold line. Pass rows { step, at, dur? } to retime individual folds.' },
  three:       { sig: '.three.rotate / .three.scale / .three.move', detail: 'animate scene objects', info: 'Transform animations for the 3D scene. Reads this table\'s `create` rows and appends the UPDATE keyframes carrying each object\'s transform over time; the base rows pass through, so the result is renderable and the animators chain. .three.rotate({ amount, dur, axis }) spins, .three.scale({ amount, dur }) grows, .three.move({ amount, dur, axis }) slides. e.g. box().three.rotate({ amount: Math.PI, dur: 8 }).three.scale({ amount: 1.5, dur: 8 }).rasterize(8).' },
  graph:       { sig: '.graph(...columns)',                   detail: 'draw graph',       info: 'Mark this Table to be drawn on the graph panel. Pass column name(s) to plot.' },
  save:        { sig: '.save(name)',                          detail: 'save as view',     info: 'Sugar for define(name, () => this) — register the current Table as a named view.' },
}

// Methods on the object returned by a table's `.three` accessor — offered after
// `.three.` (see dslCompletions). Each returns a Table, so the chain continues
// with ordinary table methods (including `.three` again).
export const THREE_METHOD_DOCS: Record<string, DocEntry> = {
  rotate: { sig: '.three.rotate({ amount, dur, axis, ease, at })', detail: 'spin over time',  info: 'For every `create` row, add `amount` radians to its rotation about `axis` (\'x\'|\'y\'|\'z\', default y; default amount a full turn) over `dur` beats. `ease` shapes the segment; `at` overrides the start beat (default the create row\'s beat).' },
  scale:  { sig: '.three.scale({ amount, dur, ease, at })',       detail: 'grow over time',   info: 'For every `create` row, multiply its scale (sx/sy/sz, default 1) by the `amount` factor (default 2×) over `dur` beats, uniformly on all axes. `ease` shapes the segment; `at` overrides the start beat.' },
  move:   { sig: '.three.move({ amount, dur, axis, ease, at })',  detail: 'slide over time',  info: 'For every `create` row, add `amount` world units to its position along `axis` (\'x\'|\'y\'|\'z\', default x; default amount 1) over `dur` beats. `ease` shapes the segment; `at` overrides the start beat.' },
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
// The default program is the "Editable Table" example, whose row data lives
// with the sample rather than inline in the code — so a fresh session/first run
// must seed the store with it, exactly as opening the example does.
export const defaultTables = SAMPLES[0].tables

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

// A resolved symbol's card: the full type from the language service plus the
// curated DSL prose when the name is surface API. The view owns the DOM.
export interface SymbolCardData {
  display: string | null
  docs: string
  curated: DocEntry | null
}
export type SymbolCardFactory = (data: SymbolCardData) => { dom: HTMLElement; destroy?: () => void }

// Curated docs for `name` completed/hovered at `start`: member access picks
// the method table by the chain's root (the same heuristic the fallback
// completions use), a bare identifier is a DSL builtin or nothing. The
// language service supplies exact types either way; this only adds prose.
export function curatedDocFor(text: string, start: number, name: string): DocEntry | null {
  let i = start - 1
  while (i >= 0 && /\s/.test(text[i])) i--
  if (i >= 0 && text[i] === '.') {
    const docs = isThreeDot(text, i) ? THREE_METHOD_DOCS
      : isExprDot(text, i) ? EXPR_METHOD_DOCS
        : TABLE_METHOD_DOCS
    return docs[name] ?? null
  }
  return DSL_BUILTIN_DOCS[name] ?? null
}

// Completing view names inside table("…") / define("…" quotes. DSL-only:
// those calls don't exist in a hydra sketch.
export function viewNameCompletions(getViews: (() => Map<string, Table> | undefined) | undefined, getLang: GetLang) {
  return (context: CompletionContext): CompletionResult | null => {
    if (getLang() !== 'dsl') return null
    if (!context.matchBefore(/\b(?:table|define)\(\s*"[^"]*/)) return null
    const open = context.matchBefore(/"[^"]*/)
    const names = [...(getViews?.() ?? new Map()).keys()]
    if (!names.length) return null
    return {
      from: open ? open.from + 1 : context.pos,
      options: names.map((n: string) => ({ label: n, type: 'variable' })),
      validFor: /^[^"]*$/,
    }
  }
}

// The pre-language-service completions, retained as the fallback while the
// worker loads (or if it never does): the chain-root heuristic picks a method
// table after a dot; bare words offer the DSL builtins plus whatever locals
// the syntax tree knows about.
function heuristicCompletions(context: CompletionContext, makeInfoNode: InfoNodeFactory): CompletionResult | null {
  const dot = context.matchBefore(/\.\w*/)
  if (dot) {
    const text = context.state.doc.toString()
    const docs = isThreeDot(text, dot.from) ? THREE_METHOD_DOCS
      : isExprDot(text, dot.from) ? EXPR_METHOD_DOCS
        : TABLE_METHOD_DOCS
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
  const from = word ? word.from : context.pos
  const local = localCompletionSource(context)
  return {
    from,
    options: [
      ...DSL_BUILTINS.map((label): Completion => {
        const d = DSL_BUILTIN_DOCS[label]
        return { label, type: 'function', detail: d.detail, info: makeInfoNode(d.sig, d.info) }
      }),
      ...(local && local.from === from ? local.options : []),
    ],
    validFor: /^\w*$/,
  }
}

// The main completion source: the TypeScript language service when its worker
// is ready (real type-aware completions — "what follows this dot" answered by
// the checker against the DSL's actual types), the heuristics otherwise. Each
// option's info card resolves lazily: full signature from the service, plus
// curated DSL prose when the name is surface API.
export function codeCompletions(
  client: LangClient | null,
  makeInfoNode: InfoNodeFactory,
  makeSymbolCard: SymbolCardFactory,
  getLang: GetLang,
) {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    // Strings and comments never complete here — view names inside quotes
    // have their own source (viewNameCompletions).
    const node = syntaxTree(context.state).resolveInner(context.pos, -1)
    if (/String|Comment/.test(node.name)) return null
    const lang = getLang()

    if (client && client.status() === 'ready') {
      const word = context.matchBefore(/[\w$]+/)
      const dot = context.matchBefore(/\.[\w$]*/)
      if (!word && !dot && !context.explicit) return null
      const text = context.state.doc.toString()
      const res = await client.completions(text, context.pos, lang)
      if (res && res.entries.length) {
        const from = word ? word.from : context.pos
        return {
          from,
          options: res.entries.map((e): Completion => {
            const curated = lang === 'dsl' ? curatedDocFor(text, from, e.name) : null
            return {
              label: e.name,
              type: cmCompletionType(e.kind),
              ...(curated ? { detail: curated.detail } : {}),
              boost: completionBoost(e.sortText, e.kind, curated !== null),
              info: async () => {
                const det = await client.details(text, context.pos, e.name, lang)
                if (!det && !curated) return null
                return makeSymbolCard({
                  display: det?.display ?? curated?.sig ?? null,
                  docs: det?.docs ?? '',
                  curated,
                })
              },
            }
          }),
          validFor: /^[\w$]*$/,
        }
      }
      // No answer (e.g. the parse is too broken mid-edit) — fall through.
    }
    // The heuristic fallback knows only the DSL surface; in a hydra cell
    // wrong suggestions are worse than none.
    return lang === 'dsl' ? heuristicCompletions(context, makeInfoNode) : null
  }
}

// Hovering an identifier shows its complete type from the language service
// (and the curated DSL prose when it's surface API).
export function typeHover(client: LangClient, makeSymbolCard: SymbolCardFactory, getLang: GetLang) {
  return hoverTooltip(async (view, pos) => {
    if (client.status() !== 'ready') return null
    const lang = getLang()
    const text = view.state.doc.toString()
    const info = await client.quickInfo(text, pos, lang)
    if (!info || !info.display) return null
    const curated = lang === 'dsl' ? curatedDocFor(text, info.start, text.slice(info.start, info.end)) : null
    return {
      pos: info.start,
      end: info.end,
      above: true,
      create: () => makeSymbolCard({ display: info.display, docs: info.docs, curated }),
    }
  })
}

// ── Signature help ───────────────────────────────────────────────────────────
// Typing "(" or "," inside a call pops a tooltip with the callee's signature,
// the active parameter highlighted; it follows re-queries as the arguments
// evolve and clears when the cursor leaves the call (or on Escape).

export interface SigHelpState {
  pos: number
  sig: LangSignatureHelp
}

export type SigCardFactory = (sig: LangSignatureHelp) => { dom: HTMLElement; destroy?: () => void }

export function signatureHelp(client: LangClient, makeSigCard: SigCardFactory, getLang: GetLang): Extension {
  const setSig = StateEffect.define<SigHelpState | null>()

  const field = StateField.define<SigHelpState | null>({
    create: () => null,
    update(value, tr) {
      if (value && tr.docChanged) value = { ...value, pos: tr.changes.mapPos(value.pos) }
      for (const e of tr.effects) if (e.is(setSig)) value = e.value
      return value
    },
    provide: (f) => showTooltip.from(f, (value): Tooltip | null => value && {
      pos: value.pos,
      above: true,
      create: () => makeSigCard(value.sig),
    }),
  })

  // Stale-response guard: only the latest query may update the tooltip.
  let epoch = 0

  const listener = EditorView.updateListener.of((update) => {
    const active = update.state.field(field) !== null
    let trigger: string | undefined
    if (update.docChanged) {
      const head = update.state.selection.main.head
      const ch = head > 0 ? update.state.doc.sliceString(head - 1, head) : ''
      if (ch === '(' || ch === ',') trigger = ch
      else if (!active) return // only ( and , open the tooltip
    } else if (!(update.selectionSet && active)) {
      return // cursor moves only re-query (or clear) an open tooltip
    }
    if (client.status() !== 'ready') return
    const id = ++epoch
    const { view } = update
    const text = update.state.doc.toString()
    const head = update.state.selection.main.head
    void client.signatureHelp(text, head, trigger, getLang()).then((sig) => {
      if (id !== epoch) return
      const value = sig ? { pos: Math.min(sig.argumentStart, head), sig } : null
      if (value === null && view.state.field(field, false) == null) return // nothing to clear
      view.dispatch({ effects: setSig.of(value) })
    })
  })

  const closeOnEscape = EditorView.domEventHandlers({
    keydown: (event, view) => {
      if (event.key === 'Escape' && view.state.field(field, false)) {
        view.dispatch({ effects: setSig.of(null) })
      }
      return false // never swallow — vim &co. still see the key
    },
  })

  return [field, listener, closeOnEscape]
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
