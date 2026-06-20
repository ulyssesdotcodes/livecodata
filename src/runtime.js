// livecodata runtime — the cook network
// ----------------------------------------------------------------------------
// A reactive dataflow engine over named views (à la Houdini node cooking). A
// program registers views with define("name", () => <Table>); the engine cooks
// them on demand, in dependency order, caching each result. Calling table("x")
// inside a view both materializes "x" and records a dependency edge, so the
// dependency DAG is discovered automatically.
//
// Determinism: each run is cooked from a recorded seed. rand() is a seeded PRNG,
// and every view gets its *own* stream (seeded from the run seed mixed with the
// view name), so a view's random sequence is independent of cook order and of
// other views — which keeps replays reproducible and is safe to memoize.
//
// In this step every view is effectively static (cooked once per run). The dense
// per-frame cache (rasterize) and static-vs-frame tagging arrive in later steps.
// ----------------------------------------------------------------------------

import { createDSL, Table } from './dsl.js'

// Small, fast PRNG. Deterministic given its 32-bit seed.
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// FNV-1a string hash → 32-bit. Used to derive a per-view seed.
function hashString(s) {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export function createRuntime() {
  // Per-run state, reset by run().
  let defs        // Map<name, { kind:'lazy', fn } | { kind:'const', table }>
  let cache       // Map<name, Table>  — cooked results
  let deps        // Map<name, string[]> — discovered dependency edges
  let graphs      // queued graph specs
  let seedVal     // run seed
  let prngs       // Map<name, () => number> — per-view random streams
  let baseRand    // body-level random stream (outside any view)
  let currentView // name of the view being cooked (for dep + rand routing)
  let cookStack   // active cook chain, for cycle detection

  function randForView(name) {
    if (!prngs.has(name)) prngs.set(name, mulberry32((seedVal ^ hashString(name)) >>> 0))
    return prngs.get(name)
  }

  // Cook a view by name, memoized. Records a dependency from the view currently
  // being cooked (if any) onto `name`.
  function cook(name) {
    if (cache.has(name)) {
      if (currentView) deps.get(currentView)?.push(name)
      return cache.get(name)
    }
    const def = defs.get(name)
    if (!def) {
      throw new Error(`table("${name}") not found — define("${name}", () => ...) it first`)
    }
    if (cookStack.includes(name)) {
      throw new Error(`cycle in cook: ${[...cookStack, name].join(' -> ')}`)
    }
    if (currentView) deps.get(currentView)?.push(name)

    if (def.kind === 'const') {
      cache.set(name, def.table)
      return def.table
    }

    cookStack.push(name)
    const prev = currentView
    currentView = name
    if (!deps.has(name)) deps.set(name, [])
    let result
    try {
      result = def.fn()
      if (!(result instanceof Table)) {
        // Tolerate a thunk that returns a bare array of rows.
        result = new Table(Array.isArray(result) ? result.map((r) => ({ ...r })) : [], ctx)
      }
    } finally {
      currentView = prev
      cookStack.pop()
    }
    cache.set(name, result)
    return result
  }

  // The hooks the DSL builders call. Stable identity so createDSL binds once.
  const ctx = {
    defineLazy(name, fn) {
      defs.set(name, { kind: 'lazy', fn })
    },
    defineConst(name, table) {
      defs.set(name, { kind: 'const', table })
      cache.set(name, table)
    },
    addGraph(spec) {
      graphs.push(spec)
    },
    resolve(name) {
      return cook(name)
    },
    rand() {
      return (currentView ? randForView(currentView) : baseRand)()
    },
  }

  const api = createDSL(ctx)

  // Evaluate a program and cook every view it defines. Returns the materialized
  // views (Map<name, Table>), resolved graph specs, and the dependency edges.
  function run(code, { seed = 0 } = {}) {
    defs = new Map()
    cache = new Map()
    deps = new Map()
    graphs = []
    prngs = new Map()
    seedVal = seed >>> 0
    baseRand = mulberry32(seedVal)
    currentView = null
    cookStack = []

    const fn = new Function(...Object.keys(api), code)
    fn(...Object.values(api))

    // Force every defined view to materialize (consts are already cached).
    for (const name of defs.keys()) cook(name)

    const resolvedGraphs = graphs
      .map((g) => (g.table ? g : { table: cache.get(g.name), columns: g.columns }))
      .filter((g) => g.table)

    return { views: cache, graphs: resolvedGraphs, deps }
  }

  return { run }
}
