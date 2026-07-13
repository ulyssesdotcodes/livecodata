import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Table, createDSL } from '../src/dsl.js'
import { withLineage, getLineage, type Row } from '../src/lineage.js'

const t = (rows: Row[]): Table => new Table(rows)

test('map / filter / slice return new tables', () => {
  const base = t([{ v: 1 }, { v: 2 }, { v: 3 }])
  assert.deepEqual(base.map((r) => ({ v: (r.v as number) * 10 })).rows, [{ v: 10 }, { v: 20 }, { v: 30 }])
  assert.deepEqual(base.filter((r) => (r.v as number) % 2 === 1).rows, [{ v: 1 }, { v: 3 }])
  assert.deepEqual(base.slice(1, 2).rows, [{ v: 2 }])
  assert.deepEqual(base.rows, [{ v: 1 }, { v: 2 }, { v: 3 }])
})

test('retime shifts and scales the beat axis; shift is offset sugar', () => {
  const base = t([{ beat: 1, dur: 2, v: 'a' }, { beat: 3, v: 'b' }, { note: 'no beat' }])

  // offset moves every beat later; rows without a beat are untouched.
  assert.deepEqual(base.retime({ offset: 4 }).rows,
    [{ beat: 5, dur: 2, v: 'a' }, { beat: 7, v: 'b' }, { note: 'no beat' }])

  // scale stretches spacing about the loop start (beat 1); durations scale too.
  assert.deepEqual(base.retime({ scale: 2 }).rows,
    [{ beat: 1, dur: 4, v: 'a' }, { beat: 5, v: 'b' }, { note: 'no beat' }])

  // shift(n) is retime({ offset: n }).
  assert.deepEqual(base.shift(-1).rows.map((r) => r.beat), [0, 2, undefined])
})

test('retime accepts a function to remap each beat arbitrarily', () => {
  const base = t([{ beat: 1 }, { beat: 2 }, { beat: 4 }])
  assert.deepEqual(base.retime((b) => b * b).rows.map((r) => r.beat), [1, 4, 16])
})

test('map exposes the row index', () => {
  const out = t([{ v: 5 }, { v: 6 }]).map((r, i) => ({ v: r.v, i }))
  assert.deepEqual(out.rows, [{ v: 5, i: 0 }, { v: 6, i: 1 }])
})

test('filterMap drops nulls, keeps rows, and flattens arrays', () => {
  const base = t([{ v: 1 }, { v: 2 }, { v: 3 }])
  const out = base.filterMap((r) =>
    r.v === 2 ? null : r.v === 3 ? [{ v: 3 }, { v: 30 }] : { v: (r.v as number) * 10 })
  assert.deepEqual(out.rows, [{ v: 10 }, { v: 3 }, { v: 30 }])
})

test('filterMap exposes the index and full row array (for look-back)', () => {
  const base = t([{ v: 5 }, { v: 9 }, { v: 2 }])
  const out = base.filterMap((r, i, rows) => (i > 0 && (r.v as number) > (rows[i - 1].v as number) ? r : null))
  assert.deepEqual(out.rows, [{ v: 9 }])
})

test('concat accepts a Table or a bare array', () => {
  const a = t([{ v: 1 }])
  assert.deepEqual(a.concat(t([{ v: 2 }])).rows, [{ v: 1 }, { v: 2 }])
  assert.deepEqual(a.concat([{ v: 3 }]).rows, [{ v: 1 }, { v: 3 }])
  assert.deepEqual(a.concat(null).rows, [{ v: 1 }])
})

test('fold reduces to a bare accumulator', () => {
  const sum = t([{ v: 1 }, { v: 2 }, { v: 4 }]).fold((acc, r) => acc + (r.v as number), 0)
  assert.equal(sum, 7)
})

test('scan threads state and flattens emitted rows', () => {
  const out = t([{ v: 4 }, { v: 7 }, { v: 12 }, { v: 3 }]).scan((state, cur) => {
    const total = state.total + (cur.v as number)
    const crossed = state.total < 10 && total >= 10
    return { state: { total }, emit: crossed ? { at: cur.v } : null }
  }, { total: 0 })
  assert.deepEqual(out.rows, [{ at: 7 }])
})

test('scan can emit arrays', () => {
  const out = t([{ v: 1 }, { v: 2 }]).scan((s, cur) => ({
    state: s,
    emit: [{ x: cur.v }, { x: (cur.v as number) * 2 }],
  }), null)
  assert.deepEqual(out.rows, [{ x: 1 }, { x: 2 }, { x: 2 }, { x: 4 }])
})

test('mapAccum threads extra state per row and discards it at the end', () => {
  const out = t([{ v: 1 }, { v: 2 }, { v: 3 }]).mapAccum((sum, cur) => {
    const nextSum = sum + (cur.v as number)
    return [{ v: cur.v, runningSum: nextSum }, nextSum]
  }, 0)
  assert.deepEqual(out.rows, [{ v: 1, runningSum: 1 }, { v: 2, runningSum: 3 }, { v: 3, runningSum: 6 }])
})

test('mapAccum can emit multiple rows per input row', () => {
  const out = t([{ v: 1 }, { v: 2 }]).mapAccum((s, cur) => [[{ x: cur.v }, { x: (cur.v as number) * 2 }], s], null)
  assert.deepEqual(out.rows, [{ x: 1 }, { x: 2 }, { x: 2 }, { x: 4 }])
})

test('columns is the first-seen union of keys across rows', () => {
  const out = t([{ a: 1 }, { b: 2, a: 3 }, { c: 4 }])
  assert.deepEqual(out.columns, ['a', 'b', 'c'])
})

test('join merges matching rows on a key (drops unmatched, fans out duplicates)', () => {
  const left = t([{ id: 'a', x: 1 }, { id: 'b', x: 2 }])
  const right = t([{ id: 'a', y: 10 }, { id: 'a', y: 11 }, { id: 'c', y: 99 }])
  assert.deepEqual(left.join(right, 'id').rows, [
    { id: 'a', x: 1, y: 10 }, { id: 'a', x: 1, y: 11 },
  ])
})

test('join accepts {left,right} columns and a key fn', () => {
  const left = t([{ k: 1, x: 'a' }])
  const right = t([{ j: 1, y: 'b' }])
  assert.deepEqual(left.join(right, { left: 'k', right: 'j' }).rows, [{ k: 1, x: 'a', j: 1, y: 'b' }])
  assert.deepEqual(left.join(right, (r) => r.k ?? r.j).rows, [{ k: 1, x: 'a', j: 1, y: 'b' }])
})

test('zip pairs rows positionally and stops at the shorter', () => {
  const a = t([{ x: 1 }, { x: 2 }, { x: 3 }])
  const b = t([{ y: 10 }, { y: 20 }])
  assert.deepEqual(a.zip(b).rows, [{ x: 1, y: 10 }, { x: 2, y: 20 }])
})

test('orderBy sorts asc and desc by key or fn', () => {
  const base = t([{ v: 2 }, { v: 1 }, { v: 3 }])
  assert.deepEqual(base.orderBy('v').rows.map((r) => r.v), [1, 2, 3])
  assert.deepEqual(base.orderBy('v', 'desc').rows.map((r) => r.v), [3, 2, 1])
  assert.deepEqual(base.orderBy((r) => -(r.v as number)).rows.map((r) => r.v), [3, 2, 1])
})

test('derive/assign add and overwrite columns, keeping the rest', () => {
  const base = t([{ a: 1 }, { a: 2 }])
  assert.deepEqual(base.derive({ b: (r: Row) => (r.a as number) * 10, c: 'k' }).rows, [
    { a: 1, b: 10, c: 'k' }, { a: 2, b: 20, c: 'k' },
  ])
  assert.deepEqual(base.assign({ a: (r: Row) => (r.a as number) + 1 }).rows, [{ a: 2 }, { a: 3 }])
})

test('mapField derives one field from one source field', () => {
  const out = t([{ v: 1 }, { v: 4 }]).mapField('v', 'root', (val) => Math.sqrt(val as number))
  assert.deepEqual(out.rows, [{ v: 1, root: 1 }, { v: 4, root: 2 }])
})

test('rescale linearly remaps a field into a range', () => {
  const out = t([{ v: 0 }, { v: 5 }, { v: 10 }]).rescale('v', [0, 10], [0, 100], 'pct')
  assert.deepEqual(out.rows.map((r) => r.pct), [0, 50, 100])
})

test('lag carries a past value into a new column (null at the start)', () => {
  const out = t([{ v: 1 }, { v: 2 }, { v: 3 }]).lag('v')
  assert.deepEqual(out.rows.map((r) => r.v_lag), [null, 1, 2])
})

test('groupBy().agg aggregates per group; count is shorthand', () => {
  const base = t([{ g: 'x', v: 1 }, { g: 'x', v: 3 }, { g: 'y', v: 10 }])
  assert.deepEqual(base.groupBy('g').agg({ sum: (rs) => rs.reduce((s, r) => s + (r.v as number), 0) }).rows, [
    { g: 'x', sum: 4 }, { g: 'y', sum: 10 },
  ])
  assert.deepEqual(base.groupBy('g').count().rows, [{ g: 'x', count: 2 }, { g: 'y', count: 1 }])
})

test('trigger emits only where the predicate fires', () => {
  const out = t([{ v: 1 }, { v: 5 }, { v: 2 }, { v: 9 }]).trigger(
    (r) => (r.v as number) > 3,
    (r) => ({ hit: r.v }),
  )
  assert.deepEqual(out.rows, [{ hit: 5 }, { hit: 9 }])
})

test('crossings detects level crossings with direction', () => {
  const wave = t([{ value: -1 }, { value: -0.5 }, { value: 0.5 }, { value: -2 }])
  assert.deepEqual(wave.crossings().rows.map((r) => ({ value: r.value, dir: r.dir })), [
    { value: 0.5, dir: 1 }, { value: -2, dir: -1 },
  ])
})

test('triggerEach fans out across objects and unions lineage from trigger + object', () => {
  const wave = new Table([
    withLineage({ value: -1, index: 0 }, [{ table: 'wave', index: 0 }]),
    withLineage({ value: 1, index: 1 }, [{ table: 'wave', index: 1 }]),
  ])
  const objs = new Table([
    withLineage({ id: 'a' }, [{ table: 'objs', index: 0 }]),
    withLineage({ id: 'b' }, [{ table: 'objs', index: 1 }]),
  ])
  const out = wave.triggerEach(
    (cur, i, rows) => i > 0 && (cur.value as number) * (rows[i - 1].value as number) < 0,
    objs,
    (o, cur) => ({ id: o.id, at: cur.index }),
  )
  assert.deepEqual(out.rows.map((r) => ({ id: r.id, at: r.at })), [
    { id: 'a', at: 1 }, { id: 'b', at: 1 },
  ])
  assert.deepEqual(getLineage(out.rows[0]), [{ table: 'wave', index: 1 }, { table: 'objs', index: 0 }])
})

test('csv parses a header row and coerces numeric cells', () => {
  const { csv } = createDSL(null)
  assert.deepEqual(csv('city,pop\nNYC,8000000\nLA,4000000').rows, [
    { city: 'NYC', pop: 8000000 }, { city: 'LA', pop: 4000000 },
  ])
})

test('json wraps an array and parses a string', () => {
  const { json } = createDSL(null)
  assert.deepEqual(json([{ a: 1 }]).rows, [{ a: 1 }])
  assert.deepEqual(json('[{"a":2}]').rows, [{ a: 2 }])
})

test('grid lays out a centred cols×rows lattice', () => {
  const { grid } = createDSL(null)
  const g = grid(2, 2, { spacing: 1 })
  assert.equal(g.length, 4)
  assert.deepEqual(g.rows[0], { i: 0, col: 0, row: 0, px: -0.5, py: 0, pz: -0.5 })
  assert.deepEqual(g.rows[3], { i: 3, col: 1, row: 1, px: 0.5, py: 0, pz: 0.5 })
})

test('rotate cycles values through a field, wrapping around', () => {
  const { rotate } = createDSL(null)
  const rows = [{ id: 0 }, { id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]
  const out = rotate(rows, 'color', ['red', 'green', 'blue'])
  assert.deepEqual(out.rows, [
    { id: 0, color: 'red' }, { id: 1, color: 'green' }, { id: 2, color: 'blue' },
    { id: 3, color: 'red' }, { id: 4, color: 'green' },
  ])
})

test('rotate leaves rows unchanged when values is empty', () => {
  const { rotate } = createDSL(null)
  const rows = [{ id: 0 }, { id: 1 }]
  assert.deepEqual(rotate(rows, 'color', []).rows, rows)
})
