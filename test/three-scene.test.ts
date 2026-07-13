// Tests for three-scene's pure geometry-rebuild decision — the layer that
// caught a real bug: updateObject only ever repositioned an existing mesh,
// so a re-run that resized an object (a house-of-cards card's thickness) or
// reshaped it (sphere <-> box) left the stale THREE.js geometry in place
// forever. (The renderer itself is WebGL and stays untested; every decision
// it acts on is computed here.)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { geometryDims, geometryChanged, textParams, textChanged } from '../src/three-scene.js'

test('geometryDims merges shape defaults with the row\'s own fields', () => {
  assert.deepEqual(geometryDims('box', {}), { hx: 0.25, hy: 0.25, hz: 0.25, r: undefined, h: undefined })
  assert.deepEqual(geometryDims('box', { hx: 0.04 }), { hx: 0.04, hy: 0.25, hz: 0.25, r: undefined, h: undefined })
  assert.deepEqual(geometryDims('sphere', {}), { hx: undefined, hy: undefined, hz: undefined, r: 0.3, h: undefined })
})

test('geometryChanged is false when neither shape nor size moved (plain position/color update)', () => {
  const dims = geometryDims('box', { hx: 0.04, hy: 0.35, hz: 0.22 })
  assert.equal(geometryChanged('box', dims, { shape: 'box', hx: 0.04, hy: 0.35, hz: 0.22, px: 1, py: 2 }), false)
})

test('geometryChanged is true when a dimension changes — house-of-cards thickness edit', () => {
  const dims = geometryDims('box', { hx: 0.04, hy: 0.35, hz: 0.22 })
  // Same id, same shape, only hx (card half-thickness) bumped on re-run.
  assert.equal(geometryChanged('box', dims, { shape: 'box', hx: 0.3, hy: 0.35, hz: 0.22 }), true)
})

test('geometryChanged is true when the shape itself changes on the same id', () => {
  const dims = geometryDims('sphere', { r: 0.3 })
  assert.equal(geometryChanged('sphere', dims, { shape: 'box', hx: 0.25, hy: 0.25, hz: 0.25 }), true)
  // ...and true again switching back, so it isn't a one-way latch.
  const boxDims = geometryDims('box', { hx: 0.25, hy: 0.25, hz: 0.25 })
  assert.equal(geometryChanged('box', boxDims, { shape: 'sphere', r: 0.3 }), true)
})

test('geometryChanged falls back to the previous shape when a row omits it', () => {
  const dims = geometryDims('box', { hx: 0.04, hy: 0.35, hz: 0.22 })
  assert.equal(geometryChanged('box', dims, { hx: 0.04, hy: 0.35, hz: 0.22 }), false)
  assert.equal(geometryChanged('box', dims, { hx: 0.5, hy: 0.35, hz: 0.22 }), true)
})

test('textParams stringifies text and fills in appearance defaults', () => {
  assert.deepEqual(textParams({ text: 'hi' }), { text: 'hi', color: 0xffffff, size: 0.5, font: 'sans-serif' })
  // A missing string is empty (not "undefined"); size stays a number; color/font override.
  assert.deepEqual(textParams({}), { text: '', color: 0xffffff, size: 0.5, font: 'sans-serif' })
  assert.deepEqual(textParams({ text: 42, color: 0xff0000, size: 1.2, font: 'serif' }),
    { text: '42', color: 0xff0000, size: 1.2, font: 'serif' })
})

test('textChanged is false for a plain reposition and true when appearance drifts', () => {
  const prev = textParams({ text: 'hi', color: 0xffffff, size: 0.5 })
  // Only px/py moved — same string, color, size: no texture rebuild needed.
  assert.equal(textChanged(prev, { text: 'hi', color: 0xffffff, size: 0.5, px: 1, py: 2 }), false)
  assert.equal(textChanged(prev, { text: 'bye', color: 0xffffff, size: 0.5 }), true)
  assert.equal(textChanged(prev, { text: 'hi', color: 0xff0000, size: 0.5 }), true)
  assert.equal(textChanged(prev, { text: 'hi', color: 0xffffff, size: 1.0 }), true)
})
