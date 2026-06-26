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
import { getLineage, withLineage } from './lineage.js'

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

// `physics` is an optional getter returning the loaded physics engine (or null
// while the async Jolt build is still loading). It's threaded onto ctx so the
// DSL's physics() builder can reach the engine during a cook.
export function createRuntime({ physics } = {}) {
  // Per-run state, reset by run(). cook() reads these but never swaps a
  // "current view" pointer — callerView and stack are threaded as parameters.
  let defs    // Map<name, { kind:'lazy', fn } | { kind:'const', table }>
  let cache   // Map<name, Table>  — cooked results
  let deps    // Map<name, string[]> — discovered dependency edges
  let graphs  // queued graph specs
  let seedVal // run seed
  let prngs   // Map<name, () => number> — per-view random streams
  let groups  // Map<groupId, string[]> — view names tagged into each group
  let currentCookingView = null  // which view's fn() is executing right now

  function randForView(name) {
    if (!prngs.has(name)) prngs.set(name, mulberry32((seedVal ^ hashString(name)) >>> 0))
    return prngs.get(name)
  }

  // Materialize a view: clone its rows (so views never share row objects) and
  // append this view's own provenance ref { table: name, index } to each row's
  // lineage. Cloning also makes returning a dependency table directly safe.
  function stamp(name, table) {
    const rows = table.rows.map((r, index) =>
      withLineage({ ...r }, [...getLineage(r), { table: name, index }]))
    return new Table(rows, ctx)
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
      const stamped = stamp(name, def.table)
      cache.set(name, stamped)
      return stamped
    }

    // A group view is the index-sorted concatenation of its member views. Like
    // any view, its rows are stamped with the group's own provenance ref (so the
    // panels can trace them), on top of the lineage each member already carries.
    if (def.kind === 'group') {
      if (!deps.has(name)) deps.set(name, [])
      const groupStack = [...stack, name]
      const rows = def.members.flatMap((m) => cook(m, name, groupStack).rows)
      rows.sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      const stamped = stamp(name, new Table(rows, ctx))
      cache.set(name, stamped)
      return stamped
    }

    if (!deps.has(name)) deps.set(name, [])
    const nextStack = [...stack, name]
    // Inject per-view rand and a dep-tracking table resolver as parameters.
    const rand = randForView(name)
    const localTable = (dep) => cook(dep, name, nextStack)
    const prevCooking = currentCookingView
    currentCookingView = name
    const raw = def.fn(rand, localTable)
    currentCookingView = prevCooking
    const result = raw instanceof Table
      ? raw
      : new Table(Array.isArray(raw) ? raw.map((r) => ({ ...r })) : [], ctx)
    const stamped = stamp(name, result)
    cache.set(name, stamped)
    return stamped
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
      graphs.push({ ...spec, viewName: currentCookingView })
    },
    // top-level table() calls (outside any view): no callerView, empty stack
    resolve(name) {
      return cook(name, null, [])
    },
    // Reach the (async-loaded) physics engine, or null while it's still loading.
    physics: () => (physics ? physics() : null),
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
      .map((g) => {
        const table = g.table
          ? (g.viewName ? cache.get(g.viewName) ?? g.table : g.table)
          : cache.get(g.name)
        return table ? { table, columns: g.columns, viewName: g.viewName ?? g.table?.name } : null
      })
      .filter(Boolean)

    return { views: cache, graphs: resolvedGraphs, deps }
  }

  return { run }
}
