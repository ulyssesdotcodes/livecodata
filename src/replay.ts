// livecodata replay — cook a program / replay the session to a position
// ----------------------------------------------------------------------------
// Pure orchestration over the runtime + the session log. No DOM. Because each
// log entry carries the program text and the seed it ran with, replaying to any
// session position reproduces exactly what was on screen then.
// ----------------------------------------------------------------------------

import { rasterizeRows } from './rasterize.js'
import { hydraRows } from './hydra.js'
import type { Table } from './dsl.js'
import type { Row } from './lineage.js'
import type { RuntimeResult } from './runtime.js'
import type { LogEntry, Log } from './log.js'

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

export interface ReplayResult extends CookedResult {
  entry: LogEntry
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

export function replayAt(runtime: Runtime, log: Log, pos: number, dataCache?: Map<string, string>): ReplayResult | null {
  const entry = log.entryAt(pos)
  if (!entry) return null
  return { entry, ...cookProgram(runtime, entry.code, entry.seed, dataCache) }
}
