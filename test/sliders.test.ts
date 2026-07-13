import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  sliderDef, sliderDefs, buildSliderIndex, sampleSliderAt,
  currentSliderRows, createSliderInput,
} from '../src/sliders.js'
import { frameToBeat } from '../src/constants.js'
import type { Row } from '../src/lineage.js'
import type { StampedEvent } from '../src/event-log.js'
import type { SliderStore } from '../src/sliders.js'

// The 1-indexed source `beat` that maps to a given cache frame (30 frames/beat).
const b = (frame: number): number => frameToBeat(frame)

// A minimal in-memory SliderStore, standing in for the editable-table store the
// app backs sliders with — appends events, replays them, fires onChange.
function fakeStore(): SliderStore {
  const events: StampedEvent[] = []
  let seq = 0
  const listeners: (() => void)[] = []
  return {
    record(kind: string, payload: Record<string, unknown> = {}): void {
      events.push({ kind, table: 'slider', seq: seq++, t: 0, ...payload })
      listeners.forEach((f) => f())
    },
    events: () => events.slice(),
    onChange: (cb: () => void) => { listeners.push(cb) },
  }
}

// ── Definitions ──────────────────────────────────────────────────────────────

test('sliderDef parses id/min/max/default and clamps the default into range', () => {
  assert.deepEqual(sliderDef({ id: 'x', min: 0, max: 10 }), { id: 'x', min: 0, max: 10, default: 0, step: 0.01 })
  assert.deepEqual(sliderDef({ id: 'x', min: 0, max: 10, default: 5 }), { id: 'x', min: 0, max: 10, default: 5, step: 0.01 })
  assert.deepEqual(sliderDef({ id: 'x', min: 0, max: 10, default: 99 }), { id: 'x', min: 0, max: 10, default: 10, step: 0.01 }, 'clamped to max')
  assert.deepEqual(sliderDef({ id: 'x', min: -1, max: 1, default: -9 }), { id: 'x', min: -1, max: 1, default: -1, step: 0.002 }, 'clamped to min')
  assert.deepEqual(sliderDef({ id: 'y' }), { id: 'y', min: 0, max: 1, default: 0, step: 0.001 }, 'min/max default to 0/1, default to min')
  assert.equal(sliderDef({ min: 0, max: 1 }), null, 'no id → null')
})

test('sliderDef takes an explicit step and defaults to a fine continuous one', () => {
  assert.equal(sliderDef({ id: 'n', min: 0, max: 10, step: 1 })!.step, 1, 'explicit integer step')
  assert.equal(sliderDef({ id: 'f', min: 0, max: 1 })!.step, 0.001, 'fine default, not quantized to 1')
})

test('sliderDefs keeps one def per id, last row wins', () => {
  const defs = sliderDefs([
    { id: 'a', min: 0, max: 1 },
    { id: 'a', min: 0, max: 5 },
    { id: 'b', min: 0, max: 1 },
    { min: 0, max: 1 }, // no id — dropped
  ])
  assert.equal(defs.length, 2)
  assert.equal(defs.find((d) => d.id === 'a')!.max, 5)
})

// ── Index + sampling (most recent at-or-before; wrap-hold across the loop) ────

test('sampleSliderAt returns the most recent value at-or-before the frame', () => {
  // brightness set to 1 at frame 60, dropped to 0 at frame 120.
  const rows: Row[] = [
    { type: 'slider', id: 'brightness', value: 1, beat: b(60) },
    { type: 'slider', id: 'brightness', value: 0, beat: b(120) },
  ]
  const idx = buildSliderIndex(rows)
  assert.equal(sampleSliderAt(idx, 'brightness', 60, 0.5), 1, 'at the move frame')
  assert.equal(sampleSliderAt(idx, 'brightness', 119, 0.5), 1, 'still held')
  assert.equal(sampleSliderAt(idx, 'brightness', 120, 0.5), 0, 'after the second move')
  assert.equal(sampleSliderAt(idx, 'brightness', 999, 0.5), 0, 'holds the last move')
})

test('sampleSliderAt wraps to the last recorded value before the first move (loop continuity)', () => {
  // A single set at frame 90 should read as a constant everywhere in the loop.
  const rows: Row[] = [{ type: 'slider', id: 'x', value: 0.7, beat: b(90) }]
  const idx = buildSliderIndex(rows)
  assert.equal(sampleSliderAt(idx, 'x', 0, 0.2), 0.7, 'before the move: holds over from the loop end')
  assert.equal(sampleSliderAt(idx, 'x', 90, 0.2), 0.7)
  assert.equal(sampleSliderAt(idx, 'x', 200, 0.2), 0.7)
})

test('sampleSliderAt returns the fallback when a slider has no recording', () => {
  const idx = buildSliderIndex([])
  assert.equal(sampleSliderAt(idx, 'x', 100, 0.42), 0.42)
})

// ── The fold: event log → current table ──────────────────────────────────────

test('currentSliderRows folds per id, dedupes one row per frame', () => {
  const events: StampedEvent[] = [
    { seq: 0, t: 0, kind: 'slider', id: 'x', value: 0.1, beat: 2, loop: 0 },
    { seq: 1, t: 0, kind: 'slider', id: 'x', value: 0.9, beat: 2, loop: 0 }, // same frame → replaces
    { seq: 2, t: 0, kind: 'slider', id: 'y', value: 0.5, beat: 3, loop: 0 },
  ]
  const rows = currentSliderRows(events)
  const x = rows.filter((r) => r.id === 'x')
  assert.equal(x.length, 1, 'burst at one frame collapses')
  assert.equal(x[0].value, 0.9, 'last write wins')
  assert.equal(rows.filter((r) => r.id === 'y').length, 1)
})

test('a fresh take (clearId then record) replaces the old one; untouched sliders carry forward', () => {
  let src = 1
  const input = createSliderInput({ store: fakeStore(), getIndex: () => src })

  src = 2; input.set('a', 0.1)
  src = 3; input.set('b', 0.2)
  // Grab a again: clear its take, then record anew from a new position.
  input.clearId('a')
  src = 1.5; input.set('a', 0.7)

  const rows = input.rows()
  const a = rows.filter((r) => r.id === 'a')
  const bb = rows.filter((r) => r.id === 'b')
  assert.equal(a.length, 1, 'the cleared a take is gone; only the new one is current')
  assert.equal(a[0].beat, 1.5)
  assert.equal(a[0].value, 0.7)
  assert.equal(bb.length, 1, 'b was never grabbed — it carries forward')
})

test('without a clear, moves accumulate into one take (deduped per frame)', () => {
  let src = 2
  const input = createSliderInput({ store: fakeStore(), getIndex: () => src })
  input.set('a', 0.1)
  src = 3; input.set('a', 0.5)
  const rows = input.rows().filter((r) => r.id === 'a')
  assert.equal(rows.length, 2, 'distinct frames both kept — no loop-based replacement')
})

// ── Live input: grab clears the take and records anew ────────────────────────

test('createSliderInput stamps moves at the source position and samples them', () => {
  let src = 1
  const input = createSliderInput({ store: fakeStore(), getIndex: () => src })
  input.setDefs([{ id: 'x', min: 0, max: 1, default: 0.2, step: 0.01 }])

  assert.equal(input.ctxAt(60).slider!('x'), 0.2, 'the default before any move')

  src = b(60); input.set('x', 0.8)
  src = b(120); input.set('x', 0.2)

  assert.equal(input.rows().length, 2)
  assert.equal(input.ctxAt(60).slider!('x'), 0.8, 'first move')
  assert.equal(input.ctxAt(119).slider!('x'), 0.8, 'held')
  assert.equal(input.ctxAt(120).slider!('x'), 0.2, 'second move')
  assert.equal(input.ctxAt(0).slider!('x'), 0.2, 'before the first move: wraps to the last value')
  assert.deepEqual(input.valuesAt(60), { x: 0.8 }, 'valuesAt maps every defined id')
})

test('grabbing a slider clears its take so it records anew (clearId)', () => {
  let src = 1
  const input = createSliderInput({ store: fakeStore(), getIndex: () => src })
  input.setDefs([{ id: 'x', min: 0, max: 1, default: 0, step: 0.01 }])

  src = b(60); input.set('x', 0.9)
  assert.equal(input.rows().length, 1)

  input.clearId('x')
  assert.equal(input.rows().length, 0, 'the old take is gone')

  src = b(30); input.set('x', 0.4)
  const rows = input.rows()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].beat, b(30))
  assert.equal(rows[0].value, 0.4)

  // The raw log keeps every slider/clear event (the store's create is filtered).
  assert.equal(input.eventRows().length, 3)
})

test('clearId only affects the named slider; sliders() covers all defined ids', () => {
  let src = b(60)
  const input = createSliderInput({ store: fakeStore(), getIndex: () => src })
  input.setDefs([
    { id: 'a', min: 0, max: 1, default: 0.1, step: 0.01 },
    { id: 'b', min: 0, max: 1, default: 0.2, step: 0.01 },
  ])
  input.set('a', 0.9)
  input.set('b', 0.8)
  input.clearId('a')

  const values = input.ctxAt(60).sliders!()
  assert.equal(values.a, 0.1, 'a fell back to its default after the clear')
  assert.equal(values.b, 0.8, 'b is untouched')
})

test('clear() empties the whole fold', () => {
  const input = createSliderInput({ store: fakeStore(), getIndex: () => 1 })
  input.set('x', 0.5)
  assert.equal(input.rows().length, 1)
  input.clear()
  assert.equal(input.rows().length, 0)
})

// The store gives sync + persistence: any two replicas folding the same event
// list get the same table (the fold is pure and order-deterministic).
test('the fold is deterministic over a shared event list (multiplayer/session replay)', () => {
  const events: StampedEvent[] = [
    { seq: 0, t: 0, kind: 'slider', id: 'x', value: 0.3, beat: b(30) },
    { seq: 1, t: 0, kind: 'slider', id: 'x', value: 0.7, beat: b(90) },
    { seq: 2, t: 0, kind: 'clear', id: 'x' },
    { seq: 3, t: 0, kind: 'slider', id: 'x', value: 0.5, beat: b(60) },
  ]
  const a = currentSliderRows(events)
  const b2 = currentSliderRows(events.map((e) => ({ ...e })))
  assert.deepEqual(a, b2)
  assert.equal(a.length, 1, 'only the post-clear take survives')
  assert.equal(a[0].value, 0.5)
})
