import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTapLog } from '../src/tap-log.js'

// tap-log stamps real Date.now() (needed so remote taps fold in true
// chronological order once merged), so these tests drive the fold directly by
// appending events with an explicit `at` rather than racing the clock.

test('a long gap starts a fresh window', () => {
  const t = createTapLog({ src: 'a' })
  t.log.append({ kind: 'tap', at: 0 })
  t.log.append({ kind: 'tap', at: 500 })
  t.log.append({ kind: 'tap', at: 3000 }) // > 2000ms gap — resets
  assert.deepEqual(t.rows(), [{ beat: 0, time: 3000 }])
})

test('the window is capped, oldest taps dropped first', () => {
  const t = createTapLog({ src: 'a' })
  for (let i = 0; i < 20; i++) t.log.append({ kind: 'tap', at: i * 100 })
  const rows = t.rows()
  assert.ok(rows.length > 1 && rows.length < 20, 'window is bounded')
  assert.equal(rows.at(-1)!.time, 1900, 'the newest tap is kept — oldest dropped first')
  assert.equal(rows.at(-1)!.beat, rows.length - 1, 'beats stay ordinal after the drop')
})

test('clear() empties the window', () => {
  const t = createTapLog({ src: 'a' })
  t.tap()
  t.tap()
  assert.equal(t.rows().length, 2)
  t.clear()
  assert.deepEqual(t.rows(), [])
})

test('two replicas converge on the same tap rows after merging', () => {
  const a = createTapLog({ src: 'a' })
  const b = createTapLog({ src: 'b' })
  a.log.append({ kind: 'tap', at: 0 })
  b.log.append({ kind: 'tap', at: 100 }) // interleaved chronologically with a's tap
  a.log.append({ kind: 'tap', at: 200 })

  a.log.merge(b.log.all())
  b.log.merge(a.log.all())

  assert.deepEqual(a.rows(), b.rows())
  assert.deepEqual(a.rows(), [
    { beat: 0, time: 0 },
    { beat: 1, time: 100 },
    { beat: 2, time: 200 },
  ])
})
