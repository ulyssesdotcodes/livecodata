// livecodata DSL
// ----------------------------------------------------------------------------
// A tiny, JavaScript-flavoured DSL for generating tables and using those tables
// to drive visuals. Tables are (for now) arrays of plain row objects. Each
// builder returns a new Table, so everything chains.
//
// Surface:
//   math(time => ...)              sample a function of time into rows
//     .range(seconds, fps = 60)    -> Table of { frame, time, value }
//   rows([ {...}, ... ])           wrap a literal array of rows in a Table
//   table("name")                  look up a previously .save()'d table
//
//   Table.map(fn)                  map rows -> rows
//   Table.filter(fn)               keep rows where fn(row) is truthy
//   Table.sortBy(key | fn)         stable-ish sort by column or accessor
//   Table.concat(other)            append another table's rows
//   Table.slice(start, end)        sub-range of rows
//   Table.trigger(pred, emit)      scan (current, previous) pairs; whenever
//                                  pred is true, emit() rows into a new table
//   Table.save("name")             register in the store and return self
// ----------------------------------------------------------------------------

export class Table {
  constructor(rows = [], store = null) {
    this.rows = rows
    this.name = null
    this._store = store
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
    return new Table(this.rows.map((r, i) => fn(r, i)), this._store)
  }

  filter(fn) {
    return new Table(this.rows.filter((r, i) => fn(r, i)), this._store)
  }

  sortBy(key) {
    const accessor = typeof key === 'function' ? key : (r) => r[key]
    const sorted = [...this.rows].sort((a, b) => {
      const av = accessor(a)
      const bv = accessor(b)
      return av < bv ? -1 : av > bv ? 1 : 0
    })
    return new Table(sorted, this._store)
  }

  concat(other) {
    const otherRows = other instanceof Table ? other.rows : (other ?? [])
    return new Table([...this.rows, ...otherRows], this._store)
  }

  slice(start, end) {
    return new Table(this.rows.slice(start, end), this._store)
  }

  // Walk consecutive (previous, current) row pairs. Whenever pred(current,
  // previous) is true, call emit(current, previous) and collect the returned
  // row(s) into a brand-new table. This is the heart of the table-driven idea:
  // a value table -> an event table.
  trigger(predicate, emit) {
    const out = []
    for (let i = 1; i < this.rows.length; i++) {
      const current = this.rows[i]
      const previous = this.rows[i - 1]
      if (predicate(current, previous)) {
        const emitted = emit(current, previous)
        if (Array.isArray(emitted)) out.push(...emitted)
        else if (emitted != null) out.push(emitted)
      }
    }
    return new Table(out, this._store)
  }

  save(name) {
    this.name = name
    if (this._store) this._store.set(name, this)
    return this
  }
}

class MathBuilder {
  constructor(fn, store) {
    this._fn = fn
    this._store = store
  }

  // Sample the function once per frame across `seconds` seconds at `fps`.
  // Each row is { frame, time, value } — one row per ~1/60s frame by default.
  range(seconds, fps = 60) {
    const count = Math.max(1, Math.round(seconds * fps))
    const rows = new Array(count)
    for (let frame = 0; frame < count; frame++) {
      const time = frame / fps
      rows[frame] = { frame, time, value: this._fn(time, frame) }
    }
    return new Table(rows, this._store)
  }
}

// Create an isolated DSL instance with its own table store.
// Returns { api, store } where `api` holds the functions injected into user
// code and `store` is a Map<name, Table>.
export function createDSL() {
  const store = new Map()

  const api = {
    math: (fn) => new MathBuilder(fn, store),

    rows: (arr) => new Table((arr ?? []).map((r) => ({ ...r })), store),

    table: (name) => {
      const t = store.get(name)
      if (!t) throw new Error(`table("${name}") not found — did you .save("${name}") it first?`)
      return t
    },
  }

  return { api, store }
}
