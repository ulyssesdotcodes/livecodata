import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRuntime } from '../src/runtime.js'
import { getLineage } from '../src/lineage.js'
import { createRigidSolver, type CompiledPattern } from '../src/origami.js'
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
  // Per-segment groups (d1…, a1…, bx…, by…) so the tutorial sequence can
  // fold each line one way, unfold it, and refold it the other way.
  const baseGroups = [
    'd1', 'd2', 'd3', 'd4', 'a1', 'a2', 'a3', 'a4',
    'bx1', 'bx2', 'bx3', 'bx4', 'by1', 'by2', 'by3', 'by4',
    'petalF', 'petalB',
  ]
  for (const g of [...baseGroups, 'neck', 'tail', 'head', 'wings']) {
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

  // The rigid solver is kinematic: a pose is a pure function of the fold
  // fractions, so check the sample's rest states directly. Rigidity is exact
  // by construction — assert it as a regression on the transform math — and
  // the flat-foldable rests must stack into thin packets.
  // The square base folds the book folds fully while the DIAGONALS end up
  // flat inside (fold them fully too and the whole sheet piles into one 45°
  // wedge — a triangle, not a square base).
  const squareTo: Record<string, number> = {
    bx1: 1, bx3: 1, by1: 1, by3: 1, bx2: -1, bx4: -1, by2: -1, by4: -1,
    d1: 0, d2: 0, d3: 0, d4: 0, a1: 0, a2: 0, a3: 0, a4: 0,
    petalF: 0, petalB: 0, neck: 0, tail: 0, head: 0, wings: 0,
  }
  const birdTo: Record<string, number> = {
    ...squareTo,
    d1: 1, d2: 1, d3: 1, d4: 1, a1: 1, a2: 1, a3: 1, a4: 1,
    bx2: 1, bx4: 1, by2: 1, by4: 1,
    petalF: 1, petalB: 1,
  }
  const solver = createRigidSolver(pattern)

  // Every pattern vertex's per-face copies, for tear + landmark checks.
  const copies: number[][] = pattern.vertices.map(() => [])
  pattern.faces.forEach((tri, f) => tri.forEach((v, k) => copies[v].push(f * 3 + k)))
  const avgPos = (v: number): [number, number, number] => {
    let x = 0
    let y = 0
    let z = 0
    for (const c of copies[v]) {
      x += solver.positions[c * 3]
      y += solver.positions[c * 3 + 1]
      z += solver.positions[c * 3 + 2]
    }
    const n = copies[v].length
    return [x / n, y / n, z / n]
  }
  const maxTear = (): number => {
    let worst = 0
    for (let v = 0; v < pattern.vertices.length; v++) {
      const [ax, ay, az] = avgPos(v)
      for (const c of copies[v]) {
        worst = Math.max(worst, Math.hypot(
          solver.positions[c * 3] - ax,
          solver.positions[c * 3 + 1] - ay,
          solver.positions[c * 3 + 2] - az,
        ))
      }
    }
    return worst
  }
  const vtx = (x: number, y: number): number => {
    const i = pattern.vertices.findIndex(([vx, vy]) => Math.hypot(vx - x, vy - y) < 1e-3)
    assert.ok(i >= 0, `vertex (${x},${y}) exists`)
    return i
  }

  const checkRigidity = (label: string): void => {
    for (let f = 0; f < pattern.faces.length; f++) {
      const [a, b, c] = pattern.faces[f]
      const idx = [a, b, c]
      for (let k = 0; k < 3; k++) {
        const k2 = (k + 1) % 3
        const rest = Math.hypot(
          pattern.vertices[idx[k2]][0] - pattern.vertices[idx[k]][0],
          pattern.vertices[idx[k2]][1] - pattern.vertices[idx[k]][1],
        )
        const now = Math.hypot(
          solver.positions[f * 9 + k2 * 3] - solver.positions[f * 9 + k * 3],
          solver.positions[f * 9 + k2 * 3 + 1] - solver.positions[f * 9 + k * 3 + 1],
          solver.positions[f * 9 + k2 * 3 + 2] - solver.positions[f * 9 + k * 3 + 2],
        )
        assert.ok(Number.isFinite(now) && Math.abs(now - rest) < 1e-5, `${label}: face ${f} rigid`)
      }
    }
  }
  const zExtent = (): number => {
    let lo = Infinity
    let hi = -Infinity
    for (let i = 2; i < solver.positions.length; i += 3) {
      lo = Math.min(lo, solver.positions[i])
      hi = Math.max(hi, solver.positions[i])
    }
    return hi - lo
  }

  // Flat: every corner exactly on the sheet.
  solver.step({})
  assert.ok(zExtent() < 1e-9, 'undriven sheet is exactly flat')

  // Square base: a thin flat packet (near-flat 178° folds stack the layers),
  // stitched so the sheet never pulls apart…
  solver.step(squareTo)
  checkRigidity('square base')
  assert.ok(zExtent() < 0.15, `square base stacks flat (z extent ${zExtent().toFixed(3)})`)
  assert.ok(maxTear() < 0.02, `square base holds together (tear ${maxTear().toFixed(3)})`)
  // …and shaped like the SQUARE base, not a triangle: the four corners stack
  // at one point √2 from the centre, and the four edge midpoints land in TWO
  // stacks (the base's side corners) √2 apart. A wedge/triangle collapse puts
  // all four midpoints in a single stack.
  const o = avgPos(vtx(0, 0))
  const cps = [vtx(1, 1), vtx(-1, 1), vtx(-1, -1), vtx(1, -1)].map(avgPos)
  const cx = cps.reduce((s, p) => s + p[0], 0) / 4
  const cy = cps.reduce((s, p) => s + p[1], 0) / 4
  const cz = cps.reduce((s, p) => s + p[2], 0) / 4
  for (const p of cps) {
    assert.ok(Math.hypot(p[0] - cx, p[1] - cy, p[2] - cz) < 0.05, 'corners stack at one point')
  }
  const cornerDist = Math.hypot(cx - o[0], cy - o[1], cz - o[2])
  assert.ok(Math.abs(cornerDist - Math.SQRT2) < 0.05, `corner stack √2 from centre (${cornerDist.toFixed(3)})`)
  const mps = [vtx(1, 0), vtx(0, 1), vtx(-1, 0), vtx(0, -1)].map(avgPos)
  let midSep = 0
  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) {
      midSep = Math.max(midSep, Math.hypot(mps[i][0] - mps[j][0], mps[i][1] - mps[j][1], mps[i][2] - mps[j][2]))
    }
    const dO = Math.hypot(mps[i][0] - o[0], mps[i][1] - o[1], mps[i][2] - o[2])
    assert.ok(Math.abs(dO - 1) < 0.05, `midpoint ${i} sits 1 from centre (${dO.toFixed(3)})`)
  }
  assert.ok(Math.abs(midSep - Math.SQRT2) < 0.05, `midpoints form two stacks √2 apart (${midSep.toFixed(3)})`)

  // Bird base: likewise flat and stitched.
  solver.step(birdTo)
  checkRigidity('bird base')
  assert.ok(zExtent() < 0.3, `bird base stacks flat (z extent ${zExtent().toFixed(3)})`)
  assert.ok(maxTear() < 0.02, `bird base holds together (tear ${maxTear().toFixed(3)})`)

  // Mid-motion (petal fold half-open, the historically worst state): the
  // sheet may offset slightly but must not pull apart.
  solver.step({ ...birdTo, petalF: 0.6, petalB: 0.6, d1: 0.5, d2: 0.5, d3: 0.5, d4: 0.5, a1: 0.5, a2: 0.5, a3: 0.5, a4: 0.5, bx2: 0, bx4: 0, by2: 0, by4: 0 })
  checkRigidity('mid petal fold')
  assert.ok(maxTear() < 0.15, `mid-fold sheet stays stitched (tear ${maxTear().toFixed(3)})`)

  const scene = views.get('scene')!
  assert.ok(scene.length > 0, 'rasterized to a frame cache')
})
