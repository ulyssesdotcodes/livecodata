import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Table, field } from '../src/dsl.js'
import { createRuntime } from '../src/runtime.js'
import { LINEAGE, getLineage, withLineage, activeLineage, type Row } from '../src/lineage.js'

function tagged(name: string, n: number): Table {
  const rows: Row[] = []
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
  assert.ok(!(new Table([row]).columns as unknown[]).includes(LINEAGE))
})

test('map / filter / flatMap / slice thread the source row lineage', () => {
  const src = tagged('src', 4)
  const mapped = src.map((r) => ({ v: r.value }))
  assert.deepEqual(getLineage(mapped.rows[2]), [{ table: 'src', index: 2 }])

  const filtered = src.filter(field('index').mod(2).eq(0))
  assert.deepEqual(filtered.rows.map((r) => getLineage(r)[0].index), [0, 2])

  const sliced = src.slice(1, 3)
  assert.deepEqual(sliced.rows.map((r) => getLineage(r)[0].index), [1, 2])

  const fm = src.flatMap((r) => (r.index === 1 ? null : [{ v: r.value }, { v: -(r.value as number) }]))
  assert.deepEqual(fm.rows.map((r) => getLineage(r)[0].index), [0, 0, 2, 2, 3, 3])
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
    define("three", () => table("randsin")
      .scan((s, cur) => ({ state: s, emit: cur.beat === 3 ? { hit: cur.beat } : null }), null))
  `
  const { views } = rt.run(code, { seed: 1 })

  assert.deepEqual(getLineage(views.get('randsin')!.rows[3]), [{ table: 'randsin', index: 3 }])

  const ev = views.get('three')!.rows[0]
  const tables = getLineage(ev).map((r) => r.table)
  assert.ok(tables.includes('randsin'), 'keeps upstream randsin ref')
  assert.ok(tables.includes('three'), 'adds its own ref')
})

test('end-to-end: the scene cache traces back to the randsin sample that set color', () => {
  const rt = createRuntime()
  const code = `
    define("randsin", () => math(t => Math.sin(t * Math.PI * 8)).range(2))
    define("base", "three", () => rows([{ id: "s", type: "create", beat: 1, shape: "sphere",
      color: 0x4a9eff, px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 }]))
    define("flash", "three", (rand, table) => {
      const objects = table("base").flatMap(o => o.type === "create" ? { id: o.id } : null)
      return table("randsin").flatMap((cur, i, rows) =>
        i > 0 && cur.value * rows[i - 1].value < 0
          ? objects.rows.map(o => ({ id: o.id, type: "color", beat: cur.beat, color: 0xffffff }))
          : null)
    })
    define("scene", () => table("three").rasterize(2))
  `
  const { views } = rt.run(code, { seed: 1 })
  const scene = views.get('scene')!

  const lateRows = scene.rows.filter((r) => r.frame === 20)
  const active = activeLineage(lateRows)
  assert.ok(active.has('randsin'), 'a randsin sample is referenced')
  assert.ok(active.has('three'), 'a three-table row is referenced')
  assert.ok(active.get('randsin')!.size >= 1)
})

test('stamping does not contaminate an upstream view returned directly', () => {
  const rt = createRuntime()
  const code = `
    define("base", () => rows([{ v: 1 }, { v: 2 }]))
    define("alias", () => table("base"))
  `
  const { views } = rt.run(code, { seed: 1 })
  for (const r of views.get('base')!.rows) {
    assert.deepEqual(getLineage(r).map((x) => x.table), ['base'])
  }
  for (const r of views.get('alias')!.rows) {
    assert.deepEqual(getLineage(r).map((x) => x.table), ['base', 'alias'])
  }
})
