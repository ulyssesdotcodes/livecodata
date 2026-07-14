// livecodata rasterize — sparse events → dense frame cache
// ----------------------------------------------------------------------------
// Houdini-style "bake": expand a sparse table of object keyframe/events into a
// dense, frame-indexed table of world state — one row per alive object per
// frame. This is the interpolation that used to live in the renderer, lifted
// out so it is plain table data the DSL produces and the user can inspect.
//
// Input event rows (sparse), keyed by object `id`, ordered by `beat`:
//   create  — { id, type:"create", beat, shape, px,py,pz, rx,ry,rz, color? }
//   update  — { id, type:"update", beat, px,py,pz, rx,ry,rz, ease? }  (keyframe)
//   color   — { id, type:"color",  beat, color, dur?, ease?, to? }  (pulse/step)
//   destroy — { id, type:"destroy", beat }
//
// Every numeric field is its own keyframe TRACK: it eases between the
// previous and next keyframe that carry it — the transform, but equally
// custom numerics (origami fold fractions, hydra variables) — and keyframes
// that omit a field don't interrupt its glide. An `ease` function on a
// keyframe shapes the segment arriving at it. Non-numeric custom fields step
// (most recent event wins).
//
// All timing fields (`beat`, `dur`) are in **beats** (beat 1 = the first frame;
// `dur` is a length in beats). Rasterization bakes onto the internal frame grid
// — FRAMES_PER_BEAT frames per beat — one output row per alive object per frame.
//
// Multi-loop sequences: an optional 0-indexed `loop` column next to `beat`
// places an event in a later pass of the loop. Every pass shares one length
// (the given maxBeats, else the largest event beat in any pass), so the events
// sit on an extended frame grid at loop * span + frame — and interpolation
// works across a loop boundary exactly as it does within one. Playback keeps
// wrapping per loop and picks the pass by how many wall-aligned loops have
// elapsed since the content last changed (see playback.ts's wallAlignedLoop).
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
  'id', 'type', 'beat', 'loop', 'dur', 'ease', 'to', 'shape', 'color',
  'px', 'py', 'pz', 'rx', 'ry', 'rz', 'sx', 'sy', 'sz', 'frame',
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
// cache frame, `dur` (a length in beats) → frames, `loop` (0-indexed pass of
// the loop) normalized to a non-negative integer (rows without one sit in
// pass 0).
function toFrameEvent(e: Row): Row {
  const ev = { ...e }
  ev.frame = beatToFrame((e.beat as number | undefined) ?? 1)
  ev.loop = typeof e.loop === 'number' ? Math.max(0, Math.floor(e.loop)) : 0
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

// Numeric keyframe fields that must NOT be interpolated as tracks: timing
// bookkeeping, identity, and color (which has its own pulse semantics).
const NO_TRACK = new Set(['frame', 'beat', 'loop', 'dur', 'id', 'color'])

function sampleObject(events: Row[], i: number): SampledState | null {
  const createEv = events.find((e) => e.type === 'create')
  if (!createEv || i < (createEv.frame as number)) return null
  if (events.some((e) => e.type === 'destroy' && (e.frame as number) <= i)) return null

  const keyframes = events.filter((e) => e.type === 'create' || e.type === 'update')

  const fields: Row = { ...createEv }
  // Custom fields — a { $expr } streaming binding from setField("amount",
  // midi("c4")), a string, … — carry the most recent event's value through
  // (last write wins, whatever the event type).
  Object.assign(fields, gatherExtra(events, i))

  // Numeric fields are per-field TRACKS: each one eases between the previous
  // and next keyframe that actually carry it — px/py/pz and rx/ry/rz, but
  // equally custom numerics like origami fold fractions. Keyframes that omit
  // a field don't interrupt its glide (so a fold schedule and a slow rotation
  // interleave freely). An `ease` function on the destination keyframe shapes
  // that segment.
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

  // The baked row is a `create` only on the object's create frame; every later
  // frame is an `update` of its fields. Spreading `createEv` above seeded
  // `type: 'create'` onto all of them, which made the dense cache read as a
  // scene-wide wall of creates instead of one create followed by updates.
  fields.type = i === (createEv.frame as number) ? 'create' : 'update'

  return { fields, sources: [...sources] }
}

export function rasterizeRows(eventRows: Row[] | null | undefined, maxBeats?: number): Row[] {
  const events = (eventRows ?? []).map(toFrameEvent)
  // One pass of the loop spans `span` frames — the given maxBeats, else the
  // largest event beat in ANY pass, so every pass is the same length. Events in
  // pass L then sit at L * span + frame on the extended grid, and the ordinary
  // keyframe machinery below interpolates across loop boundaries for free.
  const loops = events.reduce((m, e) => Math.max(m, e.loop as number), 0) + 1
  const span = maxBeats != null
    ? Math.max(0, beatsToFrames(maxBeats))
    : events.reduce((m, e) => Math.max(m, (e.frame as number) ?? 0), 0)
  for (const e of events) e.frame = (e.frame as number) + (e.loop as number) * span
  const timelines = buildTimelines(events)
  // A multi-loop cache bakes every pass out to its full span (so the last pass
  // holds to the loop boundary like the others); a single loop keeps its
  // natural extent.
  const max = loops > 1 ? loops * span : span

  const out: Row[] = []
  for (let frame = 0; frame <= max; frame++) {
    // Which pass of the loop this baked frame belongs to — carried on the dense
    // rows (only when there are several) so buildFrameIndex can recover the
    // per-loop span.
    const loop = loops > 1 && span > 0 ? Math.min(loops - 1, Math.floor(frame / span)) : null
    for (const evs of timelines.values()) {
      const s = sampleObject(evs, frame)
      if (!s) continue
      // `frame` is the baked coordinate; drop the sparse `beat`/`loop` keyframe
      // fields so the dense cache carries only its frame position (plus which
      // pass it falls in, when multi-loop).
      const { beat: _beat, loop: _loop, ...fields } = s.fields
      const baked = loop != null ? { ...fields, frame, loop, id: evs[0].id } : { ...fields, frame, id: evs[0].id }
      out.push(withLineage(baked, unionLineage(s.sources)))
    }
  }
  return out
}

export interface FrameIndex {
  map: Map<number, Row[]>
  // Total extent of the baked cache in frames, across every pass of the loop.
  maxFrame: number
  // Multi-loop sequences: how many passes the cache spans, and the per-pass
  // frame span. A cache with no `loop` column is one pass: loops = 1 and
  // loopFrames = maxFrame, so the playhead's loop length is unchanged.
  loops: number
  loopFrames: number
}

export function buildFrameIndex(sceneRows: Row[]): FrameIndex {
  const map = new Map<number, Row[]>()
  let maxFrame = 0
  let maxLoop = 0
  for (const r of sceneRows ?? []) {
    const f = (r.frame as number | undefined) ?? 0
    if (!map.has(f)) map.set(f, [])
    map.get(f)!.push(r)
    if (f > maxFrame) maxFrame = f
    const l = r.loop as number | undefined
    if (typeof l === 'number' && l > maxLoop) maxLoop = l
  }
  const loops = maxLoop + 1
  // rasterizeRows bakes a multi-loop cache to exactly loops * span frames, so
  // the per-pass span is recoverable from the total extent.
  const loopFrames = loops > 1 ? Math.round(maxFrame / loops) : maxFrame
  return { map, maxFrame, loops, loopFrames }
}

export function stateAtFrame(frameIndex: FrameIndex, i: number): Row[] {
  const f = Math.floor(i)
  if (f < 0) return []
  return frameIndex.map.get(f) ?? []
}

// Transform fields interpolated between adjacent cache frames. Everything else
// (color, shape, id, streaming bindings, …) is discrete: it takes the earlier
// frame's value, never a blend.
const INTERP_FIELDS = ['px', 'py', 'pz', 'rx', 'ry', 'rz', 'sx', 'sy', 'sz'] as const

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
