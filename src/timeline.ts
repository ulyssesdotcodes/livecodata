// livecodata timeline — an OPTIONAL remap on top of the beat-grid playhead:
// sparse keyframes { beat, source } (both 1-indexed) warp the playback beat to
// a source beat of the baked content, interpolated linearly; no timeline means
// identity. An optional 0-indexed `loop` column places a keyframe in a later
// pass of the loop; every pass spans the keyframes' full beat extent.

import type { Row } from './lineage.js'

export interface Timeline {
  // Is a real (non-identity) timeline defined?
  active: boolean
  // ONE loop's length in playback beats (the per-pass keyframe span) — the
  // playhead wraps per pass, whatever `loops` is.
  beats: number
  // How many passes of the loop the keyframes span (1 = single-loop).
  loops: number
  // Map a 1-indexed playback beat (within pass `loop`, wrapped modulo `loops`)
  // to the 1-indexed source beat it shows.
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
  // A pass-L keyframe sits at beat + L * span on the extended playback axis.
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
