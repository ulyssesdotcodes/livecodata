// livecodata multiplayer server
// ----------------------------------------------------------------------------
// A room is nothing but named event logs — the same append-only primitive the
// client folds everything from — plus the sockets currently in it. The server
// never interprets events: it merges whatever clients bring (dedup by
// (src, seq), deterministic (seq, src) order via the shared mergeEvents), sends
// each joiner the union, and relays new events to everyone else. Rooms live in
// memory; clients re-upload their full logs on every join, so a restarted
// server heals from whoever connects next.
//
// Also serves the built app from public/ so a jam needs exactly one process:
//   npm run build && npm run serve   →   http://host:8787/?room=yourroom
//
// See src/multiplayer.ts for the message protocol.
// ----------------------------------------------------------------------------

import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { pathToFileURL } from 'node:url'
import { WebSocketServer, WebSocket, type RawData } from 'ws'
import { mergeEvents, type StampedEvent } from '../src/event-log.js'

interface Room {
  logs: Map<string, StampedEvent[]>
  clients: Set<WebSocket>
}

interface ClientMessage {
  type: string
  room?: string
  log?: string
  events?: StampedEvent[]
  logs?: Record<string, StampedEvent[]>
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
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
      room = { logs: new Map(), clients: new Set() }
      rooms.set(name, room)
    }
    return room
  }

  function sendTo(ws: WebSocket, msg: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  function broadcast(room: Room, msg: Record<string, unknown>, except?: WebSocket): void {
    for (const client of room.clients) if (client !== except) sendTo(client, msg)
  }

  // Merge incoming events into a room log; relay what was actually new to the
  // other clients. Returns the newly-added events.
  function ingest(room: Room, logName: string, incoming: StampedEvent[], from: WebSocket): StampedEvent[] {
    const existing = room.logs.get(logName) ?? []
    const { events, added } = mergeEvents(existing, incoming)
    if (added.length) {
      room.logs.set(logName, events)
      broadcast(room, { type: 'events', log: logName, events: added }, from)
    }
    return added
  }

  function handleMessage(ws: WebSocket, raw: RawData): void {
    let msg: ClientMessage
    try {
      msg = JSON.parse(String(raw)) as ClientMessage
    } catch {
      return
    }

    if (msg.type === 'join' && typeof msg.room === 'string' && msg.room) {
      leave(ws)
      const room = getRoom(msg.room)
      // Union the joiner's logs first, so peers get anything it authored
      // offline, then hand it the whole room.
      for (const [name, events] of Object.entries(msg.logs ?? {})) {
        if (Array.isArray(events)) ingest(room, name, events, ws)
      }
      room.clients.add(ws)
      memberships.set(ws, room)
      const logs: Record<string, StampedEvent[]> = {}
      for (const [name, events] of room.logs) logs[name] = events
      sendTo(ws, { type: 'sync', logs })
      broadcast(room, { type: 'peers', count: room.clients.size })
      return
    }

    const room = memberships.get(ws)
    if (!room) return
    if (msg.type === 'events' && typeof msg.log === 'string' && Array.isArray(msg.events)) {
      ingest(room, msg.log, msg.events, ws)
    }
  }

  function leave(ws: WebSocket): void {
    const room = memberships.get(ws)
    if (!room) return
    memberships.delete(ws)
    room.clients.delete(ws)
    broadcast(room, { type: 'peers', count: room.clients.size })
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

  const wss = new WebSocketServer({ server, path: '/ws' })
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
