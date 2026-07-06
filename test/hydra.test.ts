import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isHydraRow,
  hydraRows,
  buildHydraIndex,
  hydraFrameAt,
  type HydraFrame,
} from '../src/hydra.js'
import type { Row } from '../src/lineage.js'

const f = (frames: number): number => frames / 60

const frameAt = (rows: Row[] | null | undefined, frame: number): HydraFrame | null =>
  hydraFrameAt(buildHydraIndex(rows), frame)

test('isHydraRow / hydraRows recognise rows carrying code or variables', () => {
  const rows: Row[] = [
    { index: 0, code: 'src(s0).out()' },
    { index: f(1), speed: 2 },
    { index: f(2) }, // only control fields → not a hydra row
  ]
  assert.equal(isHydraRow(rows[0]), true)
  assert.equal(isHydraRow(rows[1]), true)
  assert.equal(isHydraRow(rows[2]), false)
  assert.equal(isHydraRow(null), false)
  assert.deepEqual(hydraRows(rows).length, 2)
  assert.deepEqual(hydraRows(null), [])
})

test('a code row becomes the active sketch with its variables in scope', () => {
  const frame = frameAt([
    { index: 0, code: 'src(s0).modulate(noise(amount), 0.1).out()', amount: 3 },
  ], 0)
  assert.ok(frame)
  assert.equal(frame!.code, 'src(s0).modulate(noise(amount), 0.1).out()')
  assert.deepEqual(frame!.vars, { amount: 3 })
})

test('no active sketch before the first code row', () => {
  const rows: Row[] = [
    { index: f(2), code: 'osc(speed).out()', speed: 1 },
  ]
  assert.equal(frameAt(rows, 0), null, 'before the first code')
  assert.equal(frameAt(rows, 1), null, 'still before')
  assert.ok(frameAt(rows, 2), 'at the code row')
  assert.ok(frameAt(rows, 9), 'after the code row it persists')
})

test('the latest code at/before the frame wins; code persists until replaced', () => {
  const rows: Row[] = [
    { index: 0, code: 'src(s0).out()' },
    { index: f(4), code: 'osc(10).out()' },
  ]
  assert.equal(frameAt(rows, 0)!.code, 'src(s0).out()')
  assert.equal(frameAt(rows, 3)!.code, 'src(s0).out()')
  assert.equal(frameAt(rows, 4)!.code, 'osc(10).out()')
  assert.equal(frameAt(rows, 99)!.code, 'osc(10).out()')
})

test('variables take their latest value while the sketch stays put', () => {
  const rows: Row[] = [
    { index: 0, code: 'osc(speed).out()', speed: 1, hue: 0 },
    { index: f(3), speed: 5 },
    { index: f(6), hue: 0.5 },
  ]
  assert.deepEqual(frameAt(rows, 0)!.vars, { speed: 1, hue: 0 })
  assert.deepEqual(frameAt(rows, 3)!.vars, { speed: 5, hue: 0 })
  assert.deepEqual(frameAt(rows, 6)!.vars, { speed: 5, hue: 0.5 })
  // the sketch is unchanged across all those variable updates
  assert.equal(frameAt(rows, 6)!.code, 'osc(speed).out()')
})

test('buildHydraIndex converts seconds to frames and sorts ascending', () => {
  const idx = buildHydraIndex([
    { index: f(5), code: 'b' },
    { index: f(1), code: 'a' },
  ])
  assert.deepEqual(idx.map((r) => [r.index, r.code]), [[1, 'a'], [5, 'b']])
})

test('empty / negative-frame inputs yield no sketch', () => {
  assert.equal(frameAt([], 0), null)
  assert.equal(frameAt(null, 0), null)
  assert.equal(frameAt([{ index: 0, code: 'src(s0).out()' }], -1), null)
})

test('a `beat` column places rows on the loop 1-indexed, scaled by beatSeconds', () => {
  // beat b sits at (b-1)*beatSeconds seconds → *FPS frames. With a half-second
  // beat, beat 1 is frame 0 and beat 9 is frame (9-1)*0.5*60 = 240.
  const idx = buildHydraIndex([
    { beat: 9, freq: 12 },
    { beat: 1, code: 'osc(freq).out(o0)', freq: 3 },
  ], 0.5)
  assert.deepEqual(idx.map((r) => r.index), [0, 240])
  // The `beat` control column is not injected as a sketch variable.
  assert.deepEqual(hydraFrameAt(idx, 0)!.vars, { freq: 3 })
  assert.deepEqual(hydraFrameAt(idx, 239)!.vars, { freq: 3 })
  assert.deepEqual(hydraFrameAt(idx, 240)!.vars, { freq: 12 })
})

test('beatSeconds scales beat placement (tempo change moves the rows)', () => {
  const rows: Row[] = [{ beat: 5, code: 'osc(1).out(o0)' }]
  // beat 5 → (5-1)*beatSeconds seconds.
  assert.equal(buildHydraIndex(rows, 0.5)[0].index, Math.round(4 * 0.5 * 60)) // 120
  assert.equal(buildHydraIndex(rows, 0.25)[0].index, Math.round(4 * 0.25 * 60)) // 60
})

test('`beat` wins over `index` when a row carries both', () => {
  const idx = buildHydraIndex([{ beat: 3, index: 99, code: 'osc(1).out(o0)' }], 0.5)
  assert.equal(idx[0].index, Math.round(2 * 0.5 * 60)) // beat 3, not index 99
})
