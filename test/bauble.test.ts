import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isBaubleRow,
  baubleRows,
  buildBaubleIndex,
  baubleFrameAt,
  baubleScript,
  baubleCodeUpToRow,
  baubleLoops,
  isBaubleCameraVar,
  type BaubleFrame,
} from '../src/bauble.js'
import { frameToBeat } from '../src/constants.js'
import type { Row } from '../src/lineage.js'

// The 1-indexed `beat` that lands a row on a given cache frame (30 frames/beat).
const b = (frame: number): number => frameToBeat(frame)

const frameAt = (rows: Row[] | null | undefined, frame: number): BaubleFrame | null =>
  baubleFrameAt(buildBaubleIndex(rows), frame)

test('isBaubleRow / baubleRows recognise setCode/setVariable events (and nothing else)', () => {
  const rows: Row[] = [
    { beat: 1, event: 'setCode', code: '(sphere 100)' },
    { beat: b(1), event: 'setVariable', name: 'size', value: 2 },
    { beat: b(2), event: 'append', code: '(box 50)' }, // a hydra meta event — not bauble
    { beat: b(2) },
  ]
  assert.equal(isBaubleRow(rows[0]), true)
  assert.equal(isBaubleRow(rows[1]), true)
  assert.equal(isBaubleRow(rows[2]), false)
  assert.equal(isBaubleRow(rows[3]), false)
  assert.equal(isBaubleRow(null), false)
  assert.deepEqual(baubleRows(rows).length, 2)
  assert.deepEqual(baubleRows(null), [])
})

test('a setCode event becomes the active sketch, a setVariable event binds a variable', () => {
  const frame = frameAt([
    { beat: 1, event: 'setCode', code: '(sphere (+ 50 size))' },
    { beat: 1, event: 'setVariable', name: 'size', value: 30 },
  ], 0)
  assert.ok(frame)
  assert.equal(frame!.code, '(sphere (+ 50 size))')
  assert.deepEqual(frame!.vars, { size: 30 })
})

test('the latest setCode event at/before the frame wins; code persists until replaced', () => {
  const rows: Row[] = [
    { beat: 1, event: 'setCode', code: '(sphere 100)' },
    { beat: b(4), event: 'setCode', code: '(box 50)' },
  ]
  assert.equal(frameAt(rows, 0)!.code, '(sphere 100)')
  assert.equal(frameAt(rows, 3)!.code, '(sphere 100)')
  assert.equal(frameAt(rows, 4)!.code, '(box 50)')
  assert.equal(frameAt(rows, 99)!.code, '(box 50)')
})

test('variables take their latest value while the sketch stays put', () => {
  const rows: Row[] = [
    { beat: 1, event: 'setCode', code: '(sphere size)' },
    { beat: 1, event: 'setVariable', name: 'size', value: 1 },
    { beat: 1, event: 'setVariable', name: 'spin', value: 0 },
    { beat: b(3), event: 'setVariable', name: 'size', value: 5 },
    { beat: b(6), event: 'setVariable', name: 'spin', value: 0.5 },
  ]
  assert.deepEqual(frameAt(rows, 0)!.vars, { size: 1, spin: 0 })
  assert.deepEqual(frameAt(rows, 3)!.vars, { size: 5, spin: 0 })
  assert.deepEqual(frameAt(rows, 6)!.vars, { size: 5, spin: 0.5 })
  assert.equal(frameAt(rows, 6)!.code, '(sphere size)')
})

test('baubleFrameAt samples the pass named by `loop`, folding earlier passes in full', () => {
  const index = buildBaubleIndex([
    { beat: 1, loop: 0, event: 'setCode', code: 'a' },
    { beat: 1, loop: 0, event: 'setVariable', name: 'amount', value: 1 },
    { beat: b(10), loop: 1, event: 'setCode', code: 'b' },
  ])
  assert.equal(baubleFrameAt(index, 0, 0)!.code, 'a', 'pass 0')
  assert.equal(baubleFrameAt(index, 0, 1)!.code, 'a', 'early in pass 1 the change has not hit yet')
  assert.equal(baubleFrameAt(index, 10, 1)!.code, 'b', 'pass 1 reaches its setCode')
  assert.equal(baubleFrameAt(index, 0, 2)!.code, 'b', 'a later pass folds pass 1 in full')
  assert.deepEqual(baubleFrameAt(index, 0, 2)!.vars, { amount: 1 }, 'variables persist across passes')
})

test('buildBaubleIndex orders rows by (loop, frame); baubleLoops counts the passes', () => {
  const index = buildBaubleIndex([
    { beat: 1, loop: 1, event: 'setCode', code: 'later' },
    { beat: b(5), event: 'setCode', code: 'first' }, // no loop → pass 0
  ])
  assert.deepEqual(index.map((r) => r.code), ['first', 'later'])
  assert.equal(baubleLoops(index), 2)
  assert.equal(baubleLoops(buildBaubleIndex([{ beat: 1, event: 'setCode', code: 'x' }])), 1)
  assert.equal(baubleFrameAt(index, 99)!.code, 'first', 'no loop argument behaves as pass 0')
})

test('baubleScript compiles variables as (def …) forms ahead of the code, in fold order', () => {
  assert.equal(
    baubleScript({ code: '(sphere size)', vars: { size: 80, spin: 0.5 } }),
    '(def size 80)\n(def spin 0.5)\n(sphere size)',
  )
  assert.equal(baubleScript({ code: '(sphere 100)', vars: {} }), '(sphere 100)')
})

test('a string variable is inserted verbatim — any Janet expression works', () => {
  assert.equal(
    baubleScript({ code: '(sphere size)', vars: { size: '(+ 50 (* 30 (sin t)))' } }),
    '(def size (+ 50 (* 30 (sin t))))\n(sphere size)',
  )
  assert.equal(
    baubleScript({ code: '(box 50)', vars: { solid: true } }),
    '(def solid true)\n(box 50)',
  )
})

test('unusable values (blank, null, objects, NaN) are skipped rather than compiled broken', () => {
  assert.equal(
    baubleScript({ code: '(box 50)', vars: { a: '', b: null, c: undefined, d: {}, e: NaN } }),
    '(box 50)',
  )
})

test('the reserved camera variables never reach the script (the renderer owns them)', () => {
  assert.equal(isBaubleCameraVar('camera-x'), true)
  assert.equal(isBaubleCameraVar('camera-y'), true)
  assert.equal(isBaubleCameraVar('camera-zoom'), true)
  assert.equal(isBaubleCameraVar('camera'), false)
  assert.equal(
    baubleScript({ code: '(box 50)', vars: { 'camera-x': 0.2, 'camera-zoom': 0.5, size: 10 } }),
    '(def size 10)\n(box 50)',
  )
})

test('baubleCodeUpToRow folds up to and including the given row (in raw table order)', () => {
  const rows: Row[] = [
    { beat: 1, event: 'setCode', code: '(sphere size)' },
    { beat: 1, event: 'setVariable', name: 'size', value: 50 },
    { beat: 5, event: 'setVariable', name: 'size', value: 90 },
    { beat: 9, event: 'setCode', code: '(box size)' },
  ]
  assert.equal(baubleCodeUpToRow(rows, 0), '(sphere size)')
  assert.equal(baubleCodeUpToRow(rows, 1), '(def size 50)\n(sphere size)')
  assert.equal(baubleCodeUpToRow(rows, 2), '(def size 90)\n(sphere size)')
  assert.equal(baubleCodeUpToRow(rows, 3), '(def size 90)\n(box size)')
})
