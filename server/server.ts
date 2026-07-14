// livecodata multiplayer server — Node adapter
// ----------------------------------------------------------------------------
// All room behavior (merge, relay, peer-join/leave authoring) lives in the
// transport-agnostic src/room-core.ts, shared with the Cloudflare Durable
// Object twin (worker/room.ts). This file only owns what is Node-specific:
// the ws sockets, which room each socket joined, and serving the built app
// from public/ so a jam needs exactly one process:
//   npm run build && npm run serve   →   http://host:8787/?room=yourroom
//
// Rooms live in memory; clients re-upload their full logs on every join, so a
// restarted server heals from whoever connects next.
//
// See src/protocol.ts for the message shapes and src/multiplayer.ts for the
// client.
// ----------------------------------------------------------------------------

import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { pathToFileURL } from 'node:url'
import { WebSocketServer, WebSocket, type RawData } from 'ws'
import type { StampedEvent } from '../src/event-log.js'
import { parseClientMessage, type ServerMessage } from '../src/protocol.js'
import { handleEvents, handleJoin, handleLeave, type Outbound, type RoomLogs } from '../src/room-core.js'

interface Room {
  name: string
  logs: RoomLogs
  // socket → the client id it joined with (for its eventual peer-leave event).
  clients: Map<WebSocket, string>
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
}

export interface MultiplayerServer {
  port: number
  close(): Promise<void>
  // Test/inspection access to a room's merged log.
  roomLog(room: string, log: string): StampedEvent[]
}

export function startMultiplayerServer(
  { port = 8787, root = 'public' }: { port?: number; root?: string } = {},
): Promise<MultiplayerServer> {
  const rooms = new Map<string, Room>()
  // socket → the room it joined (set by its join message).
  const memberships = new Map<WebSocket, Room>()

  function getRoom(name: string): Room {
    let room = rooms.get(name)
    if (!room) {
      room = { name, logs: new Map(), clients: new Map() }
      rooms.set(name, room)
    }
    return room
  }

  function sendTo(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  function broadcast(room: Room, msg: ServerMessage, except?: WebSocket): void {
    for (const client of room.clients.keys()) if (client !== except) sendTo(client, msg)
  }

  function deliver(room: Room, sender: WebSocket, outbound: Outbound[]): void {
    for (const o of outbound) {
      if (o.to === 'sender') sendTo(sender, o.msg)
      else broadcast(room, o.msg, sender)
    }
  }

  function handleMessage(ws: WebSocket, raw: RawData): void {
    const msg = parseClientMessage(raw)
    if (!msg) return

    if (msg.type === 'join' && typeof msg.room === 'string' && msg.room) {
      leave(ws)
      const room = getRoom(msg.room)
      // room.clients is the live membership (this socket isn't added until
      // below), so an empty map means the joiner is the only one here — its
      // session initializes the room rather than merging onto stale logs.
      const result = handleJoin(room.logs, msg, undefined, room.clients.size > 0)
      room.clients.set(ws, result.clientId)
      memberships.set(ws, room)
      deliver(room, ws, result.outbound)
      return
    }

    const room = memberships.get(ws)
    if (!room) return
    if (msg.type === 'events') {
      deliver(room, ws, handleEvents(room.logs, msg).outbound)
    }
  }

  function leave(ws: WebSocket): void {
    const room = memberships.get(ws)
    if (!room) return
    memberships.delete(ws)
    const clientId = room.clients.get(ws) ?? null
    room.clients.delete(ws)
    deliver(room, ws, handleLeave(room.logs, clientId).outbound)
    // The last client just left: drop the room's log entirely rather than
    // let it sit in memory for nobody. Each client already persisted its own
    // copy locally (see main.ts's sessionStore under the room's session id),
    // so whoever reconnects first re-seeds the room from their own history —
    // same as a server restart healing from the next joiner (see the module
    // comment above).
    if (room.clients.size === 0) rooms.delete(room.name)
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const rel = normalize(url.pathname).replace(/^([/\\]|\.\.)+/, '')
      const path = join(root, rel === '' || rel === '.' ? 'index.html' : rel)
      try {
        const body = await readFile(path)
        res.writeHead(200, { 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream' })
        res.end(body)
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain' })
        res.end('not found')
      }
    })()
  })

  // permessage-deflate: the wire is JSON text dominated by repeated strings
  // (program text in code rows and live-code presence, event field names), so
  // deflate — with cross-message context takeover for clients that allow it —
  // cuts frames by several ×. Browsers negotiate it automatically; a client
  // that doesn't offer the extension just gets uncompressed frames. The cost
  // is a per-connection zlib context (~100s of KB), fine at jam-room scale.
  // (The Cloudflare backend can't opt in — the platform owns the handshake.)
  const wss = new WebSocketServer({ server, path: '/ws', perMessageDeflate: true })
  wss.on('connection', (ws) => {
    ws.on('message', (raw) => handleMessage(ws, raw))
    ws.on('close', () => leave(ws))
    ws.on('error', () => ws.close())
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, "0.0.0.0", () => {
      const address = server.address()
      const boundPort = typeof address === 'object' && address ? address.port : port
      resolve({
        port: boundPort,
        roomLog: (room, log) => rooms.get(room)?.logs.get(log)?.slice() ?? [],
        close: () => new Promise<void>((done) => {
          for (const ws of wss.clients) ws.terminate()
          wss.close(() => server.close(() => done()))
        }),
      })
    })
  })
}

const isMain = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const port = Number(process.env.PORT) || 8787
  void startMultiplayerServer({ port }).then((s) => {
    console.log(`livecodata multiplayer on http://localhost:${s.port} (ws at /ws)`)
    console.log(`open http://localhost:${s.port}/?room=<name> in two browsers to jam`)
  })
}
