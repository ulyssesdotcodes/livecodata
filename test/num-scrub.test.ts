import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scrubText, PX_PER_STEP, PX_PER_ZONE } from '../src/num-scrub.js'

// Distances are in exported sensitivity units so tuning drag feel can't break
// the contract: stepping at the literal's precision, magnitude zones, and
// float-noise-free formatting.
test('scrubbing steps a literal at its own precision, scaled by vertical zone', () => {
  assert.equal(scrubText('0.35', 2 * PX_PER_STEP, 0), '0.37')
  assert.equal(scrubText('6', -2 * PX_PER_STEP, 0), '4')
  // Less than half a step leaves the text untouched, formatting included.
  assert.equal(scrubText('0.50', Math.floor(PX_PER_STEP / 3), 0), '0.50')
  // Dragging up coarsens ×10 without dropping the value's own decimals;
  // dragging down refines ÷10 (an integer gains decimals).
  assert.equal(scrubText('0.35', PX_PER_STEP, -PX_PER_ZONE), '0.45')
  assert.equal(scrubText('6', PX_PER_STEP, PX_PER_ZONE), '6.1')
  // Sign rides along; non-numeric text passes through.
  assert.equal(scrubText('-2', -PX_PER_STEP, 0), '-3')
  assert.equal(scrubText('abc', 10 * PX_PER_STEP, 0), 'abc')
})
