// Ephemeral presence: what each replica is viewing/typing, folded latest-wins
// per replica. It rides its own named event log — deliberately NOT the
// editable-table store's log, so high-frequency cursor moves never persist
// into sessions or the scrubbable run history — and dies with the room.
// Who's *online* is decided elsewhere (main.ts's onlinePeers).

import { compactLatestPerSrcKind, createEventLog, localSource, type EventLog, type StampedEvent } from './event-log.js'

export interface PresenceInfo {
  client: string
  user: string
  table: string | null
  // The cell the editor points at (e.g. "code[0].code" — see editor.ts's cell
  // labels); `head` is the cursor offset there.
  cell: string | null
  head: number
}

// A replica's in-progress editor buffer, announced live so peers can watch
// code appear before it's Run. Purely display-side — nothing cooks off it.
export interface LiveCode {
  client: string
  cell: string
  code: string
  seq: number
}

export interface PresenceChannel {
  readonly log: EventLog
  // Throttled; no-op if nothing changed.
  set(partial: Partial<Omit<PresenceInfo, 'client'>>): void
  // Throttled; no-op if unchanged. Rides its own event kind so cursor moves
  // stay tiny and the buffer is only re-sent when it changed.
  setLiveCode(cell: string, code: string): void
  // Latest state per replica id, including the local one — callers filter.
  peers(): Map<string, PresenceInfo>
  liveCodes(): Map<string, LiveCode>
  // Fires only when a *remote* announcement lands.
  onChange(cb: () => void): void
}

// Trailing-edge throttle: the first change publishes immediately; changes
// landing inside the window coalesce into one announcement at its end.
function throttled(publish: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let dirty = false
  return function schedule(): void {
    if (timer) { dirty = true; return }
    publish()
    timer = setTimeout(() => {
      timer = null
      if (dirty) { dirty = false; schedule() }
    }, ms)
  }
}

export function createPresenceChannel(
  { user = '', src = localSource(), throttleMs = 150 }: { user?: string; src?: string; throttleMs?: number } = {},
): PresenceChannel {
  // Compacted: the folds below are latest-wins, so pruning superseded events
  // keeps the log — and the join upload / room copy (see room-core.ts's
  // PRESENCE_LOG) — bounded at O(replicas × kinds).
  const log = createEventLog({ src, compact: compactLatestPerSrcKind })
  const local: PresenceInfo = { client: src, user, table: null, cell: null, head: 0 }
  const localLive = { cell: null as string | null, code: null as string | null }
  // Newest seq wins per replica — a join sync can replay old announcements
  // out of order.
  const states = new Map<string, { seq: number; info: PresenceInfo }>()
  const liveStates = new Map<string, LiveCode>()
  const listeners: (() => void)[] = []

  function ingest(e: StampedEvent): boolean {
    if (typeof e.src !== 'string' || !e.src) return false
    if (e.kind === 'presence') {
      const cur = states.get(e.src)
      if (cur && cur.seq >= e.seq) return false
      states.set(e.src, {
        seq: e.seq,
        info: {
          client: e.src,
          user: typeof e.user === 'string' ? e.user : '',
          table: typeof e.table === 'string' ? e.table : null,
          cell: typeof e.cell === 'string' ? e.cell : null,
          head: typeof e.head === 'number' ? e.head : 0,
        },
      })
      return true
    }
    if (e.kind === 'live-code') {
      if (typeof e.cell !== 'string' || typeof e.code !== 'string') return false
      const cur = liveStates.get(e.src)
      if (cur && cur.seq >= e.seq) return false
      liveStates.set(e.src, { client: e.src, cell: e.cell, code: e.code, seq: e.seq })
      return true
    }
    return false
  }

  log.onAppend((e) => { ingest(e) })
  log.onMerge((added) => {
    let changed = false
    for (const e of added) changed = ingest(e) || changed
    if (changed) listeners.forEach((cb) => cb())
  })

  const schedule = throttled(() => {
    log.append({ kind: 'presence', user: local.user, table: local.table, cell: local.cell, head: local.head })
  }, throttleMs)

  const scheduleLive = throttled(() => {
    log.append({ kind: 'live-code', cell: localLive.cell, code: localLive.code })
  }, throttleMs)

  return {
    log,

    set(partial: Partial<Omit<PresenceInfo, 'client'>>): void {
      const next = { ...local, ...partial }
      if (next.user === local.user && next.table === local.table && next.cell === local.cell && next.head === local.head) return
      Object.assign(local, next)
      schedule()
    },

    setLiveCode(cell: string, code: string): void {
      if (cell === localLive.cell && code === localLive.code) return
      localLive.cell = cell
      localLive.code = code
      scheduleLive()
    },

    peers(): Map<string, PresenceInfo> {
      return new Map([...states].map(([client, s]) => [client, { ...s.info }]))
    },

    liveCodes(): Map<string, LiveCode> {
      return new Map([...liveStates].map(([client, lc]) => [client, { ...lc }]))
    },

    onChange(cb: () => void): void {
      listeners.push(cb)
    },
  }
}

// Stable color per user: hash the name to a hue, so it survives reloads.
export function userColor(key: string): string {
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
  return `hsl(${h % 360}, 75%, 62%)`
}

export interface CellEdit {
  table: string
  row: number
  col: string
  seq: number
}

// The last cell each replica edited, read straight off the store log —
// set-cell/set-row events already carry src + table/row/col, so no presence
// event is needed. set-row counts as editing its first written column.
export function lastCellEdits(events: StampedEvent[]): Map<string, CellEdit> {
  const out = new Map<string, CellEdit>()
  for (const e of events) {
    if (typeof e.src !== 'string' || !e.src || e.src === 'server') continue
    let col: string | null = null
    if (e.kind === 'set-cell' && typeof e.col === 'string') col = e.col
    else if (e.kind === 'set-row') col = Object.keys((e.values as Record<string, unknown> | undefined) ?? {})[0] ?? null
    else continue
    if (col == null || typeof e.table !== 'string' || typeof e.row !== 'number') continue
    // Events arrive in (seq, src) order, so per src the last one seen wins.
    out.set(e.src, { table: e.table, row: e.row, col, seq: e.seq })
  }
  return out
}
