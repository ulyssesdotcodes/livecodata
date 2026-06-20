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
//   color   — { id, type:"color",  index, color }               (step change)
//   destroy — { id, type:"destroy", index }
//
// Output cache rows (dense):
//   { frame, id, shape, px,py,pz, rx,ry,rz, color }
// Playback indexes straight into this with stateAtFrame(); no interpolation at
// render time.
// ----------------------------------------------------------------------------

function lerp(a, b, t) { return a + (b - a) * t }

// An event is a movement keyframe (carries position) when it has numeric px.
function hasPosition(e) { return typeof e.px === 'number' }

function buildTimelines(events) {
  const map = new Map()
  for (const e of events) {
    if (e.id == null) continue
    if (!map.has(e.id)) map.set(e.id, [])
    map.get(e.id).push({ ...e })
  }
  for (const evs of map.values()) evs.sort((a, b) => a.index - b.index)
  return map
}

// Sample one object's full state at frame i, or null if it doesn't exist yet
// (or has been destroyed). Position/rotation are interpolated between movement
// keyframes; color is a step function (latest color-bearing event <= i).
function sampleObject(events, i) {
  const createEv = events.find((e) => e.type === 'create')
  if (!createEv || i < createEv.index) return null
  if (events.some((e) => e.type === 'destroy' && e.index <= i)) return null

  const keyframes = events.filter(hasPosition)
  let from = keyframes[0], to = null
  for (const kf of keyframes) {
    if (kf.index <= i) from = kf
    else if (!to) to = kf
  }

  let pos, rot
  if (from && to) {
    const f = (i - from.index) / (to.index - from.index)
    pos = { x: lerp(from.px, to.px, f), y: lerp(from.py, to.py, f), z: lerp(from.pz, to.pz, f) }
    rot = { x: lerp(from.rx, to.rx, f), y: lerp(from.ry, to.ry, f), z: lerp(from.rz, to.rz, f) }
  } else if (from) {
    pos = { x: from.px, y: from.py, z: from.pz }
    rot = { x: from.rx, y: from.ry, z: from.rz }
  } else {
    pos = { x: 0, y: 0, z: 0 }
    rot = { x: 0, y: 0, z: 0 }
  }

  let color = null
  for (const e of events) {
    if (e.index <= i && e.color != null) color = e.color
  }

  return { shape: createEv.shape, pos, rot, color }
}

// Bake event rows into a dense frame cache. `maxFrame` sets the timeline length
// (frames 0..maxFrame inclusive); when omitted it is inferred from the largest
// event index. One output row per alive object per frame.
export function rasterizeRows(eventRows, maxFrame) {
  const events = eventRows ?? []
  const timelines = buildTimelines(events)
  const max = maxFrame != null
    ? Math.max(0, Math.round(maxFrame))
    : events.reduce((m, e) => Math.max(m, e.index ?? 0), 0)

  const out = []
  for (let frame = 0; frame <= max; frame++) {
    for (const evs of timelines.values()) {
      const s = sampleObject(evs, frame)
      if (!s) continue
      out.push({
        frame, id: evs[0].id, shape: s.shape,
        px: s.pos.x, py: s.pos.y, pz: s.pos.z,
        rx: s.rot.x, ry: s.rot.y, rz: s.rot.z,
        color: s.color,
      })
    }
  }
  return out
}

// Index a dense cache by frame for O(1) lookup. Returns { map, maxFrame } where
// map is Map<frame, row[]>. maxFrame is the largest frame that carries state.
export function buildFrameIndex(sceneRows) {
  const map = new Map()
  let maxFrame = 0
  for (const r of sceneRows ?? []) {
    const f = r.frame ?? 0
    if (!map.has(f)) map.set(f, [])
    map.get(f).push(r)
    if (f > maxFrame) maxFrame = f
  }
  return { map, maxFrame }
}

// The object states at (the integer floor of) frame i — a pure cache lookup.
export function stateAtFrame(frameIndex, i) {
  const f = Math.floor(i)
  if (f < 0) return []
  return frameIndex.map.get(f) ?? []
}
