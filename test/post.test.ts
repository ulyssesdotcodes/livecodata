import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  isPostRow,
  postRows,
  buildPostIndex,
  postFrameAt,
  postCodeUpToRow,
  foldVars,
  type PostFrame,
} from '../src/post.js'
import { evalPostCode, chainSignature, collectLiveValues } from '../src/post-lang.js'
import { frameToBeat } from '../src/constants.js'
import type { Row } from '../src/lineage.js'

// The 1-indexed `beat` that lands a row on a given cache frame.
const b = (frame: number): number => frameToBeat(frame)
const frameAt = (rows: Row[], frame: number): PostFrame | null => postFrameAt(buildPostIndex(rows), frame)

test('isPostRow/postRows keep only post events', () => {
  const rows: Row[] = [
    { event: 'setCode', code: 'scene()' },
    { event: 'impulse', name: 'g', value: 1 },
    { event: 'notAnEvent' },
    { code: 'x' },
  ]
  assert.equal(postRows(rows).length, 2)
  assert.equal(isPostRow(rows[0]), true)
  assert.equal(isPostRow(rows[2]), false)
})

test('a setCode establishes the chain; setVariable folds into vars', () => {
  const frame = frameAt([
    { beat: 1, event: 'setCode', code: 'scene().edges((p) => p.th, 1)' },
    { beat: 1, event: 'setVariable', name: 'th', value: 0.3 },
  ], 0)
  assert.ok(frame)
  assert.deepEqual(frame!.chains.map((c) => c.out), ['main'])
  assert.equal(frame!.chains[0].chain.map((o) => o.op).join('.'), 'scene.edges')
  assert.deepEqual(frame!.vars, { th: 0.3 })
})

test('no active program before the first setCode', () => {
  const rows: Row[] = [
    { beat: b(2), event: 'setCode', code: 'scene().blur(4)' },
    { beat: b(2), event: 'setVariable', name: 'r', value: 4 },
  ]
  assert.equal(frameAt(rows, 0), null)
  assert.equal(frameAt(rows, 1), null)
  assert.ok(frameAt(rows, 2))
})

test('the latest setCode wins and persists', () => {
  const rows: Row[] = [
    { beat: 1, event: 'setCode', code: 'scene().blur(2)' },
    { beat: b(4), event: 'setCode', code: 'scene().bloom(0.4)' },
  ]
  assert.equal(frameAt(rows, 0)!.chains[0].chain.map((o) => o.op).join('.'), 'scene.blur')
  assert.equal(frameAt(rows, 3)!.chains[0].chain.map((o) => o.op).join('.'), 'scene.blur')
  assert.equal(frameAt(rows, 4)!.chains[0].chain.map((o) => o.op).join('.'), 'scene.bloom')
})

test('replace rebinds a live literal on the SAME state (structure unchanged)', () => {
  const rows: Row[] = [
    { beat: 1, event: 'setCode', out: 'main', code: 'scene().edges(0.2, 1)' },
    { beat: b(4), event: 'replace', out: 'main', find: '0.2', value: 0.5 },
  ]
  const before = frameAt(rows, 0)!
  const after = frameAt(rows, 4)!
  assert.equal(before.stateId, after.stateId, 'a live-literal swap keeps the same precompiled state')
  assert.equal(before.chains[0].chain[1].args[0].value, 0.2)
  assert.equal(after.chains[0].chain[1].args[0].value, 0.5)
})

test('a structural arg change selects a different state; a live change does not', () => {
  const same = frameAt([{ beat: 1, event: 'setCode', code: 'scene().edges(0.9, 1)' }], 0)!
  const liveOnly = frameAt([{ beat: 1, event: 'setCode', code: 'scene().edges(0.1, 1)' }], 0)!
  const structural = frameAt([{ beat: 1, event: 'setCode', code: 'scene().edges(0.1, 2)' }], 0)!
  assert.equal(same.stateId, liveOnly.stateId)
  assert.notEqual(liveOnly.stateId, structural.stateId)
})

test('each out folds independently; the state id spans all outs in name order', () => {
  const frame = frameAt([
    { beat: 1, event: 'setCode', out: 'main', code: 'scene().blur(4)' },
    { beat: 1, event: 'setCode', out: 'b1', code: 'scene().edges(0.2, 0)' },
  ], 0)!
  assert.deepEqual(frame.chains.map((c) => c.out), ['b1', 'main'])
  assert.equal(frame.stateId, 'b1:scene().edges(#,0)|main:scene().blur(#)')
})

test('postCodeUpToRow shows the running chain after the given row', () => {
  const rows: Row[] = [
    { beat: 1, event: 'setCode', out: 'main', code: 'scene().blur(3)' },
    { beat: b(4), event: 'replace', out: 'main', find: '3', value: 6 },
  ]
  assert.equal(postCodeUpToRow(rows, 0), 'scene().blur(3)')
  assert.equal(postCodeUpToRow(rows, 1), 'scene().blur(6)')
  assert.equal(postCodeUpToRow([{ beat: 1, event: 'setVariable', name: 'x', value: 1 }], 0), null)
})

// ── chain eval (op-list) contracts ──────────────────────────────────────────

test('evalPostCode classifies args live-by-default, structural where the registry says so', () => {
  const chain = evalPostCode('scene().edges((p) => p.th, 1).bloom(0.3)')
  assert.deepEqual(chain.map((o) => o.op), ['scene', 'edges', 'bloom'])
  // edges: threshold live (a function), colorMode structural (baked 1)
  assert.equal(chain[1].args[0].cls, 'live')
  assert.equal(typeof chain[1].args[0].value, 'function')
  assert.deepEqual(chain[1].args[1], { cls: 'structural', value: 1 })
  // bloom: omitted radius/threshold fall back to registry defaults, all live
  assert.equal(chain[2].args[0].value, 0.3)
  assert.equal(chain[2].args[1].value, 0.5)
  assert.equal(chain[2].args.every((a) => a.cls === 'live'), true)
})

test('chainSignature masks live args and inlines structural ones', () => {
  assert.equal(chainSignature(evalPostCode('scene().edges(0.2, 1)')), 'scene().edges(#,1)')
  assert.equal(chainSignature(evalPostCode('scene().edges(0.5, 1)')), 'scene().edges(#,1)')
  assert.equal(chainSignature(evalPostCode('scene().edges(0.2, 2)')), 'scene().edges(#,2)')
})

test('collectLiveValues resolves functions against props in binding order', () => {
  const chain = evalPostCode('scene().edges((p) => p.th, 1).blur(3)')
  assert.deepEqual(collectLiveValues(chain, { th: 0.4 }), [0.4, 3])
})

test('an unknown op throws (caught by the fold, dropping that output)', () => {
  assert.throws(() => evalPostCode('scene().noSuchOp()'))
  // The fold swallows it rather than crashing the frame.
  assert.equal(frameAt([{ beat: 1, event: 'setCode', code: 'scene().noSuchOp()' }], 0), null)
})

// ── variable dynamics: tweens + impulses ────────────────────────────────────

const close = (a: unknown, b: number, msg?: string): void =>
  assert.ok(typeof a === 'number' && Math.abs(a - b) < 1e-9, `${msg ?? ''} expected ~${b}, got ${a}`)
const vars = (rows: Row[], frame: number): Record<string, unknown> => foldVars(buildPostIndex(rows), frame)

test('setVariable with dur tweens from the previous value using the eased curve', () => {
  const rows: Row[] = [
    { beat: 1, event: 'setVariable', name: 'th', value: 0.2 },
    { beat: 5, event: 'setVariable', name: 'th', value: 0.5, dur: 2, ease: 'linear' }, // frame 120..180
  ]
  close(vars(rows, 60).th, 0.2, 'before the tween: the step value')
  close(vars(rows, 120).th, 0.2, 'at the tween start: the previous value')
  close(vars(rows, 150).th, 0.35, 'midpoint (linear)')
  close(vars(rows, 180).th, 0.5, 'at the end: the target')
  close(vars(rows, 300).th, 0.5, 'past the end: settled at the target')
})

test('impulse adds an ease-shaped, decaying contribution while active; expired rows are inert', () => {
  const rows: Row[] = [
    { beat: 1, event: 'setVariable', name: 'g', value: 0.3 },
    { beat: 3, event: 'impulse', name: 'g', value: 1, dur: 1, ease: 'linear' }, // frame 60..90
  ]
  close(vars(rows, 30).g, 0.3, 'before the impulse')
  close(vars(rows, 60).g, 1.3, 'at onset: full add')
  close(vars(rows, 75).g, 0.8, 'midpoint decay (linear env = 0.5)')
  close(vars(rows, 90).g, 0.3, 'expired: inert')
})

test('impulses stack additively and default to an easeOut envelope', () => {
  const stacked: Row[] = [
    { beat: 1, event: 'setVariable', name: 'g', value: 0 },
    { beat: 3, event: 'impulse', name: 'g', value: 1, dur: 2, ease: 'linear' },
    { beat: 3, event: 'impulse', name: 'g', value: 0.5, dur: 2, ease: 'linear' },
  ]
  close(vars(stacked, 60).g, 1.5, 'two onsets add')
  // No ease → easeOut decay: env = 1 - (1-(1-u)^2); at u=0.5 that is 0.25.
  const decay: Row[] = [{ beat: 1, event: 'impulse', name: 'g', value: 1, dur: 1 }] // frame 0..30
  close(vars(decay, 15).g, 0.25, 'default easeOut envelope at the midpoint')
})
