// Tests for the transport-agnostic room state machine shared by the Node
// server and the Cloudflare Durable Object. Both adapters delegate all
// merge/relay/peer-event behavior here, so pinning it once covers both.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { StampedEvent } from '../src/event-log.js'
import { handleEvents, handleJoin, handleLeave, nextServerSeq, SESSION_LOG, ACTIVITY_TABLE, type RoomLogs } from '../src/room-core.js'
import { parseClientMessage } from '../src/protocol.js'

const ev = (seq: number, src: string, extra: Record<string, unknown> = {}): StampedEvent =>
  ({ seq, t: 0, kind: 'edit', src, ...extra })

test('join seeds an empty room, authors a peer-join, and syncs the union back', () => {
  const logs: RoomLogs = new Map()
  const result = handleJoin(logs, { type: 'join', client: 'alice', logs: { tables: [ev(0, 'a'), ev(1, 'a')] } }, 123)

  assert.equal(result.clientId, 'alice')
  assert.equal(result.changed, true)
  assert.equal(logs.get('tables')?.length, 2)

  const session = logs.get(SESSION_LOG) ?? []
  assert.equal(session.length, 1)
  assert.deepEqual(
    { kind: session[0].kind, src: session[0].src, table: session[0].table, client: session[0].client, t: session[0].t },
    { kind: 'peer-join', src: 'server', table: ACTIVITY_TABLE, client: 'alice', t: 123 },
  )

  // Outbound: the joiner's fresh events + peer-join to others, then a sync to
  // the sender carrying the whole room.
  const last = result.outbound[result.outbound.length - 1]
  assert.equal(last.to, 'sender')
  assert.equal(last.msg.type, 'sync')
  assert.ok(result.outbound.slice(0, -1).every((o) => o.to === 'others'))
  const syncLogs = last.msg.type === 'sync' ? last.msg.logs : {}
  assert.deepEqual(Object.keys(syncLogs).sort(), [SESSION_LOG, 'tables'])
})

test('a missing client id joins as anon', () => {
  const logs: RoomLogs = new Map()
  assert.equal(handleJoin(logs, { type: 'join' }).clientId, 'anon')
})

test('events merge, dedup by (src, seq), and only relay what was new', () => {
  const logs: RoomLogs = new Map()
  handleEvents(logs, { type: 'events', log: 'tables', events: [ev(0, 'a')] })

  // A duplicate plus one new event: only the new one relays or changes state.
  const result = handleEvents(logs, { type: 'events', log: 'tables', events: [ev(0, 'a'), ev(1, 'b')] })
  assert.equal(result.changed, true)
  assert.equal(result.outbound.length, 1)
  assert.equal(result.outbound[0].to, 'others')
  const relayed = result.outbound[0].msg.type === 'events' ? result.outbound[0].msg.events : []
  assert.deepEqual(relayed.map((e) => [e.seq, e.src]), [[1, 'b']])

  // A pure duplicate is a no-op: nothing to persist, nothing to relay.
  const dup = handleEvents(logs, { type: 'events', log: 'tables', events: [ev(0, 'a')] })
  assert.equal(dup.changed, false)
  assert.deepEqual(dup.outbound, [])
})

test('leave authors a peer-leave; an unjoined connection leaves silently', () => {
  const logs: RoomLogs = new Map()
  handleJoin(logs, { type: 'join', client: 'alice' })

  const result = handleLeave(logs, 'alice', 456)
  assert.equal(result.changed, true)
  const session = logs.get(SESSION_LOG) ?? []
  assert.deepEqual(session.map((e) => e.kind), ['peer-join', 'peer-leave'])

  const silent = handleLeave(logs, null)
  assert.equal(silent.changed, false)
  assert.deepEqual(silent.outbound, [])
})

test('server seq is derived from the logs, so a re-seeded room never mints colliding ids', () => {
  // Session 1: alice joins and leaves — the room authored server events 0..1.
  const logs: RoomLogs = new Map()
  handleJoin(logs, { type: 'join', client: 'alice' })
  handleLeave(logs, 'alice')
  const history = { [SESSION_LOG]: logs.get(SESSION_LOG) ?? [] }
  assert.equal(nextServerSeq(logs), 2)

  // The room is dropped (last client left / server restarted). Alice rejoins a
  // *fresh* room, re-uploading her history — which contains the old server
  // events. The new peer-join must not reuse (server, 0) or merge would
  // silently dedup it away.
  const fresh: RoomLogs = new Map()
  const rejoin = handleJoin(fresh, { type: 'join', client: 'alice', logs: history }, 789)
  assert.equal(rejoin.changed, true)
  const session = fresh.get(SESSION_LOG) ?? []
  assert.deepEqual(session.map((e) => e.kind), ['peer-join', 'peer-leave', 'peer-join'])
  const joins = session.filter((e) => e.kind === 'peer-join')
  assert.notEqual(joins[0].seq, joins[1].seq)
})

test('parseClientMessage drops garbage and unknown frames, validates shapes', () => {
  assert.equal(parseClientMessage('not json'), null)
  assert.equal(parseClientMessage('42'), null)
  assert.equal(parseClientMessage(JSON.stringify({ type: 'nonsense' })), null)
  assert.equal(parseClientMessage(JSON.stringify({ type: 'events', log: 'x' })), null)
  assert.equal(parseClientMessage(JSON.stringify({ type: 'events', log: 5, events: [] })), null)

  const join = parseClientMessage(JSON.stringify({ type: 'join', room: 'r', client: 'c', logs: { a: [], b: 'junk' } }))
  assert.deepEqual(join, { type: 'join', room: 'r', client: 'c', logs: { a: [] } })

  const events = parseClientMessage(JSON.stringify({ type: 'events', log: 'x', events: [{ seq: 0, t: 0, kind: 'k' }] }))
  assert.equal(events?.type, 'events')
})
