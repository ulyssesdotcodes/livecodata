// livecodata multiplayer — event logs over WebSockets
// ----------------------------------------------------------------------------
// Because every piece of authored state (code runs, table edits) is already an
// append-only event log, multiplayer is just moving stamped events between
// replicas: a room on the server holds the union of everyone's logs, and each
// client merges what it hasn't seen. Nothing here knows what the events mean.
//
// Protocol (JSON text frames):
//   client → server  { type: 'join', room, client, logs: { name: events[] } }
//   client → server  { type: 'events', log, events }   one local append
//   server → client  { type: 'sync', logs: { name: events[] } }  room union
//   server → client  { type: 'events', log, events }   relayed from a peer
//   server → client  { type: 'peers', count }
//
// The join carries the client's full logs, so joining seeds an empty room,
// brings solo work into a jam, and heals any events missed while offline —
// merge() dedups, so re-sending is always safe. Local appends are published
// live via each log's onAppend hook; remote events arrive via merge(), which
// never fires onAppend, so nothing echoes.
// ----------------------------------------------------------------------------

import { localSource, type EventLog, type StampedEvent } from './event-log.js'

export type MultiplayerStatus = 'connecting' | 'connected' | 'closed'

export interface MultiplayerOptions {
  url: string
  room: string
  // Named logs to sync, e.g. { session: log.events, tables: store.log }.
  logs: Record<string, EventLog>
  onStatus?: (status: MultiplayerStatus, peers: number) => void
}

export interface MultiplayerConnection {
  readonly status: MultiplayerStatus
  readonly peers: number
  close(): void
}

interface ServerMessage {
  type: string
  log?: string
  events?: StampedEvent[]
  logs?: Record<string, StampedEvent[]>
  count?: number
}

const RETRY_BASE_MS = 1000
const RETRY_MAX_MS = 15000

export function connectMultiplayer({ url, room, logs, onStatus }: MultiplayerOptions): MultiplayerConnection {
  let ws: WebSocket | null = null
  let status: MultiplayerStatus = 'connecting'
  let peers = 0
  let closed = false
  let retries = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null

  function setStatus(next: MultiplayerStatus, count = peers): void {
    status = next
    peers = count
    onStatus?.(status, peers)
  }

  function send(msg: Record<string, unknown>): void {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  // Publish every locally-authored event as it lands. If the socket is down
  // the event just waits in the log; the next join re-sends everything.
  for (const [name, log] of Object.entries(logs)) {
    log.onAppend((e) => send({ type: 'events', log: name, events: [e] }))
  }

  function handleMessage(raw: unknown): void {
    let msg: ServerMessage
    try {
      msg = JSON.parse(String(raw)) as ServerMessage
    } catch {
      return
    }
    if (msg.type === 'sync' && msg.logs) {
      for (const [name, events] of Object.entries(msg.logs)) {
        if (Array.isArray(events)) logs[name]?.merge(events)
      }
    } else if (msg.type === 'events' && msg.log && Array.isArray(msg.events)) {
      logs[msg.log]?.merge(msg.events)
    } else if (msg.type === 'peers' && typeof msg.count === 'number') {
      setStatus(status, msg.count)
    }
  }

  function connect(): void {
    if (closed) return
    setStatus('connecting')
    ws = new WebSocket(url)
    ws.onopen = () => {
      retries = 0
      const snapshot: Record<string, StampedEvent[]> = {}
      for (const [name, log] of Object.entries(logs)) snapshot[name] = log.all()
      send({ type: 'join', room, client: localSource(), logs: snapshot })
      setStatus('connected')
    }
    ws.onmessage = (ev) => handleMessage(ev.data)
    ws.onclose = () => {
      ws = null
      if (closed) return
      setStatus('connecting', 0)
      const delay = Math.min(RETRY_BASE_MS * 2 ** retries++, RETRY_MAX_MS)
      retryTimer = setTimeout(connect, delay)
    }
    ws.onerror = () => ws?.close()
  }

  connect()

  return {
    get status() { return status },
    get peers() { return peers },
    close(): void {
      if (closed) return
      closed = true
      if (retryTimer != null) clearTimeout(retryTimer)
      ws?.close()
      ws = null
      setStatus('closed', 0)
    },
  }
}
