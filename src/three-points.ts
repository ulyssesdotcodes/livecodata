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
  const n = (v: unknown): number => (typeof v === 'number' ? v : 0)
  for (const r of rows) {
    positions.push(n(r.px), n(r.py), n(r.pz))
    if (r.nx == null || r.ny == null || r.nz == null) haveNormals = false
    else normals.push(n(r.nx), n(r.ny), n(r.nz))
  }
  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
  if (haveNormals && normals.length === positions.length) {
    geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3))
  }
  return geometry
}
