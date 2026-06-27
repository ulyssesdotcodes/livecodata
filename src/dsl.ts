// livecodata DSL
// ----------------------------------------------------------------------------
// A tiny, JavaScript-flavoured DSL for generating tables and using those tables
// to drive visuals. Tables are arrays of plain row objects. All timing uses
// **seconds** — math().range(duration) samples over `duration` seconds at 60 fps,
// event `index`/`dur` fields are in seconds, and rasterize(maxSeconds) sets the
// animation length in seconds. Every builder returns a
// new Table, so everything chains.
// ----------------------------------------------------------------------------

import { rasterizeRows } from './rasterize.js'
import { withLineage, carry, unionLineage, type Row } from './lineage.js'
import { FPS } from './constants.js'

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
}

export type ViewFn = (rand: () => number, table: (name: string) => Table) => Table | Row[]

type JoinOn = string | { left: string; right: string } | ((r: Row) => unknown)

type DeriveSpec = Record<string, unknown | ((r: Row, i: number) => unknown)>

interface GroupResult {
  agg(spec: Record<string, (rows: Row[]) => unknown>): Table
  count(as?: string): Table
}

// ── Row helpers ──────────────────────────────────────────────────────────────

const tag = (row: Row, refs: ReturnType<typeof carry>): Row => withLineage({ ...row }, refs)

const recarry = (row: Row): Row => tag(row, carry(row))

const spread = (res: Row | Row[] | null | undefined, refs: ReturnType<typeof carry>): Row[] =>
  res == null ? [] : (Array.isArray(res) ? res : [res]).map((e) => tag(e, refs))

const rowsOf = (x: Table | Row[] | null | undefined): Row[] =>
  x instanceof Table ? x.rows : x ?? []

export class Table {
  rows: Row[]
  name: string | null
  _ctx: DSLContext | null

  constructor(rows: Row[] = [], ctx: DSLContext | null = null) {
    this.rows = rows
    this.name = null
    this._ctx = ctx
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

  _wrap(rows: Row[]): Table {
    return new Table(rows, this._ctx)
  }

  map(fn: (r: Row, i: number) => Row): Table {
    return this._wrap(this.rows.map((r, i) => tag(fn(r, i), carry(r))))
  }

  filter(fn: (r: Row, i: number) => unknown): Table {
    return this._wrap(this.rows.filter((r, i) => fn(r, i)).map(recarry))
  }

  filterMap(fn: (r: Row, i: number, rows: Row[]) => Row | Row[] | null | undefined): Table {
    return this._wrap(this.rows.flatMap((r, i) => spread(fn(r, i, this.rows), carry(r))))
  }

  concat(other: Table | Row[] | null | undefined): Table {
    return this._wrap([...this.rows, ...rowsOf(other)].map(recarry))
  }

  slice(start: number, end?: number): Table {
    return this._wrap(this.rows.slice(start, end).map(recarry))
  }

  fold<T>(fn: (acc: T, cur: Row, i: number, rows: Row[]) => T, initial: T): T {
    let acc = initial
    for (let i = 0; i < this.rows.length; i++) {
      acc = fn(acc, this.rows[i], i, this.rows)
    }
    return acc
  }

  scan<S>(
    fn: (state: S, cur: Row, i: number, rows: Row[]) => { state?: S; emit?: Row | Row[] | null | undefined } | null | undefined,
    initialState: S,
  ): Table {
    const out: Row[] = []
    let state = initialState
    this.rows.forEach((cur, i) => {
      const res = fn(state, cur, i, this.rows)
      if (res == null) return
      if ('state' in res && res.state !== undefined) state = res.state as S
      out.push(...spread(res.emit, carry(cur)))
    })
    return this._wrap(out)
  }

  join(other: Table | Row[], on: JoinOn): Table {
    const leftOf: (r: Row) => unknown = typeof on === 'function' ? on : (r) => r[typeof on === 'object' ? on.left : on]
    const rightOf: (r: Row) => unknown = typeof on === 'function' ? on : (r) => r[typeof on === 'object' ? on.right : on]
    const index = new Map<unknown, Row[]>()
    for (const r of rowsOf(other)) {
      const k = rightOf(r)
      if (!index.has(k)) index.set(k, [])
      index.get(k)!.push(r)
    }
    const out: Row[] = []
    for (const l of this.rows) {
      for (const r of index.get(leftOf(l)) ?? []) {
        out.push(withLineage({ ...l, ...r }, unionLineage([l, r])))
      }
    }
    return this._wrap(out)
  }

  zip(other: Table | Row[]): Table {
    const otherRows = rowsOf(other)
    const n = Math.min(this.rows.length, otherRows.length)
    const out: Row[] = []
    for (let i = 0; i < n; i++) {
      out.push(withLineage({ ...this.rows[i], ...otherRows[i] }, unionLineage([this.rows[i], otherRows[i]])))
    }
    return this._wrap(out)
  }

  orderBy(key: string | ((r: Row) => unknown), dir: 'asc' | 'desc' = 'asc'): Table {
    const accessor = typeof key === 'function' ? key : (r: Row) => r[key]
    const sign = dir === 'desc' ? -1 : 1
    const sorted = [...this.rows].sort((a, b) => {
      const av = accessor(a) as string | number, bv = accessor(b) as string | number
      return av < bv ? -sign : av > bv ? sign : 0
    })
    return this._wrap(sorted.map(recarry))
  }

  derive(spec: DeriveSpec): Table {
    return this._wrap(this.rows.map((r, i) => {
      const next: Row = { ...r }
      for (const k in spec) next[k] = typeof spec[k] === 'function' ? (spec[k] as (r: Row, i: number) => unknown)(r, i) : spec[k]
      return withLineage(next, carry(r))
    }))
  }

  assign(spec: DeriveSpec): Table { return this.derive(spec) }

  mapField(src: string, dst: string, fn: (val: unknown, row: Row, i: number) => unknown): Table {
    return this._wrap(this.rows.map((r, i) =>
      withLineage({ ...r, [dst]: fn(r[src], r, i) }, carry(r))))
  }

  rescale(src: string, [inLo, inHi]: [number, number], [outLo, outHi]: [number, number], dst: string = src): Table {
    const span = (inHi - inLo) || 1
    return this._wrap(this.rows.map((r) => {
      const f = ((r[src] as number) - inLo) / span
      return withLineage({ ...r, [dst]: outLo + f * (outHi - outLo) }, carry(r))
    }))
  }

  lag(field: string, n: number = 1, as: string = `${field}_lag`): Table {
    return this._wrap(this.rows.map((r, i) =>
      withLineage({ ...r, [as]: i >= n ? this.rows[i - n][field] : null }, carry(r))))
  }

  groupBy(key: string | ((r: Row) => unknown)): GroupResult {
    const keyName = typeof key === 'function' ? 'key' : key
    const accessor = typeof key === 'function' ? key : (r: Row) => r[key]
    const groups = new Map<unknown, Row[]>()
    for (const r of this.rows) {
      const k = accessor(r)
      if (!groups.has(k)) groups.set(k, [])
      groups.get(k)!.push(r)
    }
    const wrap = (rows: Row[]) => this._wrap(rows)
    return {
      agg(spec: Record<string, (rows: Row[]) => unknown>): Table {
        const out: Row[] = []
        for (const [k, rs] of groups) {
          const row: Row = { [keyName]: k }
          for (const f in spec) row[f] = spec[f](rs)
          out.push(withLineage(row, unionLineage(rs)))
        }
        return wrap(out)
      },
      count(as: string = 'count'): Table { return this.agg({ [as]: (rs) => rs.length }) },
    }
  }

  trigger(
    predicate: (r: Row, i: number, rows: Row[]) => unknown,
    emit: (r: Row, i: number, rows: Row[]) => Row | Row[] | null | undefined,
  ): Table {
    return this._wrap(this.rows.flatMap((r, i) =>
      predicate(r, i, this.rows) ? spread(emit(r, i, this.rows), carry(r)) : []))
  }

  triggerEach(
    predicate: (cur: Row, i: number, rows: Row[]) => unknown,
    objects: Table | Row[],
    make: (o: Row, cur: Row, i: number, k: number) => Row | Row[] | null | undefined,
  ): Table {
    const objRows = rowsOf(objects)
    return this._wrap(this.rows.flatMap((cur, i) =>
      predicate(cur, i, this.rows)
        ? objRows.flatMap((o, k) => spread(make(o, cur, i, k), unionLineage([cur, o])))
        : []))
  }

  crossings(field: string = 'value', level: number = 0): Table {
    const out: Row[] = []
    for (let i = 1; i < this.rows.length; i++) {
      const prev = (this.rows[i - 1][field] as number) - level
      const cur = (this.rows[i][field] as number) - level
      if (prev !== 0 && prev * cur < 0) {
        out.push(withLineage({ ...this.rows[i], dir: cur > 0 ? 1 : -1 }, carry(this.rows[i])))
      }
    }
    return this._wrap(out)
  }

  rasterize(maxSeconds?: number): Table {
    return this._wrap(rasterizeRows(this.rows, maxSeconds))
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
    const engine = this._ctx.physics?.()
    if (!engine) {
      throw new Error('physics engine still loading — press Run again in a moment')
    }
    const baseRows = this._source instanceof Table ? this._source.rows : (this._source ?? [])
    return new Table(engine.simulate(baseRows, opts), this._ctx)
  }
}

class MathBuilder {
  private _fn: (t: number) => number
  private _ctx: DSLContext

  constructor(fn: (t: number) => number, ctx: DSLContext) {
    this._fn = fn
    this._ctx = ctx
  }

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
  json(data: Row[] | string | unknown): Table
  grid(cols: number, rowsN: number, opts?: { spacing?: number; y?: number }): Table
  physics(source: Table | Row[]): PhysicsBuilder
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
    ...EASINGS,
  }
}
