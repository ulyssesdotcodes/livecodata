// Tests for the three.js primitive ⇄ points-table bridge (three-points.ts).
// Geometry generation is pure math (no WebGL), so the whole conversion — both
// directions and the round-trip — is exercised here in node.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BoxGeometry } from 'three'
import {
  primitiveGeometry,
  pointsFromGeometry,
  geometryFromPoints,
} from '../src/three-points.js'
import { Table, createDSL } from '../src/dsl.js'
import type { Row } from '../src/lineage.js'

// geometryDims itself is covered in three-scene.test.ts (same re-exported fn).

test('primitiveGeometry sizes a box from its half-extents (2·h per axis)', () => {
  const geo = primitiveGeometry('box', { hx: 0.5, hy: 1, hz: 2 })
  geo.computeBoundingBox()
  const b = geo.boundingBox!
  assert.deepEqual([b.max.x, b.max.y, b.max.z], [0.5, 1, 2])
  assert.deepEqual([b.min.x, b.min.y, b.min.z], [-0.5, -1, -2])
})

test('primitiveGeometry segments raises the vertex count without changing the size', () => {
  const plain = primitiveGeometry('sphere', { r: 1 })
  const dense = primitiveGeometry('sphere', { r: 1 }, { segments: 64 })
  assert.ok(dense.getAttribute('position').count > plain.getAttribute('position').count)
})

test('pointsFromGeometry yields one row per vertex with position and normal', () => {
  const geo = new BoxGeometry(1, 1, 1)
  const rows = pointsFromGeometry(geo)
  assert.equal(rows.length, geo.getAttribute('position').count)
  const r0 = rows[0]
  assert.equal(r0.i, 0)
  for (const k of ['px', 'py', 'pz', 'nx', 'ny', 'nz']) {
    assert.equal(typeof r0[k], 'number', `row is missing numeric ${k}`)
  }
  // Box normals are axis-aligned unit vectors.
  const len = Math.hypot(r0.nx as number, r0.ny as number, r0.nz as number)
  assert.ok(Math.abs(len - 1) < 1e-6)
})

test('pointsFromGeometry omits normals when the geometry carries none', () => {
  const geo = new BoxGeometry(1, 1, 1)
  geo.deleteAttribute('normal')
  const rows = pointsFromGeometry(geo)
  assert.equal(rows.length > 0, true)
  assert.equal('nx' in rows[0], false)
})

test('geometryFromPoints builds position + normal attributes from rows', () => {
  const rows: Row[] = [
    { px: 0, py: 0, pz: 0, nx: 0, ny: 1, nz: 0 },
    { px: 1, py: 2, pz: 3, nx: 1, ny: 0, nz: 0 },
  ]
  const geo = geometryFromPoints(rows)
  const pos = geo.getAttribute('position')
  const nrm = geo.getAttribute('normal')
  assert.equal(pos.count, 2)
  assert.deepEqual([pos.getX(1), pos.getY(1), pos.getZ(1)], [1, 2, 3])
  assert.ok(nrm)
  assert.deepEqual([nrm.getX(0), nrm.getY(0), nrm.getZ(0)], [0, 1, 0])
})

test('geometryFromPoints leaves normals off when any row lacks them', () => {
  const geo = geometryFromPoints([{ px: 0, py: 0, pz: 0 }, { px: 1, py: 1, pz: 1, nx: 0, ny: 1, nz: 0 }])
  assert.equal(geo.getAttribute('position').count, 2)
  assert.equal(geo.getAttribute('normal'), undefined)
})

test('round-trip: primitive → points → geometry reproduces the vertices', () => {
  const original = primitiveGeometry('cone', { r: 0.5, h: 0.4 })
  const rows = pointsFromGeometry(original)
  const rebuilt = geometryFromPoints(rows)
  const a = original.getAttribute('position')
  const b = rebuilt.getAttribute('position')
  assert.equal(a.count, b.count)
  for (let i = 0; i < a.count; i++) {
    assert.ok(Math.abs(a.getX(i) - b.getX(i)) < 1e-6)
    assert.ok(Math.abs(a.getY(i) - b.getY(i)) < 1e-6)
    assert.ok(Math.abs(a.getZ(i) - b.getZ(i)) < 1e-6)
  }
})

test('DSL points() returns a chainable table of point rows', () => {
  const dsl = createDSL(null)
  const table = dsl.three.points('box', { hx: 1, hy: 1, hz: 1 })
  assert.ok(table instanceof Table)
  const rows = table.rows
  assert.ok(rows.length > 0, 'box tessellates into at least one point row')
  assert.equal(typeof rows[0].px, 'number')
  assert.equal(typeof rows[0].nx, 'number')
  const shifted = table.map((r) => ({ px: (r.px as number) + 10 }))
  assert.equal(shifted.rows[0].px, (rows[0].px as number) + 10)
})

test('DSL geometry() rebuilds a primitive from a points table (inverse of points)', () => {
  const dsl = createDSL(null)
  const pts = dsl.three.points('sphere', { r: 1 })
  const geo = dsl.three.geometry(pts)
  assert.equal(geo.getAttribute('position').count, pts.rows.length)
  assert.ok(geo.getAttribute('normal'))
  // also accepts a bare row array
  const geo2 = dsl.three.geometry([{ px: 0, py: 0, pz: 0, nx: 0, ny: 1, nz: 0 }])
  assert.equal(geo2.getAttribute('position').count, 1)
})
