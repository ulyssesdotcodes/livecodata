import test from 'node:test'
import assert from 'node:assert/strict'
import { particleRows, hasSpawner, particleParamsAt } from '../src/particles.js'
import { beatToFrame } from '../src/constants.js'

test('particles: a spawn row opts the sim in; disabled rows do not', () => {
  assert.equal(hasSpawner(particleRows([{ event: 'setVariable', name: 'speed', value: 1 }])), false)
  assert.equal(hasSpawner(particleRows([{ event: 'spawn', beat: 1 }])), true)
  assert.equal(hasSpawner(particleRows([{ event: 'spawn', beat: 1, disabled: true }])), false)
})

test('particles: setVariable rows fold at-or-before the playhead, last write wins, unknown names ignored', () => {
  const rows = particleRows([
    { beat: 1, event: 'spawn' },
    { beat: 1, event: 'setVariable', name: 'speed', value: 0.001 },
    { beat: 5, event: 'setVariable', name: 'speed', value: 0.01 },
    { beat: 5, event: 'setVariable', name: 'elscale', value: 8 },
    { beat: 9, event: 'setVariable', name: 'nonsense', value: 42 },
  ])
  assert.deepEqual(particleParamsAt(rows, beatToFrame(2)), { speed: 0.001 })
  assert.deepEqual(particleParamsAt(rows, beatToFrame(10)), { speed: 0.01, elscale: 8 })
})
