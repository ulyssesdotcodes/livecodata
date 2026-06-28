// livecodata replay — cook a program / replay the "code" table to a position
// ----------------------------------------------------------------------------
// Pure orchestration over the runtime + the "code" editable table's own event
// history (see editable-tables.ts — every Run sets that table's one row, so
// its events *are* the run history). Because each of those events carries the
// program text and the seed it ran with, replaying to any position in that
// history reproduces exactly what was on screen then.
// ----------------------------------------------------------------------------

import { rasterizeRows } from './rasterize.js'
import { hydraRows } from './hydra.js'
import type { Table } from './dsl.js'
import type { Row } from './lineage.js'
import type { RuntimeResult } from './runtime.js'

interface ResolvedGraph {
  table: Table
  columns: string[]
  viewName?: string | null
}

export interface CookedResult {
  views: Map<string, Table>
  graphs: ResolvedGraph[]
  sceneRows: Row[]
  timelineRows: Row[]
  hydraRows: Row[]
}

export interface CodeEntry {
  code: string
  seed: number
}

export interface ReplayResult extends CookedResult {
  entry: CodeEntry
}

interface Runtime {
  run(code: string, opts?: { seed?: number; only?: string[]; dataCache?: Map<string, string> }): RuntimeResult
}

// Cheaply recompute just the "timeline" view (tick → frame remap), cooking only
// it and its deps. Used when the tap-beat tempo changes a beats() timeline so
// tapping stays responsive (the rest of the program isn't re-run). Returns the
// timeline rows, or [] when the program defines no timeline.
export function cookTimeline(runtime: Runtime, code: string, seed: number): Row[] {
  const result = runtime.run(code, { seed, only: ['timeline'] })
  const timeline = result.views.get('timeline')
  return timeline ? timeline.rows : []
}

export function cookProgram(runtime: Runtime, code: string, seed: number, dataCache?: Map<string, string>): CookedResult {
  const result = runtime.run(code, { seed, dataCache })
  const scene = result.views.get('scene')
  const events = result.views.get('events')
  const sceneRows = scene ? scene.rows : events ? rasterizeRows(events.rows) : []
  const timeline = result.views.get('timeline')
  const timelineRows = timeline ? timeline.rows : []
  const hydra = result.views.get('hydra')
  const hydraSketchRows = hydra ? hydraRows(hydra.rows) : hydraRows(events?.rows)
  return { views: result.views, graphs: result.graphs, sceneRows, timelineRows, hydraRows: hydraSketchRows }
}

// The code+seed active at position `pos` (0-based index) in the "code" table's
// own event list (editableStore.get('code').events — see editable-tables.ts) —
// clamped past the end to the latest entry, null before the first (or if
// there's no history yet). Each entry is a raw table-store event: the first
// run is a 'create' (seed rows under `.rows[0]`), every later one a 'set-row'
// (values under `.values`) — the two shapes main.ts's setCodeRow can produce.
export function codeEntryAt(events: readonly Row[], pos: number): CodeEntry | null {
  if (pos < 0 || events.length === 0) return null
  const e = events[Math.min(pos, events.length - 1)]
  const src = e.kind === 'set-row' ? (e.values as Row | undefined)
    : e.kind === 'create' ? (e.rows as Row[] | undefined)?.[0]
    : undefined
  if (!src || typeof src.code !== 'string') return null
  return { code: src.code, seed: typeof src.seed === 'number' ? src.seed : 0 }
}

export function replayAt(
  runtime: Runtime, events: readonly Row[], pos: number, dataCache?: Map<string, string>,
): ReplayResult | null {
  const entry = codeEntryAt(events, pos)
  if (!entry) return null
  return { entry, ...cookProgram(runtime, entry.code, entry.seed, dataCache) }
}
