// livecodata DSL — chainable tables of plain row objects that drive visuals.
// All timing is in beats (1-indexed; no seconds in the data model). A Table is
// a node in a lazy op-graph, content-hashed (Merkle) so unchanged subgraphs
// reuse their previous rows; the declarative Expr verbs exist so specs stay
// data (soundly hashable) — function verbs hash by source text + run seed,
// best-effort.
//
// JSDoc in this file is deliberately verbose: gen-lang-env.js lifts the JSDoc
// on DSLSurface members (and the emitted .d.ts of Table & friends) into the
// editor's CodeMirror hover docs, so the livecoder — not this file's reader —
// is its audience. Use /** */ for anything the editor should show on hover.

import { rasterizeRows } from './rasterize.js'
import { withLineage, carry, unionLineage, getLineage, type Row } from './lineage.js'
import { FRAMES_PER_BEAT, DEFAULT_BEAT_SECONDS } from './constants.js'
import { compileFoldTable, foldValueAt, type FoldTableProgram } from './fold-engine.js'
import type { Schema } from './editable-tables.js'
import { beatSecondsFromTaps } from './tap-log.js'
import { primitiveGeometry, pointsFromGeometry, geometryFromPoints } from './three-points.js'
import type { BufferGeometry } from 'three'

// ── Expr: a serializable, chainable expression over a row ────────────────────
// Wraps a plain-JSON node (no functions) so it hashes soundly. Operands accept
// another Expr or a raw literal: field("beat").add(0.5).

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
  // midi/slider read a streaming source at the current frame, so they can't be
  // resolved at bake time — bakeExpr defers them into per-row bindings.
  | { k: 'midi'; note: string; channel: number | null }
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

  /** Ternary: this ? then : otherwise — for picking a value declaratively. */
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
export const midi = (note: string, channel: number | null = null): Expr =>
  new Expr({ k: 'midi', note: String(note).toLowerCase(), channel })

export const slider = (id: string): Expr =>
  new Expr({ k: 'slider', id: String(id) })

// Per-frame evaluation context, supplied by playback at apply time; samplers
// read the streaming tables at the playhead's current source frame.
export interface EvalCtx {
  midi?: (note: string, channel: number | null) => number
  slider?: (id: string) => number
  sliders?: () => Record<string, number>
}

// True if the node reads a streaming source and so must be carried as a
// binding and evaluated per frame rather than at bake time.
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
// A binding is a serializable { $expr } marker left in a row where the value
// reads a streaming source; rasterize/effects carry it through unchanged and
// playback resolves it per frame (resolveBindings).

export interface Binding {
  $expr: ExprNode
}

export const isBinding = (v: unknown): v is Binding =>
  v !== null && typeof v === 'object' && '$expr' in (v as Record<string, unknown>)

function bakeExpr(node: ExprNode, row: Row, i: number): unknown {
  return isStreamingNode(node) ? { $expr: node } : evalExpr(node, row, i)
}

// Returns the same row object when there's nothing to resolve.
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

/** A row template: values are Expr (evaluated per row), nested templates, arrays, or literals (functions like easings pass through untouched). */
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

// Function-bearing specs are seed-sensitive (a closure might call rand), so
// their node's hash must include the run seed.
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

// FNV-1a — exported because it's also the runtime's per-view PRNG seed hash.
export function fnv1a(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

// Content hash: op + canonical spec (+ run seed when seed-sensitive) + input
// hashes. Memoized per instance.
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

// With a `memo`, reuse a previous run's rows when the content hash matches —
// the heart of incremental cooking.
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

// Kept internal so the public ThreeChain methods can inline the option shape —
// hover on rotate/scale/move then shows exactly what can be passed.
interface ThreeAnimOpts {
  amount?: number
  dur?: number
  axis?: 'x' | 'y' | 'z'
  ease?: (t: number) => number
  at?: number
}

/**
 * The .three accessor on a scene table: animators that read the table's
 * `create` rows and append update keyframes carrying each object's transform.
 * Every method returns a Table (base rows plus keyframes), so they chain —
 * t.box().three.rotate().three.scale().rasterize(8).
 */
export interface ThreeChain {
  /** Spin each object by `amount` radians about `axis` (default a full turn about y) over `dur` beats — adds to the current rotation. `at` overrides the start beat; `ease` shapes the segment. */
  rotate(opts?: { amount?: number; dur?: number; axis?: 'x' | 'y' | 'z'; ease?: (t: number) => number; at?: number }): Table
  /** Grow/shrink each object by the `amount` factor (default 2×) over `dur` beats — multiplies the current scale uniformly (sx/sy/sz). */
  scale(opts?: { amount?: number; dur?: number; ease?: (t: number) => number; at?: number }): Table
  /** Slide each object by `amount` world units along `axis` (default 1 along x) over `dur` beats — adds to the current position. */
  move(opts?: { amount?: number; dur?: number; axis?: 'x' | 'y' | 'z'; ease?: (t: number) => number; at?: number }): Table
}

const TAU = Math.PI * 2
const numOr = (v: unknown, d: number): number => (typeof v === 'number' ? v : d)

// Per-field numeric tweaks for the three.* row modifiers: touch a field on
// every base (create/untyped) row, and on update keyframes only when they
// already carry it, so partial animation rows stay intact.
function modRow(r: Row, specs: [key: string, base: number, f: (v: number) => number][]): Row {
  const out: Row = { ...r }
  for (const [key, base, f] of specs) {
    if (key in r || r.type !== 'update') out[key] = f(numOr(r[key], base))
  }
  return out
}

export interface DSLContext {
  defineLazy(name: string, fn: ViewFn, group?: string): void
  defineConst(name: string, table: Table): void
  addGraph(spec: GraphSpec): void
  resolve(name: string): Table
  physics?: () => PhysicsEngine | null
  // The tap-beat rows — the tempo source for tempo()/beats().
  tapRows?: () => Row[] | null
  // The run seed; folded into seed-sensitive node hashes.
  seed?: number
  // Synchronous lookup for pre-fetched data() URLs.
  getData?(url: string): string
  // Live rows for a user-editable table, creating/reconciling it on first use.
  editableRows?(name: string, schema: Schema, seedRows?: Row[]): Row[]
}

export type ViewFn = (rand: () => number, table: (name: string) => Table) => Table | Row[]

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
    // A literal-rows leaf hashes by value, so rand-derived rows are naturally
    // seed-sensitive without any flag.
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

  /** map(fn) transforms each row; map(template) builds each row declaratively from Expr/literals (diffable). Both carry the source row's lineage. */
  map(fn: (r: Row, i: number) => Row): Table
  map(template: Record<string, unknown>): Table
  map(arg: ((r: Row, i: number) => Row) | Record<string, unknown>): Table {
    if (typeof arg === 'function') {
      const fn = arg
      return this._xf('map', { fn }, (ins) => ins[0].map((r, i) => tag(fn(r, i), carry(r))), true)
    }
    const tmpl = arg
    return this._xf('mapT', { tmpl }, (ins) => ins[0].map((r, i) => tag(buildRow(tmpl, r, i), carry(r))), false)
  }

  /**
   * Keep rows that match a { field: value, … } pattern (every field strictly
   * equal, multi-key = AND) or an Expr predicate — filter(field("v").gt(3)).
   * Both forms are data, so the result is diffable and cheap to re-cook.
   */
  filter(pred: Record<string, unknown> | Expr): Table {
    if (pred instanceof Expr) {
      const node = pred.node
      return this._xf('filterE', { pred }, (ins) => ins[0].filter((r, i) => evalExpr(node, r, i)).map(recarry), false)
    }
    if (typeof pred === 'function') {
      throw new Error('filter() takes a { field: value } pattern or an Expr (e.g. field("v").gt(3)), not a function')
    }
    const keys = Object.keys(pred)
    return this._xf('filterMatch', { match: pred }, (ins) =>
      ins[0].filter((r) => keys.every((k) => r[k] === pred[k])).map(recarry), false)
  }

  /** Fan out each row into zero, one, or many rows, like Array.flatMap. For a diffable version use filter(...).emit(template). */
  flatMap(fn: (r: Row, i: number, rows: Row[]) => Row | Row[] | null | undefined): Table {
    return this._xf('flatMap', { fn }, (ins) => ins[0].flatMap((r, i) => spread(fn(r, i, ins[0]), carry(r))), true)
  }

  /** Declarative flatMap: produce one or many rows per source row from Expr/literal templates. Pair with filter() for "when X, emit Y". */
  emit(template: Record<string, unknown> | Record<string, unknown>[]): Table {
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

  join(other: Table | Row[], on: string | { left: string; right: string } | ((r: Row) => unknown)): Table {
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

  /**
   * Add or overwrite fields on every row; each spec value is an Expr, a
   * function (r, i) => val, or a literal. A streaming Expr binds per frame —
   * derive({ py: slider("height") }) follows the slider as the loop replays —
   * while a constant Expr is baked in immediately.
   */
  derive(spec: Record<string, Expr | ((r: Row, i: number) => unknown) | unknown>): Table {
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

  groupBy(key: string | ((r: Row) => unknown)): { agg(spec: Record<string, (rows: Row[]) => unknown>): Table; count(as?: string): Table } {
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

  /**
   * Pair up the rows matching a { field: value, … } pattern, cyclically (match
   * 0 pairs with the LAST match); fn(first, second) returns the row(s) that
   * replace `second`. Non-matching rows pass through unchanged.
   */
  pairBy(match: Record<string, unknown>, fn: (first: Row, second: Row) => Row | Row[]): Table {
    const keys = Object.keys(match)
    return this._xf('pairBy', { match, fn }, (ins) => {
      const rows = ins[0]
      const matchIdx: number[] = []
      rows.forEach((r, i) => { if (keys.every((k) => r[k] === match[k])) matchIdx.push(i) })
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

  /**
   * Move a table along the beat axis: retime({ offset, scale }) shifts every
   * row's `beat` and stretches spacing about the loop start (durations scale
   * too); retime(beat => newBeat) remaps arbitrarily. Rows without a `beat`
   * are untouched. shift(beats) is sugar for retime({ offset }).
   */
  retime(spec: { offset?: number; scale?: number } | ((beat: number) => number)): Table {
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

  /** Animate this table's scene objects over time — see ThreeChain. */
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

  // Shared .three.* machinery: base rows pass through; per create row, append a
  // start + end update keyframe `dur` beats apart (rasterize eases between
  // them). An `ease` function makes the node seed-sensitive, like map(fn).
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

  simulate(opts: { steps?: number; gravity?: number; fps?: number; sampleEvery?: number; collisions?: boolean } = {}): Table {
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
// A sheet of paper folded by a table of fold steps (row fields: schemas.steps).
// Each row is solved exactly — a row that cannot fold flat is an error naming
// the step, not a silently dead fold. Playback drives one numeric field,
// `fold`: k means the first k folds have landed; fractional values swing the
// next flap through 3D about its fold line.

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

  /** Fold the sheet: one row per fold (see schemas.steps for the columns), applied in order. */
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

  /** The create row: compiled program + fold at 0 (flat sheet). Extra props (id, color, px/py/pz, …) merge over defaults. */
  spawn(props: Row = {}): Table {
    const program = this.program()
    this._id = props.id ?? this._id
    // Turn-overs rotate about the axis the VIEWER sees as vertical: the scene
    // rotates the whole object by rz, so undo it here.
    const rz = typeof props.rz === 'number' ? props.rz : 0
    program.flipAxis = [Math.sin(rz), Math.cos(rz)]
    return new Table([{
      id: this._id, type: 'create', beat: 1, shape: 'origami',
      px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, color: 0xd94f2a,
      fold: 0, program, ...props,
    }], this._ctx)
  }

  /**
   * Fold schedule → update keyframes driving `fold`. With no argument, uses
   * the at/dur timings from the steps() rows; override with rows
   * { step?, at, dur? } to retime.
   */
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

  /** The fold value at a beat under the table's own schedule. */
  foldAt(beat: number): number {
    return foldValueAt(this.program(), beat)
  }
}

export interface OrigamiFactory {
  /** A bare square sheet (displayed spanning [-size, size]², default size 1) — fold it with .steps(table). */
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

  /** Sample over `beats` beats, one row per frame; `t` passed to the fn is elapsed beats (0 at the first row). Eager, so rand-derived values hash by value. */
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

// Canonical schemas for the tables the runtime knows by name (surfaced to the
// editor as `schemas` — its JSDoc there carries the usage docs).
export const SCHEMAS = deepFreeze({
  /**
   * The hydra view's event stream: one row per event, placed on the loop by
   * `beat` (1-indexed; a beat past the loop's end — the "beats" control under
   * the scene — lands the event in a later pass of the loop, so beat 17 of a
   * 16-beat loop opens the second pass). `event` picks what it does — "setCode" (`code` = the
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
   * The bauble view's event stream: one row per event, placed on the loop by
   * `beat` (1-indexed; like hydra, a beat past the loop's end lands the event
   * in a later pass of the loop) — the same table-of-events format as hydra,
   * for 3D SDF sketches instead of 2D post-processing. `event` picks what it does —
   * "setCode" (`code` = the whole sketch, a Janet shape expression like
   * "(rotate (box 50) :y t)"), "setVariable" (`name`/`value` = a (def name
   * value) compiled ahead of the sketch; changing one recompiles the shader,
   * except the reserved camera-x/camera-y/camera-zoom names, which orbit the
   * camera as live uniforms) — plus the meta-programming events that rewrite
   * the accumulated code in place: "transform" (`code` = a form wrapped
   * around the shape, a standalone `_` marking the hole or the shape inserted
   * as first argument), "duplicate" (combine the shape with a copy of itself
   * run through `code`, via `mode` + smoothing `value`), "combine" (`code` =
   * another whole shape composited via `mode` — union/intersect/subtract take
   * `value` as the :r blend radius, morph as its blend amount), "replace"
   * (swap substring `find` for `value`), "slice" (cut the shape open: an
   * onion shell `value` thick minus `code` — or a half-space about `axis`),
   * "tile" (repeat on an infinite lattice — `value` spaces all axes, or a
   * string vec3 like "[80 120 80]"), "radial" (`value` copies in a circle
   * about `axis`), and "transition" (morph from the program so far to the
   * program after it over `value` beats, riding the playback clock — build
   * the destination with ordinary events at the same beat). The render shows
   * directly when no hydra sketch is live, and is hydra's s1 source either
   * way — composite it with src(s1). `code` cells open in the editor as
   * Janet (no JS completions); check `disabled` to mute a row without
   * deleting it.
   */
  bauble: {
    beat: 'number',
    event: ['setCode', 'transform', 'duplicate', 'combine', 'replace', 'slice', 'tile', 'radial', 'transition', 'setVariable'],
    code: { type: 'code', language: 'bauble' },
    find: 'string',
    name: 'string',
    value: 'number',
    mode: ['union', 'intersect', 'subtract', 'morph'],
    axis: ['x', 'y', 'z'],
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

// One default "create" row for a 3D scene object — the shared implementation
// behind box()/sphere()/… (usage docs live on the DSLSurface members).
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

/**
 * The three.js helper namespace, reachable as either `three` or the shorthand
 * `t`. Scene-primitive builders (box, sphere, …) each return a one-row Table
 * you concat into a scene and rasterize; the transform modifiers
 * (translate/scale/rotate) shift a scene table's create rows in place. The
 * JSDoc on each member IS the editor hover doc — write it for the livecoder.
 */
export interface ThreeNamespace {
  /** One "create" row for a box (beat 1, origin, id defaults to the shape name) — set only the fields you care about, then concat into a scene and rasterize. Size: hx/hy/hz half-extents. */
  box(props?: Row): Table
  /** One "create" row for a sphere (beat 1, origin, id defaults to the shape name). Size: r. */
  sphere(props?: Row): Table
  /** One "create" row for a cylinder (beat 1, origin, id defaults to the shape name). Size: r + h (half-height). */
  cylinder(props?: Row): Table
  /** One "create" row for a cone (beat 1, origin, id defaults to the shape name). Size: r + h (half-height). */
  cone(props?: Row): Table
  /** One "create" row for a torus (beat 1, origin, id defaults to the shape name). Size: r. */
  torus(props?: Row): Table
  /** One "create" row of extruded 3D text (beat 1, origin, id defaults to "text"). Fields: text + size (cap height per line). */
  text(props?: Row): Table
  /** The generic form behind box()/sphere()/… — a create row for any shape string, including shapes without a named helper. */
  object(shape: string, props?: Row): Table
  /**
   * A three.js primitive → a table of its points: one row per vertex
   * { i, px, py, pz, nx, ny, nz } (position + surface normal in local space),
   * tessellating the same geometry the renderer draws, sized by the same
   * hx/hy/hz | r | h fields. Pass `segments` for a denser cloud. Plain
   * numbers, so the rows chain like any table.
   */
  points(shape: string, props?: Row): Table
  /** A table of points → a BufferGeometry, reading position (and normal, when every row has nx/ny/nz) from px/py/pz (nx/ny/nz). The inverse of points(). */
  geometry(points: Table | Row[]): BufferGeometry
  /**
   * Camera moves as beat-timed keyframes: one row per keyframe
   * { beat?, px, py, pz, tx, ty, tz, fov? }. px/py/pz place the eye, tx/ty/tz
   * the look-at target (default origin), fov the vertical field of view in
   * degrees. The first row becomes the camera's create row, the rest updates,
   * so it rides events → rasterize and interpolates like any object — concat
   * it into your events stream, then rasterize.
   */
  camera(keyframes: Row[] | null | undefined): Table
  /**
   * Shift every scene object in `table` by (x, y, z) world units — adds to
   * px/py/pz on each create row (and any keyframe that already carries a
   * position). Chain it before .three animators or .rasterize().
   */
  translate(table: Table | Row[], x?: number, y?: number, z?: number): Table
  /**
   * Scale every scene object in `table` — multiplies its scale (sx/sy/sz,
   * default 1) by (x, y, z). Pass one number for a uniform scale
   * (t.scale(box(), 2)); omit y/z to reuse x on those axes.
   */
  scale(table: Table | Row[], x?: number, y?: number, z?: number): Table
  /**
   * Rotate every scene object in `table` by (x, y, z) radians — adds to
   * rx/ry/rz on each create row. For a spin over time use .three.rotate.
   */
  rotate(table: Table | Row[], x?: number, y?: number, z?: number): Table
}

// The globals a user program sees. JSDoc on these members IS the editor's
// hover documentation (gen-lang-env.js copies it onto the generated ambient
// globals), so it is deliberately fuller than the types alone — write it for
// the livecoder.
export type DSLSurface = Easings & {
  define(name: string, fn: ViewFn): void
  define(name: string, group: string, fn: ViewFn): void
  table(name: string): Table
  math(fn: (t: number) => number): MathBuilder
  rows(arr: Row[] | null | undefined): Table
  /**
   * One row per entry in `values`, cycling through `rows` as it goes: output
   * row i is { ...rows[i % rows.length], ...values[i] } — a short repeating
   * base pattern with a longer array of overrides merged on top.
   */
  rotate(rows: Row[] | null | undefined, values: Row[] | null | undefined): Table
  csv(text: string): Table
  data(url: string): Table
  json(data: Row[] | string | unknown): Table
  grid(cols: number, rowsN: number, opts?: { spacing?: number; y?: number }): Table
  /**
   * The three.js helpers, grouped: scene-primitive create rows (box, sphere,
   * cylinder, cone, torus, text, and the generic object), the points ⇄
   * geometry samplers, the camera keyframer, and the translate/scale/rotate
   * modifiers that shift a scene table's create rows. Call as three.box(…) —
   * or via the shorthand `t`: t.box(…).
   */
  three: ThreeNamespace
  /** Shorthand alias for `three`: t.box(…), t.translate(scene, 1, 0, 0), etc. */
  t: ThreeNamespace
  physics(source: Table | Row[]): PhysicsBuilder
  /**
   * Folding paper: origami() is a bare sheet. Chain .steps(table) to fold it
   * by instructions (one fold per row — see schemas.steps), then
   * .spawn({ id, color, … }) for the create row and .sequence() for beat-timed
   * fold keyframes.
   */
  origami: OrigamiFactory
  /**
   * A user-editable table: rows are entered/edited in the table panel (not
   * computed), keyed by `name` so edits persist across runs. `schema` declares
   * the column names + types (number → numeric input; code → opens in the main
   * editor); a column tracks the schema exactly unless the table panel has
   * genuinely touched it, which claims it for the user. `seedRows` populate
   * the table the first time it's created.
   */
  editable(name: string, schema: Schema, seedRows?: Row[]): Table
  field(name: string): Expr
  lit(v: number | string | boolean | null): Expr
  idx(): Expr
  /** A live MIDI value at the playhead, e.g. midi("c4") — usable anywhere an Expr is, and chainable: midi("c4").mul(2). */
  midi(note: string, channel?: number | null): Expr
  /**
   * A live on-screen slider value, e.g. slider("brightness"). Sliders are
   * declared by defining a view named "sliders" (rows { id, min, max,
   * default? }); each shows as a labelled control over the visual and records
   * its automation the way MIDI does.
   */
  slider(id: string): Expr
  /** The tap-beat table: one row per wall-time button press ({ beat, time }) — the source of truth for tempo. */
  taps(): Table
  /** Seconds per beat derived from the taps (average interval), or `fallback` (default 0.5s = 120 BPM) until two taps exist. The playhead already runs at this tempo; tempo() is for programs that want the number. */
  tempo(fallback?: number): number
  /**
   * A timeline that loops every `count` playback beats. Tempo is automatic, so
   * this is purely a retime: identity by default (content plays once per
   * loop); pass { fit } in source-beats to stretch that much content across
   * the window — beats(16, { fit: 8 }) plays 8 beats of content at half speed.
   */
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
  const asTable = (x: Table | Row[] | null | undefined): Table =>
    x instanceof Table ? x : new Table(x ?? [], ctx)

  const three: ThreeNamespace = {
    box: (props: Row = {}) => sceneObject('box', props, ctx),
    sphere: (props: Row = {}) => sceneObject('sphere', props, ctx),
    cylinder: (props: Row = {}) => sceneObject('cylinder', props, ctx),
    cone: (props: Row = {}) => sceneObject('cone', props, ctx),
    torus: (props: Row = {}) => sceneObject('torus', props, ctx),
    text: (props: Row = {}) => sceneObject('text', props, ctx),
    object: (shape: string, props: Row = {}) => sceneObject(shape, props, ctx),
    points: (shape: string, props: Row = {}): Table => {
      const { segments, ...dims } = props
      const geo = primitiveGeometry(shape, dims, typeof segments === 'number' ? { segments } : {})
      const rows = pointsFromGeometry(geo)
      geo.dispose()
      return new Table(rows, ctx)
    },
    geometry: (points: Table | Row[]): BufferGeometry =>
      geometryFromPoints(points instanceof Table ? points.rows : points ?? []),
    // The first keyframe seeds a full default pose so a partial first row is
    // still well-defined.
    camera: (keyframes: Row[] | null | undefined): Table => new Table(
      (keyframes ?? []).map((k, i) => {
        const beat = typeof k.beat === 'number' ? k.beat : 1
        return i === 0
          ? { px: 0, py: 0, pz: 5, tx: 0, ty: 0, tz: 0, ...k, id: 'camera', shape: 'camera', type: 'create', beat }
          : { ...k, id: 'camera', shape: 'camera', type: 'update', beat }
      }),
      ctx,
    ),
    translate: (table: Table | Row[], x = 0, y = 0, z = 0): Table =>
      asTable(table).map((r) => modRow(r, [
        ['px', 0, (v) => v + x], ['py', 0, (v) => v + y], ['pz', 0, (v) => v + z],
      ])),
    scale: (table: Table | Row[], x = 1, y?: number, z?: number): Table =>
      asTable(table).map((r) => modRow(r, [
        ['sx', 1, (v) => v * x], ['sy', 1, (v) => v * (y ?? x)], ['sz', 1, (v) => v * (z ?? x)],
      ])),
    rotate: (table: Table | Row[], x = 0, y = 0, z = 0): Table =>
      asTable(table).map((r) => modRow(r, [
        ['rx', 0, (v) => v + x], ['ry', 0, (v) => v + y], ['rz', 0, (v) => v + z],
      ])),
  }

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
    three,
    t: three,
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
    taps: () => new Table((ctx?.tapRows?.() ?? []).map((r) => ({ ...r })), ctx),
    tempo: (fallback = DEFAULT_BEAT_SECONDS): number => beatSecondsFromTaps(ctx?.tapRows?.()) ?? fallback,
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
