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
// Same wire protocol as the Node server; see src/multiplayer.ts for the
// client and the message shapes.
// ----------------------------------------------------------------------------

import { DurableObject } from 'cloudflare:workers'
import { mergeEvents, type StampedEvent } from '../src/event-log.js'

interface ClientMessage {
  type: string
  room?: string
  log?: string
  events?: StampedEvent[]
  logs?: Record<string, StampedEvent[]>
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

  private broadcastPeers(): void {
    this.broadcast({ type: 'peers', count: this.openSockets().length })
  }

  // Merge incoming events into the room log; relay what was actually new to
  // the other sockets. Returns whether anything was added (so callers only
  // pay for a storage write when the log actually changed).
  private ingest(logs: Map<string, StampedEvent[]>, name: string, incoming: StampedEvent[], from: WebSocket): boolean {
    const existing = logs.get(name) ?? []
    const { events, added } = mergeEvents(existing, incoming)
    if (added.length) {
      logs.set(name, events)
      this.broadcast({ type: 'events', log: name, events: added }, from)
    }
    return added.length > 0
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
        if (Array.isArray(events)) changed = this.ingest(logs, name, events, ws) || changed
      }
      if (changed) await this.saveLogs(logs)
      const snapshot: Record<string, StampedEvent[]> = {}
      for (const [name, events] of logs) snapshot[name] = events
      this.send(ws, { type: 'sync', logs: snapshot })
      this.broadcastPeers()
      return
    }

    if (msg.type === 'events' && typeof msg.log === 'string' && Array.isArray(msg.events)) {
      const logs = await this.getLogs()
      if (this.ingest(logs, msg.log, msg.events, ws)) await this.saveLogs(logs)
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean): Promise<void> {
    ws.close(code, reason)
    this.broadcastPeers()
  }

  async webSocketError(_ws: WebSocket): Promise<void> {
    this.broadcastPeers()
  }
}
