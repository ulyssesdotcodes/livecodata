import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  compileFolds, createFoldPlayer,
  type FoldProgram, type Vec2,
} from '../src/origami.js'

// World position of a material sheet point as carried by the face containing
// `probe` (welded, so coincident copies agree unless the pose is impossible).
function cornerPos(program: FoldProgram, positions: Float32Array, probe: Vec2, pt: Vec2): number[] {
  const fi = program.faces.findIndex((f) => {
    for (let i = 0; i < f.poly.length; i++) {
      const a = f.poly[i]
      const b = f.poly[(i + 1) % f.poly.length]
      if ((b[0] - a[0]) * (probe[1] - a[1]) - (b[1] - a[1]) * (probe[0] - a[0]) < -1e-7) return false
    }
    return true
  })
  assert.ok(fi >= 0, `no face contains probe ${probe}`)
  let base = 0
  for (let i = 0; i < fi; i++) base += (program.faces[i].poly.length - 2) * 3
  const f = program.faces[fi]
  for (let i = 1; i + 1 < f.poly.length; i++) {
    const tri = [f.poly[0], f.poly[i], f.poly[i + 1]]
    for (let k = 0; k < 3; k++) {
      if (Math.hypot(tri[k][0] - pt[0], tri[k][1] - pt[1]) < 1e-7) {
        const o = (base + (i - 1) * 3 + k) * 3
        return [positions[o], positions[o + 1], positions[o + 2]]
      }
    }
  }
  throw new Error(`corner ${pt} not on the face containing ${probe}`)
}

const near = (a: number[], b: number[], eps: number): boolean =>
  Math.hypot(a[0] - b[0], a[1] - b[1], (a[2] ?? 0) - (b[2] ?? 0)) < eps

// ── The static compiler ───────────────────────────────────────────────────────

test('one crease row cuts the sheet and folds exactly what it names', () => {
  const { program, schedule } = compileFolds([
    { step: 'half', p1: '0,-1', p2: '0,1', move: '0.5,0', sign: 1, deg: 180, at: 1, dur: 2, to: 1 },
  ])
  assert.equal(program.warnings.length, 0, program.warnings.join('; '))
  assert.equal(program.faces.length, 2)
  assert.deepEqual(program.groups, ['half'])
  assert.deepEqual(schedule, [{ fold: 'half', at: 1, dur: 2, to: 1, ease: undefined }])

  const player = createFoldPlayer(program)
  player.step({ half: 1 })
  // The right half lands mirrored onto the left; the fold line stays put.
  assert.ok(near(cornerPos(program, player.positions, [0.5, 0], [1, -1]), [-1, -1, 0], 0.02))
  assert.ok(near(cornerPos(program, player.positions, [-0.5, 0], [-1, 1]), [-1, 1, 0], 0.001))
  assert.ok(near(cornerPos(program, player.positions, [0.5, 0], [0, 1]), [0, 1, 0], 0.001))
})

test('rows sharing a step are one fold across layers, each crease with its own turning sense', () => {
  // Fold the sheet in half, then one fold whose crease runs through BOTH
  // layers of the stack. Each layer's crease gets its own row; `sign` sets
  // which way that crease turns for positive fractions (flipping it is the
  // same as swapping p1/p2) — set so the stacked flaps move together
  // instead of tearing apart.
  const { program } = compileFolds([
    { step: 'half', p1: '0,-1', p2: '0,1', move: '0.5,0', sign: 1, deg: 180, at: 1, dur: 1, to: 1 },
    { step: 'quarter', p1: '-0.5,-1', p2: '-0.5,1', move: '-0.75,0', sign: 1, deg: 90, at: 2, dur: 1, to: 1 },
    { step: 'quarter', p1: '0.5,-1', p2: '0.5,1', move: '0.75,0', sign: 1 },
  ])
  assert.equal(program.warnings.length, 0, program.warnings.join('; '))
  assert.equal(program.groups.length, 2)
  const q = program.steps.find((s) => s.group === 'quarter')!
  assert.equal(q.spans.length, 2)
  assert.deepEqual(q.spans.map((sp) => sp.sign), [1, 1])

  const player = createFoldPlayer(program)
  player.step({ half: 1, quarter: 1 })
  // Material corner (-1,1) — the front layer's outer corner — stands up…
  const front = cornerPos(program, player.positions, [-0.9, 0.5], [-1, 1])
  assert.ok(Math.abs(front[2]) > 0.4, `front layer stands, z=${front[2]}`)
  // …and the mirrored layer's corner (material (1,1), stacked onto it by
  // `half`) goes the same world direction: the flaps stay together.
  const back = cornerPos(program, player.positions, [0.9, 0.5], [1, 1])
  assert.ok(near(front, back, 0.05), `layers stay together: ${front} vs ${back}`)
})

test('keyframe rows re-drive a step; unknown names warn', () => {
  const { program, schedule } = compileFolds([
    { step: 'half', p1: '0,-1', p2: '0,1', move: '0.5,0', sign: 1, deg: 180, at: 1, dur: 1, to: 1 },
    { step: 'half', at: 3, dur: 1, to: 0 },
    { step: 'nope', at: 4, dur: 1, to: 1 },
  ])
  assert.deepEqual(schedule.map((r) => [r.fold, r.at, r.to]), [['half', 1, 1], ['half', 3, 0]])
  assert.equal(program.warnings.length, 1, program.warnings.join('; '))
  assert.ok(program.warnings[0].includes('nope'))
})

test('points are built from the square and earlier rows; construction lines fold nothing', () => {
  // A construction line (no move) cuts nothing but can be referenced —
  // folding as construction: the diagonal's midpoint IS the sheet's centre.
  const { program } = compileFolds([
    { step: 'diag', p1: 'bottom@0', p2: 'top@1' },
    { step: 'half', p1: 'diag@0.5', p2: 'top@0.5', move: '0.5,0.5', sign: 1, deg: 180, at: 1, dur: 1, to: 1 },
  ])
  assert.deepEqual(program.groups, ['half'])
  assert.equal(program.faces.length, 2)
  const sp = program.steps[0].spans[0]
  assert.deepEqual([sp.a, sp.b], [[0, 0], [0, 1]])
  // …and the flat-fold check correctly flags this toy: one crease ending
  // mid-sheet is an odd interior vertex — it cannot fold flat.
  assert.equal(program.warnings.length, 1, program.warnings.join('; '))
  assert.ok(program.warnings[0].includes('odd vertex'))
  // Referencing a name that doesn't exist yet names the knowns.
  assert.throws(() => compileFolds([
    { step: 'x', p1: 'later@0.5', p2: 'top@0.5', move: '0,0', at: 1, dur: 1, to: 1 },
  ]), /no edge or earlier row named "later"/)
})

test('typos in point references fail loudly, never silently changing a row', () => {
  // Object.prototype members are not edges…
  assert.throws(() => compileFolds([
    { step: 'x', p1: 'constructor@0.5', p2: 'top@0.5', move: '0,0.5', at: 1, dur: 1, to: 1 },
  ]), /no edge or earlier row named "constructor"/)
  // …and a line legitimately named like one is still referenceable.
  {
    const { program } = compileFolds([
      { step: 'toString', p1: 'bottom@0', p2: 'top@1' },
      { step: 'x', p1: 'toString@0.5', p2: 'top@0', move: '-0.5,0.6', sign: 1, deg: 180, at: 1, dur: 1, to: 0 },
    ])
    assert.deepEqual(program.steps[0].spans[0].a, [0, 0])
    assert.deepEqual(program.steps[0].spans[0].b, [-1, 1])
  }
  // A bare name without "@t" is not a valid point — and must NOT silently
  // turn a crease row into a keyframe row.
  assert.throws(() => compileFolds([
    { step: 'half', p1: '0,-1', p2: '0,1', move: '0.5,0', sign: 1, deg: 180, at: 1, dur: 1, to: 1 },
    { step: 'half', p1: 'bottom', p2: 'top', at: 3, dur: 1, to: 0 },
  ]), /did you mean "bottom@t"/)
  // Trailing text after the fraction is an error, not silently dropped.
  assert.throws(() => compileFolds([
    { step: 'diag', p1: 'bottom@0', p2: 'top@1' },
    { step: 'x', p1: 'diag@0.5@junk', p2: 'top@0', move: '-0.5,0.6', at: 1, dur: 1, to: 1 },
  ]), /bad fraction/)
  // A malformed move (space for comma) throws — it must NOT silently
  // reclassify the row as a construction line.
  assert.throws(() => compileFolds([
    { step: 'half', p1: '0,-1', p2: '0,1', move: '0.5 0.5', sign: 1, deg: 180, at: 1, dur: 1, to: 1 },
  ]), /neither "name@t" nor "x,y"/)
  // Naming a fold like a sheet edge warns: "left@t" always means the edge.
  {
    const { program } = compileFolds([
      { step: 'left', p1: '0,-1', p2: '0,1', move: '-0.5,0', sign: 1, deg: 180, at: 1, dur: 1, to: 1 },
    ])
    assert.ok(program.warnings.some((w) => w.includes('named like a sheet edge')),
      program.warnings.join('; '))
  }
})

test('flat-foldability is checked statically: Kawasaki and Maekawa at interior vertices', () => {
  // The classic valid single-vertex fold: fold the square in half (the
  // through-crease's two rays share one sense), then fold the packet in
  // half — which creases the two layers with OPPOSITE senses. At the centre
  // the four 90° sectors satisfy Kawasaki and the senses come out 1-vs-3,
  // exactly Maekawa's ±2 — no warnings.
  const ok = compileFolds([
    { step: 'mid', p1: 'bottom@0.5', p2: 'top@0.5', move: '-0.5,0.5;-0.5,-0.5', sign: 1, deg: 180, at: 1, dur: 1, to: 1 },
    { step: 'front', p1: '0,0', p2: '1,0', move: '0.5,0.5', sign: 1, deg: -180, at: 2, dur: 1, to: 1 },
    { step: 'back', p1: '0,0', p2: '-1,0', move: '-0.5,0.5', sign: 1, deg: -180, at: 3, dur: 1, to: 1 },
  ]).program
  assert.equal(ok.warnings.length, 0, ok.warnings.join('; '))

  // Give both layers of the second fold the SAME sense (impossible on real
  // paper): Kawasaki still holds — the angles didn't move — but the senses
  // are now 2-vs-2 and Maekawa fails.
  const badMV = compileFolds([
    { step: 'mid', p1: 'bottom@0.5', p2: 'top@0.5', move: '-0.5,0.5;-0.5,-0.5', sign: 1, deg: 180, at: 1, dur: 1, to: 1 },
    { step: 'front', p1: '0,0', p2: '1,0', move: '0.5,0.5', sign: 1, deg: -180, at: 2, dur: 1, to: 1 },
    { step: 'back', p1: '0,0', p2: '-1,0', move: '-0.5,0.5', sign: 1, deg: 180, at: 3, dur: 1, to: 1 },
  ]).program
  assert.ok(badMV.warnings.some((w) => w.includes('Maekawa')), badMV.warnings.join('; '))
  assert.ok(!badMV.warnings.some((w) => w.includes('Kawasaki')), badMV.warnings.join('; '))

  // Skew one crease off the right angle: the alternating angles no longer
  // cancel — Kawasaki fails.
  const badK = compileFolds([
    { step: 'mid', p1: 'bottom@0.5', p2: 'top@0.5', move: '-0.5,0.5;-0.5,-0.5', sign: 1, deg: 180, at: 1, dur: 1, to: 1 },
    { step: 'front', p1: '0,0', p2: '1,0', move: '0.5,0.5', sign: 1, deg: -180, at: 2, dur: 1, to: 1 },
    { step: 'back', p1: '0,0', p2: '-1,0.4', move: '-0.5,0.5', sign: 1, deg: -180, at: 3, dur: 1, to: 1 },
  ]).program
  assert.ok(badK.warnings.some((w) => w.includes('Kawasaki')), badK.warnings.join('; '))

  // Open creases (final 0) drop out of the pattern: fold and unfold a
  // half-crease — no vertex remains, no warning.
  const undone = compileFolds([
    { step: 'a', p1: 'top@0.5', p2: '0,0', move: '0.5,0.5', sign: 1, deg: 180, at: 1, dur: 1, to: 1 },
    { step: 'a', at: 3, dur: 1, to: 0 },
  ]).program
  assert.equal(undone.warnings.length, 0, undone.warnings.join('; '))
})

test('a geometry-only row (dur 0) writes the crease but schedules nothing', () => {
  const { program, schedule } = compileFolds([
    { step: 'a', p1: '0,-1', p2: '0,1', move: '0.5,0', sign: 1, deg: 180, at: 1, dur: 1, to: 1 },
    { step: 'a', p1: '-1,0', p2: '0,0', move: '-0.5,-0.5', sign: -1 },
  ])
  assert.equal(schedule.length, 1)
  assert.equal(program.steps[0].spans.length, 2)
})

// ── The crane spec (the sample's static table, minus timing sugar) ───────────

// The crane's crease table, every point built from the square's edges and
// earlier folds (construction lines diag/vm/hm carry the referenced points).
const CRANE: Record<string, unknown>[] = [
  { step: 'diag', p1: 'bottom@0', p2: 'top@1' },
  { step: 'vm', p1: 'bottom@0.5', p2: 'top@0.5' },
  { step: 'hm', p1: 'left@0.5', p2: 'right@0.5' },
  { step: 'spine', p1: 'diag@0.5', p2: 'diag@1', move: '0.5286,0.3333', sign: 1, deg: 180 },
  { step: 'still', p1: 'diag@0', p2: 'diag@0.5', move: '-0.3333,-0.5286', sign: 1, deg: 180 },
  { step: 's1', p1: 'vm@0.7928932188', p2: 'diag@0.5', move: '0.3333,0.5286', sign: 1, deg: 180 },
  { step: 's1', p1: 'hm@0.7928932188', p2: 'diag@0.5', move: '0.5286,0.3333', sign: -1 },
  { step: 'hv', p1: 'bottom@1', p2: 'diag@0.5', move: '0.2929,-0.0976', sign: -1, deg: 90 },
  { step: 's2', p1: 'hm@0.2071067812', p2: 'diag@0.5', move: '-0.5286,-0.3333', sign: 1, deg: -180 },
  { step: 's2', p1: 'vm@0.2071067812', p2: 'diag@0.5', move: '-0.3333,-0.5286', sign: -1 },
  { step: 'kite', p1: 'top@0', p2: 's2@0', move: '-0.8619,0.3333', sign: 1, deg: -180 },
  { step: 'kite', p1: 'bottom@0', p2: 's2@0', move: '-0.8619,-0.3333', sign: -1 },
  { step: 'kite2', p1: 'top@1', p2: 's1@0', move: '0.3333,0.8619', sign: -1, deg: 180 },
  { step: 'kite2', p1: 'top@0', p2: 's1@0', move: '-0.3333,0.8619', sign: 1 },
  { step: 'petal', p1: 's2@0', p2: 's1@0', move: '-0.5286,0.5286', sign: 1, deg: 180 },
  { step: 'peelfr', p1: 'top@0.5', p2: 's1@0', move: '0.3333,0.8619', sign: 1, deg: 180 },
  { step: 'peelfl', p1: 'left@0.5', p2: 's2@0', move: '-0.8619,-0.3333', sign: 1, deg: -180 },
  { step: 'kite3', p1: 'bottom@0', p2: 'vm@0.2071067812', move: '-0.3333,-0.8619', sign: 1, deg: -180 },
  { step: 'kite3', p1: 'bottom@1', p2: 'vm@0.2071067812', move: '0.3333,-0.8619', sign: -1 },
  { step: 'kite4', p1: 'bottom@1', p2: 'hm@0.7928932188', move: '0.8619,-0.3333', sign: -1, deg: 180 },
  { step: 'kite4', p1: 'top@1', p2: 'hm@0.7928932188', move: '0.8619,0.3333', sign: 1 },
  { step: 'petal2', p1: 'vm@0.2071067812', p2: 'hm@0.7928932188', move: '0.4310,-0.6262;0.6262,-0.4310', sign: -1, deg: 180 },
  { step: 'peelbr', p1: 'right@0.5', p2: 'hm@0.7928932188', move: '0.8619,0.3333', sign: -1, deg: 180 },
  { step: 'peelbl', p1: 'bottom@0.5', p2: 'vm@0.2071067812', move: '-0.3333,-0.8619', sign: -1, deg: -180 },
]


// The finished square base, point down: the collapse's flat endpoint.
const BASE_FRACS: Record<string, number> = {
  spine: -1, still: -1, s1: -1, hv: 0, s2: -1,
  peelfr: -1, peelfl: -1, peelbr: -1, peelbl: -1,
}
// The petals lift front then back; each lift unfolds its own side's ridge
// peels (they lie on the valley, so the flat endpoint leaves them open).
const BIRD_FRACS: Record<string, number> = {
  ...BASE_FRACS,
  kite: 1, kite2: 1, petal: 1, kite3: 1, kite4: 1, petal2: 1,
  peelfr: 0, peelfl: 0, peelbr: 0, peelbl: 0,
}

test('the crane spec folds the square base exactly, point down', () => {
  const { program } = compileFolds(CRANE)
  assert.equal(program.warnings.length, 0, program.warnings.join('; '))
  assert.equal(program.faces.length, 18)
  const player = createFoldPlayer(program)
  player.step(BASE_FRACS)
  const at = (probe: Vec2, pt: Vec2): number[] => cornerPos(program, player.positions, probe, pt)

  // All four paper corners gather on the base's open point, the edge
  // midpoints stack at the side corners, the centre is the closed corner.
  for (const [probe, corner] of [
    [[0.9, 0.97], [1, 1]], [[0.9, -0.8], [1, -1]], [[-0.9, -0.97], [-1, -1]], [[-0.85, 0.9], [-1, 1]],
  ] as [Vec2, Vec2][]) {
    assert.ok(near(at(probe, corner), [-1, 1, 0], 0.02), `corner ${corner} at ${at(probe, corner)}`)
  }
  assert.ok(near(at([0.2, 0.85], [0, 1]), [0, 1, 0], 0.02))
  assert.ok(near(at([0.85, 0.2], [1, 0]), [0, 1, 0], 0.02))
  assert.ok(near(at([-0.9, 0.2], [-1, 0]), [-1, 0, 0], 0.02))
  assert.ok(near(at([0.15, -0.85], [0, -1]), [-1, 0, 0], 0.02))
  assert.ok(near(at([-0.2, 0.1], [0, 0]), [0, 0, 0], 0.02))
  let zLo = Infinity
  let zHi = -Infinity
  for (let i = 2; i < player.positions.length; i += 3) {
    zLo = Math.min(zLo, player.positions[i])
    zHi = Math.max(zHi, player.positions[i])
  }
  assert.ok(zHi - zLo < 0.05, `square base is flat (z extent ${(zHi - zLo).toFixed(4)})`)
})

test('the petal folds are single folds: front lifts alone, then the back — the bird base, exactly', () => {
  const { program } = compileFolds(CRANE)
  const player = createFoldPlayer(program)
  const at = (probe: Vec2, pt: Vec2): number[] => cornerPos(program, player.positions, probe, pt)
  const TIP = [Math.SQRT2 - 1, 1 - Math.SQRT2, 0]
  const HINGE = [-(1 - Math.SQRT1_2), 1 - Math.SQRT1_2, 0]

  // After the FRONT petal alone (tutorial step 7): the front corner is up,
  // the back corner has not moved.
  player.step({ ...BIRD_FRACS, kite3: 0, kite4: 0, petal2: 0, peelbr: -1, peelbl: -1 })
  assert.ok(near(at([-0.85, 0.9], [-1, 1]), TIP, 0.02), `front tip at ${at([-0.85, 0.9], [-1, 1])}`)
  assert.ok(near(at([0.9, -0.8], [1, -1]), [-1, 1, 0], 0.03), `back corner still at ${at([0.9, -0.8], [1, -1])}`)

  // Both petals: the bird base. The petalled corners at the tip, the side
  // corners tucked onto the hinge, the middle flaps' corners — untouched by
  // either petal, exactly as in the paper sequence — still at the base's
  // point, and the packet flat again.
  player.step(BIRD_FRACS)
  assert.ok(near(at([-0.85, 0.9], [-1, 1]), TIP, 0.02))
  assert.ok(near(at([0.9, -0.8], [1, -1]), TIP, 0.02))
  for (const [probe, corner] of [[[0.9, 0.97], [1, 1]], [[-0.9, -0.97], [-1, -1]]] as [Vec2, Vec2][]) {
    assert.ok(near(at(probe, corner), [-1, 1, 0], 0.02), `middle corner ${corner} at ${at(probe, corner)}`)
  }
  for (const [probe, mid] of [
    [[-0.9, 0.2], [-1, 0]], [[0.2, 0.85], [0, 1]], [[0.85, 0.2], [1, 0]], [[0.15, -0.85], [0, -1]],
  ] as [Vec2, Vec2][]) {
    assert.ok(near(at(probe, mid), HINGE, 0.02), `side corner ${mid} at ${at(probe, mid)}`)
  }
  let zLo = Infinity
  let zHi = -Infinity
  for (let i = 2; i < player.positions.length; i += 3) {
    zLo = Math.min(zLo, player.positions[i])
    zHi = Math.max(zHi, player.positions[i])
  }
  assert.ok(zHi - zLo < 0.05, `bird base is flat (z extent ${(zHi - zLo).toFixed(4)})`)
})

test('poses are rigid where the spec is, flex boundedly where paper must bend, and scrub purely', () => {
  const { program } = compileFolds(CRANE)
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

  // Flat endpoints are exact (the welded sliver aside).
  player.step(BASE_FRACS)
  assert.ok(stretchNow() < 0.02, `square base closes (stretch ${stretchNow().toFixed(4)})`)
  player.step(BIRD_FRACS)
  assert.ok(stretchNow() < 0.02, `bird base closes (stretch ${stretchNow().toFixed(4)})`)

  // Mid-petal the paper bends (the petal fold is not rigid-foldable — the
  // middle layers slide in their pockets) but boundedly.
  for (const p of [0.25, 0.5, 0.75]) {
    player.step({ ...BASE_FRACS, kite: p, kite2: p, petal: p })
    assert.ok(stretchNow() < 0.6, `mid-petal flex bounded at ${p} (${stretchNow().toFixed(3)})`)
  }

  // A pose is a pure function of the fractions.
  player.step({ spine: 0.37, still: 0.37, s1: -0.9 })
  const a = Float32Array.from(player.positions)
  player.step(BIRD_FRACS)
  player.step({ spine: 0.37, still: 0.37, s1: -0.9 })
  assert.deepEqual(Float32Array.from(player.positions), a)
})

// ── DSL builder (spawn / sequence) ───────────────────────────────────────────

import { createDSL } from '../src/dsl.js'
import type { Row } from '../src/lineage.js'

const dsl = createDSL(null)

test('origami().spawn emits one create row with the program and zeroed groups', () => {
  const paper = dsl.origami().steps([
    { step: 'half', p1: '0,-1', p2: '0,1', move: '0.5,0', sign: 1, deg: 180, at: 1, dur: 2, to: 1 },
  ])
  const rows = paper.spawn({ id: 'sheet', color: 0x123456 }).rows
  assert.equal(rows.length, 1)
  const r = rows[0]
  assert.equal(r.id, 'sheet')
  assert.equal(r.type, 'create')
  assert.equal(r.shape, 'origami')
  assert.equal(r.half, 0)
  assert.equal(r.color, 0x123456)
  const program = r.program as { groups: string[]; faces: unknown[] }
  assert.deepEqual(program.groups, ['half'])
  assert.equal(program.faces.length, 2)
})

test('origami().steps timings become the default sequence', () => {
  const paper = dsl.origami().steps([
    { step: 'half', p1: '0,-1', p2: '0,1', move: '0.5,0', sign: 1, deg: 180, at: 1, dur: 2, to: 1 },
    // Timing-only row: re-drives the earlier fold by name (here: unfolds it).
    { step: 'half', at: 5, dur: 1, to: 0 },
  ])
  const seq = paper.sequence().rows
  const at = (beat: number): Row => seq.find((r) => r.beat === beat)!
  assert.equal(at(3).half, 1, 'folded after its ramp')
  assert.equal(at(6).half, 0, 'the timing-only row unfolds it again')
})

test('origami sequence bakes fold steps into all-group keyframes', () => {
  const paper = dsl.origami().steps([
    { step: 'a', p1: '0,-1', p2: '0,1', move: '0.5,0', sign: 1, deg: 180, at: 1, dur: 1, to: 1 },
  ])
  paper.spawn({ id: 'p' })
  const rows = paper.sequence([
    { fold: 'a', at: 1, dur: 2 },
    { fold: 'a', at: 4, dur: 1, to: 0.4, ease: 'easeInOut' },
  ]).rows
  const at = (beat: number): Row => rows.find((r) => r.beat === beat)!
  assert.equal(at(3).a, 1, 'folded fully first')
  assert.equal(at(4).a, 1, 'held until the refold starts')
  assert.equal(at(5).a, 0.4, 'ramps back down to the partial target')
  assert.equal(typeof at(5).ease, 'function', 'named ease resolved onto the keyframe')
})
