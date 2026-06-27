import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  EFFECT_TYPES,
  isEffectEvent,
  effectEvents,
  buildEffectIndex,
  effectChainAtFrame,
  type EffectEntry,
} from '../src/effects.js'
import type { Row } from '../src/lineage.js'

const f = (frames: number): number => frames / 60

const chainAt = (rows: Row[] | null | undefined, frame: number): EffectEntry[] =>
  effectChainAtFrame(buildEffectIndex(rows), frame)

test('isEffectEvent / effectEvents split effect rows from object rows', () => {
  const rows: Row[] = [
    { id: 'ball', type: 'create', shape: 'sphere' },
    { id: 'b', type: 'addEffect', effect: 'bloom', index: 0 },
    { id: 'ball', type: 'update', px: 1 },
    { id: 'b', type: 'updateEffect', index: f(1), params: { strength: 2 } },
    { id: 'b', type: 'removeEffect', index: f(2) },
  ]
  assert.equal(isEffectEvent(rows[0]), false)
  assert.equal(isEffectEvent(rows[1]), true)
  assert.deepEqual(effectEvents(rows).map((r) => r.type),
    ['addEffect', 'updateEffect', 'removeEffect'])
  assert.deepEqual(effectEvents(null), [])
})

test('addEffect activates an effect with type defaults merged under its params', () => {
  const chain = chainAt([
    { id: 'b', type: 'addEffect', effect: 'bloom', index: 0, params: { strength: 1.5 } },
  ], 0)
  assert.equal(chain.length, 1)
  assert.equal(chain[0].id, 'b')
  assert.equal(chain[0].effect, 'bloom')
  assert.equal(chain[0].input, null)
  assert.equal(chain[0].params.strength, 1.5)
  assert.equal(chain[0].params.radius, EFFECT_TYPES.bloom.radius)
  assert.equal(chain[0].params.threshold, EFFECT_TYPES.bloom.threshold)
})

test('effect is inactive before its add and after its remove', () => {
  const rows: Row[] = [
    { id: 'b', type: 'addEffect', effect: 'bloom', index: f(2) },
    { id: 'b', type: 'removeEffect', index: f(5) },
  ]
  assert.equal(chainAt(rows, 0).length, 0, 'before add')
  assert.equal(chainAt(rows, 2).length, 1, 'at add')
  assert.equal(chainAt(rows, 4).length, 1, 'while active')
  assert.equal(chainAt(rows, 5).length, 0, 'at remove')
  assert.equal(chainAt(rows, 9).length, 0, 'after remove')
})

test('updateEffect without dur is a step change to params', () => {
  const rows: Row[] = [
    { id: 'b', type: 'addEffect', effect: 'bloom', index: 0, params: { strength: 1 } },
    { id: 'b', type: 'updateEffect', index: f(4), params: { strength: 3 } },
  ]
  assert.equal(chainAt(rows, 3)[0].params.strength, 1)
  assert.equal(chainAt(rows, 4)[0].params.strength, 3)
  assert.equal(chainAt(rows, 8)[0].params.strength, 3)
})

test('updateEffect with dur eases numeric params toward the target, then rests', () => {
  const rows: Row[] = [
    { id: 'b', type: 'addEffect', effect: 'bloom', index: 0, params: { strength: 1 } },
    { id: 'b', type: 'updateEffect', index: f(4), dur: f(4), params: { strength: 3 },
      ease: (t: number) => t },
  ]
  assert.equal(chainAt(rows, 4)[0].params.strength, 1, 'exact start value at the update')
  assert.equal(chainAt(rows, 6)[0].params.strength, 2, 'halfway transition')
  assert.equal(chainAt(rows, 8)[0].params.strength, 3, 'rests at target after dur')
  assert.equal(chainAt(rows, 12)[0].params.strength, 3, 'stays at target')
})

test('chain orders effects by input wiring: base reader first, then downstream', () => {
  const chain = chainAt([
    { id: 'c', type: 'addEffect', effect: 'film', input: 'b', index: 0 },
    { id: 'b', type: 'addEffect', effect: 'afterimage', input: 'a', index: 0 },
    { id: 'a', type: 'addEffect', effect: 'bloom', index: 0 },
  ], 0)
  assert.deepEqual(chain.map((e) => e.id), ['a', 'b', 'c'])
})

test('an effect reading the base render (no input) leads the chain', () => {
  const chain = chainAt([
    { id: 'tail', type: 'addEffect', effect: 'film', input: 'head', index: 0 },
    { id: 'head', type: 'addEffect', effect: 'bloom', index: 0 },
  ], 0)
  assert.deepEqual(chain.map((e) => e.id), ['head', 'tail'])
  assert.equal(chain[0].input, null)
  assert.equal(chain[1].input, 'head')
})

test('updateEffect can rewire an effect input', () => {
  const rows: Row[] = [
    { id: 'a', type: 'addEffect', effect: 'bloom', index: 0 },
    { id: 'b', type: 'addEffect', effect: 'film', index: 0 },
    { id: 'b', type: 'updateEffect', index: f(3), input: 'a' },
  ]
  assert.equal(chainAt(rows, 0).find((e) => e.id === 'b')!.input, null)
  assert.equal(chainAt(rows, 3).find((e) => e.id === 'b')!.input, 'a')
})

test('empty / negative-frame inputs yield an empty chain', () => {
  assert.deepEqual(chainAt([], 0), [])
  assert.deepEqual(chainAt(null, 0), [])
  assert.deepEqual(chainAt([{ id: 'b', type: 'addEffect', effect: 'bloom', index: 0 }], -1), [])
})
