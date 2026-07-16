// livecodata replay — cook a program to its scene/timeline/hydra/bauble outputs
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
import { baubleRows } from './bauble.js'
import type { Table } from './dsl.js'
import type { Row } from './lineage.js'
import type { ResolvedGraph, RunOptions, RuntimeResult } from './runtime.js'

export interface CookedResult {
  views: Map<string, Table>
  graphs: ResolvedGraph[]
  sceneRows: Row[]
  timelineRows: Row[]
  hydraRows: Row[]
  baubleRows: Row[]
}

// The slice of createRuntime's return value cookProgram needs — typed from
// runtime.ts's own exports so it can't drift from the real contract.
interface Runtime {
  run(code: string, opts?: RunOptions): RuntimeResult
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
  // Bauble rows come only from a view literally named "bauble" — its events
  // share hydra's names (setCode/setVariable), so sniffing a generic events
  // table (the hydra fallback above) would claim the same rows twice.
  const bauble = result.views.get('bauble')
  const baubleSketchRows = bauble ? baubleRows(bauble.rows) : []
  return { views: result.views, graphs: result.graphs, sceneRows, timelineRows, hydraRows: hydraSketchRows, baubleRows: baubleSketchRows }
}
