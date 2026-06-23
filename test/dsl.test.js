import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Table } from '../src/dsl.js'

// The Table transforms are pure and need no engine context.
const t = (rows) => new Table(rows)

test('map / filter / slice return new tables', () => {
  const base = t([{ v: 1 }, { v: 2 }, { v: 3 }])
  assert.deepEqual(base.map((r) => ({ v: r.v * 10 })).rows, [{ v: 10 }, { v: 20 }, { v: 30 }])
  assert.deepEqual(base.filter((r) => r.v % 2 === 1).rows, [{ v: 1 }, { v: 3 }])
  assert.deepEqual(base.slice(1, 2).rows, [{ v: 2 }])
  // original is untouched
  assert.deepEqual(base.rows, [{ v: 1 }, { v: 2 }, { v: 3 }])
})

test('map exposes the row index', () => {
  const out = t([{ v: 5 }, { v: 6 }]).map((r, i) => ({ v: r.v, i }))
  assert.deepEqual(out.rows, [{ v: 5, i: 0 }, { v: 6, i: 1 }])
})

test('filterMap drops nulls, keeps rows, and flattens arrays', () => {
  const base = t([{ v: 1 }, { v: 2 }, { v: 3 }])
  // null/undefined → dropped; a row → kept; an array → flattened.
  const out = base.filterMap((r) =>
    r.v === 2 ? null : r.v === 3 ? [{ v: 3 }, { v: 30 }] : { v: r.v * 10 })
  assert.deepEqual(out.rows, [{ v: 10 }, { v: 3 }, { v: 30 }])
})

test('filterMap exposes the index and full row array (for look-back)', () => {
  const base = t([{ v: 5 }, { v: 9 }, { v: 2 }])
  // Keep a row only when it is greater than its predecessor.
  const out = base.filterMap((r, i, rows) => (i > 0 && r.v > rows[i - 1].v ? r : null))
  assert.deepEqual(out.rows, [{ v: 9 }])
})

test('concat accepts a Table or a bare array', () => {
  const a = t([{ v: 1 }])
  assert.deepEqual(a.concat(t([{ v: 2 }])).rows, [{ v: 1 }, { v: 2 }])
  assert.deepEqual(a.concat([{ v: 3 }]).rows, [{ v: 1 }, { v: 3 }])
  assert.deepEqual(a.concat(null).rows, [{ v: 1 }])
})

test('fold reduces to a bare accumulator', () => {
  const sum = t([{ v: 1 }, { v: 2 }, { v: 4 }]).fold((acc, r) => acc + r.v, 0)
  assert.equal(sum, 7)
})

test('scan threads state and flattens emitted rows', () => {
  // Emit a marker whenever the running value crosses 10.
  const out = t([{ v: 4 }, { v: 7 }, { v: 12 }, { v: 3 }]).scan((state, cur) => {
    const total = state.total + cur.v
    const crossed = state.total < 10 && total >= 10
    return { state: { total }, emit: crossed ? { at: cur.v } : null }
  }, { total: 0 })
  // 4→11 is where the running total first reaches 10, so cur.v there is 7.
  assert.deepEqual(out.rows, [{ at: 7 }])
})

test('scan can emit arrays', () => {
  const out = t([{ v: 1 }, { v: 2 }]).scan((s, cur) => ({
    state: s,
    emit: [{ x: cur.v }, { x: cur.v * 2 }],
  }), null)
  assert.deepEqual(out.rows, [{ x: 1 }, { x: 2 }, { x: 2 }, { x: 4 }])
})

test('columns is the first-seen union of keys across rows', () => {
  const out = t([{ a: 1 }, { b: 2, a: 3 }, { c: 4 }])
  assert.deepEqual(out.columns, ['a', 'b', 'c'])
})
