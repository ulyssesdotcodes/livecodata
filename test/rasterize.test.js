import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rasterizeRows, buildFrameIndex, stateAtFrame } from '../src/rasterize.js'

// Convenience: convert frame count to seconds for API calls.
const f = (frames) => frames / 60

const create = (over = {}) => ({
  id: 's', type: 'create', index: 0, shape: 'sphere', color: 0x4a9eff,
  px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, ...over,
})

test('emits frames 0..maxFrame inclusive for an object alive throughout', () => {
  const rows = rasterizeRows([create()], f(10))
  assert.equal(rows.length, 11)
  assert.equal(rows[0].frame, 0)
  assert.equal(rows[10].frame, 10)
  assert.ok(rows.every((r) => r.id === 's' && r.shape === 'sphere'))
})

test('infers maxFrame from the largest event index when omitted', () => {
  const rows = rasterizeRows([
    create(),
    { id: 's', type: 'color', index: f(7), color: 0xffffff },
  ])
  assert.equal(rows.at(-1).frame, 7)
})

test('interpolates position/rotation linearly between movement keyframes', () => {
  const rows = rasterizeRows([
    create({ px: 0, py: 0, ry: 0 }),
    { id: 's', type: 'update', index: f(10), px: 10, py: 20, pz: 0, rx: 0, ry: 4, rz: 0 },
  ], f(10))
  const at5 = rows.find((r) => r.frame === 5)
  assert.equal(at5.px, 5, 'halfway in x')
  assert.equal(at5.py, 10, 'halfway in y')
  assert.equal(at5.ry, 2, 'halfway in rotation y')
  // endpoints exact
  assert.equal(rows.find((r) => r.frame === 0).px, 0)
  assert.equal(rows.find((r) => r.frame === 10).px, 10)
})

test('color is a step function: latest color-bearing event <= frame', () => {
  const rows = rasterizeRows([
    create({ color: 0x111111 }),
    { id: 's', type: 'color', index: f(3), color: 0x222222 },
    { id: 's', type: 'color', index: f(6), color: 0x333333 },
  ], f(8))
  const colorAt = (fr) => rows.find((r) => r.frame === fr).color
  assert.equal(colorAt(0), 0x111111)
  assert.equal(colorAt(2), 0x111111)
  assert.equal(colorAt(3), 0x222222)
  assert.equal(colorAt(5), 0x222222)
  assert.equal(colorAt(6), 0x333333)
  assert.equal(colorAt(8), 0x333333)
})

test('color pulse: flashes exactly at the trigger, eases to base, newest wins', () => {
  const rows = rasterizeRows([
    create({ color: 0x4a9eff }),
    { id: 's', type: 'color', index: f(3), color: 0xffffff, dur: f(4), ease: (t) => t },
    { id: 's', type: 'color', index: f(6), color: 0xff0000, dur: f(4), ease: (t) => t },
  ], f(12))
  const colorAt = (fr) => rows.find((r) => r.frame === fr).color
  assert.equal(colorAt(0), 0x4a9eff, 'base color before any pulse')
  assert.equal(colorAt(3), 0xffffff, 'exact flash color at the trigger frame')
  assert.notEqual(colorAt(5), 0xffffff, 'mid-decay color is a mix, not the flash')
  assert.equal(colorAt(6), 0xff0000, 'a newer pulse overrides the older one mid-decay')
  assert.equal(colorAt(10), 0x4a9eff, 'fully decayed back to the base color')
})

test('color step (no dur) stays a hard switch, newest event wins', () => {
  const rows = rasterizeRows([
    create({ color: 0x111111 }),
    { id: 's', type: 'color', index: f(4), color: 0x222222 },
  ], f(6))
  const colorAt = (fr) => rows.find((r) => r.frame === fr).color
  assert.equal(colorAt(3), 0x111111)
  assert.equal(colorAt(4), 0x222222)
  assert.equal(colorAt(6), 0x222222)
})

test('no rows before create and from destroy onward', () => {
  const rows = rasterizeRows([
    create({ index: f(2) }),
    { id: 's', type: 'destroy', index: f(5) },
  ], f(8))
  const frames = new Set(rows.map((r) => r.frame))
  assert.ok(!frames.has(0) && !frames.has(1), 'absent before create')
  assert.ok(frames.has(2) && frames.has(4), 'present while alive')
  assert.ok(!frames.has(5) && !frames.has(7), 'absent from destroy onward')
})

test('multiple objects each get a row per frame they are alive', () => {
  const rows = rasterizeRows([
    create({ id: 'a' }),
    create({ id: 'b', index: f(3) }),
  ], f(5))
  const at4 = rows.filter((r) => r.frame === 4).map((r) => r.id).sort()
  assert.deepEqual(at4, ['a', 'b'])
  const at1 = rows.filter((r) => r.frame === 1).map((r) => r.id)
  assert.deepEqual(at1, ['a'])
})

test('buildFrameIndex + stateAtFrame give O(1) lookups', () => {
  const rows = rasterizeRows([create({ id: 'a' }), create({ id: 'b' })], f(4))
  const fi = buildFrameIndex(rows)
  assert.equal(fi.maxFrame, 4)
  assert.deepEqual(stateAtFrame(fi, 2).map((r) => r.id).sort(), ['a', 'b'])
  // fractional frames floor; out-of-range frames return empty.
  assert.deepEqual(stateAtFrame(fi, 2.9).map((r) => r.id).sort(), ['a', 'b'])
  assert.deepEqual(stateAtFrame(fi, 99), [])
  assert.deepEqual(stateAtFrame(fi, -1), [])
})

test('empty input yields an empty cache', () => {
  assert.deepEqual(rasterizeRows([], f(5)), [])
  assert.deepEqual(rasterizeRows(null), [])
  const fi = buildFrameIndex([])
  assert.equal(fi.maxFrame, 0)
  assert.deepEqual(stateAtFrame(fi, 0), [])
})
