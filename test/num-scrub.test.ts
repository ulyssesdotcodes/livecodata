import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scrubText } from '../src/num-scrub.js'

test('scrubbing steps a literal at its own precision, scaled by vertical zone', () => {
  // Horizontal steps at the literal's decimals: "0.35" by hundredths, "6" by ones.
  assert.equal(scrubText('0.35', 16, 0), '0.37')
  assert.equal(scrubText('6', -16, 0), '4')
  // No horizontal movement leaves the text untouched (formatting included).
  assert.equal(scrubText('0.50', 3, 0), '0.50')
  // Dragging up coarsens ×10, down refines ÷10 (an integer gains decimals).
  assert.equal(scrubText('0.35', 8, -56), '0.45')
  assert.equal(scrubText('6', 8, 56), '6.1')
  // Sign rides along; non-numeric text passes through.
  assert.equal(scrubText('-2', -8, 0), '-3')
  assert.equal(scrubText('abc', 80, 0), 'abc')
})
