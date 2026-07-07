// livecodata replay — cook a program to its scene/timeline/hydra outputs
// ----------------------------------------------------------------------------
// Pure orchestration over the runtime: turn a program (code + seed) into the
// rows the scene, timeline and hydra panels consume. This is the one cook
// helper both a live Run and a scrubbed session replay share — replaying a past
// run is "restore every editable table to that run (editableStore.setReplayView
// in main.ts) then cook the program that was live then" — so replay no longer
// treats the "code" table specially; it's just another editable table folded to
// the run's index like the rest.
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

interface Runtime {
  run(code: string, opts?: { seed?: number; only?: string[]; dataCache?: Map<string, string> }): RuntimeResult
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
