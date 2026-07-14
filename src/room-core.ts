// livecodata multiplayer room — the transport-agnostic state machine
// ----------------------------------------------------------------------------
// A room is nothing but named event logs — the same append-only primitive the
// client folds everything from. This module owns everything a room *does*,
// independent of which transport carries it: the Node server (server/server.ts)
// and the Cloudflare Durable Object (worker/room.ts) are thin adapters that
// hold sockets and deliver the Outbound messages these handlers return.
//
// The room never *interprets* table/apply events (it merges whatever clients
// bring — dedup by (src, seq), deterministic (seq, src) order via the shared
// mergeEvents — hands each joiner the union, and relays new events to everyone
// else), but it does *author* one kind itself: a peer-join/peer-leave event on
// the "session" log whenever a connection joins or drops, tagged src:"server"
// and table:"activity" (see editable-tables.ts's record() and main.ts) so peer
// presence is just more log the client folds, replacing what used to be a
// dedicated `{type:'peers'}` message.
//
// One exception to "merge whatever clients bring": when a connection joins a
// room that currently has *no other users*, its own session initializes the
// room rather than unioning onto it. A userless room's logs are stale leftovers
// from a past jam nobody is in (backends drop a room when its last socket
// leaves, but durable storage can outlive that), so the first person back in
// gets a clean room seeded from their local session — not a merge of their work
// with whatever the room happened to still hold. With peers already present the
// join unions as usual, folding solo work into the live jam. handleJoin takes
// `hasPeers` from the adapter (only it knows the live socket count) to tell the
// two cases apart.
//
// Handlers mutate the given logs map in place and report `changed` so durable
// backends know when to persist. They are otherwise pure: no sockets, no
// timers, no storage — which is what lets one test suite pin both backends.
// ----------------------------------------------------------------------------

import { mergeEvents, type StampedEvent } from './event-log.js'
import { eventsMessage, syncMessage, type EventsMessage, type JoinMessage, type ServerMessage } from './protocol.js'

// The log peer-connection events ride, and the pseudo-table (see
// editable-tables.ts's record()) they're tagged with within it.
export const SESSION_LOG = 'session'
export const ACTIVITY_TABLE = 'activity'

export type RoomLogs = Map<string, StampedEvent[]>

// A message the adapter must deliver, relative to the connection whose
// message (or disconnect) triggered the handler: 'sender' goes back to that
// connection, 'others' to every other open connection in the room.
export interface Outbound {
  to: 'sender' | 'others'
  msg: ServerMessage
}

export interface RoomResult {
  // The logs map was mutated — durable backends should persist it.
  changed: boolean
  outbound: Outbound[]
}

export interface JoinResult extends RoomResult {
  // The id the connection joined with (for its eventual peer-leave event).
  clientId: string
}

// Merge incoming events into a room log. Returns the newly-added events so
// callers can relay exactly what was new.
function ingest(logs: RoomLogs, name: string, incoming: StampedEvent[]): StampedEvent[] {
  const existing = logs.get(name) ?? []
  const { events, added } = mergeEvents(existing, incoming)
  if (added.length) logs.set(name, events)
  return added
}

// This room's own Lamport counter for server-authored events — a separate
// "replica" (src: "server") in the same (seq, src) order as everyone else.
// Derived from the logs rather than kept as a counter: rooms are dropped when
// empty and re-seeded from a rejoiner's history (which contains the *old*
// server events), so a fresh counter starting at 0 would mint (src, seq) keys
// that collide with old events and get silently deduped away.
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
  // Nobody else is here: this joiner *initializes* the room to its own session.
  // Any logs still present are stale leftovers (see the module comment), so drop
  // them before seeding rather than unioning the joiner's work onto them. No
  // relay needed — there are no peers to relay to.
  if (!hasPeers && logs.size) {
    logs.clear()
    changed = true
  }
  // Union the joiner's logs, so peers get anything it authored offline, then
  // hand it the whole room.
  for (const [name, events] of Object.entries(msg.logs ?? {})) {
    if (!Array.isArray(events)) continue
    const added = ingest(logs, name, events)
    if (added.length) {
      changed = true
      outbound.push({ to: 'others', msg: eventsMessage(name, added) })
    }
  }
  const clientId = typeof msg.client === 'string' && msg.client ? msg.client : 'anon'
  // Authored *after* merging the joiner's own logs (which — see main.ts —
  // always include the "activity" table's create event by this point) so this
  // peer-join always lands on a table that already exists. Not sent to the
  // joiner itself — the sync below already covers it.
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
