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

    conns.push(connectMultiplayer({
      url, room: 'jam',
      logs: { session: logA, tables: tablesA, taps: tapsA.log },
    }))
    await until(() => server.roomLog('jam', 'session').some((e) => e.code === 'view("x")'), 'a to seed the room')

    // b joins empty and receives a's history via the sync.
    const logB = createEventLog({ src: 'b' })
    const tablesB = createEventLog({ src: 'b' })
    const tapsB = createTapLog({ src: 'b' })
    conns.push(connectMultiplayer({ url, room: 'jam', logs: { session: logB, tables: tablesB, taps: tapsB.log } }))
    await until(() => logB.all().some((e) => e.code === 'view("x")'), 'b to receive room history')

    // Live appends relay in both directions, across both logs.
    logB.append({ kind: 'run', code: 'view("y")', seed: 2 })
    await until(() => logA.all().some((e) => e.code === 'view("y")'), 'b\'s run to reach a')
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

    // Replicas and the room hold the same log — including the server's own
    // peer-join events (see the next test), which ride the same "session" log.
    assert.deepEqual(logA.all(), logB.all())
    assert.deepEqual(server.roomLog('jam', 'session'), logA.all())
  } finally {
    conns.forEach((c) => c.close())
    await server.close()
  }
})

test('the room server authors peer-join/peer-leave on the session log, not a side channel', async () => {
  const server = await startMultiplayerServer({ port: 0 })
  const url = `ws://127.0.0.1:${server.port}/ws`
  const conns: { close(): void }[] = []
  try {
    // The "activity" table must exist before a replica connects — see
    // main.ts's ACTIVITY_TABLE comment — otherwise a peer-join event tagged
    // table:"activity" has nothing to fold onto in a real EditableTableStore
    // (this test uses a raw EventLog, which doesn't fold at all, so it'd
    // still see the event either way; the guarantee matters client-side).
    const logA = createEventLog({ src: 'a' })
    logA.append({ kind: 'create', table: 'activity', columns: [] })
    conns.push(connectMultiplayer({ url, room: 'peerjam', logs: { session: logA } }))
    await until(() => logA.all().some((e) => e.kind === 'peer-join' && e.src === 'server'), 'a sees its own peer-join')

    const logB = createEventLog({ src: 'b' })
    logB.append({ kind: 'create', table: 'activity', columns: [] })
    const connB = connectMultiplayer({ url, room: 'peerjam', logs: { session: logB } })
    conns.push(connB)
    await until(
      () => logA.all().filter((e) => e.kind === 'peer-join' && e.src === 'server').length === 2,
      'a sees both peer-joins',
    )
    await until(
      () => logB.all().filter((e) => e.kind === 'peer-join' && e.src === 'server').length === 2,
      'b sees both peer-joins',
    )
    for (const e of logA.all().filter((e) => e.kind === 'peer-join')) {
      assert.equal(e.table, 'activity')
      assert.equal(typeof e.client, 'string')
    }

    // b leaves: a sees a peer-leave for b's client id.
    connB.close()
    await until(
      () => logA.all().some((e) => e.kind === 'peer-leave' && e.src === 'server'),
      'a sees b\'s peer-leave',
    )
  } finally {
    conns.forEach((c) => c.close())
    await server.close()
  }
})

test('the room log is dropped once the last client disconnects, and a fresh join starts clean', async () => {
  const server = await startMultiplayerServer({ port: 0 })
  const url = `ws://127.0.0.1:${server.port}/ws`
  const conns: { close(): void }[] = []
  try {
    const logA = createEventLog({ src: 'a' })
    const logB = createEventLog({ src: 'b' })
    logA.append({ kind: 'run', code: 'a0', seed: 0 })

    const connA = connectMultiplayer({ url, room: 'evanescent', logs: { session: logA } })
    conns.push(connA)
    await until(() => server.roomLog('evanescent', 'session').some((e) => e.code === 'a0'), 'a to seed the room')

    const connB = connectMultiplayer({ url, room: 'evanescent', logs: { session: logB } })
    conns.push(connB)
    await until(() => logB.all().some((e) => e.code === 'a0'), 'b to receive history')

    // One of two leaves: the room still has a member, so its log survives.
    connB.close()
    await until(
      () => server.roomLog('evanescent', 'session').some((e) => e.kind === 'peer-leave'),
      'b\'s departure to register',
    )
    assert.ok(server.roomLog('evanescent', 'session').some((e) => e.code === 'a0'), 'log survives while a is still connected')

    // The last one leaves: nobody's left to hold the log, so it's dropped —
    // each client already has its own copy in localStorage (sessionStore),
    // so nothing is actually lost.
    connA.close()
    await until(() => server.roomLog('evanescent', 'session').length === 0, 'the room log to be dropped')

    // A fresh join with no history re-seeds a brand-new room from scratch —
    // proof it's truly gone, not just quiesced (an old peer-leave/join or a0
    // would still be sitting there otherwise).
    const logC = createEventLog({ src: 'c' })
    const connC = connectMultiplayer({ url, room: 'evanescent', logs: { session: logC } })
    conns.push(connC)
    await until(() => logC.all().some((e) => e.kind === 'peer-join'), 'c to join the reborn room')
    assert.equal(server.roomLog('evanescent', 'session').length, 1)
    assert.ok(!server.roomLog('evanescent', 'session').some((e) => e.code === 'a0'), 'old history did not survive')
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
    // The room server also authors a peer-join for a's own connection (see
    // server.ts) — one extra event alongside a0.
    await until(() => server.roomLog('r', 'session').length === 2, 'a to seed')
    conns.push(connectMultiplayer({ url, room: 'r', logs: { session: logB } }))

    // Union: everything from both (plus each side's server-authored
    // peer-join), deterministically interleaved by (seq, src).
    await until(() => logA.length === 5 && logB.length === 5, 'both replicas to hold the union')
    const codes = (log: typeof logA) => log.all().filter((e) => e.code != null).map((e) => e.code)
    assert.deepEqual(codes(logA), ['a0', 'b0', 'b1'])
    assert.deepEqual(logA.all().filter((e) => e.kind === 'peer-join').length, 2)
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
    // Neither the garbage frame nor the events-before-join message landed —
    // the only thing in the room is the server's own peer-join for this
    // connection (see server.ts), authored regardless of what the joiner
    // uploaded.
    const events = server.roomLog('r', 'session')
    assert.equal(events.length, 1)
    assert.equal(events[0].kind, 'peer-join')
    assert.equal(events[0].client, 'x')
    ws.close()
  } finally {
    await server.close()
  }
})
