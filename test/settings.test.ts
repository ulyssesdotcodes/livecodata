import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getVimMode, setVimMode, getMidiEnabled, setMidiEnabled, getUsername, setUsername } from '../src/settings.js'

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

test('getMidiEnabled defaults to false with no stored value (MIDI is opt-in)', () => {
  assert.equal(getMidiEnabled(fakeStorage()), false)
})

test('setMidiEnabled then getMidiEnabled round-trips true and false', () => {
  const storage = fakeStorage()
  setMidiEnabled(true, storage)
  assert.equal(getMidiEnabled(storage), true)
  setMidiEnabled(false, storage)
  assert.equal(getMidiEnabled(storage), false)
})

test('getMidiEnabled tolerates a storage that throws, falling back to the default (off)', () => {
  const storage = {
    getItem: () => { throw new Error('boom') },
    setItem: () => { throw new Error('boom') },
  }
  assert.equal(getMidiEnabled(storage), false)
  assert.doesNotThrow(() => setMidiEnabled(true, storage))
})

test('getUsername defaults to empty, round-trips, and tolerates a throwing storage', () => {
  assert.equal(getUsername(fakeStorage()), '')
  const storage = fakeStorage()
  setUsername('ada', storage)
  assert.equal(getUsername(storage), 'ada')
  const broken = {
    getItem: (): string | null => { throw new Error('boom') },
    setItem: (): void => { throw new Error('boom') },
  }
  assert.equal(getUsername(broken), '')
  assert.doesNotThrow(() => setUsername('ada', broken))
})
