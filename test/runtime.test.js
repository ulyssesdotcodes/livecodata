import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRuntime } from '../src/runtime.js'

test('cooks defined views and resolves table() dependencies', () => {
  const rt = createRuntime()
  const code = `
    define("nums", () => math(i => i).range(4))
    define("doubled", () => table("nums").map(r => ({ index: r.index, value: r.value * 2 })))
  `
  const { views } = rt.run(code, { seed: 1 })
  assert.deepEqual(views.get('nums').rows.map((r) => r.value), [0, 1, 2, 3])
  assert.deepEqual(views.get('doubled').rows.map((r) => r.value), [0, 2, 4, 6])
})

test('records the dependency edges it discovers', () => {
  const rt = createRuntime()
  const code = `
    define("a", () => rows([{ v: 1 }]))
    define("b", () => table("a").map(r => ({ v: r.v + 1 })))
    define("c", () => table("a").concat(table("b")))
  `
  const { deps } = rt.run(code, { seed: 1 })
  assert.deepEqual(deps.get('b'), ['a'])
  assert.deepEqual(deps.get('c'), ['a', 'b'])
})

test('a shared upstream view is cooked exactly once per run', () => {
  const rt = createRuntime()
  globalThis.__cookCount = 0
  const code = `
    define("c", () => { globalThis.__cookCount++; return rows([{ v: 1 }]) })
    define("a", () => table("c").map(r => ({ ...r, a: 1 })))
    define("b", () => table("c").map(r => ({ ...r, b: 1 })))
  `
  rt.run(code, { seed: 1 })
  assert.equal(globalThis.__cookCount, 1)
  delete globalThis.__cookCount
})

test('rand() is deterministic for a given seed and varies by seed', () => {
  const rt = createRuntime()
  const code = `define("r", () => math(() => rand()).range(6))`
  const a = rt.run(code, { seed: 42 }).views.get('r').rows.map((r) => r.value)
  const b = rt.run(code, { seed: 42 }).views.get('r').rows.map((r) => r.value)
  const c = rt.run(code, { seed: 7 }).views.get('r').rows.map((r) => r.value)
  assert.deepEqual(a, b, 'same seed → identical sequence')
  assert.notDeepEqual(a, c, 'different seed → different sequence')
  for (const v of a) assert.ok(v >= 0 && v < 1, `rand in [0,1): ${v}`)
})

test("each view has an independent rand stream (order-independent)", () => {
  const rt = createRuntime()
  // Cooking "x" before/after "y" must not change x's values, because each view
  // is seeded from (runSeed, viewName), not from a shared global stream.
  const code1 = `
    define("x", () => math(() => rand()).range(3))
    define("y", () => table("x").map(r => ({ v: rand() })))
  `
  const code2 = `
    define("y", () => table("x").map(r => ({ v: rand() })))
    define("x", () => math(() => rand()).range(3))
  `
  const x1 = rt.run(code1, { seed: 99 }).views.get('x').rows.map((r) => r.value)
  const x2 = rt.run(code2, { seed: 99 }).views.get('x').rows.map((r) => r.value)
  assert.deepEqual(x1, x2)
})

test('save() registers a constant view, still resolvable by table()', () => {
  const rt = createRuntime()
  const code = `
    rows([{ v: 1 }]).save("k")
    define("d", () => table("k").map(r => ({ d: r.v + 1 })))
  `
  const { views } = rt.run(code, { seed: 1 })
  assert.equal(views.get('k').rows[0].v, 1)
  assert.equal(views.get('d').rows[0].d, 2)
})

test('graph specs are resolved to their cooked tables', () => {
  const rt = createRuntime()
  const code = `define("g", () => math(i => i).range(3).graph("value"))`
  const { graphs } = rt.run(code, { seed: 1 })
  assert.equal(graphs.length, 1)
  assert.deepEqual(graphs[0].columns, ['value'])
  assert.equal(graphs[0].table.rows.length, 3)
})

test('resolving an undefined view throws a helpful error', () => {
  const rt = createRuntime()
  assert.throws(
    () => rt.run(`define("x", () => table("missing"))`, { seed: 1 }),
    /table\("missing"\) not found/,
  )
})

test('a dependency cycle is detected', () => {
  const rt = createRuntime()
  const code = `
    define("a", () => table("b"))
    define("b", () => table("a"))
  `
  assert.throws(() => rt.run(code, { seed: 1 }), /cycle in cook/)
})

test('reproduces the zero-crossing events program end-to-end', () => {
  const rt = createRuntime()
  const code = `
    define("wave", () => math(i => Math.sin(i * Math.PI / 4)).range(16))
    define("base", () => rows([{ id: "s", type: "create", index: 0, shape: "sphere",
      color: 0x4a9eff, px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 }]))
    define("events", () =>
      table("wave")
        .scan((state, cur) => {
          const crossed = state.prev != null && cur.value * state.prev < 0
          return { state: { prev: cur.value },
            emit: crossed ? [{ id: "s", type: "color", index: cur.index, color: 0xffffff }] : null }
        }, { prev: null })
        .concat(table("base"))
        .sortBy("index"))
  `
  const { views } = rt.run(code, { seed: 1 })
  const events = views.get('events').rows
  // The base create event sorts first; at least one color crossing is emitted.
  assert.equal(events[0].type, 'create')
  assert.ok(events.some((e) => e.type === 'color'), 'a zero-crossing color event exists')
})
