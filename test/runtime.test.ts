import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRuntime } from '../src/runtime.js'
import { createEditableTableStore } from '../src/editable-tables.js'
import type { Row } from '../src/lineage.js'

test('cooks defined views and resolves table() dependencies', () => {
  const rt = createRuntime()
  const code = `
    define("nums", () => math(t => t * 30).range(4/30))
    define("doubled", (rand, table) => table("nums").map(r => ({ beat: r.beat, value: r.value * 2 })))
  `
  const { views } = rt.run(code, { seed: 1 })
  assert.deepEqual(views.get('nums')!.rows.map((r) => r.value), [0, 1, 2, 3])
  assert.deepEqual(views.get('doubled')!.rows.map((r) => r.value), [0, 2, 4, 6])
})

test('records the dependency edges it discovers', () => {
  const rt = createRuntime()
  const code = `
    define("a", () => rows([{ v: 1 }]))
    define("b", (rand, table) => table("a").map(r => ({ v: r.v + 1 })))
    define("c", (rand, table) => table("a").concat(table("b")))
  `
  const { deps } = rt.run(code, { seed: 1 })
  assert.deepEqual(deps.get('b'), ['a'])
  assert.deepEqual(deps.get('c'), ['a', 'b'])
})

test('a shared upstream view is cooked exactly once per run', () => {
  const rt = createRuntime()
  ;(globalThis as Record<string, unknown>).__cookCount = 0
  const code = `
    define("c", () => { globalThis.__cookCount++; return rows([{ v: 1 }]) })
    define("a", (rand, table) => table("c").map(r => ({ ...r, a: 1 })))
    define("b", (rand, table) => table("c").map(r => ({ ...r, b: 1 })))
  `
  rt.run(code, { seed: 1 })
  assert.equal((globalThis as Record<string, unknown>).__cookCount, 1)
  delete (globalThis as Record<string, unknown>).__cookCount
})

test('rand is deterministic for a given seed and varies by seed', () => {
  const rt = createRuntime()
  const code = `define("r", (rand) => math(() => rand()).range(6))`
  const a = rt.run(code, { seed: 42 }).views.get('r')!.rows.map((r) => r.value)
  const b = rt.run(code, { seed: 42 }).views.get('r')!.rows.map((r) => r.value)
  const c = rt.run(code, { seed: 7 }).views.get('r')!.rows.map((r) => r.value)
  assert.deepEqual(a, b, 'same seed → identical sequence')
  assert.notDeepEqual(a, c, 'different seed → different sequence')
  for (const v of a) assert.ok((v as number) >= 0 && (v as number) < 1, `rand in [0,1): ${v}`)
})

test("each view has an independent rand stream (order-independent)", () => {
  const rt = createRuntime()
  const code1 = `
    define("x", (rand) => math(() => rand()).range(3))
    define("y", (rand, table) => table("x").map(r => ({ v: rand() })))
  `
  const code2 = `
    define("y", (rand, table) => table("x").map(r => ({ v: rand() })))
    define("x", (rand) => math(() => rand()).range(3))
  `
  const x1 = rt.run(code1, { seed: 99 }).views.get('x')!.rows.map((r) => r.value)
  const x2 = rt.run(code2, { seed: 99 }).views.get('x')!.rows.map((r) => r.value)
  assert.deepEqual(x1, x2)
})

test('save() registers a constant view, still resolvable by table()', () => {
  const rt = createRuntime()
  const code = `
    rows([{ v: 1 }]).save("k")
    define("d", (rand, table) => table("k").map(r => ({ d: r.v + 1 })))
  `
  const { views } = rt.run(code, { seed: 1 })
  assert.equal(views.get('k')!.rows[0].v, 1)
  assert.equal(views.get('d')!.rows[0].d, 2)
})

test('graph specs are resolved to their cooked tables', () => {
  const rt = createRuntime()
  const code = `define("g", () => math(t => t).range(3/30).graph("value"))`
  const { graphs } = rt.run(code, { seed: 1 })
  assert.equal(graphs.length, 1)
  assert.deepEqual(graphs[0].columns, ['value'])
  assert.equal(graphs[0].table.rows.length, 3)
})

test('resolving an undefined view throws a helpful error', () => {
  const rt = createRuntime()
  assert.throws(
    () => rt.run(`define("x", (rand, table) => table("missing"))`, { seed: 1 }),
    /table\("missing"\) not found/,
  )
})

test('a dependency cycle is detected', () => {
  const rt = createRuntime()
  const code = `
    define("a", (rand, table) => table("b"))
    define("b", (rand, table) => table("a"))
  `
  assert.throws(() => rt.run(code, { seed: 1 }), /cycle in cook/)
})

test('a group view merges its members, beat-sorted', () => {
  const rt = createRuntime()
  const code = `
    define("a", "g", () => rows([{ beat: 5, tag: "a" }, { beat: 1, tag: "a" }]))
    define("b", "g", () => rows([{ beat: 3, tag: "b" }, { beat: 0, tag: "b" }]))
  `
  const { views, deps } = rt.run(code, { seed: 1 })
  const g = views.get('g')!.rows
  assert.deepEqual(g.map((r) => r.beat), [0, 1, 3, 5], 'concatenated then beat-sorted')
  assert.deepEqual(deps.get('g')!.sort(), ['a', 'b'])
})

test('reproduces the zero-crossing events program end-to-end', () => {
  const rt = createRuntime()
  const code = `
    define("wave", () => math(i => Math.sin(i * Math.PI / 4)).range(16))
    define("base", "events", () => rows([{ id: "s", type: "create", beat: 1, shape: "sphere",
      color: 0x4a9eff, px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 }]))
    define("flash", "events", (rand, table) => {
      const crossings = table("wave").filterMap((cur, i, rows) =>
        i > 0 && cur.value * rows[i - 1].value < 0 ? { beat: cur.beat } : null)
      return table("base").filterMap(o =>
        o.type !== "create" ? null
          : crossings.rows.map(c => ({ id: o.id, type: "color", beat: c.beat, color: 0xffffff })))
    })
  `
  const { views } = rt.run(code, { seed: 1 })
  const events = views.get('events')!.rows
  assert.equal(events[0].type, 'create')
  assert.ok(events.some((e) => e.type === 'color'), 'a zero-crossing color event exists')
  assert.deepEqual(events.map((e) => e.beat), [...events.map((e) => e.beat)].sort((a, b) => (a as number) - (b as number)),
    'events come out beat-sorted')
})

test('incremental cooking reuses an unchanged physics subgraph across runs', () => {
  // A fake engine that counts how many times it actually bakes.
  let bakes = 0
  const engine = {
    simulate: (rows: Row[]): Row[] => {
      bakes++
      return [...rows, { id: 'x', type: 'update', beat: 2, py: 1 }]
    },
  }
  const rt = createRuntime({ physics: () => engine })
  const codeA = `
    define("base", () => rows([{ id: "x", type: "create", motion: "dynamic" }]))
    define("sim", (rand, table) => physics(table("base")).simulate({ steps: 1 }))
    define("out", (rand, table) => table("sim").map(r => ({ ...r })))
  `
  rt.run(codeA, { seed: 1 })
  assert.equal(bakes, 1)

  // Edit an unrelated downstream view (and even change the seed): physics is
  // reused from the memo, so it is NOT re-baked.
  const codeB = codeA.replace('table("sim").map(r => ({ ...r }))', 'table("sim").map(r => ({ ...r, tag: 2 }))')
  rt.run(codeB, { seed: 2 })
  assert.equal(bakes, 1, 'editing a downstream view did not re-bake physics')

  // Changing the physics inputs (opts) does re-bake.
  const codeC = codeA.replace('{ steps: 1 }', '{ steps: 2 }')
  rt.run(codeC, { seed: 3 })
  assert.equal(bakes, 2, 'changing the physics opts re-bakes')
})

test('editable() reads rows from the editable-table store and is usable like any table', () => {
  const store = createEditableTableStore()
  store.createTable('scores')
  store.addRow('scores')
  store.setCell('scores', 0, 'value', 5)

  const rt = createRuntime({ editableRows: (name, schema) => store.ensure(name, schema) })
  const code = `
    define("scores", () => editable("scores", { value: "number" }))
    define("doubled", (rand, table) => table("scores").map(r => ({ value: r.value * 2 })))
  `
  const { views } = rt.run(code, { seed: 1 })
  assert.deepEqual(views.get('scores')!.rows.map((r) => r.value), [5])
  assert.deepEqual(views.get('doubled')!.rows.map((r) => r.value), [10])
})

test('editable() edits survive across runs (unlike a computed view)', () => {
  const store = createEditableTableStore()
  const rt = createRuntime({ editableRows: (name, schema) => store.ensure(name, schema) })
  const code = `define("t", () => editable("t", { value: "number" }))`

  rt.run(code, { seed: 1 })
  store.addRow('t')
  store.setCell('t', 0, 'value', 99)

  const { views } = rt.run(code, { seed: 2 })
  assert.deepEqual(views.get('t')!.rows.map((r) => r.value), [99])
})

test('editable() seeds rows on first create only', () => {
  const store = createEditableTableStore()
  const rt = createRuntime({ editableRows: (name, schema, seedRows) => store.ensure(name, schema, seedRows) })
  const code = `define("h", () => editable("h", { beat: "number", code: "code" }, [{ beat: 1, code: "src(s0).out()" }]))`

  const first = rt.run(code, { seed: 1 })
  assert.deepEqual(first.views.get('h')!.rows.map((r) => r.code), ['src(s0).out()'])

  // A user edit sticks; the seed rows are not re-applied on later runs.
  store.setCell('h', 0, 'code', 'osc(4).out()')
  const second = rt.run(code, { seed: 2 })
  assert.deepEqual(second.views.get('h')!.rows.map((r) => r.code), ['osc(4).out()'])
})
