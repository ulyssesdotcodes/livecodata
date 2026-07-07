import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRuntime } from '../src/runtime.js'
import { cookProgram, replayAt, codeEntryAt } from '../src/replay.js'
import type { Row } from '../src/lineage.js'

// The "code" editable table's own event shapes (see editable-tables.ts): the
// first run is a 'create' (seed row under `.rows[0]`), every later one a
// 'set-row' (values under `.values`) — replayAt/codeEntryAt read either.
const createEvent = (code: string, seed: number): Row => ({ kind: 'create', rows: [{ code, seed }] })
const runEvent = (code: string, seed: number): Row => ({ kind: 'set-row', values: { code, seed } })

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

test('codeEntryAt reads the code+seed active at a position, from either event shape', () => {
  const events = [createEvent('a', 1), runEvent('b', 2), runEvent('c', 3)]
  assert.deepEqual(codeEntryAt(events, 0), { code: 'a', seed: 1 })
  assert.deepEqual(codeEntryAt(events, 1), { code: 'b', seed: 2 })
  assert.deepEqual(codeEntryAt(events, 2), { code: 'c', seed: 3 })
  assert.deepEqual(codeEntryAt(events, 99), { code: 'c', seed: 3 }, 'past the end clamps to the last entry')
  assert.equal(codeEntryAt(events, -1), null, 'before the first entry → null')
  assert.equal(codeEntryAt([], 0), null, 'no history yet → null')
})

test('replayAt selects the program live at a session position', () => {
  const rt = createRuntime()
  const events = [createEvent(PROG(3), 10), runEvent(PROG(5), 20), runEvent(PROG(9), 30)]

  assert.equal(replayAt(rt, events, 0)!.views.get('noise')!.length, 3)
  assert.equal(replayAt(rt, events, 1)!.views.get('noise')!.length, 5)
  assert.equal(replayAt(rt, events, 2)!.views.get('noise')!.length, 9)
  assert.equal(replayAt(rt, events, 99)!.views.get('noise')!.length, 9)
  assert.equal(replayAt(rt, events, -1), null)
})

test('replayAt reproduces exactly what was authored (recorded seed)', () => {
  const rt = createRuntime()
  const events = [createEvent(PROG(6), 777)]

  const authored = cookProgram(rt, PROG(6), 777)
  const replayed = replayAt(rt, events, 0)!
  assert.deepEqual(
    replayed.views.get('noise')!.rows.map((r) => r.value),
    authored.views.get('noise')!.rows.map((r) => r.value),
  )
  assert.deepEqual(replayed.sceneRows, authored.sceneRows)
  assert.equal(replayed.entry.code, PROG(6))
})

test('replaying every position in order walks the whole history', () => {
  const rt = createRuntime()
  const sizes = [2, 4, 7]
  const events = sizes.map((n, i) => (i === 0 ? createEvent(PROG(n), i + 1) : runEvent(PROG(n), i + 1)))

  const walked = events.map((_e, i) => replayAt(rt, events, i)!.views.get('noise')!.length)
  assert.deepEqual(walked, sizes)
})
