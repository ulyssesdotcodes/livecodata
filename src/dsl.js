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
//   define("name", () => <Table>)  register a named view (a thunk, cooked lazily)
//   table("name")                  resolve another view (records a dependency)
//   math(index => ...)             sample a function of the row index
//     .range(count)                -> Table of { index, value }, count rows
//   rows([ {...}, ... ])           wrap a literal array of rows in a Table
//   rand()                         seeded PRNG in [0,1); deterministic per run
//
//   Table.map / filter / sortBy / concat / slice / fold / scan   transforms
//   Table.graph(...columns)        render this table to the graph panel
//   Table.save("name")             sugar for define("name", () => this)
// ----------------------------------------------------------------------------

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

  sortBy(key) {
    const accessor = typeof key === 'function' ? key : (r) => r[key]
    const sorted = [...this.rows].sort((a, b) => {
      const av = accessor(a)
      const bv = accessor(b)
      return av < bv ? -1 : av > bv ? 1 : 0
    })
    return new Table(sorted, this._ctx)
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
// view, recording a dependency), addGraph (queue a render spec), and rand (the
// seeded PRNG). See runtime.js for the implementation of these hooks.
export function createDSL(ctx) {
  return {
    define: (name, fn) => ctx.defineLazy(name, fn),
    table: (name) => ctx.resolve(name),
    math: (fn) => new MathBuilder(fn, ctx),
    rows: (arr) => new Table((arr ?? []).map((r) => ({ ...r })), ctx),
    rand: () => ctx.rand(),
  }
}
