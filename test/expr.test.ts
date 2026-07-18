import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Table, createDSL, field, hashOf } from '../src/dsl.js'
import { getLineage, withLineage, type Row } from '../src/lineage.js'
import { buildTimeline } from '../src/timeline.js'

const t = (rows: Row[]): Table => new Table(rows)

test('map(template) builds rows from Expr + literals', () => {
  const out = t([{ a: 1 }, { a: 2 }]).map({ b: field('a').add(10), c: 5 })
  assert.deepEqual(out.rows, [{ b: 11, c: 5 }, { b: 12, c: 5 }])
})

test('arithmetic chains evaluate left-to-right', () => {
  const out = t([{ a: 2 }]).map({ v: field('a').mul(3).add(1).sub(2) })
  assert.deepEqual(out.rows, [{ v: 5 }]) // 2*3=6, +1=7, -2=5
})

test('and/or/not compose predicates', () => {
  const base = t([
    { type: 'collision', other: 'floor' },
    { type: 'collision', other: 'wall' },
    { type: 'update', other: 'floor' },
  ])
  const out = base.filter(field('type').eq('collision').and(field('other').eq('floor')))
  assert.deepEqual(out.rows, [{ type: 'collision', other: 'floor' }])
})

test('cond picks a value declaratively', () => {
  const out = t([{ v: 1 }, { v: 9 }]).map({ big: field('v').gt(5).cond('yes', 'no') })
  assert.deepEqual(out.rows, [{ big: 'no' }, { big: 'yes' }])
})

test('emit fans each row out to one or many rows from templates', () => {
  const out = t([{ i: 0 }, { i: 1 }]).emit([{ x: field('i') }, { x: field('i').add(10) }])
  assert.deepEqual(out.rows, [{ x: 0 }, { x: 10 }, { x: 1 }, { x: 11 }])
})

test('Expr verbs carry lineage forward', () => {
  const base = new Table([withLineage({ v: 5 }, [{ table: 'src', index: 0 }])])
  const out = base.filter(field('v').gt(1)).map({ v: field('v') })
  assert.deepEqual(getLineage(out.rows[0]), [{ table: 'src', index: 0 }])
})

test('identical op-graphs hash equal; differing specs hash differently', () => {
  const a = t([{ v: 1 }]).filter(field('v').gt(1))
  const b = t([{ v: 1 }]).filter(field('v').gt(1))
  const c = t([{ v: 1 }]).filter(field('v').gt(2))
  assert.equal(hashOf(a), hashOf(b))
  assert.notEqual(hashOf(a), hashOf(c))
})

test('a changed input changes the hash (Merkle propagation)', () => {
  const a = t([{ v: 1 }]).map({ v: field('v') })
  const b = t([{ v: 2 }]).map({ v: field('v') })
  assert.notEqual(hashOf(a), hashOf(b))
})

// time is an absolute UTC epoch ms (see tap-log.ts), not time-since-first-tap —
// pick an arbitrary base instant and space rows beatSeconds apart from it.
const TAP_BASE_MS = 1_700_000_000_000
const tapRowsAt = (beatSeconds: number, n = 3): Row[] =>
  Array.from({ length: n }, (_, i) => ({ beat: i, time: TAP_BASE_MS + i * beatSeconds * 1000 }))
const dslWithTaps = (rows: Row[] = []) => createDSL({
  defineLazy() {}, defineConst() {}, addGraph() {}, resolve() { return new Table() },
  tapRows: () => rows,
})

test('tempo() derives the beat length from the taps table, else falls back', () => {
  assert.equal(dslWithTaps(tapRowsAt(0.4)).tempo(), 0.4)
  assert.equal(dslWithTaps([]).tempo(), 0.5, 'default fallback is 120 BPM')
  assert.equal(dslWithTaps(tapRowsAt(0, 1)).tempo(0.25), 0.25, 'one tap is not enough')
})

test('beats(n) builds an identity remap spanning n beats', () => {
  // Tempo is automatic in playback, so the timeline itself is just a
  // playback→source remap: the count-beat loop mapped identity.
  const tl = buildTimeline(dslWithTaps(tapRowsAt(0.5)).beats(16).rows)
  assert.equal(tl.beats, 16)
  assert.equal(tl.sourceBeatAt(9), 9)
})

test('beats(n, { fit }) maps a source span across the beat window', () => {
  // fit: 4 maps 4 source-beats (beats 1..5) across the whole 16-beat loop.
  const tl = buildTimeline(dslWithTaps(tapRowsAt(0.5)).beats(16, { fit: 4 }).rows)
  assert.equal(tl.beats, 16)
  assert.equal(tl.sourceBeatAt(9), 3)
})

test('beats() is tempo-independent — identical rows regardless of taps', () => {
  assert.deepEqual(dslWithTaps([]).beats(4).rows, dslWithTaps(tapRowsAt(0.25)).beats(4).rows)
})
