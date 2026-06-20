// livecodata replay — cook a program / replay the session to a position
// ----------------------------------------------------------------------------
// Pure orchestration over the runtime + the session log. No DOM. Because each
// log entry carries the program text and the seed it ran with, replaying to any
// session position reproduces exactly what was on screen then.
// ----------------------------------------------------------------------------

import { rasterizeRows } from './rasterize.js'

// Cook a program and resolve the dense scene cache that playback indexes into:
// the explicit "scene" view, or a rasterized "events" view as a fallback for
// older programs. Also resolves the optional "timeline" view (tick → frame
// remapping). Deterministic given (code, seed).
export function cookProgram(runtime, code, seed) {
  const result = runtime.run(code, { seed })
  const scene = result.views.get('scene')
  const events = result.views.get('events')
  const sceneRows = scene ? scene.rows : events ? rasterizeRows(events.rows) : []
  const timeline = result.views.get('timeline')
  const timelineRows = timeline ? timeline.rows : []
  return { views: result.views, graphs: result.graphs, sceneRows, timelineRows }
}

// Replay the session to logical position `pos`: cook the program that was live
// then (the latest run at/under pos), using its recorded seed. Returns the entry
// alongside the cooked result, or null if nothing exists at/under pos.
export function replayAt(runtime, log, pos) {
  const entry = log.entryAt(pos)
  if (!entry) return null
  return { entry, ...cookProgram(runtime, entry.code, entry.seed) }
}
