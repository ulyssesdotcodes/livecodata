// livecodata multiplayer room — Cloudflare Durable Object
// ----------------------------------------------------------------------------
// The Workers/Durable-Objects twin of server/server.ts: one Durable Object
// instance per room name (see worker/index.ts's idFromName(room)), built on
// the WebSocket Hibernation API so an idle room costs nothing between
// messages — the platform can drop the object from memory and still wake it
// when a message arrives on an attached socket. Room state (the named event
// logs) therefore lives in this.ctx.storage, not a JS closure — getLogs()
// lazily reloads it after a wake — and this.ctx.getWebSockets() (not a
// hand-kept Set) is how hibernation tracks which sockets are still attached.
//
// The object never *interprets* table/apply events (pure merge-and-relay,
// like server.ts), but it does author one kind itself: a peer-join/peer-leave
// event on the "session" log whenever a socket joins or drops, tagged
// src:"server" and table:"activity" (see editable-tables.ts's record() and
// main.ts) so peer presence is just more log the client folds, replacing what
// used to be a dedicated `{type:'peers'}` message. Each socket's client id is
// attached via serializeAttachment (ws.deserializeAttachment survives
// hibernation the same way this.ctx.storage does) so a peer-leave on wake
// still knows who left.
//
// Same wire protocol as the Node server; see src/multiplayer.ts for the
// client and the message shapes.
// ----------------------------------------------------------------------------

import { DurableObject } from 'cloudflare:workers'
import { mergeEvents, type StampedEvent } from '../src/event-log.js'

// The log peer-connection events ride, and the pseudo-table (see
// editable-tables.ts's record()) they're tagged with within it.
const SESSION_LOG = 'session'
const ACTIVITY_TABLE = 'activity'

interface ClientMessage {
  type: string
  room?: string
  client?: string
  log?: string
  events?: StampedEvent[]
  logs?: Record<string, StampedEvent[]>
}

interface SocketAttachment {
  client: string
}

const LOGS_KEY = 'logs'

export class Room extends DurableObject {
  private logs: Map<string, StampedEvent[]> | null = null

  // Lazily (re)load from durable storage — needed after a hibernation wake,
  // when this.logs has been reset by a fresh construction of the object.
  private async getLogs(): Promise<Map<string, StampedEvent[]>> {
    if (this.logs) return this.logs
    const stored = (await this.ctx.storage.get<Record<string, StampedEvent[]>>(LOGS_KEY)) ?? {}
    this.logs = new Map(Object.entries(stored))
    return this.logs
  }

  private async saveLogs(logs: Map<string, StampedEvent[]>): Promise<void> {
    await this.ctx.storage.put(LOGS_KEY, Object.fromEntries(logs))
  }

  // Sockets that survived hibernation but aren't actually open anymore
  // (mid-close) shouldn't get a send() or count toward peers.
  private openSockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN)
  }

  private send(ws: WebSocket, msg: Record<string, unknown>): void {
    try { ws.send(JSON.stringify(msg)) } catch { /* socket closing under us */ }
  }

  private broadcast(msg: Record<string, unknown>, except?: WebSocket): void {
    const payload = JSON.stringify(msg)
    for (const ws of this.openSockets()) {
      if (ws !== except) { try { ws.send(payload) } catch { /* ignore */ } }
    }
  }

  // Merge incoming events into the room log; relay what was actually new to
  // the other sockets. Returns the newly-added events (so callers can tell
  // whether a storage write is actually needed).
  private ingest(logs: Map<string, StampedEvent[]>, name: string, incoming: StampedEvent[], from?: WebSocket): StampedEvent[] {
    const existing = logs.get(name) ?? []
    const { events, added } = mergeEvents(existing, incoming)
    if (added.length) {
      logs.set(name, events)
      this.broadcast({ type: 'events', log: name, events: added }, from)
    }
    return added
  }

  // This room's own Lamport counter for server-authored events, derived from
  // storage rather than kept in a JS field — a hibernation wake gets a fresh
  // object instance, so anything not in this.ctx.storage (or a socket
  // attachment) wouldn't survive it.
  private nextServerSeq(logs: Map<string, StampedEvent[]>): number {
    let max = -1
    for (const events of logs.values()) {
      for (const e of events) if (e.src === 'server' && e.seq > max) max = e.seq
    }
    return max + 1
  }

  // `except` skips a redundant broadcast to a socket that's about to receive
  // this same event another way (the join handler's own subsequent `sync`).
  private async recordServerEvent(logs: Map<string, StampedEvent[]>, kind: string, payload: Record<string, unknown>, except?: WebSocket): Promise<void> {
    const event: StampedEvent = { seq: this.nextServerSeq(logs), t: Date.now(), kind, src: 'server', ...payload }
    if (this.ingest(logs, SESSION_LOG, [event], except).length) await this.saveLogs(logs)
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 })
    }
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    // Hibernatable: acceptWebSocket (not server.accept()) is what lets the
    // platform evict this object between messages and still deliver the next
    // one — the room's state is durable (see getLogs/saveLogs above), so
    // nothing is lost when that happens.
    this.ctx.acceptWebSocket(server)
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, raw: ArrayBuffer | string): Promise<void> {
    let msg: ClientMessage
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)) as ClientMessage
    } catch {
      return
    }

    if (msg.type === 'join') {
      // Union the joiner's logs first, so peers get anything it authored
      // offline, then hand it the whole room.
      const logs = await this.getLogs()
      let changed = false
      for (const [name, events] of Object.entries(msg.logs ?? {})) {
        if (Array.isArray(events)) changed = this.ingest(logs, name, events, ws).length > 0 || changed
      }
      const clientId = typeof msg.client === 'string' && msg.client ? msg.client : 'anon'
      ws.serializeAttachment({ client: clientId } satisfies SocketAttachment)
      // Authored *after* merging the joiner's own logs (which — see main.ts —
      // always include the "activity" table's create event by this point) so
      // this peer-join always lands on a table that already exists. Not
      // broadcast to the joiner itself — the sync below already covers it.
      await this.recordServerEvent(logs, 'peer-join', { table: ACTIVITY_TABLE, client: clientId }, ws)
      if (changed) await this.saveLogs(logs)
      const snapshot: Record<string, StampedEvent[]> = {}
      for (const [name, events] of logs) snapshot[name] = events
      this.send(ws, { type: 'sync', logs: snapshot })
      return
    }

    if (msg.type === 'events' && typeof msg.log === 'string' && Array.isArray(msg.events)) {
      const logs = await this.getLogs()
      if (this.ingest(logs, msg.log, msg.events, ws).length) await this.saveLogs(logs)
    }
  }

  private async recordLeave(ws: WebSocket): Promise<void> {
    const attachment = ws.deserializeAttachment() as SocketAttachment | null
    if (attachment?.client) {
      const logs = await this.getLogs()
      await this.recordServerEvent(logs, 'peer-leave', { table: ACTIVITY_TABLE, client: attachment.client })
    }
    // The last socket just left: drop the room's log entirely rather than
    // let it sit in durable storage for nobody. Each client already
    // persisted its own copy locally (see main.ts's sessionStore under the
    // room's session id), so whoever reconnects first re-seeds the object
    // from their own history — same as a fresh object healing from the next
    // joiner (see the module comment above).
    if (this.openSockets().length === 0) {
      this.logs = null
      await this.ctx.storage.delete(LOGS_KEY)
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean): Promise<void> {
    ws.close(code, reason)
    await this.recordLeave(ws)
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.recordLeave(ws)
  }
}
