import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRuntime } from '../src/runtime.js'
import { getLineage } from '../src/lineage.js'
import { createFoldPlayer, foldedPosition, type FoldProgram, type Vec2 } from '../src/origami.js'
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

test('Origami Square Base sample folds exactly: four corners gather at one point', () => {
  // The whole model is authored as INSTRUCTIONS (fold/reflect along a line
  // through two points on known edges) in the sample's editable table, so
  // this is the one place the construction is checked end-to-end: run the
  // sample, take the compiled program off the create row, and assert the
  // square base's exact landmarks.
  const sample = SAMPLES.find((s) => s.name === 'Origami Square Base')!
  const { views } = createRuntime({
    editableRows: (_name, _schema, seedRows) => seedRows ?? [],
  }).run(sample.code, { seed: 1 })

  const events = views.get('events')!
  assert.ok(events.length > 0)
  const create = events.rows.find((r) => r.type === 'create')!
  assert.equal(create.shape, 'origami')
  const program = create.program as FoldProgram
  assert.deepEqual(program.groups, ['diag', 's1', 's2'])
  assert.equal(program.warnings.length, 0, program.warnings.join('; '))

  // The exact folded model: all four paper corners on ONE point, √2 from the
  // paper's centre (the base's opposite corner); the four edge midpoints in
  // TWO stacks (the base's side corners) √2 apart, each 1 from the centre.
  const fold = (p: Vec2): Vec2 => foldedPosition(program.faces, p)!
  const corners: Vec2[] = [[1, 1], [-1, 1], [-1, -1], [1, -1]]
  const fc = corners.map(fold)
  for (const p of fc) {
    assert.ok(Math.hypot(p[0] - fc[0][0], p[1] - fc[0][1]) < 1e-9, 'corners stack at one point')
  }
  const centre = fold([0, 0])
  const cornerDist = Math.hypot(fc[0][0] - centre[0], fc[0][1] - centre[1])
  assert.ok(Math.abs(cornerDist - Math.SQRT2) < 1e-9, `corner stack √2 from centre (${cornerDist})`)
  const mids: Vec2[] = [[1, 0], [0, 1], [-1, 0], [0, -1]]
  const fm = mids.map(fold)
  assert.ok(Math.hypot(fm[0][0] - fm[1][0], fm[0][1] - fm[1][1]) < 1e-9, 'right/top midpoints stack')
  assert.ok(Math.hypot(fm[2][0] - fm[3][0], fm[2][1] - fm[3][1]) < 1e-9, 'left/bottom midpoints stack')
  const midSep = Math.hypot(fm[0][0] - fm[2][0], fm[0][1] - fm[2][1])
  assert.ok(Math.abs(midSep - Math.SQRT2) < 1e-9, `side corners √2 apart (${midSep})`)

  // Playback: fully driven, the paper stacks into a thin flat packet (the
  // player backs each 180° fold off a sliver so layers don't z-fight).
  const player = createFoldPlayer(program)
  player.step({ diag: 1, s1: 1, s2: 1 })
  let zLo = Infinity
  let zHi = -Infinity
  for (let i = 2; i < player.positions.length; i += 3) {
    assert.ok(Number.isFinite(player.positions[i]))
    zLo = Math.min(zLo, player.positions[i])
    zHi = Math.max(zHi, player.positions[i])
  }
  assert.ok(zHi - zLo < 0.15, `square base stacks flat (z extent ${(zHi - zLo).toFixed(3)})`)

  const scene = views.get('scene')!
  assert.ok(scene.length > 0, 'rasterized to a frame cache')
})
