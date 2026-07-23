import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isBaubleRow,
  baubleRows,
  buildBaubleIndex,
  baubleFrameAt,
  baubleScript,
  baubleCodeUpToRow,
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

test('the beat axis is absolute: a beat past the loop folds once the extended frame reaches it', () => {
  // Playback samples a later pass at pass * loopFrames + frame — an event
  // beyond the loop's span (here frame 100) is simply further along the grid.
  const index = buildBaubleIndex([
    { beat: 1, event: 'setCode', code: 'a' },
    { beat: 1, event: 'setVariable', name: 'amount', value: 1 },
    { beat: b(110), event: 'setCode', code: 'b' },
  ])
  assert.equal(baubleFrameAt(index, 0)!.code, 'a', 'pass 0')
  assert.equal(baubleFrameAt(index, 100)!.code, 'a', 'early in pass 1 the change has not hit yet')
  assert.equal(baubleFrameAt(index, 110)!.code, 'b', 'pass 1 reaches its setCode')
  assert.equal(baubleFrameAt(index, 200)!.code, 'b', 'a later pass folds pass 1 in full')
  assert.deepEqual(baubleFrameAt(index, 200)!.vars, { amount: 1 }, 'variables persist across passes')
})

test('buildBaubleIndex orders rows by frame', () => {
  const index = buildBaubleIndex([
    { beat: b(20), event: 'setCode', code: 'later' },
    { beat: b(5), event: 'setCode', code: 'first' },
  ])
  assert.deepEqual(index.map((r) => r.code), ['first', 'later'])
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

test('slice cuts the shape open: an onion shell minus a half-space (or a custom cutter)', () => {
  const idx = buildBaubleIndex([
    { beat: 1, event: 'setCode', code: '(sphere 70)' },
    { beat: b(2), event: 'slice', value: 5, axis: 'x' },
  ])
  assert.equal(baubleFrameAt(idx, 2)!.code, '(subtract (onion (sphere 70) 5) (half-space :x))')
  // Defaults: thickness 3, axis y; a `code` cell supplies a custom cutter.
  const defaults = buildBaubleIndex([
    { beat: 1, event: 'setCode', code: 'S' },
    { beat: b(2), event: 'slice' },
    { beat: b(3), event: 'slice', code: '(half-space :y 20)' },
  ])
  assert.equal(baubleFrameAt(defaults, 2)!.code, '(subtract (onion S 3) (half-space :y))')
  assert.equal(
    baubleFrameAt(defaults, 3)!.code,
    '(subtract (onion (subtract (onion S 3) (half-space :y)) 3) (half-space :y 20))',
  )
})

test('tile repeats on a lattice: a number spaces all axes, a string vec3 is verbatim, none is a no-op', () => {
  const at = (value?: unknown) => {
    const row: Row = { beat: b(2), event: 'tile' }
    if (value !== undefined) row.value = value
    return baubleFrameAt(buildBaubleIndex([{ beat: 1, event: 'setCode', code: 'S' }, row]), 2)!.code
  }
  assert.equal(at(90), '(tile S [90 90 90])')
  assert.equal(at('[80 120 80]'), '(tile S [80 120 80])')
  assert.equal(at(), 'S')
  assert.equal(at(0), 'S', 'zero spacing is degenerate — skipped')
})

test('radial repeats in a circle about `axis`, defaulting to 6 copies about y', () => {
  const idx = buildBaubleIndex([
    { beat: 1, event: 'setCode', code: '(move (box 15) [70 0 0])' },
    { beat: b(2), event: 'radial', value: 8, axis: 'z' },
    { beat: b(3), event: 'radial' },
  ])
  assert.equal(baubleFrameAt(idx, 2)!.code, '(radial (move (box 15) [70 0 0]) :z 8)')
  assert.equal(baubleFrameAt(idx, 3)!.code, '(radial (radial (move (box 15) [70 0 0]) :z 8) :y 6)')
})

test('transition morphs to the next setCode ahead, over the frames between them', () => {
  const idx = buildBaubleIndex([
    { beat: 1, event: 'setCode', code: '(box 60)' },
    { beat: 5, event: 'transition' },                    // frame 120 → t 2s
    { beat: 9, event: 'setCode', code: '(sphere 70)' },  // frame 240 → t 4s = window end
  ])
  // Before the transition beat, just the before program.
  assert.equal(baubleFrameAt(idx, 0)!.code, '(box 60)')
  // Inside the window: a morph whose amount rides the playback clock. Look-ahead
  // reveals (sphere 70) though its setCode is at beat 9. Byte-stable — no
  // recompile mid-wipe.
  const at = baubleFrameAt(idx, 180)!
  assert.equal(at.code, '(morph (box 60) (sphere 70) (ss t 2 4))')
  assert.equal(baubleFrameAt(idx, 239)!.code, at.code)
  // The window END is the setCode's own frame (end-exclusive): plain after.
  assert.equal(baubleFrameAt(idx, 240)!.code, '(sphere 70)')
})

test('a destination setCode on the transition’s own beat morphs a full loop pass', () => {
  // loopFrames 240 (one pass, seqLen 240): the co-located setCode gives a
  // zero-distance next → the morph fills a whole pass, t 2s → 6s.
  const idx = buildBaubleIndex([
    { beat: 1, event: 'setCode', code: '(box 60)' },     // frame 0
    { beat: 5, event: 'transition' },                    // frame 120
    { beat: 5, event: 'setCode', code: '(sphere 70)' },  // frame 120 (destination)
  ])
  const at = baubleFrameAt(idx, 180, 240)!
  assert.equal(at.code, '(morph (box 60) (sphere 70) (ss t 2 6))')
  assert.equal(baubleFrameAt(idx, 0, 240)!.code, at.code)
})

test('nested transitions wiping to a shared setCode compose in beat order', () => {
  const idx = buildBaubleIndex([
    { beat: 1, event: 'setCode', code: '(box 60)' },     // frame 0
    { beat: 5, event: 'transition' },                    // frame 120 (outer)
    { beat: 9, event: 'transition' },                    // frame 240 (inner)
    { beat: 13, event: 'setCode', code: '(sphere 70)' }, // frame 360 (both ends)
    { beat: 13, event: 'transform', code: '(twist _ :y 0.02)' }, // folds onto the destination
  ])
  // At frame 300 both windows are live: the after (folded to frame 360, the
  // transform riding on the destination setCode) is the twisted sphere; the
  // inner morphs the box toward it, the outer wraps that from the box.
  const after = '(twist (sphere 70) :y 0.02)'
  assert.equal(
    baubleFrameAt(idx, 300)!.code,
    `(morph (box 60) (morph (box 60) ${after} (ss t 4 6)) (ss t 2 6))`,
  )
})

test('meta events before any setCode are no-ops', () => {
  const idx = buildBaubleIndex([
    { beat: 1, event: 'transform', code: '(twist _ :y 0.02)' },
    { beat: 1, event: 'duplicate', code: '(move _ [40 0 0])' },
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
    { beat: 1, event: 'setCode', code: '(box 50)' },
    { beat: b(4), event: 'duplicate', code: '(move _ [120 0 0])' },
    { beat: b(102), event: 'replace', find: '50', value: '70' }, // beyond a 100-frame loop → a later pass
  ])
  assert.equal(baubleFrameAt(idx, 100)!.code, '(union (box 50) (move (box 50) [120 0 0]))')
  assert.equal(baubleFrameAt(idx, 102)!.code, '(union (box 70) (move (box 70) [120 0 0]))')
})

test('baubleCodeUpToRow samples the full fold at the given row’s frame', () => {
  const rows: Row[] = [
    { beat: 1, event: 'setCode', code: '(sphere size)' },
    { beat: 1, event: 'setVariable', name: 'size', value: 50 },
    { beat: 5, event: 'setVariable', name: 'size', value: 90 },
    { beat: 9, event: 'setCode', code: '(box size)' },
  ]
  // Rows 0 and 1 share beat 1: both show the runtime snapshot there (the
  // same-beat variable included), not a slice stopping at each row.
  assert.equal(baubleCodeUpToRow(rows, 0), '(def size 50)\n(sphere size)')
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
