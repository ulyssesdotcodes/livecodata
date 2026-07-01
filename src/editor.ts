import { EditorView, basicSetup } from 'codemirror'
import { javascript, javascriptLanguage } from '@codemirror/lang-javascript'
import { oneDark } from '@codemirror/theme-one-dark'
import { keymap, hoverTooltip } from '@codemirror/view'
import { Prec } from '@codemirror/state'
import { autocompletion, snippetCompletion, acceptCompletion, type Completion } from '@codemirror/autocomplete'
import { vim } from '@replit/codemirror-vim'
import { buildTablePreview } from './preview.js'
import { chainRoot, EXPR_ROOTS } from './completion.js'
import type { Table } from './dsl.js'

interface DocEntry {
  sig: string
  detail: string
  info: string
  // CM6 snippet template (${1:placeholder}, $0 = final cursor) — lets accepting
  // a completion insert live tab-stops for the args instead of a bare label, so
  // livecoding a call is "accept, type, Tab, type, …" instead of hand-typing
  // every paren/quote/comma.
  snippet?: string
}

const DSL_BUILTIN_DOCS: Record<string, DocEntry> = {
  define:       { sig: 'define(name, fn)',             detail: 'register view',    info: 'Register a named view. fn receives (rand, table) and must return a Table. Views are cooked lazily; deps tracked via table().', snippet: 'define("${1:name}", () => ${0})' },
  table:        { sig: 'table(name)',                  detail: 'resolve view',     info: 'Resolve a named view at top-level (no dependency tracking). Returns the cooked Table for that view.', snippet: 'table("${1:name}")' },
  math:         { sig: 'math(index => value)',         detail: 'sample function',  info: 'Sample a numeric function of the row index. Chain .range(n) to emit n rows of { index, value }.', snippet: 'math((t) => ${1:t})' },
  rows:         { sig: 'rows([{...}, ...])',           detail: 'wrap array',       info: 'Wrap a literal array of plain objects into a Table.', snippet: 'rows([${0}])' },
  csv:          { sig: 'csv(string)',                  detail: 'parse CSV',        info: 'Parse a CSV string (header row + data rows) into a Table.', snippet: 'csv(`${0}`)' },
  json:         { sig: 'json(array | string)',         detail: 'parse JSON',       info: 'Wrap a JS array or parse a JSON string into a Table.', snippet: 'json([${0}])' },
  grid:         { sig: 'grid(cols, rows)',             detail: 'XZ lattice',       info: 'Generate a cols×rows lattice of XZ positions as a Table (fields: col, row, x, z).', snippet: 'grid(${1:4}, ${2:4})' },
  physics:      { sig: 'physics(table)',               detail: 'physics scene',    info: 'Load a base scene table into the JoltPhysics engine. Chain .simulate() to run the simulation.', snippet: 'physics(${1:table("base")}).simulate({ steps: ${2:120} })' },
  field:        { sig: 'field(name)',                   detail: 'expr: read field',  info: 'A chainable expression reading row[name]. Chain .add/.sub/.mul/.div/.mod, .eq/.gt/…, .and/.or/.not, .cond(a,b). Use in filter(expr), map(template), emit(template), derive — these are diffable (no opaque closures).', snippet: 'field("${1:name}")' },
  lit:          { sig: 'lit(value)',                   detail: 'expr: literal',     info: 'A constant expression. Usually you can pass a raw value directly to an Expr method.', snippet: 'lit(${1:0})' },
  idx:          { sig: 'idx()',                         detail: 'expr: row index',   info: 'An expression yielding the row index (0-based).', snippet: 'idx()' },
  beats:        { sig: 'beats(count, { fit }?)',       detail: 'beat timeline',     info: 'A looping timeline `count` beats long at the tapped tempo (🥁 Tap under the scene). Use as the "timeline" view: define("timeline", () => beats(16)). { fit: seconds } stretches a scene across the beat window.', snippet: 'beats(${1:16})' },
  tempo:        { sig: 'tempo(fallback?)',             detail: 'beat length (s)',   info: 'Seconds per beat derived from the tap-beat table (🥁 Tap), or `fallback` (default 0.5s = 120 BPM) until two taps are recorded.', snippet: 'tempo()' },
  taps:         { sig: 'taps()',                       detail: 'tap-beat table',    info: 'The tap-beat table: one row per wall-time button press ({ beat, time }).', snippet: 'taps()' },
  box:          { sig: 'box(id, { hx, hy, hz }?)',     detail: 'row: box body',     info: 'A box object-create row (chainable). Half-extents default from the renderer/physics shape defaults when omitted. Chain .pos/.rot/.withColor/.static()/.dynamic()/.kinematic()/.withFriction/.withRestitution/.velocity/.at(time).', snippet: 'box("${1:id}", { hx: ${2:0.25}, hy: ${3:0.25}, hz: ${4:0.25} })' },
  sphere:       { sig: 'sphere(id, { r }?)',           detail: 'row: sphere body',  info: 'A sphere object-create row (chainable). Same chain methods as box().', snippet: 'sphere("${1:id}", { r: ${2:0.3} })' },
  cylinder:     { sig: 'cylinder(id, { r, h }?)',      detail: 'row: cylinder body', info: 'A cylinder object-create row (chainable). Same chain methods as box().', snippet: 'cylinder("${1:id}", { r: ${2:0.2}, h: ${3:0.3} })' },
  cone:         { sig: 'cone(id, { r, h }?)',          detail: 'row: cone body',    info: 'A cone object-create row (chainable). Same chain methods as box().', snippet: 'cone("${1:id}", { r: ${2:0.3}, h: ${3:0.3} })' },
  torus:        { sig: 'torus(id, { r }?)',            detail: 'row: torus body',   info: 'A torus object-create row (chainable). Same chain methods as box().', snippet: 'torus("${1:id}", { r: ${2:0.3} })' },
  update:       { sig: 'update(id)',                   detail: 'row: keyframe',     info: 'A later position/rotation/color keyframe for an id already created by box()/sphere()/… Chain .at(time).pos(x,y,z).', snippet: 'update("${1:id}")' },
  colorTo:      { sig: 'colorTo(id, color)',           detail: 'row: color pulse',  info: 'Pulse/step the color on an existing object. Chain .at(time).withDur(seconds).withEase(fn).withTo(color).', snippet: 'colorTo("${1:id}", ${2:0xffffff})' },
  destroy:      { sig: 'destroy(id)',                  detail: 'row: destroy',      info: 'Remove an existing object. Chain .at(time).', snippet: 'destroy("${1:id}")' },
  addEffect:    { sig: 'addEffect(id, effect, params?)', detail: 'row: add effect',  info: 'Add a post-processing effect (bloom/afterimage/dotscreen/rgbshift/film/glitch/halftone) to the composer chain. Chain .withInput(otherId).at(time).', snippet: 'addEffect("${1:id}", "${2:bloom}", { ${3:strength: 1} })' },
  updateEffect: { sig: 'updateEffect(id, params?)',    detail: 'row: update effect', info: 'Animate an existing effect\'s params. Chain .at(time).withDur(seconds).withEase(fn).', snippet: 'updateEffect("${1:id}", { ${2:strength: 1} })' },
  removeEffect: { sig: 'removeEffect(id)',             detail: 'row: remove effect', info: 'Remove an effect from the composer chain. Chain .at(time).', snippet: 'removeEffect("${1:id}")' },
  linear:       { sig: 'linear',                       detail: 'easing curve',     info: 'Linear easing (t → t). Pass as the ease field of a color-pulse row.' },
  easeIn:       { sig: 'easeIn',                       detail: 'easing curve',     info: 'Quadratic ease-in (t → t²). Starts slow, ends fast.' },
  easeOut:      { sig: 'easeOut',                      detail: 'easing curve',     info: 'Quadratic ease-out (t → 1-(1-t)²). Starts fast, ends slow.' },
  easeInOut:    { sig: 'easeInOut',                    detail: 'easing curve',     info: 'Quadratic ease-in-out. Slow at both ends, fast in the middle.' },
}

const TABLE_METHOD_DOCS: Record<string, DocEntry> = {
  map:         { sig: '.map(row => row | template)',          detail: 'transform rows',   info: 'Transform every row. Pass a function, or a declarative template of Expr/literals (e.g. { y: field("v").mul(2) }) — the template form is diffable.', snippet: '.map(${1:r => r})' },
  filter:      { sig: '.filter(row => bool | Expr)',          detail: 'keep rows',        info: 'Keep rows where the predicate holds. Pass a function, or an Expr predicate (e.g. field("type").eq("collision")) — the Expr form is diffable.', snippet: '.filter(${1:r => true})' },
  filterMap:   { sig: '.filterMap(row => row | null)',        detail: 'filter + map',     info: 'Map and filter in one pass — return a new row to keep it, null/undefined to drop it. (For a diffable form, use .filter(Expr).emit(template).)', snippet: '.filterMap(${1:r => r})' },
  emit:        { sig: '.emit(template | [templates])',        detail: 'fan out rows',     info: 'Declarative flatMap: emit one or many rows per source row from Expr/literal templates. The diffable counterpart of filterMap; pair with .filter(Expr).', snippet: '.emit([${0}])' },
  concat:      { sig: '.concat(other)',                       detail: 'combine tables',   info: 'Append the rows of another Table (or array) to this one.', snippet: '.concat(${1:other})' },
  slice:       { sig: '.slice(start, end?)',                  detail: 'subset rows',      info: 'Return a sub-range of rows, like Array.slice.', snippet: '.slice(${1:0})' },
  fold:        { sig: '.fold((acc, row) => acc, init)',       detail: 'reduce to value',  info: 'Reduce all rows to a single accumulated value, like Array.reduce.', snippet: '.fold((acc, r) => ${1:acc}, ${2:0})' },
  scan:        { sig: '.scan((state, row) => ({ state, emit }), init)', detail: 'running accumul.', info: 'Running accumulator — emit one output row per input row, carrying state forward.', snippet: '.scan((state, r) => ({ state, emit: ${1:null} }), ${2:null})' },
  join:        { sig: '.join(other, on)',                     detail: 'key join',         info: 'Key-based join: merge rows where the `on` field (or key fn) matches. Like SQL LEFT JOIN.', snippet: '.join(${1:other}, "${2:key}")' },
  zip:         { sig: '.zip(other)',                          detail: 'positional join',  info: 'Merge rows positionally — row 0 with row 0, row 1 with row 1, etc.', snippet: '.zip(${1:other})' },
  orderBy:     { sig: '.orderBy(field | fn, dir?)',           detail: 'sort rows',        info: 'Sort rows by a field name or comparator function. Optional dir: "asc" (default) or "desc".', snippet: '.orderBy("${1:field}")' },
  derive:      { sig: '.derive({ field: row => val })',       detail: 'add fields',       info: 'Add or overwrite fields on every row using derivation functions.', snippet: '.derive({ ${1:field}: ${2:(r) => r} })' },
  assign:      { sig: '.assign({ field: value })',            detail: 'set fields',       info: 'Merge a fixed object of field values into every row.', snippet: '.assign({ ${1:field}: ${2:value} })' },
  mapField:    { sig: '.mapField(field, val => val)',         detail: 'transform field',  info: 'Apply a function to one field of every row, replacing it in place.', snippet: '.mapField("${1:field}", ${2:(v) => v})' },
  rescale:     { sig: '.rescale(field, [min, max]?)',         detail: 'normalize field',  info: 'Normalize a numeric field to [0, 1] (or a custom range) across all rows.', snippet: '.rescale("${1:field}", [${2:0}, ${3:1}])' },
  lag:         { sig: '.lag(n)',                              detail: 'shift rows',       info: 'Shift rows forward by n positions, padding the start with null rows.', snippet: '.lag(${1:1})' },
  groupBy:     { sig: '.groupBy(field | fn)',                 detail: 'group rows',       info: 'Group rows by a key field or function. Chain .agg() or .count() to aggregate.', snippet: '.groupBy("${1:field}")' },
  agg:         { sig: '.agg({ field: rows => val })',         detail: 'aggregate groups', info: 'Aggregate each group into one row. Called after .groupBy().', snippet: '.agg({ ${1:field}: (rs) => ${2:rs.length} })' },
  count:       { sig: '.count()',                             detail: 'count groups',     info: 'Emit one row per group with a `count` field. Called after .groupBy().', snippet: '.count()' },
  trigger:     { sig: '.trigger(pred, emit)',                 detail: 'event detection',  info: 'When pred(row) is true, call emit(row) and include returned rows in the output.', snippet: '.trigger(${1:(r) => true}, ${2:(r) => r})' },
  triggerEach: { sig: '.triggerEach(pred, objs, make)',       detail: 'fan-out events',   info: 'Fan out: for each object in objs when pred fires, call make(row, obj) to emit rows.', snippet: '.triggerEach(${1:(r) => true}, ${2:objs}, ${3:(o, r) => r})' },
  crossings:   { sig: '.crossings(field, level)',             detail: 'threshold events', info: 'Emit one row each time the named field crosses the given numeric level.', snippet: '.crossings("${1:value}", ${2:0})' },
  range:       { sig: '.range(count)',                        detail: 'generate rows',    info: 'Emit count rows from a math() builder — each row has { index, value }.', snippet: '.range(${1:60})' },
  rasterize:   { sig: '.rasterize(maxFrame)',                 detail: 'bake frame cache', info: 'Bake sparse event rows (from simulate) into a dense per-frame world state Table indexed 0…maxFrame.', snippet: '.rasterize(${1:6})' },
  simulate:    { sig: '.simulate({ steps, gravity, ... })',   detail: 'run physics',      info: 'Step the JoltPhysics world. Options: steps (frames), gravity, fps, sampleEvery, collisions.', snippet: '.simulate({ steps: ${1:120}, gravity: ${2:-9.81} })' },
  graph:       { sig: '.graph(...columns)',                   detail: 'draw graph',       info: 'Mark this Table to be drawn on the graph panel. Pass column name(s) to plot.', snippet: '.graph("${1:column}")' },
  save:        { sig: '.save(name)',                          detail: 'save as view',     info: 'Sugar for define(name, () => this) — register the current Table as a named view.', snippet: '.save("${1:name}")' },
}

// Methods offered after a dot on an Expr (field("x").add(1).gt(2)…). Every Expr
// method returns an Expr, so a chain rooted at field()/lit()/idx() stays Expr.
const EXPR_METHOD_DOCS: Record<string, DocEntry> = {
  add:  { sig: '.add(x)',           detail: 'expr  +',   info: 'Add. x is another Expr or a number.', snippet: '.add(${1:x})' },
  sub:  { sig: '.sub(x)',           detail: 'expr  −',   info: 'Subtract x (Expr or number).', snippet: '.sub(${1:x})' },
  mul:  { sig: '.mul(x)',           detail: 'expr  ×',   info: 'Multiply by x (Expr or number).', snippet: '.mul(${1:x})' },
  div:  { sig: '.div(x)',           detail: 'expr  ÷',   info: 'Divide by x (Expr or number).', snippet: '.div(${1:x})' },
  mod:  { sig: '.mod(x)',           detail: 'expr  %',   info: 'Modulo (remainder) by x.', snippet: '.mod(${1:x})' },
  eq:   { sig: '.eq(x)',            detail: 'expr  ===', info: 'Strict-equal test. Returns a boolean Expr (use in filter / cond).', snippet: '.eq(${1:x})' },
  ne:   { sig: '.ne(x)',            detail: 'expr  !==', info: 'Not-equal test. Returns a boolean Expr.', snippet: '.ne(${1:x})' },
  gt:   { sig: '.gt(x)',            detail: 'expr  >',   info: 'Greater-than test. Returns a boolean Expr.', snippet: '.gt(${1:x})' },
  gte:  { sig: '.gte(x)',           detail: 'expr  >=',  info: 'Greater-than-or-equal test. Returns a boolean Expr.', snippet: '.gte(${1:x})' },
  lt:   { sig: '.lt(x)',            detail: 'expr  <',   info: 'Less-than test. Returns a boolean Expr.', snippet: '.lt(${1:x})' },
  lte:  { sig: '.lte(x)',           detail: 'expr  <=',  info: 'Less-than-or-equal test. Returns a boolean Expr.', snippet: '.lte(${1:x})' },
  and:  { sig: '.and(expr)',        detail: 'expr  &&',  info: 'Logical AND of two boolean Exprs.', snippet: '.and(${1:expr})' },
  or:   { sig: '.or(expr)',         detail: 'expr  ||',  info: 'Logical OR of two boolean Exprs.', snippet: '.or(${1:expr})' },
  not:  { sig: '.not()',            detail: 'expr  !',   info: 'Logical negation of a boolean Expr.', snippet: '.not()' },
  cond: { sig: '.cond(then, else)', detail: 'ternary',   info: 'If this Expr is truthy yield `then`, else `else` (each an Expr or literal).', snippet: '.cond(${1:then}, ${2:else})' },
}

// Methods offered after a dot on a row builder (box()/sphere()/update()/…).
// Split to match the actual runtime class hierarchy in dsl.ts, so e.g.
// update(id). doesn't offer .static()/.withFriction() (those only exist on
// object-create rows). Every setter name intentionally differs from the field
// it writes (see the naming-rule comment in dsl.ts) — .withColor, not .color.
const PLACEMENT_METHOD_DOCS: Record<string, DocEntry> = {
  at:  { sig: '.at(seconds)',       detail: 'row: time',    info: 'When this event happens, in seconds (the index field rasterize.js reads).', snippet: '.at(${1:0})' },
  pos: { sig: '.pos(x, y, z?)',     detail: 'row: position', info: 'Set px, py, pz.', snippet: '.pos(${1:0}, ${2:0}, ${3:0})' },
  rot: { sig: '.rot(x, y?, z?)',    detail: 'row: rotation', info: 'Set rx, ry, rz (radians).', snippet: '.rot(${1:0}, ${2:0}, ${3:0})' },
  withColor: { sig: '.withColor(hex)', detail: 'row: color', info: 'Set the color field (e.g. 0xff6b6b).', snippet: '.withColor(${1:0xffffff})' },
}

const BODY_METHOD_DOCS: Record<string, DocEntry> = {
  ...PLACEMENT_METHOD_DOCS,
  static:         { sig: '.static()',           detail: 'row: motion',     info: 'Non-moving body (motion: "static") — floors, walls.', snippet: '.static()' },
  dynamic:        { sig: '.dynamic()',          detail: 'row: motion',     info: 'Fully-simulated body (motion: "dynamic", the default).', snippet: '.dynamic()' },
  kinematic:      { sig: '.kinematic()',        detail: 'row: motion',     info: 'Script-driven body, unaffected by forces (motion: "kinematic").', snippet: '.kinematic()' },
  withFriction:   { sig: '.withFriction(f)',    detail: 'row: friction',   info: 'Set the friction coefficient.', snippet: '.withFriction(${1:0.8})' },
  withRestitution: { sig: '.withRestitution(r)', detail: 'row: bounciness', info: 'Set the restitution (bounciness) coefficient.', snippet: '.withRestitution(${1:0})' },
  velocity:       { sig: '.velocity(x, y, z?)', detail: 'row: velocity',   info: 'Set an initial linear velocity (vx, vy, vz).', snippet: '.velocity(${1:0}, ${2:0}, ${3:0})' },
}

const COLOR_METHOD_DOCS: Record<string, DocEntry> = {
  at:      { sig: '.at(seconds)',    detail: 'row: time',      info: 'When this color change happens, in seconds.', snippet: '.at(${1:0})' },
  withDur: { sig: '.withDur(seconds)', detail: 'row: duration', info: 'Ease into the new color over this many seconds (0 = instant step).', snippet: '.withDur(${1:0.5})' },
  withEase: { sig: '.withEase(fn)',  detail: 'row: easing',     info: 'Easing curve for the transition (e.g. easeOut).', snippet: '.withEase(${1:easeOut})' },
  withTo:  { sig: '.withTo(hex)',    detail: 'row: target',     info: 'Explicit color to ease toward (defaults to the base object color).', snippet: '.withTo(${1:0xffffff})' },
}

const EFFECT_METHOD_DOCS: Record<string, DocEntry> = {
  at:       { sig: '.at(seconds)',    detail: 'row: time',   info: 'When this effect event happens, in seconds.', snippet: '.at(${1:0})' },
  withInput: { sig: '.withInput(id)', detail: 'row: chain input', info: 'Wire this effect to read from another effect id earlier in the composer chain.', snippet: '.withInput("${1:id}")' },
  withDur:  { sig: '.withDur(seconds)', detail: 'row: duration', info: 'Ease the params over this many seconds (updateEffect only).', snippet: '.withDur(${1:0.5})' },
  withEase: { sig: '.withEase(fn)',   detail: 'row: easing',  info: 'Easing curve for the param transition (e.g. easeOut).', snippet: '.withEase(${1:easeOut})' },
}

const DESTROY_METHOD_DOCS: Record<string, DocEntry> = { at: PLACEMENT_METHOD_DOCS.at }

// Which method-doc set to offer after a dot, keyed by the chain's root
// identifier (see completion.ts's chainRoot). Roots not listed here fall back
// to Expr methods (EXPR_ROOTS) or plain Table methods.
const ROOT_METHOD_DOCS: Record<string, Record<string, DocEntry>> = {
  box: BODY_METHOD_DOCS, sphere: BODY_METHOD_DOCS, cylinder: BODY_METHOD_DOCS,
  cone: BODY_METHOD_DOCS, torus: BODY_METHOD_DOCS,
  update: PLACEMENT_METHOD_DOCS,
  colorTo: COLOR_METHOD_DOCS,
  destroy: DESTROY_METHOD_DOCS,
  addEffect: EFFECT_METHOD_DOCS, updateEffect: EFFECT_METHOD_DOCS, removeEffect: EFFECT_METHOD_DOCS,
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

// Build a completion option; snippet-apply when the doc has a template (so
// picking it drops in tab-stopped placeholder args), otherwise a bare label.
function docOption(label: string, type: string, d: DocEntry): Completion {
  const base: Completion = { label, type, detail: d.detail, info: () => makeInfoNode(d.sig, d.info), boost: 1 }
  return d.snippet ? snippetCompletion(d.snippet, base) : base
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
        options: names.map((n: string) => ({ label: n, type: 'variable', boost: 2 })),
        validFor: /^[^"]*$/,
      }
    }
    const dot = context.matchBefore(/\.\w*/)
    if (dot) {
      // Pick the method set by the chain's root: Expr methods after field()/lit()/
      // idx(), row-builder methods after box()/sphere()/update()/…, Table methods
      // otherwise (see completion.ts's chainRoot).
      const root = chainRoot(context.state.doc.toString() as string, dot.from as number)
      const docs = root && EXPR_ROOTS.has(root) ? EXPR_METHOD_DOCS
        : (root && ROOT_METHOD_DOCS[root]) || TABLE_METHOD_DOCS
      return {
        from: dot.from + 1,
        options: Object.keys(docs).map((label) => docOption(label, 'method', docs[label])),
        validFor: /^\w*$/,
      }
    }
    const word = context.matchBefore(/\w+/)
    if (!word && !context.explicit) return null
    return {
      from: word ? word.from : context.pos,
      options: DSL_BUILTINS.map((label) => docOption(label, 'function', DSL_BUILTIN_DOCS[label])),
      validFor: /^\w*$/,
    }
  }
}

export const defaultProgram = `// livecodata — House of Cards
// A triangular pyramid of playing cards collapses when a ball drops on it.
// Press "Run ▶" (or Cmd/Ctrl-Enter), then hit Play under the scene.
// Tips: Ctrl-Space completes views, Table verbs, and chain methods on Expr
// (field()/lit()/idx() — e.g. field("v").add(1).gt(2)) and on row builders
// (box()/sphere()/.../addEffect() — e.g. box("id").pos(0,1,0).withColor(0xfff));
// hover a "view" name to preview its table; your caret selects that view's tab
// on the right.

// 1. Build a 3-story pyramid of cards plus a falling ball.
//    Story k has (n − k) leaning-card tent pairs and (n − k − 1) horizontal
//    bridge cards between them. Card positions are derived analytically from the
//    lean angle so each card's lowest rotated corner rests on its support surface.
//    hz ≥ 0.05 is required because Jolt's BoxShape always applies a 0.05 convex
//    (corner-rounding) radius that must not exceed any half-extent.
define("base", () => {
  const lean = 0.25                    // radians from vertical (~14°)
  const H = 0.35, W = 0.22, T = 0.06  // card half-height, half-width, half-thickness
  const sl = Math.sin(lean), cl = Math.cos(lean)
  const dx    = H * sl                 // card-center x offset from tent apex
  const cyOff = W * sl + H * cl       // support-surface to card-center (no corner overlap)
  const S     = 0.50                   // spacing between adjacent tent apices
  const n     = 3                      // tents on the ground floor (try 4 for ~27 cards)

  const cards = []
  let supportY = -1.0                  // current support surface y (floor to start)

  for (let k = 0; k < n; k++) {
    const numTents = n - k
    const cardCY   = supportY + cyOff
    const topY     = supportY + W * sl + 2 * H * cl  // tent apex y
    const bHx      = S / 2 + 0.03                    // bridge half-span
    const card = (id, x) => box(id, { hx: W, hy: H, hz: T })
      .pos(x, cardCY, 0).withColor(0xfdf6e3).withFriction(0.8).withRestitution(0)

    // Leaning card pairs — two cards per tent, tops meeting at the apex
    for (let i = 0; i < numTents; i++) {
      const tx = -(numTents - 1) * S / 2 + i * S     // apex x
      cards.push(
        card("s" + k + "t" + i + "a", tx - dx).rot(0, 0, -lean),
        card("s" + k + "t" + i + "b", tx + dx).rot(0, 0,  lean),
      )
    }

    // Horizontal bridge cards spanning adjacent tent apices
    for (let i = 0; i < numTents - 1; i++) {
      const bx = -(numTents - 1) * S / 2 + (i + 0.5) * S
      cards.push(
        box("s" + k + "b" + i, { hx: bHx, hy: T, hz: W })
          .pos(bx, topY + T, 0).withColor(0xe74c3c).withFriction(0.8).withRestitution(0),
      )
    }

    // Crown on the top-story apex (replaces bridges on the final story)
    if (k === n - 1) {
      cards.push(
        box("crown", { hx: bHx, hy: T, hz: W })
          .pos(0, topY + T, 0).withColor(0xe74c3c).withFriction(0.8).withRestitution(0),
      )
    }

    supportY = topY + 2 * T  // bridge top surface becomes next story's floor
  }

  return rows([
    box("floor", { hx: 4, hy: 0.2, hz: 4 }).pos(0, -1.2, 0).withColor(0x1a2e1a).static(),
    sphere("ball", { r: 0.12 }).pos(0.05, 2.0, 0).withColor(0xf39c12).withRestitution(0.2),
    ...cards,
  ])
})

// 2. Bake a JoltPhysics simulation: 360 frames = 6 s at 60 fps. simulate()
//    appends a per-frame "update" row for every moving body and a "collision"
//    row whenever two bodies first touch. The ball hits the crown at ~0.5 s;
//    the full cascade settles over the next few seconds.
//    Tagged "events" so these rows auto-merge with the effects view below.
define("sim", "events", (rand, table) =>
  physics(table("base")).simulate({ steps: 360, gravity: -9.81 })
)

// 3. Bake the sparse "events" stream into a dense per-frame cache for playback.
define("scene", (rand, table) => table("events").rasterize(6))

// 4. Post-processing: bloom flares on each floor collision, afterimage trails
//    on tumbling cards. Reads "sim" directly (not "events") to avoid a cycle —
//    sim is a sibling group member, not the already-merged events table.
define("effects", "events", (rand, table) =>
  rows([
    addEffect("bloom", "bloom", { strength: 0.7, radius: 0.4, threshold: 0.5 }),
    addEffect("trails", "afterimage", { damp: 0.88 }).withInput("bloom"),
  ]).concat(
    // Declarative, diffable form: filter(Expr) + emit(builders). Values are Expr
    // nodes (field("index").add(0.05)) so the engine can hash this view and reuse
    // it — editing here never re-bakes the physics in "sim". Row builders drop
    // straight into emit()/map() templates just like plain objects.
    table("sim")
      .filter(field("type").eq("collision").and(field("other").eq("floor")))
      .emit([
        updateEffect("bloom", { strength: 2.6 }).at(field("index")).withDur(0.05),
        updateEffect("bloom", { strength: 0.8 }).at(field("index").add(0.05)).withDur(0.5).withEase(easeOut),
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
      // Livecoding speed tuning: pop completions almost immediately while
      // typing (basicSetup's autocompletion() already ran; this partial
      // config merges in), and accept the selected one on Tab as well as
      // Enter — handing off to a snippet's own tab-stops when the picked
      // completion is one (see docOption's use of snippetCompletion above).
      autocompletion({ activateOnTypingDelay: 30 }),
      Prec.highest(keymap.of([{ key: 'Tab', run: acceptCompletion }])),
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
