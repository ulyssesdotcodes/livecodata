import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isHydraRow,
  hydraRows,
  buildHydraIndex,
  hydraFrameAt,
  type HydraFrame,
} from '../src/hydra.js'
import { frameToBeat } from '../src/constants.js'
import type { Row } from '../src/lineage.js'

// The 1-indexed `beat` that lands a row on a given cache frame (30 frames/beat).
const b = (frame: number): number => frameToBeat(frame)

const frameAt = (rows: Row[] | null | undefined, frame: number): HydraFrame | null =>
  hydraFrameAt(buildHydraIndex(rows), frame)

test('isHydraRow / hydraRows recognise rows carrying code or variables', () => {
  const rows: Row[] = [
    { beat: 1, code: 'src(s0).out()' },
    { beat: b(1), speed: 2 },
    { beat: b(2) }, // only control fields → not a hydra row
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
    { beat: 1, code: 'src(s0).modulate(noise(amount), 0.1).out()', amount: 3 },
  ], 0)
  assert.ok(frame)
  assert.equal(frame!.code, 'src(s0).modulate(noise(amount), 0.1).out()')
  assert.deepEqual(frame!.vars, { amount: 3 })
})

test('no active sketch before the first code row', () => {
  const rows: Row[] = [
    { beat: b(2), code: 'osc(speed).out()', speed: 1 },
  ]
  assert.equal(frameAt(rows, 0), null, 'before the first code')
  assert.equal(frameAt(rows, 1), null, 'still before')
  assert.ok(frameAt(rows, 2), 'at the code row')
  assert.ok(frameAt(rows, 9), 'after the code row it persists')
})

test('the latest code at/before the frame wins; code persists until replaced', () => {
  const rows: Row[] = [
    { beat: 1, code: 'src(s0).out()' },
    { beat: b(4), code: 'osc(10).out()' },
  ]
  assert.equal(frameAt(rows, 0)!.code, 'src(s0).out()')
  assert.equal(frameAt(rows, 3)!.code, 'src(s0).out()')
  assert.equal(frameAt(rows, 4)!.code, 'osc(10).out()')
  assert.equal(frameAt(rows, 99)!.code, 'osc(10).out()')
})

test('variables take their latest value while the sketch stays put', () => {
  const rows: Row[] = [
    { beat: 1, code: 'osc(speed).out()', speed: 1, hue: 0 },
    { beat: b(3), speed: 5 },
    { beat: b(6), hue: 0.5 },
  ]
  assert.deepEqual(frameAt(rows, 0)!.vars, { speed: 1, hue: 0 })
  assert.deepEqual(frameAt(rows, 3)!.vars, { speed: 5, hue: 0 })
  assert.deepEqual(frameAt(rows, 6)!.vars, { speed: 5, hue: 0.5 })
  // the sketch is unchanged across all those variable updates
  assert.equal(frameAt(rows, 6)!.code, 'osc(speed).out()')
})

test('buildHydraIndex places rows on the frame grid by beat and sorts ascending', () => {
  const idx = buildHydraIndex([
    { beat: b(5), code: 'b' },
    { beat: b(1), code: 'a' },
  ])
  assert.deepEqual(idx.map((r) => [r.index, r.code]), [[1, 'a'], [5, 'b']])
})

test('empty / negative-frame inputs yield no sketch', () => {
  assert.equal(frameAt([], 0), null)
  assert.equal(frameAt(null, 0), null)
  assert.equal(frameAt([{ beat: 1, code: 'src(s0).out()' }], -1), null)
})

test('a `beat` column places rows on the loop 1-indexed (30 frames/beat)', () => {
  // beat b sits at (b-1)*30 frames. beat 1 → frame 0, beat 9 → frame 240.
  const idx = buildHydraIndex([
    { beat: 9, freq: 12 },
    { beat: 1, code: 'osc(freq).out(o0)', freq: 3 },
  ])
  assert.deepEqual(idx.map((r) => r.index), [0, 240])
  // The `beat` control column is not injected as a sketch variable.
  assert.deepEqual(hydraFrameAt(idx, 0)!.vars, { freq: 3 })
  assert.deepEqual(hydraFrameAt(idx, 239)!.vars, { freq: 3 })
  assert.deepEqual(hydraFrameAt(idx, 240)!.vars, { freq: 12 })
})

test('rows without a beat default to beat 1 (frame 0)', () => {
  const idx = buildHydraIndex([{ code: 'osc(1).out(o0)' }])
  assert.equal(idx[0].index, 0)
})
