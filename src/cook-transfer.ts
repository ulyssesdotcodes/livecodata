// Cook transfer — (de)serializing cooked results across the worker boundary.
// Three things in cooked rows don't survive structured clone: functions —
// packed as { $fn: source }, rehydrated with new Function (same trust domain
// as the already-evaluated program, but a lambda loses its closure captures);
// symbol-keyed row lineage — carried as a $lineage field; and Table instances
// — sent as { name, rows }.
//
// Identity matters: rasterize stamps the SAME compiled program object (megabytes
// of baked origami keyframes) onto every dense frame row. Structured clone
// serializes a shared object once — but only if packing preserves the sharing,
// so pack/unpack memoize per object. Naive per-row deep copies multiplied the
// program by the frame count and blew postMessage out of memory.

import { Table } from './dsl.js'
import { getLineage, withLineage, type Row } from './lineage.js'
import type { CookedResult } from './replay.js'

const FN_KEY = '$fn'
const LINEAGE_KEY = '$lineage'

type Memo = Map<object, unknown>

function packValue(v: unknown, memo: Memo): unknown {
  if (typeof v === 'function') return { [FN_KEY]: String(v) }
  if (v === null || typeof v !== 'object') return v
  const hit = memo.get(v)
  if (hit !== undefined) return hit
  if (Array.isArray(v)) {
    const out: unknown[] = []
    memo.set(v, out)
    for (let i = 0; i < v.length; ++i) out[i] = packValue(v[i], memo)
    return out
  }
  const out: Record<string, unknown> = {}
  memo.set(v, out)
  for (const k of Object.keys(v)) {
    out[k] = packValue((v as Record<string, unknown>)[k], memo)
  }
  return out
}

function unpackValue(v: unknown, memo: Memo): unknown {
  if (v === null || typeof v !== 'object') return v
  const hit = memo.get(v)
  if (hit !== undefined) return hit
  if (Array.isArray(v)) {
    const out: unknown[] = []
    memo.set(v, out)
    for (let i = 0; i < v.length; ++i) out[i] = unpackValue(v[i], memo)
    return out
  }
  const obj = v as Record<string, unknown>
  const keys = Object.keys(obj)
  if (keys.length === 1 && keys[0] === FN_KEY && typeof obj[FN_KEY] === 'string') {
    let fn: unknown
    try {
      fn = new Function(`return (${obj[FN_KEY] as string})`)()
    } catch {
      fn = undefined
    }
    memo.set(v, fn)
    return fn
  }
  const out: Record<string, unknown> = {}
  memo.set(v, out)
  for (const k of keys) out[k] = unpackValue(obj[k], memo)
  return out
}

export function packRows(rows: Row[], memo: Memo = new Map()): Row[] {
  return rows.map((row) => {
    const packed = packValue(row, memo) as Row
    const refs = getLineage(row)
    if (refs.length) packed[LINEAGE_KEY] = refs
    return packed
  })
}

export function unpackRows(rows: Row[], memo: Memo = new Map()): Row[] {
  return rows.map((packed) => {
    const { [LINEAGE_KEY]: refs, ...rest } = packed
    const row = unpackValue(rest, memo) as Row
    return refs ? withLineage(row, refs as ReturnType<typeof getLineage>) : row
  })
}

// Signature of one cooked output, for change detection. Functions hash by
// their source text (every cook builds fresh closures, so identity would
// always differ), and a shared object — the compiled origami program on every
// dense frame row — serializes once, then by back-reference: a naive
// JSON.stringify re-expands it per row and overflows V8's max string length.
export function rowsSig(rows: Row[]): string {
  const seen = new Map<object, number>()
  return JSON.stringify(rows, (_k, v: unknown) => {
    if (typeof v === 'function') return String(v)
    if (v !== null && typeof v === 'object') {
      const id = seen.get(v)
      if (id !== undefined) return { $ref: id }
      seen.set(v, seen.size)
    }
    return v
  })
}

export interface PackedCook {
  views: Array<{ name: string; rows: Row[] }>
  // rows: null points at a packed view by name; an anonymous .graph(table)
  // target carries its own rows.
  graphs: Array<{ viewName: string | null; columns: string[]; rows: Row[] | null }>
  sceneRows: Row[]
  timelineRows: Row[]
  hydraRows: Row[]
  baubleRows: Row[]
  postRows: Row[]
}

export function packCooked(cooked: CookedResult): PackedCook {
  // One memo for the whole payload: an object shared across views and the
  // scene rows (the compiled origami program) stays one object on the wire.
  const memo: Map<object, unknown> = new Map()
  const views = [...cooked.views].map(([name, table]) => ({ name, rows: packRows(table.rows, memo) }))
  const graphs = cooked.graphs.map((g) => {
    const viewName = g.viewName ?? g.table.name ?? null
    const isView = viewName != null && cooked.views.has(viewName)
    return { viewName, columns: g.columns, rows: isView ? null : packRows(g.table.rows, memo) }
  })
  return {
    views,
    graphs,
    sceneRows: packRows(cooked.sceneRows, memo),
    timelineRows: packRows(cooked.timelineRows, memo),
    hydraRows: packRows(cooked.hydraRows, memo),
    baubleRows: packRows(cooked.baubleRows, memo),
    postRows: packRows(cooked.postRows, memo),
  }
}

export function unpackCooked(packed: PackedCook): CookedResult {
  const memo: Map<object, unknown> = new Map()
  const views = new Map<string, Table>()
  for (const { name, rows } of packed.views) {
    const t = new Table(unpackRows(rows, memo))
    t.name = name
    views.set(name, t)
  }
  const graphs = packed.graphs.map((g) => {
    const table = (g.viewName != null ? views.get(g.viewName) : undefined) ?? new Table(unpackRows(g.rows ?? [], memo))
    return { table, columns: g.columns, viewName: g.viewName }
  })
  return {
    views,
    graphs,
    sceneRows: unpackRows(packed.sceneRows, memo),
    timelineRows: unpackRows(packed.timelineRows, memo),
    hydraRows: unpackRows(packed.hydraRows, memo),
    // ?? [] tolerates a stale worker bundle from before bauble/post existed.
    baubleRows: unpackRows(packed.baubleRows ?? [], memo),
    postRows: unpackRows(packed.postRows ?? [], memo),
  }
}
