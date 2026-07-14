// Presence: ephemeral who's-doing-what indicators riding their own synced
// event log (see src/presence.ts). Covers the per-client last-wins fold, the
// throttled announcer, deriving "last cell edited" straight from the store
// log's src stamps, and a real round-trip through the room server (which
// needs no changes — it merges and relays any named log).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPresenceChannel, userColor, lastCellEdits } from '../src/presence.js'
import { createEditableTableStore } from '../src/editable-tables.js'
import { connectMultiplayer } from '../src/multiplayer.js'
import { startMultiplayerServer } from '../server/server.js'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function until(cond: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await sleep(10)
  }
}

test('presence folds to the latest announcement per client', async () => {
  const a = createPresenceChannel({ user: 'alice', src: 'a', throttleMs: 1 })
  const b = createPresenceChannel({ user: 'bob', src: 'b', throttleMs: 1 })

  a.set({ table: 'notes' })
  await sleep(10)
  a.set({ table: 'scene', cell: 'code[0].code', head: 12 })
  await sleep(10)
  b.set({ table: 'notes' })
  await sleep(10)

  // Exchange logs both ways; both sides agree on everyone's latest state.
  b.log.merge(a.log.all())
  a.log.merge(b.log.all())
  for (const chan of [a, b]) {
    assert.deepEqual(chan.peers().get('a'), { client: 'a', user: 'alice', table: 'scene', cell: 'code[0].code', head: 12 })
    assert.deepEqual(chan.peers().get('b'), { client: 'b', user: 'bob', table: 'notes', cell: null, head: 0 })
  }
})

test('presence announcements are throttled and coalesce to the final state', async () => {
  const a = createPresenceChannel({ user: 'alice', src: 'a', throttleMs: 30 })
  a.set({ head: 1 })
  for (let h = 2; h <= 20; h++) a.set({ head: h })
  // Inside the window: one immediate announcement, the rest pending.
  assert.equal(a.log.length, 1)
  await sleep(80)
  // The trailing announcement carries the *final* coalesced state.
  const last = a.log.last()!
  assert.equal(last.head, 20)
  assert.ok(a.log.length <= 3, `expected coalesced announcements, got ${a.log.length}`)
  // Re-announcing an identical state is a no-op.
  const len = a.log.length
  a.set({ head: 20 })
  await sleep(50)
  assert.equal(a.log.length, len)
})

test('a remote merge notifies; local announcements do not', async () => {
  const a = createPresenceChannel({ user: 'alice', src: 'a', throttleMs: 1 })
  const b = createPresenceChannel({ user: 'bob', src: 'b', throttleMs: 1 })
  let notified = 0
  b.onChange(() => notified++)
  b.set({ table: 'notes' })
  await sleep(10)
  assert.equal(notified, 0)
  a.set({ table: 'scene' })
  await sleep(10)
  b.log.merge(a.log.all())
  assert.equal(notified, 1)
  // Merging the same events again adds nothing and stays quiet.
  b.log.merge(a.log.all())
  assert.equal(notified, 1)
})

test('lastCellEdits reads each replica\'s last edit off the store log', () => {
  const a = createEditableTableStore({ src: 'a' })
  const b = createEditableTableStore({ src: 'b' })

  a.ensure('notes', { pitch: 'number', on: 'boolean' })
  a.addRow('notes')
  a.setCell('notes', 0, 'pitch', 60)
  b.log.merge(a.log.all())
  b.setCell('notes', 0, 'on', true)
  b.setRow('code', 0, { code: 'x', seed: 1 }) // no such table/row — appends nothing
  a.log.merge(b.log.all())

  const edits = lastCellEdits(a.log.all())
  assert.deepEqual(edits.get('a'), { table: 'notes', row: 0, col: 'pitch', seq: edits.get('a')!.seq })
  assert.deepEqual(edits.get('b'), { table: 'notes', row: 0, col: 'on', seq: edits.get('b')!.seq })

  // A later set-row (e.g. a Run writing the "code" row) becomes that
  // replica's last edit, attributed to its first written column.
  a.ensure('code', { code: 'code', seed: 'number' })
  a.addRow('code')
  a.setRow('code', 0, { code: 'view("x")', seed: 7 })
  const after = lastCellEdits(a.log.all())
  assert.equal(after.get('a')!.table, 'code')
  assert.equal(after.get('a')!.col, 'code')
  // Non-edit events (create, add-row, server peer-joins) never count.
  assert.equal(lastCellEdits([{ seq: 0, t: 0, kind: 'peer-join', src: 'server', table: 'activity', client: 'a' }]).size, 0)
})

test('userColor is deterministic per name', () => {
  assert.equal(userColor('alice'), userColor('alice'))
  assert.notEqual(userColor('alice'), userColor('bob'))
  assert.match(userColor('alice'), /^hsl\(\d+, 75%, 62%\)$/)
})

test('presence syncs through the room server as its own named log', async () => {
  const server = await startMultiplayerServer({ port: 0 })
  const url = `ws://127.0.0.1:${server.port}/ws`
  const conns: { close(): void }[] = []
  try {
    const a = createPresenceChannel({ user: 'alice', src: 'a', throttleMs: 1 })
    const b = createPresenceChannel({ user: 'bob', src: 'b', throttleMs: 1 })
    a.set({ table: 'scene', cell: 'code[0].code', head: 4 })
    await sleep(10)

    conns.push(connectMultiplayer({ url, room: 'jam', logs: { presence: a.log } }))
    await until(() => server.roomLog('jam', 'presence').length > 0, 'a to seed presence')

    // b joins later and still sees a's pre-join announcement via the sync.
    conns.push(connectMultiplayer({ url, room: 'jam', logs: { presence: b.log } }))
    await until(() => b.peers().has('a'), 'b to learn a\'s presence')
    assert.deepEqual(b.peers().get('a'), { client: 'a', user: 'alice', table: 'scene', cell: 'code[0].code', head: 4 })

    // Live updates relay: a moves, b follows.
    a.set({ table: 'notes', head: 9 })
    await until(() => b.peers().get('a')?.table === 'notes', 'a\'s move to reach b')
    assert.equal(b.peers().get('a')!.head, 9)
  } finally {
    conns.forEach((c) => c.close())
    await server.close()
  }
})

test('live-code announcements fold to the latest buffer per client, separate from cursors', async () => {
  const a = createPresenceChannel({ user: 'alice', src: 'a', throttleMs: 1 })
  const b = createPresenceChannel({ user: 'bob', src: 'b', throttleMs: 1 })

  a.setLiveCode('code[0].code', 'view("x')
  await sleep(10)
  a.setLiveCode('code[0].code', 'view("x").grid()')
  a.set({ cell: 'code[0].code', head: 16 })
  await sleep(10)

  b.log.merge(a.log.all())
  const live = b.liveCodes().get('a')!
  assert.equal(live.cell, 'code[0].code')
  assert.equal(live.code, 'view("x").grid()')
  // Cursor state rides its own events and is unaffected.
  assert.equal(b.peers().get('a')!.head, 16)
  // Re-announcing an identical buffer is a no-op.
  const len = a.log.length
  a.setLiveCode('code[0].code', 'view("x").grid()')
  await sleep(10)
  assert.equal(a.log.length, len)
})

test('the presence log stays bounded: superseded announcements compact away', async () => {
  const a = createPresenceChannel({ user: 'alice', src: 'a', throttleMs: 1 })
  for (let i = 0; i < 50; i++) {
    a.set({ head: i })
    a.setLiveCode('code[0].code', `v${i}`)
    await sleep(3)
  }
  // One 'presence' + one 'live-code' event survive, however long the session.
  assert.ok(a.log.length <= 2, `expected a compacted log, got ${a.log.length} events`)
  const kinds = a.log.all().map((e) => e.kind).sort()
  assert.deepEqual(kinds, ['live-code', 'presence'])
  // The survivors carry the *final* state.
  assert.equal(a.log.all().find((e) => e.kind === 'presence')!.head, 49)
  assert.equal(a.log.all().find((e) => e.kind === 'live-code')!.code, 'v49')
})

test('live code syncs through the room server and the room copy stays compacted', async () => {
  const server = await startMultiplayerServer({ port: 0 })
  const url = `ws://127.0.0.1:${server.port}/ws`
  const conns: { close(): void }[] = []
  try {
    const a = createPresenceChannel({ user: 'alice', src: 'a', throttleMs: 1 })
    const b = createPresenceChannel({ user: 'bob', src: 'b', throttleMs: 1 })
    conns.push(connectMultiplayer({ url, room: 'jam', logs: { presence: a.log } }))
    conns.push(connectMultiplayer({ url, room: 'jam', logs: { presence: b.log } }))

    for (let i = 0; i < 20; i++) {
      a.setLiveCode('code[0].code', `view("x${i}")`)
      await sleep(5)
    }
    await until(() => b.liveCodes().get('a')?.code === 'view("x19")', 'a\'s typing to reach b')

    // However many announcements were published, the room holds at most the
    // latest per (replica, kind) — the join sync a latecomer downloads is
    // O(replicas), not O(keystrokes).
    await until(() => server.roomLog('jam', 'presence').length > 0, 'room to hold presence')
    const room = server.roomLog('jam', 'presence')
    const perSrcKind = new Set(room.map((e) => `${e.src}#${e.kind}`))
    assert.equal(room.length, perSrcKind.size, `room log has superseded events: ${room.length} events for ${perSrcKind.size} (src, kind) pairs`)
    // b's replica also compacts what it merged.
    assert.ok(b.log.length <= 4, `expected b's compacted log, got ${b.log.length}`)
  } finally {
    conns.forEach((c) => c.close())
    await server.close()
  }
})
