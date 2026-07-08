// livecodata multiplayer server
// ----------------------------------------------------------------------------
// A room is nothing but named event logs — the same append-only primitive the
// client folds everything from — plus the sockets currently in it. The server
// never *interprets* table/apply events (it merges whatever clients bring —
// dedup by (src, seq), deterministic (seq, src) order via the shared
// mergeEvents — sends each joiner the union, and relays new events to
// everyone else), but it does *author* one kind itself: a peer-join/peer-leave
// event on the "session" log whenever a socket joins or drops, tagged
// src:"server" and table:"activity" (see editable-tables.ts's record() and
// main.ts) so peer presence is just more log the client folds, replacing what
// used to be a dedicated `{type:'peers'}` message. Rooms live in memory;
// clients re-upload their full logs on every join, so a restarted server
// heals from whoever connects next.
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

// The log peer-connection events ride, and the pseudo-table (see
// editable-tables.ts's record()) they're tagged with within it.
const SESSION_LOG = 'session'
const ACTIVITY_TABLE = 'activity'

interface Room {
  name: string
  logs: Map<string, StampedEvent[]>
  // socket → the client id it joined with (for its eventual peer-leave event).
  clients: Map<WebSocket, string>
  // This room's own Lamport counter for server-authored events — a separate
  // "replica" (src: "server") in the same (seq, src) order as everyone else.
  serverSeq: number
}

interface ClientMessage {
  type: string
  room?: string
  client?: string
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
      room = { name, logs: new Map(), clients: new Map(), serverSeq: 0 }
      rooms.set(name, room)
    }
    return room
  }

  function sendTo(ws: WebSocket, msg: Record<string, unknown>): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  function broadcast(room: Room, msg: Record<string, unknown>, except?: WebSocket): void {
    for (const client of room.clients.keys()) if (client !== except) sendTo(client, msg)
  }

  // Merge incoming events into a room log; relay what was actually new to the
  // other clients. Returns the newly-added events.
  function ingest(room: Room, logName: string, incoming: StampedEvent[], from?: WebSocket): StampedEvent[] {
    const existing = room.logs.get(logName) ?? []
    const { events, added } = mergeEvents(existing, incoming)
    if (added.length) {
      room.logs.set(logName, events)
      broadcast(room, { type: 'events', log: logName, events: added }, from)
    }
    return added
  }

  // A server-authored event: this room's own (seq, src:"server") stream,
  // ingested through the exact same merge/broadcast path as a client's —
  // peer presence is just more log, not a side channel. `except` skips a
  // redundant broadcast to a socket that's about to receive this same event
  // another way (the join handler's own subsequent `sync`).
  function recordServerEvent(room: Room, logName: string, kind: string, payload: Record<string, unknown>, except?: WebSocket): void {
    const event: StampedEvent = { seq: room.serverSeq++, t: Date.now(), kind, src: 'server', ...payload }
    ingest(room, logName, [event], except)
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
      const clientId = typeof msg.client === 'string' && msg.client ? msg.client : 'anon'
      room.clients.set(ws, clientId)
      memberships.set(ws, room)
      // Authored *after* merging the joiner's own logs (which — see main.ts —
      // always include the "activity" table's create event by this point) so
      // this peer-join always lands on a table that already exists. Not
      // broadcast to the joiner itself — the sync below already covers it.
      recordServerEvent(room, SESSION_LOG, 'peer-join', { table: ACTIVITY_TABLE, client: clientId }, ws)
      const logs: Record<string, StampedEvent[]> = {}
      for (const [name, events] of room.logs) logs[name] = events
      sendTo(ws, { type: 'sync', logs })
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
    const clientId = room.clients.get(ws)
    room.clients.delete(ws)
    if (clientId) recordServerEvent(room, SESSION_LOG, 'peer-leave', { table: ACTIVITY_TABLE, client: clientId })
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
