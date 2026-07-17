// Tests for the transport-agnostic room state machine shared by the Node
// server and the Cloudflare Durable Object. Both adapters delegate all
// merge/relay/peer-event behavior here, so pinning it once covers both.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { StampedEvent } from '../src/event-log.js'
import { handleEvents, handleJoin, handleLeave, nextServerSeq, SESSION_LOG, ACTIVITY_TABLE, PRESENCE_LOG, type RoomLogs } from '../src/room-core.js'
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

test('joining a userless room initializes it to the joiner session, dropping stale logs', () => {
  // A room left holding stale logs from a past jam that nobody is in now.
  const logs: RoomLogs = new Map([
    ['tables', [ev(0, 'old'), ev(1, 'old')]],
    [SESSION_LOG, [ev(0, 'server', { kind: 'peer-join', src: 'server', table: ACTIVITY_TABLE, client: 'ghost' })]],
  ])

  // hasPeers=false: the joiner is alone, so its session replaces the leftovers.
  const result = handleJoin(logs, { type: 'join', client: 'alice', logs: { tables: [ev(0, 'a')] } }, 123, false)

  assert.equal(result.changed, true)
  assert.deepEqual(logs.get('tables')?.map((e) => e.src), ['a'])
  const session = logs.get(SESSION_LOG) ?? []
  assert.deepEqual(session.map((e) => e.client), ['alice'])
  // Nothing to relay — there are no peers — but the sender still gets a sync.
  assert.ok(result.outbound.every((o) => o.to === 'sender' || o.msg.type !== 'sync'))
  const last = result.outbound[result.outbound.length - 1]
  assert.equal(last.to, 'sender')
  assert.equal(last.msg.type, 'sync')
})

test('joining a room that already has peers unions the joiner logs in', () => {
  // hasPeers=true: alice's join merges rather than replacing.
  const logs: RoomLogs = new Map([['tables', [ev(0, 'bob')]]])

  const result = handleJoin(logs, { type: 'join', client: 'alice', logs: { tables: [ev(1, 'alice')] } }, 123, true)

  assert.equal(result.changed, true)
  assert.deepEqual(logs.get('tables')?.map((e) => e.src), ['bob', 'alice'])
  assert.ok(result.outbound.some((o) => o.to === 'others' && o.msg.type === 'events'))
})

test('events merge, dedup by (src, seq), and only relay what was new', () => {
  const logs: RoomLogs = new Map()
  handleEvents(logs, { type: 'events', log: 'tables', events: [ev(0, 'a')] })

  const result = handleEvents(logs, { type: 'events', log: 'tables', events: [ev(0, 'a'), ev(1, 'b')] })
  assert.equal(result.changed, true)
  assert.equal(result.outbound.length, 1)
  assert.equal(result.outbound[0].to, 'others')
  const relayed = result.outbound[0].msg.type === 'events' ? result.outbound[0].msg.events : []
  assert.deepEqual(relayed.map((e) => [e.seq, e.src]), [[1, 'b']])

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

test('the presence log compacts to the latest event per (src, kind) and relays only survivors', () => {
  const logs: RoomLogs = new Map()

  handleEvents(logs, { type: 'events', log: PRESENCE_LOG, events: [ev(0, 'a', { kind: 'presence', head: 1 })] })
  const next = handleEvents(logs, { type: 'events', log: PRESENCE_LOG, events: [ev(1, 'a', { kind: 'presence', head: 2 })] })
  assert.equal(next.changed, true)
  assert.deepEqual(logs.get(PRESENCE_LOG)!.map((e) => e.seq), [1])

  // Distinct kinds and srcs coexist: a live-code buffer doesn't evict cursors.
  handleEvents(logs, { type: 'events', log: PRESENCE_LOG, events: [ev(2, 'a', { kind: 'live-code', code: 'x' })] })
  handleEvents(logs, { type: 'events', log: PRESENCE_LOG, events: [ev(3, 'b', { kind: 'presence', head: 9 })] })
  assert.deepEqual(logs.get(PRESENCE_LOG)!.map((e) => [e.src, e.kind]), [['a', 'presence'], ['a', 'live-code'], ['b', 'presence']])

  // A stale announcement (e.g. a rejoiner re-uploading history) neither
  // persists nor relays — the compacted log is unchanged.
  const stale = handleEvents(logs, { type: 'events', log: PRESENCE_LOG, events: [ev(0, 'a', { kind: 'presence', head: 1 })] })
  assert.equal(stale.changed, false)
  assert.deepEqual(stale.outbound, [])
  assert.equal(logs.get(PRESENCE_LOG)!.length, 3)

  // Other logs are never compacted — their folds replay history.
  handleEvents(logs, { type: 'events', log: 'tables', events: [ev(0, 'a', { kind: 'presence' }), ev(1, 'a', { kind: 'presence' })] })
  assert.equal(logs.get('tables')!.length, 2)
})

test('a join uploading a full presence history stores and relays only the latest announcements', () => {
  const logs: RoomLogs = new Map([[PRESENCE_LOG, [ev(5, 'b', { kind: 'presence', head: 3 })]]])
  const history = Array.from({ length: 10 }, (_, i) => ev(i, 'a', { kind: 'presence', head: i }))

  const result = handleJoin(logs, { type: 'join', client: 'alice', logs: { [PRESENCE_LOG]: history } }, 123, true)
  assert.equal(result.changed, true)
  // Stored: b's announcement + only a's newest.
  assert.deepEqual(logs.get(PRESENCE_LOG)!.map((e) => [e.src, e.seq]), [['b', 5], ['a', 9]])
  const relayed = result.outbound.find((o) => o.to === 'others' && o.msg.type === 'events' && o.msg.log === PRESENCE_LOG)
  assert.ok(relayed && relayed.msg.type === 'events')
  assert.deepEqual(relayed.msg.events.map((e) => e.seq), [9])
})
