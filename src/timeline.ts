// livecodata timeline — DSL-driven playback time
// ----------------------------------------------------------------------------
// The playback timeline is itself an (optional) table. A "timeline" view maps
// each playback tick (a row's ordinal position, in frames) to the `source` beat
// of the baked cache it shows. That makes retime / loop / ease / hold / reverse
// plain table data the DSL produces — e.g. beats(16) produces one such table.
//
// With no timeline view, playback is the identity: tick i shows cache frame i.
// ----------------------------------------------------------------------------

import { beatToFrame, frameToBeat } from './constants.js'
import type { Row } from './lineage.js'

export interface Timeline {
  // Number of playback frames (rows) — the loop's internal length.
  length: number
  // The loop's length in playback beats (what the scrubber/readout count in), or
  // 0 with no timeline.
  beats: number
  frameAt(tick: number): number
}

export function buildTimeline(timelineRows: Row[]): Timeline {
  const rows = timelineRows ?? []
  if (!rows.length) {
    return { length: 0, beats: 0, frameAt: (tick) => Math.floor(tick) }
  }
  const last = rows.length - 1
  // Playback-beat span: the last row's playback `beat` less the first's (both
  // 1-indexed), i.e. how many beats the loop counts through.
  const beats = ((rows[last].beat as number | undefined) ?? frameToBeat(last))
    - ((rows[0].beat as number | undefined) ?? 1)
  return {
    length: rows.length,
    beats,
    frameAt(tick: number): number {
      const idx = Math.min(last, Math.max(0, Math.floor(tick)))
      const source = (rows[idx].source as number | undefined) ?? frameToBeat(idx)
      return beatToFrame(source)
    },
  }
}
