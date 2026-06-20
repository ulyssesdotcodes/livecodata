import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Table } from '../src/dsl.js'
import { createRuntime } from '../src/runtime.js'
import { LINEAGE, getLineage, withLineage, activeLineage } from '../src/lineage.js'

// Build a Table whose rows already carry lineage refs, as if cooked from a view.
function tagged(name, n) {
  const rows = []
  for (let index = 0; index < n; index++) {
    rows.push(withLineage({ index, value: index * 10 }, [{ table: name, index }]))
  }
  return new Table(rows)
}

test('lineage rides through a {...spread} but stays out of columns', () => {
  const row = withLineage({ a: 1 }, [{ table: 't', index: 0 }])
  const copy = { ...row }
  assert.deepEqual(getLineage(copy), [{ table: 't', index: 0 }], 'spread carries lineage')
  assert.deepEqual(Object.keys(copy), ['a'], 'symbol key not in Object.keys')
  assert.equal(JSON.stringify(copy), '{"a":1}', 'symbol key not serialized')
  assert.ok(!new Table([row]).columns.includes(LINEAGE))
})

test('map / filter / slice / sortBy thread the source row lineage', () => {
  const src = tagged('src', 4)
  const mapped = src.map((r) => ({ v: r.value }))
  assert.deepEqual(getLineage(mapped.rows[2]), [{ table: 'src', index: 2 }])

  const filtered = src.filter((r) => r.index % 2 === 0)
  assert.deepEqual(filtered.rows.map((r) => getLineage(r)[0].index), [0, 2])

  const sliced = src.slice(1, 3)
  assert.deepEqual(sliced.rows.map((r) => getLineage(r)[0].index), [1, 2])

  const sorted = src.sortBy((r) => -r.index)
  assert.deepEqual(sorted.rows.map((r) => getLineage(r)[0].index), [3, 2, 1, 0])
})

test('concat keeps each row\'s own lineage', () => {
  const out = tagged('a', 2).concat(tagged('b', 2))
  assert.deepEqual(out.rows.map((r) => getLineage(r)[0].table), ['a', 'a', 'b', 'b'])
})

test('scan-emitted rows inherit the consumed input row lineage', () => {
  const out = tagged('src', 4).scan((s, cur) => ({
    state: s,
    emit: cur.index === 2 ? { mark: true } : null,
  }), null)
  assert.equal(out.rows.length, 1)
  assert.deepEqual(getLineage(out.rows[0]), [{ table: 'src', index: 2 }])
})

test('the engine stamps each view, accumulating transitive provenance', () => {
  const rt = createRuntime()
  const code = `
    define("randsin", () => math(i => i).range(6))
    define("events", () => table("randsin")
      .scan((s, cur) => ({ state: s, emit: cur.index === 3 ? { hit: cur.index } : null }), null))
  `
  const { views } = rt.run(code, { seed: 1 })

  // randsin row 3 is stamped with its own ref.
  assert.deepEqual(getLineage(views.get('randsin').rows[3]), [{ table: 'randsin', index: 3 }])

  // the events row carries BOTH its upstream randsin ref and its own events ref.
  const ev = views.get('events').rows[0]
  const tables = getLineage(ev).map((r) => r.table)
  assert.ok(tables.includes('randsin'), 'keeps upstream randsin ref')
  assert.ok(tables.includes('events'), 'adds its own ref')
})

test('end-to-end: the scene cache traces back to the randsin sample that set color', () => {
  const rt = createRuntime()
  const code = `
    define("randsin", () => math(i => Math.sin(i * Math.PI / 4)).range(16))
    define("base", () => rows([{ id: "s", type: "create", index: 0, shape: "sphere",
      color: 0x4a9eff, px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 }]))
    define("events", () =>
      table("randsin")
        .scan((state, cur) => {
          const crossed = state.prev != null && cur.value * state.prev < 0
          return { state: { prev: cur.value },
            emit: crossed ? [{ id: "s", type: "color", index: cur.index, color: 0xffffff }] : null }
        }, { prev: null })
        .concat(table("base"))
        .sortBy("index"))
    define("scene", () => table("events").rasterize(16))
  `
  const { views } = rt.run(code, { seed: 1 })
  const scene = views.get('scene')

  // Active provenance at a late frame includes a randsin sample and the events
  // table — i.e. the cache knows which dataset rows drive the current state.
  const lateRows = scene.rows.filter((r) => r.frame === 12)
  const active = activeLineage(lateRows)
  assert.ok(active.has('randsin'), 'a randsin sample is referenced')
  assert.ok(active.has('events'), 'an events row is referenced')
  assert.ok(active.get('randsin').size >= 1)
})

test('stamping does not contaminate an upstream view returned directly', () => {
  const rt = createRuntime()
  const code = `
    define("base", () => rows([{ v: 1 }, { v: 2 }]))
    define("alias", () => table("base"))
  `
  const { views } = rt.run(code, { seed: 1 })
  // base rows must NOT have picked up the "alias" ref.
  for (const r of views.get('base').rows) {
    assert.deepEqual(getLineage(r).map((x) => x.table), ['base'])
  }
  for (const r of views.get('alias').rows) {
    assert.deepEqual(getLineage(r).map((x) => x.table), ['base', 'alias'])
  }
})
