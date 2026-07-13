import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initPhysics, simulateScene } from '../src/physics.js'
import { createRuntime } from '../src/runtime.js'
import type { Row } from '../src/lineage.js'

const engine = await initPhysics()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Jolt = engine.Jolt as any

function rowsById(out: Row[], id: string): Row[] {
  return out.filter((r) => r.id === id)
}

test('a dynamic body falls under gravity', () => {
  const out = simulateScene(Jolt, [
    { id: 'ball', type: 'create', shape: 'sphere', motion: 'dynamic', px: 0, py: 5, pz: 0 },
  ], { steps: 60, gravity: -9.81 })

  const updates = rowsById(out, 'ball').filter((r) => r.type === 'update')
  assert.ok(updates.length > 0, 'emits update rows for the dynamic body')
  const first = updates[0]
  const last = updates[updates.length - 1]
  assert.ok((last.py as number) < (first.py as number) - 1, `ball fell: ${(first.py as number).toFixed(2)} -> ${(last.py as number).toFixed(2)}`)
})

test('dropAt holds a dynamic body motionless, then releases it into free fall', () => {
  // fps 30, steps 60: one update row per frame, dropAt 1s -> released at frame 30.
  const out = simulateScene(Jolt, [
    { id: 'ball', type: 'create', shape: 'sphere', motion: 'dynamic', dropAt: 1, px: 0, py: 5, pz: 0 },
  ], { steps: 60, gravity: -9.81, fps: 30 })

  const updates = rowsById(out, 'ball').filter((r) => r.type === 'update')
  assert.equal(updates.length, 60, 'one update row per stepped frame, held rows included')

  for (const r of updates.slice(0, 30)) assert.equal(r.py, 5, `stays put while held: ${r.py}`)
  assert.ok((updates[59].py as number) < 4, `fell after release: ${(updates[59].py as number).toFixed(2)}`)
})

test('static bodies are preserved but never emit update rows', () => {
  const out = simulateScene(Jolt, [
    { id: 'floor', type: 'create', shape: 'box', motion: 'static', px: 0, py: -1, pz: 0, hx: 5, hy: 0.5, hz: 5 },
    { id: 'ball', type: 'create', shape: 'sphere', motion: 'dynamic', px: 0, py: 3, pz: 0 },
  ], { steps: 30 })

  const floorRows = rowsById(out, 'floor')
  assert.equal(floorRows.length, 1, 'floor appears exactly once (its create row)')
  assert.equal(floorRows[0].type, 'create')
  assert.ok(rowsById(out, 'ball').some((r) => r.type === 'update'), 'ball still moves')
})

test('a body landing on the floor produces collision rows for both bodies', () => {
  const out = simulateScene(Jolt, [
    { id: 'floor', type: 'create', shape: 'box', motion: 'static', px: 0, py: -1, pz: 0, hx: 5, hy: 0.5, hz: 5 },
    { id: 'ball', type: 'create', shape: 'sphere', motion: 'dynamic', px: 0, py: 3, pz: 0 },
  ], { steps: 120, gravity: -9.81 })

  const collisions = out.filter((r) => r.type === 'collision')
  assert.ok(collisions.length >= 2, 'at least one contact, recorded symmetrically')

  const ballHit = collisions.find((r) => r.id === 'ball' && r.other === 'floor')
  const floorHit = collisions.find((r) => r.id === 'floor' && r.other === 'ball')
  assert.ok(ballHit, 'ball records hitting the floor')
  assert.ok(floorHit, 'floor records being hit by the ball')
  assert.equal(ballHit!.beat, floorHit!.beat, 'both sides share the contact beat')
  assert.equal(typeof ballHit!.cx, 'number', 'contact point uses cx/cy/cz, not px/py/pz')
  assert.equal(ballHit!.px, undefined, 'collision rows carry no movement keyframe')
})

test('collisions:false skips contact rows', () => {
  const out = simulateScene(Jolt, [
    { id: 'floor', type: 'create', shape: 'box', motion: 'static', px: 0, py: -1, pz: 0, hx: 5, hy: 0.5, hz: 5 },
    { id: 'ball', type: 'create', shape: 'sphere', motion: 'dynamic', px: 0, py: 3, pz: 0 },
  ], { steps: 120, collisions: false })

  assert.equal(out.filter((r) => r.type === 'collision').length, 0)
})

test('output is sorted by beat, base creates first at beat 1', () => {
  const out = simulateScene(Jolt, [
    { id: 'ball', type: 'create', shape: 'sphere', motion: 'dynamic', px: 0, py: 5, pz: 0 },
  ], { steps: 20 })

  for (let i = 1; i < out.length; i++) {
    assert.ok(((out[i].beat as number) ?? 1) >= ((out[i - 1].beat as number) ?? 1), 'non-decreasing beat')
  }
  assert.equal(out[0].type, 'create')
  assert.equal(out[0].beat, 1, 'create normalized to beat 1')
})

test('sampleEvery thins out the update rows', () => {
  const base: Row[] = [{ id: 'ball', type: 'create', shape: 'sphere', motion: 'dynamic', px: 0, py: 5, pz: 0 }]
  const dense = simulateScene(Jolt, base, { steps: 60, sampleEvery: 1 })
  const sparse = simulateScene(Jolt, base, { steps: 60, sampleEvery: 4 })

  const denseUpdates = dense.filter((r) => r.type === 'update').length
  const sparseUpdates = sparse.filter((r) => r.type === 'update').length
  assert.ok(sparseUpdates < denseUpdates, `${sparseUpdates} < ${denseUpdates}`)
  assert.ok(sparseUpdates > 0)
})

test('simulation is deterministic across runs', () => {
  const base: Row[] = [
    { id: 'a', type: 'create', shape: 'box', motion: 'dynamic', px: 0.1, py: 4, pz: 0, rx: 0.3 },
    { id: 'b', type: 'create', shape: 'sphere', motion: 'dynamic', px: 0, py: 2, pz: 0 },
    { id: 'g', type: 'create', shape: 'box', motion: 'static', px: 0, py: -1, pz: 0, hx: 3, hy: 0.3, hz: 3 },
  ]
  const a = simulateScene(Jolt, base, { steps: 90 })
  const b = simulateScene(Jolt, base, { steps: 90 })
  assert.deepEqual(a, b, 'identical input yields identical baked rows')
})

test('initial velocity is applied to dynamic bodies', () => {
  const out = simulateScene(Jolt, [
    { id: 'shot', type: 'create', shape: 'sphere', motion: 'dynamic', px: 0, py: 0, pz: 0, vx: 5 },
  ], { steps: 30, gravity: 0 })

  const updates = rowsById(out, 'shot').filter((r) => r.type === 'update')
  assert.ok((updates[updates.length - 1].px as number) > 1, 'travelled along +x from its initial velocity')
})

function fakeEngine(rows: Row[]): { simulate: () => Row[] } {
  return { simulate: () => rows }
}

test('physics() builder bakes the source table and stays chainable', () => {
  const baked: Row[] = [
    { id: 'x', type: 'create', beat: 1 },
    { id: 'x', type: 'update', beat: 2, py: 1 },
  ]
  const runtime = createRuntime({ physics: () => fakeEngine(baked) })
  const { views } = runtime.run(`
    define("scene", () => rows([{ id: "x", type: "create", motion: "dynamic" }]))
    define("events", (rand, table) => physics(table("scene")).simulate({ steps: 1 }))
  `, { seed: 1 })

  const events = views.get('events')
  assert.ok(events, 'result cooks like any other view')
  assert.equal(events!.rows.length, 2)
  assert.equal(events!.rows[1].py, 1)
})

test('physics() throws a friendly error while the engine is still loading', () => {
  const runtime = createRuntime({ physics: () => null })
  assert.throws(() => runtime.run(`
    define("events", (rand, table) => physics(rows([{ id: "x", type: "create" }])).simulate())
  `, { seed: 1 }), /still loading/)
})
