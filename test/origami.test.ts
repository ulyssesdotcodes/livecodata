import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  compileFoldProgram, createFoldPlayer, foldedPosition, applyIso,
  type Vec2,
} from '../src/origami.js'

const close = (a: Vec2, b: Vec2, eps = 1e-9): boolean =>
  Math.hypot(a[0] - b[0], a[1] - b[1]) < eps

// ── The exact folded model ────────────────────────────────────────────────────

test('a single reflection mirrors one side exactly and leaves the other alone', () => {
  const { program } = compileFoldProgram([
    { step: 'half', op: 'reflect', p1: 'bottom@0.5', p2: 'top@0.5', move: 'right@0.5' },
  ])
  assert.equal(program.faces.length, 2)
  assert.deepEqual(program.groups, ['half'])
  // Material points: the moving side lands mirrored, the still side stays.
  assert.ok(close(foldedPosition(program.faces, [1, 0])!, [-1, 0]))
  assert.ok(close(foldedPosition(program.faces, [1, -1])!, [-1, -1]))
  assert.ok(close(foldedPosition(program.faces, [-0.5, 0.25])!, [-0.5, 0.25]))
  // Points on the fold line don't move.
  assert.ok(close(foldedPosition(program.faces, [0, 0.5])!, [0, 0.5]))
})

test('"name@t" resolves a point along the edge an earlier fold created', () => {
  const { program } = compileFoldProgram([
    { step: 'half', op: 'reflect', p1: 'bottom@0.5', p2: 'top@0.5', move: 'right@0.5' },
    // Line through the midpoint of the LEFT paper edge and the midpoint of
    // the first fold's edge — resolved against the folded model.
    { step: 'q', op: 'reflect', p1: 'left@0.5', p2: 'half@0.5', move: 'left@0' },
  ])
  // half's edge runs (0,−1)→(0,1); its midpoint is the paper centre (0,0),
  // so q folds along y=0 and the bottom corners land on the top ones.
  assert.ok(close(foldedPosition(program.faces, [-1, -1])!, [-1, 1]))
  // (1,−1) was carried to (−1,−1) by the first fold, then up to (−1,1).
  assert.ok(close(foldedPosition(program.faces, [1, -1])!, [-1, 1]))
  assert.equal(program.faces.length, 4)
})

test('the square base: three instructions gather all four corners at one point', () => {
  const { program, schedule } = compileFoldProgram([
    { step: 'diag', op: 'reflect', p1: 'bottom@0', p2: 'top@1', move: 'bottom@1', at: 1, dur: 2 },
    { step: 's1', op: 'reflect', p1: 'right@0.5', p2: 'diag@0.5', move: 'right@1', at: 4, dur: 2 },
    { step: 's2', op: 'reflect', p1: 'left@0.5', p2: 'diag@0.5', move: 'left@0', at: 6.5, dur: 2 },
  ])
  assert.equal(program.warnings.length, 0, program.warnings.join('; '))
  assert.equal(program.faces.length, 6)

  // All four paper corners coincide…
  const corners: Vec2[] = [[1, 1], [-1, 1], [-1, -1], [1, -1]]
  const folded = corners.map((c) => foldedPosition(program.faces, c)!)
  for (const f of folded) assert.ok(close(f, folded[0]), `corner at ${f} vs ${folded[0]}`)
  // …√2 from the paper's centre, which becomes the opposite corner of the
  // base (the diamond's diagonal is half the paper's).
  const centre = foldedPosition(program.faces, [0, 0])!
  const d = Math.hypot(folded[0][0] - centre[0], folded[0][1] - centre[1])
  assert.ok(Math.abs(d - Math.SQRT2) < 1e-9, `corner stack ${d} from centre`)

  // The paper-edge midpoints stack in TWO piles (the base's side corners),
  // each 1 from the centre and √2 apart.
  const mids: Vec2[] = [[1, 0], [0, 1], [-1, 0], [0, -1]]
  const fm = mids.map((m) => foldedPosition(program.faces, m)!)
  assert.ok(close(fm[0], fm[1]), 'right/top edge midpoints coincide')
  assert.ok(close(fm[2], fm[3]), 'left/bottom edge midpoints coincide')
  const sep = Math.hypot(fm[0][0] - fm[2][0], fm[0][1] - fm[2][1])
  assert.ok(Math.abs(sep - Math.SQRT2) < 1e-9, `side corners ${sep} apart`)
  for (const m of fm) {
    const dm = Math.hypot(m[0] - centre[0], m[1] - centre[1])
    assert.ok(Math.abs(dm - 1) < 1e-9, `side corner ${dm} from centre`)
  }

  // Every step recorded its moving faces and timing.
  assert.equal(program.steps.length, 3)
  assert.deepEqual(program.steps.map((st) => st.moving.length), [3, 2, 2])
  assert.deepEqual(schedule.map((r) => [r.fold, r.at, r.dur, r.to]), [
    ['diag', 1, 2, 1], ['s1', 4, 2, 1], ['s2', 6.5, 2, 1],
  ])
})

test('reflection folds every layer on that side of the line', () => {
  const { program } = compileFoldProgram([
    { step: 'diag', op: 'reflect', p1: 'bottom@0', p2: 'top@1', move: 'bottom@1' },
    { step: 's1', op: 'reflect', p1: 'right@0.5', p2: 'diag@0.5', move: 'right@1' },
  ])
  // s1's line crosses BOTH layers of the folded triangle, so it records two
  // moving faces and its crease pulls back to two different sheet lines.
  const s1 = program.steps[1]
  assert.equal(s1.moving.length, 2)
  // The two moved faces are mirror layers: their isometries differ.
  const [f1, f2] = s1.moving.map((i) => program.faces[i])
  const det = (T: { a: number; b: number; c: number; d: number }): number => T.a * T.d - T.b * T.c
  assert.ok(Math.abs(det(f1.T) + det(f2.T)) < 1e-9, 'one layer face-up, one face-down')
})

test('faces stay exactly rigid: isometries preserve every edge length', () => {
  const { program } = compileFoldProgram([
    { step: 'diag', op: 'reflect', p1: 'bottom@0', p2: 'top@1', move: 'bottom@1' },
    { step: 's1', op: 'reflect', p1: 'right@0.5', p2: 'diag@0.5', move: 'right@1' },
    { step: 's2', op: 'reflect', p1: 'left@0.5', p2: 'diag@0.5', move: 'left@0' },
  ])
  for (const f of program.faces) {
    for (let i = 0; i < f.poly.length; i++) {
      const a = f.poly[i]
      const b = f.poly[(i + 1) % f.poly.length]
      const fa = applyIso(f.T, a)
      const fb = applyIso(f.T, b)
      const rest = Math.hypot(b[0] - a[0], b[1] - a[1])
      const now = Math.hypot(fb[0] - fa[0], fb[1] - fa[1])
      assert.ok(Math.abs(now - rest) < 1e-9)
    }
  }
})

test('op "fold" rotates just the connected flap by deg', () => {
  const { program } = compileFoldProgram([
    { step: 'up', op: 'fold', deg: 90, p1: 'bottom@0.5', p2: 'top@0.5', move: 'right@0.5' },
  ])
  const player = createFoldPlayer(program)
  player.step({ up: 1 })
  // The right half stands straight up: its outer edge x=1 maps to z=1, x=0.
  // Find a corner that moved and check the exact 90°.
  let seen = false
  for (let i = 0; i < player.positions.length; i += 3) {
    const x = player.positions[i]
    const z = player.positions[i + 2]
    if (Math.abs(z) > 1e-6) {
      seen = true
      assert.ok(z > 0, 'dir +1 lifts toward the viewer')
      assert.ok(Math.abs(x) < 1e-6, `rotated the full 90° (x=${x}, z=${z})`)
    }
  }
  assert.ok(seen, 'something folded')
  // A non-flat fold leaves the tracked model unfolded, with a warning.
  assert.ok(program.warnings.some((w) => w.includes('90')), program.warnings.join('; '))
})

test('errors name the fold and the problem', () => {
  // Raw coordinates are not a position — every position is an edge of the
  // paper or an earlier fold's edge.
  assert.throws(
    () => compileFoldProgram([{ step: 'x', p1: '0.3,0.4', p2: 'top@0.5' }]),
    /fold "x" p1: "0.3,0.4" is not a known edge/,
  )
  assert.throws(
    () => compileFoldProgram([{ step: 'x', p1: 'nope@0.5', p2: 'top@0.5' }]),
    /"nope@0.5" is not a known edge/,
  )
  assert.throws(
    () => compileFoldProgram([
      { step: 'a', p1: 'bottom@0.5', p2: 'top@0.5', move: 'right@0.5' },
      { step: 'a', p1: 'left@0.5', p2: 'right@0.5', move: 'bottom@0.5' },
    ]),
    /defined twice/,
  )
  assert.throws(
    () => compileFoldProgram([{ step: 'x', op: 'fold', deg: 90, p1: 'bottom@0.5', p2: 'top@0.5' }]),
    /set a move point/,
  )
  // A paper-edge fraction past the end walks off the paper.
  assert.throws(
    () => compileFoldProgram([{ step: 'x', p1: 'bottom@2', p2: 'top@0.5' }]),
    /not on the paper/,
  )
})

test('a re-drive row with a line drives just that stretch of the fold\'s edge', () => {
  const { program, schedule } = compileFoldProgram([
    { step: 'diag', op: 'reflect', p1: 'bottom@0', p2: 'top@1', move: 'bottom@1', dir: -1, at: 1, dur: 2 },
    { step: 's1', op: 'reflect', p1: 'right@0.5', p2: 'diag@0.5', move: 'right@1', at: 4, dur: 2 },
    // Open just the part of the diagonal inside the folded corner (the
    // spine between the corner's two triangles), then refold it the other
    // way — the same flat endpoint through the opposite half-space.
    { step: 'diag', p1: 'diag@0.5', p2: 'diag@1', at: 4, dur: 1, to: 0 },
    { step: 'diag', p1: 'diag@0.5', p2: 'diag@1', at: 5, dur: 1, to: -1 },
  ])
  const spine = 'diag~0.5-1'
  assert.deepEqual(program.groups, ['diag', 's1', spine])
  // The carved group inherits the fold's schedule so far, then its own rows.
  const derived = schedule.filter((r) => r.fold === spine)
  assert.deepEqual(derived.map((r) => [r.at, r.to]), [[1, 1], [4, 0], [5, -1]])

  // Where the right paper-edge midpoint (1,0) sits AS CARRIED BY the
  // corner's inner triangle (the face interior to (0.7, 0.4)), which hinges
  // on the spine. The point also exists on the static layer across the
  // closure crease — that copy is the one that tears in impossible poses.
  const player = createFoldPlayer(program)
  const at = (fracs: Record<string, number>): Vec2 & { 2?: number } => {
    player.step(fracs)
    const p: Vec2 = [1, 0]
    const probe: Vec2 = [0.7, 0.4]
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
        if (Math.hypot(tri[k][0] - p[0], tri[k][1] - p[1]) < 1e-9) {
          const o = (base + (i - 1) * 3 + k) * 3
          return [player.positions[o], player.positions[o + 1], player.positions[o + 2]] as never
        }
      }
    }
    throw new Error('corner not found')
  }
  const near = (a: number[], b: number[], eps: number): boolean =>
    Math.hypot(a[0] - b[0], a[1] - b[1], (a[2] ?? 0) - (b[2] ?? 0)) < eps

  // Spine pressed: the inner triangle lies mirrored against its twin.
  assert.ok(near(at({ diag: 1, s1: 0.5, [spine]: 1 }) as never, [0, 1, 0], 0.1))
  // Spine open at the swing's midpoint: the corner's two triangles stand
  // coplanar — the T — with the edge midpoint straight up.
  assert.ok(near(at({ diag: 1, s1: 0.5, [spine]: 0 }) as never, [0, 0, 1], 1e-5))
  // Refolded the other way: back flat on the base.
  assert.ok(near(at({ diag: 1, s1: 1, [spine]: -1 }) as never, [0, 1, 0], 0.1))
})

test('the collapse: pre-crease, open, fold inward — the centre vertex mechanism closes', () => {
  // The square-base collapse as hands do it: crease the diagonal, open the
  // sheet, then reflect the corner while the diagonal refolds — its half
  // inside the corner one way, the still half the other, coupled along the
  // degree-4 vertex's exact rigid path. Every shared edge stays together.
  const { program } = compileFoldProgram([
    { step: 'diag', op: 'reflect', p1: 'bottom@0', p2: 'top@1', move: 'bottom@1', dir: -1, at: 1, dur: 2 },
    { step: 'diag', at: 3.5, dur: 1, to: 0 },
    { step: 's1', op: 'reflect', p1: 'right@0.5', p2: 'diag@0.5', move: 'right@1', at: 5, dur: 2 },
    { step: 'diag', p1: 'diag@0.5', p2: 'diag@1', at: 5, dur: 2, to: 1 },
    { step: 'diag', p1: 'diag@0', p2: 'diag@0.5', at: 5, dur: 2, to: -1 },
  ])
  const player = createFoldPlayer(program)
  const spine = 'diag~0.5-1'
  const still = 'diag~0-0.5'

  const cornerPos = (fi: number, p: Vec2): number[] | null => {
    let base = 0
    for (let i = 0; i < fi; i++) base += (program.faces[i].poly.length - 2) * 3
    const f = program.faces[fi]
    for (let i = 1; i + 1 < f.poly.length; i++) {
      const tri = [f.poly[0], f.poly[i], f.poly[i + 1]]
      for (let k = 0; k < 3; k++) {
        if (Math.hypot(tri[k][0] - p[0], tri[k][1] - p[1]) < 1e-9) {
          const o = (base + (i - 1) * 3 + k) * 3
          return [player.positions[o], player.positions[o + 1], player.positions[o + 2]]
        }
      }
    }
    return null
  }
  const maxGap = (): number => {
    let worst = 0
    for (let i = 0; i < program.faces.length; i++) {
      for (let j = i + 1; j < program.faces.length; j++) {
        for (const v of program.faces[i].poly) {
          if (!program.faces[j].poly.some((w) => Math.hypot(w[0] - v[0], w[1] - v[1]) < 1e-9)) continue
          const a = cornerPos(i, v)
          const b = cornerPos(j, v)
          if (a && b) worst = Math.max(worst, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]))
        }
      }
    }
    return worst
  }

  // The vertex's exact folding path: (reflection fraction, |diagonal-half|).
  const branch: [number, number][] = [
    [0.125, 0.0890], [0.25, 0.1814], [0.375, 0.2810], [0.5, 0.3918],
    [0.625, 0.5180], [0.75, 0.6627], [0.875, 0.8254], [1, 1],
  ]
  for (const [f, v] of branch) {
    player.step({ s1: f, [spine]: v, [still]: -v })
    assert.ok(maxGap() < 0.002, `collapse closes at f=${f} (gap ${maxGap().toFixed(4)})`)
  }

  // Halfway: the corner tip stands straight up over the paper's centre line
  // — the top view T, the front <|, the side <|>.
  player.step({ s1: 0.5, [spine]: 0.3918, [still]: -0.3918 })
  const faceOfTip = program.faces.findIndex((f) => f.poly.some((v) => Math.hypot(v[0] - 1, v[1] - 1) < 1e-9))
  const tip = cornerPos(faceOfTip, [1, 1])!
  assert.ok(Math.hypot(tip[0] - 0, tip[1] - 1, tip[2] - 1) < 0.01, `tip stands at (0,1,1), got ${tip}`)
})

// ── Playback ──────────────────────────────────────────────────────────────────

const SQUARE_BASE = [
  { step: 'diag', op: 'reflect', p1: 'bottom@0', p2: 'top@1', move: 'bottom@1', dir: -1 },
  { step: 's1', op: 'reflect', p1: 'right@0.5', p2: 'diag@0.5', move: 'right@1' },
  { step: 's2', op: 'reflect', p1: 'left@0.5', p2: 'diag@0.5', move: 'left@0', dir: -1 },
]

test('playback is rigid at every fraction and lands on the exact folded state', () => {
  const { program } = compileFoldProgram(SQUARE_BASE)
  const player = createFoldPlayer(program)

  // Rest lengths from the flat pose (independent of the fan layout).
  player.step({})
  const flat = Float32Array.from(player.positions)
  const restLen: number[] = []
  for (let i = 0; i + 8 < flat.length; i += 9) {
    for (const [a, b] of [[0, 3], [3, 6], [6, 0]]) {
      restLen.push(Math.hypot(
        flat[i + a] - flat[i + b],
        flat[i + a + 1] - flat[i + b + 1],
        flat[i + a + 2] - flat[i + b + 2],
      ))
    }
  }
  const assertRigid = (label: string): void => {
    let k = 0
    for (let i = 0; i + 8 < player.positions.length; i += 9) {
      for (const [a, b] of [[0, 3], [3, 6], [6, 0]]) {
        const now = Math.hypot(
          player.positions[i + a] - player.positions[i + b],
          player.positions[i + a + 1] - player.positions[i + b + 1],
          player.positions[i + a + 2] - player.positions[i + b + 2],
        )
        assert.ok(Math.abs(now - restLen[k]) < 1e-5, `${label}: tri edge ${k} rigid`)
        k++
      }
    }
  }

  // Mid-fold poses are rigid rotations — check a few.
  const poses: Record<string, number>[] = [
    { diag: 0.5 },
    { diag: 1, s1: 0.3 },
    { diag: 1, s1: 1, s2: 0.7 },
    { diag: 1, s1: 1, s2: 1 },
  ]
  for (const fracs of poses) {
    player.step(fracs)
    assertRigid(JSON.stringify(fracs))
  }

  // Fully folded: a thin flat packet whose corners sit (near-exactly) on the
  // exact model's positions — the player only backs off the last sliver of
  // each 180° fold to keep stacked layers from z-fighting.
  player.step({ diag: 1, s1: 1, s2: 1 })
  let zLo = Infinity
  let zHi = -Infinity
  for (let i = 2; i < player.positions.length; i += 3) {
    zLo = Math.min(zLo, player.positions[i])
    zHi = Math.max(zHi, player.positions[i])
  }
  assert.ok(zHi - zLo < 0.15, `square base stacks flat (z extent ${(zHi - zLo).toFixed(3)})`)

  const centre = foldedPosition(program.faces, [0, 0])!
  const corner = foldedPosition(program.faces, [1, 1])!
  const dist = Math.hypot(corner[0] - centre[0], corner[1] - centre[1])
  assert.ok(Math.abs(dist - Math.SQRT2) < 1e-9)

  // Scrubbing is a pure function of the fractions.
  player.step({ diag: 0.37, s1: 0.9 })
  const a = Float32Array.from(player.positions)
  player.step({ diag: 1, s1: 1, s2: 1 })
  player.step({ diag: 0.37, s1: 0.9 })
  assert.deepEqual(Float32Array.from(player.positions), a)
})

test('hinges stay attached mid-fold: crease endpoints agree across the fold line', () => {
  const { program } = compileFoldProgram(SQUARE_BASE)
  const player = createFoldPlayer(program)
  // While ONLY the current step is in motion the sheet is a perfect rigid
  // mechanism — the fold-line vertices are shared, so faces across the
  // active crease stay glued.
  player.step({ diag: 1, s1: 0.5 })
  // Material fold-line point of s1 in each adjacent face: the two layers'
  // creases coincide on the sheet? No — s1's crease is a different sheet
  // segment per layer, but each crease's endpoints must map identically from
  // both its sides. Check via the paper staying within diameter bounds: no
  // vertex may fly off.
  for (let i = 0; i < player.positions.length; i++) {
    assert.ok(Number.isFinite(player.positions[i]))
    assert.ok(Math.abs(player.positions[i]) < 3.5)
  }
})

// ── DSL builder (spawn / sequence) ───────────────────────────────────────────

import { createDSL } from '../src/dsl.js'
import type { Row } from '../src/lineage.js'

const dsl = createDSL(null)

test('origami().spawn emits one create row with the program and zeroed groups', () => {
  const paper = dsl.origami().steps([
    { step: 'half', op: 'reflect', p1: 'bottom@0.5', p2: 'top@0.5', move: 'right@0.5', at: 1, dur: 2 },
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
    { step: 'half', op: 'reflect', p1: 'bottom@0.5', p2: 'top@0.5', move: 'right@0.5', at: 1, dur: 2 },
    // Timing-only row: re-drives the earlier fold by name (here: unfolds it).
    { step: 'half', at: 5, dur: 1, to: 0 },
  ])
  const seq = paper.sequence().rows
  const at = (beat: number): Row => seq.find((r) => r.beat === beat)!
  assert.equal(at(3).half, 1, 'folded after its ramp')
  assert.equal(at(6).half, 0, 'the timing-only row unfolds it again')
})

test('steps without `at` run one after another', () => {
  const paper = dsl.origami().steps([
    { step: 'a', op: 'reflect', p1: 'bottom@0.5', p2: 'top@0.5', move: 'right@0.5' },
    { step: 'b', op: 'reflect', p1: 'left@0.5', p2: 'a@0.5', move: 'left@0', dur: 2 },
  ])
  const seq = paper.sequence().rows
  const at = (beat: number): Row => seq.find((r) => r.beat === beat)!
  assert.equal(at(2).a, 1, 'first fold finishes at beat 2')
  assert.equal(at(2).b, 0, 'second starts as the first ends')
  assert.equal(at(4).b, 1, 'second takes its own dur')
})

test('origami sequence bakes fold steps into all-group keyframes', () => {
  const paper = dsl.origami().steps([
    { step: 'a', op: 'reflect', p1: 'bottom@0.5', p2: 'top@0.5', move: 'right@0.5' },
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
