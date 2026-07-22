import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isPostRow,
  postRows,
  buildPostIndex,
  postFrameAt,
  postCodeUpToRow,
  postStateFrames,
  foldVars,
  type PostFrame,
} from '../src/post.js'
import { evalPostCode, chainSignature, collectLiveValues, sliderDeclsInCode, postVarDecls } from '../src/post-lang.js'
// Registers the Expr live-arg adapter post-lang consults (expr in post cells).
import '../src/expr-cell.js'
import { slider, progress, field, isBinding, evalExpr, type Binding } from '../src/dsl.js'
import { frameToBeat } from '../src/constants.js'
import type { Row } from '../src/lineage.js'

const b = (frame: number): number => frameToBeat(frame)
const frameAt = (rows: Row[], frame: number): PostFrame | null => postFrameAt(buildPostIndex(rows), frame)
const ops = (frame: PostFrame | null): string[] => (frame?.chain ?? []).map((o) => o.op)
const close = (a: unknown, x: number): void =>
  assert.ok(typeof a === 'number' && Math.abs(a - x) < 1e-9, `expected ~${x}, got ${a}`)
const vars = (rows: Row[], frame: number): Record<string, unknown> => foldVars(buildPostIndex(rows), frame)

test('isPostRow/postRows keep only post events', () => {
  const rows: Row[] = [
    { event: 'setCode', code: 'edges(0.2)' },
    { event: 'pulse', name: 'g', value: 1 },
    { event: 'setSource' }, // a hydra-only name — not a post event
    { code: 'x' },
  ]
  assert.equal(postRows(rows).length, 2)
  assert.equal(isPostRow(rows[0]), true)
  assert.equal(isPostRow(rows[2]), false)
})

test('the scene is implicit: a top-level op starts a chain, and set folds into vars', () => {
  const frame = frameAt([
    { beat: 1, event: 'setCode', code: 'edges((p) => p.th, 1)' },
    { beat: 1, event: 'setVariable', name: 'th', value: 0.3 },
  ], 0)!
  // `edges(0.2)` compiles to the same op list as `scene().edges(0.2)`.
  assert.deepEqual(ops(frame), ['scene', 'edges'])
  assert.equal(frame.stateId, frameAt([{ beat: 1, event: 'setCode', code: 'scene().edges((p) => p.th, 1)' }], 0)!.stateId)
  assert.deepEqual(frame.vars, { th: 0.3 })
})

test('an empty chain is passthrough (post inactive); a set-only table stays inactive', () => {
  assert.equal(frameAt([{ beat: 1, event: 'setCode', code: '' }], 0), null)
  assert.equal(frameAt([{ beat: 1, event: 'setVariable', name: 'x', value: 1 }], 0), null)
})

test('the latest chain wins and persists', () => {
  const rows: Row[] = [
    { beat: 1, event: 'setCode', code: 'blur(2)' },
    { beat: b(4), event: 'setCode', code: 'bloom(0.4)' },
  ]
  assert.deepEqual(ops(frameAt(rows, 3)), ['scene', 'blur'])
  assert.deepEqual(ops(frameAt(rows, 4)), ['scene', 'bloom'])
})

test('add appends effects (leading dot optional), including from passthrough', () => {
  assert.deepEqual(ops(frameAt([
    { beat: 1, event: 'setCode', code: 'blur(4)' },
    { beat: b(4), event: 'add', code: 'pixelate(6)' },
    { beat: b(6), event: 'add', code: '.invert()' },
  ], 6)), ['scene', 'blur', 'pixelate', 'invert'])
  // No prior chain — add starts one from the scene.
  assert.deepEqual(ops(frameAt([{ beat: 1, event: 'add', code: 'pixelate(6)' }], 0)), ['scene', 'pixelate'])
})

test('remove drops every op with the given name, even the first (next op goes top-level)', () => {
  assert.deepEqual(ops(frameAt([
    { beat: 1, event: 'setCode', code: 'blur(4).bloom(1).pixelate(6)' },
    { beat: b(4), event: 'remove', name: 'bloom' },
  ], 4)), ['scene', 'blur', 'pixelate'])
  assert.deepEqual(ops(frameAt([
    { beat: 1, event: 'setCode', code: 'blur(4).bloom(1)' },
    { beat: b(4), event: 'remove', name: 'blur' },
  ], 4)), ['scene', 'bloom'])
})

test('layer composites another chain via the chosen mode', () => {
  const chain = frameAt([
    { beat: 1, event: 'setCode', code: 'edges(0.2, 0)' },
    { beat: b(4), event: 'layer', mode: 'blend', value: 0.5, code: 'strobe(2)' },
  ], 4)!.chain
  assert.deepEqual(chain.map((o) => o.op), ['scene', 'edges', 'blend'])
  assert.deepEqual(chain[2].chainArgs![0].map((o) => o.op), ['scene', 'strobe'])
})

test('a transition wraps before→after during its window, then expires to the after program', () => {
  const rows: Row[] = [
    { beat: 1, event: 'setCode', code: 'blur(4)' },
    { beat: 5, event: 'transition', dur: 2 }, // frame 120, window [120,180)
    { beat: 5, event: 'setCode', code: 'edges(0.2, 0)' },
  ]
  const idx = buildPostIndex(rows)
  assert.deepEqual(ops(postFrameAt(idx, 120)), ['transition'], 'inside the window: the wipe')
  assert.deepEqual(ops(postFrameAt(idx, 180)), ['scene', 'edges'], 'at the end: the after program stands alone')
  assert.ok(postStateFrames(idx).includes(180), 'the window END is an enumerated state frame')
})

test('prev() is an explicit feedback head usable as a branch arg', () => {
  const chain = frameAt([{ beat: 1, event: 'setCode', code: 'blend(prev().mosaic(4), 0.4)' }], 0)!.chain
  assert.deepEqual(chain.map((o) => o.op), ['scene', 'blend'])
  assert.deepEqual(chain[1].chainArgs![0].map((o) => o.op), ['prev', 'mosaic'])
})

test('a structural arg change selects a different state; a live change does not', () => {
  const s1 = frameAt([{ beat: 1, event: 'setCode', code: 'edges(0.9, 1)' }], 0)!
  const live = frameAt([{ beat: 1, event: 'setCode', code: 'edges(0.1, 1)' }], 0)!
  const struct = frameAt([{ beat: 1, event: 'setCode', code: 'edges(0.1, 2)' }], 0)!
  assert.equal(s1.stateId, live.stateId)
  assert.notEqual(live.stateId, struct.stateId)
})

test('set with dur tweens from the previous value using the eased curve', () => {
  const rows: Row[] = [
    { beat: 1, event: 'setVariable', name: 'th', value: 0.2 },
    { beat: 5, event: 'setVariable', name: 'th', value: 0.5, dur: 2, ease: 'linear' }, // frame 120..180
  ]
  close(vars(rows, 60).th, 0.2)   // before the tween: the step value
  close(vars(rows, 150).th, 0.35) // midpoint (linear)
  close(vars(rows, 180).th, 0.5)  // settled at the target
})

test('pulse adds a decaying (default easeOut) contribution that stacks and expires', () => {
  const rows: Row[] = [
    { beat: 1, event: 'setVariable', name: 'g', value: 0.3 },
    { beat: 3, event: 'pulse', name: 'g', value: 1, dur: 1 }, // frame 60..90, default easeOut
    { beat: 3, event: 'pulse', name: 'g', value: 0.5, dur: 1 },
  ]
  close(vars(rows, 60).g, 1.8)   // onset: 0.3 + (1 + 0.5)·env(0)=1
  close(vars(rows, 75).g, 0.675) // midpoint easeOut env=0.25: 0.3 + 1.5·0.25
  close(vars(rows, 90).g, 0.3)   // expired: inert
})

// ── expression values in set/pulse rows ──────────────────────────────────────

const resolveAt = (v: unknown, sliderValue: number): unknown =>
  evalExpr((v as Binding).$expr, {}, 0, { slider: () => sliderValue })

test('a set with dur shaping itself with progress() sweeps 0→1 and rests at 1', () => {
  const rows: Row[] = [
    { beat: 1, event: 'setVariable', name: 'v', value: progress().toJSON(), dur: 2 }, // frames 0..60
  ]
  assert.equal(typeof vars(rows, 30).v, 'number', 'progress-only exprs bake to plain numbers')
  close(vars(rows, 0).v, 0)
  close(vars(rows, 30).v, 0.5)
  close(vars(rows, 60).v, 1)
  close(vars(rows, 300).v, 1)
})

test('a tween to an expression target emits a per-frame-resolving lerp composite', () => {
  const rows: Row[] = [
    { beat: 1, event: 'setVariable', name: 'v', value: 1 },
    { beat: 5, event: 'setVariable', name: 'v', value: slider('x').toJSON(), dur: 2, ease: 'linear' }, // frames 120..180
  ]
  assert.equal(typeof vars(rows, 60).v, 'number', 'numeric-only prefix stays on the arithmetic path')
  close(vars(rows, 60).v, 1)
  const mid = vars(rows, 150).v // u = 0.5
  assert.ok(isBinding(mid), 'the tween resolves per frame, not at fold')
  close(resolveAt(mid, 5), 3) // 1 + (5 - 1) · 0.5
  // settled: eased u = 1 leaves the target expression alone
  close(resolveAt(vars(rows, 180).v, 5), 5)
})

test('a pulse stacks over an expression base instead of being dropped', () => {
  const rows: Row[] = [
    { beat: 1, event: 'setVariable', name: 'g', value: slider('x').toJSON() },
    { beat: 3, event: 'pulse', name: 'g', value: 1, dur: 1 }, // frames 60..90
  ]
  close(resolveAt(vars(rows, 60).g, 2), 3) // base 2 + 1·env(0)
  close(resolveAt(vars(rows, 90).g, 2), 2) // expired pulse leaves the bare base
})

test('field() in a value cell reads its own row, not sibling vars', () => {
  const rows: Row[] = [
    { beat: 1, event: 'setVariable', name: 'beat', value: 99 }, // a sibling var named like a column
    { beat: 3, event: 'setVariable', name: 'v', value: field('beat').toJSON() },
  ]
  assert.equal(vars(rows, 60).v, 3, "the row's own beat column, substituted at fold time")
})

test('substitution never mutates the source nodes (cook memo safety)', () => {
  const value = progress().mul(2).toJSON()
  const snapshot = JSON.parse(JSON.stringify(value))
  const rows: Row[] = [{ beat: 1, event: 'setVariable', name: 'v', value, dur: 2 }]
  vars(rows, 15)
  vars(rows, 45)
  vars(rows, 90)
  assert.deepEqual(value, snapshot)
})

test('postCodeUpToRow shows the running chain after the given row', () => {
  const rows: Row[] = [
    { beat: 1, event: 'setCode', code: 'blur(3)' },
    { beat: b(4), event: 'add', code: 'pixelate(6)' },
  ]
  assert.equal(postCodeUpToRow(rows, 0), 'blur(3)')
  assert.equal(postCodeUpToRow(rows, 1), 'blur(3).pixelate(6)')
})

test('warm-compile audit: no frame of a loop introduces an unenumerated state', () => {
  const rows: Row[] = [
    { beat: 1, event: 'setCode', code: 'edges((p) => p.th, 1)' },
    { beat: 1, event: 'setVariable', name: 'th', value: 0.2 },
    { beat: 9, event: 'add', code: 'bloom((p) => p.glow)' },
    { beat: 11, event: 'remove', name: 'bloom' },
    { beat: 13, event: 'transition', dur: 2 },
    { beat: 13, event: 'setCode', code: 'blend(prev().mosaic(4), 0.5)' },
  ]
  const idx = buildPostIndex(rows)
  const enumerated = new Set<string>()
  for (const f of postStateFrames(idx)) { const fr = postFrameAt(idx, f); if (fr) enumerated.add(fr.stateId) }
  const maxF = Math.max(...postStateFrames(idx)) + 120
  for (let f = 0; f <= maxF; f++) {
    const fr = postFrameAt(idx, f)
    if (fr) assert.ok(enumerated.has(fr.stateId), `frame ${f} state "${fr.stateId}" was not precompiled`)
  }
})

test('op-list lowering: live-by-default, structural where the registry says, signature masks live', () => {
  const chain = evalPostCode('edges((p) => p.th, 1).blur(3)')
  assert.equal(chain[1].args[0].cls, 'live')       // threshold: a function
  assert.equal(typeof chain[1].args[0].value, 'function')
  assert.deepEqual(chain[1].args[1], { cls: 'structural', value: 1 }) // colorMode baked
  assert.equal(chainSignature(chain), chainSignature(evalPostCode('edges(0.9, 1).blur(0)')), 'live literals are masked')
  assert.deepEqual(collectLiveValues(chain, { th: 0.4 }), [0.4, 3]) // resolved in binding order
})

test('the hydra-style ops lower: geometry/colour fx are live, modulate carries its modulator chain', () => {
  const chain = evalPostCode('scale(1.2).rotate(0.3).scrollX(0.1).kaleid(4).hue(0.1).saturate(1.5).modulate(prev(), 0.2).fade(0.4)')
  assert.deepEqual(chain.map((o) => o.op),
    ['scene', 'scale', 'rotate', 'scrollX', 'kaleid', 'hue', 'saturate', 'modulate', 'fade'])
  assert.equal(chain[1].args[0].cls, 'live') // scale amount is a uniform, no recompile on change
  const modulate = chain.find((o) => o.op === 'modulate')!
  assert.equal(modulate.kind, 'combine')
  assert.equal(modulate.args[0].cls, 'live') // amount
  assert.deepEqual(modulate.chainArgs![0].map((o) => o.op), ['prev']) // the modulator feeds off prev()
})

test('a broken chain (unknown op, or a last-line comment) surfaces its error', () => {
  // The cook compiles every state, so these throws reach the user instead of
  // being swallowed. A trailing `//` comment is the classic case: the wrapping
  // `return (...)` can't close past it.
  assert.throws(() => evalPostCode('noSuchOp()'))
  assert.throws(() => frameAt([{ beat: 1, event: 'setCode', code: 'noSuchOp()' }], 0))
  assert.throws(() => frameAt([{ beat: 1, event: 'setCode', code: 'edges(0.2)\n// glow' }], 0))
})

test('slider() is a live arg reading props.sliders; sliderDeclsInCode scans a cell for declarations', () => {
  const chain = evalPostCode('blur(slider("r", 2, 8))')
  assert.deepEqual(collectLiveValues(chain, { sliders: { r: 4 } }), [4], 'reads the slider per frame')
  assert.deepEqual(collectLiveValues(chain, {}), [2], 'falls back to min before the slider exists')
  assert.deepEqual(collectLiveValues(evalPostCode('blur(slider("r"))'), {}), [0], 'no min → 0')
  assert.deepEqual(sliderDeclsInCode('.blur(slider("r", 2, 8))'), [{ id: 'r', min: 2, max: 8 }], 'leading-dot fragments scan too')
  assert.deepEqual(sliderDeclsInCode('broken('), [], 'a mid-edit cell declares nothing')
})

test('val("name", initial) is a live arg reading the folded variable, with the initial as fallback', () => {
  const chain = evalPostCode('blur(val("rad", 4))')
  assert.deepEqual(collectLiveValues(chain, { rad: 9 }), [9], 'reads the folded variable per frame')
  assert.deepEqual(collectLiveValues(chain, {}), [4], 'the initial is the fallback')
  const frame = frameAt([
    { beat: 1, event: 'setCode', code: 'blur(val("rad", 4))' },
    { beat: 1, event: 'setVariable', name: 'rad', value: 2 },
  ], 0)!
  assert.deepEqual(collectLiveValues(frame.chain, frame.vars), [2], 'a set row (the fold materializes one) drives it')
  assert.deepEqual(
    postVarDecls('bloom(val("glow", 0.5)).blur(val("rad"))'),
    [{ name: 'glow', value: 0.5 }, { name: 'rad', value: 0 }],
    'declarations scan textually; no value → 0',
  )
})

test('an Expr as a live arg resolves per frame and declares its slider', () => {
  const chain = evalPostCode('bloom(expr.slider("r", 2, 8).mul(2))')
  assert.equal(collectLiveValues(chain, { sliders: { r: 3 } })[0], 6)
  assert.ok(sliderDeclsInCode('bloom(expr.slider("r", 2, 8))').some((d) => d.id === 'r' && d.min === 2 && d.max === 8))
  const viaMidi = evalPostCode('blur(expr.midi("c4"))')
  assert.equal(collectLiveValues(viaMidi, { $midi: () => 0.5 })[0], 0.5)
})
