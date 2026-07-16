// three.js primitives ⇄ tables of points
// ----------------------------------------------------------------------------
// The bridge between a three.js primitive (a BufferGeometry) and the DSL's data
// model (a table of plain rows). It goes both ways:
//
//   primitive → points table   pointsFromGeometry(geo)   — one row per vertex,
//                                                           { i, px,py,pz, nx,ny,nz }
//   points table → primitive    geometryFromPoints(rows)  — a BufferGeometry with
//                                                           position (+ normal) attrs
//
// Both are pure geometry math — no WebGL, no DOM — so they run in the cook
// worker (where user programs are evaluated) just as happily as on the render
// thread. That's why the primitive builder lives here rather than in
// three-scene.ts: it stays dependency-light (no fonts / TextGeometry), and the
// renderer imports it, so a box sampled by points("box") is the SAME geometry
// the renderer draws for box() — same shared SHAPE_DEFAULTS, same tessellation.
// ----------------------------------------------------------------------------

import {
  BufferGeometry,
  Float32BufferAttribute,
  BoxGeometry,
  SphereGeometry,
  CylinderGeometry,
  ConeGeometry,
  TorusGeometry,
} from 'three'
import { SHAPE_DEFAULTS } from './shapes.js'
import type { Row } from './lineage.js'

export interface GeometryDims { hx: number; hy: number; hz: number; r: number; h: number }

// The subset of a row's fields that determine geometry size, merged with the
// shape's defaults — used to build the geometry and (in three-scene) to detect a
// size change that means the geometry must be rebuilt. Lives here so both the
// renderer and the points sampler read one definition.
export function geometryDims(shape: string, dims: Record<string, unknown>): GeometryDims {
  const d = { ...(SHAPE_DEFAULTS[shape] ?? SHAPE_DEFAULTS.box), ...dims }
  return { hx: d.hx as number, hy: d.hy as number, hz: d.hz as number, r: d.r as number, h: d.h as number }
}

// How finely to tessellate a primitive when sampling it. Omitted, each shape
// uses the renderer's own segment counts, so the sampled points land exactly on
// the mesh the renderer draws; a `segments` bumps the density up (more rows) for
// a denser point cloud without changing the silhouette.
export interface PrimitiveOptions { segments?: number }

// Build the primitive BufferGeometry for a named shape from a size row. With no
// options this reproduces three-scene's renderer geometry byte-for-byte (the
// renderer delegates here), so the two never drift; a `segments` override raises
// the tessellation for a denser sampling.
export function primitiveGeometry(
  shape: string,
  dims: Record<string, unknown>,
  opts: PrimitiveOptions = {},
): BufferGeometry {
  const { hx, hy, hz, r, h } = geometryDims(shape, dims)
  const s = opts.segments
  switch (shape) {
    case 'sphere':   return new SphereGeometry(r, s ?? 32, s ?? 32)
    case 'cylinder': return new CylinderGeometry(r, r, h * 2, s ?? 32)
    case 'cone':     return new ConeGeometry(r, h * 2, s ?? 32)
    case 'torus':    return new TorusGeometry(r, 0.08, s ? Math.max(3, Math.round(s / 4)) : 16, s ? s * 2 : 64)
    case 'box':
    default:         return s ? new BoxGeometry(hx * 2, hy * 2, hz * 2, s, s, s) : new BoxGeometry(hx * 2, hy * 2, hz * 2)
  }
}

// A three.js primitive → a table of its vertices with normals: one row per
// vertex in the geometry's position attribute, `i` its index, px/py/pz the
// position, nx/ny/nz the normal (present only if the geometry carries a normal
// attribute — every primitive above does). Coordinates are in the geometry's own
// local space (centered on the origin, like the meshes the renderer builds).
export function pointsFromGeometry(geometry: BufferGeometry): Row[] {
  const pos = geometry.getAttribute('position')
  if (!pos) return []
  const nrm = geometry.getAttribute('normal')
  const out: Row[] = new Array(pos.count)
  for (let i = 0; i < pos.count; i++) {
    const row: Row = { i, px: pos.getX(i), py: pos.getY(i), pz: pos.getZ(i) }
    if (nrm) {
      row.nx = nrm.getX(i)
      row.ny = nrm.getY(i)
      row.nz = nrm.getZ(i)
    }
    out[i] = row
  }
  return out
}

// A table of points → a three.js primitive: a BufferGeometry whose `position`
// attribute is the rows' px/py/pz. If every row carries a full nx/ny/nz normal
// the `normal` attribute is set too; otherwise it's left off (three can derive
// face normals, or a caller can computeVertexNormals()). Missing coordinates
// read as 0. The inverse of pointsFromGeometry: sampling a primitive and feeding
// the rows back here round-trips to an equivalent geometry.
export function geometryFromPoints(rows: Row[]): BufferGeometry {
  const positions: number[] = []
  const normals: number[] = []
  let haveNormals = rows.length > 0
  for (const r of rows) {
    positions.push(numOr0(r.px), numOr0(r.py), numOr0(r.pz))
    if (r.nx == null || r.ny == null || r.nz == null) haveNormals = false
    else normals.push(numOr0(r.nx), numOr0(r.ny), numOr0(r.nz))
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  if (haveNormals && normals.length === positions.length) {
    geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3))
  }
  return geometry
}

const numOr0 = (v: unknown): number => (typeof v === 'number' ? v : 0)

// ── Animated point cloud: a beat-keyed points table → scene events ───────────
// A points table carries a `beat` column (see the DSL's points()), so different
// beats can hold the object in different poses — a morphing / breathing cloud.
// pointCloudEvents packs that table into the scene's event stream for ONE object
// (shape "points"): the earliest beat becomes the `create`, each later beat an
// `update`, and each event carries THAT beat's vertices as flat position/normal
// buffers (ptPos/ptNrm) plus a discrete `ptKey` so the renderer re-uploads the
// GPU buffer only when the beat actually changes.
//
// The rendered geometry holds a FIXED-SIZE buffer, so every beat that defines
// points must define the SAME number of them — a differing count throws here (at
// cook time), rather than silently truncating or reallocating mid-playback.
export function pointCloudEvents(rows: Row[], props: Row = {}): Row[] {
  const { id = 'points', ...rest } = props
  const byBeat = new Map<number, Row[]>()
  for (const r of rows) {
    const b = typeof r.beat === 'number' ? r.beat : 1
    let bucket = byBeat.get(b)
    if (!bucket) byBeat.set(b, (bucket = []))
    bucket.push(r)
  }
  const beats = [...byBeat.keys()].sort((a, b) => a - b)
  if (!beats.length) return []

  const count = byBeat.get(beats[0])!.length
  for (const b of beats) {
    const n = byBeat.get(b)!.length
    if (n !== count) {
      throw new Error(
        `pointCloud: beat ${b} defines ${n} point(s) but beat ${beats[0]} defines ${count} — a rendered point cloud must keep the same number of points across every beat where points are defined`,
      )
    }
  }

  return beats.map((b, k) => {
    const pts = byBeat.get(b)!
    const position: number[] = []
    const normal: number[] = []
    let hasNormals = true
    for (const p of pts) {
      position.push(numOr0(p.px), numOr0(p.py), numOr0(p.pz))
      if (p.nx == null || p.ny == null || p.nz == null) hasNormals = false
      else normal.push(numOr0(p.nx), numOr0(p.ny), numOr0(p.nz))
    }
    const event: Row = k === 0
      ? { id, type: 'create', beat: b, shape: 'points', px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, ...rest }
      : { id, type: 'update', beat: b }
    event.ptKey = String(b)
    event.ptPos = position
    event.ptNrm = hasNormals && normal.length === position.length ? normal : null
    return event
  })
}
