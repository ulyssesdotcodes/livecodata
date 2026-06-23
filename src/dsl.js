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
//   csv("a,b\n1,2")                parse a pasted CSV string into a Table
//   json([ {...} ] | "[...]")      wrap/parse a JSON array into a Table
//   grid(cols, rows)               a cols×rows lattice of XZ object positions
//   linear/easeIn/easeOut/easeInOut   easing curves for a color pulse's `ease`
//                                     (any t => t' works, e.g. ease: t => t*t)
//
//   Table.map / filter / filterMap / concat / slice / fold / scan   transforms
//   Table.join(other,on) / zip(other)          combine two tables (key / positional)
//   Table.orderBy / derive / assign / mapField / rescale / lag   reshape & derive
//   Table.groupBy(key).agg({ field: rows=>v }) group & aggregate
//   Table.trigger(pred,emit) / triggerEach(pred,objs,make) / crossings(field,level)
//                                  event detection — "when X, do Y" (and fan out)
//   Table.graph(...columns)        draw this table on the graph panel
//   Table.rasterize(maxFrame)      bake events into the dense frame cache
//   Table.save("name")             sugar for define("name", () => this)
// ----------------------------------------------------------------------------

import { rasterizeRows } from './rasterize.js'
import { withLineage, carry, unionLineage } from './lineage.js'

// ── Row helpers ─────────────────────────────────────────────────────────────
// Every transform clones each row (so views never share row objects) and threads
// lineage onto the result. Capturing that once here keeps the verbs below
// declarative — they say what they produce, not how to copy and tag it.

// Clone a row and stamp `refs` as its lineage.
const tag = (row, refs) => withLineage({ ...row }, refs)

// Clone a row, carrying its own lineage forward — the default for transforms that
// reshape or reorder rows without changing where they came from.
const recarry = (row) => tag(row, carry(row))

// Normalize an emit result — a row, an array of rows, or null/undefined — into a
// flat array of cloned rows each stamped with `refs`. The shared shape behind
// filterMap / scan / trigger / triggerEach: "for this source, emit these rows".
const spread = (res, refs) =>
  res == null ? [] : (Array.isArray(res) ? res : [res]).map((e) => tag(e, refs))

// The rows of a Table, a bare array, or nothing — for verbs that accept either.
const rowsOf = (x) => (x instanceof Table ? x.rows : x ?? [])

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

  // Build a sibling Table sharing this one's engine context. Every transform
  // funnels through here, so the row-cloning + lineage rules live in one place
  // (the row helpers above) rather than being respelled in each verb.
  _wrap(rows) {
    return new Table(rows, this._ctx)
  }

  // Transforms clone each row (so views never share row objects) and thread the
  // source row's lineage onto the result — see the row helpers above.

  map(fn) {
    return this._wrap(this.rows.map((r, i) => tag(fn(r, i), carry(r))))
  }

  filter(fn) {
    return this._wrap(this.rows.filter((r, i) => fn(r, i)).map(recarry))
  }

  // filter + flatMap in one pass: fn(row, i, rows) returns a row, an array of
  // rows, or null/undefined to drop it. Returns a new Table of everything kept.
  // The workhorse for deriving one event stream from another — e.g. turning each
  // "create" in a base scene into a flash event per trigger. Emitted rows inherit
  // the source row's lineage.
  filterMap(fn) {
    return this._wrap(this.rows.flatMap((r, i) => spread(fn(r, i, this.rows), carry(r))))
  }

  concat(other) {
    return this._wrap([...this.rows, ...rowsOf(other)].map(recarry))
  }

  slice(start, end) {
    return this._wrap(this.rows.slice(start, end).map(recarry))
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
    this.rows.forEach((cur, i) => {
      const res = fn(state, cur, i, this.rows)
      if (res == null) return
      if ('state' in res) state = res.state
      // Emitted rows are caused by `cur`, so they inherit its lineage.
      out.push(...spread(res.emit, carry(cur)))
    })
    return this._wrap(out)
  }

  // ── Combine datasets ──────────────────────────────────────────────────────

  // Inner join with another table. `on` is a column present in both, a
  // { left, right } pair of column names, or a fn(row) -> join value. Emits one
  // { ...left, ...right } row per matching pair; lineage is the union of both, so
  // a joined row traces back to its source rows on either side.
  join(other, on) {
    const leftOf = typeof on === 'function' ? on : (r) => r[typeof on === 'object' ? on.left : on]
    const rightOf = typeof on === 'function' ? on : (r) => r[typeof on === 'object' ? on.right : on]
    const index = new Map()
    for (const r of rowsOf(other)) {
      const k = rightOf(r)
      if (!index.has(k)) index.set(k, [])
      index.get(k).push(r)
    }
    const out = []
    for (const l of this.rows) {
      for (const r of index.get(leftOf(l)) ?? []) {
        out.push(withLineage({ ...l, ...r }, unionLineage([l, r])))
      }
    }
    return this._wrap(out)
  }

  // Positional join: pair row i of each table, merging fields ({ ...left, ...right }),
  // stopping at the shorter. Handy for combining frame-aligned series.
  zip(other) {
    const otherRows = rowsOf(other)
    const n = Math.min(this.rows.length, otherRows.length)
    const out = []
    for (let i = 0; i < n; i++) {
      out.push(withLineage({ ...this.rows[i], ...otherRows[i] }, unionLineage([this.rows[i], otherRows[i]])))
    }
    return this._wrap(out)
  }

  // ── Reshape / derive ──────────────────────────────────────────────────────

  // Sort by a column name or accessor fn; dir is 'asc' (default) or 'desc'.
  orderBy(key, dir = 'asc') {
    const accessor = typeof key === 'function' ? key : (r) => r[key]
    const sign = dir === 'desc' ? -1 : 1
    const sorted = [...this.rows].sort((a, b) => {
      const av = accessor(a), bv = accessor(b)
      return av < bv ? -sign : av > bv ? sign : 0
    })
    return this._wrap(sorted.map(recarry))
  }

  // Add or overwrite columns. spec maps a field name to a value or a fn(row, i);
  // all other columns are kept. (Arquero's derive.) `assign` is an alias.
  derive(spec) {
    return this._wrap(this.rows.map((r, i) => {
      const next = { ...r }
      for (const k in spec) next[k] = typeof spec[k] === 'function' ? spec[k](r, i) : spec[k]
      return withLineage(next, carry(r))
    }))
  }

  assign(spec) { return this.derive(spec) }

  // Derive ONE output field from ONE source field: row[dst] = fn(row[src], row, i),
  // keeping every other column. The focused form of derive.
  mapField(src, dst, fn) {
    return this._wrap(this.rows.map((r, i) =>
      withLineage({ ...r, [dst]: fn(r[src], r, i) }, carry(r))))
  }

  // Linearly remap a numeric field from an input range to an output range, into
  // `dst` (defaults to `src`). The grammar-of-graphics "scale" as a verb — the
  // workhorse for mapping a data value to a position, size, or hue.
  rescale(src, [inLo, inHi], [outLo, outHi], dst = src) {
    const span = (inHi - inLo) || 1
    return this._wrap(this.rows.map((r) => {
      const f = (r[src] - inLo) / span
      return withLineage({ ...r, [dst]: outLo + f * (outHi - outLo) }, carry(r))
    }))
  }

  // Add a column carrying `field`'s value from n rows earlier (null for the first n
  // rows) — compare against the past without the rows[i-1] dance.
  lag(field, n = 1, as = `${field}_lag`) {
    return this._wrap(this.rows.map((r, i) =>
      withLineage({ ...r, [as]: i >= n ? this.rows[i - n][field] : null }, carry(r))))
  }

  // ── Group / aggregate ─────────────────────────────────────────────────────

  // Group rows by a key (column name or fn) and aggregate. Returns a grouped
  // handle whose .agg(spec) emits one row per group: { <key>, ...aggregates },
  // each aggregate being fn(groupRows) -> value; .count() is shorthand. The key
  // column is named after the column (or "key" for a fn). Lineage on each output
  // row is the union of that group's rows.
  groupBy(key) {
    const keyName = typeof key === 'function' ? 'key' : key
    const accessor = typeof key === 'function' ? key : (r) => r[key]
    const groups = new Map()
    for (const r of this.rows) {
      const k = accessor(r)
      if (!groups.has(k)) groups.set(k, [])
      groups.get(k).push(r)
    }
    const wrap = (rows) => this._wrap(rows)
    return {
      agg(spec) {
        const out = []
        for (const [k, rs] of groups) {
          const row = { [keyName]: k }
          for (const f in spec) row[f] = spec[f](rs)
          out.push(withLineage(row, unionLineage(rs)))
        }
        return wrap(out)
      },
      count(as = 'count') { return this.agg({ [as]: (rs) => rs.length }) },
    }
  }

  // ── Trigger / event detection ─────────────────────────────────────────────

  // Emit rows only where a predicate fires: where predicate(cur, i, rows) is
  // truthy, emit(cur, i, rows) returns a row, an array of rows, or null to skip.
  // Reads as "when X, do Y" — a named filterMap. Emitted rows inherit cur's lineage.
  trigger(predicate, emit) {
    return this._wrap(this.rows.flatMap((r, i) =>
      predicate(r, i, this.rows) ? spread(emit(r, i, this.rows), carry(r)) : []))
  }

  // On each row where predicate fires, fan out across `objects` (a Table or array):
  // emit make(obj, cur, i, k) for every object row. The workhorse for "when the
  // wave crosses zero, do something to every sphere." Each emitted row's lineage is
  // the union of the trigger row and the object row, so it traces back to both.
  triggerEach(predicate, objects, make) {
    const objRows = rowsOf(objects)
    return this._wrap(this.rows.flatMap((cur, i) =>
      predicate(cur, i, this.rows)
        ? objRows.flatMap((o, k) => spread(make(o, cur, i, k), unionLineage([cur, o])))
        : []))
  }

  // Detect crossings of a numeric `field` past `level` (default 0): emit each row
  // where the series crosses, tagged dir (+1 rising, -1 falling). Sugar for the
  // common zero-crossing predicate; pair with triggerEach to fan out.
  crossings(field = 'value', level = 0) {
    const out = []
    for (let i = 1; i < this.rows.length; i++) {
      const prev = this.rows[i - 1][field] - level
      const cur = this.rows[i][field] - level
      if (prev !== 0 && prev * cur < 0) {
        out.push(withLineage({ ...this.rows[i], dir: cur > 0 ? 1 : -1 }, carry(this.rows[i])))
      }
    }
    return this._wrap(out)
  }

  // Bake this sparse event table into a dense, frame-indexed cache: one row per
  // alive object per frame, with position/rotation interpolated and color
  // stepped (see rasterize.js). This is the table playback indexes into.
  // `maxFrame` sets the timeline length; omit it to infer from the max index.
  rasterize(maxFrame) {
    return this._wrap(rasterizeRows(this.rows, maxFrame))
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

// Easing curves injected into user code, used as the `ease` of a color pulse
// (see rasterize.js). They map progress t in [0,1] to an eased t'; a custom
// curve is just any function of the same shape, e.g. `ease: t => t * t`.
export const EASINGS = {
  linear: (t) => t,
  easeIn: (t) => t * t,
  easeOut: (t) => 1 - (1 - t) * (1 - t),
  easeInOut: (t) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2),
}

// Parse a CSV string into an array of row objects. The first non-empty line is
// the header; cells that look numeric are coerced to Number. Minimal (no quoted
// commas) — enough to paste a dataset inline and start combining it.
function parseCSV(text) {
  const lines = String(text).trim().split(/\r?\n/).filter((l) => l.length)
  if (!lines.length) return []
  const header = lines[0].split(',').map((h) => h.trim())
  return lines.slice(1).map((line) => {
    const cells = line.split(',')
    const row = {}
    header.forEach((h, i) => {
      const raw = (cells[i] ?? '').trim()
      const num = Number(raw)
      row[h] = raw !== '' && !Number.isNaN(num) ? num : raw
    })
    return row
  })
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
    // Inline data import: parse a pasted CSV/JSON dataset into a Table so it can
    // be combined with other views (an async data(url) fetch is a later step).
    csv: (text) => new Table(parseCSV(text), ctx),
    json: (data) => new Table(
      (Array.isArray(data) ? data : typeof data === 'string' ? JSON.parse(data) : []).map((r) => ({ ...r })),
      ctx,
    ),
    // A cols×rows lattice of XZ positions centred on the origin. Each row:
    // { i, col, row, px, py, pz } — drop-in object placement for the scene.
    grid: (cols, rowsN, { spacing = 0.7, y = 0 } = {}) => {
      const out = []
      const total = Math.max(0, cols * rowsN)
      for (let i = 0; i < total; i++) {
        const c = i % cols
        const rr = Math.floor(i / cols)
        out.push({
          i, col: c, row: rr,
          px: (c - (cols - 1) / 2) * spacing, py: y, pz: (rr - (rowsN - 1) / 2) * spacing,
        })
      }
      return new Table(out, ctx)
    },
    ...EASINGS,
  }
}
