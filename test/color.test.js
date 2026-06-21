import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mixColor } from '../src/color.js'

test('mixColor returns endpoints exactly', () => {
  assert.equal(mixColor(0x000000, 0xffffff, 0), 0x000000)
  assert.equal(mixColor(0x000000, 0xffffff, 1), 0xffffff)
  assert.equal(mixColor(0xff5577, 0x4a9eff, 0), 0xff5577)
  assert.equal(mixColor(0xff5577, 0x4a9eff, 1), 0x4a9eff)
})

test('mixColor clamps t to [0,1]', () => {
  assert.equal(mixColor(0xffffff, 0x4a9eff, -2), 0xffffff)
  assert.equal(mixColor(0xffffff, 0x4a9eff, 5), 0x4a9eff)
})

test('mixColor lands strictly between for an interior t', () => {
  const mid = mixColor(0x000000, 0xffffff, 0.5)
  assert.ok(mid > 0x000000 && mid < 0xffffff, 'a 50% mix is between black and white')
})

test('mixColor degrades gracefully on null operands', () => {
  assert.equal(mixColor(null, 0x4a9eff, 0.5), 0x4a9eff)
  assert.equal(mixColor(0x4a9eff, null, 0.5), 0x4a9eff)
  assert.equal(mixColor(null, null, 0.5), null)
})
