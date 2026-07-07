// livecodata runtime — the cook network
// ----------------------------------------------------------------------------
// A reactive dataflow engine over named views (à la Houdini node cooking). A
// program registers views with define("name", (rand, table) => <Table>); the
// engine cooks them on demand, in dependency order.
//
// Cooking now builds a lazy op-graph (see dsl.ts): running a view's fn assembles
// Table nodes (and discovers its table() dependencies) but does not compute rows.
// After cooking, the engine *materializes* each view, reusing a previous run's
// rows whenever a node's content hash is unchanged (a 2-generation memo). So an
// edit that leaves the physics subgraph untouched will not re-bake physics.
// ----------------------------------------------------------------------------

import {
  createDSL, Table, materialize,
  type ViewFn, type DSLContext, type GraphSpec, type PhysicsEngine, type Memo, type MatCtx,
} from './dsl.js'
import { getLineage, withLineage, type Row } from './lineage.js'
import type { ColumnType } from './editable-tables.js'

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
  tapRows?: () => Row[] | null
  editableRows?: (name: string, schema: Record<string, ColumnType>, seedRows?: Row[]) => Row[]
}

export interface RunOptions {
  seed?: number
  // Cook only these views (and their deps) instead of all — used to cheaply
  // recompute a tempo-driven "timeline" on a beat tap without re-running the rest.
  only?: string[]
  dataCache?: Map<string, string>
}

export function createRuntime({ physics, tapRows, editableRows }: RuntimeOptions = {}): { run: (code: string, opts?: RunOptions) => RuntimeResult } {
  let defs: Map<string, DefEntry>
  let cache: Map<string, Table>
  let deps: Map<string, string[]>
  let graphs: GraphSpec[]
  let seedVal: number
  let prngs: Map<string, () => number>
  let groups: Map<string, string[]>
  let currentCookingView: string | null = null
  let dataCache = new Map<string, string>()

  // Cross-run row cache keyed by content hash. Two generations: at run start the
  // current map rolls into `prev`, so a result survives one run of non-use before
  // being evicted (bounds memory while still catching same-as-last-run subgraphs).
  let curMemo = new Map<number, Row[]>()
  let prevMemo = new Map<number, Row[]>()
  const memo: Memo = {
    get: (h) => curMemo.get(h) ?? prevMemo.get(h),
    set: (h, rows) => { curMemo.set(h, rows) },
  }

  function randForView(name: string): () => number {
    if (!prngs.has(name)) prngs.set(name, mulberry32((seedVal ^ hashString(name)) >>> 0))
    return prngs.get(name)!
  }

  // Wrap a Table in a 'stamp' node that appends this view's provenance ref
  // ({ table: name, index }) to each row's lineage when materialized.
  function stampNode(name: string, input: Table): Table {
    return Table._fromNode(ctx, {
      op: 'stamp',
      spec: { name },
      inputs: [input],
      seedSensitive: false,
      compute: (ins) => ins[0].map((r, index) =>
        withLineage({ ...r }, [...getLineage(r), { table: name, index }])),
    })
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
      const stamped = stampNode(name, def.table)
      cache.set(name, stamped)
      return stamped
    }

    if (def.kind === 'group') {
      if (!deps.has(name)) deps.set(name, [])
      const groupStack = [...stack, name]
      const members = def.members.map((m) => cook(m, name, groupStack))
      const groupT = Table._fromNode(ctx, {
        op: 'group',
        spec: { members: def.members },
        inputs: members,
        seedSensitive: false,
        compute: (ins) => {
          const rows: Row[] = ins.flat()
          rows.sort((a, b) => ((a.beat as number) ?? 1) - ((b.beat as number) ?? 1))
          return rows
        },
      })
      const stamped = stampNode(name, groupT)
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
    const stamped = stampNode(name, result)
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
    },
    addGraph(spec: GraphSpec): void {
      graphs.push({ ...spec, viewName: currentCookingView })
    },
    resolve(name: string): Table {
      return cook(name, null, [])
    },
    physics: () => (physics ? physics() : null),
    tapRows: () => (tapRows ? tapRows() : null),
    getData: (url: string) => dataCache.get(url) ?? '',
    editableRows: (name: string, schema: Record<string, ColumnType>, seedRows?: Row[]) =>
      (editableRows ? editableRows(name, schema, seedRows) : []),
  }

  const api = createDSL(ctx)
  const matCtx: MatCtx = { physics: () => (physics ? physics() : null) }

  function run(code: string, { seed = 0, only, dataCache: dc }: RunOptions = {}): RuntimeResult {
    defs = new Map()
    cache = new Map()
    deps = new Map()
    graphs = []
    prngs = new Map()
    groups = new Map()
    seedVal = seed >>> 0
    ctx.seed = seedVal
    dataCache = dc ?? new Map()

    // Roll the memo forward one generation.
    prevMemo = curMemo
    curMemo = new Map()

    const fn = new Function(...Object.keys(api), code) as (...args: unknown[]) => void
    fn(...Object.values(api))

    for (const [group, members] of groups) {
      defs.set(group, { kind: 'group', members })
    }

    // Cook (build the op-graphs + discover deps) then materialize, reusing
    // unchanged subgraphs from the memo. With `only`, cook just those views.
    const toCook = only ?? [...defs.keys()]
    for (const name of toCook) if (defs.has(name)) cook(name, null, [])
    for (const t of cache.values()) materialize(t, matCtx, memo)

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
