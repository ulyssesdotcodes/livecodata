// Transport-agnostic multiplayer room: named event logs plus handlers that
// mutate the logs map in place and report `changed` so durable backends know
// when to persist. The Node server (server/server.ts) and the Cloudflare
// Durable Object (worker/room.ts) are thin adapters holding sockets and
// delivering the Outbound messages; the handlers are otherwise pure (no
// sockets, timers, or storage), which lets one test suite pin both backends.
// The room never interprets events, but it does author peer-join/peer-leave
// events itself, so peer presence is just more log the client folds.

import { compactLatestPerSrcKind, eventKey, mergeEvents, type StampedEvent } from './event-log.js'
import { eventsMessage, syncMessage, type EventsMessage, type JoinMessage, type ServerMessage } from './protocol.js'

// The log peer-connection events ride, and the pseudo-table they're tagged with.
export const SESSION_LOG = 'session'
export const ACTIVITY_TABLE = 'activity'

// The one log the room compacts rather than keeping whole: presence folds
// latest-per-(src, kind) on every client (see presence.ts), so keeping history
// would grow per keystroke and bloat every join sync.
export const PRESENCE_LOG = 'presence'

export type RoomLogs = Map<string, StampedEvent[]>

// A message the adapter must deliver; `to` is relative to the connection
// whose message (or disconnect) triggered the handler.
export interface Outbound {
  to: 'sender' | 'others'
  msg: ServerMessage
}

export interface RoomResult {
  changed: boolean
  outbound: Outbound[]
}

export interface JoinResult extends RoomResult {
  // The id the connection joined with, for its eventual peer-leave event.
  clientId: string
}

// Merge incoming events into a room log, returning the newly-added events so
// callers relay exactly what was new. The presence log is compacted on both
// sides of the merge: superseded announcements neither persist nor relay, and
// losing their dedup memory is safe because re-deliveries compact away again.
function ingest(logs: RoomLogs, name: string, incoming: StampedEvent[]): StampedEvent[] {
  const compacting = name === PRESENCE_LOG
  const existing = logs.get(name) ?? []
  const { events, added } = mergeEvents(existing, compacting ? compactLatestPerSrcKind(incoming) : incoming)
  if (!added.length) return added
  if (!compacting) {
    logs.set(name, events)
    return added
  }
  const stored = compactLatestPerSrcKind(events)
  const kept = new Set(stored.map(eventKey))
  const fresh = added.filter((e) => kept.has(eventKey(e)))
  // Everything new was already superseded — nothing to persist or relay.
  if (fresh.length) logs.set(name, stored)
  return fresh
}

// The Lamport counter for server-authored (src: "server") events, derived
// from the logs rather than kept as a counter: a room re-seeded from a
// rejoiner's history contains the *old* server events, and a fresh counter
// starting at 0 would mint colliding (src, seq) keys that get silently deduped.
export function nextServerSeq(logs: RoomLogs): number {
  let max = -1
  for (const events of logs.values()) {
    for (const e of events) if (e.src === 'server' && e.seq > max) max = e.seq
  }
  return max + 1
}

function recordServerEvent(logs: RoomLogs, kind: string, clientId: string, now: number): StampedEvent[] {
  const event: StampedEvent = {
    seq: nextServerSeq(logs),
    t: now,
    kind,
    src: 'server',
    table: ACTIVITY_TABLE,
    client: clientId,
  }
  return ingest(logs, SESSION_LOG, [event])
}

export function handleJoin(logs: RoomLogs, msg: JoinMessage, now: number = Date.now(), hasPeers = true): JoinResult {
  const outbound: Outbound[] = []
  let changed = false
  // Nobody else here: the joiner *initializes* the room. Any logs still
  // present are stale leftovers from a past jam (durable storage can outlive
  // the last socket), so drop them rather than union the joiner's work onto them.
  if (!hasPeers && logs.size) {
    logs.clear()
    changed = true
  }
  for (const [name, events] of Object.entries(msg.logs ?? {})) {
    if (!Array.isArray(events)) continue
    const added = ingest(logs, name, events)
    if (added.length) {
      changed = true
      outbound.push({ to: 'others', msg: eventsMessage(name, added) })
    }
  }
  const clientId = typeof msg.client === 'string' && msg.client ? msg.client : 'anon'
  // Authored *after* merging the joiner's own logs so the peer-join lands on
  // an "activity" table that already exists. Not sent to the joiner itself —
  // the sync below covers it.
  const added = recordServerEvent(logs, 'peer-join', clientId, now)
  if (added.length) {
    changed = true
    outbound.push({ to: 'others', msg: eventsMessage(SESSION_LOG, added) })
  }
  outbound.push({ to: 'sender', msg: syncMessage(logs) })
  return { clientId, changed, outbound }
}

export function handleEvents(logs: RoomLogs, msg: EventsMessage): RoomResult {
  const added = ingest(logs, msg.log, msg.events)
  if (!added.length) return { changed: false, outbound: [] }
  return { changed: true, outbound: [{ to: 'others', msg: eventsMessage(msg.log, added) }] }
}

export function handleLeave(logs: RoomLogs, clientId: string | null, now: number = Date.now()): RoomResult {
  if (!clientId) return { changed: false, outbound: [] }
  const added = recordServerEvent(logs, 'peer-leave', clientId, now)
  if (!added.length) return { changed: false, outbound: [] }
  return { changed: true, outbound: [{ to: 'others', msg: eventsMessage(SESSION_LOG, added) }] }
}

// Route each outbound message to the sender or the rest of the room; shared by
// both adapters, which differ only in their send/broadcast primitives.
export function deliverOutbound(
  outbound: Outbound[],
  sendToSender: (msg: ServerMessage) => void,
  broadcastToOthers: (msg: ServerMessage) => void,
): void {
  for (const o of outbound) {
    if (o.to === 'sender') sendToSender(o.msg)
    else broadcastToOthers(o.msg)
  }
}
