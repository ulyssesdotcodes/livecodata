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

test('Origami Square Base sample: the five-crease squash stands the T exactly', () => {
  // The sample folds the triangle, then squashes it around its middle: the
  // centre valleys, the two mountains to the doubled edge's midpoint, and
  // the spine unfolding flat — one mechanism, keyframed along its exact
  // rigid path. Run the sample and check the standing T.
  const sample = SAMPLES.find((s) => s.name === 'Origami Square Base')!
  const { views } = createRuntime({
    editableRows: (_name, _schema, seedRows) => seedRows ?? [],
  }).run(sample.code, { seed: 1 })

  const events = views.get('events')!
  const create = events.rows.find((r) => r.type === 'create')!
  assert.equal(create.shape, 'origami')
  const program = create.program as FoldProgram
  assert.deepEqual(program.groups, ['diag', 'mtn', 's1', 'diag~0.5-1'])
  // The mountains are a transient, non-flat fold — the one expected warning.
  assert.equal(program.warnings.length, 1, program.warnings.join('; '))
  assert.ok(program.warnings[0].includes('mtn'))

  // Take the fractions at the end of the squash off the baked keyframes and
  // check the T: the spine (right half of the triangle's long edge) lies
  // flat ON the table pointing up-right, the mountain ridge stands mid-air,
  // the centre line's end stays on the fold line — and nothing stretches.
  const updates = events.rows.filter((r) => r.type === 'update' && typeof r.mtn === 'number')
  const last = updates.reduce((a, b) => ((a.beat as number) > (b.beat as number) ? a : b))
  const fracs: Record<string, number> = {}
  for (const g of program.groups) fracs[g] = typeof last[g] === 'number' ? last[g] as number : 0
  const player = createFoldPlayer(program)
  player.step(fracs)

  const cornerPos = (probe: Vec2, pt: Vec2): number[] => {
    const fi = program.faces.findIndex((f) => {
      for (let i = 0; i < f.poly.length; i++) {
        const a = f.poly[i]
        const b = f.poly[(i + 1) % f.poly.length]
        if ((b[0] - a[0]) * (probe[1] - a[1]) - (b[1] - a[1]) * (probe[0] - a[0]) < -1e-7) return false
      }
      return true
    })
    let base = 0
    for (let i = 0; i < fi; i++) base += (program.faces[i].poly.length - 2) * 3
    const f = program.faces[fi]
    for (let i = 1; i + 1 < f.poly.length; i++) {
      const tri = [f.poly[0], f.poly[i], f.poly[i + 1]]
      for (let k = 0; k < 3; k++) {
        if (Math.hypot(tri[k][0] - pt[0], tri[k][1] - pt[1]) < 1e-9) {
          const o = (base + (i - 1) * 3 + k) * 3
          return [player.positions[o], player.positions[o + 1], player.positions[o + 2]]
        }
      }
    }
    throw new Error('corner not found')
  }
  const near = (a: number[], b: number[], eps: number): boolean =>
    Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < eps

  // Spine tip flat on the table at √2·(1/3, 2√2/3): the top-view T's stem.
  assert.ok(near(cornerPos([0.9, 0.97], [1, 1]), [Math.SQRT2 / 3, 4 / 3, 0], 0.02),
    `tip at ${cornerPos([0.9, 0.97], [1, 1])}`)
  // The mountain ridge's outer end stands mid-air over the doubled edge.
  assert.ok(near(cornerPos([0.4, 0.9], [0.5, 1]), [0.354, 1, 0.354], 0.02),
    `ridge at ${cornerPos([0.4, 0.9], [0.5, 1])}`)
  // The centre line's outer end stays put on the fold line.
  assert.ok(near(cornerPos([-0.3, 0.8], [0, 1]), [0, 1, 0], 0.02))
  // The still triangle hasn't moved.
  assert.ok(near(cornerPos([-0.9, -0.8], [-1, -1]), [-1, -1, 0], 1e-6))

  // Rigid throughout: sample a few beats of the baked schedule and check no
  // face edge stretches (the welded mesh turns any mechanism error into
  // stretch — there must be none).
  const kfAt = (beat: number): Record<string, number> => {
    const fr: Record<string, number> = {}
    for (const g of program.groups) {
      let v = 0
      for (const r of updates) {
        if ((r.beat as number) <= beat && typeof r[g] === 'number') v = r[g] as number
      }
      fr[g] = v
    }
    return fr
  }
  const flat = (() => {
    player.step({})
    return Float32Array.from(player.positions)
  })()
  const stretchNow = (): number => {
    let worst = 0
    for (let i = 0; i + 8 < flat.length; i += 9) {
      for (const [a, b] of [[0, 3], [3, 6], [6, 0]]) {
        const rest = Math.hypot(
          flat[i + a] - flat[i + b], flat[i + a + 1] - flat[i + b + 1], flat[i + a + 2] - flat[i + b + 2])
        const now = Math.hypot(
          player.positions[i + a] - player.positions[i + b],
          player.positions[i + a + 1] - player.positions[i + b + 1],
          player.positions[i + a + 2] - player.positions[i + b + 2])
        worst = Math.max(worst, Math.abs(now - rest))
      }
    }
    return worst
  }
  for (const beat of [2, 4.5, 5, 5.5, 6]) {
    player.step(kfAt(beat))
    assert.ok(stretchNow() < 0.03, `beat ${beat}: stretch ${stretchNow().toFixed(4)}`)
  }

  const scene = views.get('scene')!
  assert.ok(scene.length > 0, 'rasterized to a frame cache')
})
