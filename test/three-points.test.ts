// Tests for the three.js primitive ⇄ points-table bridge (three-points.ts).
// Geometry generation is pure math (no WebGL), so the whole conversion — both
// directions and the round-trip — is exercised here in node.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BoxGeometry } from 'three'
import {
  geometryDims,
  primitiveGeometry,
  pointsFromGeometry,
  geometryFromPoints,
  pointCloudEvents,
} from '../src/three-points.js'
import { Table, createDSL } from '../src/dsl.js'
import type { Row } from '../src/lineage.js'

test('geometryDims merges shape defaults with the row (matches the renderer)', () => {
  assert.deepEqual(geometryDims('box', {}), { hx: 0.25, hy: 0.25, hz: 0.25, r: undefined, h: undefined })
  assert.deepEqual(geometryDims('box', { hx: 0.04 }), { hx: 0.04, hy: 0.25, hz: 0.25, r: undefined, h: undefined })
  assert.deepEqual(geometryDims('sphere', {}), { hx: undefined, hy: undefined, hz: undefined, r: 0.3, h: undefined })
})

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

test('DSL points() returns a chainable table of point rows with a beat column', () => {
  const dsl = createDSL(null)
  const table = dsl.points('box', { hx: 1, hy: 1, hz: 1 })
  assert.ok(table instanceof Table)
  const rows = table.rows
  assert.equal(rows.length, 24) // a box's 6 faces × 4 corners
  assert.equal(typeof rows[0].nx, 'number')
  assert.equal(rows[0].beat, 1) // stamped with the default beat
  // beat is overridable, so a cloud can be posed on a later beat
  assert.equal(dsl.points('box', { beat: 5 }).rows[0].beat, 5)
  // chains like any other table
  const shifted = table.map((r) => ({ px: (r.px as number) + 10 }))
  assert.equal(shifted.rows[0].px, (rows[0].px as number) + 10)
})

test('pointCloudEvents packs beats into create + update events carrying flat buffers', () => {
  const beat1: Row[] = [
    { beat: 1, px: 0, py: 0, pz: 0, nx: 0, ny: 1, nz: 0 },
    { beat: 1, px: 1, py: 0, pz: 0, nx: 0, ny: 1, nz: 0 },
  ]
  const beat3: Row[] = [
    { beat: 3, px: 0, py: 1, pz: 0, nx: 0, ny: 1, nz: 0 },
    { beat: 3, px: 1, py: 1, pz: 0, nx: 0, ny: 1, nz: 0 },
  ]
  const events = pointCloudEvents([...beat3, ...beat1], { id: 'cloud', color: 0xff0000 })
  assert.equal(events.length, 2)
  // earliest beat is the create (shape "points"), later beats are updates
  assert.equal(events[0].type, 'create')
  assert.equal(events[0].beat, 1)
  assert.equal(events[0].shape, 'points')
  assert.equal(events[0].color, 0xff0000)
  assert.equal(events[1].type, 'update')
  assert.equal(events[1].beat, 3)
  assert.equal(events[1].shape, undefined) // shape only on create
  // each event carries its beat's flat position buffer + a discrete key
  assert.deepEqual(events[0].ptPos, [0, 0, 0, 1, 0, 0])
  assert.deepEqual(events[1].ptPos, [0, 1, 0, 1, 1, 0])
  assert.deepEqual(events[0].ptNrm, [0, 1, 0, 0, 1, 0])
  assert.equal(events[0].ptKey, '1')
  assert.equal(events[1].ptKey, '3')
})

test('pointCloudEvents leaves ptNrm null when a beat lacks full normals', () => {
  const events = pointCloudEvents([{ beat: 1, px: 0, py: 0, pz: 0 }])
  assert.equal(events.length, 1)
  assert.equal(events[0].ptNrm, null)
  assert.deepEqual(events[0].ptPos, [0, 0, 0])
})

test('pointCloudEvents errors when the point count differs between beats', () => {
  const rows: Row[] = [
    { beat: 1, px: 0, py: 0, pz: 0 },
    { beat: 1, px: 1, py: 0, pz: 0 },
    { beat: 2, px: 0, py: 1, pz: 0 }, // only one point on beat 2
  ]
  assert.throws(() => pointCloudEvents(rows), /must keep the same number of points/)
})

test('DSL pointCloud() turns a beat-keyed points table into a scene object', () => {
  const dsl = createDSL(null)
  // a sphere held on beat 1 and a shifted copy on beat 5 → a 2-pose cloud
  const b1 = dsl.points('sphere', { r: 1, segments: 8 })
  const b5 = dsl.points('sphere', { r: 1, segments: 8, beat: 5 })
  const cloud = dsl.pointCloud(b1.concat(b5), { id: 'ball' })
  assert.ok(cloud instanceof Table)
  const events = cloud.rows
  assert.equal(events.length, 2)
  assert.equal(events[0].type, 'create')
  assert.equal(events[1].type, 'update')
  // both beats carry the same number of points (same sphere tessellation)
  assert.equal((events[0].ptPos as number[]).length, (events[1].ptPos as number[]).length)
})

test('a pointCloud rasterizes to per-frame rows that step the buffer by beat', () => {
  const dsl = createDSL(null)
  const b1 = dsl.points('box', { hx: 1, beat: 1 })
  const b3 = dsl.points('box', { hx: 2, beat: 3 }) // a bigger box on beat 3
  const scene = dsl.pointCloud(b1.concat(b3), { id: 'box' }).rasterize(4)
  const rows = scene.rows
  // the create beat's buffer holds until beat 3, then the update beat's takes over
  const early = rows.find((r) => r.frame === 0)!
  const late = rows[rows.length - 1]
  assert.equal(early.ptKey, '1')
  assert.equal(late.ptKey, '3')
  // same point count throughout (box → 24 vertices), buffer just changes contents
  assert.equal((early.ptPos as number[]).length, (late.ptPos as number[]).length)
  assert.notDeepEqual(early.ptPos, late.ptPos)
})

test('DSL geometry() rebuilds a primitive from a points table (inverse of points)', () => {
  const dsl = createDSL(null)
  const pts = dsl.points('sphere', { r: 1 })
  const geo = dsl.geometry(pts)
  assert.equal(geo.getAttribute('position').count, pts.rows.length)
  assert.ok(geo.getAttribute('normal'))
  // also accepts a bare row array
  const geo2 = dsl.geometry([{ px: 0, py: 0, pz: 0, nx: 0, ny: 1, nz: 0 }])
  assert.equal(geo2.getAttribute('position').count, 1)
})
