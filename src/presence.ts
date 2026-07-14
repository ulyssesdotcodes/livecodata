// livecodata presence — who's looking at (and typing in) what, right now
// ----------------------------------------------------------------------------
// Ephemeral multiplayer state: each replica announces the table tab it has
// open, the code cell its editor is pointed at, its cursor position there,
// and — as its own 'live-code' event kind — the in-progress buffer it is
// typing, so peers can watch code appear before it is ever Run.
// It rides the same event-log-over-WebSocket machinery as everything else — a
// presence announcement is just an event on its own named log (see main.ts's
// connectMultiplayer logs) — but deliberately NOT the editable-table store's
// log: cursor moves are high-frequency and meaningless historically, so they
// must not be persisted into sessions, refold the store on every keystroke, or
// show up in the scrubbable run history. The room server needs no changes
// (it merges and relays any named log), and the log dies with the room.
//
// The visible state is, as always, a fold: the latest presence event per
// replica wins. Who's *online* is not decided here — that's the "activity"
// table's peer-join/leave history (see main.ts's onlinePeers); this module
// only answers "what was each replica last doing".
//
// "Last cell another user edited" needs no presence event at all: every
// set-cell/set-row event in the store log already carries the authoring
// replica (src) plus table/row/col — lastCellEdits() below just reads them.
// ----------------------------------------------------------------------------

import { compactLatestPerSrcKind, createEventLog, localSource, type EventLog, type StampedEvent } from './event-log.js'

export interface PresenceInfo {
  client: string
  user: string
  // The table tab this replica has open in its table panel.
  table: string | null
  // The code cell its editor is a window onto ("code[0].code" for the main
  // program — see editor.ts's cell labels) and the cursor offset there.
  cell: string | null
  head: number
}

// A replica's in-progress editor buffer: what they've typed since their last
// Run, announced live (throttled) so peers can watch code appear without
// waiting for an Apply. Purely display-side — nothing cooks off a live-code
// announcement; the cook still happens only on an Apply pulse. seq is the
// announcement's log stamp, so "which of two typists is newest" is the usual
// (Lamport) comparison.
export interface LiveCode {
  client: string
  cell: string
  code: string
  seq: number
}

export interface PresenceChannel {
  // The log to hand to connectMultiplayer (as its own named log).
  readonly log: EventLog
  // Merge into the local state and announce it (throttled — cursor moves
  // arrive per keystroke). No-op if nothing actually changed.
  set(partial: Partial<Omit<PresenceInfo, 'client'>>): void
  // Announce the local in-progress buffer for a cell (throttled — doc changes
  // arrive per keystroke). Rides its own event kind, separate from the cursor
  // announcements, so cursor moves stay tiny and the buffer is only re-sent
  // when it actually changed. No-op if unchanged.
  setLiveCode(cell: string, code: string): void
  // Latest announced state per replica id (including this one — callers
  // filter by client and by who's actually online).
  peers(): Map<string, PresenceInfo>
  // Latest announced in-progress buffer per replica id (same caveats).
  liveCodes(): Map<string, LiveCode>
  // Fired when a *remote* announcement lands (local set()s don't need it —
  // the local UI never shows its own indicators).
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
  // Compacted: only the latest announcement per (replica, kind) is state (the
  // folds below are latest-wins), so superseded events are pruned rather than
  // accumulating one event per throttle tick for the life of the session —
  // which also keeps the join upload and the room server's copy (see
  // room-core.ts's PRESENCE_LOG) bounded at O(replicas × kinds).
  const log = createEventLog({ src, compact: compactLatestPerSrcKind })
  const local: PresenceInfo = { client: src, user, table: null, cell: null, head: 0 }
  const localLive = { cell: null as string | null, code: null as string | null }
  // client → its latest presence (by that replica's own seq — merged history
  // can replay old announcements out of order after a join sync).
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

// A stable color per user: hash the name to a hue. Keyed by username (falling
// back to client id in callers) so a user keeps their color across reloads.
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

// The last cell each replica edited, read straight off the store log — every
// set-cell/set-row event already carries src + table/row/col, so "what did
// alice touch last" is a scan, not a new event type. set-row (e.g. a Run
// writing the "code" row) counts as editing its first written column. The
// server's own events (peer-join/leave) aren't edits and are skipped.
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
