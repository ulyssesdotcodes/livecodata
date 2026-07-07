import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTimeline } from '../src/timeline.js'
import { frameToBeat } from '../src/constants.js'
import { createRuntime } from '../src/runtime.js'
import { cookProgram, cookTimeline } from '../src/replay.js'

// The 1-indexed source `beat` that maps back to a given cache frame.
const src = (frame: number): number => frameToBeat(frame)

test('no timeline rows → identity mapping, length 0', () => {
  const tl = buildTimeline([])
  assert.equal(tl.length, 0)
  assert.equal(tl.beats, 0)
  assert.equal(tl.frameAt(0), 0)
  assert.equal(tl.frameAt(7), 7)
  assert.equal(tl.frameAt(3.9), 3, 'floors fractional ticks')
})

test('maps tick → source frame via the source-beat field, clamping the tick', () => {
  const tl = buildTimeline([{ source: src(10) }, { source: src(20) }, { source: src(30.6) }])
  assert.equal(tl.length, 3)
  assert.equal(tl.frameAt(0), 10)
  assert.equal(tl.frameAt(1), 20)
  assert.equal(tl.frameAt(2), 31, 'frame value is rounded')
  assert.equal(tl.frameAt(1.8), 20, 'fractional tick floors to its row')
  assert.equal(tl.frameAt(99), 31, 'tick past the end clamps to the last row')
  assert.equal(tl.frameAt(-5), 10, 'negative tick clamps to the first row')
})

test('loop: first 60 frames repeat across a 360-frame timeline', () => {
  const rows = Array.from({ length: 360 }, (_, i) => ({ source: src(i % 60) }))
  const tl = buildTimeline(rows)
  assert.equal(tl.length, 360)
  assert.equal(tl.frameAt(0), 0)
  assert.equal(tl.frameAt(59), 59)
  assert.equal(tl.frameAt(60), 0, 'wraps back to the start')
  assert.equal(tl.frameAt(125), 5)
})

test('reverse: source runs backwards', () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ source: src(99 - i) }))
  const tl = buildTimeline(rows)
  assert.equal(tl.frameAt(0), 99)
  assert.equal(tl.frameAt(99), 0)
  assert.equal(tl.frameAt(40), 59)
})

test('falls back to identity when a row omits source', () => {
  const tl = buildTimeline([{}, {}, {}])
  assert.equal(tl.frameAt(2), 2)
})

test('cookProgram surfaces timelineRows from a defined timeline view', () => {
  const rt = createRuntime()
  const code = `
    define("base", () => rows([{ id: "s", type: "create", beat: 1, shape: "sphere",
      color: 0x4a9eff, px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 }]))
    define("scene", () => table("base").rasterize(2))
    define("timeline", () => math(t => (t % 1) + 1).range(4).map(r => ({ source: r.value })))
  `
  const cooked = cookProgram(rt, code, 1)
  assert.equal(cooked.timelineRows.length, 120)
  const tl = buildTimeline(cooked.timelineRows)
  assert.equal(tl.frameAt(31), 1, 'looped timeline drives the mapping')
})

test('cookProgram yields no timeline rows when none is defined', () => {
  const rt = createRuntime()
  const code = `
    define("events", () => rows([{ id: "s", type: "create", beat: 1, shape: "box",
      color: 1, px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 }]))
  `
  const cooked = cookProgram(rt, code, 1)
  assert.deepEqual(cooked.timelineRows, [])
  assert.equal(buildTimeline(cooked.timelineRows).length, 0)
})

test('a beats() timeline reflects the tap-beat tempo', () => {
  const tapRows = [{ beat: 0, time: 0 }, { beat: 1, time: 0.5 }] // 0.5s/beat = 120 BPM
  const rt = createRuntime({ tapRows: () => tapRows })
  const code = `
    define("base", () => rows([{ id: "s", type: "create", beat: 1, shape: "sphere",
      color: 0x4a9eff, px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 }]))
    define("scene", () => table("base").rasterize(2))
    define("timeline", () => beats(4))
  `
  const cooked = cookProgram(rt, code, 1)
  assert.equal(cooked.timelineRows.length, 120, '4 beats * 0.5s * 60fps')
})

test('cookTimeline recomputes only the timeline (skips the rest)', () => {
  const tapRows = [{ beat: 0, time: 0 }, { beat: 1, time: 0.5 }]
  const rt = createRuntime({ tapRows: () => tapRows })
  const code = `
    define("base", () => rows([{ id: "s", type: "create", beat: 1, shape: "sphere",
      color: 0x4a9eff, px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 }]))
    define("boom", () => { throw new Error("should not cook this") })
    define("scene", () => table("base").rasterize(2))
    define("timeline", () => beats(4))
  `
  const rows = cookTimeline(rt, code, 1)
  assert.equal(rows.length, 120, '"boom" was never cooked')
})

test('cookTimeline returns [] when no timeline is defined', () => {
  const rt = createRuntime()
  const code = `define("base", () => rows([{ id: "s" }]))`
  assert.deepEqual(cookTimeline(rt, code, 1), [])
})
