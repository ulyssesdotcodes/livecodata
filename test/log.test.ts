import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createLog, randomSeed } from '../src/log.js'

interface FakeStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  _mem: Map<string, string>
}

function fakeStorage(): FakeStorage {
  const mem = new Map<string, string>()
  return {
    getItem: (k) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
    _mem: mem,
  }
}

test('append assigns monotonic seq and relative timestamps', () => {
  const log = createLog()
  const a = log.append({ kind: 'run', code: 'v0', seed: 1 })
  const b = log.append({ kind: 'run', code: 'v1', seed: 2 })
  const c = log.append({ kind: 'run', code: 'v2', seed: 3 })
  assert.equal(a.seq, 0)
  assert.equal(b.seq, 1)
  assert.equal(c.seq, 2)
  assert.equal(log.length, 3)
  assert.equal(a.t, 0, 'first event anchors the clock at t=0')
  assert.ok(b.t >= a.t && c.t >= b.t, 'timestamps are non-decreasing')
})

test('entryAt selects the latest entry whose seq <= pos, clamping both ends', () => {
  const log = createLog()
  log.append({ kind: 'run', code: 'v0' })
  log.append({ kind: 'run', code: 'v1' })
  log.append({ kind: 'run', code: 'v2' })
  assert.equal(log.entryAt(-1), null, 'before the first entry → null')
  assert.equal(log.entryAt(0)!.code, 'v0')
  assert.equal(log.entryAt(1)!.code, 'v1')
  assert.equal(log.entryAt(99)!.code, 'v2', 'past the end clamps to the last entry')
})

test('serialize → load round-trips entries', () => {
  const log = createLog()
  log.append({ kind: 'run', code: 'a', seed: 11 })
  log.append({ kind: 'run', code: 'b', seed: 22 })
  const json = log.serialize()

  const restored = createLog()
  assert.equal(restored.load(json), true)
  assert.equal(restored.length, 2)
  assert.equal(restored.last()!.code, 'b')
  assert.equal(restored.last()!.seed, 22)
})

test('persist → rehydrate restores a session and continues seq monotonically', () => {
  const storage = fakeStorage()
  const log = createLog()
  log.append({ kind: 'run', code: 'v0' })
  log.append({ kind: 'run', code: 'v1' })
  log.append({ kind: 'run', code: 'v2' })
  log.persist(storage)

  const reloaded = createLog()
  assert.equal(reloaded.rehydrate(storage), true)
  assert.equal(reloaded.length, 3)
  assert.equal(reloaded.last()!.code, 'v2')
  const next = reloaded.append({ kind: 'run', code: 'v3' })
  assert.equal(next.seq, 3)
})

test('rehydrate returns false for empty, missing, and corrupt stores', () => {
  assert.equal(createLog().rehydrate(fakeStorage()), false, 'empty store')

  const corrupt = fakeStorage()
  corrupt.setItem('livecodata.session', '{not valid json')
  assert.equal(createLog().rehydrate(corrupt), false, 'corrupt store does not throw')

  const noEntries = fakeStorage()
  noEntries.setItem('livecodata.session', JSON.stringify({ version: 1, entries: [] }))
  assert.equal(createLog().rehydrate(noEntries), false, 'valid but empty → false')
})

test('clear empties the log and removes the persisted copy', () => {
  const storage = fakeStorage()
  const log = createLog()
  log.append({ kind: 'run', code: 'v0' })
  log.persist(storage)
  log.clear(storage)
  assert.equal(log.length, 0)
  assert.equal(storage.getItem('livecodata.session'), null)
})

test('randomSeed produces unsigned 32-bit integers', () => {
  for (let i = 0; i < 50; i++) {
    const s = randomSeed()
    assert.ok(Number.isInteger(s) && s >= 0 && s <= 0xffffffff, `seed in range: ${s}`)
  }
})
