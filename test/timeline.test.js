import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTimeline } from '../src/timeline.js'
import { createRuntime } from '../src/runtime.js'
import { cookProgram } from '../src/replay.js'

// Convenience: build timeline rows where each row has `time` in seconds.
const times = (arr) => arr.map((time) => ({ time }))
// Convenience: frame → seconds
const f = (frames) => frames / 60

test('no timeline rows → identity mapping, length 0', () => {
  const tl = buildTimeline([])
  assert.equal(tl.length, 0)
  assert.equal(tl.frameAt(0), 0)
  assert.equal(tl.frameAt(7), 7)
  assert.equal(tl.frameAt(3.9), 3, 'floors fractional ticks')
})

test('maps tick → source frame via time field (seconds), clamping the tick', () => {
  const tl = buildTimeline([{ time: f(10) }, { time: f(20) }, { time: f(30.6) }])
  assert.equal(tl.length, 3)
  assert.equal(tl.frameAt(0), 10)
  assert.equal(tl.frameAt(1), 20)
  assert.equal(tl.frameAt(2), 31, 'frame value is rounded')
  assert.equal(tl.frameAt(1.8), 20, 'fractional tick floors to its row')
  assert.equal(tl.frameAt(99), 31, 'tick past the end clamps to the last row')
  assert.equal(tl.frameAt(-5), 10, 'negative tick clamps to the first row')
})

test('loop: first second (60 frames) repeats across a 6-second timeline', () => {
  // 360 rows where each row's time = (i/60) % 1 seconds (loops every 1 second)
  const rows = Array.from({ length: 360 }, (_, i) => ({ time: (i / 60) % 1 }))
  const tl = buildTimeline(rows)
  assert.equal(tl.length, 360)
  assert.equal(tl.frameAt(0), 0)
  assert.equal(tl.frameAt(59), 59)
  assert.equal(tl.frameAt(60), 0, 'wraps back to the start')
  assert.equal(tl.frameAt(125), 5)
})

test('reverse: time runs backwards', () => {
  // 100 rows, source time descends from 99/60s to 0
  const rows = Array.from({ length: 100 }, (_, i) => ({ time: (99 - i) / 60 }))
  const tl = buildTimeline(rows)
  assert.equal(tl.frameAt(0), 99)
  assert.equal(tl.frameAt(99), 0)
  assert.equal(tl.frameAt(40), 59)
})

test('falls back to identity when a row omits time', () => {
  const tl = buildTimeline([{}, {}, {}])
  assert.equal(tl.frameAt(2), 2)
})

test('cookProgram surfaces timelineRows from a defined timeline view', () => {
  const rt = createRuntime()
  const code = `
    define("base", () => rows([{ id: "s", type: "create", index: 0, shape: "sphere",
      color: 0x4a9eff, px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 }]))
    define("scene", () => table("base").rasterize(2))
    define("timeline", () => math(t => t % 0.5).range(2).map(r => ({ time: r.value })))
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
