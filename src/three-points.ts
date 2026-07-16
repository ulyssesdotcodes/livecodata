// three.js primitives ⇄ tables of points. Pure geometry math — no WebGL, no
// DOM — so it runs in the cook worker as well as the render thread. The
// primitive builder lives here (not three-scene.ts) and the renderer imports
// it, so a box sampled by points("box") is the SAME geometry the renderer
// draws for box().

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

export function geometryDims(shape: string, dims: Record<string, unknown>): GeometryDims {
  const d = { ...(SHAPE_DEFAULTS[shape] ?? SHAPE_DEFAULTS.box), ...dims }
  return { hx: d.hx as number, hy: d.hy as number, hz: d.hz as number, r: d.r as number, h: d.h as number }
}

// With `segments` omitted, each shape uses the renderer's own segment counts,
// so sampled points land exactly on the drawn mesh; setting it raises density
// without changing the silhouette.
export interface PrimitiveOptions { segments?: number }

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

// One row per vertex: { i, px..pz, nx..nz }. Normals only when the geometry
// carries them; coordinates are in the geometry's local, origin-centered space.
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

// Inverse of pointsFromGeometry. The `normal` attribute is set only when every
// row carries a full nx/ny/nz; missing coordinates read as 0.
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
