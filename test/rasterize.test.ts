import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rasterizeRows, buildFrameIndex, stateAtFrame, sampleFrame } from '../src/rasterize.js'
import { frameToBeat, framesToBeats } from '../src/constants.js'
import type { Row } from '../src/lineage.js'

// A target cache frame → the 1-indexed `beat` that lands on it, and → the beats
// *span* (for the maxBeats arg). Beats are the input unit now; frames stay the
// internal baking grid these assertions read.
const b = (frame: number): number => frameToBeat(frame)
const mb = (frame: number): number => framesToBeats(frame)

const create = (over: Row = {}): Row => ({
  id: 's', type: 'create', beat: 1, shape: 'sphere', color: 0x4a9eff,
  px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, ...over,
})

test('emits frames 0..maxFrame inclusive for an object alive throughout', () => {
  const rows = rasterizeRows([create()], mb(10))
  assert.equal(rows.length, 11)
  assert.equal(rows[0].frame, 0)
  assert.equal(rows[10].frame, 10)
  assert.ok(rows.every((r) => r.id === 's' && r.shape === 'sphere'))
})

test('infers maxFrame from the largest event beat when omitted', () => {
  const rows = rasterizeRows([
    create(),
    { id: 's', type: 'color', beat: b(7), color: 0xffffff },
  ])
  assert.equal(rows.at(-1)!.frame, 7)
})

test('interpolates position/rotation linearly between movement keyframes', () => {
  const rows = rasterizeRows([
    create({ px: 0, py: 0, ry: 0 }),
    { id: 's', type: 'update', beat: b(10), px: 10, py: 20, pz: 0, rx: 0, ry: 4, rz: 0 },
  ], mb(10))
  const at5 = rows.find((r) => r.frame === 5)!
  assert.equal(at5.px, 5, 'halfway in x')
  assert.equal(at5.py, 10, 'halfway in y')
  assert.equal(at5.ry, 2, 'halfway in rotation y')
  assert.equal(rows.find((r) => r.frame === 0)!.px, 0)
  assert.equal(rows.find((r) => r.frame === 10)!.px, 10)
})

test('color is a step function: latest color-bearing event <= frame', () => {
  const rows = rasterizeRows([
    create({ color: 0x111111 }),
    { id: 's', type: 'color', beat: b(3), color: 0x222222 },
    { id: 's', type: 'color', beat: b(6), color: 0x333333 },
  ], mb(8))
  const colorAt = (fr: number) => rows.find((r) => r.frame === fr)!.color
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
    { id: 's', type: 'color', beat: b(3), color: 0xffffff, dur: mb(4), ease: (t: number) => t },
    { id: 's', type: 'color', beat: b(6), color: 0xff0000, dur: mb(4), ease: (t: number) => t },
  ], mb(12))
  const colorAt = (fr: number) => rows.find((r) => r.frame === fr)!.color
  assert.equal(colorAt(0), 0x4a9eff, 'base color before any pulse')
  assert.equal(colorAt(3), 0xffffff, 'exact flash color at the trigger frame')
  assert.notEqual(colorAt(5), 0xffffff, 'mid-decay color is a mix, not the flash')
  assert.equal(colorAt(6), 0xff0000, 'a newer pulse overrides the older one mid-decay')
  assert.equal(colorAt(10), 0x4a9eff, 'fully decayed back to the base color')
})

test('color step (no dur) stays a hard switch, newest event wins', () => {
  const rows = rasterizeRows([
    create({ color: 0x111111 }),
    { id: 's', type: 'color', beat: b(4), color: 0x222222 },
  ], mb(6))
  const colorAt = (fr: number) => rows.find((r) => r.frame === fr)!.color
  assert.equal(colorAt(3), 0x111111)
  assert.equal(colorAt(4), 0x222222)
  assert.equal(colorAt(6), 0x222222)
})

test('no rows before create and from destroy onward', () => {
  const rows = rasterizeRows([
    create({ beat: b(2) }),
    { id: 's', type: 'destroy', beat: b(5) },
  ], mb(8))
  const frames = new Set(rows.map((r) => r.frame))
  assert.ok(!frames.has(0) && !frames.has(1), 'absent before create')
  assert.ok(frames.has(2) && frames.has(4), 'present while alive')
  assert.ok(!frames.has(5) && !frames.has(7), 'absent from destroy onward')
})

test('multiple objects each get a row per frame they are alive', () => {
  const rows = rasterizeRows([
    create({ id: 'a' }),
    create({ id: 'b', beat: b(3) }),
  ], mb(5))
  const at4 = rows.filter((r) => r.frame === 4).map((r) => r.id).sort()
  assert.deepEqual(at4, ['a', 'b'])
  const at1 = rows.filter((r) => r.frame === 1).map((r) => r.id)
  assert.deepEqual(at1, ['a'])
})

test('buildFrameIndex + stateAtFrame give O(1) lookups', () => {
  const rows = rasterizeRows([create({ id: 'a' }), create({ id: 'b' })], mb(4))
  const fi = buildFrameIndex(rows)
  assert.equal(fi.maxFrame, 4)
  assert.deepEqual(stateAtFrame(fi, 2).map((r) => r.id).sort(), ['a', 'b'])
  assert.deepEqual(stateAtFrame(fi, 2.9).map((r) => r.id).sort(), ['a', 'b'])
  assert.deepEqual(stateAtFrame(fi, 99), [])
  assert.deepEqual(stateAtFrame(fi, -1), [])
})

test('sampleFrame eases transform fields between cache frames', () => {
  const rows = rasterizeRows([
    create({ px: 0, py: 0, ry: 0 }),
    { id: 's', type: 'update', beat: b(10), px: 10, py: 20, pz: 0, rx: 0, ry: 4, rz: 0 },
  ], mb(10))
  const fi = buildFrameIndex(rows)

  // Frame 4 bakes px=4; frame 5 bakes px=5. Halfway between → 4.5.
  const half = sampleFrame(fi, 4.5)[0]
  assert.equal(half.px, 4.5, 'position eased half a frame')
  assert.equal(half.ry, 1.8, 'rotation eased half a frame')

  // Integer frames and frac 0 are plain lookups.
  assert.equal(sampleFrame(fi, 4)[0].px, 4)
  // Past the last frame, no next frame to ease toward → hold.
  assert.equal(sampleFrame(fi, 10)[0].px, 10)
})

test('sampleFrame does not blend discrete fields (color) or eased ids that vanish', () => {
  const rows = rasterizeRows([
    create({ id: 'a', color: 0x111111, px: 0 }),
    { id: 'a', type: 'update', beat: b(4), px: 8 },
    create({ id: 'b', beat: b(2), px: 0 }),
    { id: 'b', type: 'destroy', beat: b(3) },
  ], mb(4))
  const fi = buildFrameIndex(rows)
  const at = sampleFrame(fi, 1.5)
  const a = at.find((r) => r.id === 'a')!
  assert.equal(a.color, 0x111111, 'color is not interpolated')
  assert.equal(a.px, 3, 'a eased between frame 1 (px=2) and 2 (px=4)')
})

test('empty input yields an empty cache', () => {
  assert.deepEqual(rasterizeRows([], mb(5)), [])
  assert.deepEqual(rasterizeRows(null), [])
  const fi = buildFrameIndex([])
  assert.equal(fi.maxFrame, 0)
  assert.deepEqual(stateAtFrame(fi, 0), [])
})

test('custom numeric fields interpolate between keyframes (fold fractions ride the grid)', () => {
  const rows = rasterizeRows([
    create({ wings: 0 }),
    { id: 's', type: 'update', beat: b(10), wings: 1 },
  ], mb(10))
  const at5 = rows.find((r) => r.frame === 5)!
  assert.equal(at5.wings, 0.5, 'halfway through the ramp')
  assert.equal(rows.find((r) => r.frame === 10)!.wings, 1)
})

test('custom numeric fields hold their last value when the next keyframe omits them', () => {
  const rows = rasterizeRows([
    create({ wings: 0 }),
    { id: 's', type: 'update', beat: b(4), wings: 1 },
    { id: 's', type: 'update', beat: b(8), px: 3 }, // no wings field
  ], mb(8))
  assert.equal(rows.find((r) => r.frame === 6)!.wings, 1, 'held, not re-lerped')
})

test('an ease function on the destination keyframe shapes the segment', () => {
  const easeIn = (t: number): number => t * t
  const rows = rasterizeRows([
    create({ px: 0, wings: 0 }),
    { id: 's', type: 'update', beat: b(10), px: 10, wings: 1, ease: easeIn },
  ], mb(10))
  const at5 = rows.find((r) => r.frame === 5)!
  assert.equal(at5.px, 2.5, 'position eased quadratically')
  assert.equal(at5.wings, 0.25, 'custom numeric eased the same way')
})

test('numeric tracks glide across keyframes that omit them', () => {
  const rows = rasterizeRows([
    create({ ry: 0, wings: 0 }),
    { id: 's', type: 'update', beat: b(4), wings: 1 },   // no ry
    { id: 's', type: 'update', beat: b(10), ry: 5 },      // no wings
  ], mb(10))
  const at5 = rows.find((r) => r.frame === 5)!
  assert.equal(at5.ry, 2.5, 'ry glides through the wings-only keyframe')
  assert.equal(at5.wings, 1, 'wings holds after its own last keyframe')
  const at2 = rows.find((r) => r.frame === 2)!
  assert.equal(at2.wings, 0.5, 'wings ramp unaffected by the later ry keyframe')
})

// --- multi-loop sequences: the `loop` column next to `beat` ------------------

test('a loop column extends the bake across passes: loop L beat b lands at L * span + frame', () => {
  const rows = rasterizeRows([
    create({ px: 0 }),
    { id: 's', type: 'update', beat: b(4), loop: 0, px: 4 },
    { id: 's', type: 'update', beat: b(4), loop: 1, px: 8 },
  ], mb(4))
  // Two passes of a 4-frame loop → baked out to 8 frames.
  assert.equal(rows.at(-1)!.frame, 8)
  assert.equal(rows.find((r) => r.frame === 4)!.px, 4, 'end of pass 0')
  assert.equal(rows.find((r) => r.frame === 8)!.px, 8, 'end of pass 1')
})

test('interpolation crosses the loop boundary like any other keyframe segment', () => {
  const rows = rasterizeRows([
    create({ px: 0 }),
    { id: 's', type: 'update', beat: b(2), loop: 0, px: 2 },
    { id: 's', type: 'update', beat: b(2), loop: 1, px: 6 },
  ], mb(4))
  // Pass 0 frame 2 (px 2) → pass 1 frame 2 (extended frame 6, px 6): the
  // segment spans the wrap at frame 4.
  assert.equal(rows.find((r) => r.frame === 4)!.px, 4, 'halfway through the cross-boundary glide')
})

test('without a maxBeats arg the per-pass span is the largest event beat in any pass', () => {
  const rows = rasterizeRows([
    create(),
    { id: 's', type: 'update', beat: b(6), loop: 0, px: 1 },
    { id: 's', type: 'update', beat: b(2), loop: 1, px: 2 },
  ])
  // Span = 6 frames (pass 0's extent); pass 1 bakes out to its full span too.
  assert.equal(rows.at(-1)!.frame, 12)
})

test('dense multi-loop rows carry which pass they fall in; single-loop rows do not', () => {
  const multi = rasterizeRows([
    create(),
    { id: 's', type: 'update', beat: b(2), loop: 1, px: 1 },
  ], mb(2))
  assert.equal(multi.find((r) => r.frame === 1)!.loop, 0)
  assert.equal(multi.find((r) => r.frame === 3)!.loop, 1)
  assert.equal(multi.find((r) => r.frame === 4)!.loop, 1, 'the last baked frame belongs to the final pass')

  const single = rasterizeRows([create()], mb(2))
  assert.ok(single.every((r) => !('loop' in r)), 'no loop column → the baked rows are unchanged')
})

test('buildFrameIndex recovers loops and the per-pass span from a multi-loop cache', () => {
  const rows = rasterizeRows([
    create(),
    { id: 's', type: 'update', beat: b(3), loop: 2, px: 1 },
  ], mb(3))
  const idx = buildFrameIndex(rows)
  assert.equal(idx.loops, 3)
  assert.equal(idx.loopFrames, 3, 'per-pass span')
  assert.equal(idx.maxFrame, 9, 'total extent = loops * span')

  const singleIdx = buildFrameIndex(rasterizeRows([create()], mb(3)))
  assert.equal(singleIdx.loops, 1)
  assert.equal(singleIdx.loopFrames, singleIdx.maxFrame, 'single-loop: span is the whole cache')
})

test('an object can exist in only one pass (create/destroy carry loop too)', () => {
  const rows = rasterizeRows([
    create({ loop: 1 }),
    { id: 's', type: 'destroy', beat: b(2), loop: 1 },
  ], mb(3))
  assert.ok(!rows.some((r) => (r.frame as number) < 3), 'absent through pass 0')
  assert.ok(rows.some((r) => r.frame === 3), 'alive at the top of pass 1')
  assert.ok(!rows.some((r) => (r.frame as number) > 4), 'destroyed within pass 1')
})
