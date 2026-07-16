// livecodata DSL
// ----------------------------------------------------------------------------
// A tiny, JavaScript-flavoured DSL for generating tables and using those tables
// to drive visuals. Tables are arrays of plain row objects. All timing uses
// **beats** — a row's `beat` column (1-indexed: beat 1 is the first frame) is
// where it sits on the loop, math().range(beats) samples over `beats` beats,
// rasterize(maxBeats) sets the animation length in beats, and retime()/shift()
// move a table along the beat axis. There are no seconds in the data model; the
// beats() timeline maps the tapped tempo onto this beat grid. Every builder
// returns a new Table, so everything chains.
//
// Deferred / diffable
// -------------------
// A Table is no longer an eagerly-computed array of rows: it is a *node* in a
// lazy op-graph — { op, spec, inputs, compute } — materialized on demand. Each
// node has a content hash (Merkle: op + spec + input hashes), so the engine can
// reuse a previously-materialized result when a view's whole subgraph is
// unchanged. That's what makes "only cook what's needed" possible: editing the
// effects view doesn't re-bake physics, because the physics node's hash is
// unchanged.
//
// For hashing to be *sound* the inputs must be data, not opaque closures. So the
// function-valued verbs (map(fn), filter(fn), …) have declarative, chainable
// Expr variants — field("beat").add(0.5), filter(field("type").eq("collision"))
// — three.js-node style. Function verbs still work but are hashed by their source
// text + the run seed (best-effort; a closure could capture changed outer scope).
// ----------------------------------------------------------------------------

import { rasterizeRows } from './rasterize.js'
import { withLineage, carry, unionLineage, getLineage, type Row } from './lineage.js'
import { FRAMES_PER_BEAT, DEFAULT_BEAT_SECONDS } from './constants.js'
import { compileFoldTable, foldValueAt, type FoldTableProgram } from './fold-engine.js'
import type { Schema } from './editable-tables.js'
import { beatSecondsFromTaps } from './tap-log.js'
import { primitiveGeometry, pointsFromGeometry, geometryFromPoints } from './three-points.js'
import type { BufferGeometry } from 'three'

// ── Expr: a small, serializable, chainable expression over a row ─────────────
// Each Expr wraps a plain-JSON `node` (no functions), so it serializes for
// hashing and evaluates against a row. Operands accept another Expr or a raw
// literal. Chain like three.js nodes: field("beat").add(0.5).

type BinOp = 'add' | 'sub' | 'mul' | 'div' | 'mod'
type CmpOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte'

export type ExprNode =
  | { k: 'field'; name: string }
  | { k: 'lit'; v: number | string | boolean | null }
  | { k: 'idx' }
  | { k: 'bin'; op: BinOp; a: ExprNode; b: ExprNode }
  | { k: 'cmp'; op: CmpOp; a: ExprNode; b: ExprNode }
  | { k: 'logic'; op: 'and' | 'or'; a: ExprNode; b: ExprNode }
  | { k: 'not'; a: ExprNode }
  | { k: 'cond'; t: ExprNode; a: ExprNode; b: ExprNode }
  // A live value pulled from the streaming MIDI table at the *current frame* —
  // the most recent event for `note` (optionally on `channel`) at-or-before the
  // playhead's source position. Not resolvable at bake time, so any expression
  // containing one is deferred into a per-row binding (see bakeExpr).
  | { k: 'midi'; note: string; channel: number | null }
  // A live value pulled from the on-screen slider `id` at the *current frame* —
  // the slider's recorded automation sampled at the playhead's source position
  // (its live position while the user is dragging it). Streaming exactly like
  // midi(), so it too defers into a per-frame binding.
  | { k: 'slider'; id: string }

type ExprInput = Expr | number | string | boolean | null

const toNode = (x: ExprInput): ExprNode =>
  x instanceof Expr ? x.node : { k: 'lit', v: x }

export class Expr {
  node: ExprNode
  constructor(node: ExprNode) {
    this.node = node
  }

  private bin(op: BinOp, o: ExprInput): Expr {
    return new Expr({ k: 'bin', op, a: this.node, b: toNode(o) })
  }
  add(o: ExprInput): Expr { return this.bin('add', o) }
  sub(o: ExprInput): Expr { return this.bin('sub', o) }
  mul(o: ExprInput): Expr { return this.bin('mul', o) }
  div(o: ExprInput): Expr { return this.bin('div', o) }
  mod(o: ExprInput): Expr { return this.bin('mod', o) }

  private cmp(op: CmpOp, o: ExprInput): Expr {
    return new Expr({ k: 'cmp', op, a: this.node, b: toNode(o) })
  }
  eq(o: ExprInput): Expr { return this.cmp('eq', o) }
  ne(o: ExprInput): Expr { return this.cmp('ne', o) }
  gt(o: ExprInput): Expr { return this.cmp('gt', o) }
  gte(o: ExprInput): Expr { return this.cmp('gte', o) }
  lt(o: ExprInput): Expr { return this.cmp('lt', o) }
  lte(o: ExprInput): Expr { return this.cmp('lte', o) }

  and(o: Expr): Expr { return new Expr({ k: 'logic', op: 'and', a: this.node, b: o.node }) }
  or(o: Expr): Expr { return new Expr({ k: 'logic', op: 'or', a: this.node, b: o.node }) }
  not(): Expr { return new Expr({ k: 'not', a: this.node }) }

  // Ternary: this ? then : otherwise — for picking a value declaratively.
  cond(then: ExprInput, otherwise: ExprInput): Expr {
    return new Expr({ k: 'cond', t: this.node, a: toNode(then), b: toNode(otherwise) })
  }

  // Stable JSON form (used by the canonical serializer for hashing).
  toJSON(): { $expr: ExprNode } {
    return { $expr: this.node }
  }
}

export const field = (name: string): Expr => new Expr({ k: 'field', name })
export const lit = (v: number | string | boolean | null): Expr => new Expr({ k: 'lit', v })
export const idx = (): Expr => new Expr({ k: 'idx' })
// A live MIDI value, e.g. midi("c4"). Usable anywhere an Expr is — setField,
// map(template), derive — and chainable: midi("c4").mul(2).
export const midi = (note: string, channel: number | null = null): Expr =>
  new Expr({ k: 'midi', note: String(note).toLowerCase(), channel })

// A live slider value, e.g. slider("brightness"). Same shape as midi(): usable
// anywhere an Expr is and chainable — slider("brightness").mul(2).
export const slider = (id: string): Expr =>
  new Expr({ k: 'slider', id: String(id) })

// Per-frame evaluation context. `midi` samples the streaming MIDI table and
// `slider` the streaming slider table, both at the playhead's current source
// frame (supplied by playback at apply time). `sliders` returns every defined
// slider's current value keyed by id — handed to hydra sketches as props.sliders.
export interface EvalCtx {
  midi?: (note: string, channel: number | null) => number
  slider?: (id: string) => number
  sliders?: () => Record<string, number>
}

// True if a node reads from a streaming source (MIDI) and so cannot be resolved
// at bake time — it must be carried as a binding and evaluated per frame.
export function isStreamingNode(n: ExprNode): boolean {
  switch (n.k) {
    case 'midi': case 'slider': return true
    case 'field': case 'lit': case 'idx': return false
    case 'not': return isStreamingNode(n.a)
    case 'bin': case 'cmp': case 'logic': return isStreamingNode(n.a) || isStreamingNode(n.b)
    case 'cond': return isStreamingNode(n.t) || isStreamingNode(n.a) || isStreamingNode(n.b)
  }
}

export function evalExpr(n: ExprNode, row: Row, i: number, ctx?: EvalCtx): unknown {
  switch (n.k) {
    case 'field': return row[n.name]
    case 'lit': return n.v
    case 'idx': return i
    case 'midi': return ctx?.midi ? ctx.midi(n.note, n.channel) : 0
    case 'slider': return ctx?.slider ? ctx.slider(n.id) : 0
    case 'bin': {
      const a = evalExpr(n.a, row, i, ctx) as number
      const b = evalExpr(n.b, row, i, ctx) as number
      switch (n.op) {
        case 'add': return a + b
        case 'sub': return a - b
        case 'mul': return a * b
        case 'div': return a / b
        case 'mod': return a % b
      }
    }
    // eslint-disable-next-line no-fallthrough
    case 'cmp': {
      const a = evalExpr(n.a, row, i, ctx) as number
      const b = evalExpr(n.b, row, i, ctx) as number
      switch (n.op) {
        case 'eq': return a === b
        case 'ne': return a !== b
        case 'gt': return a > b
        case 'gte': return a >= b
        case 'lt': return a < b
        case 'lte': return a <= b
      }
    }
    // eslint-disable-next-line no-fallthrough
    case 'logic': {
      const a = evalExpr(n.a, row, i, ctx)
      return n.op === 'and' ? (a && evalExpr(n.b, row, i, ctx)) : (a || evalExpr(n.b, row, i, ctx))
    }
    case 'not': return !evalExpr(n.a, row, i, ctx)
    case 'cond': return evalExpr(n.t, row, i, ctx) ? evalExpr(n.a, row, i, ctx) : evalExpr(n.b, row, i, ctx)
  }
}

// ── Streaming bindings ───────────────────────────────────────────────────────
// A binding is a plain, serializable marker { $expr: node } left in a row in
// place of a value that can't be computed until a frame is shown (it reads MIDI).
// rasterize/effects carry bindings through unchanged; playback resolves them per
// frame against the live MIDI table (resolveBindings, with an EvalCtx).

export interface Binding {
  $expr: ExprNode
}

export const isBinding = (v: unknown): v is Binding =>
  v !== null && typeof v === 'object' && '$expr' in (v as Record<string, unknown>)

// Bake-time evaluation of an Expr: streaming expressions defer to a binding
// (resolved later, per frame); everything else evaluates to a concrete value now.
function bakeExpr(node: ExprNode, row: Row, i: number): unknown {
  return isStreamingNode(node) ? { $expr: node } : evalExpr(node, row, i)
}

// Replace any { $expr } bindings in a row with their per-frame values, using the
// (already-baked) row's own fields plus the streaming ctx. Returns the same row
// object when there's nothing to resolve.
export function resolveBindings(row: Row, ctx: EvalCtx): Row {
  let out: Row | null = null
  for (const k in row) {
    const v = row[k]
    if (isBinding(v)) {
      if (!out) out = { ...row }
      out[k] = evalExpr(v.$expr, row, 0, ctx)
    }
  }
  return out ?? row
}

// A row template: a plain object whose values are Expr (evaluated per row),
// nested templates, arrays, or plain literals (including functions like easings,
// which pass through untouched).
export type Template = Record<string, unknown>

function buildValue(v: unknown, row: Row, i: number): unknown {
  if (v instanceof Expr) return bakeExpr(v.node, row, i)
  if (Array.isArray(v)) return v.map((x) => buildValue(x, row, i))
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>)) {
      out[k] = buildValue((v as Record<string, unknown>)[k], row, i)
    }
    return out
  }
  return v
}

const buildRow = (tmpl: Template, row: Row, i: number): Row => buildValue(tmpl, row, i) as Row

// Does this spec contain any function value? Function-bearing ops are seed-
// sensitive (a closure might call rand), so their hash includes the run seed.
function hasFn(v: unknown): boolean {
  if (typeof v === 'function') return true
  if (v instanceof Expr) return false
  if (Array.isArray(v)) return v.some(hasFn)
  if (v !== null && typeof v === 'object') return Object.values(v as Record<string, unknown>).some(hasFn)
  return false
}

// ── Canonical serialization + hashing (for the Merkle dataflow) ──────────────

function stableStringify(v: unknown): string {
  if (v === null) return 'null'
  if (v === undefined) return 'undef'
  const t = typeof v
  if (t === 'number' || t === 'boolean') return String(v)
  if (t === 'string') return JSON.stringify(v)
  if (t === 'function') return 'fn:' + (v as () => unknown).toString()
  if (v instanceof Expr) return 'expr:' + stableStringify(v.node)
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']'
  const o = v as Record<string, unknown>
  const keys = Object.keys(o).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(o[k])).join(',') + '}'
}

// FNV-1a string hash — also the runtime's per-view PRNG seed hash, so keep it
// exported rather than re-implemented per module.
export function fnv1a(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

// Content hash of a Table node: op + canonical spec (+ run seed for seed-
// sensitive nodes) + the hashes of its inputs. Memoized per instance.
export function hashOf(t: Table): number {
  if (t._hash !== null) return t._hash
  const node = t._node
  const childHashes = node.inputs.map(hashOf)
  const seedPart = node.seedSensitive ? '#' + String(t._ctx?.seed ?? 0) : ''
  const canon = node.op + '|' + stableStringify(node.spec) + seedPart + '|' + childHashes.join(',')
  return (t._hash = fnv1a(canon))
}

// ── Materialization ──────────────────────────────────────────────────────────

export interface MatCtx {
  physics?: () => PhysicsEngine | null
}

export interface Memo {
  get(h: number): Row[] | undefined
  set(h: number, rows: Row[]): void
}

// Compute (and cache) a node's rows. With a `memo`, reuse a previous run's rows
// when the content hash matches — the heart of incremental cooking.
export function materialize(t: Table, ctx: MatCtx, memo?: Memo): Row[] {
  if (t._rows) return t._rows
  let h: number | null = null
  if (memo) {
    h = hashOf(t)
    const hit = memo.get(h)
    if (hit) {
      t._rows = hit
      return hit
    }
  }
  const inputs = t._node.inputs.map((inp) => materialize(inp, ctx, memo))
  const rows = t._node.compute(inputs, ctx)
  t._rows = rows
  if (memo && h !== null) memo.set(h, rows)
  return rows
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GraphSpec {
  table?: Table
  columns: string[]
  viewName?: string | null
  name?: string
}

export interface PhysicsEngine {
  simulate(baseRows: Row[], opts?: SimulateOptions): Row[]
}

export interface SimulateOptions {
  steps?: number
  gravity?: number
  fps?: number
  sampleEvery?: number
  collisions?: boolean
}

// retime({ offset, scale }): shift a table's rows by `offset` beats and stretch
// their spacing about the loop start (beat 1) by `scale`.
export interface RetimeSpec {
  offset?: number
  scale?: number
}

// Options shared by the .three.* scene animators. `amount` is how far to go
// (radians for rotate, world units for move, a multiplier for scale); `dur` how
// many beats the move takes; `axis` picks x/y/z (rotate/move); `ease` shapes the
// segment arriving at the target; `at` overrides the start beat (default: each
// create row's own beat).
export interface ThreeAnimOpts {
  amount?: number
  dur?: number
  axis?: 'x' | 'y' | 'z'
  ease?: (t: number) => number
  at?: number
}

// The .three accessor on a scene table: transform animations that read the
// table's `create` rows and append the update keyframes carrying each object's
// transform. Every method returns a Table (the base rows plus the new
// keyframes), so they chain — box().three.rotate().three.scale().rasterize(8).
export interface ThreeChain {
  // Spin each object by `amount` radians about `axis` (default a full turn about
  // y) over `dur` beats — adds to the object's current rotation.
  rotate(opts?: ThreeAnimOpts): Table
  // Grow/shrink each object by the `amount` factor (default 2×) over `dur` beats
  // — multiplies the object's current scale uniformly on all axes (sx/sy/sz).
  scale(opts?: ThreeAnimOpts): Table
  // Slide each object by `amount` along `axis` (default 1 unit along x) over
  // `dur` beats — adds to the object's current position.
  move(opts?: ThreeAnimOpts): Table
}

const TAU = Math.PI * 2
const numOr = (v: unknown, d: number): number => (typeof v === 'number' ? v : d)

export interface DSLContext {
  defineLazy(name: string, fn: ViewFn, group?: string): void
  defineConst(name: string, table: Table): void
  addGraph(spec: GraphSpec): void
  resolve(name: string): Table
  physics?: () => PhysicsEngine | null
  // The tap-beat table rows (wall-time button presses), or null. The tempo source
  // for tempo()/beats().
  tapRows?: () => Row[] | null
  // The run seed, set by the runtime; folded into seed-sensitive node hashes.
  seed?: number
  // Synchronous lookup for pre-fetched data() URLs.
  getData?(url: string): string
  // User-editable table storage: returns the live rows for a table with this
  // column schema, creating it (seeded with `seedRows`, as create events) or
  // reconciling its columns on first use.
  editableRows?(name: string, schema: Schema, seedRows?: Row[]): Row[]
}

export type ViewFn = (rand: () => number, table: (name: string) => Table) => Table | Row[]

type JoinOn = string | { left: string; right: string } | ((r: Row) => unknown)

type DeriveSpec = Record<string, unknown | ((r: Row, i: number) => unknown)>

interface GroupResult {
  agg(spec: Record<string, (rows: Row[]) => unknown>): Table
  count(as?: string): Table
}

interface TNode {
  op: string
  spec: unknown
  inputs: Table[]
  compute: (inputs: Row[][], ctx: MatCtx) => Row[]
  seedSensitive: boolean
}

// ── Row helpers ──────────────────────────────────────────────────────────────

const tag = (row: Row, refs: ReturnType<typeof carry>): Row => withLineage({ ...row }, refs)
const recarry = (row: Row): Row => tag(row, carry(row))
const spread = (res: Row | Row[] | null | undefined, refs: ReturnType<typeof carry>): Row[] =>
  res == null ? [] : (Array.isArray(res) ? res : [res]).map((e) => tag(e, refs))
const rowsOf = (x: Table | Row[] | null | undefined): Row[] =>
  x instanceof Table ? x.rows : x ?? []

export class Table {
  name: string | null
  _ctx: DSLContext | null
  _node: TNode
  _rows: Row[] | null
  _hash: number | null

  constructor(rows: Row[] = [], ctx: DSLContext | null = null) {
    this._ctx = ctx
    this.name = null
    this._rows = null
    this._hash = null
    // A literal-rows leaf: its hash is by value (so e.g. rand-derived math rows
    // are naturally seed-sensitive without any flag).
    this._node = { op: 'rows', spec: rows, inputs: [], seedSensitive: false, compute: () => rows }
  }

  static _fromNode(ctx: DSLContext | null, node: TNode): Table {
    const t = Object.create(Table.prototype) as Table
    t._ctx = ctx
    t.name = null
    t._rows = null
    t._hash = null
    t._node = node
    return t
  }

  private _xf(
    op: string,
    spec: unknown,
    compute: (inputs: Row[][], ctx: MatCtx) => Row[],
    seedSensitive = false,
    others: Table[] = [],
  ): Table {
    return Table._fromNode(this._ctx, { op, spec, inputs: [this, ...others], compute, seedSensitive })
  }

  private _other(x: Table | Row[] | null | undefined): Table {
    return x instanceof Table ? x : new Table(x ?? [], this._ctx)
  }

  get rows(): Row[] {
    return materialize(this, { physics: this._ctx?.physics })
  }

  get length(): number {
    return this.rows.length
  }

  get columns(): string[] {
    const seen: string[] = []
    const set = new Set<string>()
    for (const row of this.rows) {
      for (const k of Object.keys(row)) {
        if (!set.has(k)) {
          set.add(k)
          seen.push(k)
        }
      }
    }
    return seen
  }

  // map(fn) transforms each row; map(template) builds each row declaratively from
  // Expr/literals (diffable). Both carry the source row's lineage.
  map(fn: (r: Row, i: number) => Row): Table
  map(template: Template): Table
  map(arg: ((r: Row, i: number) => Row) | Template): Table {
    if (typeof arg === 'function') {
      const fn = arg
      return this._xf('map', { fn }, (ins) => ins[0].map((r, i) => tag(fn(r, i), carry(r))), true)
    }
    const tmpl = arg
    return this._xf('mapT', { tmpl }, (ins) => ins[0].map((r, i) => tag(buildRow(tmpl, r, i), carry(r))), false)
  }

  // filter(fn) or filter(Expr predicate).
  filter(pred: ((r: Row, i: number) => unknown) | Expr): Table {
    if (pred instanceof Expr) {
      const node = pred.node
      return this._xf('filterE', { pred }, (ins) => ins[0].filter((r, i) => evalExpr(node, r, i)).map(recarry), false)
    }
    const fn = pred
    return this._xf('filter', { fn }, (ins) => ins[0].filter((r, i) => fn(r, i)).map(recarry), true)
  }

  filterMap(fn: (r: Row, i: number, rows: Row[]) => Row | Row[] | null | undefined): Table {
    return this._xf('filterMap', { fn }, (ins) => ins[0].flatMap((r, i) => spread(fn(r, i, ins[0]), carry(r))), true)
  }

  // flatMap(fn) — fan out each row into zero, one, or many rows. Alias of
  // filterMap with a name that matches the fan-out use case (Array.flatMap).
  flatMap(fn: (r: Row, i: number, rows: Row[]) => Row | Row[] | null | undefined): Table {
    return this._xf('flatMap', { fn }, (ins) => ins[0].flatMap((r, i) => spread(fn(r, i, ins[0]), carry(r))), true)
  }

  // emit(template | template[]) — declarative flatMap: produce one or many rows
  // per source row from Expr/literal templates. The diffable counterpart of
  // filterMap (pair with filter() for "when X, emit Y").
  emit(template: Template | Template[]): Table {
    return this._xf('emit', { template }, (ins) =>
      ins[0].flatMap((r, i) => {
        const built = Array.isArray(template)
          ? template.map((tt) => buildRow(tt, r, i))
          : buildRow(template, r, i)
        return spread(built, carry(r))
      }), false)
  }

  concat(other: Table | Row[] | null | undefined): Table {
    return this._xf('concat', {}, (ins) => [...ins[0], ...ins[1]].map(recarry), false, [this._other(other)])
  }

  slice(start: number, end?: number): Table {
    return this._xf('slice', { start, end }, (ins) => ins[0].slice(start, end).map(recarry), false)
  }

  fold<T>(fn: (acc: T, cur: Row, i: number, rows: Row[]) => T, initial: T): T {
    let acc = initial
    const rows = this.rows
    for (let i = 0; i < rows.length; i++) acc = fn(acc, rows[i], i, rows)
    return acc
  }

  scan<S>(
    fn: (state: S, cur: Row, i: number, rows: Row[]) => { state?: S; emit?: Row | Row[] | null | undefined } | null | undefined,
    initialState: S,
  ): Table {
    return this._xf('scan', { fn, initialState }, (ins) => {
      const out: Row[] = []
      let state = initialState
      ins[0].forEach((cur, i) => {
        const res = fn(state, cur, i, ins[0])
        if (res == null) return
        if ('state' in res && res.state !== undefined) state = res.state as S
        out.push(...spread(res.emit, carry(cur)))
      })
      return out
    }, true)
  }

  // mapAccum(fn, initialState) — like map(), but fn also threads extra state
  // between rows; the final state is discarded and only the emitted rows are
  // kept. Simpler sibling of scan(): fn always emits (no skipping) and
  // returns [emit, nextState] instead of an {state, emit} object.
  mapAccum<S>(
    fn: (state: S, cur: Row, i: number, rows: Row[]) => [Row | Row[], S],
    initialState: S,
  ): Table {
    return this._xf('mapAccum', { fn, initialState }, (ins) => {
      const out: Row[] = []
      let state = initialState
      ins[0].forEach((cur, i) => {
        const [emit, nextState] = fn(state, cur, i, ins[0])
        state = nextState
        out.push(...spread(emit, carry(cur)))
      })
      return out
    }, true)
  }

  join(other: Table | Row[], on: JoinOn): Table {
    const leftOf: (r: Row) => unknown = typeof on === 'function' ? on : (r) => r[typeof on === 'object' ? on.left : on]
    const rightOf: (r: Row) => unknown = typeof on === 'function' ? on : (r) => r[typeof on === 'object' ? on.right : on]
    return this._xf('join', { on }, (ins) => {
      const index = new Map<unknown, Row[]>()
      for (const r of ins[1]) {
        const k = rightOf(r)
        if (!index.has(k)) index.set(k, [])
        index.get(k)!.push(r)
      }
      const out: Row[] = []
      for (const l of ins[0]) {
        for (const r of index.get(leftOf(l)) ?? []) {
          out.push(withLineage({ ...l, ...r }, unionLineage([l, r])))
        }
      }
      return out
    }, typeof on === 'function', [this._other(other)])
  }

  zip(other: Table | Row[]): Table {
    return this._xf('zip', {}, (ins) => {
      const n = Math.min(ins[0].length, ins[1].length)
      const out: Row[] = []
      for (let i = 0; i < n; i++) {
        out.push(withLineage({ ...ins[0][i], ...ins[1][i] }, unionLineage([ins[0][i], ins[1][i]])))
      }
      return out
    }, false, [this._other(other)])
  }

  orderBy(key: string | ((r: Row) => unknown), dir: 'asc' | 'desc' = 'asc'): Table {
    const accessor = typeof key === 'function' ? key : (r: Row) => r[key]
    const sign = dir === 'desc' ? -1 : 1
    return this._xf('orderBy', { key, dir }, (ins) => {
      const sorted = [...ins[0]].sort((a, b) => {
        const av = accessor(a) as string | number, bv = accessor(b) as string | number
        return av < bv ? -sign : av > bv ? sign : 0
      })
      return sorted.map(recarry)
    }, typeof key === 'function')
  }

  // derive/assign: spec values are Expr (evaluated), functions (r,i)=>val, or
  // literals. Expr/literal-only specs are diffable; function specs are seed-aware.
  derive(spec: DeriveSpec): Table {
    return this._xf('derive', { spec }, (ins) => ins[0].map((r, i) => {
      const next: Row = { ...r }
      for (const k in spec) {
        const sv = spec[k]
        next[k] = sv instanceof Expr ? bakeExpr(sv.node, r, i)
          : typeof sv === 'function' ? (sv as (r: Row, i: number) => unknown)(r, i)
            : sv
      }
      return withLineage(next, carry(r))
    }), hasFn(spec))
  }

  assign(spec: DeriveSpec): Table { return this.derive(spec) }

  // Set one field on every row from an Expr (or a plain value). The headline use
  // is a live MIDI value: .setField("amount", midi("c4")) — a streaming Expr is
  // left as a per-frame binding, so the field follows the note as the loop
  // replays; a plain/constant Expr is baked in immediately. Sugar over derive.
  setField(name: string, value: Expr | unknown): Table {
    return this.derive({ [name]: value })
  }

  mapField(src: string, dst: string, fn: (val: unknown, row: Row, i: number) => unknown): Table {
    return this._xf('mapField', { src, dst, fn }, (ins) =>
      ins[0].map((r, i) => withLineage({ ...r, [dst]: fn(r[src], r, i) }, carry(r))), true)
  }

  rescale(src: string, [inLo, inHi]: [number, number], [outLo, outHi]: [number, number], dst: string = src): Table {
    const span = (inHi - inLo) || 1
    return this._xf('rescale', { src, inLo, inHi, outLo, outHi, dst }, (ins) =>
      ins[0].map((r) => {
        const f = ((r[src] as number) - inLo) / span
        return withLineage({ ...r, [dst]: outLo + f * (outHi - outLo) }, carry(r))
      }), false)
  }

  lag(fieldName: string, n: number = 1, as: string = `${fieldName}_lag`): Table {
    return this._xf('lag', { field: fieldName, n, as }, (ins) =>
      ins[0].map((r, i) => withLineage({ ...r, [as]: i >= n ? ins[0][i - n][fieldName] : null }, carry(r))), false)
  }

  groupBy(key: string | ((r: Row) => unknown)): GroupResult {
    const keyName = typeof key === 'function' ? 'key' : key
    const accessor = typeof key === 'function' ? key : (r: Row) => r[key]
    const self = this
    const build = (op: string, spec: unknown, aggregate: (groups: Map<unknown, Row[]>) => Row[]): Table =>
      self._xf(op, spec, (ins) => {
        const groups = new Map<unknown, Row[]>()
        for (const r of ins[0]) {
          const k = accessor(r)
          if (!groups.has(k)) groups.set(k, [])
          groups.get(k)!.push(r)
        }
        return aggregate(groups)
      }, true)
    return {
      agg(spec: Record<string, (rows: Row[]) => unknown>): Table {
        return build('groupBy.agg', { key, spec }, (groups) => {
          const out: Row[] = []
          for (const [k, rs] of groups) {
            const row: Row = { [keyName]: k }
            for (const f in spec) row[f] = spec[f](rs)
            out.push(withLineage(row, unionLineage(rs)))
          }
          return out
        })
      },
      count(as: string = 'count'): Table {
        return build('groupBy.count', { key, as }, (groups) => {
          const out: Row[] = []
          for (const [k, rs] of groups) {
            out.push(withLineage({ [keyName]: k, [as]: rs.length }, unionLineage(rs)))
          }
          return out
        })
      },
    }
  }

  trigger(
    predicate: (r: Row, i: number, rows: Row[]) => unknown,
    emit: (r: Row, i: number, rows: Row[]) => Row | Row[] | null | undefined,
  ): Table {
    return this._xf('trigger', { predicate, emit }, (ins) =>
      ins[0].flatMap((r, i) => predicate(r, i, ins[0]) ? spread(emit(r, i, ins[0]), carry(r)) : []), true)
  }

  triggerEach(
    predicate: (cur: Row, i: number, rows: Row[]) => unknown,
    objects: Table | Row[],
    make: (o: Row, cur: Row, i: number, k: number) => Row | Row[] | null | undefined,
  ): Table {
    return this._xf('triggerEach', { predicate, make }, (ins) =>
      ins[0].flatMap((cur, i) =>
        predicate(cur, i, ins[0])
          ? ins[1].flatMap((o, k) => spread(make(o, cur, i, k), unionLineage([cur, o])))
          : []), true, [this._other(objects)])
  }

  crossings(fieldName: string = 'value', level: number = 0): Table {
    return this._xf('crossings', { field: fieldName, level }, (ins) => {
      const out: Row[] = []
      for (let i = 1; i < ins[0].length; i++) {
        const prev = (ins[0][i - 1][fieldName] as number) - level
        const cur = (ins[0][i][fieldName] as number) - level
        if (prev !== 0 && prev * cur < 0) {
          out.push(withLineage({ ...ins[0][i], dir: cur > 0 ? 1 : -1 }, carry(ins[0][i])))
        }
      }
      return out
    }, false)
  }

  // Pairs up the rows where row[fieldName] === value, cyclically: match k is
  // "second" paired with match k-1 as "first" — so match 0 pairs with the
  // LAST match, wrapping the sequence into a cycle. For each pair, fn(first,
  // second) returns the row(s) that replace `second` in the output; rows that
  // don't match (and unpaired rows generally) pass through unchanged.
  pairBy(fieldName: string, value: unknown, fn: (first: Row, second: Row) => Row | Row[]): Table {
    return this._xf('pairBy', { field: fieldName, value, fn }, (ins) => {
      const rows = ins[0]
      const matchIdx: number[] = []
      rows.forEach((r, i) => { if (r[fieldName] === value) matchIdx.push(i) })
      if (!matchIdx.length) return rows.map(recarry)
      const replacement = new Map<number, Row[]>()
      matchIdx.forEach((idx, k) => {
        const prev = rows[matchIdx[(k - 1 + matchIdx.length) % matchIdx.length]]
        const cur = rows[idx]
        replacement.set(idx, spread(fn(prev, cur), unionLineage([prev, cur])))
      })
      return rows.flatMap((r, i) => replacement.get(i) ?? [recarry(r)])
    }, true)
  }

  rasterize(maxBeats?: number): Table {
    return this._xf('rasterize', { maxBeats }, (ins) => rasterizeRows(ins[0], maxBeats), false)
  }

  // Move a table along the beat axis. Declarative form retime({ offset, scale })
  // shifts every row's `beat` by `offset` beats and stretches the spacing about
  // the loop start (beat 1) by `scale` (durations scale too) — diffable/hashable,
  // the common case. Function form retime(beat => newBeat) remaps each row's beat
  // arbitrarily (a closure, so hashed by source text, like map(fn)). Rows without
  // a `beat` are left untouched. shift(beats) is sugar for retime({ offset }).
  retime(spec: RetimeSpec | ((beat: number) => number)): Table {
    if (typeof spec === 'function') {
      const fn = spec
      return this._xf('retimeFn', { fn }, (ins) => ins[0].map((r) => {
        if (typeof r.beat !== 'number') return recarry(r)
        return withLineage({ ...r, beat: fn(r.beat as number) }, carry(r))
      }), true)
    }
    const { offset = 0, scale = 1 } = spec
    return this._xf('retime', { offset, scale }, (ins) => ins[0].map((r) => {
      if (typeof r.beat !== 'number') return recarry(r)
      const next: Row = { ...r, beat: 1 + ((r.beat as number) - 1) * scale + offset }
      if (typeof r.dur === 'number') next.dur = (r.dur as number) * scale
      return withLineage(next, carry(r))
    }), false)
  }

  shift(beats: number): Table {
    return this.retime({ offset: beats })
  }

  // ── three: animate scene objects over time ──────────────────────────────────
  // Read this table's `create` rows and, for every object, append the update
  // keyframes that carry its transform from its current value to one `amount`
  // away over `dur` beats. rasterize eases every numeric field between the
  // keyframes that carry it, so each animator writes a START keyframe (the
  // object's current value) and an END keyframe `dur` beats later — rotate/move
  // ADD `amount`, scale MULTIPLIES. The base rows pass through unchanged, so the
  // result is renderable as-is and the animators chain:
  //   box({ id: "a" })
  //     .three.rotate({ amount: Math.PI, dur: 8 })
  //     .three.scale({ amount: 1.5, dur: 8, ease: easeInOut })
  //     .rasterize(8)
  get three(): ThreeChain {
    return {
      rotate: (opts: ThreeAnimOpts = {}): Table => {
        const { amount = TAU, axis = 'y' } = opts
        const f = `r${axis}`
        return this._threeAnim('three.rotate', opts, (c) => {
          const from = numOr(c[f], 0)
          return { start: { [f]: from }, end: { [f]: from + amount } }
        })
      },
      move: (opts: ThreeAnimOpts = {}): Table => {
        const { amount = 1, axis = 'x' } = opts
        const f = `p${axis}`
        return this._threeAnim('three.move', opts, (c) => {
          const from = numOr(c[f], 0)
          return { start: { [f]: from }, end: { [f]: from + amount } }
        })
      },
      scale: (opts: ThreeAnimOpts = {}): Table => {
        const { amount = 2 } = opts
        return this._threeAnim('three.scale', opts, (c) => {
          const sx = numOr(c.sx, 1), sy = numOr(c.sy, 1), sz = numOr(c.sz, 1)
          return { start: { sx, sy, sz }, end: { sx: sx * amount, sy: sy * amount, sz: sz * amount } }
        })
      },
    }
  }

  // Shared machinery for the .three.* animators: pass the base rows through, then
  // per create row append a start + end update keyframe `dur` beats apart, with
  // fields from `fieldsFor`. `opts` is the (serializable) hash spec; an `ease`
  // function makes the node seed-sensitive, exactly like map(fn).
  private _threeAnim(op: string, opts: ThreeAnimOpts, fieldsFor: (create: Row) => { start: Row; end: Row }): Table {
    const { dur = 4, at, ease } = opts
    return this._xf(op, opts, (ins) => {
      const out: Row[] = ins[0].map(recarry)
      for (const c of ins[0]) {
        if (c.type !== 'create') continue
        const startBeat = at ?? (typeof c.beat === 'number' ? (c.beat as number) : 1)
        const { start, end } = fieldsFor(c)
        out.push(tag({ id: c.id, type: 'update', beat: startBeat, ...start }, carry(c)))
        out.push(tag({ id: c.id, type: 'update', beat: startBeat + dur, ...end, ...(ease ? { ease } : {}) }, carry(c)))
      }
      return out
    }, hasFn(opts))
  }

  graph(...columns: (string | string[])[]): this {
    const cols = columns.flat().filter(Boolean) as string[]
    this._ctx?.addGraph({ table: this, columns: cols })
    return this
  }

  save(name: string): this {
    this.name = name
    this._ctx?.defineConst(name, this)
    return this
  }
}

class PhysicsBuilder {
  private _source: Table | Row[]
  private _ctx: DSLContext

  constructor(source: Table | Row[], ctx: DSLContext) {
    this._source = source
    this._ctx = ctx
  }

  simulate(opts: SimulateOptions = {}): Table {
    const src = this._source instanceof Table ? this._source : new Table(this._source ?? [], this._ctx)
    return Table._fromNode(this._ctx, {
      op: 'physics',
      spec: opts,
      inputs: [src],
      seedSensitive: false,
      compute: (ins, ctx): Row[] => {
        const engine = ctx.physics?.()
        if (!engine) {
          throw new Error('physics engine still loading — press Run again in a moment')
        }
        return engine.simulate(ins[0], opts)
      },
    })
  }
}

// ── Origami ───────────────────────────────────────────────────────────────────
// A sheet of paper folded by a TABLE OF FOLD STEPS: every row is one fold.
// p1/p2 give the fold line as two points drawn on the CURRENT folded model
// (unit square [0,1]², the sheet before any fold); move gives sheet-space
// marker point(s) ("x,y", ";"-separated, coordinates on the UNFOLDED sheet)
// naming the flap(s) that swing; kind/pick choose among the valid layer
// orders when the fold is ambiguous (e.g. kind: "reverse" for an inside
// reverse fold); at/dur schedule the swing on the beat timeline. Each row
// is solved exactly: faces are cut along the line, the flaps reflect, and
// the layer order is computed — a row that cannot fold flat is an error
// naming the step, not a silently dead fold. Playback drives one numeric
// field, `fold`: k means the first k folds have landed, fractional values
// swing the next flap through 3D about its fold line.

export class OrigamiBuilder {
  private _size: number
  private _ctx: DSLContext | null
  private _id: unknown = 'paper'
  private _rows: Row[] = []
  private _compiled: FoldTableProgram | null = null

  constructor(size: number, ctx: DSLContext | null) {
    this._size = size
    this._ctx = ctx
  }

  // One table = the whole folding, one row per fold, applied in order.
  steps(steps: Table | Row[]): OrigamiBuilder {
    const next = new OrigamiBuilder(this._size, this._ctx)
    next._id = this._id
    next._rows = [...this._rows, ...(steps instanceof Table ? steps.rows : steps ?? [])]
    return next
  }

  program(): FoldTableProgram {
    if (!this._compiled) {
      this._compiled = compileFoldTable(this._rows, { size: this._size })
    }
    return this._compiled
  }

  // The create row: compiled program + fold at 0 (flat sheet). Extra props
  // (id, color, px/py/pz, rx/ry/rz, beat, …) merge over defaults.
  spawn(props: Row = {}): Table {
    const program = this.program()
    this._id = props.id ?? this._id
    // turn-overs rotate about the axis the VIEWER sees as vertical: the
    // scene rotates the whole object by rz, so undo it to find which
    // paper direction displays upright
    const rz = typeof props.rz === 'number' ? props.rz : 0
    program.flipAxis = [Math.sin(rz), Math.cos(rz)]
    return new Table([{
      id: this._id, type: 'create', beat: 1, shape: 'origami',
      px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, color: 0xd94f2a,
      fold: 0, program, ...props,
    }], this._ctx)
  }

  // Fold schedule → update keyframes driving `fold`. With no argument, uses
  // the at/dur timings from the steps() rows (at defaults to the row's
  // position, dur to 0.75 beats). Override with rows { step?, at, dur? } to
  // retime, or pass nothing and retime the table instead.
  sequence(steps?: Table | Row[] | null, opts: { id?: unknown } = {}): Table {
    const id = opts.id ?? this._id
    const program = this.program()
    let timed = program.steps.map((s) => ({ t0: s.t0, t1: s.t1, to: s.to, name: s.name }))
    const overrides = steps instanceof Table ? steps.rows : steps
    if (overrides) {
      const byName = new Map(timed.map((s) => [s.name, s]))
      overrides.forEach((r, i) => {
        const target = r.step != null ? byName.get(String(r.step)) : timed[i]
        if (!target) return
        const at = r.at ?? r.beat
        if (at != null) {
          const dur = r.dur != null ? Math.max(Number(r.dur), 1 / FRAMES_PER_BEAT) : target.t1 - target.t0
          target.t0 = Number(at)
          target.t1 = Number(at) + dur
        }
      })
      timed = [...timed].sort((a, b) => a.t0 - b.t0)
    }
    const out: Row[] = []
    timed.forEach((s, k) => {
      out.push({ id, type: 'update', beat: s.t0, fold: k })
      out.push({ id, type: 'update', beat: s.t1, fold: k + s.to })
    })
    return new Table(out, this._ctx)
  }

  // The fold value at a beat under the table's own schedule — handy in tests
  // and expressions.
  foldAt(beat: number): number {
    return foldValueAt(this.program(), beat)
  }
}

export interface OrigamiFactory {
  // A bare square sheet (unit square, displayed spanning [-size, size]²,
  // default size 1) — fold it with .steps(table).
  (opts?: { size?: number }): OrigamiBuilder
}

function makeOrigami(ctx: DSLContext | null): OrigamiFactory {
  return ((opts: { size?: number } = {}) =>
    new OrigamiBuilder(opts.size ?? 1, ctx)) as OrigamiFactory
}

class MathBuilder {
  private _fn: (t: number) => number
  private _ctx: DSLContext

  constructor(fn: (t: number) => number, ctx: DSLContext) {
    this._fn = fn
    this._ctx = ctx
  }

  // Sample over `beats` beats, one row per frame on the beat grid. `t` (the value
  // passed to the math fn) is elapsed beats — 0 at the first row. Eager (a
  // literal-rows leaf): the values — which may come from rand — are baked in, so
  // the leaf's hash is value-based and naturally seed-sensitive.
  range(beats: number): Table {
    const n = Math.max(1, Math.round(beats * FRAMES_PER_BEAT))
    const rows: Row[] = new Array(n)
    for (let i = 0; i < n; i++) {
      const t = i / FRAMES_PER_BEAT
      rows[i] = { beat: t + 1, value: this._fn(t) }
    }
    return new Table(rows, this._ctx)
  }
}

export const EASINGS = {
  linear: (t: number): number => t,
  easeIn: (t: number): number => t * t,
  easeOut: (t: number): number => 1 - (1 - t) * (1 - t),
  easeInOut: (t: number): number => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2),
} as const

export type Easings = typeof EASINGS

// ── Canonical table schemas ──────────────────────────────────────────────────
// The column schemas of the tables the runtime gives meaning to by name, so an
// editable version comes out with the right columns, enum dropdowns, and code
// languages without restating them: editable("hydra", schemas.hydra). Keys
// match the table names the runtime looks for. Frozen — a schema is a shared
// constant, not per-run state; spread one to extend it:
// editable("hydra", { ...schemas.hydra, layerName: "string" }).
export const SCHEMAS = deepFreeze({
  /**
   * The hydra view's event stream: one row per event, placed on the loop by
   * `beat` (1-indexed). `event` picks what it does — "setCode" (`code` = the
   * whole sketch), "setVariable" (`name`/`value` = a live input the sketch
   * reads as a props function), "setSource"/"append" (`code` = a new chain
   * head / a ".effect(…)" fragment), "replace" (swap substring `find` for
   * `value`), "layer" (`code` = another sketch composited via `mode`, amount
   * `value`), "transition" (`code` = a black-and-white mask that wipes to the
   * program after it over `value` beats). `out` names the hydra output the row
   * drives (o0 by default) and is appended as the terminal `.out(oN)`, so a
   * setCode's `code` needn't write its own; each output's events fold
   * independently. `event`, `mode`, and `out` are enums (dropdowns in the table
   * panel); `code` cells open in the editor with hydra completions; check
   * `disabled` to mute a row without deleting it.
   */
  hydra: {
    beat: 'number',
    event: ['setCode', 'setSource', 'append', 'replace', 'layer', 'transition', 'setVariable'],
    out: ['o0', 'o1', 'o2', 'o3'],
    code: { type: 'code', language: 'hydra' },
    find: 'string',
    name: 'string',
    value: 'number',
    mode: ['blend', 'add', 'mult', 'diff', 'layer', 'mask'],
    disabled: 'boolean',
  },
  /**
   * The "sliders" view: one on-screen control per row — `id` names it (and is
   * what slider(id) reads), `min`/`max` its range, `default` its initial
   * value. Check `disabled` to pull the control off screen without losing
   * its settings.
   */
  sliders: { id: 'string', min: 'number', max: 'number', default: 'number', disabled: 'boolean' },
  /**
   * Beat-timed positions: one keyframe per row — `beat` places it on the loop
   * (1-indexed), `px`/`py`/`pz` the position. The usual shape for an editable
   * motion path; check `disabled` to skip a keyframe.
   */
  path: { beat: 'number', px: 'number', py: 'number', pz: 'number', disabled: 'boolean' },
  /**
   * An origami fold table (see origami().steps()): one fold per row — `step`
   * a label, `p1`/`p2` two points "x,y" on the fold line, `move` the sheet
   * point(s) naming the flap(s) that swing, `kind`/`pick` choose among valid
   * layer orders ("simple", "reverse", "sink", …), `at`/`dur` the swing's
   * beat timing, `to` how far it lands (1 = flat). Check `disabled` to skip
   * a fold.
   */
  steps: {
    step: 'string', p1: 'string', p2: 'string', move: 'string',
    kind: 'string', pick: 'number', at: 'number', dur: 'number', to: 'number',
    disabled: 'boolean',
  },
} as const satisfies Record<string, Schema>)

export type Schemas = typeof SCHEMAS

// User programs are untyped JS, so `as const` alone can't stop a sketch from
// assigning into a shared schema and quietly reshaping every later run's
// tables — freeze the whole tree.
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v)
    Object.freeze(value)
  }
  return value
}

// ── Scene primitives ───────────────────────────────────────────────────────
// Sugar for the verbose "create" row you'd otherwise hand-write for a 3D scene
// object. box()/sphere()/cylinder()/cone()/torus()/text() each return a Table
// holding one { type: "create", shape } row, defaulted to beat 1 at the origin
// with no rotation, so only the fields you care about need setting. `id`
// defaults to the shape name — give distinct ids for multiple objects. Being
// Tables, they chain and concat like everything else:
//   box({ id: "a", px: -1, color: 0x4a9eff })
//     .concat(sphere({ id: "b", px: 1, r: 0.4 }))
//     .rasterize(8)
// Size fields follow the row schema shared with the renderer/physics: box uses
// hx/hy/hz (half-extents), sphere/torus use r, cylinder/cone use r + h (half-
// height), text uses text + size. Sizes left unset fall back to the shape's
// defaults in the renderer. Any renderer field (color, rx/ry/rz, …) can be set
// via props.
function sceneObject(shape: string, props: Row, ctx: DSLContext | null): Table {
  return new Table([{
    id: shape, type: 'create', beat: 1, shape,
    px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0,
    ...props,
  }], ctx)
}

function parseCSV(text: string): Row[] {
  const lines = String(text).trim().split(/\r?\n/).filter((l) => l.length)
  if (!lines.length) return []
  const header = lines[0].split(',').map((h) => h.trim())
  return lines.slice(1).map((line) => {
    const cells = line.split(',')
    const row: Row = {}
    header.forEach((h, i) => {
      const raw = (cells[i] ?? '').trim()
      const num = Number(raw)
      row[h] = raw !== '' && !Number.isNaN(num) ? num : raw
    })
    return row
  })
}

export type DSLSurface = Easings & {
  define(name: string, fn: ViewFn): void
  define(name: string, group: string, fn: ViewFn): void
  table(name: string): Table
  math(fn: (t: number) => number): MathBuilder
  rows(arr: Row[] | null | undefined): Table
  // One row per entry in `values` (so the output length matches `values`),
  // cycling through `rows` as it goes: output row i is { ...rows[i %
  // rows.length], ...values[i] }. `rows` is the short array rotated through
  // (a repeating base/pattern); `values` is the longer array of overrides
  // merged on top.
  rotate(rows: Row[] | null | undefined, values: Row[] | null | undefined): Table
  csv(text: string): Table
  data(url: string): Table
  json(data: Row[] | string | unknown): Table
  grid(cols: number, rowsN: number, opts?: { spacing?: number; y?: number }): Table
  // Camera moves as beat-timed keyframes: one row per keyframe
  // { beat?, px, py, pz, tx, ty, tz, fov? }. The first becomes the scene's
  // camera create row, the rest updates — all id "camera", shape "camera" —
  // so it rides events → rasterize like any object and interpolates between
  // keyframes for free. px/py/pz place the eye, tx/ty/tz the look-at target
  // (default origin), fov the vertical field of view in degrees (lower = a
  // longer lens). Concat it into your events stream, then rasterize.
  camera(keyframes: Row[] | null | undefined): Table
  // Scene-primitive builders: each returns a Table with one create row for a
  // 3D object (beat 1, at the origin, no rotation), so only the fields you set
  // matter. `id` defaults to the shape name. Concat them into a scene and
  // rasterize. Sizes: box→hx/hy/hz, sphere/torus→r, cylinder/cone→r+h,
  // text→text+size; unset sizes use the renderer's shape defaults.
  box(props?: Row): Table
  sphere(props?: Row): Table
  cylinder(props?: Row): Table
  cone(props?: Row): Table
  torus(props?: Row): Table
  text(props?: Row): Table
  // The generic form behind box()/sphere()/… — build a create row for any
  // shape string, including future shapes without a named helper.
  object(shape: string, props?: Row): Table
  // A three.js primitive → a table of its points. Tessellates the shape (the
  // SAME geometry the renderer draws for box()/sphere()/…, sized by the same
  // hx/hy/hz | r | h fields) and returns one row per vertex: { i, px, py, pz,
  // nx, ny, nz } — position and surface normal in the shape's local space. Pass
  // `segments` to raise the tessellation for a denser cloud. The rows are plain
  // numbers, so they chain and transform like any table:
  //   points("sphere", { r: 1, segments: 48 }).map({ px: field("nx"), ... })
  points(shape: string, props?: Row): Table
  // A table of points → a three.js primitive: a BufferGeometry whose position
  // (and, when every row has nx/ny/nz, normal) attribute is read from the rows'
  // px/py/pz (nx/ny/nz). The inverse of points(): geometry(points("box")) round-
  // trips to an equivalent box geometry.
  geometry(points: Table | Row[]): BufferGeometry
  physics(source: Table | Row[]): PhysicsBuilder
  // Folding paper: origami() is a bare sheet. Chain .steps(table) to fold it
  // by instructions — each row a fold/reflection along a line through two
  // points on known edges — then .spawn({ id, color, ... }) for the create
  // row and .sequence() for beat-timed fold keyframes.
  origami: OrigamiFactory
  // A user-editable table: rows are entered/edited in the table panel (not
  // computed), keyed by `name` so edits persist across runs — stored as change
  // *events*, of which the visible table is the fold. `schema` declares the
  // column names + types (number → numeric input; code → opens in the main
  // editor); a column here tracks the schema exactly (added when declared,
  // gone when it isn't) unless the table panel has genuinely touched it (e.g.
  // "+ column", or a rename/retype), which claims it and makes it survive
  // regardless of what's declared on a later Run. `seedRows` populate the
  // table the first time it's created.
  editable(name: string, schema: Schema, seedRows?: Row[]): Table
  field(name: string): Expr
  lit(v: number | string | boolean | null): Expr
  idx(): Expr
  midi(note: string, channel?: number | null): Expr
  // A live on-screen slider value, e.g. slider("brightness"). Sliders are
  // declared by defining a view named "sliders" whose rows carry { id, min,
  // max } (plus an optional `default`); each shows as a labelled control over
  // the visual and records its automation the way MIDI does.
  slider(id: string): Expr
  taps(): Table
  tempo(fallback?: number): number
  beats(count: number, opts?: { fallback?: number; fit?: number }): Table
  /**
   * Canonical schemas for the tables the runtime knows by name — pass one to
   * editable() for the right columns, enum dropdowns, and code languages:
   * editable("hydra", schemas.hydra). Frozen; spread to extend:
   * editable("hydra", { ...schemas.hydra, extra: "string" }).
   */
  schemas: Schemas
}

export function createDSL(ctx: DSLContext | null): DSLSurface {
  return {
    define: (name: string, group: string | ViewFn, fn?: ViewFn) =>
      fn === undefined
        ? ctx!.defineLazy(name, group as ViewFn)
        : ctx!.defineLazy(name, fn, group as string),
    table: (name: string) => ctx!.resolve(name),
    math: (fn: (t: number) => number) => new MathBuilder(fn, ctx!),
    rows: (arr: Row[] | null | undefined) => new Table((arr ?? []).map((r) => ({ ...r })), ctx),
    rotate: (rows: Row[] | null | undefined, values: Row[] | null | undefined): Table => {
      const src = rows ?? []
      return new Table(
        (values ?? []).map((v, i) => (src.length ? { ...src[i % src.length], ...v } : { ...v })),
        ctx,
      )
    },
    csv: (text: string) => new Table(parseCSV(text), ctx),
    data: (url: string) => new Table(parseCSV(ctx?.getData?.(url) ?? ''), ctx),
    json: (data: Row[] | string | unknown) => new Table(
      (Array.isArray(data) ? data : typeof data === 'string' ? JSON.parse(data) as Row[] : []).map((r) => ({ ...r as Row })),
      ctx,
    ),
    grid: (cols: number, rowsN: number, { spacing = 0.7, y = 0 } = {}): Table => {
      const out: Row[] = []
      const total = Math.max(0, cols * rowsN)
      for (let i = 0; i < total; i++) {
        const c = i % cols
        const rr = Math.floor(i / cols)
        out.push({
          i, col: c, row: rr,
          px: (c - (cols - 1) / 2) * spacing, py: y, pz: (rr - (rowsN - 1) / 2) * spacing,
        })
      }
      return new Table(out, ctx)
    },
    physics: (source: Table | Row[]) => new PhysicsBuilder(source, ctx!),
    // Camera keyframes → the "camera" scene object's create + update events.
    // The first keyframe seeds a full default pose (eye at 0,0,5 looking at the
    // origin) so a partial first row is still well-defined; later keyframes need
    // only the fields they change.
    camera: (keyframes: Row[] | null | undefined): Table => new Table(
      (keyframes ?? []).map((k, i) => {
        const beat = typeof k.beat === 'number' ? k.beat : 1
        return i === 0
          ? { px: 0, py: 0, pz: 5, tx: 0, ty: 0, tz: 0, ...k, id: 'camera', shape: 'camera', type: 'create', beat }
          : { ...k, id: 'camera', shape: 'camera', type: 'update', beat }
      }),
      ctx,
    ),
    // Scene primitives — one create row apiece, defaulted to beat 1 at the
    // origin (see sceneObject). object() is the generic; the named helpers are
    // sugar so autocomplete surfaces the available shapes.
    object: (shape: string, props: Row = {}) => sceneObject(shape, props, ctx),
    // Primitive ⇄ points bridge (see three-points.ts). points() samples a
    // shape's vertices+normals into a table; geometry() rebuilds a three.js
    // primitive from such a table. `segments` (if a number) sets tessellation;
    // the remaining props size the shape (hx/hy/hz | r | h).
    points: (shape: string, props: Row = {}): Table => {
      const { segments, ...dims } = props
      const geo = primitiveGeometry(shape, dims, typeof segments === 'number' ? { segments } : {})
      const rows = pointsFromGeometry(geo)
      geo.dispose()
      return new Table(rows, ctx)
    },
    geometry: (points: Table | Row[]): BufferGeometry =>
      geometryFromPoints(points instanceof Table ? points.rows : points ?? []),
    box: (props: Row = {}) => sceneObject('box', props, ctx),
    sphere: (props: Row = {}) => sceneObject('sphere', props, ctx),
    cylinder: (props: Row = {}) => sceneObject('cylinder', props, ctx),
    cone: (props: Row = {}) => sceneObject('cone', props, ctx),
    torus: (props: Row = {}) => sceneObject('torus', props, ctx),
    text: (props: Row = {}) => sceneObject('text', props, ctx),
    origami: makeOrigami(ctx),
    editable: (name: string, schema: Schema, seedRows?: Row[]): Table => {
      const rows = (ctx?.editableRows?.(name, schema, seedRows) ?? []).map((r) => ({ ...r }))
      return new Table(rows, ctx).save(name)
    },
    field,
    lit,
    idx,
    midi,
    slider,
    // The tap-beat table: one row per wall-time button press ({ beat, time } —
    // ordinal + absolute UTC epoch ms). The source of truth for tempo.
    taps: () => new Table((ctx?.tapRows?.() ?? []).map((r) => ({ ...r })), ctx),
    // Seconds per beat derived from the tap-beat table (the average interval), or
    // `fallback` (default 0.5s = 120 BPM) until two taps are recorded. The
    // playhead already advances at this tempo automatically; tempo() is here for
    // programs that want the number.
    tempo: (fallback = DEFAULT_BEAT_SECONDS): number => beatSecondsFromTaps(ctx?.tapRows?.()) ?? fallback,
    // A timeline that loops every `count` playback beats. Tempo is automatic
    // (the playhead runs at the tapped tempo regardless), so this is purely a
    // RETIME: two keyframes mapping the count-beat loop onto a span of `source`
    // beats. Identity by default (content plays once per loop); pass { fit } in
    // source-beats to stretch a shorter/longer stretch of content across the
    // window — e.g. beats(16, { fit: 8 }) plays 8 beats of content at half speed.
    beats: (count: number, { fit }: { fit?: number } = {}): Table => {
      const spanBeats = fit != null ? fit : count
      return new Table([
        { beat: 1, source: 1 },
        { beat: count + 1, source: spanBeats + 1 },
      ], ctx)
    },
    ...EASINGS,
    schemas: SCHEMAS,
  }
}
