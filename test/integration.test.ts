import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRuntime } from '../src/runtime.js'
import { getLineage } from '../src/lineage.js'
import { createFoldSolver, type CompiledPattern } from '../src/origami.js'
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

test('Origami Crane sample folds the traditional bird base without blowing up', () => {
  // The crane's crease pattern lives entirely in the sample program now (not
  // behind a preset in src/origami.ts), so this is the one place its
  // geometry — Kawasaki's theorem, a real mesh, a flat-foldable base — is
  // still checked.
  const sample = SAMPLES.find((s) => s.name === 'Origami Crane')!
  const { views } = createRuntime({
    editableRows: (_name, _schema, seedRows) => seedRows ?? [],
  }).run(sample.code, { seed: 1 })

  const events = views.get('events')!
  assert.ok(events.length > 0)
  const create = events.rows.find((r) => r.type === 'create')!
  assert.equal(create.shape, 'origami')
  const pattern = create.pattern as CompiledPattern
  for (const g of ['diag', 'book', 'petal', 'neck', 'tail', 'head', 'wings']) {
    assert.ok(pattern.groups.includes(g), `missing group ${g}`)
  }
  assert.ok(pattern.faces.length >= 20, `expected a real mesh, got ${pattern.faces.length} faces`)

  // Kawasaki's theorem at the classic interior vertices of the bird base:
  // alternating sector angles around each vertex sum to π. The sample writes
  // its coordinates rounded to 4 decimals, hence the loose vertex lookup —
  // and the theorem still holding on the rounded pattern is the point.
  const d = Math.SQRT2 - 1
  const checkKawasaki = (vx: number, vy: number): void => {
    const vi = pattern.vertices.findIndex(([x, y]) => Math.hypot(x - vx, y - vy) < 1e-3)
    assert.ok(vi >= 0, `vertex (${vx},${vy}) exists`)
    const dirs: number[] = []
    const seen = new Set<string>()
    for (const h of pattern.hinges) {
      if (h.group === null) continue
      for (const [a, b] of [[h.e[0], h.e[1]], [h.e[1], h.e[0]]]) {
        if (a !== vi) continue
        const key = `${a},${b}`
        if (seen.has(key)) continue
        seen.add(key)
        dirs.push(Math.atan2(pattern.vertices[b][1] - vy, pattern.vertices[b][0] - vx))
      }
    }
    dirs.sort((x, y) => x - y)
    assert.ok(dirs.length >= 4 && dirs.length % 2 === 0, `even degree at (${vx},${vy}): ${dirs.length}`)
    let alt = 0
    for (let i = 0; i < dirs.length; i++) {
      const gap = (i + 1 < dirs.length ? dirs[i + 1] : dirs[0] + 2 * Math.PI) - dirs[i]
      alt += i % 2 === 0 ? gap : -gap
    }
    assert.ok(Math.abs(alt) < 1e-3, `Kawasaki at (${vx},${vy}): alternating sum ${alt}`)
  }
  checkKawasaki(d, -d)
  checkKawasaki(-d, d)

  // Folding the base most of the way must stay numerically sane and keep the
  // paper inextensible. The collapse is three cascading motions in the sample;
  // ramp them together here as they largely are by the end.
  const solver = createFoldSolver(pattern)
  for (let i = 0; i < 80; i++) solver.step({ diag: i / 80, book: i / 80, petal: i / 80 }, 40)
  for (let i = 0; i < 40; i++) solver.step({ diag: 1, book: 1, petal: 1 }, 40)
  for (let i = 0; i < solver.positions.length; i++) {
    assert.ok(Number.isFinite(solver.positions[i]), 'positions stay finite')
  }
  let maxStretch = 0
  for (const [a, b, c] of pattern.faces) {
    for (const [i, j] of [[a, b], [b, c], [c, a]]) {
      const rest = Math.hypot(
        pattern.vertices[j][0] - pattern.vertices[i][0],
        pattern.vertices[j][1] - pattern.vertices[i][1],
      )
      const now = Math.hypot(
        solver.positions[j * 3] - solver.positions[i * 3],
        solver.positions[j * 3 + 1] - solver.positions[i * 3 + 1],
        solver.positions[j * 3 + 2] - solver.positions[i * 3 + 2],
      )
      maxStretch = Math.max(maxStretch, Math.abs(now - rest) / rest)
    }
  }
  assert.ok(maxStretch < 0.12, `paper stretched ${(maxStretch * 100).toFixed(1)}%`)

  const scene = views.get('scene')!
  assert.ok(scene.length > 0, 'rasterized to a frame cache')
})
