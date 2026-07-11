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
import { compilePattern, cranePattern, fanPattern, type PatternSpec } from './origami.js'
import type { ColumnType } from './editable-tables.js'

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

// Per-frame evaluation context. `midi` samples the streaming MIDI table at the
// playhead's current source frame (supplied by playback at apply time).
export interface EvalCtx {
  midi?: (note: string, channel: number | null) => number
}

// True if a node reads from a streaming source (MIDI) and so cannot be resolved
// at bake time — it must be carried as a binding and evaluated per frame.
export function isStreamingNode(n: ExprNode): boolean {
  switch (n.k) {
    case 'midi': return true
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

function fnv1a(s: string): number {
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
  editableRows?(name: string, schema: Record<string, ColumnType>, seedRows?: Row[]): Row[]
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
// A sheet of paper plus creases, each in a named GROUP with a target fold
// angle (degrees; + valley toward the viewer, − mountain). spawn() emits the
// scene's create row (shape: "origami", with the compiled pattern riding along
// as data); fold state is just numeric fields named after the groups —
// 0 = flat, 1 = fully folded — so a fold schedule is ordinary update keyframes
// and the baker interpolates them like any transform. sequence() is sugar that
// turns sparse steps { fold, at, dur, to, ease } into those keyframes,
// handling overlapping folds by baking every group's envelope value at every
// breakpoint.

interface FoldStep {
  group: string
  t0: number
  t1: number
  to: number
  ease: ((t: number) => number) | null
  start: number
}

export class OrigamiBuilder {
  private _spec: PatternSpec
  private _ctx: DSLContext | null
  private _id: unknown = 'paper'

  constructor(spec: PatternSpec, ctx: DSLContext | null) {
    this._spec = spec
    this._ctx = ctx
  }

  // Add one crease line (clipped to the sheet; crossings with other creases
  // are split automatically). Returns a new builder, so chains don't mutate.
  crease(x1: number, y1: number, x2: number, y2: number, group = 'fold', angle = 180): OrigamiBuilder {
    const next = new OrigamiBuilder(
      { ...this._spec, creases: [...this._spec.creases, { x1, y1, x2, y2, group, angle }] },
      this._ctx,
    )
    next._id = this._id
    return next
  }

  groups(): string[] {
    return compilePattern(this._spec).groups
  }

  // The create row: compiled pattern + all fold groups at 0 (flat sheet).
  // Extra props (id, color, px/py/pz, rx/ry/rz, beat, …) merge over defaults.
  spawn(props: Row = {}): Table {
    const pattern = compilePattern(this._spec)
    this._id = props.id ?? this._id
    const zeros: Row = {}
    for (const g of pattern.groups) zeros[g] = 0
    return new Table([{
      id: this._id, type: 'create', beat: 1, shape: 'origami',
      px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, color: 0xd94f2a,
      ...zeros, pattern, ...props,
    }], this._ctx)
  }

  // Fold schedule → update keyframes. Steps: { fold, at, dur?, to?, ease? }
  // (aliases: group/beat; dur defaults to 1 beat, to defaults to 1 = fully
  // folded; ease is an easing fn or its name, e.g. "easeInOut"). Steps may
  // overlap freely — each keyframe carries every scheduled group's value.
  sequence(steps: Table | Row[], opts: { id?: unknown } = {}): Table {
    const id = opts.id ?? this._id
    const rows = steps instanceof Table ? steps.rows : steps ?? []
    const norm: FoldStep[] = rows
      .filter((r) => r && (r.fold ?? r.group) != null && (r.at ?? r.beat) != null)
      .map((r) => {
        const t0 = Number(r.at ?? r.beat)
        const dur = r.dur != null ? Math.max(Number(r.dur), 1 / FRAMES_PER_BEAT) : 1
        const easeRaw = r.ease
        const ease = typeof easeRaw === 'function'
          ? easeRaw as (t: number) => number
          : typeof easeRaw === 'string' && easeRaw in EASINGS
            ? EASINGS[easeRaw as keyof Easings]
            : null
        return {
          group: String(r.fold ?? r.group), t0, t1: t0 + dur,
          to: r.to != null ? Number(r.to) : 1, ease, start: 0,
        }
      })
      .sort((a, b) => a.t0 - b.t0)

    // Each step ramps from wherever its group's envelope sits at its start.
    const byGroup = new Map<string, FoldStep[]>()
    for (const s of norm) {
      if (!byGroup.has(s.group)) byGroup.set(s.group, [])
      byGroup.get(s.group)!.push(s)
    }
    const evalStep = (s: FoldStep, t: number): number => {
      const p = Math.min(1, Math.max(0, (t - s.t0) / (s.t1 - s.t0)))
      return s.start + (s.to - s.start) * (s.ease ? s.ease(p) : p)
    }
    for (const list of byGroup.values()) {
      for (let i = 0; i < list.length; i++) {
        list[i].start = i === 0 ? 0 : evalStep(list[i - 1], list[i].t0)
      }
    }
    const valueAt = (group: string, t: number): number => {
      const list = byGroup.get(group)!
      let v = 0
      for (const s of list) {
        if (t <= s.t0) break
        v = evalStep(s, t)
      }
      return v
    }

    // One keyframe per breakpoint, carrying every scheduled group. A segment
    // that exactly spans a single eased step inherits its ease.
    const times = [...new Set(norm.flatMap((s) => [s.t0, s.t1]))].sort((a, b) => a - b)
    const out: Row[] = times.map((t, i) => {
      const row: Row = { id, type: 'update', beat: t }
      for (const g of byGroup.keys()) row[g] = valueAt(g, t)
      const prev = i > 0 ? times[i - 1] : null
      if (prev !== null) {
        const eases = norm.filter((s) => s.ease && s.t0 === prev && s.t1 === t).map((s) => s.ease!)
        if (eases.length && eases.every((e) => e === eases[0])) row.ease = eases[0]
      }
      return row
    })
    return new Table(out, this._ctx)
  }
}

export interface OrigamiFactory {
  // A bare square sheet spanning [-size, size]² (default size 1) — add your
  // own creases with .crease().
  (opts?: { size?: number }): OrigamiBuilder
  // The traditional crane: fold "base" to 1 for the bird base, then stage
  // "neck", "tail", "head", and "wings".
  crane(): OrigamiBuilder
  // An accordion fan with one group per pleat ("fan0", "fan1", …), or pass
  // { group } to gang every pleat into one fold.
  fan(pleats?: number, opts?: { group?: string; angle?: number }): OrigamiBuilder
}

function makeOrigami(ctx: DSLContext | null): OrigamiFactory {
  const factory = ((opts: { size?: number } = {}) =>
    new OrigamiBuilder({ size: opts.size ?? 1, creases: [] }, ctx)) as OrigamiFactory
  factory.crane = () => new OrigamiBuilder(cranePattern(), ctx)
  factory.fan = (pleats?: number, opts?: { group?: string; angle?: number }) =>
    new OrigamiBuilder(fanPattern(pleats, opts), ctx)
  return factory
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

// Average seconds between consecutive tap-beat presses (each row's `time` is
// an absolute UTC epoch ms, not time-since-first-tap), or null with fewer than
// two taps. The one place tempo()/beats() turn the taps table into a beat length.
function beatSecondsFromTaps(rows: Row[] | null | undefined): number | null {
  if (!rows || rows.length < 2) return null
  const first = rows[0].time as number
  const last = rows[rows.length - 1].time as number
  return (last - first) / (rows.length - 1) / 1000
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
  csv(text: string): Table
  data(url: string): Table
  json(data: Row[] | string | unknown): Table
  grid(cols: number, rowsN: number, opts?: { spacing?: number; y?: number }): Table
  physics(source: Table | Row[]): PhysicsBuilder
  // Folding paper: origami() is a bare sheet, origami.crane() /
  // origami.fan(n) are presets. Chain .crease(x1,y1,x2,y2, group, angle),
  // then .spawn({ id, color, ... }) for the create row and .sequence(steps)
  // for beat-timed fold keyframes.
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
  editable(name: string, schema: Record<string, ColumnType>, seedRows?: Row[]): Table
  field(name: string): Expr
  lit(v: number | string | boolean | null): Expr
  idx(): Expr
  midi(note: string, channel?: number | null): Expr
  taps(): Table
  tempo(fallback?: number): number
  beats(count: number, opts?: { fallback?: number; fit?: number }): Table
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
    origami: makeOrigami(ctx),
    editable: (name: string, schema: Record<string, ColumnType>, seedRows?: Row[]): Table => {
      const rows = (ctx?.editableRows?.(name, schema, seedRows) ?? []).map((r) => ({ ...r }))
      return new Table(rows, ctx).save(name)
    },
    field,
    lit,
    idx,
    midi,
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
  }
}
