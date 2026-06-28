import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRuntime } from '../src/runtime.js'
import { createLog } from '../src/log.js'
import { cookProgram, replayAt } from '../src/replay.js'

const PROG = (n: number): string => `
  define("base", () => rows([{ id: "s", type: "create", index: 0, shape: "sphere",
    color: 0x4a9eff, px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 }]))
  define("noise", (rand) => math(() => rand()).range(${n}/60))
  define("events", (rand, table) => table("base"))
  define("scene", (rand, table) => table("events").rasterize(${n}/60))
`

test('cookProgram resolves the scene cache and is deterministic per seed', () => {
  const rt = createRuntime()
  const a = cookProgram(rt, PROG(8), 123)
  const b = cookProgram(rt, PROG(8), 123)
  assert.ok(a.sceneRows.length > 0)
  assert.deepEqual(a.sceneRows, b.sceneRows)
  assert.deepEqual(
    a.views.get('noise')!.rows.map((r) => r.value),
    b.views.get('noise')!.rows.map((r) => r.value),
    'same seed → identical noise',
  )
})

test('cookProgram falls back to rasterizing events when there is no scene view', () => {
  const rt = createRuntime()
  const code = `
    define("events", () => rows([{ id: "s", type: "create", index: 0, shape: "box",
      color: 1, px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 }]))
  `
  const cooked = cookProgram(rt, code, 1)
  assert.ok(cooked.sceneRows.length > 0, 'events rasterized into a cache')
  assert.equal(cooked.sceneRows[0].shape, 'box')
})

test('cookProgram surfaces the hydra sketch rows from the "hydra" view', () => {
  const rt = createRuntime()
  const code = `
    define("base", () => rows([{ id: "s", type: "create", index: 0, shape: "box",
      color: 1, px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 }]))
    define("scene", (rand, table) => table("base").rasterize(1/60))
    define("hydra", () => rows([
      { index: 0, code: "src(s0).modulate(noise(amount)).out()", amount: 3 },
    ]))
  `
  const cooked = cookProgram(rt, code, 1)
  assert.equal(cooked.hydraRows.length, 1)
  assert.equal(cooked.hydraRows[0].code, 'src(s0).modulate(noise(amount)).out()')
  assert.equal(cooked.hydraRows[0].amount, 3)
  assert.ok(cooked.sceneRows.every((r) => r.id === 's'))
})

test('hydra variables can be data-driven from another view without cycling', () => {
  const rt = createRuntime()
  const code = `
    define("sim", () => rows([
      { id: "s", type: "create", index: 0, shape: "box", color: 1,
        px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 },
      { id: "s", type: "collision", index: 0.5, other: "floor" },
    ]))
    define("scene", (rand, table) => table("sim").rasterize(1/60))
    define("hydra", (rand, table) =>
      rows([{ index: 0, code: "src(s0).modulate(noise(amount)).out()", amount: 0.2 }]).concat(
        table("sim")
          .filter(r => r.type === "collision" && r.other === "floor")
          .map(r => ({ index: r.index, amount: 2.6 }))
      ))
  `
  const cooked = cookProgram(rt, code, 1)
  const bump = cooked.hydraRows.find((r) => r.amount === 2.6)
  assert.ok(bump, 'a collision-driven variable change was emitted')
  assert.equal(bump!.index, 0.5)
})

test('replayAt selects the program live at a session position', () => {
  const rt = createRuntime()
  const log = createLog()
  log.append({ kind: 'run', code: PROG(3), seed: 10 })
  log.append({ kind: 'run', code: PROG(5), seed: 20 })
  log.append({ kind: 'run', code: PROG(9), seed: 30 })

  assert.equal(replayAt(rt, log, 0)!.views.get('noise')!.length, 3)
  assert.equal(replayAt(rt, log, 1)!.views.get('noise')!.length, 5)
  assert.equal(replayAt(rt, log, 2)!.views.get('noise')!.length, 9)
  assert.equal(replayAt(rt, log, 99)!.views.get('noise')!.length, 9)
  assert.equal(replayAt(rt, log, -1), null)
})

test('replayAt reproduces exactly what was authored (recorded seed)', () => {
  const rt = createRuntime()
  const log = createLog()
  log.append({ kind: 'run', code: PROG(6), seed: 777 })

  const authored = cookProgram(rt, PROG(6), 777)
  const replayed = replayAt(rt, log, 0)!
  assert.deepEqual(
    replayed.views.get('noise')!.rows.map((r) => r.value),
    authored.views.get('noise')!.rows.map((r) => r.value),
  )
  assert.deepEqual(replayed.sceneRows, authored.sceneRows)
  assert.equal(replayed.entry.code, PROG(6))
})

test('replaying every position in order walks the whole session', () => {
  const rt = createRuntime()
  const log = createLog()
  const sizes = [2, 4, 7]
  sizes.forEach((n, i) => log.append({ kind: 'run', code: PROG(n), seed: i + 1 }))

  const walked = log.all().map((e) => replayAt(rt, log, e.seq)!.views.get('noise')!.length)
  assert.deepEqual(walked, sizes)
})
