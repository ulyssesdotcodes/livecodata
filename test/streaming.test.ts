import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  Table, field, midi, isBinding, isStreamingNode, resolveBindings, hashOf, type Expr,
} from '../src/dsl.js'
import { rasterizeRows } from '../src/rasterize.js'
import { buildMidiIndex, sampleMidiAt, midiRow, decodeMidi } from '../src/midi.js'
import { buildHydraIndex, hydraFrameAt } from '../src/hydra.js'
import type { Row } from '../src/lineage.js'

const t = (rows: Row[]): Table => new Table(rows)
const nodeOf = (e: Expr): import('../src/dsl.js').ExprNode => e.node

// ── Streaming detection ─────────────────────────────────────────────────────

test('isStreamingNode is true for any expression containing midi()', () => {
  assert.equal(isStreamingNode(nodeOf(field('a').add(1))), false)
  assert.equal(isStreamingNode(nodeOf(midi('c4'))), true)
  assert.equal(isStreamingNode(nodeOf(midi('c4').mul(2))), true)
  assert.equal(isStreamingNode(nodeOf(field('base').add(midi('c4')))), true)
})

// ── setField: streaming → binding, constant → baked ─────────────────────────

test('setField(midi) leaves a per-frame binding; resolveBindings reads the ctx', () => {
  const row = t([{ id: 'a' }]).setField('amount', midi('c4')).rows[0]
  assert.ok(isBinding(row.amount), 'a streaming value is deferred')
  const resolved = resolveBindings(row, { midi: () => 0.7 })
  assert.equal(resolved.amount, 0.7)
  assert.notEqual(resolved, row, 'a fresh row is returned when something resolves')
})

test('setField with a constant Expr bakes immediately (no binding)', () => {
  const row = t([{ a: 2 }]).setField('b', field('a').mul(3)).rows[0]
  assert.equal(row.b, 6)
  assert.ok(!isBinding(row.b))
})

test('a midi value composes with row fields, resolved at frame time', () => {
  const row = t([{ base: 10 }]).setField('v', field('base').add(midi('c4').mul(100))).rows[0]
  assert.ok(isBinding(row.v))
  // base (baked: 10) + c4 (live: 0.5) * 100 = 60
  assert.equal(resolveBindings(row, { midi: () => 0.5 }).v, 60)
})

test('resolveBindings returns the same row when there is nothing to resolve', () => {
  const row: Row = { a: 1, b: 2 }
  assert.equal(resolveBindings(row, { midi: () => 0 }), row)
})

test('midi bindings are diffable: same note hashes equal, different note differs', () => {
  const a = t([{ id: 'x' }]).setField('amount', midi('c4'))
  const b = t([{ id: 'x' }]).setField('amount', midi('c4'))
  const c = t([{ id: 'x' }]).setField('amount', midi('e4'))
  assert.equal(hashOf(a), hashOf(b))
  assert.notEqual(hashOf(a), hashOf(c))
})

// ── rasterize carries bindings through to every baked frame ─────────────────

test('rasterize carries a midi binding onto each dense frame row', () => {
  const events = t([
    { id: 's', type: 'create', index: 0, shape: 'box', px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 },
  ]).setField('amount', midi('c4'))

  const baked = rasterizeRows(events.rows, 0.05) // ~3 frames
  assert.ok(baked.length >= 2)
  for (const f of baked) assert.ok(isBinding(f.amount), 'binding survives the bake')
})

// ── End-to-end: the same path playback walks each frame ─────────────────────

test('a note recorded at 1s drives the field every time the loop passes 1s', () => {
  // Record c4 (on) at source 1s, off at 2s — exactly what live input would store.
  const midiRows = [
    midiRow(decodeMidi([0x90, 60, 127])!, 1),
    midiRow(decodeMidi([0x80, 60, 0])!, 2),
  ]
  const idx = buildMidiIndex(midiRows)
  const ctxAt = (frame: number): { midi: (n: string, c: number | null) => number } => ({
    midi: (note, ch) => sampleMidiAt(idx, note, ch, frame),
  })

  // The baked scene with a midi-bound field, as rasterize produces it.
  const baked = rasterizeRows(
    t([{ id: 's', type: 'create', index: 0, shape: 'box', px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 }])
      .setField('amount', midi('c4')).rows,
    3,
  )
  const rowAt = (frame: number): Row => resolveBindings(baked.find((r) => r.frame === frame)!, ctxAt(frame))

  assert.equal(rowAt(30).amount, 0, 'before the note (0.5s): 0')
  assert.equal(rowAt(60).amount, 1, 'loop reaches 1s: note on')
  assert.equal(rowAt(90).amount, 1, 'still held at 1.5s')
  assert.equal(rowAt(120).amount, 0, 'released at 2s')
})

// ── The same carry-through, but for a hydra sketch variable ─────────────────

test('a midi binding in a hydra sketch variable survives to hydraFrameAt and resolves at playback', () => {
  const row = t([{ index: 0, code: 'osc(speed).out()' }]).setField('speed', midi('c4')).rows[0]
  assert.ok(isBinding(row.speed), 'the sketch variable is deferred, like a scene field')

  const idx = buildHydraIndex([row])
  const frame = hydraFrameAt(idx, 0)
  assert.ok(frame)
  assert.ok(isBinding(frame!.vars.speed), 'the binding survives hydraFrameAt untouched')

  const resolved = resolveBindings(frame!.vars, { midi: () => 0.6 })
  assert.equal(resolved.speed, 0.6)
})
