// livecodata mouse — canvas clicks, event-logged like MIDI and sliders. Each
// click is stamped with the playhead's content/source position (a 1-indexed
// beat) plus the camera ray it was aimed along, and rides the shared
// editable-table store, so recorded clicks sync over multiplayer and persist
// in the session. Unlike midi()/slider() — per-frame streams resolved at
// playback — clicks are bake-time DATA: a program reads them as
// table("mouse") and each new click re-cooks the live program (see main.ts's
// live re-cook), which is what lets a click re-bake a physics simulation on
// the fly and have it replay at the same beat every loop.

import type { StampedEvent } from './event-log.js'
import type { Row } from './lineage.js'

// One click, in the coordinates a program wants: `x`/`y` the normalized
// device position (-1..1, y up), px/py/pz the camera-ray origin and dx/dy/dz
// its unit direction at click time (see SceneAPI.pickRay).
export interface ClickPayload {
  x: number
  y: number
  px: number
  py: number
  pz: number
  dx: number
  dy: number
  dz: number
}

const CLICK_FIELDS = ['x', 'y', 'px', 'py', 'pz', 'dx', 'dy', 'dz'] as const

// ── The fold: event log → current table ─────────────────────────────────────
// Clicks ACCUMULATE (a shooter wants every shot to replay each loop) — the
// whole history since the last `clear`, in recording order, so row indices
// are stable as ids and slice(-n) keeps the newest takes. Pure; the log is
// never rewritten.
export function currentMouseRows(events: StampedEvent[]): Row[] {
  const out: Row[] = []
  for (const e of events) {
    if (e.kind === 'clear') { out.length = 0; continue }
    if (e.kind !== 'click') continue
    const row: Row = { type: 'click', beat: (e.beat as number | undefined) ?? 1, loop: (e.loop as number | undefined) ?? 0 }
    for (const k of CLICK_FIELDS) row[k] = (e[k] as number | undefined) ?? 0
    out.push(row)
  }
  return out
}

// ── Live input ───────────────────────────────────────────────────────────────

// The mouse log, abstracted to just what the input needs — the exact twin of
// sliders' SliderStore. main.ts backs this with the editable-table store.
export interface MouseStore {
  record(kind: string, payload?: Record<string, unknown>): void
  events(): StampedEvent[]
  onChange(cb: () => void): void
}

export interface MouseInputOptions {
  store: MouseStore
  // Where new clicks get stamped: the playhead's content/source position (a
  // 1-indexed beat, Playback.currentSourceBeats), so a recorded shot lands on
  // the same beat of every loop replay.
  getIndex: () => number
  // Current loop iteration, carried on each click for provenance.
  getLoop?: () => number
}

export interface MouseInput {
  // The folded current table (the "mouse" view).
  rows(): Row[]
  // The raw append-only log (the "mouse·events" view).
  eventRows(): Row[]
  // Record one click at the current source position.
  click(payload: ClickPayload): void
  clear(): void
}

export function createMouseInput({ store, getIndex, getLoop }: MouseInputOptions): MouseInput {
  // Fold cache, invalidated on any store change (local, peer merge, or
  // session load).
  let current: Row[] | null = null
  store.onChange(() => { current = null })

  return {
    rows: () => (current ??= currentMouseRows(store.events())).map((r) => ({ ...r })),
    eventRows: () => store.events()
      .filter((e) => e.kind === 'click' || e.kind === 'clear')
      .map(({ kind, seq, t, loop, beat, x, y, px, py, pz, dx, dy, dz }) =>
        ({ seq, t, kind, loop, beat, x, y, px, py, pz, dx, dy, dz })),
    click(payload: ClickPayload): void {
      store.record('click', { ...payload, beat: getIndex(), loop: getLoop?.() ?? 0 })
    },
    clear: () => store.record('clear'),
  }
}
