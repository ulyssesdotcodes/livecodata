// livecodata rasterize — Houdini-style bake: expand sparse object events
// (create/update/color/destroy, keyed by `id`) into a dense frame-indexed
// cache, one row per alive object per frame, on the FRAMES_PER_BEAT grid.
// Timing fields (`beat`, `dur`) are in beats, 1-indexed (beat 1 = frame 0).
// The beat axis is absolute: events past the loop's end just bake further
// along the grid, and playback wraps the playhead into it in loop-length
// passes (see the scene visualizer in visualizer.ts).

import { withLineage, unionLineage, type Row } from './lineage.js'
import { mixColor } from './color.js'
import { beatToFrame, beatsToFrames } from './constants.js'

interface SampledState {
  fields: Row
  sources: Row[]
}

// Fields rasterize interprets itself. Anything else — a custom field, or a
// { $expr } streaming binding — is "extra": carried through to each baked row
// untouched, to be read (and bindings resolved) at playback. `loop` is the
// retired pass column: still reserved so old tables carrying one stay inert.
const RESERVED = new Set([
  'id', 'type', 'beat', 'loop', 'dur', 'ease', 'to', 'shape', 'color',
  'px', 'py', 'pz', 'rx', 'ry', 'rz', 'sx', 'sy', 'sz', 'frame',
])

// Non-reserved fields visible at frame `i`: events at-or-before, last write wins.
function gatherExtra(events: Row[], i: number): Row {
  const extra: Row = {}
  for (const e of events) {
    if ((e.frame as number) > i) continue
    for (const k in e) {
      if (!RESERVED.has(k)) extra[k] = e[k]
    }
  }
  return extra
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

// Resolve event timing to the frame grid: `beat` (1-indexed) → cache frame,
// `dur` (beats) → frames.
function toFrameEvent(e: Row): Row {
  const ev = { ...e }
  ev.frame = beatToFrame((e.beat as number | undefined) ?? 1)
  if (ev.dur != null) ev.dur = beatsToFrames(ev.dur as number)
  return ev
}

function buildTimelines(events: Row[]): Map<unknown, Row[]> {
  const map = new Map<unknown, Row[]>()
  for (const e of events) {
    if (e.id == null) continue
    if (!map.has(e.id)) map.set(e.id, [])
    map.get(e.id)!.push({ ...e })
  }
  for (const evs of map.values()) evs.sort((a, b) => (a.frame as number) - (b.frame as number))
  return map
}

// `color` events are a pulse/step, not a keyframe: a bare event is a hard
// switch (newest wins); with `dur` it decays back to `to` (or the base color).
function sampleColor(events: Row[], createEv: Row, i: number): { color: number | null; source: Row | null } {
  let colorEv: Row | null = null
  for (const e of events) {
    if (e.type === 'color' && (e.frame as number) <= i) colorEv = e
  }
  if (!colorEv) return { color: (createEv.color as number | null | undefined) ?? null, source: null }

  const dur = colorEv.dur as number | undefined
  if (dur == null || dur <= 0) return { color: colorEv.color as number | null, source: colorEv }

  const base = colorEv.to != null
    ? (colorEv.to as number | null)
    : ((createEv.color as number | null | undefined) ?? (colorEv.color as number | null))
  const p = Math.min(1, Math.max(0, (i - (colorEv.frame as number)) / dur))
  const easeFn = colorEv.ease as ((t: number) => number) | undefined
  const eased = typeof easeFn === 'function' ? easeFn(p) : p
  return { color: mixColor(colorEv.color as number | null, base, eased), source: colorEv }
}

// Numeric fields that must NOT interpolate as tracks: timing bookkeeping,
// identity, and color (which has its own pulse semantics).
const NO_TRACK = new Set(['frame', 'beat', 'loop', 'dur', 'id', 'color'])

function sampleObject(events: Row[], i: number): SampledState | null {
  const createEv = events.find((e) => e.type === 'create')
  if (!createEv || i < (createEv.frame as number)) return null
  if (events.some((e) => e.type === 'destroy' && (e.frame as number) <= i)) return null

  const keyframes = events.filter((e) => e.type === 'create' || e.type === 'update')

  const fields: Row = { ...createEv }
  Object.assign(fields, gatherExtra(events, i))

  // Numeric fields are per-field TRACKS: each eases between the previous and
  // next keyframe that actually carry it, so keyframes omitting a field don't
  // interrupt its glide. An `ease` on the destination keyframe shapes that
  // segment.
  const names = new Set<string>()
  for (const kf of keyframes) {
    for (const k in kf) {
      if (!NO_TRACK.has(k) && typeof kf[k] === 'number') names.add(k)
    }
  }
  const sources = new Set<Row>([createEv])
  for (const name of names) {
    let prev: Row | null = null
    let next: Row | null = null
    for (const kf of keyframes) {
      if (typeof kf[name] !== 'number') continue
      if ((kf.frame as number) <= i) prev = kf
      else {
        next = kf
        break
      }
    }
    if (!prev) continue
    sources.add(prev)
    if (next) {
      const raw = (i - (prev.frame as number)) / ((next.frame as number) - (prev.frame as number))
      const easeFn = next.ease as ((t: number) => number) | undefined
      const t = typeof easeFn === 'function' ? easeFn(raw) : raw
      fields[name] = lerp(prev[name] as number, next[name] as number, t)
      sources.add(next)
    } else {
      fields[name] = prev[name]
    }
  }

  const { color, source: colorSource } = sampleColor(events, createEv, i)
  fields.color = color
  if (colorSource) sources.add(colorSource)

  return { fields, sources: [...sources] }
}

export function rasterizeRows(eventRows: Row[] | null | undefined, maxBeats?: number): Row[] {
  const events = (eventRows ?? []).map(toFrameEvent)
  // Bake out to the largest event frame, or at least the last frame a
  // `maxBeats` loop samples (its span EXCLUSIVE — frame span belongs to the
  // next pass, and pad frames reaching it would spuriously add one). How the
  // extent chops into passes is playback's concern.
  const max = Math.max(
    maxBeats != null ? Math.max(0, beatsToFrames(maxBeats) - 1) : 0,
    events.reduce((m, e) => Math.max(m, (e.frame as number) ?? 0), 0),
  )
  const timelines = buildTimelines(events)

  const out: Row[] = []
  for (let frame = 0; frame <= max; frame++) {
    for (const evs of timelines.values()) {
      const s = sampleObject(evs, frame)
      if (!s) continue
      // Drop the sparse `beat` keyframe field (and any legacy `loop`); the
      // dense cache is keyed by `frame`.
      const { beat: _beat, loop: _loop, ...fields } = s.fields
      out.push(withLineage({ ...fields, frame, id: evs[0].id }, unionLineage(s.sources)))
    }
  }
  return out
}

export interface FrameIndex {
  map: Map<number, Row[]>
  // Total extent of the baked cache in frames.
  maxFrame: number
}

export function buildFrameIndex(sceneRows: Row[]): FrameIndex {
  const map = new Map<number, Row[]>()
  let maxFrame = 0
  for (const r of sceneRows ?? []) {
    const f = (r.frame as number | undefined) ?? 0
    if (!map.has(f)) map.set(f, [])
    map.get(f)!.push(r)
    if (f > maxFrame) maxFrame = f
  }
  return { map, maxFrame }
}

export function stateAtFrame(frameIndex: FrameIndex, i: number): Row[] {
  const f = Math.floor(i)
  if (f < 0) return []
  return frameIndex.map.get(f) ?? []
}

// Fields interpolated between adjacent cache frames; everything else is
// discrete (takes the earlier frame's value, never a blend).
const INTERP_FIELDS = ['px', 'py', 'pz', 'rx', 'ry', 'rz', 'sx', 'sy', 'sz'] as const

// State at a *fractional* frame: the floored frame's rows with transforms
// eased toward the next frame — keeps motion smooth when the playhead crosses
// cache frames slower than one-per-render. An object absent at the next frame
// (about to be destroyed) is left un-eased.
export function sampleFrame(frameIndex: FrameIndex, frameFloat: number): Row[] {
  const f0 = Math.floor(frameFloat)
  if (f0 < 0) return []
  const a = frameIndex.map.get(f0) ?? []
  const frac = frameFloat - f0
  if (frac <= 0 || f0 >= frameIndex.maxFrame) return a

  const b = frameIndex.map.get(f0 + 1)
  if (!b) return a
  const bById = new Map(b.map((r) => [r.id, r]))
  return a.map((row) => {
    const next = bById.get(row.id)
    if (!next) return row
    let out: Row | null = null
    for (const k of INTERP_FIELDS) {
      const va = row[k], vb = next[k]
      if (typeof va === 'number' && typeof vb === 'number' && va !== vb) {
        out ??= { ...row }
        out[k] = va + (vb - va) * frac
      }
    }
    return out ?? row
  })
}
