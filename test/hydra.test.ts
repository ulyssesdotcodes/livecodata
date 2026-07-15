import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isHydraRow,
  hydraRows,
  buildHydraIndex,
  hydraFrameAt,
  hydraCodeUpToRow,
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

// --- the `output` column: per-output folding --------------------------------

test('isHydraRow recognises the transition event', () => {
  assert.equal(isHydraRow({ beat: 1, event: 'transition', code: 'noise(3).out(o0)', value: 4 }), true)
  assert.equal(hydraRows([
    { beat: 1, event: 'setCode', code: 'osc(1).out(o0)' },
    { beat: 1, event: 'transition', code: 'noise(3).out(o0)', value: 2 },
  ]).length, 2)
})

test('events fold per output; the sketch concatenates every output in name order', () => {
  // o1 renders an oscillator; o0 reads it back as src(o1). Each output folds on
  // its own, and the sampled code is both programs, one per line, o0 then o1.
  const idx = buildHydraIndex([
    { beat: 1, output: 'o1', event: 'setCode', code: 'osc(10).out(o1)' },
    { beat: 1, output: 'o0', event: 'setCode', code: 'src(o1).out(o0)' },
  ])
  assert.equal(hydraFrameAt(idx, 0)!.code, 'src(o1).out(o0)\nosc(10).out(o1)')
})

test('append / layer target the row’s own output', () => {
  const idx = buildHydraIndex([
    { beat: 1, output: 'o1', event: 'setCode', code: 'osc(10).out(o1)' },
    { beat: b(2), output: 'o1', event: 'append', code: '.rotate(0.1)' },
    { beat: b(3), output: 'o1', event: 'layer', code: 'noise(3).out(o1)', mode: 'add' },
  ])
  assert.equal(hydraFrameAt(idx, 2)!.code, 'osc(10).rotate(0.1).out(o1)')
  assert.equal(hydraFrameAt(idx, 3)!.code, 'osc(10).rotate(0.1).add(noise(3)).out(o1)')
})

test('a missing / blank output cell defaults to o0 (single-output tables unchanged)', () => {
  const idx = buildHydraIndex([
    { beat: 1, output: '', event: 'setCode', code: 'osc(10).out(o0)' },
    { beat: b(2), event: 'append', code: '.kaleid(4)' },
  ])
  assert.equal(hydraFrameAt(idx, 2)!.code, 'osc(10).kaleid(4).out(o0)')
})

// --- the transition event: a mask wipe from the before to the after program --

// The reveal fragment a masked transition builds for a given mask chain and
// The window a transition exposes to its mask sketch, in props.time units
// (seconds: FPS=60, 30 frames/beat → 0.5 s/beat, so start = startFrame / 60):
// transitionPos(t) normalises a time to 0→1 across [start, start+dur], clamped.
const posFn = (startFrame: number, durFrames: number): string =>
  `(t) => Math.min(Math.max((t - ${startFrame / 60}) / ${durFrames / 60}, 0), 1)`
// A masked transition wraps the user's mask sketch, binding transitionStart /
// transitionEnd / transitionPos around it so the mask can drive itself.
const maskExpr = (mask: string, startFrame: number, durFrames: number): string =>
  `((transitionStart, transitionEnd, transitionPos) => (${mask}))`
  + `(${startFrame / 60}, ${(startFrame + durFrames) / 60}, ${posFn(startFrame, durFrames)})`

test('code/transition/code wipes from the before program to the after through the mask', () => {
  const idx = buildHydraIndex([
    { beat: 1, event: 'setCode', code: 'src(s0).out(o0)' },
    // At the same beat: the transition (snapshots src(s0) as "before"), then the
    // destination program that folds on as the live "after".
    { beat: 5, event: 'transition', code: 'voronoi(5).out(o0)', value: 4 },
    { beat: 5, event: 'setCode', code: 'osc(10).out(o0)' },
  ])
  // Before the transition beat, just the before program.
  assert.equal(hydraFrameAt(idx, 0)!.code, 'src(s0).out(o0)')
  // At/after the transition beat: before.layer(after.mask(<user mask, wrapped
  // with transitionStart/End/Pos>)), the window baked in props.time units over
  // the 4-beat span (start frame 120, 120-frame window) rather than injected.
  const at = hydraFrameAt(idx, 120)! // beat 5 = frame 120
  assert.equal(
    at.code,
    `src(s0).layer((osc(10)).mask(${maskExpr('voronoi(5)', 120, 120)})).out(o0)`,
  )
  // No per-frame data is injected — the wipe rides the playback clock — so the
  // string is byte-stable across the whole 120-frame window (start 120), which
  // is what lets it animate without a recompile.
  assert.deepEqual(at.vars, {})
  assert.equal(hydraFrameAt(idx, 180)!.code, at.code)
  assert.equal(hydraFrameAt(idx, 239)!.code, at.code)
  // Once the window elapses (frame 120 + 120 = 240) the wipe is done and
  // collapses to just the after program — the before and mask are gone.
  assert.equal(hydraFrameAt(idx, 240)!.code, 'osc(10).out(o0)')
})

test('code/transition/layer reveals the layer through the mask', () => {
  const idx = buildHydraIndex([
    { beat: 1, event: 'setCode', code: 'osc(10).out(o0)' },
    { beat: 5, event: 'transition', code: 'noise(3).out(o0)', value: 2 },
    { beat: 5, event: 'layer', code: 'voronoi(5).out(o0)', mode: 'add', value: 0.5 },
  ])
  assert.equal(
    hydraFrameAt(idx, 120)!.code,
    `osc(10).layer((osc(10).add(voronoi(5), 0.5)).mask(${maskExpr('noise(3)', 120, 60)})).out(o0)`,
  )
})

test('layer/transition/code wipes from the layered program to a new one', () => {
  const idx = buildHydraIndex([
    { beat: 1, event: 'setCode', code: 'osc(10).out(o0)' },
    { beat: b(60), event: 'layer', code: 'voronoi(5).out(o0)', mode: 'add', value: 0.5 }, // frame 60
    { beat: 5, event: 'transition', code: 'noise(3).out(o0)', value: 2 },
    { beat: 5, event: 'setCode', code: 'src(s0).out(o0)' },
  ])
  assert.equal(
    hydraFrameAt(idx, 120)!.code,
    `osc(10).add(voronoi(5), 0.5).layer((src(s0)).mask(${maskExpr('noise(3)', 120, 60)})).out(o0)`,
  )
})

test('a transition with no mask code falls back to a plain crossfade', () => {
  const idx = buildHydraIndex([
    { beat: 1, event: 'setCode', code: 'osc(10).out(o0)' },
    { beat: 5, event: 'transition', value: 2 },
    { beat: 5, event: 'setCode', code: 'noise(3).out(o0)' },
  ])
  assert.equal(
    hydraFrameAt(idx, 120)!.code,
    `osc(10).blend((noise(3)), (props) => (${posFn(120, 60)})(props.time)).out(o0)`,
  )
})

test('the wipe code is byte-stable through its window, then collapses to the after', () => {
  const idx = buildHydraIndex([
    { beat: 1, event: 'setCode', code: 'osc(10).out(o0)' },
    { beat: 5, event: 'transition', code: 'noise(3).out(o0)', value: 2 }, // frames 120–180
    { beat: 5, event: 'setCode', code: 'src(s0).out(o0)' },
  ])
  const at = hydraFrameAt(idx, 120)!
  // Every frame inside the window yields the identical string — only the clock
  // hydra reads (props.time) moves, so setSketch never recompiles mid-wipe.
  for (const f of [150, 179]) assert.equal(hydraFrameAt(idx, f)!.code, at.code)
  assert.deepEqual(at.vars, {})
  // At and past the window's end (frame 120 + 60 = 180) the wipe is finished and
  // the code is just the after program — nothing of the before/mask lingers.
  assert.equal(hydraFrameAt(idx, 180)!.code, 'src(s0).out(o0)')
  assert.equal(hydraFrameAt(idx, 300)!.code, 'src(s0).out(o0)')
})

test('a transition before any setCode is a no-op', () => {
  const idx = buildHydraIndex([
    { beat: 1, event: 'transition', code: 'noise(3).out(o0)', value: 2 },
    { beat: b(2), event: 'setCode', code: 'osc(10).out(o0)' },
  ])
  assert.equal(hydraFrameAt(idx, 0), null)
  assert.equal(hydraFrameAt(idx, 2)!.code, 'osc(10).out(o0)')
})

test('a wipe wraps cleanly at the loop boundary (loop 0) and re-runs each pass', () => {
  // A single-loop program (no `loop` column → pass 0): a program at the start,
  // and a wipe to a new one late in the loop. hydraFrameAt is a pure function of
  // the within-loop frame — and playback samples it at the *wrapped* source
  // frame each pass (playback.ts: srcFrameF = (srcBeat - 1) * FRAMES_PER_BEAT,
  // pos %= maxBeats) — so the frames below are exactly what each loop replays.
  const idx = buildHydraIndex([
    { beat: 1, event: 'setCode', code: 'osc(20).out(o0)' },
    { beat: 14, event: 'transition', code: 'gradient(1).out(o0)', value: 2 }, // frames 390–450
    { beat: 14, event: 'setCode', code: 'noise(3).out(o0)' },
  ])
  const start = 'osc(20).out(o0)'
  // Top of the loop (frame 0): only the start program — the transition, later in
  // the loop, isn't reached yet. So every wrap back to frame 0 lands cleanly on
  // the start, with no residue of the after program from the pass just ended.
  assert.equal(hydraFrameAt(idx, 0)!.code, start)
  // Mid-wipe (frame 420): before wiped to after through the mask.
  const mid = hydraFrameAt(idx, 420)!.code
  assert.equal(
    mid,
    `osc(20).layer((noise(3)).mask(${maskExpr('gradient(1)', 390, 60)})).out(o0)`,
  )
  // End of the loop (frame 450+, window elapsed): just the after program — this
  // is the "code at the end of the loop" that shows until the wrap.
  assert.equal(hydraFrameAt(idx, 450)!.code, 'noise(3).out(o0)')
  assert.equal(hydraFrameAt(idx, 479)!.code, 'noise(3).out(o0)')
  // Because sampling is a pure function of the within-loop frame, the next pass
  // replays all of it identically — the wipe re-runs every loop, not just once.
  assert.equal(hydraFrameAt(idx, 0)!.code, start)
  assert.equal(hydraFrameAt(idx, 420)!.code, mid)
})

test('overlapping transitions compose in beat order, the earliest wrapping the later', () => {
  const idx = buildHydraIndex([
    { beat: 1, event: 'setCode', code: 'osc(10).out(o0)' },
    // A long (8-beat, frames 120–360) wipe still running when a short one starts.
    { beat: 5, event: 'transition', code: 'noise(3).out(o0)', value: 8 },
    { beat: 5, event: 'setCode', code: 'src(s0).out(o0)' },
    { beat: 9, event: 'transition', code: 'voronoi(4).out(o0)', value: 2 },
    { beat: 9, event: 'setCode', code: 'gradient().out(o0)' },
  ])
  // At beat 9 (frame 240) both windows are live (beat 5 → frames 120–360, beat 9
  // → frames 240–300), so they nest — each on its own baked window, nothing
  // shared. The earliest wraps the later.
  const inner = `src(s0).layer((gradient()).mask(${maskExpr('voronoi(4)', 240, 60)}))`
  assert.equal(
    hydraFrameAt(idx, 240)!.code,
    `osc(10).layer((${inner}).mask(${maskExpr('noise(3)', 120, 240)})).out(o0)`,
  )
  // Once the inner (voronoi) wipe finishes at frame 300, it collapses away and
  // only the outer (noise) wipe — from osc to the now-settled gradient — remains.
  assert.equal(
    hydraFrameAt(idx, 300)!.code,
    `osc(10).layer((gradient()).mask(${maskExpr('noise(3)', 120, 240)})).out(o0)`,
  )
})

test('transitions on different outputs fold apart, each on its own baked window', () => {
  const idx = buildHydraIndex([
    { beat: 1, output: 'o0', event: 'setCode', code: 'src(s0).out(o0)' },
    { beat: 5, output: 'o0', event: 'transition', code: 'noise(3).out(o0)', value: 2 },
    { beat: 5, output: 'o0', event: 'setCode', code: 'osc(10).out(o0)' },
    { beat: 1, output: 'o1', event: 'setCode', code: 'gradient().out(o1)' },
    { beat: 5, output: 'o1', event: 'transition', code: 'voronoi(4).out(o1)', value: 2 },
    { beat: 5, output: 'o1', event: 'setCode', code: 'osc(20).out(o1)' },
  ])
  const frame = hydraFrameAt(idx, 120)!
  // Both wipes read props.time directly, so o0 and o1 stay wholly independent —
  // no shared counter, no cross-output renumbering, nothing to recompile when
  // one output's transition starts.
  assert.equal(
    frame.code,
    `src(s0).layer((osc(10)).mask(${maskExpr('noise(3)', 120, 60)})).out(o0)\n`
    + `gradient().layer((osc(20)).mask(${maskExpr('voronoi(4)', 120, 60)})).out(o1)`,
  )
  assert.deepEqual(frame.vars, {})
})

// --- hydraCodeUpToRow: the compiled code as of one table row ------------------

test('hydraCodeUpToRow folds up to and including the given row (in raw table order)', () => {
  const rows: Row[] = [
    { beat: 1, event: 'setCode', code: 'osc(20).out(o0)' },
    { beat: 5, event: 'replace', find: '20', value: 45 },
    { beat: 7, event: 'append', code: '.kaleid(5)' },
    { beat: 9, event: 'setSource', code: 'noise(2.5)' },
  ]
  // Each row shows the running program right after it applies.
  assert.equal(hydraCodeUpToRow(rows, 0), 'osc(20).out(o0)')
  assert.equal(hydraCodeUpToRow(rows, 1), 'osc(45).out(o0)')
  assert.equal(hydraCodeUpToRow(rows, 2), 'osc(45).kaleid(5).out(o0)')
  assert.equal(hydraCodeUpToRow(rows, 3), 'noise(2.5).kaleid(5).out(o0)')
})

test('hydraCodeUpToRow stops at the row even when several share a beat', () => {
  const rows: Row[] = [
    { beat: 1, event: 'setCode', code: 'src(s0).out(o0)' },
    { beat: 5, event: 'transition', code: 'voronoi(5).out(o0)', value: 4 },
    { beat: 5, event: 'setCode', code: 'osc(10).out(o0)' },
  ]
  // At the transition row, the destination (the beat-5 setCode) hasn't folded
  // yet, so before === after: the wipe is from src(s0) to itself.
  assert.equal(
    hydraCodeUpToRow(rows, 1),
    `src(s0).layer((src(s0)).mask(${maskExpr('voronoi(5)', 120, 120)})).out(o0)`,
  )
  // At the following setCode row, the destination is in place.
  assert.equal(
    hydraCodeUpToRow(rows, 2),
    `src(s0).layer((osc(10)).mask(${maskExpr('voronoi(5)', 120, 120)})).out(o0)`,
  )
})

test('hydraCodeUpToRow returns null for a non-hydra row or before any setCode', () => {
  assert.equal(hydraCodeUpToRow([{ beat: 1, foo: 'bar' }], 0), null, 'not a hydra row')
  assert.equal(hydraCodeUpToRow([
    { beat: 1, event: 'append', code: '.rotate(0.1)' }, // no setCode yet
    { beat: 5, event: 'setCode', code: 'osc(1).out(o0)' },
  ], 0), null, 'nothing compiled yet at that row')
  assert.equal(hydraCodeUpToRow([], 0), null)
  assert.equal(hydraCodeUpToRow(null, 0), null)
})
