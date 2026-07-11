import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRuntime } from '../src/runtime.js'
import { getLineage } from '../src/lineage.js'
import { createBakedFolding, type CompiledPattern, type DriveKey } from '../src/origami.js'
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

  // The folding is physics (a compliant solver after Ghassaei's Origami
  // Simulator), baked against the beat: spawn() attached the fold schedule
  // as `drive`, and poses are a pure function of the beat. Check the
  // sample's rest states by landmark geometry.
  const drive = create.drive as DriveKey[]
  assert.ok(Array.isArray(drive) && drive.length > 0, 'create row carries the fold schedule')
  const baked = createBakedFolding(pattern, drive)

  const vtx = (x: number, y: number): number => {
    const i = pattern.vertices.findIndex(([vx, vy]) => Math.hypot(vx - x, vy - y) < 1e-3)
    assert.ok(i >= 0, `vertex (${x},${y}) exists`)
    return i
  }
  const pos = (v: number): [number, number, number] =>
    [baked.positions[v * 3], baked.positions[v * 3 + 1], baked.positions[v * 3 + 2]]
  const zExtent = (): number => {
    let lo = Infinity
    let hi = -Infinity
    for (let i = 2; i < baked.positions.length; i += 3) {
      lo = Math.min(lo, baked.positions[i])
      hi = Math.max(hi, baked.positions[i])
    }
    return hi - lo
  }
  const maxStrain = (): number => {
    let worst = 0
    for (const [a, b, c] of pattern.faces) {
      for (const [i, j] of [[a, b], [b, c], [c, a]] as const) {
        const rest = Math.hypot(
          pattern.vertices[j][0] - pattern.vertices[i][0],
          pattern.vertices[j][1] - pattern.vertices[i][1],
        )
        const now = Math.hypot(
          baked.positions[j * 3] - baked.positions[i * 3],
          baked.positions[j * 3 + 1] - baked.positions[i * 3 + 1],
          baked.positions[j * 3 + 2] - baked.positions[i * 3 + 2],
        )
        worst = Math.max(worst, Math.abs(now - rest) / rest)
      }
    }
    return worst
  }

  // Flat at the start.
  baked.poseAt(0)
  assert.ok(zExtent() < 1e-6, 'sheet starts exactly flat')

  // Square-base rest (step 1 ends at beat 3, rest until 4.5): shaped like the
  // SQUARE base, not a triangle — corners stack at one point √2 from the
  // centre, and the edge midpoints land in TWO stacks √2 apart (a wedge
  // collapse would pile all four midpoints together).
  baked.poseAt(4.4)
  assert.ok(maxStrain() < 0.08, `paper barely stretches at rest (${(maxStrain() * 100).toFixed(1)}%)`)
  const o = pos(vtx(0, 0))
  const cps = [vtx(1, 1), vtx(-1, 1), vtx(-1, -1), vtx(1, -1)].map(pos)
  const cx = cps.reduce((s, p) => s + p[0], 0) / 4
  const cy = cps.reduce((s, p) => s + p[1], 0) / 4
  const cz = cps.reduce((s, p) => s + p[2], 0) / 4
  for (const p of cps) {
    // real paper springs open a little at rest, so the stack is snug, not exact
    assert.ok(Math.hypot(p[0] - cx, p[1] - cy, p[2] - cz) < 0.35, 'corners gather at one point')
  }
  const cornerDist = Math.hypot(cx - o[0], cy - o[1], cz - o[2])
  assert.ok(Math.abs(cornerDist - Math.SQRT2) < 0.15, `corner stack √2 from centre (${cornerDist.toFixed(3)})`)
  const mps = [vtx(1, 0), vtx(0, 1), vtx(-1, 0), vtx(0, -1)].map(pos)
  let midSep = 0
  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) {
      midSep = Math.max(midSep, Math.hypot(mps[i][0] - mps[j][0], mps[i][1] - mps[j][1], mps[i][2] - mps[j][2]))
    }
    const dO = Math.hypot(mps[i][0] - o[0], mps[i][1] - o[1], mps[i][2] - o[2])
    assert.ok(Math.abs(dO - 1) < 0.25, `midpoint ${i} sits 1 from centre (${dO.toFixed(3)})`)
  }
  assert.ok(midSep > 1.1, `midpoints form two separate stacks (${midSep.toFixed(3)}) — square, not triangle`)

  // Bird-base rest (step 2 ends at beat 8, rest until 9.5): a snug packet.
  baked.poseAt(9.4)
  assert.ok(maxStrain() < 0.08, `bird base barely stretched (${(maxStrain() * 100).toFixed(1)}%)`)
  const bps = [vtx(1, 1), vtx(-1, 1), vtx(-1, -1), vtx(1, -1)].map(pos)
  const bcx = bps.reduce((s, p) => s + p[0], 0) / 4
  const bcy = bps.reduce((s, p) => s + p[1], 0) / 4
  const bcz = bps.reduce((s, p) => s + p[2], 0) / 4
  for (const p of bps) {
    assert.ok(Math.hypot(p[0] - bcx, p[1] - bcy, p[2] - bcz) < 0.1, 'bird base corners press tight')
  }

  // Determinism: scrubbing anywhere and back reproduces poses exactly.
  baked.poseAt(4.4)
  const again = Float32Array.from(baked.positions)
  baked.poseAt(0)
  baked.poseAt(4.4)
  assert.deepEqual(Array.from(baked.positions), Array.from(again))

  const scene = views.get('scene')!
  assert.ok(scene.length > 0, 'rasterized to a frame cache')
})
