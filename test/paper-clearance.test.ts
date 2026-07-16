import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compileFoldTable, foldTablePositions } from '../src/fold-engine.js'
import { clearanceAt } from './util/clearance.js'

// Paper must not pass through paper — where zero-thickness folding makes
// contact unavoidable it must stay too shallow to read as mess: no face pair
// deeper than 4.5 stack thicknesses (grazes sit well below; a plunging solver
// measures ~9), and exactly-coincident faces only momentarily, never
// persistently. The sweep measures what the renderer draws: solved positions
// plus each face's layer offset.

const CRANE_ROWS = [
  { step: 'diag', p1: '0,0', p2: '1,1', move: '0.667,0.333', at: 1 },
  { step: 'collapse1', p1: '0,0.5', p2: '1,0.5', move: '0.333,0.167', kind: 'reverse', at: 2 },
  { step: 'collapse2', p1: '0.5,0', p2: '0.5,1', move: '0.833,0.667', kind: 'reverse', at: 3 },
  { step: 'collapse3', p1: '0,1', p2: '0.4142135624,0', move: '0.667,0.069036', kind: 'reverse', at: 4 },
  { step: 'collapse4', p1: '0,1', p2: '1,0.5857864376', move: '0.930964,0.667', kind: 'reverse', at: 5 },
  { step: 'flatten', p1: '0,0.2928932188', p2: '0.7071067812,1', move: '0.930964,0.333', at: 6 },
  { step: 'tuck1', p1: '0,1', p2: '0.4142135624,0', move: '0.069036,0.667', kind: 'reverse', at: 7 },
  { step: 'tuck2', p1: '0,1', p2: '1,0.5857864376', move: '0.667,0.930964', kind: 'reverse', at: 8 },
  { step: 'kite1', p1: '0,1', p2: '0.6681786379,0', move: '0.525373,0.274808', pick: 1, at: 9 },
  { step: 'kite2', p1: '0,1', p2: '1,0.3318213621', move: '0.897812,0.667', at: 10 },
  { step: 'turn', p1: '0,0.2928932188', p2: '0.7071067812,1', move: '0.333,0.930964', at: 11 },
  { step: 'kite3', p1: '0,1', p2: '1,0.3318213621', move: '0.667,0.897812', pick: 1, at: 12 },
  { step: 'kite4', p1: '0,1', p2: '0.6681786379,0', move: '0.208238,0.583899', pick: 1, at: 13 },
  { step: 'neck', p1: '0.1345593806,0', p2: '0.4733251916,1', move: '0.906033,0.694263', kind: 'reverse', at: 14 },
  { step: 'tail', p1: '0,0.5266748083', p2: '1,0.8654406193', move: '0.246505,0.203815', kind: 'reverse', at: 15 },
  { step: 'head', p1: '0,0.1274716613', p2: '1,0.8431274379', move: '0.096435,0.080352', kind: 'reverse', at: 16 },
  { step: 'wings', p1: '0,0.1414213562', p2: '0.8585786438,1', move: '0.858,0.377;0.377,0.858', at: 17, dur: 1.5, to: 0.5 },
]

const CICADA_ROWS = [
  { step: 'half', p1: '0,0', p2: '1,1', move: '0.667,0.333', at: 1 },
  { step: 'cornerL', p1: '0,0.5', p2: '1,0.5', move: '0.1,0.3;0.3,0.1', at: 2 },
  { step: 'cornerR', p1: '0.5,0', p2: '0.5,1', move: '0.6,0.8;0.8,0.6', at: 3 },
  { step: 'wingL', p1: '0.19885,0.598479', p2: '1.001892,0.99618', move: '0.03,0.12;0.12,0.03', at: 4 },
  { step: 'wingR', p1: '0.401521,0.80115', p2: '0.00382,-0.001892', move: '0.88,0.97;0.97,0.88', at: 5 },
  { step: 'head1', p1: '-0.19,0.59', p2: '0.41,1.19', move: '0.97,0.03', at: 6 },
  { step: 'head2', p1: '-0.24,0.64', p2: '0.36,1.24', move: '0.03,0.97', at: 7 },
  { step: 'tuckL', p1: '0.09,0.59', p2: '0.39,0.29', move: '0.05,0.55', at: 8 },
  { step: 'tuckR', p1: '0.41,0.91', p2: '0.71,0.61', move: '0.45,0.95', at: 9 },
]

const SAMPLES_PER_STEP = 12
const DEPTH_CAP_STACKS = 4.5
const SHIMMER_AREA = 0.04     // 1% of the unit-square paper (display area 4)
const SHIMMER_RUN = 2         // consecutive sampled frames

const sweepModel = (name: string, rows: Record<string, unknown>[]): void => {
  const program = compileFoldTable(rows, { size: 1 })
  const stack = program.gap * program.maxLayer
  for (let k = 0; k < program.steps.length; ++k) {
    const step = program.steps[k]
    let run = 0
    for (let i = 1; i < SAMPLES_PER_STEP; ++i) {
      const fold = k + (i / SAMPLES_PER_STEP) * step.to
      const c = clearanceAt(program, fold, { shearGapFrac: 0.005 })
      assert.ok(c.depth <= DEPTH_CAP_STACKS * stack,
        `${name} step "${step.name}" fold ${fold.toFixed(3)}: paper plunges ${(c.depth / stack).toFixed(1)}x stack (pair ${c.worstPair})`)
      run = c.shearArea > SHIMMER_AREA ? run + 1 : 0
      assert.ok(run <= SHIMMER_RUN,
        `${name} step "${step.name}" fold ${fold.toFixed(3)}: coincident faces persist for ${run} frames (area ${c.shearArea.toFixed(3)})`)
    }
  }
}

test('crane playback keeps paper out of paper', () => {
  sweepModel('crane', CRANE_ROWS)
})

test('cicada playback keeps paper out of paper', () => {
  sweepModel('cicada', CICADA_ROWS)
})

test('the deep reverse folds keep their baked mechanism motion', () => {
  // the depth cap alone would pass if everything silently fell back to rigid
  // swings; pin the routing so paper-true motion cannot regress unnoticed
  const program = compileFoldTable(CRANE_ROWS, { size: 1 })
  for (const name of ['collapse1', 'collapse2', 'collapse3', 'collapse4', 'neck', 'tail', 'head']) {
    const step = program.steps.find((s) => s.name === name)!
    assert.ok(step.soft, `step "${name}" has baked motion`)
  }
  for (const name of ['neck', 'tail', 'head']) {
    const step = program.steps.find((s) => s.name === name)!
    assert.ok(step.soft!.zDirs, `step "${name}" bakes the mechanism (offsets ride the paper)`)
  }
})

test('table folding: parity chains across steps and starts face-up', () => {
  for (const rows of [CRANE_ROWS, CICADA_ROWS]) {
    const program = compileFoldTable(rows, { size: 1 })
    let parity = 0
    for (const step of program.steps) {
      assert.equal(step.flipFrom, parity, `step "${step.name}" starts at the running parity`)
      assert.ok(step.flipTo === step.flipFrom || step.flipTo === (step.flipFrom ^ 1))
      parity = step.flipTo
    }
    // mechanism steps never flip: they open upward off the anchored cover
    for (const step of program.steps) {
      if (step.soft?.zDirs) assert.equal(step.flipFrom, step.flipTo, `mech step "${step.name}" does not flip`)
    }
  }
})

test('a fold whose flap hinge leaves the line is rejected, not stretched', () => {
  // the cicada wing rows as first authored: the crease misses the corner
  // where the flap boundary meets static paper by 0.05 — the old engine
  // silently stretched a static face 11% to absorb it
  const rows = [
    { step: 'half', p1: '0,0', p2: '1,1', move: '0.667,0.333', at: 1 },
    { step: 'cornerL', p1: '0,0.5', p2: '1,0.5', move: '0.1,0.3;0.3,0.1', at: 2 },
    { step: 'cornerR', p1: '0.5,0', p2: '0.5,1', move: '0.6,0.8;0.8,0.6', at: 3 },
    { step: 'wingL', p1: '0.159099,0.628769', p2: '0.901561,0.946967', move: '0.03,0.12;0.12,0.03', at: 4 },
  ]
  assert.throws(() => compileFoldTable(rows, { size: 1 }), /hinge leaves the fold line/)
})


// displayed worst edge stretch across a step's swing — piecewise keyframe
// wobble and seam tears show up here
const displayedStrain = (rows: Record<string, unknown>[], name: string): number => {
  const program = compileFoldTable(rows, { size: 1 })
  const k = program.steps.findIndex((s) => s.name === name)
  const step = program.steps[k]
  const edges: [number, number, number][] = []
  const seen = new Set<string>()
  for (const F of step.FV) {
    for (let i = 0, j = F.length - 1; i < F.length; j = i++) {
      const key = F[i] < F[j] ? `${F[i]}:${F[j]}` : `${F[j]}:${F[i]}`
      if (seen.has(key)) continue
      seen.add(key)
      const rest = Math.hypot(step.Vfrom[F[i]][0] - step.Vfrom[F[j]][0], step.Vfrom[F[i]][1] - step.Vfrom[F[j]][1])
      if (rest > 1e-9) edges.push([F[i], F[j], rest])
    }
  }
  let worst = 0
  for (let i = 1; i < 24; ++i) {
    const { pos } = foldTablePositions(program, k + (i / 24) * step.to)
    for (const [a, b, rest] of edges) {
      const len = Math.hypot(pos[a][0] - pos[b][0], pos[a][1] - pos[b][1], pos[a][2] - pos[b][2])
      worst = Math.max(worst, Math.abs(len - rest) / rest)
    }
  }
  return worst
}

test('mechanism swings are smooth and clear (the beat-5.5 class of artifact)', () => {
  // two user-reported artifacts on collapse4's swing that the coarse sweep
  // missed: keyframe-lerp wobble (visible shiver) and persistent grazing
  // crossings from display offsets shearing along different assembly directions
  const program = compileFoldTable(CRANE_ROWS, { size: 1 })
  const stack = program.gap * program.maxLayer
  for (const name of ['collapse4', 'neck']) {
    assert.ok(displayedStrain(CRANE_ROWS, name) < 0.02,
      `${name}: exact mechanism plays without wobble`)
  }
  for (const name of ['tail', 'head']) {
    assert.ok(displayedStrain(CRANE_ROWS, name) < 0.35,
      `${name}: capped mechanism stays within its bending budget`)
  }
  for (let k = 0; k < program.steps.length; ++k) {
    const step = program.steps[k]
    if (!step.soft?.zDirs || step.FV.length > 20) continue
    let worst = 0
    for (let i = 1; i < 24; ++i) {
      worst = Math.max(worst, clearanceAt(program, k + (i / 24) * step.to).depth)
    }
    assert.ok(worst <= 0.35 * stack,
      `${name(step)}: shallow mechanism crossings stay in the graze range (${(worst / stack).toFixed(2)}x stack)`)
  }
  function name(s: { name: string }): string { return s.name }
})
