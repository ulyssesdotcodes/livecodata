// livecodata MIDI — an event log folded into a streaming table
// ----------------------------------------------------------------------------
// MIDI is a *streaming* source: notes arrive live, while the timeline plays.
// Like every other live thing here (code runs, table edits, slider moves) what
// is stored is the append-only log of events. Exactly like sliders, that log
// is NOT a private one: it rides the shared editable-table store (main.ts
// hands createMidiInput a thin MidiStore adapter over
// editableStore.record('midi', …)), so recorded MIDI syncs over multiplayer
// and persists in the session like any other table. Each event carries three
// time stamps:
//   t     — wall-clock ms since the first event (from the event log)
//   loop  — which loop iteration the playhead was in when it arrived
//   beat  — the playhead's *content/source* position (a 1-indexed beat — see
//           Playback.currentSourceBeats), the coordinate the baked scene is
//           keyed to. Recording this (not wall time) is what makes a recorded
//           sweep's speed track the timeline mapping: remap the timeline 2x
//           slower and the sweep takes 2x as long, with everything else.
//
// The *current* "midi" table is a pure fold of the log: for each note, the
// events from the most recent loop in which that note was recorded (so playing
// a note in a new loop replaces its old take, while untouched notes carry
// forward), deduped to one row per (channel, frame). The raw log itself is the
// read-only "midi·events" table — history is never rewritten, only re-derived.
//
//   { type:"midi", note:"c4", noteNum:60, channel:1, value:0.8, beat:3.0, loop:2 }
//
// At a given frame the *active* value of a note is the most recent row for it
// at-or-before that frame — exactly how rasterize/effects sample sparse events.
// The DSL's midi("c4") (an Expr) becomes a per-row binding that playback resolves
// each frame against the folded table (see resolveBindings in dsl.ts), sampled
// at the same source frame events are recorded at.
// ----------------------------------------------------------------------------

import { beatToFrame } from './constants.js'
import type { StampedEvent } from './event-log.js'
import type { Row } from './lineage.js'
import type { EvalCtx } from './dsl.js'

const SEMITONES: Record<string, number> = {
  c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11,
}
const SHARP_NAMES = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b']

// "c4" / "C#4" / "db3" → MIDI note number (C4 = 60), or null if unparseable.
export function noteToNumber(name: string): number | null {
  const m = /^([a-g])([#b]?)(-?\d+)$/i.exec(String(name).trim())
  if (!m) return null
  const base = SEMITONES[m[1].toLowerCase()]
  const accidental = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0
  const octave = parseInt(m[3], 10)
  return (octave + 1) * 12 + base + accidental
}

// MIDI note number → canonical lower-case note name (sharps), e.g. 60 → "c4".
export function numberToNote(n: number): string {
  const name = SHARP_NAMES[((n % 12) + 12) % 12]
  const octave = Math.floor(n / 12) - 1
  return `${name}${octave}`
}

// ── Decoding raw MIDI bytes ──────────────────────────────────────────────────

export interface DecodedMidi {
  note: string
  noteNum: number
  channel: number // 1-based (1–16)
  value: number   // normalized 0–1 (velocity, or CC value)
}

// Decode a raw [status, data1, data2] message into a normalized event, or null
// for messages we don't track. Note-on with velocity 0 is treated as note-off.
export function decodeMidi(data: ArrayLike<number>): DecodedMidi | null {
  const status = data[0] ?? 0
  const type = status & 0xf0
  const channel = (status & 0x0f) + 1
  const d1 = data[1] ?? 0
  const d2 = data[2] ?? 0
  if (type === 0x90) return { note: numberToNote(d1), noteNum: d1, channel, value: d2 / 127 }
  if (type === 0x80) return { note: numberToNote(d1), noteNum: d1, channel, value: 0 }
  if (type === 0xb0) return { note: `cc${d1}`, noteNum: d1, channel, value: d2 / 127 }
  return null
}

// A decoded event + the source position (a 1-indexed beat) it landed at → a row.
export function midiRow(d: DecodedMidi, beat: number): Row {
  return { type: 'midi', note: d.note, noteNum: d.noteNum, channel: d.channel, value: d.value, beat }
}

// ── Indexing + sampling ──────────────────────────────────────────────────────

interface MidiSample {
  frame: number
  channel: number
  value: number
}

export type MidiIndex = Map<string, MidiSample[]>

// Group rows by note name, each list sorted ascending by frame, for fast
// "most recent at-or-before" lookups. Event beats are pre-converted to frames to
// compare against the playhead's source frame.
export function buildMidiIndex(rows: Row[] | null | undefined): MidiIndex {
  const map: MidiIndex = new Map()
  for (const r of rows ?? []) {
    const note = String(r.note ?? '').toLowerCase()
    if (!note) continue
    if (!map.has(note)) map.set(note, [])
    map.get(note)!.push({
      frame: beatToFrame((r.beat as number | undefined) ?? 1),
      channel: (r.channel as number | undefined) ?? 0,
      value: (r.value as number | undefined) ?? 0,
    })
  }
  for (const list of map.values()) list.sort((a, b) => a.frame - b.frame)
  return map
}

// The active value of a note at `frame`: the most recent event at-or-before it,
// restricted to `channel` when one is given (null = any channel). 0 if none yet.
export function sampleMidiAt(index: MidiIndex, note: string, channel: number | null, frame: number): number {
  const list = index.get(note.toLowerCase())
  if (!list) return 0
  let value = 0
  for (const s of list) {
    if (s.frame > frame) break
    if (channel == null || s.channel === channel) value = s.value
  }
  return value
}

// ── The fold: event log → current table ─────────────────────────────────────
// For each note, keep only the events from the most recent loop in which it was
// recorded — a new take replaces the old one, untouched notes carry forward —
// then dedupe to one row per (channel, frame): a burst of messages landing at
// the same source frame (rapid CC/velocity) collapses to the last value. Pure;
// the log is never rewritten.
export function currentMidiRows(events: StampedEvent[]): Row[] {
  const perNote = new Map<string, { loop: number; byKey: Map<string, Row> }>()
  for (const e of events) {
    if (e.kind === 'clear') { perNote.clear(); continue }
    if (e.kind !== 'midi') continue
    const note = e.note as string
    const loop = (e.loop as number | undefined) ?? 0
    let entry = perNote.get(note)
    if (!entry || loop > entry.loop) {
      entry = { loop, byKey: new Map() }
      perNote.set(note, entry)
    } else if (loop < entry.loop) {
      continue // stale (shouldn't happen with a monotonic loop counter)
    }
    const frame = beatToFrame((e.beat as number | undefined) ?? 1)
    entry.byKey.set(`${e.channel as number}:${frame}`, {
      type: 'midi', note, noteNum: e.noteNum, channel: e.channel,
      value: e.value, beat: e.beat, loop,
    })
  }
  const out: Row[] = []
  for (const entry of perNote.values()) out.push(...entry.byKey.values())
  out.sort((a, b) => ((a.beat as number) - (b.beat as number)) || ((a.channel as number) - (b.channel as number)))
  return out
}

// ── Live input ───────────────────────────────────────────────────────────────

// The midi log, abstracted to just what the input needs — the exact twin of
// sliders' SliderStore. main.ts backs this with the editable-table store:
// record('midi', kind, payload) appends a store event (auto-creating the
// "midi" log table on first sight), events() returns that table's events, and
// onChange fires on every store change (a local message, a peer's merged
// event, or a session load). Riding the store is what makes recorded MIDI
// sync over multiplayer and persist in the session.
export interface MidiStore {
  record(kind: string, payload?: Record<string, unknown>): void
  events(): StampedEvent[]
  onChange(cb: () => void): void
}

export interface MidiInputOptions {
  store: MidiStore
  // The playhead's current content/source position (a 1-indexed beat) — where new
  // events get stamped (Playback.currentSourceBeats). The same coordinate the
  // baked scene is keyed to, so a recorded sweep's speed tracks the timeline
  // mapping rather than staying fixed to wall-clock time.
  getIndex: () => number
  // The current loop iteration (increments each time playback wraps). Folded
  // into each event so the current table can be derived per note from the most
  // recent loop that recorded it.
  getLoop?: () => number
}

export interface MidiInput {
  // The folded current table (the "midi" view): per note, the most recent
  // loop's take, one row per (channel, frame).
  rows(): Row[]
  // The raw append-only log (the "midi·events" view): every event as recorded,
  // stamped with seq, wall-clock t, loop, and source index.
  eventRows(): Row[]
  clear(): void
  // A per-frame evaluation context for resolveBindings: midi(note) samples the
  // folded table at `srcFrame` (the same content/source domain events are
  // stamped in — see Playback.currentSourceBeats).
  ctxAt(srcFrame: number): EvalCtx
  // Feed a raw message (exposed for the browser listener and for tests).
  feed(data: ArrayLike<number>): void
}

export function createMidiInput({ store, getIndex, getLoop }: MidiInputOptions): MidiInput {
  // Fold caches, invalidated whenever the store changes (a local message, a
  // merged peer event, or a session load — all reach the same fold via
  // store.events()).
  let current: Row[] | null = null
  let index: MidiIndex | null = null

  store.onChange(() => { current = null; index = null })

  const rows = (): Row[] => (current ??= currentMidiRows(store.events()))
  const idx = (): MidiIndex => (index ??= buildMidiIndex(rows()))

  function feed(data: ArrayLike<number>): void {
    const decoded = decodeMidi(data)
    if (!decoded) return
    store.record('midi', {
      note: decoded.note, noteNum: decoded.noteNum, channel: decoded.channel, value: decoded.value,
      beat: getIndex(),
      loop: getLoop?.() ?? 0,
    })
  }

  return {
    rows: () => rows().map((r) => ({ ...r })),
    eventRows: () => store.events()
      .filter((e) => e.kind === 'midi' || e.kind === 'clear')
      .map(({ kind, seq, t, loop, beat, note, channel, value }) => ({ seq, t, kind, loop, beat, note, channel, value })),
    clear: () => store.record('clear'),
    ctxAt: (srcFrame: number): EvalCtx => ({
      midi: (note, channel) => sampleMidiAt(idx(), note, channel, srcFrame),
    }),
    feed,
  }
}

// Best-effort Web MIDI subscription, separate from the input itself: the input
// (fold + feed over the shared store) exists regardless — so MIDI synced from
// a peer or loaded from a saved session plays back with no hardware and no
// permission — while requesting device access pops a browser permission
// prompt, so main.ts calls this only once the user enables the MIDI toggle.
// Silently no-ops where unavailable (unsupported browser, denied permission,
// headless test).
export function subscribeWebMidi(input: Pick<MidiInput, 'feed'>): void {
  const access = (navigator as Navigator & {
    requestMIDIAccess?: () => Promise<{ inputs: Map<unknown, { onmidimessage: ((e: { data: Uint8Array }) => void) | null }> }>
  }).requestMIDIAccess
  if (typeof access !== 'function') {
    console.warn('[midi] Web MIDI API not available in this browser')
    return
  }
  access.call(navigator).then((midi) => {
    const inputs = [...midi.inputs.values()]
    console.log('[midi] access granted, inputs:', inputs.length)
    for (const device of inputs) {
      console.log('[midi] subscribing to input:', (device as unknown as { name?: string }).name ?? device)
      device.onmidimessage = (e) => input.feed(e.data)
    }
  }).catch((err) => { console.warn('[midi] access denied:', err) })
}
