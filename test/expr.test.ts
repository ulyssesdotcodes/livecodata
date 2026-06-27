import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Table, createDSL, field, hashOf } from '../src/dsl.js'
import { getLineage, withLineage, type Row } from '../src/lineage.js'

const t = (rows: Row[]): Table => new Table(rows)

// ── Expr (chainable expression nodes) ───────────────────────────────────────

test('map(template) builds rows from Expr + literals', () => {
  const out = t([{ a: 1 }, { a: 2 }]).map({ b: field('a').add(10), c: 5 })
  assert.deepEqual(out.rows, [{ b: 11, c: 5 }, { b: 12, c: 5 }])
})

test('arithmetic chains evaluate left-to-right', () => {
  const out = t([{ a: 2 }]).map({ v: field('a').mul(3).add(1).sub(2) })
  assert.deepEqual(out.rows, [{ v: 5 }]) // 2*3=6, +1=7, -2=5
})

test('filter(Expr) keeps rows where the predicate holds', () => {
  assert.deepEqual(t([{ v: 1 }, { v: 5 }, { v: 2 }]).filter(field('v').gt(2)).rows, [{ v: 5 }])
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

test('derive accepts Expr, functions, and literals together', () => {
  const out = t([{ a: 2 }]).derive({ b: field('a').mul(3), c: (r: Row) => (r.a as number) + 1, d: 'k' })
  assert.deepEqual(out.rows, [{ a: 2, b: 6, c: 3, d: 'k' }])
})

test('Expr verbs carry lineage forward', () => {
  const base = new Table([withLineage({ v: 5 }, [{ table: 'src', index: 0 }])])
  const out = base.filter(field('v').gt(1)).map({ v: field('v') })
  assert.deepEqual(getLineage(out.rows[0]), [{ table: 'src', index: 0 }])
})

// ── Content hashing (Merkle dataflow) ───────────────────────────────────────

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

// ── Tap-beat / tempo builders (derived from the taps table) ─────────────────

const tapRowsAt = (beatSeconds: number, n = 3): Row[] =>
  Array.from({ length: n }, (_, i) => ({ beat: i, time: i * beatSeconds }))
const dslWithTaps = (rows: Row[] = []) => createDSL({
  defineLazy() {}, defineConst() {}, addGraph() {}, resolve() { return new Table() },
  tapRows: () => rows,
})

test('tempo() derives the beat length from the taps table, else falls back', () => {
  assert.equal(dslWithTaps(tapRowsAt(0.4)).tempo(), 0.4)
  assert.equal(dslWithTaps([]).tempo(), 0.5, 'default fallback is 120 BPM')
  assert.equal(dslWithTaps(tapRowsAt(0, 1)).tempo(0.25), 0.25, 'one tap is not enough')
})

test('taps() wraps the tap-beat rows in a Table (cloned)', () => {
  const rows = tapRowsAt(0.5, 2)
  const tbl = dslWithTaps(rows).taps()
  assert.deepEqual(tbl.rows, rows)
  assert.notEqual(tbl.rows[0], rows[0], 'rows are cloned')
})

test('beats(n) builds an n-beat identity timeline at the tapped tempo', () => {
  const tl = dslWithTaps(tapRowsAt(0.5)).beats(16) // 16 * 0.5s = 8s → 480 frames @ 60fps
  assert.equal(tl.length, 480)
  assert.deepEqual(tl.rows[0], { index: 0, beat: 0, time: 0 })
  const last = tl.rows[tl.length - 1]
  assert.equal(last.beat, 16)
  assert.ok(Math.abs((last.time as number) - 8) < 1e-9)
})

test('beats(n, { fit }) stretches a source duration across the beat window', () => {
  const tl = dslWithTaps(tapRowsAt(0.5)).beats(16, { fit: 4 })
  const last = tl.rows[tl.length - 1]
  assert.ok(Math.abs((last.time as number) - 4) < 1e-9)
})

test('beats() uses the fallback tempo when no taps are recorded', () => {
  assert.equal(dslWithTaps([]).beats(4).length, 120) // 4 * 0.5 * 60
})
