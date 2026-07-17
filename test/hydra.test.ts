import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isHydraRow,
  hydraRows,
  buildHydraIndex,
  hydraFrameAt,
  hydraCodeUpToRow,
  type HydraFrame,
} from '../src/hydra.js'
import { frameToBeat } from '../src/constants.js'
import type { Row } from '../src/lineage.js'

// The 1-indexed `beat` that lands a row on a given cache frame (30 frames/beat).
const b = (frame: number): number => frameToBeat(frame)

const frameAt = (rows: Row[] | null | undefined, frame: number): HydraFrame | null =>
  hydraFrameAt(buildHydraIndex(rows), frame)

test('a setCode event becomes the active sketch, a setVariable event puts a variable in scope', () => {
  const frame = frameAt([
    // The code omits `.out()` — the fold appends the `out` column's output (o0).
    { beat: 1, event: 'setCode', code: 'src(s0).modulate(noise(amount), 0.1)' },
    { beat: 1, event: 'setVariable', name: 'amount', value: 3 },
  ], 0)
  assert.ok(frame)
  assert.equal(frame!.code, 'src(s0).modulate(noise(amount), 0.1).out(o0)')
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
    { beat: 1, event: 'setCode', code: 'src(s0)' },
    { beat: b(4), event: 'setCode', code: 'osc(10)' },
  ]
  assert.equal(frameAt(rows, 0)!.code, 'src(s0).out(o0)')
  assert.equal(frameAt(rows, 3)!.code, 'src(s0).out(o0)')
  assert.equal(frameAt(rows, 4)!.code, 'osc(10).out(o0)')
  assert.equal(frameAt(rows, 99)!.code, 'osc(10).out(o0)')
})

test('variables take their latest value while the sketch stays put', () => {
  const rows: Row[] = [
    { beat: 1, event: 'setCode', code: 'osc(speed)' },
    { beat: 1, event: 'setVariable', name: 'speed', value: 1 },
    { beat: 1, event: 'setVariable', name: 'hue', value: 0 },
    { beat: b(3), event: 'setVariable', name: 'speed', value: 5 },
    { beat: b(6), event: 'setVariable', name: 'hue', value: 0.5 },
  ]
  assert.deepEqual(frameAt(rows, 0)!.vars, { speed: 1, hue: 0 })
  assert.deepEqual(frameAt(rows, 3)!.vars, { speed: 5, hue: 0 })
  assert.deepEqual(frameAt(rows, 6)!.vars, { speed: 5, hue: 0.5 })
  assert.equal(frameAt(rows, 6)!.code, 'osc(speed).out(o0)')
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

test('the beat axis is absolute: a beat past the loop folds once the extended frame reaches it', () => {
  // Playback samples a later pass at pass * loopFrames + frame — an event
  // beyond the loop's span (here frame 100) is simply further along the grid.
  const index = buildHydraIndex([
    { beat: 1, event: 'setCode', code: 'a' },
    { beat: 1, event: 'setVariable', name: 'amount', value: 1 },
    { beat: b(110), event: 'setCode', code: 'b' },
  ])
  assert.equal(hydraFrameAt(index, 0)!.code, 'a.out(o0)', 'pass 0')
  assert.equal(hydraFrameAt(index, 100)!.code, 'a.out(o0)', 'early in pass 1 the change has not hit yet')
  assert.equal(hydraFrameAt(index, 110)!.code, 'b.out(o0)', 'pass 1 reaches its setCode')
  assert.equal(hydraFrameAt(index, 200)!.code, 'b.out(o0)', 'a later pass folds pass 1 in full')
  assert.deepEqual(hydraFrameAt(index, 200)!.vars, { amount: 1 }, 'variables persist across passes')
})

test('buildHydraIndex orders rows by frame', () => {
  const index = buildHydraIndex([
    { beat: b(20), event: 'setCode', code: 'later' },
    { beat: b(5), event: 'setCode', code: 'first' },
  ])
  assert.deepEqual(index.map((r) => r.code), ['first', 'later'])
})

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

test('replace swaps every occurrence of the literal string in the current code', () => {
  const rows: Row[] = [
    { beat: 1, event: 'setCode', code: 'osc(10).modulate(osc(10)).out(o0)' },
    { beat: b(4), event: 'replace', find: 'osc', value: 'noise' },
  ]
  const idx = buildHydraIndex(rows)
  assert.equal(hydraFrameAt(idx, 0)!.code, 'osc(10).modulate(osc(10)).out(o0)')
  assert.equal(hydraFrameAt(idx, 4)!.code, 'noise(10).modulate(noise(10)).out(o0)')
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

test('meta events compose in beat order and fold across loop passes', () => {
  const idx = buildHydraIndex([
    { beat: 1, event: 'setCode', code: 'osc(10).out(o0)' },
    { beat: b(4), event: 'append', code: '.rotate(0.1)' },
    { beat: b(102), event: 'replace', find: '10', value: '20' }, // beyond a 100-frame loop → a later pass
  ])
  // Sampling into the next pass folds the earlier one in full (append included).
  assert.equal(hydraFrameAt(idx, 100)!.code, 'osc(10).rotate(0.1).out(o0)')
  assert.equal(hydraFrameAt(idx, 102)!.code, 'osc(20).rotate(0.1).out(o0)')
})

test('events fold per output; the sketch concatenates every output in name order', () => {
  const idx = buildHydraIndex([
    { beat: 1, out: 'o1', event: 'setCode', code: 'osc(10).out(o1)' },
    { beat: 1, out: 'o0', event: 'setCode', code: 'src(o1).out(o0)' },
  ])
  assert.equal(hydraFrameAt(idx, 0)!.code, 'src(o1).out(o0)\nosc(10).out(o1)')
})

test('append / layer target the row’s own output', () => {
  const idx = buildHydraIndex([
    { beat: 1, out: 'o1', event: 'setCode', code: 'osc(10).out(o1)' },
    { beat: b(2), out: 'o1', event: 'append', code: '.rotate(0.1)' },
    { beat: b(3), out: 'o1', event: 'layer', code: 'noise(3).out(o1)', mode: 'add' },
  ])
  assert.equal(hydraFrameAt(idx, 2)!.code, 'osc(10).rotate(0.1).out(o1)')
  assert.equal(hydraFrameAt(idx, 3)!.code, 'osc(10).rotate(0.1).add(noise(3)).out(o1)')
})

test('the `out` column supplies the terminal .out(oN); code needn’t write it', () => {
  assert.equal(frameAt([{ beat: 1, event: 'setCode', code: 'osc(10)' }], 0)!.code, 'osc(10).out(o0)')
  assert.equal(
    frameAt([{ beat: 1, out: 'o2', event: 'setCode', code: 'osc(10)' }], 0)!.code,
    'osc(10).out(o2)',
  )
  // An explicit .out(...) in the code is normalised to the column's output.
  assert.equal(
    frameAt([{ beat: 1, out: 'o1', event: 'setCode', code: 'osc(10).out(o0)' }], 0)!.code,
    'osc(10).out(o1)',
  )
})

// A transition's window is in props.time seconds (FPS=60, 30 frames/beat):
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
    // Same beat: the transition snapshots the "before"; the setCode folds on as the "after".
    { beat: 5, event: 'transition', code: 'voronoi(5).out(o0)', value: 4 },
    { beat: 5, event: 'setCode', code: 'osc(10).out(o0)' },
  ])
  assert.equal(hydraFrameAt(idx, 0)!.code, 'src(s0).out(o0)')
  const at = hydraFrameAt(idx, 120)! // beat 5 = frame 120
  assert.equal(
    at.code,
    `src(s0).layer((osc(10)).mask(${maskExpr('voronoi(5)', 120, 120)})).out(o0)`,
  )
  // Byte-stable through the window — the wipe rides props.time, so no recompile.
  assert.deepEqual(at.vars, {})
  assert.equal(hydraFrameAt(idx, 180)!.code, at.code)
  assert.equal(hydraFrameAt(idx, 239)!.code, at.code)
  // Window elapses at frame 120 + 120 = 240: only the after program remains.
  assert.equal(hydraFrameAt(idx, 240)!.code, 'osc(10).out(o0)')
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

test('a wipe wraps cleanly at the loop boundary (loop 0) and re-runs each pass', () => {
  // hydraFrameAt is a pure function of the within-loop frame, and playback
  // samples it at the wrapped frame each pass — so every loop replays the wipe.
  const idx = buildHydraIndex([
    { beat: 1, event: 'setCode', code: 'osc(20).out(o0)' },
    { beat: 14, event: 'transition', code: 'gradient(1).out(o0)', value: 2 }, // frames 390–450
    { beat: 14, event: 'setCode', code: 'noise(3).out(o0)' },
  ])
  const start = 'osc(20).out(o0)'
  // Frame 0: no residue of the after program from the pass just ended.
  assert.equal(hydraFrameAt(idx, 0)!.code, start)
  const mid = hydraFrameAt(idx, 420)!.code // mid-wipe
  assert.equal(
    mid,
    `osc(20).layer((noise(3)).mask(${maskExpr('gradient(1)', 390, 60)})).out(o0)`,
  )
  // Frame 450+: window elapsed, just the after program until the wrap.
  assert.equal(hydraFrameAt(idx, 450)!.code, 'noise(3).out(o0)')
  assert.equal(hydraFrameAt(idx, 479)!.code, 'noise(3).out(o0)')
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
  // At frame 240 both windows are live (120–360 and 240–300), so they nest.
  const inner = `src(s0).layer((gradient()).mask(${maskExpr('voronoi(4)', 240, 60)}))`
  assert.equal(
    hydraFrameAt(idx, 240)!.code,
    `osc(10).layer((${inner}).mask(${maskExpr('noise(3)', 120, 240)})).out(o0)`,
  )
  // The inner wipe ends at frame 300; only the outer remains.
  assert.equal(
    hydraFrameAt(idx, 300)!.code,
    `osc(10).layer((gradient()).mask(${maskExpr('noise(3)', 120, 240)})).out(o0)`,
  )
})

test('hydraCodeUpToRow folds up to and including the given row (in raw table order)', () => {
  const rows: Row[] = [
    { beat: 1, event: 'setCode', code: 'osc(20).out(o0)' },
    { beat: 5, event: 'replace', find: '20', value: 45 },
    { beat: 7, event: 'append', code: '.kaleid(5)' },
    { beat: 9, event: 'setSource', code: 'noise(2.5)' },
  ]
  assert.equal(hydraCodeUpToRow(rows, 0), 'osc(20).out(o0)')
  assert.equal(hydraCodeUpToRow(rows, 1), 'osc(45).out(o0)')
  assert.equal(hydraCodeUpToRow(rows, 2), 'osc(45).kaleid(5).out(o0)')
  assert.equal(hydraCodeUpToRow(rows, 3), 'noise(2.5).kaleid(5).out(o0)')
})
