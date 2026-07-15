import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRuntime } from '../src/runtime.js'
import { getLineage } from '../src/lineage.js'
import { foldTablePositions, type FoldTableProgram } from '../src/fold-engine.js'
import { conformRow, schemaColumns, invalidColumns, type ColumnType } from '../src/editable-tables.js'
import { SAMPLES } from '../src/samples.js'
import { buildHydraIndex, hydraFrameAt } from '../src/hydra.js'
import { frameToBeat } from '../src/constants.js'

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

test('Origami Crane sample: 17 exact fold steps, wings held half-raised', () => {
  const sample = SAMPLES.find((s) => s.name === 'Origami Crane')!
  // materialize seed rows exactly like the app does (cook-service): the sample's
  // table data seeds the store when the program's editable(name, schema) carries
  // no inline rows, then every schema column exists on every row with type
  // defaults for untouched cells.
  const { views } = createRuntime({
    editableRows: (name: string, schema: Record<string, ColumnType>, seed?: Record<string, unknown>[]) =>
      (seed ?? sample.tables?.[name] ?? []).map((r) => conformRow(r, schemaColumns(schema))),
  }).run(sample.code, { seed: 1 })

  const events = views.get('events')!
  const create = events.rows.find((r) => r.type === 'create')!
  const program = create.program as FoldTableProgram
  assert.equal(program.kind, 'fold-table')
  assert.equal(program.steps.length, 17)
  assert.equal(program.steps[16].name, 'wings')
  assert.equal(program.steps[16].to, 0.5)
  assert.equal(program.steps[16].FV.length, 74)
  // solved fold kinds: the collapse and the point folds are reverse folds
  const kinds = program.steps.map((s) => s.type)
  assert.equal(kinds.filter((k) => k === 'Inside Reverse').length, 9)

  // the schedule drives one numeric: fold rises 0 → 16.5 and never falls
  const folds = events.rows
    .filter((r) => r.type === 'update' && typeof r.fold === 'number')
    .sort((a, b) => (a.beat as number) - (b.beat as number))
    .map((r) => r.fold as number)
  assert.equal(folds[folds.length - 1], 16.5)
  for (let i = 1; i < folds.length; ++i) assert.ok(folds[i] >= folds[i - 1])

  // exact states at every landed fold: all flat (|z| only layer nudges = 0
  // here, raw positions), and the finished pose has the wings up
  for (let k = 0; k <= 16; ++k) {
    const { pos } = foldTablePositions(program, k)
    for (const p of pos) assert.equal(Math.abs(p[2]), 0, `state ${k} is flat`)
  }
  const held = foldTablePositions(program, 16.5)
  const zMax = Math.max(...held.pos.map((p) => p[2]))
  assert.ok(zMax > 0.5, `wings rise out of plane (z ${zMax.toFixed(2)})`)

  // rasterized scene carries the fold value onto frames
  const scene = views.get('scene')!
  const withFold = scene.rows.filter((r) => typeof r.fold === 'number')
  assert.ok(withFold.length > 0, 'scene frames carry fold')
  const last = withFold[withFold.length - 1]
  assert.equal(last.fold, 16.5)
})

test('Hydra Meta sample: replace/append/setSource/layer rewrite the sketch across the loop', () => {
  const sample = SAMPLES.find((s) => s.name === 'Hydra Meta')!
  const { views } = createRuntime({
    editableRows: (name: string, schema, seed?: Record<string, unknown>[]) =>
      (seed ?? sample.tables?.[name] ?? []).map((r) => conformRow(r, schemaColumns(schema))),
  }).run(sample.code, { seed: 1 })

  // The enum columns declared as string[] materialize as enum columns with
  // their options, and every seed value fits its type (no invalid rows).
  const hydra = views.get('hydra')!
  const cols = schemaColumns({
    beat: 'number',
    event: ['setCode', 'setSource', 'append', 'replace', 'layer', 'transition', 'setVariable'],
    output: ['o0', 'o1', 'o2', 'o3'],
    code: 'code', find: 'string', name: 'string', value: 'number',
    mode: ['blend', 'add', 'mult', 'diff', 'layer', 'mask'],
  })
  assert.equal(cols.find((c) => c.name === 'event')!.type, 'enum')
  assert.deepEqual(cols.find((c) => c.name === 'mode')!.options,
    ['blend', 'add', 'mult', 'diff', 'layer', 'mask'])
  for (const r of hydra.rows) assert.deepEqual(invalidColumns(r, cols), [], 'seed rows conform')

  const index = buildHydraIndex(hydra.rows)
  const at = (beat: number) => hydraFrameAt(index, Math.round((beat - 1) * 30))!

  // beat 1: the bare oscillator.
  assert.equal(at(1).code, 'osc(20, 0.1, 1.2).out(o0)')
  // beat 5: replace retuned 20 → 45 in place.
  assert.equal(at(5).code, 'osc(45, 0.1, 1.2).out(o0)')
  // beat 7: append grew the chain with a kaleidoscope.
  assert.equal(at(7).code, 'osc(45, 0.1, 1.2).kaleid(5).out(o0)')
  // beat 9: setSource swapped osc → noise, the kaleidoscope carried over.
  assert.equal(at(9).code, 'noise(2.5, 0.3).kaleid(5).out(o0)')
  // beat 13: an additive layer of voronoi over the current sketch.
  assert.equal(at(13).code, 'noise(2.5, 0.3).kaleid(5).add(voronoi(10), 0.5).out(o0)')
  // beat 14: a transition wipes from that whole program (the "before") to a
  // fresh sketch (the "after") through the user's mask — a gradient thresholded
  // by transitionPos. The mask is wrapped so transitionStart/End/Pos are in
  // scope, the window baked in props.time units: beat 14 = 6.5s, +2 beats = 7.5s.
  const posFn = '(t) => Math.min(Math.max((t - 6.5) / 1, 0), 1)'
  const userMask = 'gradient(0).thresh((props) => 1 - transitionPos(props.time), 0.15)'
  const maskExpr = `((transitionStart, transitionEnd, transitionPos) => (${userMask}))(6.5, 7.5, ${posFn})`
  assert.equal(
    at(14).code,
    'noise(2.5, 0.3).kaleid(5).add(voronoi(10), 0.5).layer((osc(30, 0.2, 2).kaleid(7))'
    + `.mask(${maskExpr})).out(o0)`,
  )
  // Nothing is injected per frame (vars stay empty), and the code is byte-stable
  // through the wipe (beat 15, frame 420, is mid-window) — so it never recompiles.
  assert.deepEqual(at(14).vars, {})
  assert.equal(at(15).code, at(14).code)
  // At beat 16 (frame 450) the 2-beat window has elapsed: the wipe collapses to
  // just the after sketch, leaving nothing of the before or the mask behind.
  assert.equal(at(16).code, 'osc(30, 0.2, 2).kaleid(7).out(o0)')
  // frameToBeat is the inverse used above — a light sanity tie to constants.
  assert.equal(Math.round(frameToBeat(0)), 1)
})

test('Origami Cicada sample: nine simple folds, all exact', () => {
  const sample = SAMPLES.find((s) => s.name === 'Origami Cicada')!
  const { views } = createRuntime({
    editableRows: (name: string, schema: Record<string, ColumnType>, seed?: Record<string, unknown>[]) =>
      (seed ?? sample.tables?.[name] ?? []).map((r) => conformRow(r, schemaColumns(schema))),
  }).run(sample.code, { seed: 1 })
  const events = views.get('events')!
  const program = events.rows.find((r) => r.type === 'create')!.program as FoldTableProgram
  assert.equal(program.steps.length, 9)
  for (const step of program.steps) assert.equal(step.type, 'Pureland')
  // every landed state is flat, and the finished bug has wings past the
  // body on both sides
  for (let k = 0; k <= 9; ++k) {
    const { pos } = foldTablePositions(program, k)
    for (const p of pos) assert.ok(Math.abs(p[2]) < 1e-12, `state ${k} flat`)
  }
  const done = foldTablePositions(program, 9)
  const xs = done.pos.map((p) => p[0])
  assert.ok(Math.max(...xs) - Math.min(...xs) > 0.8, 'wings splay wide')
})
