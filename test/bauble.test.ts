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
  pipeAppend,
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
    { beat: b(2), event: 'transform', code: 'twist :y 0.02' },
    { beat: b(2), event: 'duplicate', code: 'move [120 0 0]' },
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

test('pipeAppend grows a single form as one flat chain, wraps anything else', () => {
  // A (…) form takes the segment inside its closing paren…
  assert.equal(pipeAppend('(sphere 50)', 'move [80 0 0]'), '(sphere 50 | move [80 0 0])')
  // …so chains stay flat as they grow.
  assert.equal(pipeAppend('(sphere 50 | move [80 0 0])', 'shade [1 0 0]'), '(sphere 50 | move [80 0 0] | shade [1 0 0])')
  // A bare token (or anything not one balanced form) is wrapped.
  assert.equal(pipeAppend('S', 'twist :y 0.02'), '(S | twist :y 0.02)')
})

test('transform appends its `code` cell as a pipe segment; transforms stack flat in beat order', () => {
  const idx = buildBaubleIndex([
    { beat: 1, event: 'setCode', code: '(box 50)' },
    { beat: b(2), event: 'transform', code: 'twist :y 0.02' },
    { beat: b(3), event: 'transform', code: 'rotate :y t' },
    { beat: b(4), event: 'transform', code: 'symmetry' }, // a bare head works too
  ])
  assert.equal(baubleFrameAt(idx, 0)!.code, '(box 50)')
  assert.equal(baubleFrameAt(idx, 2)!.code, '(box 50 | twist :y 0.02)')
  assert.equal(baubleFrameAt(idx, 3)!.code, '(box 50 | twist :y 0.02 | rotate :y t)')
  assert.equal(baubleFrameAt(idx, 4)!.code, '(box 50 | twist :y 0.02 | rotate :y t | symmetry)')
})

test('duplicate combines the shape with a copy of itself run through the `code` segment', () => {
  const idx = buildBaubleIndex([
    { beat: 1, event: 'setCode', code: '(sphere 50)' },
    { beat: b(2), event: 'duplicate', code: 'move [120 0 0]' },
  ])
  assert.equal(baubleFrameAt(idx, 2)!.code, '(sphere 50 | union (sphere 50 | move [120 0 0]))')
})

test('duplicate picks the combiner from `mode`; `value` is the :r radius or morph amount', () => {
  const at = (mode?: string, value?: unknown) => {
    const row: Row = { beat: b(2), event: 'duplicate', code: 'move [40 0 0]' }
    if (mode !== undefined) row.mode = mode
    if (value !== undefined) row.value = value
    return baubleFrameAt(buildBaubleIndex([{ beat: 1, event: 'setCode', code: 'S' }, row]), 2)!.code
  }
  assert.equal(at('subtract', 10), '(S | subtract :r 10 (S | move [40 0 0]))')
  assert.equal(at('intersect'), '(S | intersect (S | move [40 0 0]))')
  assert.equal(at('morph', 0.3), '(S | morph (S | move [40 0 0]) 0.3)')
  assert.equal(at('morph'), '(S | morph (S | move [40 0 0]))')
  // An unknown mode falls back to union; a blank code duplicates verbatim.
  assert.equal(at('bogus', 15), '(S | union :r 15 (S | move [40 0 0]))')
  const plain = baubleFrameAt(buildBaubleIndex([
    { beat: 1, event: 'setCode', code: 'S' },
    { beat: b(2), event: 'duplicate', mode: 'morph' },
  ]), 2)!.code
  assert.equal(plain, '(S | morph S)')
})

test('combine composites another whole shape via `mode`, extending the chain', () => {
  const idx = buildBaubleIndex([
    { beat: 1, event: 'setCode', code: '(box 60)' },
    { beat: b(2), event: 'combine', code: '(sphere 70)', mode: 'subtract', value: 10 },
    { beat: b(3), event: 'combine', code: '(torus :x 80 20)' }, // default union, no value
  ])
  assert.equal(baubleFrameAt(idx, 2)!.code, '(box 60 | subtract :r 10 (sphere 70))')
  assert.equal(baubleFrameAt(idx, 3)!.code, '(box 60 | subtract :r 10 (sphere 70) | union (torus :x 80 20))')
})

test('a combine/morph `value` can be a Janet expression string, used verbatim', () => {
  const idx = buildBaubleIndex([
    { beat: 1, event: 'setCode', code: '(box 60)' },
    { beat: b(2), event: 'combine', code: '(sphere 80)', mode: 'morph', value: '(ss (sin t) -1 1)' },
  ])
  assert.equal(baubleFrameAt(idx, 2)!.code, '(box 60 | morph (sphere 80) (ss (sin t) -1 1))')
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

test('slice cuts the shape open: an onion shell minus a half-space (or a custom cutter)', () => {
  const idx = buildBaubleIndex([
    { beat: 1, event: 'setCode', code: '(sphere 70)' },
    { beat: b(2), event: 'slice', value: 5, axis: 'x' },
  ])
  assert.equal(baubleFrameAt(idx, 2)!.code, '(sphere 70 | onion 5 | subtract (half-space :x))')
  // Defaults: thickness 3, axis y; a `code` cell supplies a custom cutter.
  const defaults = buildBaubleIndex([
    { beat: 1, event: 'setCode', code: 'S' },
    { beat: b(2), event: 'slice' },
    { beat: b(3), event: 'slice', code: '(half-space :y 20)' },
  ])
  assert.equal(baubleFrameAt(defaults, 2)!.code, '(S | onion 3 | subtract (half-space :y))')
  assert.equal(
    baubleFrameAt(defaults, 3)!.code,
    '(S | onion 3 | subtract (half-space :y) | onion 3 | subtract (half-space :y 20))',
  )
})

test('tile repeats on a lattice: a number spaces all axes, a string vec3 is verbatim, none is a no-op', () => {
  const at = (value?: unknown) => {
    const row: Row = { beat: b(2), event: 'tile' }
    if (value !== undefined) row.value = value
    return baubleFrameAt(buildBaubleIndex([{ beat: 1, event: 'setCode', code: 'S' }, row]), 2)!.code
  }
  assert.equal(at(90), '(S | tile [90 90 90])')
  assert.equal(at('[80 120 80]'), '(S | tile [80 120 80])')
  assert.equal(at(), 'S')
  assert.equal(at(0), 'S', 'zero spacing is degenerate — skipped')
})

test('radial repeats in a circle about `axis`, defaulting to 6 copies about y', () => {
  const idx = buildBaubleIndex([
    { beat: 1, event: 'setCode', code: '(move (box 15) [70 0 0])' },
    { beat: b(2), event: 'radial', value: 8, axis: 'z' },
    { beat: b(3), event: 'radial' },
  ])
  assert.equal(baubleFrameAt(idx, 2)!.code, '(move (box 15) [70 0 0] | radial :z 8)')
  assert.equal(baubleFrameAt(idx, 3)!.code, '(move (box 15) [70 0 0] | radial :z 8 | radial :y 6)')
})

test('transition morphs from the before program to the after, on the t clock', () => {
  const idx = buildBaubleIndex([
    { beat: 1, event: 'setCode', code: '(box 60)' },
    // At the same beat: the transition (snapshots the box as "before"), then
    // the destination program that folds on as the live "after".
    { beat: 5, event: 'transition', value: 4 }, // frames 120–240 → t 2s–4s
    { beat: 5, event: 'setCode', code: '(sphere 70)' },
  ])
  // Before the transition beat, just the before program.
  assert.equal(baubleFrameAt(idx, 0)!.code, '(box 60)')
  // Inside the window: a morph whose amount rides the playback clock. The
  // string is byte-stable across the whole window — no recompile mid-wipe.
  const at = baubleFrameAt(idx, 120)!
  assert.equal(at.code, '(box 60 | morph (sphere 70) (ss t 2 4))')
  assert.equal(baubleFrameAt(idx, 180)!.code, at.code)
  assert.equal(baubleFrameAt(idx, 239)!.code, at.code)
  // Once the window elapses the wipe is done and collapses to the after.
  assert.equal(baubleFrameAt(idx, 240)!.code, '(sphere 70)')
})

test('transition composes with meta events as the after program; nested wipes wrap in beat order', () => {
  const idx = buildBaubleIndex([
    { beat: 1, event: 'setCode', code: '(box 60)' },
    { beat: 5, event: 'transition', value: 8 }, // frames 120–360 → t 2s–6s
    { beat: 5, event: 'setCode', code: '(sphere 70)' },
    { beat: 9, event: 'transition', value: 2 }, // frames 240–300 → t 4s–5s
    { beat: 9, event: 'transform', code: 'twist :y 0.02' },
  ])
  // At beat 9 both windows are live: the inner wipe goes sphere → twisted
  // sphere, the outer wraps it from the box.
  assert.equal(
    baubleFrameAt(idx, 240)!.code,
    '(box 60 | morph (sphere 70 | morph (sphere 70 | twist :y 0.02) (ss t 4 5)) (ss t 2 6))',
  )
  // The inner wipe finishes at frame 300; only the outer remains.
  assert.equal(
    baubleFrameAt(idx, 300)!.code,
    '(box 60 | morph (sphere 70 | twist :y 0.02) (ss t 2 6))',
  )
})

test('meta events before any setCode are no-ops', () => {
  const idx = buildBaubleIndex([
    { beat: 1, event: 'transform', code: 'twist :y 0.02' },
    { beat: 1, event: 'duplicate', code: 'move [40 0 0]' },
    { beat: 1, event: 'combine', code: '(sphere 40)' },
    { beat: 1, event: 'replace', find: 'a', value: 'b' },
    { beat: 1, event: 'slice' },
    { beat: 1, event: 'tile', value: 90 },
    { beat: 1, event: 'radial' },
    { beat: 1, event: 'transition', value: 2 },
    { beat: b(2), event: 'setCode', code: '(box 50)' },
  ])
  assert.equal(baubleFrameAt(idx, 0), null)
  assert.equal(baubleFrameAt(idx, 2)!.code, '(box 50)')
})

test('meta events compose in beat order and fold across loop passes', () => {
  const idx = buildBaubleIndex([
    { beat: 1, loop: 0, event: 'setCode', code: '(box 50)' },
    { beat: b(4), loop: 0, event: 'duplicate', code: 'move [120 0 0]' },
    { beat: b(2), loop: 1, event: 'replace', find: '50', value: '70' },
  ])
  assert.equal(baubleFrameAt(idx, 0, 1)!.code, '(box 50 | union (box 50 | move [120 0 0]))')
  assert.equal(baubleFrameAt(idx, 2, 1)!.code, '(box 70 | union (box 70 | move [120 0 0]))')
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
    { beat: 5, event: 'transform', code: 'twist :y 0.02' },
    { beat: 7, event: 'combine', code: '(sphere 40)', mode: 'subtract', value: 5 },
    { beat: 9, event: 'replace', find: '50', value: '65' },
  ]
  assert.equal(baubleCodeUpToRow(rows, 0), '(box 50)')
  assert.equal(baubleCodeUpToRow(rows, 1), '(box 50 | twist :y 0.02)')
  assert.equal(baubleCodeUpToRow(rows, 2), '(box 50 | twist :y 0.02 | subtract :r 5 (sphere 40))')
  assert.equal(baubleCodeUpToRow(rows, 3), '(box 65 | twist :y 0.02 | subtract :r 5 (sphere 40))')
})
