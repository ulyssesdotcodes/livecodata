// livecodata DSL
// ----------------------------------------------------------------------------
// A tiny, JavaScript-flavoured DSL for generating tables and using those tables
// to drive visuals. Tables are (for now) arrays of plain row objects, implicitly
// ordered by row index — each row is one ~1/60s frame. Every builder returns a
// new Table, so everything chains.
//
// Surface:
//   math(index => ...)             sample a function of the row index
//     .range(count)                -> Table of { index, value }, count rows
//   rows([ {...}, ... ])           wrap a literal array of rows in a Table
//   table("name")                  look up a previously .save()'d table
//
//   Table.map(fn)                  map rows -> rows
//   Table.filter(fn)               keep rows where fn(row) is truthy
//   Table.sortBy(key | fn)         stable-ish sort by column or accessor
//   Table.concat(other)            append another table's rows
//   Table.slice(start, end)        sub-range of rows
//   Table.fold(fn, init)           left-fold over rows, like Array.reduce:
//                                  fn(acc, current, index, rows) -> acc.
//                                  Returns the bare accumulator (any type).
//   Table.scan(fn, initState)      stateful, row-emitting fold that stays
//                                  chainable. fn(state, current, index, rows)
//                                  returns { state, emit } where emit is a row,
//                                  an array of rows, or null. Returns a new
//                                  Table of everything emitted.
//   Table.graph(...columns)        render this table to the graph panel, using
//                                  the named columns as y-series (x is index).
//                                  With no args, plots every numeric column.
//   Table.save("name")             register in the store and return self
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
  // This is the general primitive behind the table-driven idea: fold a value
  // table down to anything — an event table, a sum, a min/max, etc. Wrap an
  // accumulated array of rows with rows(...) to get a chainable Table back.
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
  // appended to the output. Returns a new Table of everything emitted — so
  // unlike fold you don't need to wrap the result in rows(...).
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
    if (this._ctx) this._ctx.graphs.push({ table: this, columns: cols })
    return this
  }

  save(name) {
    this.name = name
    if (this._ctx) this._ctx.store.set(name, this)
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

// Create an isolated DSL instance with its own table store and graph queue.
// Returns { api, store, graphs } where `api` holds the functions injected into
// user code, `store` is a Map<name, Table>, and `graphs` collects .graph() specs.
export function createDSL() {
  const ctx = { store: new Map(), graphs: [] }

  const api = {
    math: (fn) => new MathBuilder(fn, ctx),

    rows: (arr) => new Table((arr ?? []).map((r) => ({ ...r })), ctx),

    table: (name) => {
      const t = ctx.store.get(name)
      if (!t) throw new Error(`table("${name}") not found — did you .save("${name}") it first?`)
      return t
    },
  }

  return { api, store: ctx.store, graphs: ctx.graphs }
}
