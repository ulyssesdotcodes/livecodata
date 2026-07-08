import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getVimMode, setVimMode } from '../src/settings.js'

interface FakeStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  _mem: Map<string, string>
}

function fakeStorage(): FakeStorage {
  const mem = new Map<string, string>()
  return {
    getItem: (k) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k, v) => mem.set(k, String(v)),
    _mem: mem,
  }
}

test('getVimMode defaults to true with no stored value (matches the prior always-on behavior)', () => {
  assert.equal(getVimMode(fakeStorage()), true)
})

test('setVimMode then getVimMode round-trips true and false', () => {
  const storage = fakeStorage()
  setVimMode(true, storage)
  assert.equal(getVimMode(storage), true)
  setVimMode(false, storage)
  assert.equal(getVimMode(storage), false)
})

test('getVimMode tolerates a storage that throws, falling back to the default (on)', () => {
  const storage = {
    getItem: () => { throw new Error('boom') },
    setItem: () => { throw new Error('boom') },
  }
  assert.equal(getVimMode(storage), true)
  assert.doesNotThrow(() => setVimMode(true, storage))
})
