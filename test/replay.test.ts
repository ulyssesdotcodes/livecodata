import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRuntime } from '../src/runtime.js'
import { cookProgram } from '../src/replay.js'

const PROG = (n: number): string => `
  define("base", () => rows([{ id: "s", type: "create", beat: 1, shape: "sphere",
    color: 0x4a9eff, px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 }]))
  define("noise", (rand) => math(() => rand()).range(${n}/30))
  define("events", (rand, table) => table("base"))
  define("scene", (rand, table) => table("events").rasterize(${n}/30))
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
    define("events", () => rows([{ id: "s", type: "create", beat: 1, shape: "box",
      color: 1, px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 }]))
  `
  const cooked = cookProgram(rt, code, 1)
  assert.ok(cooked.sceneRows.length > 0, 'events rasterized into a cache')
  assert.equal(cooked.sceneRows[0].shape, 'box')
})

test('cookProgram surfaces the hydra sketch rows from the "hydra" view', () => {
  const rt = createRuntime()
  const code = `
    define("base", () => rows([{ id: "s", type: "create", beat: 1, shape: "box",
      color: 1, px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 }]))
    define("scene", (rand, table) => table("base").rasterize(1/30))
    define("hydra", () => rows([
      { beat: 1, code: "src(s0).modulate(noise(amount)).out()", amount: 3 },
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
      { id: "s", type: "create", beat: 1, shape: "box", color: 1,
        px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 },
      { id: "s", type: "collision", beat: 3, other: "floor" },
    ]))
    define("scene", (rand, table) => table("sim").rasterize(1/30))
    define("hydra", (rand, table) =>
      rows([{ beat: 1, code: "src(s0).modulate(noise(amount)).out()", amount: 0.2 }]).concat(
        table("sim")
          .filter(r => r.type === "collision" && r.other === "floor")
          .map(r => ({ beat: r.beat, amount: 2.6 }))
      ))
  `
  const cooked = cookProgram(rt, code, 1)
  const bump = cooked.hydraRows.find((r) => r.amount === 2.6)
  assert.ok(bump, 'a collision-driven variable change was emitted')
  assert.equal(bump!.beat, 3)
})

test('cookProgram reproduces exactly what was authored for a given seed', () => {
  const rt = createRuntime()
  const authored = cookProgram(rt, PROG(6), 777)
  const again = cookProgram(rt, PROG(6), 777)
  assert.deepEqual(
    again.views.get('noise')!.rows.map((r) => r.value),
    authored.views.get('noise')!.rows.map((r) => r.value),
  )
  assert.deepEqual(again.sceneRows, authored.sceneRows)
})
