// livecodata sliders — on-screen controls, event-logged like MIDI
// ----------------------------------------------------------------------------
// A slider is a labelled UI control drawn over the visual output (see
// ui/slider-panel.tsx). It is the twin of MIDI: instead of a knob on a physical
// controller, the knob is on screen, but everything downstream is identical.
// What is stored is the append-only log of value changes, each stamped with the
// playhead's *content/source* position (a 1-indexed `beat` — see
// Playback.currentSourceBeats) and the *pass* of the multi-loop sequence it
// landed in (a 0-indexed `loop`, from Playback.passesSince — the same shared,
// wall-aligned pass count the scene/hydra/timeline loop columns run on). So a
// recorded move replays every time the loop returns to that pass and beat, its
// speed tracks the timeline mapping, and it survives a re-cook untouched.
//
// Unlike MIDI, the slider log is NOT a private log — it rides the shared
// editable-table store (main.ts hands createSliderInput a thin SliderStore
// adapter over editableStore.record('slider', …)). That single decision buys
// multiplayer sync and session persistence for free: slider moves are ordinary
// store events, so they merge across a room and serialize into a session
// exactly like every other table (see editable-tables.ts's record()). Both the
// source beat and the pass are shared coordinates (content space + the
// wall-aligned pass every clock-synced client agrees on), not wall-clock time,
// so a move recorded on one machine replays at the same pass and beat on every
// peer — which is why the `loop` a move is stamped with is meaningful across the
// room, where a raw per-client wrap counter would not be.
//
// The *current* "slider" table is a pure fold of that log: for each slider id,
// its moves since the last `clear` for it, deduped to one row per (loop, frame).
// A `clear` with an `id` is the take boundary — fired when the user grabs the
// slider ("record anew"); a `clear` with no id drops everything. The fold reads
// the log's deterministic (seq, src) order, so every replica folds the same
// table. The raw log is the "slider·events" table.
//
//   { type:"slider", id:"brightness", value:0.8, beat:3.0, loop:0 }
//
// Two things make sliders different from MIDI:
//   - Which sliders exist, and their min/max, come from the program: a view
//     named "sliders" whose rows are { id, min, max } (plus an optional
//     `default`). The bindings and the UI both read those definitions.
//   - A slider is bidirectional. During playback the recorded automation drives
//     it, and the UI thumb follows the value at the playhead (sampleSliderAt).
//     The moment the user grabs one, that slider loses sync: its old take is
//     cleared and it records anew from the live playhead (clearId + set).
//
// At the current pass + frame the *active* value of a slider is the most recent
// move at-or-before it — every earlier pass in full, plus this pass up to the
// frame (mirroring hydraFrameAt), with the playhead pass wrapped into the id's
// own pass count so the sequence cycles. A single-pass recording (all loop 0)
// therefore just repeats every loop; with recorded moves but none yet reached,
// the value wraps to the last recorded move (a looped automation holds across
// the boundary), so a single set reads as a constant. With no recording at all
// it reads the slider's `default`. midi()'s sibling slider(id)
// (an Expr) becomes a per-frame binding playback resolves against this table.
// ----------------------------------------------------------------------------

import { beatToFrame } from './constants.js'
import type { StampedEvent } from './event-log.js'
import type { Row } from './lineage.js'
import type { EvalCtx } from './dsl.js'

// ── Definitions ──────────────────────────────────────────────────────────────

export interface SliderDef {
  id: string
  min: number
  max: number
  // Where the control sits, and what slider(id) reads, before any recording.
  default: number
  // The control's granularity. Defaults to a fine continuous step (~1/1000 of
  // the range); pass `step: 1` in the definition row for an integer slider.
  step: number
}

const clamp = (v: number, lo: number, hi: number): number =>
  hi < lo ? v : Math.min(hi, Math.max(lo, v))

// Parse one definition row ({ id, min, max, default?, step? }) into a normalized
// def, or null if it has no id. min/max default to 0/1; default falls back to
// min (clamped into range); step defaults to a fine continuous 1/1000 of the
// range so a plain { id, min, max } slider isn't quantized.
export function sliderDef(row: Row): SliderDef | null {
  const id = row.id != null ? String(row.id) : ''
  if (!id) return null
  const min = Number(row.min ?? 0)
  const max = Number(row.max ?? 1)
  const raw = row.default != null ? Number(row.default) : min
  const def = Number.isFinite(raw) ? raw : min
  const span = max - min
  const rawStep = row.step != null ? Number(row.step) : NaN
  const step = Number.isFinite(rawStep) && rawStep > 0 ? rawStep : (span > 0 ? span / 1000 : 1)
  return { id, min, max, default: clamp(def, min, max), step }
}

// The slider definitions a program declares (its "sliders" view rows), one per
// id — a later row with the same id replaces an earlier one.
export function sliderDefs(rows: Row[] | null | undefined): SliderDef[] {
  const byId = new Map<string, SliderDef>()
  for (const r of rows ?? []) {
    const d = sliderDef(r)
    if (d) byId.set(d.id, d)
  }
  return [...byId.values()]
}

// ── Indexing + sampling ──────────────────────────────────────────────────────
// A slider move carries a 0-indexed `loop` (which pass of a multi-loop sequence
// it plays in) next to its frame, exactly like the scene/hydra `loop` column
// (see hydra.ts). A single-pass recording is all loop 0 and repeats every pass;
// a move recorded while playback was in pass 2 sits in pass 2 and plays there.

interface SliderSample {
  loop: number
  frame: number
  value: number
}

// Per id: its samples sorted by (loop, frame), and how many passes it spans
// (max loop + 1) so sampling can wrap the playhead's pass into the sequence.
interface SliderEntry {
  loops: number
  samples: SliderSample[]
}

export type SliderIndex = Map<string, SliderEntry>

// Group rows by slider id, samples sorted by (loop, frame), for fast "most
// recent at-or-before (pass, frame)" lookups.
export function buildSliderIndex(rows: Row[] | null | undefined): SliderIndex {
  const byId = new Map<string, SliderSample[]>()
  for (const r of rows ?? []) {
    const id = r.id != null ? String(r.id) : ''
    if (!id) continue
    if (!byId.has(id)) byId.set(id, [])
    byId.get(id)!.push({
      loop: typeof r.loop === 'number' ? Math.max(0, Math.floor(r.loop)) : 0,
      frame: beatToFrame((r.beat as number | undefined) ?? 1),
      value: (r.value as number | undefined) ?? 0,
    })
  }
  const map: SliderIndex = new Map()
  for (const [id, samples] of byId) {
    samples.sort((a, b) => (a.loop - b.loop) || (a.frame - b.frame))
    map.set(id, { loops: samples.reduce((m, s) => Math.max(m, s.loop), 0) + 1, samples })
  }
  return map
}

// The active value of a slider at `frame` of the current playhead `pass`: the
// most recent move at-or-before (wrappedPass, frame) — every earlier pass in
// full, plus this pass up to `frame` — mirroring hydraFrameAt. `pass` is wrapped
// into the id's own pass count, so the sequence cycles. With recorded moves but
// none yet at-or-before this point, wrap to the last recorded value (a looped
// automation holds across the boundary). With no recording at all, `fallback`.
export function sampleSliderAt(index: SliderIndex, id: string, frame: number, pass: number, fallback: number): number {
  const entry = index.get(id)
  if (!entry || !entry.samples.length) return fallback
  const p = ((pass % entry.loops) + entry.loops) % entry.loops
  let value: number | null = null
  for (const s of entry.samples) {
    if (s.loop > p || (s.loop === p && s.frame > frame)) break
    value = s.value
  }
  return value ?? entry.samples[entry.samples.length - 1].value
}

// ── The fold: event log → current table ─────────────────────────────────────
// For each slider id, keep its moves since the last `clear` for it, deduped to
// one row per (loop, frame) — a burst of drag messages landing at the same
// source frame in the same pass collapses to the last value, while the same
// frame in a different pass is its own row. A `clear` with an `id` is the take
// boundary, fired when the user grabs the slider ("record anew"); a `clear` with
// no id drops everything. The fold reads events in the log's deterministic
// (seq, src) order, so every replica folds to the same table. Pure.
export function currentSliderRows(events: StampedEvent[]): Row[] {
  const perId = new Map<string, Map<string, Row>>()
  for (const e of events) {
    if (e.kind === 'clear') {
      if (e.id != null) perId.delete(String(e.id))
      else perId.clear()
      continue
    }
    if (e.kind !== 'slider') continue
    const id = String(e.id)
    let byKey = perId.get(id)
    if (!byKey) { byKey = new Map(); perId.set(id, byKey) }
    const loop = typeof e.loop === 'number' ? Math.max(0, Math.floor(e.loop)) : 0
    const frame = beatToFrame((e.beat as number | undefined) ?? 1)
    byKey.set(`${loop}:${frame}`, { type: 'slider', id, value: e.value, beat: e.beat, loop })
  }
  const out: Row[] = []
  for (const byKey of perId.values()) out.push(...byKey.values())
  out.sort((a, b) => ((a.loop as number) - (b.loop as number)) ||
    ((a.beat as number) - (b.beat as number)) ||
    String(a.id).localeCompare(String(b.id)))
  return out
}

// ── Live input ───────────────────────────────────────────────────────────────

// The slider log, abstracted to just what the input needs. main.ts backs this
// with the editable-table store — record('slider', kind, payload) appends a
// store event (auto-creating the "slider" log table on first sight), events()
// returns that table's events, and onChange fires on every store change (a local
// record, a peer's merged event, or a session load). Riding the store is what
// makes slider automation sync over multiplayer and persist in the session.
export interface SliderStore {
  record(kind: string, payload?: Record<string, unknown>): void
  events(): StampedEvent[]
  onChange(cb: () => void): void
}

export interface SliderInputOptions {
  store: SliderStore
  // The playhead's content/source position (a 1-indexed beat) where new moves
  // get stamped — Playback.currentSourceBeats, the same coordinate MIDI uses,
  // and the one that's comparable across peers (content space, not wall time).
  getIndex: () => number
  // Which pass of the multi-loop sequence the playhead is in right now — the
  // shared, wall-aligned pass count (Playback.passesSince from a shared epoch).
  // A move is stamped with this pass and read back at it, so a slider recorded
  // in pass 2 plays in pass 2, exactly like a scene/hydra row's `loop` column.
  // Every clock-synced peer computes the same pass, so it stays consistent.
  getPass: () => number
}

export interface SliderInput {
  // The folded current table (the "slider" view): per id, its take since the
  // last clear, one row per frame.
  rows(): Row[]
  // The raw log (the "slider·events" view).
  eventRows(): Row[]
  // Replace the active slider definitions (from the program's "sliders" view).
  // Sets the fallback value each id reads before any recording.
  setDefs(defs: SliderDef[]): void
  defs(): SliderDef[]
  // Record a value for `id` at the current source position (a UI drag frame).
  set(id: string, value: number): void
  // Drop one slider's recorded take — fired when the user grabs it, so it
  // records a fresh take instead of fighting the old one.
  clearId(id: string): void
  clear(): void
  // A per-frame evaluation context for resolveBindings: slider(id) samples the
  // folded table at `srcFrame`; sliders() returns every defined id's value.
  ctxAt(srcFrame: number): EvalCtx
  // Every defined slider's value at `srcFrame` (recorded automation, or the
  // default) — what the UI thumbs follow as the loop plays.
  valuesAt(srcFrame: number): Record<string, number>
}

export function createSliderInput({ store, getIndex, getPass }: SliderInputOptions): SliderInput {
  let defList: SliderDef[] = []
  let defById = new Map<string, SliderDef>()
  // Fold caches, invalidated whenever the store changes (a local move, a merged
  // peer move, or a session load — all reach the same fold via store.events()).
  let current: Row[] | null = null
  let index: SliderIndex | null = null

  store.onChange(() => { current = null; index = null })

  const rows = (): Row[] => (current ??= currentSliderRows(store.events()))
  const idx = (): SliderIndex => (index ??= buildSliderIndex(rows()))
  const fallbackFor = (id: string): number => defById.get(id)?.default ?? 0
  // Every defined slider's value at `srcFrame` in the current pass — shared by
  // ctxAt().sliders() (handed to hydra) and valuesAt() (the UI thumbs).
  const readAll = (srcFrame: number): Record<string, number> => {
    const pass = getPass()
    const out: Record<string, number> = {}
    for (const d of defList) out[d.id] = sampleSliderAt(idx(), d.id, srcFrame, pass, d.default)
    return out
  }

  return {
    rows: () => rows().map((r) => ({ ...r })),
    eventRows: () => store.events()
      .filter((e) => e.kind === 'slider' || e.kind === 'clear')
      .map(({ kind, seq, t, loop, beat, id, value }) => ({ seq, t, kind, loop, beat, id, value })),
    setDefs(defs: SliderDef[]): void {
      defList = defs
      defById = new Map(defs.map((d) => [d.id, d]))
    },
    defs: () => defList,
    set(id: string, value: number): void {
      store.record('slider', { id, value, beat: getIndex(), loop: getPass() })
    },
    clearId(id: string): void {
      store.record('clear', { id })
    },
    clear(): void {
      store.record('clear')
    },
    ctxAt(srcFrame: number): EvalCtx {
      const pass = getPass()
      return {
        slider: (id) => sampleSliderAt(idx(), id, srcFrame, pass, fallbackFor(id)),
        sliders: () => readAll(srcFrame),
      }
    },
    valuesAt: (srcFrame: number) => readAll(srcFrame),
  }
}
