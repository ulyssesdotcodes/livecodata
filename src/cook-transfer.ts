// Cook transfer — (de)serializing cooked results across the worker boundary.
// Three things in cooked rows don't survive structured clone: functions —
// packed as { $fn: source }, rehydrated with new Function (same trust domain
// as the already-evaluated program, but a lambda loses its closure captures);
// symbol-keyed row lineage — carried as a $lineage field; and Table instances
// — sent as { name, rows }.

import { Table } from './dsl.js'
import { getLineage, withLineage, type Row } from './lineage.js'
import type { CookedResult } from './replay.js'

const FN_KEY = '$fn'
const LINEAGE_KEY = '$lineage'

function packValue(v: unknown): unknown {
  if (typeof v === 'function') return { [FN_KEY]: String(v) }
  if (Array.isArray(v)) return v.map(packValue)
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>)) {
      out[k] = packValue((v as Record<string, unknown>)[k])
    }
    return out
  }
  return v
}

function unpackValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(unpackValue)
  if (v !== null && typeof v === 'object') {
    const obj = v as Record<string, unknown>
    const keys = Object.keys(obj)
    if (keys.length === 1 && keys[0] === FN_KEY && typeof obj[FN_KEY] === 'string') {
      try {
        return new Function(`return (${obj[FN_KEY] as string})`)()
      } catch {
        return undefined
      }
    }
    const out: Record<string, unknown> = {}
    for (const k of keys) out[k] = unpackValue(obj[k])
    return out
  }
  return v
}

export function packRows(rows: Row[]): Row[] {
  return rows.map((row) => {
    const packed = packValue(row) as Row
    const refs = getLineage(row)
    if (refs.length) packed[LINEAGE_KEY] = refs
    return packed
  })
}

export function unpackRows(rows: Row[]): Row[] {
  return rows.map((packed) => {
    const { [LINEAGE_KEY]: refs, ...rest } = packed
    const row = unpackValue(rest) as Row
    return refs ? withLineage(row, refs as ReturnType<typeof getLineage>) : row
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
}

export function packCooked(cooked: CookedResult): PackedCook {
  const views = [...cooked.views].map(([name, table]) => ({ name, rows: packRows(table.rows) }))
  const graphs = cooked.graphs.map((g) => {
    const viewName = g.viewName ?? g.table.name ?? null
    const isView = viewName != null && cooked.views.has(viewName)
    return { viewName, columns: g.columns, rows: isView ? null : packRows(g.table.rows) }
  })
  return {
    views,
    graphs,
    sceneRows: packRows(cooked.sceneRows),
    timelineRows: packRows(cooked.timelineRows),
    hydraRows: packRows(cooked.hydraRows),
    baubleRows: packRows(cooked.baubleRows),
  }
}

export function unpackCooked(packed: PackedCook): CookedResult {
  const views = new Map<string, Table>()
  for (const { name, rows } of packed.views) {
    const t = new Table(unpackRows(rows))
    t.name = name
    views.set(name, t)
  }
  const graphs = packed.graphs.map((g) => {
    const table = (g.viewName != null ? views.get(g.viewName) : undefined) ?? new Table(unpackRows(g.rows ?? []))
    return { table, columns: g.columns, viewName: g.viewName }
  })
  return {
    views,
    graphs,
    sceneRows: unpackRows(packed.sceneRows),
    timelineRows: unpackRows(packed.timelineRows),
    hydraRows: unpackRows(packed.hydraRows),
    // ?? [] tolerates a stale worker bundle from before bauble existed.
    baubleRows: unpackRows(packed.baubleRows ?? []),
  }
}
