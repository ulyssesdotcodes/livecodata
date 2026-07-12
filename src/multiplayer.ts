// livecodata multiplayer — event logs over WebSockets
// ----------------------------------------------------------------------------
// Because every piece of authored state (code runs, table edits) is already an
// append-only event log, multiplayer is just moving stamped events between
// replicas: a room on the server holds the union of everyone's logs, and each
// client merges what it hasn't seen. Nothing here knows what the events mean —
// including peer connections and Apply pulses, which ride the exact same
// named logs as regular table edits (see editable-tables.ts's record() and
// main.ts's "activity" table) rather than needing a protocol message of their
// own. Syncing is genuinely just "sync the log(s), replay on connection."
//
// The wire protocol (message shapes and parsing) is shared with both server
// backends — see src/protocol.ts.
//
// The join carries the client's full logs, so joining seeds an empty room,
// brings solo work into a jam, and heals any events missed while offline —
// merge() dedups, so re-sending is always safe. Local appends are published
// live via each log's onAppend hook; remote events arrive via merge(), which
// never fires onAppend, so nothing echoes.
//
// The room also rides along on the connection URL as ?room= (in addition to
// the join message): the Node server ignores it (its WebSocketServer path
// match only looks at the pathname), but a Cloudflare Worker backend (see
// worker/index.ts) has to pick which Durable Object to route the upgrade to
// *before* any message — including "join" — can be read off the socket.
// ----------------------------------------------------------------------------

import { localSource, type EventLog, type StampedEvent } from './event-log.js'
import { parseServerMessage, type ClientMessage } from './protocol.js'

export type MultiplayerStatus = 'connecting' | 'connected' | 'closed'

export interface MultiplayerOptions {
  url: string
  room: string
  // Named logs to sync, e.g. { session: log.events, tables: store.log }.
  logs: Record<string, EventLog>
  onStatus?: (status: MultiplayerStatus) => void
}

export interface MultiplayerConnection {
  readonly status: MultiplayerStatus
  close(): void
}

const RETRY_BASE_MS = 1000
const RETRY_MAX_MS = 15000

export function connectMultiplayer({ url, room, logs, onStatus }: MultiplayerOptions): MultiplayerConnection {
  let ws: WebSocket | null = null
  let status: MultiplayerStatus = 'connecting'
  let closed = false
  let retries = 0
  let retryTimer: ReturnType<typeof setTimeout> | null = null

  function setStatus(next: MultiplayerStatus): void {
    status = next
    onStatus?.(status)
  }

  function send(msg: ClientMessage): void {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  // Publish every locally-authored event as it lands. If the socket is down
  // the event just waits in the log; the next join re-sends everything.
  for (const [name, log] of Object.entries(logs)) {
    log.onAppend((e) => send({ type: 'events', log: name, events: [e] }))
  }

  function handleMessage(raw: unknown): void {
    const msg = parseServerMessage(raw)
    if (!msg) return
    if (msg.type === 'sync') {
      for (const [name, events] of Object.entries(msg.logs)) logs[name]?.merge(events)
    } else {
      logs[msg.log]?.merge(msg.events)
    }
  }

  function connect(): void {
    if (closed) return
    setStatus('connecting')
    const target = new URL(url)
    target.searchParams.set('room', room)
    ws = new WebSocket(target.toString())
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
      setStatus('connecting')
      const delay = Math.min(RETRY_BASE_MS * 2 ** retries++, RETRY_MAX_MS)
      retryTimer = setTimeout(connect, delay)
    }
    ws.onerror = () => ws?.close()
  }

  connect()

  return {
    get status() { return status },
    close(): void {
      if (closed) return
      closed = true
      if (retryTimer != null) clearTimeout(retryTimer)
      ws?.close()
      ws = null
      setStatus('closed')
    },
  }
}
