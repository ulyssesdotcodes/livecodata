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
//
// Multi-loop sequences: an optional 0-indexed `loop` column next to `beat`
// places a keyframe in a later pass of the loop, so the remap can differ per
// pass. Every pass spans the same length (the keyframes' beat extent across
// all passes), keyframes sit on an extended playback-beat axis at
// beat + loop * span, and sourceBeatAt takes which pass to sample.
// ----------------------------------------------------------------------------

import type { Row } from './lineage.js'

export interface Timeline {
  // Is a real (non-identity) timeline defined?
  active: boolean
  // ONE loop's length in playback beats (the per-pass keyframe span), or 0
  // when none — the playhead still wraps per pass, whatever `loops` is.
  beats: number
  // How many passes of the loop the keyframes span (1 = single-loop).
  loops: number
  // Map a 1-indexed playback beat (within pass `loop`, which wraps modulo
  // `loops`) to the 1-indexed source beat it shows.
  sourceBeatAt(playbackBeat: number, loop?: number): number
}

export function buildTimeline(timelineRows: Row[]): Timeline {
  const keyed = (timelineRows ?? [])
    .filter((r) => typeof r.beat === 'number')
    .map((r): Row => ({ ...r, loop: typeof r.loop === 'number' ? Math.max(0, Math.floor(r.loop)) : 0 }))
  if (!keyed.length) {
    return { active: false, beats: 0, loops: 1, sourceBeatAt: (pb) => pb }
  }
  const loops = keyed.reduce((m, r) => Math.max(m, r.loop as number), 0) + 1
  // Every pass spans the keyframes' full beat extent, so a pass-L keyframe's
  // position on the extended playback axis is beat + L * span.
  const minBeat = keyed.reduce((m, r) => Math.min(m, r.beat as number), Infinity)
  const span = keyed.reduce((m, r) => Math.max(m, r.beat as number), -Infinity) - minBeat
  const rows = keyed
    .map((r) => ({ ...r, beat: (r.beat as number) + (r.loop as number) * span }))
    .sort((a, b) => (a.beat as number) - (b.beat as number))
  const first = rows[0], last = rows[rows.length - 1]
  const srcOf = (r: Row): number => (r.source as number | undefined) ?? (r.beat as number)
  return {
    active: true,
    beats: span,
    loops,
    sourceBeatAt(playbackBeat: number, loop = 0): number {
      const pb = playbackBeat + (loops > 1 ? (loop % loops) * span : 0)
      if (pb <= (first.beat as number)) return srcOf(first)
      if (pb >= (last.beat as number)) return srcOf(last)
      // Interpolate within the bracketing keyframes.
      for (let i = 1; i < rows.length; i++) {
        const b1 = rows[i].beat as number
        if (pb <= b1) {
          const b0 = rows[i - 1].beat as number
          const s0 = srcOf(rows[i - 1]), s1 = srcOf(rows[i])
          const f = b1 === b0 ? 0 : (pb - b0) / (b1 - b0)
          return s0 + (s1 - s0) * f
        }
      }
      return srcOf(last)
    },
  }
}
