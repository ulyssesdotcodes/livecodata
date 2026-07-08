// livecodata editable tables — event-sourced
// ----------------------------------------------------------------------------
// User-authored tables, as opposed to the code-generated views produced by
// running the DSL program. What is *stored* is never the table itself but the
// append-only log of change events — add-row, set-cell, rename-column, … —
// on the shared event-log primitive. The visible table is a fold of those
// events up to now, so every editable table is really two tables: the
// interactive current state (`name`) and the read-only edit history
// (`name·events`). Editing a cell doesn't overwrite anything; it appends.
//
// The whole store — every table — rides ONE event log, so its serialize/load
// round-trips the entire store in one shot: that's the unit a session
// persists (see sessions.ts/main.ts) and also the unit multiplayer syncs (see
// multiplayer.ts) — merging in another replica's events refolds every table
// (including "code") from the union. The store itself holds no storage
// reference of its own; the caller owns if/when/where it's saved.
//
// The main program is not exempt from this: it lives here too, as an
// editable table named "code" (columns `code`/`seed`, always exactly one
// row) that main.ts writes on every Run. Clicking Apply/Ctrl-Enter records a
// "run" (see recordRun/SessionRun) — a bookmark of every table's log index at
// that moment, spanning the whole store rather than just "code" — and the
// session bar scrubs those runs, folding the log back to any of them
// (setReplayView) to reproduce the exact state then. So "the session" is this
// store's events *plus* its list of runs (persisted together — see sessions.ts).
//
// A program reads a table via the DSL's editable(name, schema) — see dsl.ts —
// which appends a create (or schema-reconcile) event on first sight and
// returns the folded rows. That's the "specify types in the code editor"
// path; the table panel's own +table / +column UI is the other way to
// create/shape one. Column type "code" marks cells edited in the main code
// editor (click the cell) rather than inline.
// ----------------------------------------------------------------------------

import { createEventLog, type EventLog, type StampedEvent } from './event-log.js'
import type { Row } from './lineage.js'

export type ColumnType = 'number' | 'string' | 'boolean' | 'code'

// A "run": the session bookmark recorded when the user clicks Apply (Ctrl-Enter)
// after a batch of edits. It captures, per editable table, how many of that
// table's log events had landed at that moment (its name·events length) — the
// "index per editable table event log" the session scrubs over. Because the
// whole store rides ONE ordered log, that snapshot is exactly a prefix of the
// log: `at` is its length, and re-folding the log up to `at` reconstructs every
// table's state as it was at that run. `tables` is the same cut expressed the
// way the user thinks of it (one index per table) — kept for display and so the
// serialized session literally is "the event data + a list of per-table
// indices", but replay uses `at`, which stays correct across renames/removes.
export interface SessionRun {
  at: number
  tables: Record<string, number>
}

export interface EditableColumn {
  name: string
  type: ColumnType
}

export interface EditableTableData {
  columns: EditableColumn[]
  rows: Row[]
  // The edit history, as display rows for the read-only `name·events` table.
  events: Row[]
}

function defaultFor(type: ColumnType): unknown {
  switch (type) {
    case 'number': return 0
    case 'boolean': return false
    default: return ''
  }
}

// One table's folded state. `events` accumulates the display form of every
// event that touched this table (riding along through renames).
interface TableState {
  columns: EditableColumn[]
  rows: Row[]
  events: Row[]
}

// The display form of an event: everything but the table name (implicit in
// which events-table it appears in), seq/t first.
function eventRow(e: StampedEvent): Row {
  const { table: _table, ...rest } = e
  return rest
}

// Rebuild a row to match `columns`, keeping matching data, defaulting the rest.
function conformRow(row: Row, columns: EditableColumn[]): Row {
  const next: Row = {}
  for (const c of columns) next[c.name] = c.name in row ? row[c.name] : defaultFor(c.type)
  return next
}

// Apply one event to the map of table states. Defensive (events may come from
// storage): unknown tables / columns / rows are ignored rather than thrown.
function applyEvent(tables: Map<string, TableState>, e: StampedEvent): void {
  const name = e.table as string
  if (e.kind === 'create') {
    if (tables.has(name)) return
    const columns = (e.columns as EditableColumn[] ?? []).map((c) => ({ ...c }))
    const rows = ((e.rows as Row[] | undefined) ?? []).map((r) => conformRow(r, columns))
    tables.set(name, { columns, rows, events: [eventRow(e)] })
    return
  }
  const t = tables.get(name)
  if (!t) return
  t.events.push(eventRow(e))
  switch (e.kind) {
    case 'schema': {
      const columns = (e.columns as EditableColumn[] ?? []).map((c) => ({ ...c }))
      t.rows = t.rows.map((r) => conformRow(r, columns))
      t.columns = columns
      break
    }
    case 'add-column': {
      const col = e.col as string
      if (!col || t.columns.some((c) => c.name === col)) break
      t.columns.push({ name: col, type: e.type as ColumnType })
      const d = defaultFor(e.type as ColumnType)
      t.rows.forEach((r) => { r[col] = d })
      break
    }
    case 'remove-column': {
      const col = e.col as string
      t.columns = t.columns.filter((c) => c.name !== col)
      t.rows.forEach((r) => { delete r[col] })
      break
    }
    case 'rename-column': {
      const col = e.col as string, to = e.to as string
      const c = t.columns.find((c) => c.name === col)
      if (!c || !to || t.columns.some((c) => c.name === to)) break
      c.name = to
      t.rows.forEach((r) => { r[to] = r[col]; delete r[col] })
      break
    }
    case 'set-column-type': {
      const c = t.columns.find((c) => c.name === e.col)
      if (c) c.type = e.type as ColumnType
      break
    }
    case 'add-row': {
      const row: Row = {}
      for (const c of t.columns) row[c.name] = defaultFor(c.type)
      t.rows.push(row)
      break
    }
    case 'remove-row': {
      const i = e.row as number
      if (i >= 0 && i < t.rows.length) t.rows.splice(i, 1)
      break
    }
    case 'set-cell': {
      const row = t.rows[e.row as number]
      if (row) row[e.col as string] = e.value
      break
    }
    case 'set-row': {
      const row = t.rows[e.row as number]
      if (row) Object.assign(row, e.values as Record<string, unknown>)
      break
    }
    case 'rename-table': {
      const to = e.to as string
      if (!to || tables.has(to)) break
      tables.delete(name)
      tables.set(to, t)
      break
    }
    case 'remove-table':
      tables.delete(name)
      break
  }
}

// Fold a list of events into the table-state map — the whole store's state at
// the end of that list. Folding a *prefix* of the log (see setReplayView)
// reconstructs the store as it was at an earlier run.
function foldEventsMap(events: StampedEvent[]): Map<string, TableState> {
  const tables = new Map<string, TableState>()
  for (const e of events) applyEvent(tables, e)
  return tables
}

export interface EditableTableStore {
  // The underlying event log — the unit multiplayer syncs. Remote events
  // merged into it refold the store and fire onChange.
  readonly log: EventLog
  listNames(): string[]
  has(name: string): boolean
  get(name: string): EditableTableData | undefined
  createTable(name: string): void
  removeTable(name: string): void
  renameTable(name: string, newName: string): boolean
  // Called by the DSL's editable(name, schema): appends a create event on first
  // use (optionally seeding rows), and returns the folded (current) rows. On
  // later calls the declared schema is a *floor*, not a replacement: any
  // declared column missing from the live table is added, and a declared
  // column whose type disagrees is retyped — but a column the table has that
  // isn't declared (e.g. one added via the table panel's "+ column") is left
  // alone, so it survives the next Apply instead of being silently dropped.
  // Removing a column is only ever explicit (the table panel's own
  // removeColumn), never a side effect of re-running the program.
  ensure(name: string, schema: Record<string, ColumnType>, seedRows?: Row[]): Row[]
  addColumn(name: string, colName: string, type: ColumnType): void
  removeColumn(name: string, colName: string): void
  setColumnType(name: string, colName: string, type: ColumnType): void
  renameColumn(name: string, colName: string, newName: string): boolean
  addRow(name: string): void
  removeRow(name: string, index: number): void
  setCell(name: string, index: number, colName: string, value: unknown): void
  // Atomically set several cells of one row in a single event — e.g. a
  // program Run sets `code` and `seed` together, so the pair is always one
  // history entry rather than two, and is never observed half-updated.
  setRow(name: string, index: number, values: Record<string, unknown>): void
  // Record an arbitrary event on `table` (auto-creating it, with no columns,
  // on first sight) — for append-only event streams that aren't user-editable
  // rows at all: an Apply bookmark, a peer joining/leaving, … (see main.ts).
  // Rides the exact same store log as every real editable table, so it's
  // covered by the same serialize/load/merge/multiplayer-sync path for free,
  // and shows up as "table·events" like any other history — multiplayer
  // syncing genuinely is just "sync the log, replay on connection," this is
  // what lets peer-connection and run/apply events ride that too instead of
  // needing a channel of their own.
  record(table: string, kind: string, payload?: Record<string, unknown>): void
  // Fired after any change event lands (a fold consumer should re-read).
  onChange(cb: () => void): void
  // --- runs (session history) ---------------------------------------------
  // Record the current per-table log indices as a new run (the Apply/Ctrl-Enter
  // bookmark) and return it. The runs are the coordinates the session bar
  // scrubs over; the serialized list rides alongside the event data in a saved
  // session (see sessions.ts).
  recordRun(): SessionRun
  runs(): SessionRun[]
  setRuns(runs: SessionRun[]): void
  // Reconstruct runs from a legacy session that saved no run list, one per
  // recorded program Run in "code"'s own history (best-effort backward compat).
  deriveRunsFromCode(): void
  // Show the store as it was at `run` — reads (get/has/listNames/ensure) serve
  // that historical fold and ensure() appends nothing, so a scrubbed replay is
  // a pure preview. `null` returns to the live head. Any real mutation also
  // returns to head (you edit the head, never rewrite history).
  setReplayView(run: SessionRun | null): void
  // The whole store as one serialized blob (every table's events) — the event
  // data half of what a session persists (runs are the other half). load()
  // replaces the store's entire history and re-folds every table from scratch,
  // resetting runs; clear() empties it. Both notify like any other change.
  serialize(): string
  load(json: string | unknown): boolean
  clear(): void
}

export function createEditableTableStore({ src }: { src?: string } = {}): EditableTableStore {
  const log = createEventLog({ src })
  // The live head fold, kept incrementally: append() applies the new event to
  // this map. Always the full log — replay views are separate (below).
  let tables = new Map<string, TableState>()
  // The recorded runs (Apply bookmarks) — the session bar's scrub coordinates.
  let runs: SessionRun[] = []
  // When set (a scrubbed replay), reads serve this historical fold instead of
  // `tables`, and ensure() is read-only. Null = live head. Any append() clears
  // it, so an edit always lands on the head, never on a past run.
  let replay: Map<string, TableState> | null = null
  const listeners: (() => void)[] = []
  const notify = (): void => listeners.forEach((cb) => cb())

  // Which fold reads resolve against — the replay view while scrubbing, else head.
  const view = (): Map<string, TableState> => replay ?? tables

  function refold(): void {
    tables = foldEventsMap(log.all())
  }

  function append(payload: Record<string, unknown> & { kind: string; table: string }): void {
    replay = null
    const e = log.append(payload)
    applyEvent(tables, e)
    notify()
  }

  // Remote events (multiplayer) can land between existing ones, so the
  // incremental fold can't absorb them — rebuild it from the merged log. Any
  // in-progress replay view is dropped too: it's a fold of a log prefix, and
  // that prefix's meaning can shift once earlier history changes underneath it.
  log.onMerge(() => {
    replay = null
    refold()
    notify()
  })

  const schemaColumns = (schema: Record<string, ColumnType>): EditableColumn[] =>
    Object.entries(schema).map(([n, t]) => ({ name: n, type: t }))

  // The floor a re-declared schema applies to an existing table: every
  // existing column survives (so a column added via the table panel isn't
  // clobbered by the next Apply); declared columns missing from `existing` are
  // appended, and a declared column already present is retyped to match.
  const mergeColumns = (existing: EditableColumn[], declared: EditableColumn[]): EditableColumn[] => {
    const declaredByName = new Map(declared.map((c) => [c.name, c]))
    const merged = existing.map((c) => declaredByName.get(c.name) ?? c)
    const haveNames = new Set(existing.map((c) => c.name))
    for (const c of declared) if (!haveNames.has(c.name)) merged.push(c)
    return merged
  }

  return {
    log,
    listNames: () => [...view().keys()],
    has: (name) => view().has(name),

    get(name: string): EditableTableData | undefined {
      const t = view().get(name)
      return t ? { columns: t.columns, rows: t.rows, events: t.events } : undefined
    },

    createTable(name: string): void {
      if (tables.has(name)) return
      // New tables start with a "beat" column — the convention every other table
      // here keys time by (1-indexed beats).
      append({ kind: 'create', table: name, columns: [{ name: 'beat', type: 'number' }] })
    },

    removeTable(name: string): void {
      if (!tables.has(name)) return
      append({ kind: 'remove-table', table: name })
    },

    renameTable(name: string, newName: string): boolean {
      newName = newName.trim()
      if (!newName || !tables.has(name) || tables.has(newName)) return false
      append({ kind: 'rename-table', table: name, to: newName })
      return true
    },

    ensure(name: string, schema: Record<string, ColumnType>, seedRows?: Row[]): Row[] {
      const wantCols = schemaColumns(schema)
      // Replay is a read-only preview: a cook running against a past run must
      // not append create/schema events. Serve the historical rows (or the
      // seed, if the program references a table that didn't exist at that run).
      if (replay) {
        const t = replay.get(name)
        if (t) return t.rows
        return (seedRows ?? []).map((r) => conformRow(r, wantCols))
      }
      const existing = tables.get(name)
      if (!existing) {
        append({ kind: 'create', table: name, columns: wantCols, rows: seedRows })
      } else {
        const merged = mergeColumns(existing.columns, wantCols)
        if (JSON.stringify(existing.columns) !== JSON.stringify(merged)) {
          append({ kind: 'schema', table: name, columns: merged })
        }
      }
      return tables.get(name)!.rows
    },

    addColumn(name: string, colName: string, type: ColumnType): void {
      colName = colName.trim()
      const t = tables.get(name)
      if (!t || !colName || t.columns.some((c) => c.name === colName)) return
      append({ kind: 'add-column', table: name, col: colName, type })
    },

    removeColumn(name: string, colName: string): void {
      if (!tables.get(name)?.columns.some((c) => c.name === colName)) return
      append({ kind: 'remove-column', table: name, col: colName })
    },

    setColumnType(name: string, colName: string, type: ColumnType): void {
      const col = tables.get(name)?.columns.find((c) => c.name === colName)
      if (!col || col.type === type) return
      append({ kind: 'set-column-type', table: name, col: colName, type })
    },

    renameColumn(name: string, colName: string, newName: string): boolean {
      newName = newName.trim()
      const t = tables.get(name)
      if (!t || !newName || newName === colName) return false
      if (!t.columns.some((c) => c.name === colName) || t.columns.some((c) => c.name === newName)) return false
      append({ kind: 'rename-column', table: name, col: colName, to: newName })
      return true
    },

    addRow(name: string): void {
      if (!tables.has(name)) return
      append({ kind: 'add-row', table: name })
    },

    removeRow(name: string, index: number): void {
      const t = tables.get(name)
      if (!t || index < 0 || index >= t.rows.length) return
      append({ kind: 'remove-row', table: name, row: index })
    },

    setCell(name: string, index: number, colName: string, value: unknown): void {
      if (!tables.get(name)?.rows[index]) return
      append({ kind: 'set-cell', table: name, row: index, col: colName, value })
    },

    setRow(name: string, index: number, values: Record<string, unknown>): void {
      if (!tables.get(name)?.rows[index]) return
      append({ kind: 'set-row', table: name, row: index, values })
    },

    record(table: string, kind: string, payload: Record<string, unknown> = {}): void {
      if (!tables.has(table)) append({ kind: 'create', table, columns: [] })
      append({ kind, table, ...payload })
    },

    onChange(cb: () => void): void {
      listeners.push(cb)
    },

    recordRun(): SessionRun {
      replay = null
      const tableIdx: Record<string, number> = {}
      for (const [name, t] of tables) tableIdx[name] = t.events.length
      const run: SessionRun = { at: log.length, tables: tableIdx }
      runs.push(run)
      return run
    },

    runs: () => runs.map((r) => ({ at: r.at, tables: { ...r.tables } })),

    setRuns(next: SessionRun[]): void {
      runs = next.map((r) => ({ at: r.at, tables: { ...r.tables } }))
    },

    deriveRunsFromCode(): void {
      const code = tables.get('code')
      const all = log.all()
      runs = (code?.events ?? []).map((e) => {
        const at = (e.seq as number) + 1
        const tableIdx: Record<string, number> = {}
        for (const [name, t] of foldEventsMap(all.slice(0, at))) tableIdx[name] = t.events.length
        return { at, tables: tableIdx }
      })
    },

    setReplayView(run: SessionRun | null): void {
      replay = run ? foldEventsMap(log.all().slice(0, run.at)) : null
    },

    serialize: () => log.serialize(),

    load(json: string | unknown): boolean {
      if (!log.load(json)) return false
      replay = null
      runs = []
      refold()
      notify()
      return true
    },

    clear(): void {
      log.clear()
      tables = new Map()
      replay = null
      runs = []
      notify()
    },
  }
}
