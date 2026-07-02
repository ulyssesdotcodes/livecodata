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
//
// Dense rows are tedious to author by hand, so a mapping can also be written
// sparsely and rasterized (mirroring how rasterize() bakes sparse scene events):
//
//   warpKeyframes — keyframe rows { src, dst, ease? } (source seconds, playback
//     seconds, easing to the next keyframe) → dense { index, time } rows.
//   paceEvents — events from *any* table (collisions, crossings, …) split the
//     source span into segments; each between-event segment plays at its own
//     speed ("slow down between collisions"), building keyframes for the above.
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

// ── Sparse time-warp → dense timeline rows ───────────────────────────────────

export type EaseFn = (t: number) => number
// An easing is a function, a name looked up in `easings` (the DSL passes its
// EASINGS), or absent (linear).
export type EaseLike = EaseFn | string | null | undefined
// Per-segment easing for paceEvents: one easing for every segment, or an array
// cycled per segment.
export type EaseSpec = EaseLike | EaseLike[]
// Per-segment playback speed for paceEvents: one number for every segment, an
// array cycled per segment (e.g. [0.4, 2] alternates slow/fast), or a function
// of the segment ordinal and its source span.
export type SpeedSpec = number | number[] | ((seg: number, span: { from: number; to: number }) => number)

export interface WarpOptions {
  ease?: EaseLike // default easing for keyframes that don't carry their own
  easings?: Record<string, EaseFn> // name → fn lookup for string eases
}

const linear: EaseFn = (t) => t

function resolveEase(e: EaseLike, easings?: Record<string, EaseFn>): EaseFn {
  if (typeof e === 'function') return e
  if (typeof e === 'string') return easings?.[e] ?? linear
  return linear
}

// Rasterize time-mapping keyframes { src, dst, ease? } (all times in seconds;
// `ease` shapes the segment from this keyframe to the next) into one row per
// playback frame: { index, time }. Playback runs 0 → the last keyframe's dst;
// before the first keyframe the mapping holds its src. src may go backwards
// (reverse), repeat (loop), or hold (freeze) — it's just data.
export function warpKeyframes(keyframeRows: Row[] | null | undefined, opts: WarpOptions = {}): Row[] {
  const kfs = (keyframeRows ?? [])
    .filter((r) => typeof r.src === 'number' && typeof r.dst === 'number')
    .map((r) => ({
      src: r.src as number,
      dst: Math.max(0, r.dst as number),
      ease: resolveEase((r.ease ?? opts.ease) as EaseLike, opts.easings),
    }))
    .sort((a, b) => a.dst - b.dst)
  if (!kfs.length) return []

  const frames = Math.round(kfs[kfs.length - 1].dst * FPS)
  const out: Row[] = new Array(frames + 1)
  let seg = 0
  for (let i = 0; i <= frames; i++) {
    const t = i / FPS
    while (seg < kfs.length - 1 && kfs[seg + 1].dst <= t) seg++
    const a = kfs[seg]
    const b = kfs[Math.min(seg + 1, kfs.length - 1)]
    const time = t <= a.dst || b.dst <= a.dst
      ? a.src
      : a.src + (b.src - a.src) * a.ease(Math.min(1, (t - a.dst) / (b.dst - a.dst)))
    out[i] = { index: t, time }
  }
  return out
}

export interface PaceOptions {
  at?: string // event source-time field, in seconds (default "index")
  until?: number // source length in seconds (default: the last event's time)
  speed?: SpeedSpec // per-segment playback speed (2 = twice as fast); default 1
  ease?: EaseSpec // per-segment easing (note: eased segments ramp to zero speed at events)
  easings?: Record<string, EaseFn>
}

function speedFor(spec: SpeedSpec | undefined, seg: number, span: { from: number; to: number }): number {
  const raw = typeof spec === 'function' ? spec(seg, span)
    : Array.isArray(spec) ? spec[seg % spec.length]
      : spec
  return typeof raw === 'number' && raw > 0 && Number.isFinite(raw) ? raw : 1
}

const easeFor = (spec: EaseSpec | undefined, seg: number): EaseLike =>
  Array.isArray(spec) ? spec[seg % spec.length] : spec

// Warp playback speed *between events*. The rows are events at source times
// (field `at`, seconds); they split the source span [0, until] into segments,
// and each segment plays at its own speed. Duplicate event times collapse to
// one boundary (a physics contact emits a collision row per body). Returns the
// dense timeline rows (via warpKeyframes).
export function paceEvents(eventRows: Row[] | null | undefined, opts: PaceOptions = {}): Row[] {
  const at = opts.at ?? 'index'
  const eventTimes = [...new Set(
    (eventRows ?? [])
      .map((r) => r[at])
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0),
  )].sort((a, b) => a - b)
  const until = opts.until ?? (eventTimes.length ? eventTimes[eventTimes.length - 1] : 0)
  if (until <= 0) return []

  const bounds = [0, ...eventTimes.filter((t) => t < until), until]
  const kfs: Row[] = []
  let dst = 0
  for (let seg = 0; seg < bounds.length - 1; seg++) {
    const span = { from: bounds[seg], to: bounds[seg + 1] }
    kfs.push({ src: span.from, dst, ease: easeFor(opts.ease, seg) })
    dst += (span.to - span.from) / speedFor(opts.speed, seg, span)
  }
  kfs.push({ src: bounds[bounds.length - 1], dst })
  return warpKeyframes(kfs, { easings: opts.easings })
}
