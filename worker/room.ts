// livecodata multiplayer room — Cloudflare Durable Object adapter
// ----------------------------------------------------------------------------
// The Workers/Durable-Objects twin of server/server.ts: one Durable Object
// instance per room name (see worker/index.ts's idFromName(room)). All room
// behavior (merge, relay, peer-join/leave authoring) lives in the shared
// src/room-core.ts; this file only owns what is platform-specific.
//
// Built on the WebSocket Hibernation API so an idle room costs nothing
// between messages — the platform can drop the object from memory and still
// wake it when a message arrives on an attached socket. Room state (the named
// event logs) therefore lives in this.ctx.storage, not a JS closure —
// getLogs() lazily reloads it after a wake — and this.ctx.getWebSockets()
// (not a hand-kept Set) is how hibernation tracks which sockets are still
// attached. Each socket's client id is attached via serializeAttachment
// (ws.deserializeAttachment survives hibernation the same way this.ctx.storage
// does) so a peer-leave on wake still knows who left — and the attachment
// doubles as the "has this socket joined?" gate for event frames.
//
// Same wire protocol as the Node server; see src/protocol.ts for the message
// shapes and src/multiplayer.ts for the client.
// ----------------------------------------------------------------------------

import { DurableObject } from 'cloudflare:workers'
import type { StampedEvent } from '../src/event-log.js'
import { parseClientMessage, type ServerMessage } from '../src/protocol.js'
import { handleEvents, handleJoin, handleLeave, type Outbound, type RoomLogs } from '../src/room-core.js'

interface SocketAttachment {
  client: string
}

const LOGS_KEY = 'logs'

export class Room extends DurableObject {
  private logs: RoomLogs | null = null

  // Lazily (re)load from durable storage — needed after a hibernation wake,
  // when this.logs has been reset by a fresh construction of the object.
  private async getLogs(): Promise<RoomLogs> {
    if (this.logs) return this.logs
    const stored = (await this.ctx.storage.get<Record<string, StampedEvent[]>>(LOGS_KEY)) ?? {}
    this.logs = new Map(Object.entries(stored))
    return this.logs
  }

  private async saveLogs(logs: RoomLogs): Promise<void> {
    await this.ctx.storage.put(LOGS_KEY, Object.fromEntries(logs))
  }

  // Sockets that survived hibernation but aren't actually open anymore
  // (mid-close) shouldn't get a send() or count toward peers.
  private openSockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN)
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    try { ws.send(JSON.stringify(msg)) } catch { /* socket closing under us */ }
  }

  private broadcast(msg: ServerMessage, except?: WebSocket): void {
    const payload = JSON.stringify(msg)
    for (const ws of this.openSockets()) {
      if (ws !== except) { try { ws.send(payload) } catch { /* ignore */ } }
    }
  }

  private deliver(sender: WebSocket, outbound: Outbound[]): void {
    for (const o of outbound) {
      if (o.to === 'sender') this.send(sender, o.msg)
      else this.broadcast(o.msg, sender)
    }
  }

  private joinedClient(ws: WebSocket): string | null {
    const attachment = ws.deserializeAttachment() as SocketAttachment | null | undefined
    return attachment?.client ?? null
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
    const msg = parseClientMessage(typeof raw === 'string' ? raw : new TextDecoder().decode(raw))
    if (!msg) return

    if (msg.type === 'join') {
      const logs = await this.getLogs()
      const result = handleJoin(logs, msg)
      ws.serializeAttachment({ client: result.clientId } satisfies SocketAttachment)
      if (result.changed) await this.saveLogs(logs)
      this.deliver(ws, result.outbound)
      return
    }

    // Events from a socket that never joined are dropped, matching the Node
    // server's membership gate.
    if (msg.type === 'events' && this.joinedClient(ws) !== null) {
      const logs = await this.getLogs()
      const result = handleEvents(logs, msg)
      if (result.changed) await this.saveLogs(logs)
      this.deliver(ws, result.outbound)
    }
  }

  private async recordLeave(ws: WebSocket): Promise<void> {
    const clientId = this.joinedClient(ws)
    if (clientId) {
      const logs = await this.getLogs()
      const result = handleLeave(logs, clientId)
      if (result.changed) await this.saveLogs(logs)
      this.deliver(ws, result.outbound)
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
