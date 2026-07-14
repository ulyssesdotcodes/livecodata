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

test('flatMap fans rows out (and drops nulls) like filterMap', () => {
  const base = t([{ v: 1 }, { v: 2 }, { v: 3 }])
  const out = base.flatMap((r) =>
    r.v === 2 ? null : r.v === 3 ? [{ v: 3 }, { v: 30 }] : { v: (r.v as number) * 10 })
  assert.deepEqual(out.rows, [{ v: 10 }, { v: 3 }, { v: 30 }])
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

test('pairBy pairs matches cyclically, replacing each `second` with fn\'s output', () => {
  const out = t([
    { beat: 1, event: 'setCode', code: 'a' },
    { beat: 5, event: 'setVariable', name: 'freq', value: 3 },
    { beat: 9, event: 'setCode', code: 'b' },
  ]).pairBy('event', 'setCode', (first, second) => [
    { beat: second.beat, from: first.code, to: second.code },
  ])
  assert.deepEqual(out.rows, [
    { beat: 1, from: 'b', to: 'a' },
    { beat: 5, event: 'setVariable', name: 'freq', value: 3 },
    { beat: 9, from: 'a', to: 'b' },
  ])
})

test('pairBy leaves rows unchanged when nothing matches', () => {
  const rows = [{ beat: 1, event: 'setVariable' }]
  assert.deepEqual(t(rows).pairBy('event', 'setCode', () => ({})).rows, rows)
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

test('.three.rotate passes base rows through, appending start + end keyframes', () => {
  const { box } = createDSL(null)
  const scene = box({ id: 'a' }).concat(box({ id: 'b', beat: 3 }))
  const out = scene.three.rotate({ amount: Math.PI, dur: 4 })
  assert.deepEqual(out.rows, [
    // The base create rows survive, so the result is renderable as-is.
    { id: 'a', type: 'create', beat: 1, shape: 'box', px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 },
    { id: 'b', type: 'create', beat: 3, shape: 'box', px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 },
    // 'a': create at beat 1, so ry glides 0 → π over beats 1..5.
    { id: 'a', type: 'update', beat: 1, ry: 0 },
    { id: 'a', type: 'update', beat: 5, ry: Math.PI },
    // 'b': create at beat 3, so beats 3..7.
    { id: 'b', type: 'update', beat: 3, ry: 0 },
    { id: 'b', type: 'update', beat: 7, ry: Math.PI },
  ])
})

test('.three.rotate adds to the object\'s current rotation, honouring axis', () => {
  const { box } = createDSL(null)
  const out = box({ id: 'a', rx: 1 }).three.rotate({ amount: 2, dur: 2, axis: 'x' })
  assert.deepEqual(out.rows.filter((r) => r.type === 'update'), [
    { id: 'a', type: 'update', beat: 1, rx: 1 },
    { id: 'a', type: 'update', beat: 3, rx: 3 },
  ])
})

test('.three.scale multiplies scale uniformly, seeding a start keyframe of 1', () => {
  const { sphere } = createDSL(null)
  const out = sphere({ id: 's' }).three.scale({ amount: 2, dur: 4 })
  assert.deepEqual(out.rows.filter((r) => r.type === 'update'), [
    { id: 's', type: 'update', beat: 1, sx: 1, sy: 1, sz: 1 },
    { id: 's', type: 'update', beat: 5, sx: 2, sy: 2, sz: 2 },
  ])
})

test('.three.move slides along an axis; ease and at options apply to the end keyframe', () => {
  const ease = (t: number): number => t
  const { box } = createDSL(null)
  const out = box({ id: 'a', pz: 1 }).three.move({ amount: 3, dur: 2, axis: 'z', ease, at: 4 })
  assert.deepEqual(out.rows.filter((r) => r.type === 'update'), [
    { id: 'a', type: 'update', beat: 4, pz: 1 },
    { id: 'a', type: 'update', beat: 6, pz: 4, ease },
  ])
})

test('.three animators chain, each acting only on the create rows', () => {
  const { box } = createDSL(null)
  const out = box({ id: 'a' }).three.rotate({ amount: 1, dur: 2 }).three.scale({ amount: 3, dur: 2 })
  // rotate's update rows are ignored by scale (create-only); both sets appear.
  assert.deepEqual(out.rows.filter((r) => r.type === 'update'), [
    { id: 'a', type: 'update', beat: 1, ry: 0 },
    { id: 'a', type: 'update', beat: 3, ry: 1 },
    { id: 'a', type: 'update', beat: 1, sx: 1, sy: 1, sz: 1 },
    { id: 'a', type: 'update', beat: 3, sx: 3, sy: 3, sz: 3 },
  ])
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

test('camera builds a create row (defaulted pose) then update keyframes', () => {
  const { camera } = createDSL(null)
  const cam = camera([
    { beat: 1, px: 0, py: 0.5, pz: 5, fov: 60 },
    { beat: 9, px: 4, fov: 45 },
  ])
  // First keyframe: create, seeded with a full default pose (target at origin).
  assert.deepEqual(cam.rows[0], {
    id: 'camera', shape: 'camera', type: 'create', beat: 1,
    px: 0, py: 0.5, pz: 5, tx: 0, ty: 0, tz: 0, fov: 60,
  })
  // Later keyframes are updates carrying only the fields they set (px/fov here).
  assert.deepEqual(cam.rows[1], {
    id: 'camera', shape: 'camera', type: 'update', beat: 9, px: 4, fov: 45,
  })
})

test('camera defaults a missing beat to 1 and returns empty for no keyframes', () => {
  const { camera } = createDSL(null)
  assert.equal(camera([]).length, 0)
  assert.equal(camera(null).length, 0)
  assert.equal(camera([{ pz: 8 }]).rows[0].beat, 1)
})

test('box builds a defaulted create row, props overriding defaults', () => {
  const { box } = createDSL(null)
  assert.deepEqual(box({ id: 'a', px: -1, color: 0x4a9eff }).rows[0], {
    id: 'a', type: 'create', beat: 1, shape: 'box',
    px: -1, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, color: 0x4a9eff,
  })
})

test('primitive id defaults to the shape name; extra props pass through', () => {
  const { sphere } = createDSL(null)
  const r = sphere({ r: 0.5, beat: 3 }).rows[0]
  assert.equal(r.id, 'sphere')
  assert.equal(r.shape, 'sphere')
  assert.equal(r.type, 'create')
  assert.equal(r.beat, 3)
  assert.equal(r.r, 0.5)
})

test('every named primitive carries its shape and a "create" type', () => {
  const dsl = createDSL(null)
  for (const shape of ['box', 'sphere', 'cylinder', 'cone', 'torus', 'text'] as const) {
    const row = (dsl[shape] as (p?: Row) => Table)().rows[0]
    assert.equal(row.shape, shape)
    assert.equal(row.type, 'create')
    assert.equal(row.id, shape)
  }
})

test('primitives concat into one scene table in order', () => {
  const { box, cone, text } = createDSL(null)
  const scene = box({ id: 'b' }).concat(cone({ id: 'c' })).concat(text({ id: 't', text: 'hi' }))
  assert.deepEqual(scene.rows.map((r) => r.shape), ['box', 'cone', 'text'])
  assert.equal(scene.rows[2].text, 'hi')
})

test('object(shape, props) is the generic primitive builder', () => {
  const { object } = createDSL(null)
  const r = object('torus', { id: 'ring', r: 0.6 }).rows[0]
  assert.equal(r.shape, 'torus')
  assert.equal(r.id, 'ring')
  assert.equal(r.r, 0.6)
  assert.equal(r.type, 'create')
})

test('rotate emits one row per value, cycling through rows and merging', () => {
  const { rotate } = createDSL(null)
  const pattern = [{ shape: 'a' }, { shape: 'b' }]
  const out = rotate(pattern, [{ beat: 1 }, { beat: 2 }, { beat: 3 }, { beat: 4 }, { beat: 5 }])
  assert.deepEqual(out.rows, [
    { shape: 'a', beat: 1 }, { shape: 'b', beat: 2 }, { shape: 'a', beat: 3 },
    { shape: 'b', beat: 4 }, { shape: 'a', beat: 5 },
  ])
})

test('rotate lets each value override the cycled row', () => {
  const { rotate } = createDSL(null)
  const out = rotate([{ code: 'x' }, { code: 'y' }], [{ beat: 1 }, { beat: 2, code: 'z' }])
  assert.deepEqual(out.rows, [{ code: 'x', beat: 1 }, { code: 'z', beat: 2 }])
})

test('rotate output length follows values, not rows', () => {
  const { rotate } = createDSL(null)
  assert.deepEqual(rotate([{ a: 1 }], []).rows, [])
  assert.deepEqual(rotate([], [{ b: 1 }, { b: 2 }]).rows, [{ b: 1 }, { b: 2 }])
})
