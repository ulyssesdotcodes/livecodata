// livecodata runtime — the cook network
// ----------------------------------------------------------------------------
// A reactive dataflow engine over named views (à la Houdini node cooking). A
// program registers views with define("name", (rand, table) => <Table>); the
// engine cooks them on demand, in dependency order, caching each result.
// ----------------------------------------------------------------------------

import { createDSL, Table, type ViewFn, type DSLContext, type GraphSpec, type PhysicsEngine } from './dsl.js'
import { getLineage, withLineage, type Row } from './lineage.js'

type DefEntry =
  | { kind: 'lazy'; fn: ViewFn }
  | { kind: 'const'; table: Table }
  | { kind: 'group'; members: string[] }

interface ResolvedGraph {
  table: Table
  columns: string[]
  viewName?: string | null
}

export interface RuntimeResult {
  views: Map<string, Table>
  graphs: ResolvedGraph[]
  deps: Map<string, string[]>
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hashString(s: string): number {
  let h = 2166136261 >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export interface RuntimeOptions {
  physics?: () => PhysicsEngine | null
}

export function createRuntime({ physics }: RuntimeOptions = {}): { run: (code: string, opts?: { seed?: number }) => RuntimeResult } {
  let defs: Map<string, DefEntry>
  let cache: Map<string, Table>
  let deps: Map<string, string[]>
  let graphs: GraphSpec[]
  let seedVal: number
  let prngs: Map<string, () => number>
  let groups: Map<string, string[]>
  let currentCookingView: string | null = null

  function randForView(name: string): () => number {
    if (!prngs.has(name)) prngs.set(name, mulberry32((seedVal ^ hashString(name)) >>> 0))
    return prngs.get(name)!
  }

  function stamp(name: string, table: Table): Table {
    const rows = table.rows.map((r, index) =>
      withLineage({ ...r }, [...getLineage(r), { table: name, index }]))
    return new Table(rows, ctx)
  }

  function cook(name: string, callerView: string | null, stack: string[]): Table {
    if (cache.has(name)) {
      if (callerView) deps.get(callerView)?.push(name)
      return cache.get(name)!
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

    if (def.kind === 'group') {
      if (!deps.has(name)) deps.set(name, [])
      const groupStack = [...stack, name]
      const rows: Row[] = def.members.flatMap((m) => cook(m, name, groupStack).rows)
      rows.sort((a, b) => ((a.index as number) ?? 0) - ((b.index as number) ?? 0))
      const stamped = stamp(name, new Table(rows, ctx))
      cache.set(name, stamped)
      return stamped
    }

    if (!deps.has(name)) deps.set(name, [])
    const nextStack = [...stack, name]
    const rand = randForView(name)
    const localTable = (dep: string) => cook(dep, name, nextStack)
    const prevCooking = currentCookingView
    currentCookingView = name
    const raw = def.fn(rand, localTable)
    currentCookingView = prevCooking
    const result = raw instanceof Table
      ? raw
      : new Table(Array.isArray(raw) ? (raw as Row[]).map((r) => ({ ...r })) : [], ctx)
    const stamped = stamp(name, result)
    cache.set(name, stamped)
    return stamped
  }

  const ctx: DSLContext = {
    defineLazy(name: string, fn: ViewFn, group?: string): void {
      defs.set(name, { kind: 'lazy', fn })
      if (group) {
        if (!groups.has(group)) groups.set(group, [])
        groups.get(group)!.push(name)
      }
    },
    defineConst(name: string, table: Table): void {
      defs.set(name, { kind: 'const', table })
      cache.set(name, table)
    },
    addGraph(spec: GraphSpec): void {
      graphs.push({ ...spec, viewName: currentCookingView })
    },
    resolve(name: string): Table {
      return cook(name, null, [])
    },
    physics: () => (physics ? physics() : null),
  }

  const api = createDSL(ctx)

  function run(code: string, { seed = 0 } = {}): RuntimeResult {
    defs = new Map()
    cache = new Map()
    deps = new Map()
    graphs = []
    prngs = new Map()
    groups = new Map()
    seedVal = seed >>> 0

    const fn = new Function(...Object.keys(api), code) as (...args: unknown[]) => void
    fn(...Object.values(api))

    for (const [group, members] of groups) {
      defs.set(group, { kind: 'group', members })
    }

    for (const name of defs.keys()) cook(name, null, [])

    const resolvedGraphs = graphs
      .map((g): ResolvedGraph | null => {
        const table = g.table
          ? (g.viewName ? cache.get(g.viewName) ?? g.table : g.table)
          : (g.name ? cache.get(g.name) : undefined)
        return table ? { table, columns: g.columns, viewName: g.viewName ?? g.table?.name } : null
      })
      .filter((x): x is ResolvedGraph => x !== null)

    return { views: cache, graphs: resolvedGraphs, deps }
  }

  return { run }
}
