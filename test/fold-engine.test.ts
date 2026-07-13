import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  initialState, foldStep, lineThrough, animatedPositions, FoldError,
  type FoldOutcome, type FoldSpec, type FoldState, type Line, type Vec2,
} from '../src/fold-engine.js'

const near = (a: number, b: number, tol = 1e-9): boolean => Math.abs(a - b) < tol

test('initial state is one square face in a stable frame', () => {
  const st = initialState()
  assert.equal(st.FV.length, 1)
  assert.equal(st.V.length, 4)
  assert.deepEqual(st.sheet, st.V)
  assert.deepEqual(st.layers, [0])
  assert.deepEqual(st.FO, [])
})

test('diagonal fold: two faces, valid layer order, exact reflection', () => {
  const st = initialState()
  const out = foldStep(st, {
    line: lineThrough([0, 0], [1, 1]),
    move: [[0.9, 0.1]],
  })
  assert.equal(out.state.FV.length, 2)
  assert.equal(out.type, 'Pureland')
  assert.equal(out.nStates, 2) // flap above or below
  assert.equal(out.state.FO.length, 1)
  // the moved corner (1,0) lands on (0,1)
  const vi = out.state.sheet.findIndex((s) => near(s[0], 1) && near(s[1], 0))
  assert.ok(vi >= 0)
  assert.ok(near(out.state.V[vi][0], 0) && near(out.state.V[vi][1], 1))
  // sheet coords untouched by folding
  for (const s of out.state.sheet) {
    assert.ok(s[0] > -1e-9 && s[0] < 1 + 1e-9 && s[1] > -1e-9 && s[1] < 1 + 1e-9)
  }
})

test('animatedPositions: hinge swing from flat to the folded state', () => {
  const st = initialState()
  const out = foldStep(st, { line: lineThrough([0, 0], [1, 1]), move: [[0.9, 0.1]] })
  const at0 = animatedPositions(out, 0)
  const at1 = animatedPositions(out, 1)
  const mid = animatedPositions(out, 0.5)
  for (let i = 0; i < out.state.V.length; ++i) {
    // t=0 matches the pre-fold flat coords; t=1 matches the folded state
    assert.ok(near(at0[i][0], out.anim.Vfrom[i][0]) && near(at0[i][1], out.anim.Vfrom[i][1]))
    assert.ok(near(at0[i][2], 0) && near(at1[i][2], 0, 1e-6))
    assert.ok(near(at1[i][0], out.state.V[i][0], 1e-6) && near(at1[i][1], out.state.V[i][1], 1e-6))
  }
  // mid-swing the moving corner is out of plane, and edge lengths are rigid
  const vi = out.state.sheet.findIndex((s) => near(s[0], 1) && near(s[1], 0))
  assert.ok(Math.abs(mid[vi][2]) > 0.3)
  const d3 = (a: number[], b: number[]): number =>
    Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
  for (const F of out.state.FV) {
    for (let j = 0; j < F.length; ++j) {
      const a = F[j], b = F[(j + 1) % F.length]
      const rest = Math.hypot(
        out.anim.Vfrom[a][0] - out.anim.Vfrom[b][0],
        out.anim.Vfrom[a][1] - out.anim.Vfrom[b][1])
      for (const P of [at0, mid, at1]) {
        assert.ok(near(d3(P[a], P[b]), rest, 1e-9), 'edges must stay rigid mid-swing')
      }
    }
  }
})

test('single flap of a stack moves alone when its sheet marker is used', () => {
  let st = initialState()
  st = foldStep(st, { line: lineThrough([0, 0], [1, 1]), move: [[0.9, 0.1]] }).state
  st = foldStep(st, { line: lineThrough([0.5, 0.5], [0, 1]), move: [[0.05, 0.05]] }).state
  const out = foldStep(st, { line: lineThrough([0.25, 0.75], [0.5, 0.5]), move: [[0.02, 0.02]] })
  assert.equal(out.nStates, 1)
  // only faces containing the marked sheet region moved
  assert.ok(out.anim.moving.some(Boolean) && !out.anim.moving.every(Boolean))
})

test('verifier errors: bad marker, degenerate move sets, unknown kind', () => {
  const st = initialState()
  assert.throws(() => foldStep(st, {
    line: lineThrough([0, 0], [1, 1]), move: [[2.5, 2.5]],
  }), FoldError)
  // line misses the sheet: the only flap is the whole model
  assert.throws(() => foldStep(st, {
    line: lineThrough([2, 0], [2, 1]), move: [[0.5, 0.5]],
  }), FoldError)
  assert.throws(() => foldStep(st, {
    line: lineThrough([0, 0], [1, 1]), move: [[0.9, 0.1]], kind: 'Banana',
  }), FoldError)
})

// The 16 validated folds of the traditional crane (fold lines and flap
// markers extracted from line-folder's example sequence, MIT, and replayed
// exactly against it — see notes/origami-research.md §8).
const CRANE: { line: Line; move: Vec2[]; kind?: string; pick?: number }[] = [
  { line: [[0.7071067812, -0.7071067812], 0], move: [[0.666667, 0.333333]] },
  { line: [[0, 1], 0.5], move: [[0.333333, 0.166667]], kind: 'Inside Reverse' },
  { line: [[1, 0], 0.5], move: [[0.833333, 0.666667]], kind: 'Inside Reverse' },
  { line: [[0.9238795325, 0.3826834324], 0.3826834324], move: [[0.666667, 0.069036]], kind: 'Inside Reverse' },
  { line: [[0.3826834324, 0.9238795325], 0.9238795325], move: [[0.930964, 0.666667]], kind: 'Inside Reverse' },
  { line: [[0.7071067812, -0.7071067812], -0.2071067812], move: [[0.930964, 0.333333]] },
  { line: [[0.9238795325, 0.3826834324], 0.3826834324], move: [[0.069036, 0.666667]], kind: 'Inside Reverse' },
  { line: [[0.3826834324, 0.9238795325], 0.9238795325], move: [[0.666667, 0.930964]], kind: 'Inside Reverse' },
  { line: [[0.8314696123, 0.555570233], 0.555570233], move: [[0.525373, 0.274808]], pick: 1 },
  { line: [[0.555570233, 0.8314696123], 0.8314696123], move: [[0.897812, 0.666667]] },
  { line: [[-0.7071067812, 0.7071067812], 0.2071067812], move: [[0.333333, 0.930964]] },
  { line: [[0.555570233, 0.8314696123], 0.8314696123], move: [[0.666667, 0.897812]], pick: 1 },
  { line: [[-0.8314696123, -0.555570233], -0.555570233], move: [[0.208238, 0.583899]], pick: 1 },
  { line: [[0.94712842, -0.3208547274], 0.1274450135], move: [[0.906033, 0.694263]], kind: 'Inside Reverse' },
  { line: [[-0.3208547274, 0.94712842], 0.498828679], move: [[0.246505, 0.203815]], kind: 'Inside Reverse' },
  { line: [[-0.5819756983, 0.8132061772], 0.1036607424], move: [[0.096435, 0.080352]], kind: 'Inside Reverse' },
]
const CRANE_FACES = [2, 4, 6, 8, 10, 11, 13, 15, 20, 25, 26, 31, 36, 44, 52, 60]

test('the 16-fold crane sequence solves exactly, step by step', () => {
  let st = initialState()
  CRANE.forEach((spec, i) => {
    const out = foldStep(st, spec as FoldSpec)
    assert.equal(out.state.FV.length, CRANE_FACES[i], `step ${i + 1} face count`)
    assert.ok(out.state.layers.length === out.state.FV.length, `step ${i + 1} layers`)
    if (spec.kind !== undefined) assert.equal(out.type, spec.kind, `step ${i + 1} kind`)
    // hinge invariant: every vertex shared by a moving and a static face
    // lies on the fold line — the swing can never tear
    const owner: (boolean | undefined)[] = out.anim.Vfrom.map(() => undefined)
    const [u, d] = out.anim.line
    for (let fi = 0; fi < out.state.FV.length; ++fi) {
      for (const vi of out.state.FV[fi]) {
        if (owner[vi] === undefined) owner[vi] = out.anim.moving[fi]
        else if (owner[vi] !== out.anim.moving[fi]) {
          const h = out.anim.Vfrom[vi][0] * u[0] + out.anim.Vfrom[vi][1] * u[1] - d
          assert.ok(Math.abs(h) < 1e-9, `step ${i + 1}: hinge vertex off the axis`)
          owner[vi] = out.anim.moving[fi]
        }
      }
    }
    st = out.state
  })
  // the folded crane is a small flat model with a full layer stack
  assert.equal(st.FV.length, 60)
  assert.equal(new Set(st.layers).size, st.layers.length)
  // sheet coords still cover the unit square (nothing lost or distorted)
  for (const s of st.sheet) {
    assert.ok(s[0] > -1e-6 && s[0] < 1 + 1e-6 && s[1] > -1e-6 && s[1] < 1 + 1e-6)
  }
})
