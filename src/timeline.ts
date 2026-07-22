// livecodata timeline — an OPTIONAL remap on top of the beat-grid playhead,
// defined as a table of EVENTS (see schemas.timeline): each row warps the
// playback window `dur` beats long starting at `beat` (1-indexed) onto source
// beats of the baked content — "retime" stretches input `from`..`to` into the
// output block `outFrom`..`outTo` (default the window; from > to runs
// backwards) and repeats the block across the window, "loop" cycles
// `from`..`to` at natural speed, "hold" freezes at `from`, "speed" runs from
// `from` at `rate`. Playback
// beats no event covers play unmapped (identity); no timeline means identity
// everywhere. An optional 0-indexed `loop` column places an event in a later
// pass of the loop; every pass spans beat 1 to the last event's end.
//
// Legacy sparse keyframe rows { beat, source } (no `event` column) are still
// accepted: consecutive keyframes become linear segments, exactly the old
// straight-map behavior.

import type { Row } from './lineage.js'

export interface Timeline {
  // Is a real (non-identity) timeline defined?
  active: boolean
  // ONE loop's length in playback beats (beat 1 to the pass's last event
  // end) — the playhead wraps per pass, whatever `loops` is.
  beats: number
  // How many passes of the loop the events span (1 = single-loop).
  loops: number
  // Map a 1-indexed playback beat (within pass `loop`, wrapped modulo `loops`)
  // to the 1-indexed source beat it shows.
  sourceBeatAt(playbackBeat: number, loop?: number): number
}

// One linear piece of the playback→source map: playback [p0, p1] plays source
// [s0, s1] (s0 > s1 runs backwards, s0 === s1 holds a frame).
export interface TimelineSegment {
  p0: number
  p1: number
  s0: number
  s1: number
  // The event row that produced this segment — undefined for the legacy
  // sparse-keyframe segments, which have no event kind of their own. Purely
  // descriptive (coverage-shading tint); playback never reads it.
  kind?: 'retime' | 'loop' | 'hold' | 'speed'
}

const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)

// Blank cells in an editable table conform to 0 (see conformRow), and beats
// are 1-indexed, so 0 in any optional column reads as "unset".
const opt = (v: unknown): number | undefined => (typeof v === 'number' && v !== 0 ? v : undefined)

// Compile timeline rows into sorted segments on the extended playback axis
// (pass L's events sit at beat + L * span).
function compile(timelineRows: Row[]): { segments: TimelineSegment[]; span: number; loops: number } {
  const rows = (timelineRows ?? [])
    .filter((r) => !r.disabled && typeof r.beat === 'number')
    .map((r): Row => ({ ...r, loop: Math.max(0, Math.floor(num(r.loop) ?? 0)) }))
  if (!rows.length) return { segments: [], span: 0, loops: 1 }
  const endOf = (r: Row): number => (r.beat as number) + (opt(r.dur) ?? 0)
  const loops = rows.reduce((m, r) => Math.max(m, r.loop as number), 0) + 1
  // Beats are 1-indexed, so a pass runs from beat 1 to the last event's end —
  // events starting mid-loop leave the early beats unmapped, not cut off.
  const span = rows.reduce((m, r) => Math.max(m, endOf(r)), -Infinity) - 1

  const segments: TimelineSegment[] = []
  const keyframes = rows
    .filter((r) => typeof r.event !== 'string')
    .map((r) => ({
      beat: (r.beat as number) + (r.loop as number) * span,
      src: opt(r.source) ?? (r.beat as number),
    }))
    .sort((a, b) => a.beat - b.beat)
  for (let i = 1; i < keyframes.length; i++) {
    segments.push({ p0: keyframes[i - 1].beat, p1: keyframes[i].beat, s0: keyframes[i - 1].src, s1: keyframes[i].src })
  }

  for (const r of rows) {
    if (typeof r.event !== 'string') continue
    const off = (r.loop as number) * span
    const p0 = (r.beat as number) + off
    const p1 = endOf(r) + off
    if (!(p1 > p0)) continue
    const from = opt(r.from) ?? (r.beat as number)
    const to = opt(r.to) ?? endOf(r)
    const kind = r.event as TimelineSegment['kind']
    // Tile the block [o0, o1) → source [from, to] across the window [p0, p1],
    // clipping partial blocks at both edges; o0 anchors the cycle phase, so a
    // window starting mid-block starts mid-source.
    const tile = (o0: number, o1: number): void => {
      const cycle = o1 - o0
      if (!(cycle > 0)) {
        segments.push({ p0, p1, s0: from, s1: from, kind })
        return
      }
      for (let k = Math.floor((p0 - o0) / cycle); o0 + k * cycle < p1; k++) {
        const b0 = o0 + k * cycle
        const q0 = Math.max(b0, p0), q1 = Math.min(b0 + cycle, p1)
        if (!(q1 > q0)) continue
        segments.push({
          p0: q0, p1: q1,
          s0: from + ((q0 - b0) / cycle) * (to - from),
          s1: from + ((q1 - b0) / cycle) * (to - from),
          kind,
        })
      }
    }
    switch (r.event) {
      case 'retime':
        tile((opt(r.outFrom) ?? (r.beat as number)) + off, (opt(r.outTo) ?? endOf(r)) + off)
        break
      case 'hold':
        segments.push({ p0, p1, s0: from, s1: from, kind })
        break
      case 'speed': {
        const rate = opt(r.rate) ?? 1
        segments.push({ p0, p1, s0: from, s1: from + rate * (p1 - p0), kind })
        break
      }
      case 'loop':
        tile(p0, p0 + Math.max(0, to - from))
        break
    }
  }
  segments.sort((a, b) => a.p0 - b.p0 || a.p1 - b.p1)
  return { segments, span, loops }
}

// The compiled segments alone — what Table.retime warps content through.
export function timelineSegments(timelineRows: Row[]): TimelineSegment[] {
  return compile(timelineRows).segments
}

function sourceAt(segments: TimelineSegment[], p: number): number {
  for (const seg of segments) {
    if (p < seg.p0) break // sorted by p0 — we're in a gap, which plays unmapped
    if (p <= seg.p1) {
      const f = seg.p1 === seg.p0 ? 0 : (p - seg.p0) / (seg.p1 - seg.p0)
      return seg.s0 + (seg.s1 - seg.s0) * f
    }
  }
  return p
}

export interface BeatPlacement {
  // Playback beat the source beat lands on.
  beat: number
  // Local playback-per-source rate — what a `dur` stretches by (1 in a hold).
  stretch: number
}

// Invert the map: every playback beat at which source beat `b` is shown, one
// entry per segment that plays it — a loop event yields one per cycle. Source
// intervals are half-open (a cycle's end belongs to the next cycle) except at
// the timeline's very end, so segment joins don't double-place a beat.
export function placeBeat(segments: TimelineSegment[], b: number): BeatPlacement[] {
  const out: BeatPlacement[] = []
  const lastEnd = segments.reduce((m, s) => Math.max(m, s.p1), -Infinity)
  for (const seg of segments) {
    if (seg.s1 === seg.s0) {
      if (b === seg.s0) out.push({ beat: seg.p0, stretch: 1 })
      continue
    }
    const t = (b - seg.s0) / (seg.s1 - seg.s0)
    if (t >= 0 && (t < 1 || (t <= 1 && seg.p1 === lastEnd))) {
      out.push({
        beat: seg.p0 + t * (seg.p1 - seg.p0),
        stretch: Math.abs((seg.p1 - seg.p0) / (seg.s1 - seg.s0)),
      })
    }
  }
  return out
}

export function buildTimeline(timelineRows: Row[]): Timeline {
  const { segments, span, loops } = compile(timelineRows)
  if (!segments.length) {
    return { active: false, beats: 0, loops: 1, sourceBeatAt: (pb) => pb }
  }
  return {
    active: true,
    beats: span,
    loops,
    sourceBeatAt(playbackBeat: number, loop = 0): number {
      const p = playbackBeat + (loops > 1 ? (loop % loops) * span : 0)
      return sourceAt(segments, p)
    },
  }
}
