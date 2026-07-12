import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTimeline } from '../src/timeline.js'
import { createRuntime } from '../src/runtime.js'
import { cookProgram } from '../src/replay.js'

test('no timeline rows → identity mapping, not active', () => {
  const tl = buildTimeline([])
  assert.equal(tl.active, false)
  assert.equal(tl.beats, 0)
  assert.equal(tl.sourceBeatAt(1), 1)
  assert.equal(tl.sourceBeatAt(7.5), 7.5)
})

test('maps playback beat → source beat, interpolating and clamping', () => {
  // Play source beats 1..5 across playback beats 1..17 (a { fit: 4 } window).
  const tl = buildTimeline([{ beat: 1, source: 1 }, { beat: 17, source: 5 }])
  assert.equal(tl.active, true)
  assert.equal(tl.beats, 16, 'playback-beat span')
  assert.equal(tl.sourceBeatAt(1), 1)
  assert.equal(tl.sourceBeatAt(9), 3, 'halfway through the loop → halfway through the source span')
  assert.equal(tl.sourceBeatAt(17), 5)
  assert.equal(tl.sourceBeatAt(99), 5, 'past the end clamps to the last keyframe')
  assert.equal(tl.sourceBeatAt(-5), 1, 'before the start clamps to the first keyframe')
})

test('interpolates within multiple keyframes (a warped section)', () => {
  // Hold source at beat 1 for the first half, then run 1→9 over the second half.
  const tl = buildTimeline([
    { beat: 1, source: 1 },
    { beat: 5, source: 1 },
    { beat: 9, source: 9 },
  ])
  assert.equal(tl.sourceBeatAt(3), 1, 'held in the first section')
  assert.equal(tl.sourceBeatAt(5), 1)
  assert.equal(tl.sourceBeatAt(7), 5, 'halfway through the second section')
  assert.equal(tl.sourceBeatAt(9), 9)
})

test('reverse: source runs backwards as playback advances', () => {
  const tl = buildTimeline([{ beat: 1, source: 5 }, { beat: 5, source: 1 }])
  assert.equal(tl.sourceBeatAt(1), 5)
  assert.equal(tl.sourceBeatAt(3), 3)
  assert.equal(tl.sourceBeatAt(5), 1)
})

test('cookProgram surfaces timelineRows from a defined timeline view', () => {
  const rt = createRuntime()
  const code = `
    define("base", () => rows([{ id: "s", type: "create", beat: 1, shape: "sphere",
      color: 0x4a9eff, px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 }]))
    define("scene", () => table("base").rasterize(2))
    define("timeline", () => beats(16, { fit: 4 }))
  `
  const cooked = cookProgram(rt, code, 1)
  assert.equal(cooked.timelineRows.length, 2, 'a sparse two-keyframe remap')
  const tl = buildTimeline(cooked.timelineRows)
  assert.equal(tl.beats, 16)
  assert.equal(tl.sourceBeatAt(9), 3, 'the 4-beat source span is stretched across the loop')
})

test('cookProgram yields no timeline rows when none is defined', () => {
  const rt = createRuntime()
  const code = `
    define("events", () => rows([{ id: "s", type: "create", beat: 1, shape: "box",
      color: 1, px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 }]))
  `
  const cooked = cookProgram(rt, code, 1)
  assert.deepEqual(cooked.timelineRows, [])
  assert.equal(buildTimeline(cooked.timelineRows).active, false)
})

// --- multi-loop sequences: the `loop` column next to `beat` ------------------

test('a loop column gives each pass its own remap; beats stays the per-pass span', () => {
  // Pass 0 plays source 1..5 forward; pass 1 plays it in reverse.
  const tl = buildTimeline([
    { beat: 1, loop: 0, source: 1 },
    { beat: 5, loop: 0, source: 5 },
    { beat: 1, loop: 1, source: 5 },
    { beat: 5, loop: 1, source: 1 },
  ])
  assert.equal(tl.loops, 2)
  assert.equal(tl.beats, 4, 'the playhead still wraps every pass, not once per sequence')
  assert.equal(tl.sourceBeatAt(1, 0), 1)
  assert.equal(tl.sourceBeatAt(3, 0), 3)
  assert.equal(tl.sourceBeatAt(3, 1), 3, 'reverse pass, halfway')
  assert.equal(tl.sourceBeatAt(5, 1), 1)
  assert.equal(tl.sourceBeatAt(3, 2), 3, 'the loop argument wraps modulo the pass count')
})

test('rows without a loop column keep single-loop behavior (loops = 1, loop arg ignored)', () => {
  const tl = buildTimeline([{ beat: 1, source: 1 }, { beat: 17, source: 5 }])
  assert.equal(tl.loops, 1)
  assert.equal(tl.sourceBeatAt(9), tl.sourceBeatAt(9, 3))
})
