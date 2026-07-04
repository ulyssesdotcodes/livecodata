import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEventLog, foldEvents } from '../src/event-log.js'

test('append stamps seq (monotonic) and t (ms since first event)', () => {
  const log = createEventLog()
  const a = log.append({ kind: 'x', v: 1 })
  const b = log.append({ kind: 'y', v: 2 })
  assert.equal(a.seq, 0)
  assert.equal(b.seq, 1)
  assert.ok(a.t >= 0 && b.t >= a.t)
  assert.equal(log.length, 2)
  assert.deepEqual(log.all().map((e) => e.kind), ['x', 'y'])
})

test('upTo returns the prefix at-or-before a position', () => {
  const log = createEventLog()
  log.append({ kind: 'a' })
  log.append({ kind: 'b' })
  log.append({ kind: 'c' })
  assert.deepEqual(log.upTo(1).map((e) => e.kind), ['a', 'b'])
  assert.deepEqual(log.upTo(-1), [])
  assert.equal(log.last()!.kind, 'c')
})

test('serialize/load round-trips and seq continues after load', () => {
  const log = createEventLog()
  log.append({ kind: 'a' })
  log.append({ kind: 'b' })
  const json = log.serialize()

  const log2 = createEventLog()
  assert.ok(log2.load(json))
  assert.deepEqual(log2.all().map((e) => e.kind), ['a', 'b'])
  const c = log2.append({ kind: 'c' })
  assert.equal(c.seq, 2)
})

test('load rejects garbage without throwing', () => {
  const log = createEventLog()
  assert.equal(log.load('not json'), false)
  assert.equal(log.load('{"nope":1}'), false)
  assert.equal(log.load(null), false)
})

test('onChange fires on append, load, and clear', () => {
  const log = createEventLog()
  let fired = 0
  log.onChange(() => fired++)
  log.append({ kind: 'a' })
  log.load(log.serialize())
  log.clear()
  assert.equal(fired, 3)
})

test('foldEvents derives state from the event list', () => {
  const log = createEventLog()
  log.append({ kind: 'add', n: 2 })
  log.append({ kind: 'add', n: 3 })
  log.append({ kind: 'mul', n: 10 })
  const total = foldEvents(log.all(), (s, e) => (e.kind === 'add' ? s + (e.n as number) : s * (e.n as number)), 0)
  assert.equal(total, 50)
})
