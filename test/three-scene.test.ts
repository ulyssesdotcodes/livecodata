// Tests for three-scene's pure geometry-rebuild decision — the layer that
// caught a real bug: updateObject only ever repositioned an existing mesh,
// so a re-run that resized an object (a house-of-cards card's thickness) or
// reshaped it (sphere <-> box) left the stale THREE.js geometry in place
// forever. (The renderer itself is WebGL and stays untested; every decision
// it acts on is computed here.)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { geometryDims, geometryChanged, textParams, textGeometryChanged } from '../src/three-scene.js'

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

test('textParams stringifies text and fills in defaults', () => {
  assert.deepEqual(textParams({ text: 'hi' }), { text: 'hi', size: 0.5, color: 0xffffff })
  // A missing string is empty (not "undefined"); size stays a number; color overrides.
  assert.deepEqual(textParams({}), { text: '', size: 0.5, color: 0xffffff })
  assert.deepEqual(textParams({ text: 42, size: 1.2, color: 0xff0000 }), { text: '42', size: 1.2, color: 0xff0000 })
})

test('textGeometryChanged tracks string/size only — color recolors without a rebuild', () => {
  const prev = textParams({ text: 'hi', size: 0.5, color: 0xffffff })
  // Reposition, or a color change: no glyph geometry rebuild needed.
  assert.equal(textGeometryChanged(prev, { text: 'hi', size: 0.5, px: 1, py: 2 }), false)
  assert.equal(textGeometryChanged(prev, { text: 'hi', size: 0.5, color: 0xff0000 }), false)
  // A new string or a new size does need the geometry regenerated.
  assert.equal(textGeometryChanged(prev, { text: 'bye', size: 0.5 }), true)
  assert.equal(textGeometryChanged(prev, { text: 'hi', size: 1.0 }), true)
})
