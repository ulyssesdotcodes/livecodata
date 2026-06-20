import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTimeline } from '../src/timeline.js'
import { createRuntime } from '../src/runtime.js'
import { cookProgram } from '../src/replay.js'

const frames = (arr) => arr.map((frame) => ({ frame }))

test('no timeline rows → identity mapping, length 0', () => {
  const tl = buildTimeline([])
  assert.equal(tl.length, 0)
  assert.equal(tl.frameAt(0), 0)
  assert.equal(tl.frameAt(7), 7)
  assert.equal(tl.frameAt(3.9), 3, 'floors fractional ticks')
})

test('maps tick → frame, clamping the tick and rounding the frame', () => {
  const tl = buildTimeline([{ frame: 10 }, { frame: 20 }, { frame: 30.6 }])
  assert.equal(tl.length, 3)
  assert.equal(tl.frameAt(0), 10)
  assert.equal(tl.frameAt(1), 20)
  assert.equal(tl.frameAt(2), 31, 'frame value is rounded')
  assert.equal(tl.frameAt(1.8), 20, 'fractional tick floors to its row')
  assert.equal(tl.frameAt(99), 31, 'tick past the end clamps to the last row')
  assert.equal(tl.frameAt(-5), 10, 'negative tick clamps to the first row')
})

test('loop: first 60 frames repeat across a longer timeline', () => {
  const tl = buildTimeline(frames(Array.from({ length: 360 }, (_, i) => i % 60)))
  assert.equal(tl.length, 360)
  assert.equal(tl.frameAt(0), 0)
  assert.equal(tl.frameAt(59), 59)
  assert.equal(tl.frameAt(60), 0, 'wraps back to the start')
  assert.equal(tl.frameAt(125), 5)
})

test('reverse: time runs backwards', () => {
  const tl = buildTimeline(frames(Array.from({ length: 100 }, (_, i) => 99 - i)))
  assert.equal(tl.frameAt(0), 99)
  assert.equal(tl.frameAt(99), 0)
  assert.equal(tl.frameAt(40), 59)
})

test('falls back to the source frame when a row omits frame', () => {
  const tl = buildTimeline([{}, {}, {}])
  assert.equal(tl.frameAt(2), 2)
})

test('cookProgram surfaces timelineRows from a defined timeline view', () => {
  const rt = createRuntime()
  const code = `
    define("base", () => rows([{ id: "s", type: "create", index: 0, shape: "sphere",
      color: 0x4a9eff, px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 }]))
    define("scene", () => table("base").rasterize(120))
    define("timeline", () => math(i => i % 30).range(120).map(r => ({ frame: r.value })))
  `
  const cooked = cookProgram(rt, code, 1)
  assert.equal(cooked.timelineRows.length, 120)
  const tl = buildTimeline(cooked.timelineRows)
  assert.equal(tl.frameAt(31), 1, 'looped timeline drives the mapping')
})

test('cookProgram yields no timeline rows when none is defined', () => {
  const rt = createRuntime()
  const code = `
    define("events", () => rows([{ id: "s", type: "create", index: 0, shape: "box",
      color: 1, px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 }]))
  `
  const cooked = cookProgram(rt, code, 1)
  assert.deepEqual(cooked.timelineRows, [])
  assert.equal(buildTimeline(cooked.timelineRows).length, 0)
})
