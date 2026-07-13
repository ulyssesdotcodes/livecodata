import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRuntime } from '../src/runtime.js'
import { getLineage } from '../src/lineage.js'
import { foldTablePositions, type FoldTableProgram } from '../src/fold-engine.js'
import { SAMPLES } from '../src/samples.js'

test('new verbs cook end-to-end (grid/derive/groupBy/csv/join/triggerEach + lineage)', () => {
  const code = `
define("wave", () => math(t => Math.sin(t * Math.PI * 10)).range(0.8))
define("base", "events", () => grid(2, 2).derive({
  id: r => "o" + r.i, type: "create", beat: 1, shape: "sphere",
  rx: 0, ry: 0, rz: 0, color: 0x4444ff,
}))
define("flash", "events", (rand, table) =>
  table("wave").triggerEach(
    (cur, i, rows) => i > 0 && cur.value * rows[i - 1].value < 0,
    table("base"),
    (o, cur) => ({ id: o.id, type: "color", beat: cur.beat, color: 0xff0000, dur: 4/30 })
  ))
define("scene", () => table("events").rasterize(24/30))
define("bySign", () => table("wave").derive({ sign: r => r.value >= 0 ? "pos" : "neg" }).groupBy("sign").count())
define("cities", () => csv("id,pop\\na,8\\nb,4"))
define("joined", () => table("cities").join(rows([{ id: "a", note: "hit" }]), "id"))
`
  const { views } = createRuntime().run(code, { seed: 1 })

  assert.equal(views.get('base')!.length, 4)

  const colorRows = views.get('events')!.rows.filter((r) => r.type === 'color')
  assert.equal(views.get('events')!.length, 4 + colorRows.length)
  assert.ok(colorRows.length >= 4 && colorRows.length % 4 === 0, 'color events fan out per object')

  assert.equal(views.get('bySign')!.rows.reduce((s, r) => s + (r.count as number), 0), 24)

  assert.deepEqual(views.get('cities')!.rows.map((r) => ({ id: r.id, pop: r.pop })),
    [{ id: 'a', pop: 8 }, { id: 'b', pop: 4 }])
  assert.deepEqual(views.get('joined')!.rows.map((r) => ({ id: r.id, pop: r.pop, note: r.note })),
    [{ id: 'a', pop: 8, note: 'hit' }])

  const scene = views.get('scene')!
  assert.equal(scene.length, 4 * 25)
  const lit = scene.rows.find((r) => r.color !== 0x4444ff)
  assert.ok(lit, 'expected at least one flashed frame')
  const tables = new Set(getLineage(lit!).map((l) => l.table))
  assert.ok(tables.has('wave'), 'flashed frame traces to the wave sample')
  assert.ok(tables.has('base'), 'flashed frame traces to the base object')
})

test('Origami Crane sample: 17 exact fold steps, wings held half-raised', () => {
  const sample = SAMPLES.find((s) => s.name === 'Origami Crane')!
  const { views } = createRuntime({
    editableRows: (_n: string, _s: unknown, seed?: Record<string, unknown>[]) => seed ?? [],
  }).run(sample.code, { seed: 1 })

  const events = views.get('events')!
  const create = events.rows.find((r) => r.type === 'create')!
  const program = create.program as FoldTableProgram
  assert.equal(program.kind, 'fold-table')
  assert.equal(program.steps.length, 17)
  assert.equal(program.steps[16].name, 'wings')
  assert.equal(program.steps[16].to, 0.5)
  assert.equal(program.steps[16].FV.length, 74)
  // solved fold kinds: the collapse and the point folds are reverse folds
  const kinds = program.steps.map((s) => s.type)
  assert.equal(kinds.filter((k) => k === 'Inside Reverse').length, 9)

  // the schedule drives one numeric: fold rises 0 → 16.5 and never falls
  const folds = events.rows
    .filter((r) => r.type === 'update' && typeof r.fold === 'number')
    .sort((a, b) => (a.beat as number) - (b.beat as number))
    .map((r) => r.fold as number)
  assert.equal(folds[folds.length - 1], 16.5)
  for (let i = 1; i < folds.length; ++i) assert.ok(folds[i] >= folds[i - 1])

  // exact states at every landed fold: all flat (|z| only layer nudges = 0
  // here, raw positions), and the finished pose has the wings up
  for (let k = 0; k <= 16; ++k) {
    const { pos } = foldTablePositions(program, k)
    for (const p of pos) assert.equal(Math.abs(p[2]), 0, `state ${k} is flat`)
  }
  const held = foldTablePositions(program, 16.5)
  const zMax = Math.max(...held.pos.map((p) => p[2]))
  assert.ok(zMax > 0.5, `wings rise out of plane (z ${zMax.toFixed(2)})`)

  // rasterized scene carries the fold value onto frames
  const scene = views.get('scene')!
  const withFold = scene.rows.filter((r) => typeof r.fold === 'number')
  assert.ok(withFold.length > 0, 'scene frames carry fold')
  const last = withFold[withFold.length - 1]
  assert.equal(last.fold, 16.5)
})
