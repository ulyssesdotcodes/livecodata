// livecodata timeline — DSL-driven retiming over the beat grid
// ----------------------------------------------------------------------------
// The playhead advances in beats at the tapped tempo (see playback.ts) — that
// is automatic and needs no timeline. A "timeline" view is an OPTIONAL remap ON
// TOP of that: it warps the playback beat to a `source` beat of the baked
// content, so you can speed up / slow down / loop / reverse a stretch relative
// to the tempo grid. Each row is a sparse keyframe { beat, source } (both
// 1-indexed); the mapping interpolates linearly between them. beats(count, {fit})
// produces one such table — two keyframes mapping the count-beat loop onto a
// span of source beats.
//
// With no timeline view, the mapping is the identity: playback beat b shows
// source beat b, and the content plays once per its natural beat length.
// ----------------------------------------------------------------------------

import type { Row } from './lineage.js'

export interface Timeline {
  // Is a real (non-identity) timeline defined?
  active: boolean
  // The loop's length in playback beats (its keyframe span), or 0 when none.
  beats: number
  // Map a 1-indexed playback beat to the 1-indexed source beat it shows.
  sourceBeatAt(playbackBeat: number): number
}

export function buildTimeline(timelineRows: Row[]): Timeline {
  const rows = (timelineRows ?? [])
    .filter((r) => typeof r.beat === 'number')
    .sort((a, b) => (a.beat as number) - (b.beat as number))
  if (!rows.length) {
    return { active: false, beats: 0, sourceBeatAt: (pb) => pb }
  }
  const first = rows[0], last = rows[rows.length - 1]
  const srcOf = (r: Row): number => (r.source as number | undefined) ?? (r.beat as number)
  return {
    active: true,
    beats: (last.beat as number) - (first.beat as number),
    sourceBeatAt(playbackBeat: number): number {
      if (playbackBeat <= (first.beat as number)) return srcOf(first)
      if (playbackBeat >= (last.beat as number)) return srcOf(last)
      // Interpolate within the bracketing keyframes.
      for (let i = 1; i < rows.length; i++) {
        const b1 = rows[i].beat as number
        if (playbackBeat <= b1) {
          const b0 = rows[i - 1].beat as number
          const s0 = srcOf(rows[i - 1]), s1 = srcOf(rows[i])
          const f = b1 === b0 ? 0 : (playbackBeat - b0) / (b1 - b0)
          return s0 + (s1 - s0) * f
        }
      }
      return srcOf(last)
    },
  }
}
