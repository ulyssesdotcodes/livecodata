// Multiplayer: event logs synced over WebSockets. Covers the pure convergence
// story (two editable-table stores cross-merging their logs) and the real
// transport (two clients through the room server, using Node's built-in
// WebSocket client).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEventLog } from '../src/event-log.js'
import { createEditableTableStore } from '../src/editable-tables.js'
import { createTapLog } from '../src/tap-log.js'
import { connectMultiplayer } from '../src/multiplayer.js'
import { startMultiplayerServer } from '../server/server.js'

async function until(cond: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

test('two editable-table stores converge by exchanging log events', () => {
  const a = createEditableTableStore({ src: 'a' })
  const b = createEditableTableStore({ src: 'b' })

  a.ensure('notes', { pitch: 'number', on: 'boolean' })
  a.setCell('notes', -1, 'pitch', 0) // no row yet — ignored, appends nothing
  a.addRow('notes')
  a.setCell('notes', 0, 'pitch', 60)

  // b edits concurrently, unaware of a.
  b.ensure('notes', { pitch: 'number', on: 'boolean' })
  b.addRow('notes')
  b.setCell('notes', 0, 'on', true)

  // Exchange logs both ways (order of exchange must not matter).
  b.log.merge(a.log.all())
  a.log.merge(b.log.all())

  const ta = a.get('notes')!
  const tb = b.get('notes')!
  assert.deepEqual(ta.rows, tb.rows)
  assert.deepEqual(ta.columns, tb.columns)
  assert.deepEqual(a.log.all(), b.log.all())
  // Both concurrent add-rows survived the union.
  assert.equal(ta.rows.length, 2)
})

test('store refolds and notifies when remote events merge in', () => {
  const a = createEditableTableStore({ src: 'a' })
  const b = createEditableTableStore({ src: 'b' })
  b.ensure('t', { v: 'number' })
  b.addRow('t')
  b.setCell('t', 0, 'v', 7)

  let changed = 0
  a.onChange(() => changed++)
  a.log.merge(b.log.all())
  assert.equal(changed, 1)
  assert.deepEqual(a.get('t')!.rows, [{ v: 7 }])
  // The whole store rides one log: a fresh store loaded from a's serialized
  // events folds the same state (this is the unit sessions/multiplayer sync).
  const rehydrated = createEditableTableStore()
  assert.ok(rehydrated.load(a.serialize()))
  assert.deepEqual(rehydrated.get('t')!.rows, [{ v: 7 }])
})

test('rooms sync history on join and relay live appends both ways', async () => {
  const server = await startMultiplayerServer({ port: 0 })
  const url = `ws://127.0.0.1:${server.port}/ws`
  const conns: { close(): void }[] = []
  try {
    // a has prior work; it joins first and seeds the room.
    const logA = createEventLog({ src: 'a' })
    const tablesA = createEventLog({ src: 'a' })
    const tapsA = createTapLog({ src: 'a' })
    logA.append({ kind: 'run', code: 'view("x")', seed: 1 })

    let peersA = 0
    conns.push(connectMultiplayer({
      url, room: 'jam',
      logs: { session: logA, tables: tablesA, taps: tapsA.log },
      onStatus: (_s, p) => { peersA = p },
    }))
    await until(() => server.roomLog('jam', 'session').length === 1, 'a to seed the room')

    // b joins empty and receives a's history via the sync.
    const logB = createEventLog({ src: 'b' })
    const tablesB = createEventLog({ src: 'b' })
    const tapsB = createTapLog({ src: 'b' })
    conns.push(connectMultiplayer({ url, room: 'jam', logs: { session: logB, tables: tablesB, taps: tapsB.log } }))
    await until(() => logB.length === 1, 'b to receive room history')
    assert.equal(logB.last()!.code, 'view("x")')
    await until(() => peersA === 2, 'peer count to reach a')

    // Live appends relay in both directions, across both logs.
    logB.append({ kind: 'run', code: 'view("y")', seed: 2 })
    await until(() => logA.length === 2, 'b\'s run to reach a')
    assert.equal(logA.last()!.code, 'view("y")')
    assert.equal(logA.last()!.src, 'b')

    tablesA.append({ kind: 'create', table: 'notes', columns: [] })
    await until(() => tablesB.length === 1, 'a\'s table event to reach b')
    assert.equal(tablesB.last()!.kind, 'create')

    // Tap-beat is shared the same way: b's taps reach a and fold identically.
    tapsB.tap()
    tapsB.tap()
    await until(() => tapsA.log.length === 2, 'b\'s taps to reach a')
    assert.deepEqual(tapsA.rows(), tapsB.rows())
    assert.equal(tapsA.rows().length, 2)

    // Replicas and the room hold the same log.
    assert.deepEqual(logA.all(), logB.all())
    assert.deepEqual(server.roomLog('jam', 'session'), logA.all())
  } finally {
    conns.forEach((c) => c.close())
    await server.close()
  }
})

test('a client that worked offline heals the room when it (re)joins', async () => {
  const server = await startMultiplayerServer({ port: 0 })
  const url = `ws://127.0.0.1:${server.port}/ws`
  const conns: { close(): void }[] = []
  try {
    const logA = createEventLog({ src: 'a' })
    const logB = createEventLog({ src: 'b' })
    logA.append({ kind: 'run', code: 'a0', seed: 0 })
    logB.append({ kind: 'run', code: 'b0', seed: 0 })
    logB.append({ kind: 'run', code: 'b1', seed: 0 })

    conns.push(connectMultiplayer({ url, room: 'r', logs: { session: logA } }))
    await until(() => server.roomLog('r', 'session').length === 1, 'a to seed')
    conns.push(connectMultiplayer({ url, room: 'r', logs: { session: logB } }))

    // Union: everything from both, deterministically interleaved by (seq, src).
    await until(() => logA.length === 3 && logB.length === 3, 'both replicas to hold the union')
    assert.deepEqual(logA.all().map((e) => e.code), ['a0', 'b0', 'b1'])
    assert.deepEqual(logB.all(), logA.all())
  } finally {
    conns.forEach((c) => c.close())
    await server.close()
  }
})

test('server ignores garbage frames and events sent before a join', async () => {
  const server = await startMultiplayerServer({ port: 0 })
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`)
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
    ws.send('not json')
    ws.send(JSON.stringify({ type: 'events', log: 'session', events: [{ seq: 0, t: 0, kind: 'run' }] }))
    ws.send(JSON.stringify({ type: 'join', room: 'r', client: 'x', logs: {} }))
    const sync = await new Promise<string>((resolve) => { ws.onmessage = (ev) => resolve(String(ev.data)) })
    assert.equal((JSON.parse(sync) as { type: string }).type, 'sync')
    assert.equal(server.roomLog('r', 'session').length, 0)
    ws.close()
  } finally {
    await server.close()
  }
})
