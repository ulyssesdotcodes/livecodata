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
  applyForm,
  type BaubleFrame,
} from '../src/bauble.js'
import { frameToBeat } from '../src/constants.js'
import type { Row } from '../src/lineage.js'

// The 1-indexed `beat` that lands a row on a given cache frame (30 frames/beat).
const b = (frame: number): number => frameToBeat(frame)

const frameAt = (rows: Row[] | null | undefined, frame: number): BaubleFrame | null =>
  baubleFrameAt(buildBaubleIndex(rows), frame)

test('isBaubleRow / baubleRows recognise the bauble events (and nothing else)', () => {
  const rows: Row[] = [
    { beat: 1, event: 'setCode', code: '(sphere 100)' },
    { beat: b(1), event: 'setVariable', name: 'size', value: 2 },
    { beat: b(2), event: 'transform', code: '(twist _ :y 0.02)' },
    { beat: b(2), event: 'duplicate', code: '(move _ [120 0 0])' },
    { beat: b(3), event: 'combine', code: '(sphere 40)', mode: 'subtract' },
    { beat: b(3), event: 'replace', find: '100', value: 80 },
    { beat: b(4), event: 'append', code: '.kaleid(4)' }, // a hydra-only meta event
    { beat: b(4) },
  ]
  for (const i of [0, 1, 2, 3, 4, 5]) assert.equal(isBaubleRow(rows[i]), true, `row ${i}`)
  assert.equal(isBaubleRow(rows[6]), false)
  assert.equal(isBaubleRow(rows[7]), false)
  assert.equal(isBaubleRow(null), false)
  assert.deepEqual(baubleRows(rows).length, 6)
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

// --- meta-programming events: transform / duplicate / combine / replace ------

test('applyForm fills every standalone `_` hole, leaves longer symbols alone', () => {
  assert.equal(applyForm('(twist _ :y 0.02)', '(box 50)'), '(twist (box 50) :y 0.02)')
  assert.equal(applyForm('(union _ (mirror _ :x))', '(box 50)'), '(union (box 50) (mirror (box 50) :x))')
  // `_` inside a longer symbol is not a hole: the subject inserts as first arg.
  assert.equal(applyForm('(foo_bar 1)', 'S'), '(foo_bar S 1)')
})

test('applyForm without a hole inserts the shape as the first argument; a bare symbol becomes a call', () => {
  assert.equal(applyForm('(rotate :y t)', '(box 50)'), '(rotate (box 50) :y t)')
  assert.equal(applyForm('symmetry', '(box 50)'), '(symmetry (box 50))')
})

test('transform wraps the current shape; transforms stack in beat order', () => {
  const idx = buildBaubleIndex([
    { beat: 1, event: 'setCode', code: '(box 50)' },
    { beat: b(2), event: 'transform', code: '(twist _ :y 0.02)' },
    { beat: b(3), event: 'transform', code: '(rotate :y t)' }, // no hole → first arg
  ])
  assert.equal(baubleFrameAt(idx, 0)!.code, '(box 50)')
  assert.equal(baubleFrameAt(idx, 2)!.code, '(twist (box 50) :y 0.02)')
  assert.equal(baubleFrameAt(idx, 3)!.code, '(rotate (twist (box 50) :y 0.02) :y t)')
})

test('duplicate combines the shape with a transformed copy of itself', () => {
  const idx = buildBaubleIndex([
    { beat: 1, event: 'setCode', code: '(sphere 50)' },
    { beat: b(2), event: 'duplicate', code: '(move _ [120 0 0])' },
  ])
  assert.equal(baubleFrameAt(idx, 2)!.code, '(union (sphere 50) (move (sphere 50) [120 0 0]))')
})

test('duplicate picks the combiner from `mode`; `value` is the :r radius or morph amount', () => {
  const at = (mode?: string, value?: unknown) => {
    const row: Row = { beat: b(2), event: 'duplicate', code: '(move _ [40 0 0])' }
    if (mode !== undefined) row.mode = mode
    if (value !== undefined) row.value = value
    return baubleFrameAt(buildBaubleIndex([{ beat: 1, event: 'setCode', code: 'S' }, row]), 2)!.code
  }
  assert.equal(at('subtract', 10), '(subtract :r 10 S (move S [40 0 0]))')
  assert.equal(at('intersect'), '(intersect S (move S [40 0 0]))')
  assert.equal(at('morph', 0.3), '(morph S (move S [40 0 0]) 0.3)')
  assert.equal(at('morph'), '(morph S (move S [40 0 0]))')
  // An unknown mode falls back to union; a blank code duplicates verbatim.
  assert.equal(at('bogus', 15), '(union :r 15 S (move S [40 0 0]))')
  const plain = baubleFrameAt(buildBaubleIndex([
    { beat: 1, event: 'setCode', code: 'S' },
    { beat: b(2), event: 'duplicate', mode: 'morph' },
  ]), 2)!.code
  assert.equal(plain, '(morph S S)')
})

test('combine composites another whole shape via `mode`', () => {
  const idx = buildBaubleIndex([
    { beat: 1, event: 'setCode', code: '(box 60)' },
    { beat: b(2), event: 'combine', code: '(sphere 70)', mode: 'subtract', value: 10 },
    { beat: b(3), event: 'combine', code: '(torus :x 80 20)' }, // default union, no value
  ])
  assert.equal(baubleFrameAt(idx, 2)!.code, '(subtract :r 10 (box 60) (sphere 70))')
  assert.equal(baubleFrameAt(idx, 3)!.code, '(union (subtract :r 10 (box 60) (sphere 70)) (torus :x 80 20))')
})

test('a combine/morph `value` can be a Janet expression string, used verbatim', () => {
  const idx = buildBaubleIndex([
    { beat: 1, event: 'setCode', code: '(box 60)' },
    { beat: b(2), event: 'combine', code: '(sphere 80)', mode: 'morph', value: '(ss (sin t) -1 1)' },
  ])
  assert.equal(baubleFrameAt(idx, 2)!.code, '(morph (box 60) (sphere 80) (ss (sin t) -1 1))')
})

test('replace swaps every occurrence of the literal string in the current code', () => {
  const idx = buildBaubleIndex([
    { beat: 1, event: 'setCode', code: '(union (sphere 50) (move (sphere 50) [90 0 0]))' },
    { beat: b(4), event: 'replace', find: 'sphere 50', value: 'box 40' },
    { beat: b(5), event: 'replace', find: '', value: 'x' },
  ])
  assert.equal(baubleFrameAt(idx, 4)!.code, '(union (box 40) (move (box 40) [90 0 0]))')
  assert.equal(baubleFrameAt(idx, 5)!.code, '(union (box 40) (move (box 40) [90 0 0]))', 'empty find changes nothing')
})

test('meta events before any setCode are no-ops', () => {
  const idx = buildBaubleIndex([
    { beat: 1, event: 'transform', code: '(twist _ :y 0.02)' },
    { beat: 1, event: 'duplicate', code: '(move _ [40 0 0])' },
    { beat: 1, event: 'combine', code: '(sphere 40)' },
    { beat: 1, event: 'replace', find: 'a', value: 'b' },
    { beat: b(2), event: 'setCode', code: '(box 50)' },
  ])
  assert.equal(baubleFrameAt(idx, 0), null)
  assert.equal(baubleFrameAt(idx, 2)!.code, '(box 50)')
})

test('meta events compose in beat order and fold across loop passes', () => {
  const idx = buildBaubleIndex([
    { beat: 1, loop: 0, event: 'setCode', code: '(box 50)' },
    { beat: b(4), loop: 0, event: 'duplicate', code: '(move _ [120 0 0])' },
    { beat: b(2), loop: 1, event: 'replace', find: '50', value: '70' },
  ])
  assert.equal(baubleFrameAt(idx, 0, 1)!.code, '(union (box 50) (move (box 50) [120 0 0]))')
  assert.equal(baubleFrameAt(idx, 2, 1)!.code, '(union (box 70) (move (box 70) [120 0 0]))')
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

test('baubleCodeUpToRow shows each meta event\'s running program in turn', () => {
  const rows: Row[] = [
    { beat: 1, event: 'setCode', code: '(box 50)' },
    { beat: 5, event: 'transform', code: '(twist _ :y 0.02)' },
    { beat: 7, event: 'combine', code: '(sphere 40)', mode: 'subtract', value: 5 },
    { beat: 9, event: 'replace', find: '50', value: '65' },
  ]
  assert.equal(baubleCodeUpToRow(rows, 0), '(box 50)')
  assert.equal(baubleCodeUpToRow(rows, 1), '(twist (box 50) :y 0.02)')
  assert.equal(baubleCodeUpToRow(rows, 2), '(subtract :r 5 (twist (box 50) :y 0.02) (sphere 40))')
  assert.equal(baubleCodeUpToRow(rows, 3), '(subtract :r 5 (twist (box 65) :y 0.02) (sphere 40))')
})
