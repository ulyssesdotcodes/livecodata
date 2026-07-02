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
import { mixColor } from './color.js'
import { FPS } from './constants.js'

interface Vec3 {
  x: number
  y: number
  z: number
}

interface SampledState {
  shape: unknown
  pos: Vec3
  rot: Vec3
  color: number | null
  sources: Row[]
  extra: Row
}

// Fields computed explicitly per frame (position/rotation/color/bookkeeping) —
// everything else on a create event (hx/hy/hz, r, texture, …) is a static shape
// dimension/dressing field that should pass through to every rasterized frame.
const COMPUTED_FIELDS = new Set([
  'id', 'type', 'index', 'dur', 'ease', 'to', 'shape', 'px', 'py', 'pz', 'rx', 'ry', 'rz', 'color', 'frame',
])

function extraDims(createEv: Row): Row {
  const extra: Row = {}
  for (const [k, v] of Object.entries(createEv)) {
    if (!COMPUTED_FIELDS.has(k)) extra[k] = v
  }
  return extra
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function hasPosition(e: Row): boolean {
  return typeof e.px === 'number'
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

  const keyframes = events.filter(hasPosition)
  let from: Row | null = keyframes[0] ?? null
  let to: Row | null = null
  for (const kf of keyframes) {
    if ((kf.index as number) <= i) from = kf
    else if (!to) to = kf
  }

  let pos: Vec3
  let rot: Vec3
  if (from && to) {
    const f = (i - (from.index as number)) / ((to.index as number) - (from.index as number))
    pos = { x: lerp(from.px as number, to.px as number, f), y: lerp(from.py as number, to.py as number, f), z: lerp(from.pz as number, to.pz as number, f) }
    rot = { x: lerp(from.rx as number, to.rx as number, f), y: lerp(from.ry as number, to.ry as number, f), z: lerp(from.rz as number, to.rz as number, f) }
  } else if (from) {
    pos = { x: from.px as number, y: from.py as number, z: from.pz as number }
    rot = { x: from.rx as number, y: from.ry as number, z: from.rz as number }
  } else {
    pos = { x: 0, y: 0, z: 0 }
    rot = { x: 0, y: 0, z: 0 }
  }

  let colorEv: Row | null = null
  for (const e of events) {
    if ((e.index as number) <= i && e.color != null) colorEv = e
  }
  let color: number | null = (createEv.color as number | null | undefined) ?? null
  if (colorEv) {
    const dur = colorEv.dur as number | undefined
    if (dur != null && dur > 0) {
      const base = colorEv.to != null ? (colorEv.to as number | null) : ((createEv.color as number | null | undefined) ?? (colorEv.color as number | null))
      const p = Math.min(1, Math.max(0, (i - (colorEv.index as number)) / dur))
      const easeFn = colorEv.ease as ((t: number) => number) | undefined
      const eased = typeof easeFn === 'function' ? easeFn(p) : p
      color = mixColor(colorEv.color as number | null, base as number | null, eased)
    } else {
      color = colorEv.color as number | null
    }
  }

  const sources = [createEv, from, to, colorEv].filter((x): x is Row => x !== null)
  return { shape: createEv.shape, pos, rot, color, sources, extra: extraDims(createEv) }
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
      out.push(withLineage({
        ...s.extra,
        frame, id: evs[0].id, shape: s.shape,
        px: s.pos.x, py: s.pos.y, pz: s.pos.z,
        rx: s.rot.x, ry: s.rot.y, rz: s.rot.z,
        color: s.color,
      }, unionLineage(s.sources)))
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
