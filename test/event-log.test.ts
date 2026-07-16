import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEventLog, foldEvents, randomSeed, mergeEvents, compareEvents, localSource, compactLatestPerSrcKind } from '../src/event-log.js'
import type { StampedEvent } from '../src/event-log.js'

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

test('serialized version is the base plus the number of registered migrations', () => {
  assert.equal(JSON.parse(createEventLog().serialize()).version, 1)
  const migrations = [(evs: StampedEvent[]) => evs, (evs: StampedEvent[]) => evs]
  assert.equal(JSON.parse(createEventLog({ migrations }).serialize()).version, 3)
})

test('load upgrades old data by running the tail of the migration chain', () => {
  // v1 → v2 tags each event; v2 → v3 tags again.
  const migrations = [
    (evs: StampedEvent[]) => evs.map((e) => ({ ...e, via: [...(e.via as string[] ?? []), 'v2'] })),
    (evs: StampedEvent[]) => evs.map((e) => ({ ...e, via: [...(e.via as string[] ?? []), 'v3'] })),
  ]
  const at = (version: number): string[] => {
    const log = createEventLog({ migrations })
    log.load(JSON.stringify({ version, start: 0, events: [{ kind: 'x', seq: 0, t: 0 }] }))
    return log.all()[0].via as string[]
  }
  assert.deepEqual(at(1), ['v2', 'v3'], 'v1 data runs both migrations')
  assert.deepEqual(at(2), ['v3'], 'v2 data runs only the last')
  assert.deepEqual(at(3), undefined, 'current-version data runs none')
})

test('a missing version is treated as the base; newer-than-known data loads as-is', () => {
  const migrations = [(evs: StampedEvent[]) => evs.map((e) => ({ ...e, migrated: true }))]
  const noVersion = createEventLog({ migrations })
  noVersion.load(JSON.stringify({ start: 0, events: [{ kind: 'x', seq: 0, t: 0 }] }))
  assert.equal(noVersion.all()[0].migrated, true, 'absent version migrates from the base')

  const future = createEventLog({ migrations })
  future.load(JSON.stringify({ version: 99, start: 0, events: [{ kind: 'x', seq: 0, t: 0 }] }))
  assert.equal(future.all()[0].migrated, undefined, 'data from a newer version is left untouched')
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

test('append stamps src (the replica id, overridable for tests)', () => {
  const log = createEventLog({ src: 'me' })
  assert.equal(log.append({ kind: 'a' }).src, 'me')
  const dflt = createEventLog()
  assert.equal(dflt.append({ kind: 'a' }).src, localSource())
})

test('compareEvents orders by seq then src', () => {
  const order = [
    { seq: 0, t: 0, kind: 'x', src: 'b' },
    { seq: 1, t: 0, kind: 'x', src: 'a' },
    { seq: 1, t: 0, kind: 'x', src: 'b' },
    { seq: 2, t: 0, kind: 'x' },
  ]
  const shuffled = [order[2], order[3], order[0], order[1]]
  assert.deepEqual(shuffled.sort(compareEvents), order)
})

test('mergeEvents unions, dedups by (src, seq), and drops malformed events', () => {
  const a: StampedEvent[] = [{ seq: 0, t: 0, kind: 'x', src: 'a' }]
  const incoming = [
    { seq: 0, t: 0, kind: 'x', src: 'a' },          // duplicate
    { seq: 0, t: 5, kind: 'y', src: 'b' },          // new
    { kind: 'nope' } as unknown as StampedEvent,    // malformed
  ]
  const { events, added } = mergeEvents(a, incoming)
  assert.deepEqual(added.map((e) => e.kind), ['y'])
  assert.deepEqual(events.map((e) => `${e.src}${e.seq}`), ['a0', 'b0'])
  const again = mergeEvents(events, incoming)
  assert.equal(again.events, events)
  assert.equal(again.added.length, 0)
})

test('merge interleaves remote events deterministically and bumps the clock', () => {
  const a = createEventLog({ src: 'a' })
  const b = createEventLog({ src: 'b' })
  a.append({ kind: 'a0' })
  a.append({ kind: 'a1' })
  b.append({ kind: 'b0' })

  assert.equal(a.merge(b.all()).length, 1)
  assert.equal(b.merge(a.all()).length, 2)
  const order = a.all().map((e) => e.kind)
  assert.deepEqual(order, ['a0', 'b0', 'a1'])
  assert.deepEqual(b.all().map((e) => e.kind), order)

  // Lamport bump: the next local append on b sorts after everything merged.
  const next = b.append({ kind: 'b1' })
  assert.equal(next.seq, 2)
  assert.equal(b.all().at(-1)!.kind, 'b1')
})

test('merge is idempotent and fires onMerge/onChange only when something was new', () => {
  const a = createEventLog({ src: 'a' })
  const b = createEventLog({ src: 'b' })
  b.append({ kind: 'x' })
  let merges = 0
  let changes = 0
  a.onMerge((added) => { merges++; assert.equal(added.length, 1) })
  a.onChange(() => changes++)
  a.merge(b.all())
  a.merge(b.all())
  assert.equal(merges, 1)
  assert.equal(changes, 1)
})

test('onAppend fires for local appends only, never for merges', () => {
  const a = createEventLog({ src: 'a' })
  const b = createEventLog({ src: 'b' })
  const appended: string[] = []
  a.onAppend((e) => appended.push(e.kind))
  a.append({ kind: 'mine' })
  b.append({ kind: 'theirs' })
  a.merge(b.all())
  assert.deepEqual(appended, ['mine'])
})

test('merged logs serialize/load round-trip with src intact', () => {
  const a = createEventLog({ src: 'a' })
  const b = createEventLog({ src: 'b' })
  a.append({ kind: 'x' })
  b.append({ kind: 'y' })
  a.merge(b.all())
  const copy = createEventLog()
  assert.ok(copy.load(a.serialize()))
  assert.deepEqual(copy.all(), a.all())
})

test('foldEvents derives state from the event list', () => {
  const log = createEventLog()
  log.append({ kind: 'add', n: 2 })
  log.append({ kind: 'add', n: 3 })
  log.append({ kind: 'mul', n: 10 })
  const total = foldEvents(log.all(), (s, e) => (e.kind === 'add' ? s + (e.n as number) : s * (e.n as number)), 0)
  assert.equal(total, 50)
})

test('randomSeed produces unsigned 32-bit integers', () => {
  for (let i = 0; i < 50; i++) {
    const s = randomSeed()
    assert.ok(Number.isInteger(s) && s >= 0 && s <= 0xffffffff, `seed in range: ${s}`)
  }
})

test('compactLatestPerSrcKind keeps only the newest event per (src, kind)', () => {
  const events: StampedEvent[] = [
    { seq: 0, t: 0, kind: 'presence', src: 'a', head: 1 },
    { seq: 1, t: 0, kind: 'presence', src: 'b', head: 2 },
    { seq: 2, t: 0, kind: 'live-code', src: 'a', code: 'x' },
    { seq: 3, t: 0, kind: 'presence', src: 'a', head: 9 },
    { seq: 4, t: 0, kind: 'live-code', src: 'a', code: 'xy' },
  ]
  const compacted = compactLatestPerSrcKind(events)
  assert.deepEqual(compacted.map((e) => e.seq), [1, 3, 4])
  assert.equal(compactLatestPerSrcKind(compacted), compacted)
})

test('a compact policy prunes superseded events on append and merge, seq stays monotonic', () => {
  const log = createEventLog({ src: 'a', compact: compactLatestPerSrcKind })
  for (let h = 0; h < 10; h++) log.append({ kind: 'presence', head: h })
  log.append({ kind: 'live-code', code: 'x' })
  assert.deepEqual(log.all().map((e) => [e.kind, e.seq]), [['presence', 9], ['live-code', 10]])
  assert.equal(log.append({ kind: 'presence', head: 99 }).seq, 11)

  // A superseded remote event is pruned right back out; a fresh src folds in.
  const b = createEventLog({ src: 'b', compact: compactLatestPerSrcKind })
  b.append({ kind: 'presence', head: 5 })
  log.merge(b.all())
  log.merge([{ seq: 1, t: 0, kind: 'presence', src: 'a', head: 1 }])
  assert.deepEqual(
    log.all().map((e) => [e.src, e.kind, e.seq]),
    [['b', 'presence', 0], ['a', 'live-code', 10], ['a', 'presence', 11]],
  )
  assert.ok(log.append({ kind: 'presence', head: 100 }).seq > 11)
})
