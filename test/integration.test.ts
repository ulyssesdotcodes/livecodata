import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRuntime } from '../src/runtime.js'
import { getLineage } from '../src/lineage.js'
import { createFoldPlayer, type FoldProgram, type Vec2 } from '../src/origami.js'
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

test('Origami Crane sample: squash to the square base, petal to the bird base', () => {
  // The sample is a static crease table: the collapse to the square base,
  // then the petal folds to the bird base. Run it and check the folded
  // states against the classic coordinates.
  const sample = SAMPLES.find((s) => s.name === 'Origami Crane')!
  const { views } = createRuntime({
    editableRows: (_name, _schema, seedRows) => seedRows ?? [],
  }).run(sample.code, { seed: 1 })

  const events = views.get('events')!
  const create = events.rows.find((r) => r.type === 'create')!
  assert.equal(create.shape, 'origami')
  const program = create.program as FoldProgram
  assert.deepEqual(program.groups,
    ['spine', 'spineN', 'spineH', 'still', 'stillN', 's1', 'hv', 's2',
      'kite', 'kiteN', 'kite2', 'kite2H', 'kite2N', 'petal', 'peelfr', 'peelfl',
      'kite3', 'kite3N', 'kite4', 'kite4H', 'kite4N', 'petal2', 'peelbr', 'peelbl',
      'thinfr', 'thinfrH', 'thinfrN', 'thinfl', 'thinflN',
      'thinbr', 'thinbrH', 'thinbrN', 'thinbl', 'thinblN',
      'neck', 'tail', 'head', 'wingf', 'wingb'])
  assert.equal(program.warnings.length, 0, program.warnings.join('; '))

  // Take the fractions at the end of the squash off the baked keyframes and
  // check the T: the spine (right half of the triangle's long edge) lies
  // flat ON the table pointing up-right, the mountain ridge stands mid-air,
  // the centre line's end stays on the fold line — and nothing stretches.
  const updates = events.rows.filter((r) => r.type === 'update' && typeof r.hv === 'number')
  const kfFracsAt = (beat: number): Record<string, number> => {
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
  const fracs = kfFracsAt(14.5) // the finished square base, before the petal
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

  // THE SQUARE BASE: all four paper corners gather on one point, the
  // coincident edge midpoints stack at the diamond's two side corners, the
  // paper's centre sits at the closed corner, and the packet is flat.
  for (const [probe, corner] of [
    [[0.9, 0.97], [1, 1]], [[0.9, -0.8], [1, -1]], [[-0.9, -0.97], [-1, -1]], [[-0.85, 0.9], [-1, 1]],
  ] as [Vec2, Vec2][]) {
    assert.ok(near(cornerPos(probe, corner), [-1, 1, 0], 0.02),
      `corner ${corner} at ${cornerPos(probe, corner)}`)
  }
  assert.ok(near(cornerPos([0.2, 0.85], [0, 1]), [0, 1, 0], 0.02),
    `ridge (0,1) at ${cornerPos([0.2, 0.85], [0, 1])}`)
  assert.ok(near(cornerPos([0.85, 0.2], [1, 0]), [0, 1, 0], 0.02),
    `ridge (1,0) at ${cornerPos([0.85, 0.2], [1, 0])}`)
  assert.ok(near(cornerPos([-0.9, 0.05], [-1, 0]), [-1, 0, 0], 0.02),
    `ridge (-1,0) at ${cornerPos([-0.9, 0.05], [-1, 0])}`)
  assert.ok(near(cornerPos([0.05, -0.9], [0, -1]), [-1, 0, 0], 0.02),
    `ridge (0,-1) at ${cornerPos([0.05, -0.9], [0, -1])}`)
  assert.ok(near(cornerPos([-0.2, 0.1], [0, 0]), [0, 0, 0], 0.02), 'centre at the closed corner')
  {
    let zLo = Infinity
    let zHi = -Infinity
    for (let i = 2; i < player.positions.length; i += 3) {
      zLo = Math.min(zLo, player.positions[i])
      zHi = Math.max(zHi, player.positions[i])
    }
    assert.ok(zHi - zLo < 0.05, `square base is flat (z extent ${(zHi - zLo).toFixed(4)})`)
  }

  // THE BIRD BASE (the petals, front then back, beats 14.6–16): the
  // petalled corners land √2−1 past the closed corner, the side corners
  // tuck onto the hinge, the middle flaps' corners — untouched by either
  // petal, exactly as in the paper sequence — stay at the base's point.
  {
    player.step(kfFracsAt(16.2))
    for (const [probe, corner] of [
      [[-0.85, 0.9], [-1, 1]], [[0.9, -0.8], [1, -1]],
    ] as [Vec2, Vec2][]) {
      assert.ok(near(cornerPos(probe, corner), [Math.SQRT2 - 1, 1 - Math.SQRT2, 0], 0.02),
        `petalled corner ${corner} at ${cornerPos(probe, corner)}`)
    }
    for (const [probe, corner] of [
      [[0.9, 0.97], [1, 1]], [[-0.9, -0.97], [-1, -1]],
    ] as [Vec2, Vec2][]) {
      assert.ok(near(cornerPos(probe, corner), [-1, 1, 0], 0.02),
        `middle corner ${corner} at ${cornerPos(probe, corner)}`)
    }
    assert.ok(near(cornerPos([-0.9, 0.05], [-1, 0]), [-(1 - Math.SQRT1_2), 1 - Math.SQRT1_2, 0], 0.02),
      `side corner (-1,0) tucks to the hinge, at ${cornerPos([-0.9, 0.05], [-1, 0])}`)
    player.step(fracs)
  }

  // Mid-way (the first standing pocket, beat 6): the squashing flap's tip
  // sweeps to the table beside the corner while the pocket stands.
  {
    player.step(kfFracsAt(6))
    assert.ok(near(cornerPos([0.9, 0.97], [1, 1]), [-0.994, 1.0, -0.111], 0.02),
      `standing tip at ${cornerPos([0.9, 0.97], [1, 1])}`)
    player.step(fracs)
  }

  // Rigid throughout: sample a few beats of the baked schedule and check no
  // face edge stretches (the welded mesh turns any mechanism error into
  // stretch — there must be none).
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
  for (const beat of [2, 4.5, 5, 5.5, 6, 7, 7.5, 8, 8.5, 9, 10, 10.5, 11.5, 12.5, 13, 13.5, 14, 16]) {
    player.step(kfFracsAt(beat))
    assert.ok(stretchNow() < 0.03, `beat ${beat}: stretch ${stretchNow().toFixed(4)}`)
  }

  // Every fold ends FLAT: the triangle, the square base, each finished
  // petal, the bird base, and each thinning pass (17 = front pair done,
  // 18 = the thinned bird base).
  const zExtent = (): number => {
    let lo = Infinity
    let hi = -Infinity
    for (let i = 2; i < player.positions.length; i += 3) {
      lo = Math.min(lo, player.positions[i])
      hi = Math.max(hi, player.positions[i])
    }
    return hi - lo
  }
  for (const beat of [3.5, 14.5, 15.3, 16, 17, 18, 19.55, 20.65, 21.7]) {
    player.step(kfFracsAt(beat))
    assert.ok(stretchNow() < 0.01, `beat ${beat}: fold end strained (${stretchNow().toFixed(4)})`)
    assert.ok(zExtent() < 0.05, `beat ${beat}: fold end not flat (z extent ${zExtent().toFixed(4)})`)
  }
  // The finished crane is NOT flat: the wings fold a quarter turn down, one
  // toward the viewer and one away.
  {
    player.step(kfFracsAt(Infinity))
    assert.ok(zExtent() > 0.4, `wings down should be 3D (z extent ${zExtent().toFixed(3)})`)
  }
  // The thinned legs: the former outer edges (the kite creases, the bird
  // base's silhouette) lie ON the centre line — the world axis x = −y —
  // after both thinning passes.
  {
    player.step(kfFracsAt(18))
    const worldOfSheet = (pt: Vec2): number[] => {
      let base = 0
      for (const f of program.faces) {
        const poly = f.poly
        let inside = true
        for (let i = 0; i < poly.length && inside; i++) {
          const a = poly[i]
          const b = poly[(i + 1) % poly.length]
          if ((b[0] - a[0]) * (pt[1] - a[1]) - (b[1] - a[1]) * (pt[0] - a[0]) < -1e-9) inside = false
        }
        if (inside) {
          const [s0, s1, s2] = poly
          const det = (s1[0] - s0[0]) * (s2[1] - s0[1]) - (s1[1] - s0[1]) * (s2[0] - s0[0])
          const a = ((pt[0] - s0[0]) * (s2[1] - s0[1]) - (pt[1] - s0[1]) * (s2[0] - s0[0])) / det
          const b = ((s1[0] - s0[0]) * (pt[1] - s0[1]) - (s1[1] - s0[1]) * (pt[0] - s0[0])) / det
          const o = base * 3
          const P = player.positions
          return [0, 1, 2].map((k) =>
            P[o + k] + a * (P[o + 3 + k] - P[o + k]) + b * (P[o + 6 + k] - P[o + k]))
        }
        base += (poly.length - 2) * 3
      }
      throw new Error('sheet point not found')
    }
    // midpoints of the two former outer edges (on the kite2/kite creases)
    for (const pt of [[0.5, 0.79289322], [-0.5, -0.79289322]] as Vec2[]) {
      const w = worldOfSheet(pt)
      assert.ok(Math.abs(w[0] + w[1]) < 0.02,
        `thinned edge at (${pt}) should sit on the axis, got (${w.map((v) => v.toFixed(3))})`)
    }
    // After the inside reverse folds (beat 20.65, before the head tucks the
    // tip): the points swing up and out, each the reflection of the old tip
    // across its reverse line — the neck steeper (60°) than the tail (30°),
    // so the head end rises higher.
    player.step(kfFracsAt(20.65))
    const neckTip = worldOfSheet([0.985, 0.985])
    assert.ok(Math.hypot(neckTip[0] + 0.547, neckTip[1] - 1.238) < 0.04,
      `neck tip at (${neckTip.map((v) => v.toFixed(3))})`)
    const tailTip = worldOfSheet([-0.985, -0.985])
    assert.ok(Math.hypot(tailTip[0] + 1.238, tailTip[1] - 0.04) < 0.04,
      `tail tip at (${tailTip.map((v) => v.toFixed(3))})`)
    player.step(kfFracsAt(14.5))
  }

  const scene = views.get('scene')!
  assert.ok(scene.length > 0, 'rasterized to a frame cache')

  // Strain-solved paths throughout: petals and thinning stay under 0.2 per
  // rendered frame; the inside reverse folds — pop through the layers, then
  // press — flex a little more at the press's tightest moment.
  for (const f of scene.rows) {
    const beat = (f.frame as number) / 30 + 1
    if (beat <= 14.6) continue
    const fr: Record<string, number> = {}
    for (const g of program.groups) fr[g] = f[g] as number
    player.step(fr)
    const cap = beat <= 16 ? 0.45 : beat <= 18.5 ? 0.21 : 0.3
    assert.ok(stretchNow() < cap, `frame at beat ${beat.toFixed(2)}: stretch ${stretchNow().toFixed(3)}`)
  }
})

test('Origami Jumping Frog sample: waterbomb head, legs, sides, spring pleat', () => {
  // Same static-crease-table dialect as the crane: run the sample and check
  // every fold's end pose against the classic frog coordinates.
  const sample = SAMPLES.find((s) => s.name === 'Origami Jumping Frog')!
  const { views } = createRuntime({
    editableRows: (_name, _schema, seedRows) => seedRows ?? [],
  }).run(sample.code, { seed: 1 })

  const events = views.get('events')!
  const create = events.rows.find((r) => r.type === 'create')!
  assert.equal(create.shape, 'origami')
  const program = create.program as FoldProgram
  assert.deepEqual(program.groups,
    ['halve', 'horiz', 'diagB', 'diagA', 'legL', 'legR', 'sideL', 'sideR', 'bottomup', 'pleat'])
  assert.equal(program.warnings.length, 0, program.warnings.join('; '))

  const updates = events.rows.filter((r) => r.type === 'update' && typeof r.halve === 'number')
  const kfFracsAt = (beat: number): Record<string, number> => {
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
  const player = createFoldPlayer(program)
  player.step({})
  const flat = Float32Array.from(player.positions)
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
  const zExtent = (): number => {
    let lo = Infinity
    let hi = -Infinity
    for (let i = 2; i < player.positions.length; i += 3) {
      lo = Math.min(lo, player.positions[i])
      hi = Math.max(hi, player.positions[i])
    }
    return hi - lo
  }

  // Every fold ends FLAT and strain-free: after the halve, the collapse,
  // each leg, each side, the bottom-up and the pleat.
  for (const beat of [2.5, 5, 6.6, 7.9, 9, 10, 11.4, 12.7]) {
    player.step(kfFracsAt(beat))
    assert.ok(stretchNow() < 0.01, `beat ${beat}: fold end strained (${stretchNow().toFixed(4)})`)
    assert.ok(zExtent() < 0.05, `beat ${beat}: fold end not flat (z ${zExtent().toFixed(3)})`)
  }

  // The classic landmarks at the finished frog: the loose top-mid corner
  // rides the leg folds to the apex; the square's bottom corners and the
  // bottom edge's midpoint all gather at the spring's tip.
  player.step(kfFracsAt(Infinity))
  const cornerPos = (pt: Vec2): number[] => {
    let base = 0
    for (const f of program.faces) {
      const j = f.poly.findIndex((p) => Math.hypot(p[0] - pt[0], p[1] - pt[1]) < 1e-6)
      if (j >= 0) {
        let tri: number
        let slot: number
        if (j === 0) { tri = 0; slot = 0 } else if (j <= f.poly.length - 2) { tri = j - 1; slot = 1 } else { tri = j - 2; slot = 2 }
        const o = (base + tri * 3 + slot) * 3
        return [player.positions[o], player.positions[o + 1], player.positions[o + 2]]
      }
      base += (f.poly.length - 2) * 3
    }
    throw new Error(`corner ${pt} not found`)
  }
  const near2 = (a: number[], b: [number, number]): boolean =>
    Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.02
  assert.ok(near2(cornerPos([0, 1]), [0.5, 0.5]), `apex at ${cornerPos([0, 1])}`)
  for (const pt of [[0, -1], [1, -1], [-1, -1]] as Vec2[]) {
    assert.ok(near2(cornerPos(pt), [0.5, -0.5]), `spring tip ${pt} at ${cornerPos(pt)}`)
  }

  // Mid-fold the paper lerps (no solved rigid paths): bounded flex.
  const scene = views.get('scene')!
  for (const f of scene.rows) {
    const fr: Record<string, number> = {}
    for (const g of program.groups) fr[g] = f[g] as number
    player.step(fr)
    assert.ok(stretchNow() < 0.4, `frame ${f.frame}: flex ${stretchNow().toFixed(3)}`)
  }
})
