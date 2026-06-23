// livecodata DSL
// ----------------------------------------------------------------------------
// A tiny, JavaScript-flavoured DSL for generating tables and using those tables
// to drive visuals. Tables are (for now) arrays of plain row objects, implicitly
// ordered by row index — each row is one ~1/60s frame. Every builder returns a
// new Table, so everything chains.
//
// Tables are no longer built-and-saved imperatively; they are *defined* as named
// views and cooked by the engine (see runtime.js). The DSL itself is UI-agnostic:
// it builds Tables and talks to the engine through a small `ctx` of hooks.
//
// Surface (injected into user code by the engine):
//   define("name", (rand, table) => <Table>)  register a named view (cooked lazily)
//   define("name", "group", (rand, table) => <Table>)  also tag the view into a
//     group: the engine auto-creates a view named "group" that concatenates every
//     member, index-sorted — so e.g. base creates + flash events merge into one
//     "events" table with no manual concat/sort.
//     rand()   seeded per-view PRNG in [0,1); deterministic per run + view name
//     table()  dep-tracked resolver — records the dependency edge for this view
//   table("name")                  resolve a view at top-level (no dep tracking)
//   math(index => ...)             sample a function of the row index
//     .range(count)                -> Table of { index, value }, count rows
//   rows([ {...}, ... ])           wrap a literal array of rows in a Table
//
//   Table.map / filter / filterMap / concat / slice / fold / scan   transforms
//   Table.graph(...columns)        render this table to the graph panel
//   Table.save("name")             sugar for define("name", () => this)
// ----------------------------------------------------------------------------

import { rasterizeRows } from './rasterize.js'

export class Table {
  constructor(rows = [], ctx = null) {
    this.rows = rows
    this.name = null
    this._ctx = ctx
  }

  get length() {
    return this.rows.length
  }

  // Union of keys across all rows, in first-seen order. Used for display.
  get columns() {
    const seen = []
    const set = new Set()
    for (const row of this.rows) {
      for (const k of Object.keys(row)) {
        if (!set.has(k)) {
          set.add(k)
          seen.push(k)
        }
      }
    }
    return seen
  }

  map(fn) {
    return new Table(this.rows.map((r, i) => fn(r, i)), this._ctx)
  }

  filter(fn) {
    return new Table(this.rows.filter((r, i) => fn(r, i)), this._ctx)
  }

  // filter + flatMap in one pass: fn(row, i, rows) returns a row, an array of
  // rows, or null/undefined to drop it. Returns a new Table of everything kept.
  // The workhorse for deriving one event stream from another — e.g. turning each
  // "create" in a base scene into a flash event per trigger.
  filterMap(fn) {
    const out = []
    this.rows.forEach((r, i) => {
      const res = fn(r, i, this.rows)
      if (res == null) return
      if (Array.isArray(res)) out.push(...res)
      else out.push(res)
    })
    return new Table(out, this._ctx)
  }

  concat(other) {
    const otherRows = other instanceof Table ? other.rows : (other ?? [])
    return new Table([...this.rows, ...otherRows], this._ctx)
  }

  slice(start, end) {
    return new Table(this.rows.slice(start, end), this._ctx)
  }

  // Left fold over the rows, exactly like Array.reduce. The callback gets
  // (accumulator, current, index, rows), so the previous row is rows[index-1].
  // Returns the bare accumulator (any type).
  fold(fn, initial) {
    let acc = initial
    for (let i = 0; i < this.rows.length; i++) {
      acc = fn(acc, this.rows[i], i, this.rows)
    }
    return acc
  }

  // A stateful fold that emits rows as it goes and stays chainable. For each
  // row, fn(state, current, index, rows) returns { state, emit }: `state` is
  // threaded to the next call, `emit` (a row, array of rows, or null) is
  // appended to the output. Returns a new Table of everything emitted.
  scan(fn, initialState) {
    const out = []
    let state = initialState
    for (let i = 0; i < this.rows.length; i++) {
      const res = fn(state, this.rows[i], i, this.rows)
      if (res == null) continue
      if ('state' in res) state = res.state
      const emit = res.emit
      if (Array.isArray(emit)) out.push(...emit)
      else if (emit != null) out.push(emit)
    }
    return new Table(out, this._ctx)
  }

  // Bake this sparse event table into a dense, frame-indexed cache: one row per
  // alive object per frame, with position/rotation interpolated and color
  // stepped (see rasterize.js). This is the table playback indexes into.
  // `maxFrame` sets the timeline length; omit it to infer from the max index.
  rasterize(maxFrame) {
    return new Table(rasterizeRows(this.rows, maxFrame), this._ctx)
  }

  // Queue this table to be drawn on the graph panel. The named columns become
  // y-series plotted against the row index (or the `index` column if present).
  // With no columns, every numeric column (besides `index`) is plotted.
  graph(...columns) {
    const cols = columns.flat().filter(Boolean)
    this._ctx?.addGraph({ table: this, columns: cols })
    return this
  }

  // Sugar for define("name", () => this): register this already-built table as
  // a constant named view.
  save(name) {
    this.name = name
    this._ctx?.defineConst(name, this)
    return this
  }
}

class MathBuilder {
  constructor(fn, ctx) {
    this._fn = fn
    this._ctx = ctx
  }

  // Sample the function once per row for `count` rows. Each row is one frame:
  // { index, value } where value = fn(index).
  range(count) {
    const n = Math.max(1, Math.round(count))
    const rows = new Array(n)
    for (let index = 0; index < n; index++) {
      rows[index] = { index, value: this._fn(index) }
    }
    return new Table(rows, this._ctx)
  }
}

// Build the DSL surface bound to an engine context. `ctx` provides the hooks the
// builders need: defineLazy/defineConst (registration), resolve (look up another
// view at the top level), and addGraph (queue a render spec).
// rand and table inside views are injected per-cook by the engine, not from ctx.
export function createDSL(ctx) {
  return {
    // define(name, fn) or define(name, group, fn). A 3-arg call tags the view
    // into a named group (see runtime.js — the engine builds the group view).
    define: (name, group, fn) =>
      fn === undefined
        ? ctx.defineLazy(name, group)
        : ctx.defineLazy(name, fn, group),
    table: (name) => ctx.resolve(name),
    math: (fn) => new MathBuilder(fn, ctx),
    rows: (arr) => new Table((arr ?? []).map((r) => ({ ...r })), ctx),
  }
}
