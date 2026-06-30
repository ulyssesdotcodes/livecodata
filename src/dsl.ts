// livecodata DSL
// ----------------------------------------------------------------------------
// A tiny, JavaScript-flavoured DSL for generating tables and using those tables
// to drive visuals. Tables are arrays of plain row objects. All timing uses
// **seconds** — math().range(duration) samples over `duration` seconds at 60 fps,
// event `index`/`dur` fields are in seconds, and rasterize(maxSeconds) sets the
// animation length in seconds. Every builder returns a new Table, so everything
// chains.
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
// Expr variants — field("index").add(0.05), filter(field("type").eq("collision"))
// — three.js-node style. Function verbs still work but are hashed by their source
// text + the run seed (best-effort; a closure could capture changed outer scope).
// ----------------------------------------------------------------------------

import { rasterizeRows } from './rasterize.js'
import { withLineage, carry, unionLineage, getLineage, type Row } from './lineage.js'
import { FPS } from './constants.js'

// ── Expr: a small, serializable, chainable expression over a row ─────────────
// Each Expr wraps a plain-JSON `node` (no functions), so it serializes for
// hashing and evaluates against a row. Operands accept another Expr or a raw
// literal. Chain like three.js nodes: field("index").add(0.05).

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

function evalExpr(n: ExprNode, row: Row, i: number): unknown {
  switch (n.k) {
    case 'field': return row[n.name]
    case 'lit': return n.v
    case 'idx': return i
    case 'bin': {
      const a = evalExpr(n.a, row, i) as number
      const b = evalExpr(n.b, row, i) as number
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
      const a = evalExpr(n.a, row, i) as number
      const b = evalExpr(n.b, row, i) as number
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
      const a = evalExpr(n.a, row, i)
      return n.op === 'and' ? (a && evalExpr(n.b, row, i)) : (a || evalExpr(n.b, row, i))
    }
    case 'not': return !evalExpr(n.a, row, i)
    case 'cond': return evalExpr(n.t, row, i) ? evalExpr(n.a, row, i) : evalExpr(n.b, row, i)
  }
}

// A row template: a plain object whose values are Expr (evaluated per row),
// nested templates, arrays, or plain literals (including functions like easings,
// which pass through untouched).
export type Template = Record<string, unknown>

function buildValue(v: unknown, row: Row, i: number): unknown {
  if (v instanceof Expr) return evalExpr(v.node, row, i)
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
        next[k] = sv instanceof Expr ? evalExpr(sv.node, r, i)
          : typeof sv === 'function' ? (sv as (r: Row, i: number) => unknown)(r, i)
            : sv
      }
      return withLineage(next, carry(r))
    }), hasFn(spec))
  }

  assign(spec: DeriveSpec): Table { return this.derive(spec) }

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

  rasterize(maxSeconds?: number): Table {
    return this._xf('rasterize', { maxSeconds }, (ins) => rasterizeRows(ins[0], maxSeconds), false)
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

class MathBuilder {
  private _fn: (t: number) => number
  private _ctx: DSLContext

  constructor(fn: (t: number) => number, ctx: DSLContext) {
    this._fn = fn
    this._ctx = ctx
  }

  // Sample over `durationSeconds` at FPS. Eager (a literal-rows leaf): the values
  // — which may come from rand — are baked in, so the leaf's hash is value-based
  // and naturally seed-sensitive.
  range(durationSeconds: number): Table {
    const n = Math.max(1, Math.round(durationSeconds * FPS))
    const rows: Row[] = new Array(n)
    for (let i = 0; i < n; i++) {
      const t = i / FPS
      rows[i] = { index: t, value: this._fn(t) }
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
// seconds since the first tap), or null with fewer than two taps. The one place
// tempo()/beats() turn the taps table into a beat length.
function beatSecondsFromTaps(rows: Row[] | null | undefined): number | null {
  if (!rows || rows.length < 2) return null
  return (rows[rows.length - 1].time as number) / (rows.length - 1)
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
  field(name: string): Expr
  lit(v: number | string | boolean | null): Expr
  idx(): Expr
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
    field,
    lit,
    idx,
    // The tap-beat table: one row per wall-time button press ({ beat, time } —
    // ordinal + seconds since the first tap). The source of truth for tempo.
    taps: () => new Table((ctx?.tapRows?.() ?? []).map((r) => ({ ...r })), ctx),
    // Seconds per beat derived from the tap-beat table (the average interval), or
    // `fallback` (default 0.5s = 120 BPM) until two taps are recorded.
    tempo: (fallback = 0.5): number => beatSecondsFromTaps(ctx?.tapRows?.()) ?? fallback,
    // A looping timeline `count` beats long at the tapped tempo — measure playback
    // length in beats (e.g. beats(16) is a 16-beat loop). Each row is one playback
    // frame; `time` (seconds) is the source time it maps to. By default time runs
    // identity (0 → count·beat seconds) so the baked scene plays once per loop;
    // pass { fit } in source-seconds to stretch a scene across the beat window.
    beats: (count: number, { fallback = 0.5, fit }: { fallback?: number; fit?: number } = {}): Table => {
      const beat = beatSecondsFromTaps(ctx?.tapRows?.()) ?? fallback
      const totalSeconds = Math.max(0, count) * beat
      const frames = Math.max(1, Math.round(totalSeconds * FPS))
      const span = fit != null ? fit : totalSeconds
      const out: Row[] = new Array(frames)
      for (let i = 0; i < frames; i++) {
        const frac = frames > 1 ? i / (frames - 1) : 0
        out[i] = { index: i / FPS, beat: frac * count, time: frac * span }
      }
      return new Table(out, ctx)
    },
    ...EASINGS,
  }
}
