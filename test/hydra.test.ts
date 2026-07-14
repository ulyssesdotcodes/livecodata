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

// --- meta-programming events: replace / append / layer -----------------------

test('isHydraRow / hydraRows recognise the meta-programming events', () => {
  const rows: Row[] = [
    { beat: 1, event: 'setSource', code: 'osc(20)' },
    { beat: 1, event: 'replace', find: 'a', value: 'b' },
    { beat: 1, event: 'append', code: '.rotate(0.1)' },
    { beat: 1, event: 'layer', code: 'noise(3).out(o0)', mode: 'add' },
    { beat: 1, event: 'nonsense' },
  ]
  assert.equal(isHydraRow(rows[0]), true)
  assert.equal(isHydraRow(rows[1]), true)
  assert.equal(isHydraRow(rows[2]), true)
  assert.equal(isHydraRow(rows[3]), true)
  assert.equal(isHydraRow(rows[4]), false)
  assert.equal(hydraRows(rows).length, 4)
})

test('setSource swaps the head generator, keeping the effects after it', () => {
  const idx = buildHydraIndex([
    { beat: 1, event: 'setCode', code: 'src(s0).kaleid(5).out(o0)' },
    { beat: b(2), event: 'setSource', code: 'osc(20, 0.1)' },
  ])
  assert.equal(hydraFrameAt(idx, 0)!.code, 'src(s0).kaleid(5).out(o0)')
  assert.equal(hydraFrameAt(idx, 2)!.code, 'osc(20, 0.1).kaleid(5).out(o0)')
})

test('setSource keeps the head args balanced across nested parens and arrows', () => {
  const idx = buildHydraIndex([
    { beat: 1, event: 'setCode', code: 'osc((props) => props.freq, 0.1).modulate(noise(2)).out(o0)' },
    { beat: b(2), event: 'setSource', code: 'src(s0)' },
  ])
  assert.equal(hydraFrameAt(idx, 2)!.code, 'src(s0).modulate(noise(2)).out(o0)')
})

test('setSource brings the new source’s own leading effects, strips its .out()', () => {
  const idx = buildHydraIndex([
    { beat: 1, event: 'setCode', code: 'osc(10).kaleid(4).out(o0)' },
    { beat: b(2), event: 'setSource', code: 'noise(3).colorama(0.5).out(o0)' },
  ])
  assert.equal(hydraFrameAt(idx, 2)!.code, 'noise(3).colorama(0.5).kaleid(4).out(o0)')
})

test('setSource before any setCode is a no-op', () => {
  const idx = buildHydraIndex([
    { beat: 1, event: 'setSource', code: 'osc(10)' },
    { beat: b(2), event: 'setCode', code: 'src(s0).out(o0)' },
  ])
  assert.equal(hydraFrameAt(idx, 0), null)
  assert.equal(hydraFrameAt(idx, 2)!.code, 'src(s0).out(o0)')
})

test('replace swaps every occurrence of the literal string in the current code', () => {
  const rows: Row[] = [
    { beat: 1, event: 'setCode', code: 'osc(10).modulate(osc(10)).out(o0)' },
    { beat: b(4), event: 'replace', find: 'osc', value: 'noise' },
  ]
  const idx = buildHydraIndex(rows)
  assert.equal(hydraFrameAt(idx, 0)!.code, 'osc(10).modulate(osc(10)).out(o0)')
  assert.equal(hydraFrameAt(idx, 4)!.code, 'noise(10).modulate(noise(10)).out(o0)')
})

test('replace before any setCode is a no-op (nothing to transform yet)', () => {
  const idx = buildHydraIndex([
    { beat: 1, event: 'replace', find: 'a', value: 'b' },
    { beat: b(2), event: 'setCode', code: 'osc(a).out(o0)' },
  ])
  // The replace at beat 1 saw no code; the beat-2 code arrives untouched.
  assert.equal(hydraFrameAt(idx, 0), null)
  assert.equal(hydraFrameAt(idx, 2)!.code, 'osc(a).out(o0)')
})

test('replace coerces a non-string replacement and ignores an empty find', () => {
  const idx = buildHydraIndex([
    { beat: 1, event: 'setCode', code: 'osc(FREQ).out(o0)' },
    { beat: b(2), event: 'replace', find: 'FREQ', value: 12 },
    { beat: b(3), event: 'replace', find: '', value: 'x' },
  ])
  assert.equal(hydraFrameAt(idx, 2)!.code, 'osc(12).out(o0)')
  assert.equal(hydraFrameAt(idx, 3)!.code, 'osc(12).out(o0)', 'empty find changes nothing')
})

test('append extends the chain with a fragment, before the .out()', () => {
  const idx = buildHydraIndex([
    { beat: 1, event: 'setCode', code: 'osc(10).out(o0)' },
    { beat: b(2), event: 'append', code: '.rotate(0.1)' },
    { beat: b(3), event: 'append', code: '.kaleid(4)' },
  ])
  assert.equal(hydraFrameAt(idx, 2)!.code, 'osc(10).rotate(0.1).out(o0)')
  assert.equal(hydraFrameAt(idx, 3)!.code, 'osc(10).rotate(0.1).kaleid(4).out(o0)')
})

test('append tolerates a missing .out() and trims/ignores blank fragments', () => {
  const idx = buildHydraIndex([
    { beat: 1, event: 'setCode', code: 'osc(10)' },
    { beat: b(2), event: 'append', code: '  .rotate(0.1)  ' },
    { beat: b(3), event: 'append', code: '   ' },
  ])
  assert.equal(hydraFrameAt(idx, 2)!.code, 'osc(10).rotate(0.1).out(o0)')
  assert.equal(hydraFrameAt(idx, 3)!.code, 'osc(10).rotate(0.1).out(o0)', 'blank fragment is a no-op')
})

test('layer defaults to blend mode; a value supplies the crossfade amount', () => {
  const idx = buildHydraIndex([
    { beat: 1, event: 'setCode', code: 'src(s0).out(o0)' },
    { beat: b(2), event: 'layer', code: 'noise(3).colorama(0.5).out(o0)', value: 0.3 },
  ])
  assert.equal(
    hydraFrameAt(idx, 2)!.code,
    'src(s0).blend(noise(3).colorama(0.5), 0.3).out(o0)',
  )
})

test('layer picks the compositing operator from `mode`', () => {
  const at = (mode: string, value?: unknown) => {
    const row: Row = { beat: b(2), event: 'layer', code: 'noise(3).out(o0)', mode }
    if (value !== undefined) row.value = value
    return hydraFrameAt(buildHydraIndex([
      { beat: 1, event: 'setCode', code: 'osc(10).out(o0)' },
      row,
    ]), 2)!.code
  }
  // amount-taking modes carry the value; amount-free modes ignore it
  assert.equal(at('add', 1), 'osc(10).add(noise(3), 1).out(o0)')
  assert.equal(at('mult', 0.5), 'osc(10).mult(noise(3), 0.5).out(o0)')
  assert.equal(at('diff', 0.9), 'osc(10).diff(noise(3)).out(o0)')
  assert.equal(at('layer'), 'osc(10).layer(noise(3)).out(o0)')
  assert.equal(at('mask'), 'osc(10).mask(noise(3)).out(o0)')
  // an unknown mode falls back to blend
  assert.equal(at('bogus', 0.4), 'osc(10).blend(noise(3), 0.4).out(o0)')
})

test('layer amount can be a live expression evaluated with props each frame', () => {
  const idx = buildHydraIndex([
    { beat: 1, event: 'setCode', code: 'osc(10).out(o0)' },
    { beat: b(2), event: 'layer', code: 'noise(3).out(o0)', mode: 'add', value: 'props.mix' },
    { beat: b(3), event: 'layer', code: 'voronoi().out(o0)', value: '({time}) => Math.sin(time)' },
  ])
  assert.equal(
    hydraFrameAt(idx, 2)!.code,
    'osc(10).add(noise(3), (props) => (props.mix)).out(o0)',
  )
  // An amount that's already a function is used verbatim, not double-wrapped.
  assert.equal(
    hydraFrameAt(idx, 3)!.code,
    'osc(10).add(noise(3), (props) => (props.mix)).blend(voronoi(), (({time}) => Math.sin(time))).out(o0)',
  )
})

test('layer with no amount omits it, leaning on the operator’s hydra default', () => {
  const idx = buildHydraIndex([
    { beat: 1, event: 'setCode', code: 'osc(10).out(o0)' },
    { beat: b(2), event: 'layer', code: 'noise(3).out(o0)' },
  ])
  assert.equal(hydraFrameAt(idx, 2)!.code, 'osc(10).blend(noise(3)).out(o0)')
})

test('meta events compose in beat order and fold across loop passes', () => {
  const idx = buildHydraIndex([
    { beat: 1, loop: 0, event: 'setCode', code: 'osc(10).out(o0)' },
    { beat: b(4), loop: 0, event: 'append', code: '.rotate(0.1)' },
    { beat: b(2), loop: 1, event: 'replace', find: '10', value: '20' },
  ])
  // Pass 1 folds pass 0 in full (append included), then applies its own replace.
  assert.equal(hydraFrameAt(idx, 0, 1)!.code, 'osc(10).rotate(0.1).out(o0)')
  assert.equal(hydraFrameAt(idx, 2, 1)!.code, 'osc(20).rotate(0.1).out(o0)')
})
