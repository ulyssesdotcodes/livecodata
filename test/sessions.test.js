import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSessionStore } from '../src/sessions.js'

// A minimal in-memory stand-in for window.localStorage.
function fakeStorage() {
  const mem = new Map()
  return {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
    _mem: mem,
  }
}

test('newId produces distinct ids', () => {
  const store = createSessionStore(fakeStorage())
  const ids = new Set([store.newId(), store.newId(), store.newId()])
  assert.equal(ids.size, 3)
})

test('save then load round-trips the serialized log', () => {
  const store = createSessionStore(fakeStorage())
  store.save('a', { serialized: '{"entries":[1]}', tables: ['scene'] })
  assert.equal(store.load('a'), '{"entries":[1]}')
  assert.equal(store.load('missing'), null)
})

test('save upserts: same id updates in place and preserves createdAt', () => {
  const store = createSessionStore(fakeStorage())
  const first = store.save('a', { serialized: 'v0', tables: ['x'] })
  const second = store.save('a', { serialized: 'v1', tables: ['x', 'y'] })
  assert.equal(store.list().length, 1, 'one record, not two')
  assert.equal(store.load('a'), 'v1')
  assert.equal(second.createdAt, first.createdAt, 'createdAt preserved across updates')
  assert.ok(second.updatedAt >= first.updatedAt, 'updatedAt advances')
})

test('list returns summaries (with tables) newest-updated first, no log payload', () => {
  const store = createSessionStore(fakeStorage())
  store.save('a', { serialized: 'a', tables: ['one'] })
  store.save('b', { serialized: 'b', tables: ['two', 'three'] })
  const list = store.list()
  assert.deepEqual(list.map((s) => s.id), ['b', 'a'], 'newest first')
  assert.deepEqual(list[0].tables, ['two', 'three'])
  assert.equal('log' in list[0], false, 'summaries omit the serialized log')
})

test('remove deletes a single session', () => {
  const store = createSessionStore(fakeStorage())
  store.save('a', { serialized: 'a' })
  store.save('b', { serialized: 'b' })
  store.remove('a')
  assert.equal(store.load('a'), null)
  assert.equal(store.load('b'), 'b')
  assert.equal(store.list().length, 1)
})

test('survives an empty, missing, or corrupt store without throwing', () => {
  assert.deepEqual(createSessionStore(fakeStorage()).list(), [])

  const corrupt = fakeStorage()
  corrupt.setItem('livecodata.sessions', '{not valid json')
  assert.deepEqual(createSessionStore(corrupt).list(), [], 'corrupt → empty list')
  // And a save over a corrupt store recovers cleanly.
  const store = createSessionStore(corrupt)
  store.save('a', { serialized: 'a', tables: [] })
  assert.equal(store.load('a'), 'a')
})

test('a new store instance sees sessions persisted by another (same storage)', () => {
  const storage = fakeStorage()
  createSessionStore(storage).save('a', { serialized: 'a', tables: ['t'] })
  const reopened = createSessionStore(storage)
  assert.equal(reopened.load('a'), 'a')
  assert.deepEqual(reopened.list().map((s) => s.id), ['a'])
})
