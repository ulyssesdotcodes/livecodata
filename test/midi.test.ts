import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  noteToNumber, numberToNote, decodeMidi, midiRow,
  buildMidiIndex, sampleMidiAt, createMidiInput,
} from '../src/midi.js'
import { buildTimeline } from '../src/timeline.js'
import type { Row } from '../src/lineage.js'

// ── Note names ↔ numbers ────────────────────────────────────────────────────

test('noteToNumber parses note names (C4 = 60)', () => {
  assert.equal(noteToNumber('c4'), 60)
  assert.equal(noteToNumber('C4'), 60)
  assert.equal(noteToNumber('a4'), 69)
  assert.equal(noteToNumber('c#4'), 61)
  assert.equal(noteToNumber('db4'), 61, 'flats fold to the same pitch')
  assert.equal(noteToNumber('c-1'), 0, 'lowest octave')
  assert.equal(noteToNumber('nope'), null)
})

test('numberToNote round-trips through sharps', () => {
  assert.equal(numberToNote(60), 'c4')
  assert.equal(numberToNote(61), 'c#4')
  assert.equal(numberToNote(69), 'a4')
  assert.equal(numberToNote(noteToNumber('g5')!), 'g5')
})

// ── Decoding raw messages ────────────────────────────────────────────────────

test('decodeMidi reads note-on / note-off / CC and channels', () => {
  assert.deepEqual(decodeMidi([0x90, 60, 127]), { note: 'c4', noteNum: 60, channel: 1, value: 1 })
  assert.deepEqual(decodeMidi([0x80, 60, 0]), { note: 'c4', noteNum: 60, channel: 1, value: 0 })
  // note-on with velocity 0 is a note-off
  assert.equal(decodeMidi([0x90, 60, 0])!.value, 0)
  // channel is 1-based: 0x95 → channel 6
  assert.equal(decodeMidi([0x95, 64, 64])!.channel, 6)
  // control change
  assert.deepEqual(decodeMidi([0xb0, 1, 64]), { note: 'cc1', noteNum: 1, channel: 1, value: 64 / 127 })
  // unhandled status (pitch bend) → null
  assert.equal(decodeMidi([0xe0, 0, 64]), null)
})

// ── Index + sampling (most recent at-or-before a frame) ─────────────────────

test('sampleMidiAt returns the most recent value at-or-before the frame', () => {
  // c4 played (value 1) at index 1s = frame 60; released (value 0) at 2s = frame 120
  const rows: Row[] = [
    midiRow(decodeMidi([0x90, 60, 127])!, 1),
    midiRow(decodeMidi([0x80, 60, 0])!, 2),
  ]
  const idx = buildMidiIndex(rows)
  assert.equal(sampleMidiAt(idx, 'c4', null, 59), 0, 'before the note: silent')
  assert.equal(sampleMidiAt(idx, 'c4', null, 60), 1, 'at the note frame: on')
  assert.equal(sampleMidiAt(idx, 'c4', null, 119), 1, 'still held')
  assert.equal(sampleMidiAt(idx, 'c4', null, 120), 0, 'after release: off')
  assert.equal(sampleMidiAt(idx, 'd4', null, 999), 0, 'unknown note: 0')
})

test('sampleMidiAt filters by channel when one is given', () => {
  const rows: Row[] = [
    midiRow(decodeMidi([0x90, 60, 127])!, 0),  // c4 ch1 value 1
    midiRow(decodeMidi([0x91, 60, 64])!, 1),   // c4 ch2 value ~0.5
  ]
  const idx = buildMidiIndex(rows)
  assert.equal(sampleMidiAt(idx, 'c4', null, 999), 64 / 127, 'any channel → most recent overall')
  assert.equal(sampleMidiAt(idx, 'c4', 1, 999), 1, 'channel 1 only')
  assert.equal(sampleMidiAt(idx, 'c4', 2, 999), 64 / 127, 'channel 2 only')
  assert.equal(sampleMidiAt(idx, 'c4', 3, 999), 0, 'channel with no events')
})

// ── Live input: events stamped with the source position ─────────────────────

test('createMidiInput stamps events with the current source position', () => {
  let srcSeconds = 0
  const input = createMidiInput({ getIndex: () => srcSeconds })

  srcSeconds = 1
  input.feed([0x90, 60, 127]) // c4 on, recorded at the loop's 1s position
  srcSeconds = 5              // (playhead moved on, but the event keeps its stamp)

  const rows = input.rows()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].note, 'c4')
  assert.equal(rows[0].index, 1, 'stamped at the source position it was heard at')

  // Replays every time the loop passes 1s (frame 60), silent before it.
  assert.equal(input.ctxAt(60).midi!('c4', null), 1)
  assert.equal(input.ctxAt(59).midi!('c4', null), 0)
})

test('createMidiInput notifies on change and clears', () => {
  let changes = 0
  const input = createMidiInput({ getIndex: () => 0, onChange: () => { changes++ } })
  input.feed([0x90, 62, 100])
  input.feed([0xe0, 0, 0]) // ignored message → no row, no notify
  assert.equal(input.rows().length, 1)
  assert.equal(changes, 1)
  input.clear()
  assert.equal(input.rows().length, 0)
  assert.equal(changes, 2)
})

// ── Loop-aware clearing: each new loop replaces the previous take per note ───

test('startNewLoop: first play after a loop wrap replaces that note\'s history', () => {
  let src = 0
  const input = createMidiInput({ getIndex: () => src })

  // Loop 1: play c4 at 1s, d4 at 2s
  src = 1; input.feed([0x90, 60, 127]) // c4 on
  src = 2; input.feed([0x90, 62, 100]) // d4 on

  // Loop wraps
  input.startNewLoop()

  // Loop 2: play c4 at 0.5s — should replace the 1s c4 from loop 1
  src = 0.5; input.feed([0x90, 60, 64]) // c4 on, new position

  const rows = input.rows()
  const c4rows = rows.filter((r) => r.note === 'c4')
  const d4rows = rows.filter((r) => r.note === 'd4')

  assert.equal(c4rows.length, 1, 'old c4 recording cleared; only new one survives')
  assert.equal(c4rows[0].index, 0.5, 'new c4 is at 0.5s, not 1s')
  assert.equal(c4rows[0].value, 64 / 127)
  assert.equal(d4rows.length, 1, 'd4 was not played in loop 2 — it carries forward')
})

test('a second play of the same note in the same loop only adds (no extra clear)', () => {
  let src = 0
  const input = createMidiInput({ getIndex: () => src })

  // Loop 1
  src = 1; input.feed([0x90, 60, 127]) // c4 on

  input.startNewLoop()

  // Loop 2: play c4 twice — first clears loop-1 history; second just adds
  src = 0.5; input.feed([0x90, 60, 100]) // first play: clears + records
  src = 1.5; input.feed([0x90, 60, 50])  // second play: no extra clear

  const c4rows = input.rows().filter((r) => r.note === 'c4')
  assert.equal(c4rows.length, 2, 'both loop-2 events kept')
  assert.deepEqual(c4rows.map((r) => r.index), [0.5, 1.5])
})

// ── At most one row per (note, channel, index) ──────────────────────────────

test('a burst of messages at the same frame replaces rather than piling up', () => {
  let src = 1
  const input = createMidiInput({ getIndex: () => src })

  // Same note, same channel, same source position — e.g. rapid velocity/CC
  // messages landing within the same frame — should collapse to one row.
  input.feed([0x90, 60, 10])
  input.feed([0x90, 60, 64])
  input.feed([0x90, 60, 127])

  const c4rows = input.rows().filter((r) => r.note === 'c4')
  assert.equal(c4rows.length, 1, 'only the latest value at this index survives')
  assert.equal(c4rows[0].value, 1, 'last write wins')
})

test('same note/index but different channels keep one row per channel', () => {
  let src = 2
  const input = createMidiInput({ getIndex: () => src })

  input.feed([0x90, 60, 100]) // c4, channel 1
  input.feed([0x91, 60, 50])  // c4, channel 2, same index

  const c4rows = input.rows().filter((r) => r.note === 'c4')
  assert.equal(c4rows.length, 2, 'distinct channels are not deduped against each other')
  assert.deepEqual(c4rows.map((r) => r.channel).sort(), [1, 2])
})

test('same note/channel but different index (frame) both survive', () => {
  let src = 1
  const input = createMidiInput({ getIndex: () => src })

  input.feed([0x90, 60, 100])
  src = 1.5
  input.feed([0x90, 60, 50])

  const c4rows = input.rows().filter((r) => r.note === 'c4')
  assert.equal(c4rows.length, 2, 'different frames are independent rows')
})

// ── Recording tracks the timeline mapping ────────────────────────────────────
// MIDI is recorded at the playhead's *content/source* position (see
// Playback.currentSourceSeconds) — the same coordinate the whole baked scene is
// keyed to — not raw wall-clock/tick time. That's what makes a recorded sweep's
// speed follow the timeline: remap the timeline to run slower, and the same
// recorded points are reached later, stretching the sweep along with everything
// else on screen, regardless of what mapping was active when it was recorded.

test('a sweep recorded under an identity mapping takes 2x as long once the timeline is remapped 2x slower', () => {
  // Recorded while the timeline was identity (1:1): c4 on at content 0s, off at
  // content 1s — as if performed over 1 real second with no active remap.
  const events: Row[] = [
    { type: 'midi', note: 'c4', channel: 1, value: 1, index: 0 },
    { type: 'midi', note: 'c4', channel: 1, value: 0, index: 1 },
  ]
  const index = buildMidiIndex(events)

  // Remap the timeline to run 2x slower: content(tick) = tick / 2.
  const slow = buildTimeline(Array.from({ length: 3 * 60 }, (_, i) => ({ time: (i / 60) / 2 })))
  const valueAtTick = (tickSeconds: number): number =>
    sampleMidiAt(index, 'c4', 1, slow.frameAt(Math.floor(tickSeconds * 60)))

  assert.equal(valueAtTick(0), 1, 'on at tick 0 (content 0)')
  assert.equal(valueAtTick(1), 1, 'still on at tick 1 (content reached only 0.5s)')
  assert.equal(valueAtTick(1.9), 1, 'still on just before content reaches 1s')
  assert.equal(valueAtTick(2), 0, 'off once content reaches 1s — the sweep now took 2 real seconds, not 1')
})
