import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isHydraRow,
  hydraRows,
  buildHydraIndex,
  hydraFrameAt,
  hydraLoops,
  type HydraFrame,
} from '../src/hydra.js'
import { frameToBeat } from '../src/constants.js'
import type { Row } from '../src/lineage.js'

// The 1-indexed `beat` that lands a row on a given cache frame (30 frames/beat).
const b = (frame: number): number => frameToBeat(frame)

const frameAt = (rows: Row[] | null | undefined, frame: number): HydraFrame | null =>
  hydraFrameAt(buildHydraIndex(rows), frame)

test('isHydraRow / hydraRows recognise setCode/setVariable events', () => {
  const rows: Row[] = [
    { beat: 1, event: 'setCode', code: 'src(s0).out()' },
    { beat: b(1), event: 'setVariable', name: 'speed', value: 2 },
    { beat: b(2) }, // no event kind → not a hydra row
  ]
  assert.equal(isHydraRow(rows[0]), true)
  assert.equal(isHydraRow(rows[1]), true)
  assert.equal(isHydraRow(rows[2]), false)
  assert.equal(isHydraRow(null), false)
  assert.deepEqual(hydraRows(rows).length, 2)
  assert.deepEqual(hydraRows(null), [])
})

test('a setCode event becomes the active sketch, a setVariable event puts a variable in scope', () => {
  const frame = frameAt([
    { beat: 1, event: 'setCode', code: 'src(s0).modulate(noise(amount), 0.1).out()' },
    { beat: 1, event: 'setVariable', name: 'amount', value: 3 },
  ], 0)
  assert.ok(frame)
  assert.equal(frame!.code, 'src(s0).modulate(noise(amount), 0.1).out()')
  assert.deepEqual(frame!.vars, { amount: 3 })
})

test('no active sketch before the first setCode event', () => {
  const rows: Row[] = [
    { beat: b(2), event: 'setCode', code: 'osc(speed).out()' },
    { beat: b(2), event: 'setVariable', name: 'speed', value: 1 },
  ]
  assert.equal(frameAt(rows, 0), null, 'before the first code')
  assert.equal(frameAt(rows, 1), null, 'still before')
  assert.ok(frameAt(rows, 2), 'at the code row')
  assert.ok(frameAt(rows, 9), 'after the code row it persists')
})

test('the latest setCode event at/before the frame wins; code persists until replaced', () => {
  const rows: Row[] = [
    { beat: 1, event: 'setCode', code: 'src(s0).out()' },
    { beat: b(4), event: 'setCode', code: 'osc(10).out()' },
  ]
  assert.equal(frameAt(rows, 0)!.code, 'src(s0).out()')
  assert.equal(frameAt(rows, 3)!.code, 'src(s0).out()')
  assert.equal(frameAt(rows, 4)!.code, 'osc(10).out()')
  assert.equal(frameAt(rows, 99)!.code, 'osc(10).out()')
})

test('variables take their latest value while the sketch stays put', () => {
  const rows: Row[] = [
    { beat: 1, event: 'setCode', code: 'osc(speed).out()' },
    { beat: 1, event: 'setVariable', name: 'speed', value: 1 },
    { beat: 1, event: 'setVariable', name: 'hue', value: 0 },
    { beat: b(3), event: 'setVariable', name: 'speed', value: 5 },
    { beat: b(6), event: 'setVariable', name: 'hue', value: 0.5 },
  ]
  assert.deepEqual(frameAt(rows, 0)!.vars, { speed: 1, hue: 0 })
  assert.deepEqual(frameAt(rows, 3)!.vars, { speed: 5, hue: 0 })
  assert.deepEqual(frameAt(rows, 6)!.vars, { speed: 5, hue: 0.5 })
  // the sketch is unchanged across all those variable updates
  assert.equal(frameAt(rows, 6)!.code, 'osc(speed).out()')
})

test('buildHydraIndex places rows on the frame grid by beat and sorts ascending', () => {
  const idx = buildHydraIndex([
    { beat: b(5), event: 'setCode', code: 'b' },
    { beat: b(1), event: 'setCode', code: 'a' },
  ])
  assert.deepEqual(idx.map((r) => [r.index, r.code]), [[1, 'a'], [5, 'b']])
})

test('empty / negative-frame inputs yield no sketch', () => {
  assert.equal(frameAt([], 0), null)
  assert.equal(frameAt(null, 0), null)
  assert.equal(frameAt([{ beat: 1, event: 'setCode', code: 'src(s0).out()' }], -1), null)
})

test('a `beat` column places rows on the loop 1-indexed (30 frames/beat)', () => {
  // beat b sits at (b-1)*30 frames. beat 1 → frame 0, beat 9 → frame 240.
  const idx = buildHydraIndex([
    { beat: 9, event: 'setVariable', name: 'freq', value: 12 },
    { beat: 1, event: 'setCode', code: 'osc(freq).out(o0)' },
    { beat: 1, event: 'setVariable', name: 'freq', value: 3 },
  ])
  assert.deepEqual(idx.map((r) => r.index), [0, 0, 240])
  assert.deepEqual(hydraFrameAt(idx, 0)!.vars, { freq: 3 })
  assert.deepEqual(hydraFrameAt(idx, 239)!.vars, { freq: 3 })
  assert.deepEqual(hydraFrameAt(idx, 240)!.vars, { freq: 12 })
})

test('rows without a beat default to beat 1 (frame 0)', () => {
  const idx = buildHydraIndex([{ event: 'setCode', code: 'osc(1).out(o0)' }])
  assert.equal(idx[0].index, 0)
})

// --- multi-loop sequences: the `loop` column next to `beat` ------------------

test('hydraFrameAt samples the pass named by `loop`, folding earlier passes in full', () => {
  const index = buildHydraIndex([
    { beat: 1, loop: 0, event: 'setCode', code: 'a' },
    { beat: 1, loop: 0, event: 'setVariable', name: 'amount', value: 1 },
    { beat: b(10), loop: 1, event: 'setCode', code: 'b' },
  ])
  assert.equal(hydraFrameAt(index, 0, 0)!.code, 'a', 'pass 0')
  assert.equal(hydraFrameAt(index, 0, 1)!.code, 'a', 'early in pass 1 the change has not hit yet')
  assert.equal(hydraFrameAt(index, 10, 1)!.code, 'b', 'pass 1 reaches its setCode')
  assert.equal(hydraFrameAt(index, 0, 2)!.code, 'b', 'a later pass folds pass 1 in full')
  assert.deepEqual(hydraFrameAt(index, 0, 2)!.vars, { amount: 1 }, 'variables persist across passes')
})

test('buildHydraIndex orders rows by (loop, frame); hydraLoops counts the passes', () => {
  const index = buildHydraIndex([
    { beat: 1, loop: 1, event: 'setCode', code: 'later' },
    { beat: b(5), event: 'setCode', code: 'first' }, // no loop → pass 0
  ])
  assert.deepEqual(index.map((r) => r.code), ['first', 'later'])
  assert.equal(hydraLoops(index), 2)
  assert.equal(hydraLoops(buildHydraIndex([{ beat: 1, event: 'setCode', code: 'x' }])), 1)
})

test('hydraFrameAt without a loop argument behaves as pass 0 (single-loop unchanged)', () => {
  const index = buildHydraIndex([
    { beat: 1, event: 'setCode', code: 'a' },
    { beat: 1, loop: 1, event: 'setCode', code: 'b' },
  ])
  assert.equal(hydraFrameAt(index, 99)!.code, 'a')
})
