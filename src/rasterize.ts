// livecodata rasterize — sparse events → dense frame cache
// ----------------------------------------------------------------------------
// Houdini-style "bake": expand a sparse table of object keyframe/events into a
// dense, frame-indexed table of world state — one row per alive object per
// frame. This is the interpolation that used to live in the renderer, lifted
// out so it is plain table data the DSL produces and the user can inspect.
//
// Input event rows (sparse), keyed by object `id`, ordered by `beat`:
//   create  — { id, type:"create", beat, shape, px,py,pz, rx,ry,rz, color? }
//   update  — { id, type:"update", beat, px,py,pz, rx,ry,rz }  (movement keyframe)
//   color   — { id, type:"color",  beat, color, dur?, ease?, to? }  (pulse/step)
//   destroy — { id, type:"destroy", beat }
//
// All timing fields (`beat`, `dur`) are in **beats** (beat 1 = the first frame;
// `dur` is a length in beats). Rasterization bakes onto the internal frame grid
// — FRAMES_PER_BEAT frames per beat — one output row per alive object per frame.
// ----------------------------------------------------------------------------

import { withLineage, unionLineage, type Row } from './lineage.js'
import { mixColor } from './color.js'
import { beatToFrame, beatsToFrames } from './constants.js'

interface SampledState {
  fields: Row
  sources: Row[]
}

// Fields rasterize interprets itself (timing, transform, color, bookkeeping).
// Anything else on an event — e.g. a custom field, or a { $expr } streaming
// binding from setField("amount", midi("c4")) — is "extra": carried through to
// each baked frame row untouched, to be read (and bindings resolved) at playback.
const RESERVED = new Set([
  'id', 'type', 'beat', 'dur', 'ease', 'to', 'shape', 'color',
  'px', 'py', 'pz', 'rx', 'ry', 'rz', 'frame',
])

// Accumulate the non-reserved fields visible at frame `i` (events at-or-before
// `i`, last write wins), so a field set on create — or updated later — sticks.
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

// Resolve an event's timing to the internal frame grid: `beat` (1-indexed) → its
// cache frame, `dur` (a length in beats) → frames.
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

// `color` events are a pulse/step, not a keyframe: a bare `color` event is a
// hard switch (newest wins), while `dur` decays from `color` back to `to`
// (or the object's base color) eased over `dur` frames.
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

function sampleObject(events: Row[], i: number): SampledState | null {
  const createEv = events.find((e) => e.type === 'create')
  if (!createEv || i < (createEv.frame as number)) return null
  if (events.some((e) => e.type === 'destroy' && (e.frame as number) <= i)) return null

  const keyframes = events.filter((e) => e.type === 'create' || e.type === 'update')
  let from: Row | null = keyframes[0] ?? null
  let to: Row | null = null
  for (const kf of keyframes) {
    if ((kf.frame as number) <= i) from = kf
    else if (!to) to = kf
  }

  const fields: Row = { ...createEv }
  if (from) {
    for (const [k, v] of Object.entries(from))
      if (typeof v === 'number') fields[k] = v
  }
  if (from && to) {
    const t = (i - (from.frame as number)) / ((to.frame as number) - (from.frame as number))
    for (const [k, v] of Object.entries(to))
      if (typeof v === 'number' && typeof from[k] === 'number')
        fields[k] = lerp(from[k] as number, v, t)
  }
  // Non-numeric custom fields — e.g. a { $expr } streaming binding from
  // setField("amount", midi("c4")) — don't lerp; carry the most recent
  // event's value through untouched (resolved per frame at playback).
  Object.assign(fields, gatherExtra(events, i))

  const { color, source: colorSource } = sampleColor(events, createEv, i)
  fields.color = color

  const sources = [createEv, from, to, colorSource].filter((x): x is Row => x !== null)
  return { fields, sources }
}

export function rasterizeRows(eventRows: Row[] | null | undefined, maxBeats?: number): Row[] {
  const events = (eventRows ?? []).map(toFrameEvent)
  const timelines = buildTimelines(events)
  const max = maxBeats != null
    ? Math.max(0, beatsToFrames(maxBeats))
    : events.reduce((m, e) => Math.max(m, (e.frame as number) ?? 0), 0)

  const out: Row[] = []
  for (let frame = 0; frame <= max; frame++) {
    for (const evs of timelines.values()) {
      const s = sampleObject(evs, frame)
      if (!s) continue
      // `frame` is the baked coordinate; drop the sparse `beat` keyframe field so
      // the dense cache carries only its frame position.
      const { beat: _beat, ...fields } = s.fields
      out.push(withLineage({ ...fields, frame, id: evs[0].id }, unionLineage(s.sources)))
    }
  }
  return out
}

export interface FrameIndex {
  map: Map<number, Row[]>
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

// Transform fields interpolated between adjacent cache frames. Everything else
// (color, shape, id, streaming bindings, …) is discrete: it takes the earlier
// frame's value, never a blend.
const INTERP_FIELDS = ['px', 'py', 'pz', 'rx', 'ry', 'rz'] as const

// State at a *fractional* frame: the floored frame's rows with their transform
// fields eased toward the next frame by the fractional part. The dense cache is
// already baked at 60fps, so this is what keeps motion smooth when the playhead
// crosses cache frames slower than one-per-render (a slow tempo, or a >60Hz
// display). An object present at the floor frame but not the next (about to be
// destroyed) is left un-eased. Falls back to a plain lookup at integer frames.
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
