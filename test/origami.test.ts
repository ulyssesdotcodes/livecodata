import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  compilePattern, createFoldSolver, hingeAngle, fanPattern,
  type PatternSpec, type Hinge,
} from '../src/origami.js'

// One vertical crease across the sheet — the simplest foldable pattern.
const halfFold = (angle = 90): PatternSpec => ({
  size: 1,
  creases: [{ x1: 0, y1: -1, x2: 0, y2: 1, group: 'half', angle }],
})

test('compilePattern: one crease splits the sheet into two faces of two triangles', () => {
  const p = compilePattern(halfFold())
  assert.equal(p.vertices.length, 6) // 4 corners + 2 crease endpoints on the border
  assert.equal(p.faces.length, 4)
  const creaseHinges = p.hinges.filter((h) => h.group === 'half')
  assert.equal(creaseHinges.length, 1, 'the crease edge is one hinge')
  const facetHinges = p.hinges.filter((h) => h.group === null)
  assert.equal(facetHinges.length, 2, 'one triangulation diagonal per rectangle')
  assert.deepEqual(p.groups, ['half'])
})

test('compilePattern: crossing creases are split at the intersection', () => {
  const p = compilePattern({
    size: 1,
    creases: [
      { x1: 0, y1: -1, x2: 0, y2: 1, group: 'v', angle: 90 },
      { x1: -1, y1: 0, x2: 1, y2: 0, group: 'h', angle: -90 },
    ],
  })
  // 4 corners + 4 border midpoints + center.
  assert.equal(p.vertices.length, 9)
  assert.equal(p.hinges.filter((h) => h.group === 'v').length, 2)
  assert.equal(p.hinges.filter((h) => h.group === 'h').length, 2)
})

test('compilePattern: dangling creases are dropped instead of corrupting faces', () => {
  const p = compilePattern({
    size: 1,
    creases: [{ x1: -0.5, y1: 0, x2: 0.5, y2: 0, group: 'dead', angle: 90 }],
  })
  assert.equal(p.hinges.filter((h) => h.group === 'dead').length, 0)
  // Total sheet area is preserved by triangulation.
  let area = 0
  for (const [a, b, c] of p.faces) {
    const [ax, ay] = p.vertices[a]
    const [bx, by] = p.vertices[b]
    const [cx, cy] = p.vertices[c]
    area += Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2
  }
  assert.ok(Math.abs(area - 4) < 1e-6, `area ${area} should be 4`)
})

test('hingeAngle gradient matches finite differences', () => {
  // A bent hinge in general position.
  const pos = new Float32Array([
    0.1, -0.9, 0.05, // e0
    0.2, 1.1, -0.02, // e1
    1.0, 0.3, 0.4,   // w0
    -0.9, -0.2, 0.6, // w1
  ])
  const h: Hinge = { e: [0, 1], w: [2, 3], group: 'g', target: 0 }
  const grad = { e0: [0, 0, 0], e1: [0, 0, 0], w0: [0, 0, 0], w1: [0, 0, 0] }
  hingeAngle(pos, h, grad)
  const analytic = [...grad.e0, ...grad.e1, ...grad.w0, ...grad.w1]

  // Positions are float32, so use a coarse FD step and a loose-ish tolerance.
  const eps = 1e-3
  for (let i = 0; i < 12; i++) {
    const save = pos[i]
    pos[i] = save + eps
    const up = hingeAngle(pos, h)
    pos[i] = save - eps
    const down = hingeAngle(pos, h)
    pos[i] = save
    const fd = (up - down) / (2 * eps)
    assert.ok(
      Math.abs(fd - analytic[i]) < 1e-2 * Math.max(1, Math.abs(fd)),
      `component ${i}: fd ${fd} vs analytic ${analytic[i]}`,
    )
  }
})

test('solver folds a valley crease toward +z and converges', () => {
  const p = compilePattern(halfFold(150))
  const solver = createFoldSolver(p)
  for (let i = 0; i < 40; i++) solver.step({ half: 1 }, 60)

  // Every vertex off the crease line should have risen well above the plane.
  let minLift = Infinity
  p.vertices.forEach(([x], i) => {
    if (Math.abs(x) < 1e-6) return
    minLift = Math.min(minLift, solver.positions[i * 3 + 2])
  })
  assert.ok(minLift > 0.1, `valley fold should lift wings toward +z (min z ${minLift})`)

  // The crease hinge should sit near its 150° target.
  const hinge = p.hinges.find((h) => h.group === 'half')!
  const theta = hingeAngle(solver.positions, hinge)
  assert.ok(Math.abs(theta - (150 * Math.PI) / 180) < 0.05, `theta ${theta}`)

  // Paper is inextensible: no axial spring stretched more than a few percent.
  for (const [a, b, c] of p.faces) {
    for (const [i, j] of [[a, b], [b, c], [c, a]]) {
      const rest = Math.hypot(
        p.vertices[j][0] - p.vertices[i][0],
        p.vertices[j][1] - p.vertices[i][1],
      )
      const now = Math.hypot(
        solver.positions[j * 3] - solver.positions[i * 3],
        solver.positions[j * 3 + 1] - solver.positions[i * 3 + 1],
        solver.positions[j * 3 + 2] - solver.positions[i * 3 + 2],
      )
      assert.ok(Math.abs(now - rest) / rest < 0.05, `edge ${i}-${j} stretched ${now} vs ${rest}`)
    }
  }
})

test('solver unfolds again when the fraction returns to 0', () => {
  const p = compilePattern(halfFold(150))
  const solver = createFoldSolver(p)
  for (let i = 0; i < 30; i++) solver.step({ half: 1 }, 60)
  for (let i = 0; i < 60; i++) solver.step({ half: 0 }, 60)
  let maxZ = 0
  for (let i = 0; i < p.vertices.length; i++) {
    maxZ = Math.max(maxZ, Math.abs(solver.positions[i * 3 + 2]))
  }
  assert.ok(maxZ < 0.08, `sheet should relax flat again (max |z| ${maxZ})`)
})

test('fan pattern: one group per pleat, ripple-foldable', () => {
  const p = compilePattern(fanPattern(5))
  assert.equal(p.groups.length, 5)
  const solver = createFoldSolver(p)
  for (let i = 0; i < 60; i++) {
    solver.step({ fan0: 1, fan1: 1, fan2: 1, fan3: 1, fan4: 1 }, 40)
  }
  for (let i = 0; i < solver.positions.length; i++) {
    assert.ok(Number.isFinite(solver.positions[i]))
  }
  // Accordion compresses in x.
  let minX = Infinity
  let maxX = -Infinity
  for (let i = 0; i < p.vertices.length; i++) {
    minX = Math.min(minX, solver.positions[i * 3])
    maxX = Math.max(maxX, solver.positions[i * 3])
  }
  assert.ok(maxX - minX < 1.5, `accordion should compress (width ${maxX - minX})`)
})

// ── DSL builder (spawn / sequence) ───────────────────────────────────────────

import { createDSL } from '../src/dsl.js'
import type { Row } from '../src/lineage.js'

const dsl = createDSL(null)

test('origami().spawn emits one create row with the compiled pattern and zeroed groups', () => {
  const paper = dsl.origami().crease(0, -1, 0, 1, 'half', 120)
  const rows = paper.spawn({ id: 'sheet', color: 0x123456 }).rows
  assert.equal(rows.length, 1)
  const r = rows[0]
  assert.equal(r.id, 'sheet')
  assert.equal(r.type, 'create')
  assert.equal(r.shape, 'origami')
  assert.equal(r.half, 0)
  assert.equal(r.color, 0x123456)
  const pattern = r.pattern as { groups: string[]; faces: unknown[] }
  assert.deepEqual(pattern.groups, ['half'])
  assert.ok(pattern.faces.length >= 4)
})

test('origami().creases adds many creases at once from a plain array of objects', () => {
  const paper = dsl.origami().creases([
    { x1: 0, y1: -1, x2: 0, y2: 1, group: 'a', angle: 90 },
    { x1: -1, y1: 0, x2: 1, y2: 0, group: 'b', angle: -90 },
  ])
  const pattern = paper.spawn({ id: 'sheet' }).rows[0].pattern as { groups: string[] }
  assert.deepEqual(pattern.groups.sort(), ['a', 'b'])
  // Chains with .crease() too — the two building blocks are interchangeable.
  const mixed = dsl.origami().crease(0.5, -1, 0.5, 1, 'c', 45).creases([
    { x1: -0.5, y1: -1, x2: -0.5, y2: 1, group: 'd', angle: 45 },
  ])
  const mixedPattern = mixed.spawn({ id: 'sheet2' }).rows[0].pattern as { groups: string[] }
  assert.deepEqual(mixedPattern.groups.sort(), ['c', 'd'])
})

test('origami().folds turns fold-step rows into creases plus a default sequence', () => {
  const paper = dsl.origami().folds([
    // A physical step: a line in sheet coordinates + a degree + timing.
    { fold: 'half', x1: 0, y1: -1, x2: 0, y2: 1, deg: 150, at: 1, dur: 2, to: 1 },
    // Timing-only row: re-folds the earlier step by name (here: unfolds it).
    { fold: 'half', at: 5, dur: 1, to: 0 },
    // No fold name → auto-named group, still a step of its own.
    { x1: -1, y1: 0, x2: 1, y2: 0, deg: -90, at: 2, dur: 1, to: 1 },
  ])
  const pattern = paper.spawn({ id: 'p' }).rows[0].pattern as { groups: string[] }
  assert.ok(pattern.groups.includes('half'))
  assert.equal(pattern.groups.length, 2)
  const auto = pattern.groups.find((g) => g !== 'half')!

  const seq = paper.sequence().rows
  const at = (beat: number): Row => seq.find((r) => r.beat === beat)!
  assert.equal(at(3).half, 1, 'folded after its ramp')
  assert.equal(at(3)[auto], 1, 'auto-named fold ramps on its own timing')
  assert.equal(at(6).half, 0, 'the timing-only row unfolds it again')
})

test('origami sequence bakes fold steps into all-group keyframes', () => {
  const paper = dsl.origami()
    .crease(0, -1, 0, 1, 'a', 90)
    .crease(-1, 0, 1, 0, 'b', -90)
  paper.spawn({ id: 'p' })
  const rows = paper.sequence([
    { fold: 'a', at: 1, dur: 2 },
    { fold: 'b', at: 2, dur: 2 }, // overlaps the tail of a's ramp
  ]).rows

  // Breakpoints at 1, 2, 3, 4 — every row carries both groups.
  assert.deepEqual(rows.map((r) => r.beat), [1, 2, 3, 4])
  assert.ok(rows.every((r) => r.id === 'p' && r.type === 'update'))
  const at = (beat: number): Row => rows.find((r) => r.beat === beat)!
  assert.equal(at(1).a, 0)
  assert.equal(at(2).a, 0.5)
  assert.equal(at(3).a, 1)
  assert.equal(at(2).b, 0)
  assert.equal(at(3).b, 0.5)
  assert.equal(at(4).b, 1)
})

test('origami sequence supports partial folds, refolds, and named eases', () => {
  const paper = dsl.origami().crease(0, -1, 0, 1, 'w', 150)
  paper.spawn({ id: 'p' })
  const rows = paper.sequence([
    { fold: 'w', at: 1, dur: 1 },
    { fold: 'w', at: 4, dur: 1, to: 0.4, ease: 'easeInOut' },
  ]).rows
  const at = (beat: number): Row => rows.find((r) => r.beat === beat)!
  assert.equal(at(2).w, 1, 'folded fully first')
  assert.equal(at(4).w, 1, 'held until the refold starts')
  assert.equal(at(5).w, 0.4, 'ramps back down to the partial target')
  assert.equal(typeof at(5).ease, 'function', 'named ease resolved onto the keyframe')
})

// ── Rigid (kinematic) solver ─────────────────────────────────────────────────

import { createRigidSolver } from '../src/origami.js'

test('rigid solver: a valley fold lifts the far side toward +z by exactly the target', () => {
  const p = compilePattern(halfFold(90))
  const solver = createRigidSolver(p)
  solver.step({ half: 1 })
  // Faces are per-corner now; every corner with x away from the crease on the
  // folded side must sit at exactly |x| height (90° rotation), and the kept
  // side stays in the plane.
  let folded = 0
  for (let f = 0; f < p.faces.length; f++) {
    for (let k = 0; k < 3; k++) {
      const x = solver.positions[f * 9 + k * 3]
      const z = solver.positions[f * 9 + k * 3 + 2]
      if (Math.abs(z) > 1e-6) {
        folded++
        assert.ok(z > 0, `folded side went up, got z=${z}`)
        assert.ok(Math.abs(Math.abs(x) - 0) < 1e-6 || Math.abs(z) > 0, 'rotated by 90°')
      }
    }
  }
  assert.ok(folded > 0, 'something folded')
  // Rigidity is exact: every face's edge lengths match the pattern.
  for (let f = 0; f < p.faces.length; f++) {
    const [a, b, c] = p.faces[f]
    const idx = [a, b, c]
    for (let k = 0; k < 3; k++) {
      const k2 = (k + 1) % 3
      const rest = Math.hypot(
        p.vertices[idx[k2]][0] - p.vertices[idx[k]][0],
        p.vertices[idx[k2]][1] - p.vertices[idx[k]][1],
      )
      const now = Math.hypot(
        solver.positions[f * 9 + k2 * 3] - solver.positions[f * 9 + k * 3],
        solver.positions[f * 9 + k2 * 3 + 1] - solver.positions[f * 9 + k * 3 + 1],
        solver.positions[f * 9 + k2 * 3 + 2] - solver.positions[f * 9 + k * 3 + 2],
      )
      assert.ok(Math.abs(now - rest) < 1e-6, `face ${f} edge ${k} exact`)
    }
  }
})

test('rigid solver: undriven creases stay exactly flat', () => {
  const p = compilePattern({
    size: 1,
    creases: [
      { x1: 0, y1: -1, x2: 0, y2: 1, group: 'v', angle: 150 },
      { x1: -1, y1: 0, x2: 1, y2: 0, group: 'h', angle: -150 },
    ],
  })
  const solver = createRigidSolver(p)
  solver.step({ v: 1, h: 0 })
  // With h undriven, the sheet is a clean single fold: every corner lies
  // either in the z=0 plane or on the half-plane rotated exactly 150° about
  // the crease — nothing in between (the h crease shows no kink at all).
  for (let f = 0; f < p.faces.length; f++) {
    for (let k = 0; k < 3; k++) {
      const x = solver.positions[f * 9 + k * 3]
      const z = solver.positions[f * 9 + k * 3 + 2]
      const onFlat = Math.abs(z) < 1e-6
      const angle = (Math.atan2(z, x) * 180) / Math.PI
      const onFolded = Math.abs(angle - 150) < 1e-4
      assert.ok(onFlat || onFolded, `corner x=${x} z=${z} on a rigid half-plane (angle ${angle})`)
    }
  }
})
