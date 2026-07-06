// livecodata rasterize — sparse events → dense frame cache
// ----------------------------------------------------------------------------
// Houdini-style "bake": expand a sparse table of object keyframe/events into a
// dense, frame-indexed table of world state — one row per alive object per
// frame. This is the interpolation that used to live in the renderer, lifted
// out so it is plain table data the DSL produces and the user can inspect.
//
// Input event rows (sparse), keyed by object `id`, ordered by `index`:
//   create  — { id, type:"create", index, shape, px,py,pz, rx,ry,rz, color? }
//   update  — { id, type:"update", index, px,py,pz, rx,ry,rz }  (movement keyframe)
//   color   — { id, type:"color",  index, color, dur?, ease?, to? }  (pulse/step)
//   destroy — { id, type:"destroy", index }
//
// All timing fields (`index`, `dur`) are in **seconds**. Rasterization bakes at
// FPS (60) internally — one output frame per 1/60s.
// ----------------------------------------------------------------------------

import { withLineage, unionLineage, type Row } from './lineage.js'
import { FPS } from './constants.js'

interface SampledState {
  fields: Row
  sources: Row[]
}

// Fields rasterize interprets itself (timing, transform, color, bookkeeping).
// Anything else on an event — e.g. a custom field, or a { $expr } streaming
// binding from setField("amount", midi("c4")) — is "extra": carried through to
// each baked frame row untouched, to be read (and bindings resolved) at playback.
const RESERVED = new Set([
  'id', 'type', 'index', 'dur', 'ease', 'to', 'shape', 'color',
  'px', 'py', 'pz', 'rx', 'ry', 'rz', 'frame',
])

// Accumulate the non-reserved fields visible at frame `i` (events at-or-before
// `i`, last write wins), so a field set on create — or updated later — sticks.
function gatherExtra(events: Row[], i: number): Row {
  const extra: Row = {}
  for (const e of events) {
    if ((e.index as number) > i) continue
    for (const k in e) {
      if (!RESERVED.has(k)) extra[k] = e[k]
    }
  }
  return extra
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function toFrameEvent(e: Row): Row {
  const ev = { ...e }
  if (ev.index != null) ev.index = Math.round((ev.index as number) * FPS)
  if (ev.dur != null) ev.dur = (ev.dur as number) * FPS
  return ev
}

function buildTimelines(events: Row[]): Map<unknown, Row[]> {
  const map = new Map<unknown, Row[]>()
  for (const e of events) {
    if (e.id == null) continue
    if (!map.has(e.id)) map.set(e.id, [])
    map.get(e.id)!.push({ ...e })
  }
  for (const evs of map.values()) evs.sort((a, b) => (a.index as number) - (b.index as number))
  return map
}

function sampleObject(events: Row[], i: number): SampledState | null {
  const createEv = events.find((e) => e.type === 'create')
  if (!createEv || i < (createEv.index as number)) return null
  if (events.some((e) => e.type === 'destroy' && (e.index as number) <= i)) return null

  const keyframes = events.filter((e) => e.type === 'create' || e.type === 'update')
  let from: Row | null = keyframes[0] ?? null
  let to: Row | null = null
  for (const kf of keyframes) {
    if ((kf.index as number) <= i) from = kf
    else if (!to) to = kf
  }

  const fields: Row = { ...createEv }
  if (from) {
    for (const [k, v] of Object.entries(from))
      if (typeof v === 'number') fields[k] = v
  }
  if (from && to) {
    const t = (i - (from.index as number)) / ((to.index as number) - (from.index as number))
    for (const [k, v] of Object.entries(to))
      if (typeof v === 'number' && typeof from[k] === 'number')
        fields[k] = lerp(from[k] as number, v, t)
  }
  // Non-numeric custom fields — e.g. a { $expr } streaming binding from
  // setField("amount", midi("c4")) — don't lerp; carry the most recent
  // event's value through untouched (resolved per frame at playback).
  Object.assign(fields, gatherExtra(events, i))

  const sources = [createEv, from, to].filter((x): x is Row => x !== null)
  return { fields, sources }
}

export function rasterizeRows(eventRows: Row[] | null | undefined, maxSeconds?: number): Row[] {
  const events = (eventRows ?? []).map(toFrameEvent)
  const timelines = buildTimelines(events)
  const max = maxSeconds != null
    ? Math.max(0, Math.round(maxSeconds * FPS))
    : events.reduce((m, e) => Math.max(m, (e.index as number) ?? 0), 0)

  const out: Row[] = []
  for (let frame = 0; frame <= max; frame++) {
    for (const evs of timelines.values()) {
      const s = sampleObject(evs, frame)
      if (!s) continue
      out.push(withLineage({ ...s.fields, frame, id: evs[0].id }, unionLineage(s.sources)))
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
