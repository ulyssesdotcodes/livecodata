import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRuntime } from '../src/runtime.js'
import { getLineage } from '../src/lineage.js'

// End-to-end: the new DSL verbs cook through the real engine (groups, lineage
// stamping, rasterize) — not just as isolated Table units.
test('new verbs cook end-to-end (grid/derive/groupBy/csv/join/triggerEach + lineage)', () => {
  const code = `
define("wave", () => math(t => Math.sin(t * Math.PI * 10)).range(0.4))
define("base", "events", () => grid(2, 2).derive({
  id: r => "o" + r.i, type: "create", index: 0, shape: "sphere",
  rx: 0, ry: 0, rz: 0, color: 0x4444ff,
}))
define("flash", "events", (rand, table) =>
  table("wave").triggerEach(
    (cur, i, rows) => i > 0 && cur.value * rows[i - 1].value < 0,
    table("base"),
    (o, cur) => ({ id: o.id, type: "color", index: cur.index, color: 0xff0000, dur: 4/60 })
  ))
define("scene", () => table("events").rasterize(24/60))
define("bySign", () => table("wave").derive({ sign: r => r.value >= 0 ? "pos" : "neg" }).groupBy("sign").count())
define("cities", () => csv("id,pop\\na,8\\nb,4"))
define("joined", () => table("cities").join(rows([{ id: "a", note: "hit" }]), "id"))
`
  const { views } = createRuntime().run(code, { seed: 1 })

  // grid → 4 base create rows
  assert.equal(views.get('base').length, 4)

  // events group = 4 creates + color events, fanned out across all 4 objects
  const colorRows = views.get('events').rows.filter((r) => r.type === 'color')
  assert.equal(views.get('events').length, 4 + colorRows.length)
  assert.ok(colorRows.length >= 4 && colorRows.length % 4 === 0, 'color events fan out per object')

  // derive + groupBy + count partitions all 24 samples
  assert.equal(views.get('bySign').rows.reduce((s, r) => s + r.count, 0), 24)

  // csv coerces numerics; join keeps only the matching id. (Cooked rows carry a
  // lineage symbol, so compare explicit fields rather than whole-row deepEqual.)
  assert.deepEqual(views.get('cities').rows.map((r) => ({ id: r.id, pop: r.pop })),
    [{ id: 'a', pop: 8 }, { id: 'b', pop: 4 }])
  assert.deepEqual(views.get('joined').rows.map((r) => ({ id: r.id, pop: r.pop, note: r.note })),
    [{ id: 'a', pop: 8, note: 'hit' }])

  // scene is the dense cache (4 objects × 25 frames); a flashed frame traces back
  // through lineage to BOTH the wave sample and the base object that produced it.
  const scene = views.get('scene')
  assert.equal(scene.length, 4 * 25)
  const lit = scene.rows.find((r) => r.color !== 0x4444ff)
  assert.ok(lit, 'expected at least one flashed frame')
  const tables = new Set(getLineage(lit).map((l) => l.table))
  assert.ok(tables.has('wave'), 'flashed frame traces to the wave sample')
  assert.ok(tables.has('base'), 'flashed frame traces to the base object')
})
