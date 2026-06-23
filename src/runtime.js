// livecodata runtime — the cook network
// ----------------------------------------------------------------------------
// A reactive dataflow engine over named views (à la Houdini node cooking).
// A program registers views with define("name", (rand, table) => <Table>).
//
// Cooking a view is a memoized recursive resolution over the definition map:
// asking for a view materializes it — and, transitively, everything it asks
// for via table() — caching each result and recording the dependency edges
// (and any cycles) it discovers along the way.
//
// There is no mutable "current view" pointer and no per-instance scratch:
// every run() builds a fresh, self-contained session, and each view is handed
// its own `rand` (a per-view seeded stream) and `table` (a resolver that
// records the dependency edge) as arguments. const views, lazy views, and
// group views are all just thunks of that shape, so there is a single cook path.
// ----------------------------------------------------------------------------

import { createDSL, Table } from './dsl.js'

// A deterministic [0,1) stream from a 32-bit seed (mulberry32).
const seededStream = (seed) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// FNV-1a string hash → 32-bit, used to give each view its own seed.
const hash = (s) => {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return h >>> 0
}

// Coerce a thunk's result to a Table (tolerating a bare array of rows).
const asTable = (v, ctx) =>
  v instanceof Table ? v : new Table(Array.isArray(v) ? v.map((r) => ({ ...r })) : [], ctx)

// Memoize a unary function by its key.
const memoize = (fn) => {
  const cache = new Map()
  return (key) => (cache.has(key) ? cache.get(key) : cache.set(key, fn(key)).get(key))
}

// Get a Map's array value, creating an empty one on first access.
const listIn = (map, key) => (map.has(key) ? map.get(key) : map.set(key, []).get(key))

// One evaluation of a program: an isolated graph of named views cooked from a
// single run seed. All state lives in this closure and dies with the call.
function cookSession(seed) {
  const defs = new Map()    // name -> (rand, table) => Table | rows
  const deps = new Map()    // name -> names it depends on, in cook order
  const members = new Map() // groupId -> member view names tagged into it
  const graphs = []         // queued { table, columns } render specs
  const cache = new Map()   // name -> cooked Table (memo)
  const randFor = memoize((name) => seededStream((seed ^ hash(name)) >>> 0))

  // Cook a view to its Table, memoized. `stack` is the active cook chain, used
  // only for cycle detection. Each view receives its own rand and a `table`
  // resolver closed over its name, so resolving a dep records the edge for it.
  const cook = (name, stack) => {
    if (cache.has(name)) return cache.get(name)
    if (stack.includes(name)) throw new Error(`cycle in cook: ${[...stack, name].join(' -> ')}`)
    const def = defs.get(name)
    if (!def) throw new Error(`table("${name}") not found — define("${name}", (rand, table) => ...) it first`)

    listIn(deps, name) // every cooked view owns an edge list, even with no deps
    const childStack = [...stack, name]
    const table = (dep) => (listIn(deps, name).push(dep), cook(dep, childStack))
    return cache.set(name, asTable(def(randFor(name), table), ctx)).get(name)
  }

  // A group view is the index-sorted concatenation of its tagged members —
  // just a lazy view whose body resolves each member through `table` (so the
  // group→member edges are recorded like any other dependency).
  const groupThunk = (group) => (_rand, table) =>
    new Table(
      members.get(group).flatMap((m) => table(m).rows).sort((a, b) => (a.index ?? 0) - (b.index ?? 0)),
      ctx,
    )

  // The hooks the DSL builders call. Stable identity so createDSL binds once.
  const ctx = {
    defineLazy: (name, fn, group) => {
      defs.set(name, fn)
      if (group) listIn(members, group).push(name)
    },
    defineConst: (name, table) => defs.set(name, () => table),
    addGraph: (spec) => graphs.push(spec),
    resolve: (name) => cook(name, []), // top-level table(): no caller, no edge
  }

  // Register each group as a synthetic view, force everything to materialize,
  // then hand back the cooked graph.
  const finalize = () => {
    for (const group of members.keys()) defs.set(group, groupThunk(group))
    for (const name of defs.keys()) cook(name, [])
    return { views: cache, graphs: graphs.filter((g) => g.table), deps }
  }

  return { ctx, finalize }
}

export function createRuntime() {
  // Evaluate a program against a fresh session and return the cooked views
  // (Map<name, Table>), resolved graph specs, and the discovered dependency edges.
  const run = (code, { seed = 0 } = {}) => {
    const { ctx, finalize } = cookSession(seed >>> 0)
    const api = createDSL(ctx)
    new Function(...Object.keys(api), code)(...Object.values(api))
    return finalize()
  }

  return { run }
}
