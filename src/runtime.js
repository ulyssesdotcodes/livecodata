// livecodata runtime — the cook network
// ----------------------------------------------------------------------------
// A reactive dataflow engine over named views (à la Houdini node cooking). A
// program registers views with define("name", (rand, table) => <Table>); the
// engine cooks them on demand, in dependency order, caching each result.
//
// Calling table("x") inside a view both materializes "x" and records a
// dependency edge. Each view receives its own injected `rand` and `table`
// arguments — no mutable instance state tracks the current view.
//
// cook() is a pure recursive function: callerView and stack are threaded as
// parameters. rand and table are injected per-invocation, not routed through
// shared mutable state.
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
  // Per-run state, reset by run(). cook() reads these but never swaps a
  // "current view" pointer — callerView and stack are threaded as parameters.
  let defs    // Map<name, { kind:'lazy', fn } | { kind:'const', table }>
  let cache   // Map<name, Table>  — cooked results
  let deps    // Map<name, string[]> — discovered dependency edges
  let graphs  // queued graph specs
  let seedVal // run seed
  let prngs   // Map<name, () => number> — per-view random streams
  let groups  // Map<groupId, string[]> — view names tagged into each group

  function randForView(name) {
    if (!prngs.has(name)) prngs.set(name, mulberry32((seedVal ^ hashString(name)) >>> 0))
    return prngs.get(name)
  }

  // Cook a view by name, memoized.
  //   callerView — name of the view that triggered this cook (for dep recording), or null
  //   stack      — names currently on the cook path, for cycle detection
  function cook(name, callerView, stack) {
    if (cache.has(name)) {
      if (callerView) deps.get(callerView)?.push(name)
      return cache.get(name)
    }
    const def = defs.get(name)
    if (!def) {
      throw new Error(`table("${name}") not found — define("${name}", (rand, table) => ...) it first`)
    }
    if (stack.includes(name)) {
      throw new Error(`cycle in cook: ${[...stack, name].join(' -> ')}`)
    }
    if (callerView) deps.get(callerView)?.push(name)

    if (def.kind === 'const') {
      cache.set(name, def.table)
      return def.table
    }

    // A group view is the index-sorted concatenation of its member views.
    if (def.kind === 'group') {
      if (!deps.has(name)) deps.set(name, [])
      const groupStack = [...stack, name]
      const rows = def.members.flatMap((m) => cook(m, name, groupStack).rows)
      rows.sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      const grouped = new Table(rows, ctx)
      cache.set(name, grouped)
      return grouped
    }

    if (!deps.has(name)) deps.set(name, [])
    const nextStack = [...stack, name]
    // Inject per-view rand and a dep-tracking table resolver as parameters.
    const rand = randForView(name)
    const localTable = (dep) => cook(dep, name, nextStack)
    const raw = def.fn(rand, localTable)
    const result = raw instanceof Table
      ? raw
      : new Table(Array.isArray(raw) ? raw.map((r) => ({ ...r })) : [], ctx)
    cache.set(name, result)
    return result
  }

  // The hooks the DSL builders call. Stable identity so createDSL binds once.
  const ctx = {
    defineLazy(name, fn, group) {
      defs.set(name, { kind: 'lazy', fn })
      if (group) {
        if (!groups.has(group)) groups.set(group, [])
        groups.get(group).push(name)
      }
    },
    defineConst(name, table) {
      defs.set(name, { kind: 'const', table })
      cache.set(name, table)
    },
    addGraph(spec) {
      graphs.push(spec)
    },
    // top-level table() calls (outside any view): no callerView, empty stack
    resolve(name) {
      return cook(name, null, [])
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
    groups = new Map()
    seedVal = seed >>> 0

    const fn = new Function(...Object.keys(api), code)
    fn(...Object.values(api))

    // Register each group as a view that merges its tagged members (index-sorted).
    for (const [group, members] of groups) {
      defs.set(group, { kind: 'group', members })
    }

    // Force every defined view to materialize (consts are already cached).
    for (const name of defs.keys()) cook(name, null, [])

    const resolvedGraphs = graphs
      .map((g) => (g.table ? g : { table: cache.get(g.name), columns: g.columns }))
      .filter((g) => g.table)

    return { views: cache, graphs: resolvedGraphs, deps }
  }

  return { run }
}
