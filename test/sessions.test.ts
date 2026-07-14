import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSessionStore } from '../src/sessions.js'

// The storage-blob backend is what runs under node (no IndexedDB); both
// backends share the upsert/summary/sort logic these tests pin down, and the
// same async SessionStore surface main.ts codes against.

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

test('newId produces distinct ids', () => {
  const store = createSessionStore(fakeStorage())
  const ids = new Set([store.newId(), store.newId(), store.newId()])
  assert.equal(ids.size, 3)
})

test('save then load round-trips the serialized log', async () => {
  const store = createSessionStore(fakeStorage())
  await store.save('a', { events: '{"entries":[1]}', tables: ['scene'] })
  assert.equal(await store.load('a'), '{"entries":[1]}')
  assert.equal(await store.load('missing'), null)
})

test('save then runs round-trips the run list; legacy sessions report none', async () => {
  const store = createSessionStore(fakeStorage())
  const runs = [{ at: 2, tables: { code: 1, nums: 1 } }, { at: 4, tables: { code: 2, nums: 2 } }]
  await store.save('a', { events: 'e', tables: ['nums'], runs })
  assert.deepEqual(await store.runs('a'), runs)

  await store.save('b', { events: 'e' }) // no runs supplied — a legacy/empty session
  assert.deepEqual(await store.runs('b'), [])
  assert.deepEqual(await store.runs('missing'), [])
})

test('save upserts: same id updates in place and preserves createdAt', async () => {
  const store = createSessionStore(fakeStorage())
  const first = await store.save('a', { events: 'v0', tables: ['x'] })
  const second = await store.save('a', { events: 'v1', tables: ['x', 'y'] })
  assert.equal((await store.list()).length, 1, 'one record, not two')
  assert.equal(await store.load('a'), 'v1')
  assert.equal(second.createdAt, first.createdAt, 'createdAt preserved across updates')
  assert.ok(second.updatedAt >= first.updatedAt, 'updatedAt advances')
})

test('list returns summaries (with tables) newest-updated first, no log payload', async () => {
  const store = createSessionStore(fakeStorage())
  await store.save('a', { events: 'a', tables: ['one'] })
  await store.save('b', { events: 'b', tables: ['two', 'three'] })
  const list = await store.list()
  assert.deepEqual(list.map((s) => s.id), ['b', 'a'], 'newest first')
  assert.deepEqual(list[0].tables, ['two', 'three'])
  assert.equal('events' in list[0], false, 'summaries omit the serialized events')
})

test('sessions start unnamed and unarchived', async () => {
  const store = createSessionStore(fakeStorage())
  await store.save('a', { events: 'a' })
  const [s] = await store.list()
  assert.equal(s.name, '')
  assert.equal(s.archived, false)
})

test('rename sets the name; a later save preserves it', async () => {
  const store = createSessionStore(fakeStorage())
  await store.save('a', { events: 'v0' })
  await store.rename('a', 'my jam')
  assert.equal((await store.list())[0].name, 'my jam')

  await store.save('a', { events: 'v1', tables: ['x'] })
  assert.equal((await store.list())[0].name, 'my jam', 'name survives an ordinary save')
  assert.equal(await store.load('a'), 'v1', 'the save still landed')
})

test('setArchived flips the flag; a later save preserves it; unarchive restores', async () => {
  const store = createSessionStore(fakeStorage())
  await store.save('a', { events: 'v0' })
  await store.setArchived('a', true)
  assert.equal((await store.list())[0].archived, true)

  await store.save('a', { events: 'v1' })
  assert.equal((await store.list())[0].archived, true, 'archived survives an ordinary save')

  await store.setArchived('a', false)
  assert.equal((await store.list())[0].archived, false)
})

test('rename and setArchived on an unknown id are no-ops', async () => {
  const store = createSessionStore(fakeStorage())
  await store.rename('missing', 'x')
  await store.setArchived('missing', true)
  assert.deepEqual(await store.list(), [])
})

test('remove deletes a single session', async () => {
  const store = createSessionStore(fakeStorage())
  await store.save('a', { events: 'a' })
  await store.save('b', { events: 'b' })
  await store.remove('a')
  assert.equal(await store.load('a'), null)
  assert.equal(await store.load('b'), 'b')
  assert.equal((await store.list()).length, 1)
})

test('survives an empty, missing, or corrupt store without throwing', async () => {
  assert.deepEqual(await createSessionStore(fakeStorage()).list(), [])

  const corrupt = fakeStorage()
  corrupt.setItem('livecodata.sessions', '{not valid json')
  assert.deepEqual(await createSessionStore(corrupt).list(), [], 'corrupt → empty list')
  const store = createSessionStore(corrupt)
  await store.save('a', { events: 'a', tables: [] })
  assert.equal(await store.load('a'), 'a')
})

test('a failed write rejects rather than losing data silently', async () => {
  const storage = fakeStorage()
  const store = createSessionStore(storage)
  await store.save('a', { events: 'a' })
  storage.setItem = () => { throw new Error('quota exceeded') }
  await assert.rejects(store.save('a', { events: 'bigger' }), /quota/)
})

test('a new store instance sees sessions persisted by another (same storage)', async () => {
  const storage = fakeStorage()
  await createSessionStore(storage).save('a', { events: 'a', tables: ['t'] })
  const reopened = createSessionStore(storage)
  assert.equal(await reopened.load('a'), 'a')
  assert.deepEqual((await reopened.list()).map((s) => s.id), ['a'])
})
