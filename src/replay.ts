// Cook a program (code + seed) into the rows the scene/timeline/hydra/bauble
// panels consume — the one cook helper shared by a live Run and a scrubbed
// session replay, so replay treats the "code" table like any other editable
// table folded to the run's index.

import { rasterizeRows } from './rasterize.js'
import { hydraRows } from './hydra.js'
import { baubleRows } from './bauble.js'
import { postRows } from './post.js'
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
  postRows: Row[]
}

// The slice of createRuntime's return value cookProgram needs.
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
  // No events-table fallback for bauble: its events share hydra's names, so
  // sniffing the generic events table would claim the same rows twice.
  const bauble = result.views.get('bauble')
  const baubleSketchRows = bauble ? baubleRows(bauble.rows) : []
  // No events-table fallback for post either — its setCode/transition/… names
  // collide with hydra's (bauble precedent).
  const post = result.views.get('post')
  const postSketchRows = post ? postRows(post.rows) : []
  return { views: result.views, graphs: result.graphs, sceneRows, timelineRows, hydraRows: hydraSketchRows, baubleRows: baubleSketchRows, postRows: postSketchRows }
}
