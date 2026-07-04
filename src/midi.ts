// livecodata MIDI — a streaming table sampled at the playhead
// ----------------------------------------------------------------------------
// MIDI is a *streaming* source: notes arrive live, while the timeline plays. We
// treat them like every other dataset — as table rows — but with one twist that
// makes them loop-friendly: each event is stamped with the timeline's *source*
// position at the moment it arrived (seconds; the current frame while looping),
// not wall-clock time. So a note played when the loop is at 1s is recorded at
// index 1s, and replays every time the loop passes 1s.
//
//   { type:"midi", note:"c4", noteNum:60, channel:1, value:0.8, index:1.0 }
//
// At a given frame the *active* value of a note is the most recent event for it
// at-or-before that frame — exactly how rasterize/effects sample sparse events.
// The DSL's midi("c4") (an Expr) becomes a per-row binding that playback resolves
// each frame against this table (see resolveBindings in dsl.ts).
// ----------------------------------------------------------------------------

import { FPS } from './constants.js'
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

// A decoded event + the source position (seconds) it landed at → a table row.
export function midiRow(d: DecodedMidi, indexSeconds: number): Row {
  return { type: 'midi', note: d.note, noteNum: d.noteNum, channel: d.channel, value: d.value, index: indexSeconds }
}

// ── Indexing + sampling ──────────────────────────────────────────────────────

interface MidiSample {
  frame: number
  channel: number
  value: number
}

export type MidiIndex = Map<string, MidiSample[]>

// Group rows by note name, each list sorted ascending by frame, for fast
// "most recent at-or-before" lookups. Event indices (seconds) are pre-converted
// to frames to compare against the playhead's source frame.
export function buildMidiIndex(rows: Row[] | null | undefined): MidiIndex {
  const map: MidiIndex = new Map()
  for (const r of rows ?? []) {
    const note = String(r.note ?? '').toLowerCase()
    if (!note) continue
    if (!map.has(note)) map.set(note, [])
    map.get(note)!.push({
      frame: Math.round(((r.index as number | undefined) ?? 0) * FPS),
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

// ── Live input ───────────────────────────────────────────────────────────────

export interface MidiInputOptions {
  // Current source position (seconds) — where new events get stamped. While
  // looping this is the loop's current frame, so notes pin to loop positions.
  getIndex: () => number
  // Called after an event is recorded (or taps cleared) so the UI can refresh.
  onChange?: () => void
}

export interface MidiInput {
  rows(): Row[]
  clear(): void
  // Call when the loop wraps. The next event on each note will first clear
  // that note's history from previous loops before recording — so playing in a
  // new loop replaces the old recording for that note, while notes you don't
  // touch carry forward unchanged.
  startNewLoop(): void
  // A per-frame evaluation context for resolveBindings: midi(note) samples the
  // recorded table at `srcFrame`.
  ctxAt(srcFrame: number): EvalCtx
  // Feed a raw message (exposed for the browser listener and for tests).
  feed(data: ArrayLike<number>): void
}

export function createMidiInput({ getIndex, onChange }: MidiInputOptions): MidiInput {
  let events: Row[] = []
  let index: MidiIndex | null = null // cached; invalidated on change
  // Notes that have been cleared in the current loop (so a second play of the
  // same note in the same loop just adds, rather than clearing again).
  let clearedThisLoop = new Set<string>()

  const idx = (): MidiIndex => (index ??= buildMidiIndex(events))

  function feed(data: ArrayLike<number>): void {
    const decoded = decodeMidi(data)
    if (!decoded) return
    // On first play of a note after a loop wrap: drop its history from previous
    // loops so this new take cleanly replaces the old recording for that note.
    const key = decoded.note
    if (!clearedThisLoop.has(key)) {
      events = events.filter((e) => (e.note as string) !== key)
      clearedThisLoop.add(key)
    }
    // At most one row per (note, channel, index/frame): a burst of messages
    // landing at the same source frame (e.g. rapid CC/velocity) replaces rather
    // than piling up — the table stays one value per channel per index.
    const indexSeconds = getIndex()
    const frame = Math.round(indexSeconds * FPS)
    events = events.filter((e) =>
      !(e.note === decoded.note && e.channel === decoded.channel && Math.round((e.index as number) * FPS) === frame))
    events.push(midiRow(decoded, indexSeconds))
    index = null
    onChange?.()
  }

  // Best-effort Web MIDI subscription. Silently no-ops where unavailable
  // (unsupported browser, denied permission, headless test).
  const access = (navigator as Navigator & {
    requestMIDIAccess?: () => Promise<{ inputs: Map<unknown, { onmidimessage: ((e: { data: Uint8Array }) => void) | null }> }>
  }).requestMIDIAccess
  if (typeof access === 'function') {
    access.call(navigator).then((midi) => {
      const inputs = [...midi.inputs.values()]
      console.log('[midi] access granted, inputs:', inputs.length)
      for (const input of inputs) {
        console.log('[midi] subscribing to input:', (input as unknown as { name?: string }).name ?? input)
        input.onmidimessage = (e) => {
          console.log('[midi] message:', Array.from(e.data))
          feed(e.data)
        }
      }
    }).catch((err) => { console.warn('[midi] access denied:', err) })
  } else {
    console.warn('[midi] Web MIDI API not available in this browser')
  }

  return {
    rows: () => events.map((r) => ({ ...r })),
    clear: () => { events = []; index = null; clearedThisLoop = new Set(); onChange?.() },
    startNewLoop: () => { clearedThisLoop = new Set() },
    ctxAt: (srcFrame: number): EvalCtx => ({
      midi: (note, channel) => sampleMidiAt(idx(), note, channel, srcFrame),
    }),
    feed,
  }
}
