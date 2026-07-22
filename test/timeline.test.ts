import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTimeline } from '../src/timeline.js'
import { Table, createDSL } from '../src/dsl.js'
import { FRAMES_PER_BEAT } from '../src/constants.js'
import { withLineage, getLineage } from '../src/lineage.js'
import { createRuntime } from '../src/runtime.js'
import { cookProgram } from '../src/replay.js'

test('no timeline rows → identity mapping, not active', () => {
  const tl = buildTimeline([])
  assert.equal(tl.active, false)
  assert.equal(tl.beats, 0)
  assert.equal(tl.sourceBeatAt(1), 1)
  assert.equal(tl.sourceBeatAt(7.5), 7.5)
})

// --- event rows: the timeline schema ----------------------------------------

test('retime event maps its playback window linearly onto the source range', () => {
  // Play source beats 1..5 across playback beats 1..17 (beats(16, { fit: 4 })).
  const tl = buildTimeline([{ event: 'retime', beat: 1, dur: 16, from: 1, to: 5 }])
  assert.equal(tl.active, true)
  assert.equal(tl.beats, 16, 'loop length = beat 1 to the last event end')
  assert.equal(tl.sourceBeatAt(1), 1)
  assert.equal(tl.sourceBeatAt(9), 3, 'halfway through the loop → halfway through the source span')
  assert.equal(tl.sourceBeatAt(17), 5)
})

test('loop event cycles the source range at natural speed until the window closes', () => {
  const tl = buildTimeline([{ event: 'loop', beat: 1, dur: 16, from: 1, to: 5 }])
  assert.equal(tl.beats, 16)
  assert.equal(tl.sourceBeatAt(3), 3)
  assert.equal(tl.sourceBeatAt(6), 2, 'second cycle restarts at `from`')
  assert.equal(tl.sourceBeatAt(16), 4, 'fourth cycle')
})

test('hold event freezes the source frame across its window', () => {
  const tl = buildTimeline([{ event: 'hold', beat: 1, dur: 4, from: 3 }])
  assert.equal(tl.sourceBeatAt(1), 3)
  assert.equal(tl.sourceBeatAt(4.5), 3)
})

test('retime with from > to plays the source range backwards', () => {
  const tl = buildTimeline([{ event: 'retime', beat: 1, dur: 4, from: 5, to: 1 }])
  assert.equal(tl.sourceBeatAt(1), 5)
  assert.equal(tl.sourceBeatAt(3), 3)
  assert.equal(tl.sourceBeatAt(5), 1)
})

test('retime with an output block repeats the stretched block across its window', () => {
  // Source 1..5 stretched to half speed (an 8-beat block), looping across 16.
  const tl = buildTimeline([{ event: 'retime', beat: 1, dur: 16, from: 1, to: 5, outFrom: 1, outTo: 9 }])
  assert.equal(tl.beats, 16)
  assert.equal(tl.sourceBeatAt(5), 3, 'halfway through the first block')
  assert.equal(tl.sourceBeatAt(10), 1.5, 'second block restarts the source')
  assert.equal(tl.sourceBeatAt(13), 3)
})

test('retime output block anchors phase: a window starting mid-block starts mid-source', () => {
  const tl = buildTimeline([{ event: 'retime', beat: 5, dur: 8, from: 1, to: 5, outFrom: 1, outTo: 9 }])
  assert.equal(tl.sourceBeatAt(6), 3.5, 'beat 6 sits in the block that began (unheard) at beat 1')
  assert.equal(tl.sourceBeatAt(10), 1.5)
})

test('speed event advances from `from` at `rate` source beats per playback beat', () => {
  const tl = buildTimeline([{ event: 'speed', beat: 1, dur: 8, from: 1, rate: 0.5 }])
  assert.equal(tl.sourceBeatAt(9), 5, 'half speed: 8 playback beats cover 4 source beats')
})

test('playback beats no event covers play unmapped; disabled rows are ignored', () => {
  const tl = buildTimeline([
    { event: 'hold', beat: 9, dur: 8, from: 2 },
    { event: 'retime', beat: 1, dur: 89, disabled: true },
  ])
  assert.equal(tl.beats, 16, 'the unmapped head still counts toward the loop')
  assert.equal(tl.sourceBeatAt(3), 3, 'before the first event → identity')
  assert.equal(tl.sourceBeatAt(12), 2)
})

test('zero-filled cells from the table panel read as unset', () => {
  // Blank cells in an editable table conform to 0 (schemas fill defaults), so
  // a hand-entered retime row arrives with outFrom/outTo/rate/loop all 0 —
  // it must behave exactly like the sparse row a program would write.
  const tl = buildTimeline([
    { event: 'retime', beat: 1, dur: 16, from: 1, to: 5, outFrom: 0, outTo: 0, rate: 0, loop: 0, disabled: false },
  ])
  assert.equal(tl.beats, 16)
  assert.equal(tl.sourceBeatAt(9), 3)
})

test('events compose: loop a section inside an otherwise straight playthrough', () => {
  const tl = buildTimeline([
    { event: 'retime', beat: 1, dur: 8 },
    { event: 'loop', beat: 9, dur: 8, from: 1, to: 3 },
  ])
  assert.equal(tl.sourceBeatAt(5), 5, 'plain retime is identity without from/to')
  assert.equal(tl.sourceBeatAt(10), 2)
  assert.equal(tl.sourceBeatAt(12), 2, 'the 2-beat section cycles')
})

// --- legacy sparse keyframes { beat, source } still work ---------------------

test('keyframe rows interpolate within multiple keyframes (a warped section)', () => {
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

test('keyframe reverse: source runs backwards as playback advances', () => {
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
  const tl = buildTimeline(cooked.timelineRows)
  assert.equal(tl.beats, 16)
  assert.equal(tl.sourceBeatAt(9), 3, 'the 4-beat source span is stretched across the loop')
})

test('cookProgram yields no timeline rows when none is defined', () => {
  const rt = createRuntime()
  const code = `
    define("three", () => rows([{ id: "s", type: "create", beat: 1, shape: "box",
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

test('event rows take the loop column too', () => {
  const tl = buildTimeline([
    { event: 'retime', beat: 1, dur: 4, loop: 0 },
    { event: 'retime', beat: 1, dur: 4, from: 5, to: 1, loop: 1 },
  ])
  assert.equal(tl.loops, 2)
  assert.equal(tl.beats, 4)
  assert.equal(tl.sourceBeatAt(3, 0), 3)
  assert.equal(tl.sourceBeatAt(3, 1), 3, 'reverse pass, halfway')
  assert.equal(tl.sourceBeatAt(5, 1), 1)
})

test('rows without a loop column keep single-loop behavior (loops = 1, loop arg ignored)', () => {
  const tl = buildTimeline([{ event: 'retime', beat: 1, dur: 16, from: 1, to: 5 }])
  assert.equal(tl.loops, 1)
  assert.equal(tl.sourceBeatAt(9), tl.sourceBeatAt(9, 3))
})

// --- .retime(timeline): warp any beat table through a timeline table ----------

test('retime through a loop event duplicates rows once per cycle', () => {
  const content = new Table([
    { id: 'a', beat: 1 },
    { id: 'b', beat: 3 },
  ])
  const out = content.retime([{ event: 'loop', beat: 1, dur: 8, from: 1, to: 5 }]).rows
  assert.deepEqual(
    out.map((r) => [r.id, r.beat]),
    [['a', 1], ['a', 5], ['b', 3], ['b', 7]],
  )
})

test('retime through a retime stretch rescales beat spacing and dur', () => {
  const content = new Table([{ id: 'a', beat: 3, dur: 2 }])
  // Half speed: source 1..5 across playback 1..9.
  const out = content.retime([{ event: 'retime', beat: 1, dur: 8, from: 1, to: 5 }]).rows
  assert.deepEqual(out.map((r) => [r.beat, r.dur]), [[5, 4]])
})

test('retime drops rows no event plays; non-beat rows pass through', () => {
  const content = new Table([
    { id: 'late', beat: 10 },
    { id: 'meta' },
  ])
  const out = content.retime([{ event: 'loop', beat: 1, dur: 8, from: 1, to: 5 }]).rows
  assert.deepEqual(out.map((r) => r.id), ['meta'])
})

test('retime through a repeating retime block places rows once per repeat, dur stretched', () => {
  const content = new Table([{ id: 'a', beat: 3, dur: 2 }])
  const out = content.retime([
    { event: 'retime', beat: 1, dur: 16, from: 1, to: 5, outFrom: 1, outTo: 9 },
  ]).rows
  assert.deepEqual(out.map((r) => [r.beat, r.dur]), [[5, 4], [13, 4]])
})

test('retime carries each source row\'s lineage onto every placed copy', () => {
  const src = withLineage({ id: 'a', beat: 1 }, [{ table: 'melody', index: 0 }])
  const out = new Table([src]).retime([{ event: 'loop', beat: 1, dur: 8, from: 1, to: 5 }]).rows
  assert.equal(out.length, 2)
  for (const r of out) assert.deepEqual(getLineage(r), [{ table: 'melody', index: 0 }])
})

test('retime loops a subsection of an origami fold sequence', () => {
  const dsl = createDSL(null)
  const paper = dsl.origami().steps([
    { step: 'diag', p1: '0,0', p2: '1,1', move: '0.667,0.333', at: 1, dur: 2 },
    { step: 'collapse', p1: '0,0.5', p2: '1,0.5', move: '0.333,0.167', kind: 'reverse', at: 4, dur: 2 },
  ])
  const spawn = paper.spawn({ id: 'sheet' })
  // First fold plays straight; the second fold's window (source 4..7) loops
  // three times — the sheet folds shut, eases back open, folds shut again.
  const warp = [
    { event: 'retime', beat: 1, dur: 3 },
    { event: 'loop', beat: 4, dur: 9, from: 4, to: 7 },
  ]
  const scene = spawn.concat(paper.sequence().retime(warp)).rasterize(13)
  const foldAt = (b: number): number => {
    const row = scene.rows.find((r) => r.frame === Math.round((b - 1) * FRAMES_PER_BEAT) && r.id === 'sheet')!
    return row.fold as number
  }
  assert.equal(foldAt(3), 1, 'the first fold lands on the straight clock')
  assert.equal(foldAt(6), 2, 'the second fold lands in the first cycle')
  assert.equal(foldAt(8), 1.5, 'mid-swing inside a repeat')
  assert.equal(foldAt(9), 2, 'landed again in the second cycle')
  assert.equal(foldAt(12), 2, 'and in the third')
})

test('retime with an empty timeline is a no-op', () => {
  const content = new Table([{ id: 'a', beat: 2 }])
  assert.deepEqual(content.retime([]).rows, [{ id: 'a', beat: 2 }])
})

test('a user timeline table (editable, schemas.timeline) remaps other tables in a program', () => {
  const rt = createRuntime({ editableRows: (_name, _schema, seedRows) => seedRows ?? [] })
  const code = `
    define("warp", () => editable("warp", schemas.timeline, [
      { event: "loop", beat: 1, dur: 8, from: 1, to: 5 },
    ]))
    define("hits", () => rows([{ id: "x", beat: 2 }]).retime(table("warp")))
  `
  const result = rt.run(code, { seed: 1 })
  const hits = result.views.get('hits')!
  assert.deepEqual(hits.rows.map((r) => r.beat), [2, 6])
})
