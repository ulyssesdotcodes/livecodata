// livecodata timeline — DSL-driven playback time
// ----------------------------------------------------------------------------
// The playback timeline is itself an (optional) table. A "timeline" view maps
// each playback tick (a row's ordinal position, in frames) to a source time in
// the dense cache, via a `time` field in **seconds**. That makes retime / loop /
// ease / hold / reverse plain table data the DSL produces — e.g.
//
//   define("timeline", () => math(t => t % 1).range(6).map(r => ({ time: r.value })))
//
// With no timeline view, playback is the identity: tick i shows cache frame i.
// ----------------------------------------------------------------------------

import { FPS } from './constants.js'
import type { Row } from './lineage.js'

export interface Timeline {
  length: number
  frameAt(tick: number): number
}

export function buildTimeline(timelineRows: Row[]): Timeline {
  const rows = timelineRows ?? []
  if (!rows.length) {
    return { length: 0, frameAt: (tick) => Math.floor(tick) }
  }
  const last = rows.length - 1
  return {
    length: rows.length,
    frameAt(tick: number): number {
      const idx = Math.min(last, Math.max(0, Math.floor(tick)))
      const time = (rows[idx].time as number | undefined) ?? (idx / FPS)
      return Math.round(time * FPS)
    },
  }
}
