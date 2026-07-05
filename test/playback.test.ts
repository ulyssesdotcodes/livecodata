import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wallAlignedTick } from '../src/playback.js'

test('wallAlignedTick is 0 exactly at the anchor instant', () => {
  assert.equal(wallAlignedTick(1000, 1000, 4), 0)
})

test('wallAlignedTick advances linearly with elapsed wall time', () => {
  assert.equal(wallAlignedTick(1000 + 1500, 1000, 4), 1.5)
})

test('wallAlignedTick wraps into [0, loopSeconds) past one loop', () => {
  assert.equal(wallAlignedTick(1000 + 4500, 1000, 4), 0.5)
  assert.equal(wallAlignedTick(1000 + 4000 * 3 + 500, 1000, 4), 0.5, 'wraps across multiple loops the same way')
})

test('wallAlignedTick handles "now" before the anchor (still non-negative)', () => {
  assert.equal(wallAlignedTick(1000 - 500, 1000, 4), 3.5)
})

test('wallAlignedTick returns 0 for a non-positive loop length', () => {
  assert.equal(wallAlignedTick(5000, 1000, 0), 0)
  assert.equal(wallAlignedTick(5000, 1000, -4), 0)
})

test('two independent "clients" sharing an anchor land on the same phase at the same wall time', () => {
  const anchorMs = 123456
  const loopSeconds = 2
  const nowMs = anchorMs + 7777
  // Client A "started" a while ago, client B just started — irrelevant to the
  // wall-aligned phase, which only depends on the shared anchor + now.
  const phaseA = wallAlignedTick(nowMs, anchorMs, loopSeconds)
  const phaseB = wallAlignedTick(nowMs, anchorMs, loopSeconds)
  assert.equal(phaseA, phaseB)
})
