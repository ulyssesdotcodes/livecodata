// livecodata presence — who's looking at (and typing in) what, right now
// ----------------------------------------------------------------------------
// Ephemeral multiplayer state: each replica announces the table tab it has
// open, the code cell its editor is pointed at, and its cursor position there.
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

import { createEventLog, localSource, type EventLog, type StampedEvent } from './event-log.js'

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

export interface PresenceChannel {
  // The log to hand to connectMultiplayer (as its own named log).
  readonly log: EventLog
  // Merge into the local state and announce it (throttled — cursor moves
  // arrive per keystroke). No-op if nothing actually changed.
  set(partial: Partial<Omit<PresenceInfo, 'client'>>): void
  // Latest announced state per replica id (including this one — callers
  // filter by client and by who's actually online).
  peers(): Map<string, PresenceInfo>
  // Fired when a *remote* announcement lands (local set()s don't need it —
  // the local UI never shows its own indicators).
  onChange(cb: () => void): void
}

export function createPresenceChannel(
  { user = '', src = localSource(), throttleMs = 150 }: { user?: string; src?: string; throttleMs?: number } = {},
): PresenceChannel {
  const log = createEventLog({ src })
  const local: PresenceInfo = { client: src, user, table: null, cell: null, head: 0 }
  // client → its latest presence (by that replica's own seq — merged history
  // can replay old announcements out of order after a join sync).
  const states = new Map<string, { seq: number; info: PresenceInfo }>()
  const listeners: (() => void)[] = []

  function ingest(e: StampedEvent): boolean {
    if (e.kind !== 'presence' || typeof e.src !== 'string' || !e.src) return false
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

  log.onAppend((e) => { ingest(e) })
  log.onMerge((added) => {
    let changed = false
    for (const e of added) changed = ingest(e) || changed
    if (changed) listeners.forEach((cb) => cb())
  })

  const publish = (): void => {
    log.append({ kind: 'presence', user: local.user, table: local.table, cell: local.cell, head: local.head })
  }

  // Trailing-edge throttle: the first change publishes immediately; changes
  // landing inside the window coalesce into one announcement at its end.
  let timer: ReturnType<typeof setTimeout> | null = null
  let dirty = false
  function schedule(): void {
    if (timer) { dirty = true; return }
    publish()
    timer = setTimeout(() => {
      timer = null
      if (dirty) { dirty = false; schedule() }
    }, throttleMs)
  }

  return {
    log,

    set(partial: Partial<Omit<PresenceInfo, 'client'>>): void {
      const next = { ...local, ...partial }
      if (next.user === local.user && next.table === local.table && next.cell === local.cell && next.head === local.head) return
      Object.assign(local, next)
      schedule()
    },

    peers(): Map<string, PresenceInfo> {
      return new Map([...states].map(([client, s]) => [client, { ...s.info }]))
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
