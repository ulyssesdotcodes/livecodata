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
// which appends a create (or declare-schema) event on first sight and returns
// the folded rows. That's the "specify types in the code editor" path; the
// table panel's own +table / +column UI is the other way to create/shape one.
// Column type "code" marks cells edited in the main code editor (click the
// cell) rather than inline.
//
// A table's *effective* columns are computed, not stored as one blob: each
// table tracks `userColumns` (a fold over genuine table-panel actions —
// add/remove/rename/retype a column, or the seed of a table-panel-created
// table) separately from `declared` (the most recent schema a program passed
// to editable(name, schema)). effectiveColumns() merges the two on every read
// — declared supplies columns and their order, userColumns overrides a
// declared column's type once the user has explicitly touched it (and
// contributes any extra columns declared doesn't mention) — so a column the
// user genuinely added/edited survives regardless of what the program
// declares on a later Apply, while a column that only ever existed because
// the program declared it comes and goes freely as the declaration changes.
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
// event that touched this table (riding along through renames). `columns`
// isn't stored directly — see effectiveColumns() below — so that a column's
// provenance (declared by the program vs. added/edited by the user) survives
// the fold instead of collapsing into one opaque list.
interface TableState {
  // Columns from genuine table-panel actions: add-column, a rename/retype
  // (even of a column that started out declared — touching it via the table
  // panel "claims" it), or the seed columns of a table-panel-created table.
  // Never mutated by a program's editable(name, schema) call.
  userColumns: EditableColumn[]
  // Column names explicitly removed via the table panel — excluded from the
  // effective columns even if `declared` still asks for them, so a removal
  // sticks instead of reappearing on the program's next Apply.
  removedColumns: Set<string>
  // The most recently declared schema (editable(name, schema)), or null for
  // a table the program never declared (purely table-panel driven, e.g. "+
  // table"). Replaced wholesale by each declare-schema event.
  declared: EditableColumn[] | null
  rows: Row[]
  events: Row[]
  // True for a pure event stream created via record() — an Apply pulse,
  // peer-join/leave, … (see EditableTableStore.record). Never has columns or
  // rows of its own, so it isn't a "row-editable table" at all; the table
  // panel shows it read-only, as its own event history, rather than offering
  // add/rename/retype-column or add/remove-row controls that would do nothing.
  log: boolean
}

// Merge a declared schema with the user's own columns: declared supplies the
// columns and their order, but a userColumns entry for the same name (the
// user explicitly retyped it via the table panel) overrides declared's type
// — an explicit user edit always wins over what the program currently says.
// Columns only in userColumns (the program never declared them) are appended
// after, in their own order.
function mergeColumns(userColumns: EditableColumn[], declared: EditableColumn[]): EditableColumn[] {
  const userByName = new Map(userColumns.map((c) => [c.name, c]))
  const declaredNames = new Set(declared.map((c) => c.name))
  const merged = declared.map((c) => userByName.get(c.name) ?? c)
  for (const c of userColumns) if (!declaredNames.has(c.name)) merged.push(c)
  return merged
}

// The columns a table actually shows: declared merged with userColumns (see
// mergeColumns), minus anything explicitly removed via the table panel. This
// is the one place "what are this table's columns right now" is computed —
// everywhere else works off it rather than reading a stored `columns` field.
function effectiveColumns(t: TableState): EditableColumn[] {
  const cols = t.declared ? mergeColumns(t.userColumns, t.declared) : t.userColumns
  return t.removedColumns.size ? cols.filter((c) => !t.removedColumns.has(c.name)) : cols
}

// The display form of an event: everything but the table name (implicit in
// which events-table it appears in), seq/t first.
function eventRow(e: StampedEvent): Row {
  const { table: _table, ...rest } = e
  return rest
}

// Rebuild a row to match `columns`, keeping matching data, defaulting the rest.
// Exported for the cook worker, which mirrors ensure()'s read-only replay
// semantics against a rows snapshot (see cook-service.ts).
export function conformRow(row: Row, columns: EditableColumn[]): Row {
  const next: Row = {}
  for (const c of columns) next[c.name] = c.name in row ? row[c.name] : defaultFor(c.type)
  return next
}

// An editable() schema in column-list form — the shape create/declare-schema
// events carry.
export function schemaColumns(schema: Record<string, ColumnType>): EditableColumn[] {
  return Object.entries(schema).map(([n, t]) => ({ name: n, type: t }))
}

// Apply one event to the map of table states. Defensive (events may come from
// storage): unknown tables / columns / rows are ignored rather than thrown.
function applyEvent(tables: Map<string, TableState>, e: StampedEvent): void {
  const name = e.table as string
  if (e.kind === 'create') {
    if (tables.has(name)) return
    const columns = (e.columns as EditableColumn[] ?? []).map((c) => ({ ...c }))
    // A DSL-originated create (ensure()'s first sight of the table) seeds
    // `declared`; a table-panel create ("+ table", or record()'s columnless
    // stream) seeds `userColumns` directly — it has no program declaring it.
    const declared = e.declared === true ? columns : null
    const t: TableState = { userColumns: declared ? [] : columns, removedColumns: new Set(), declared, rows: [], events: [eventRow(e)], log: e.log === true }
    t.rows = ((e.rows as Row[] | undefined) ?? []).map((r) => conformRow(r, effectiveColumns(t)))
    tables.set(name, t)
    return
  }
  const t = tables.get(name)
  if (!t) return
  t.events.push(eventRow(e))
  switch (e.kind) {
    case 'declare-schema': {
      t.declared = (e.columns as EditableColumn[] ?? []).map((c) => ({ ...c }))
      t.rows = t.rows.map((r) => conformRow(r, effectiveColumns(t)))
      break
    }
    case 'add-column': {
      const col = e.col as string
      if (!col || effectiveColumns(t).some((c) => c.name === col)) break
      t.userColumns.push({ name: col, type: e.type as ColumnType })
      t.removedColumns.delete(col)
      t.rows = t.rows.map((r) => conformRow(r, effectiveColumns(t)))
      break
    }
    case 'remove-column': {
      const col = e.col as string
      t.userColumns = t.userColumns.filter((c) => c.name !== col)
      t.removedColumns.add(col)
      t.rows = t.rows.map((r) => conformRow(r, effectiveColumns(t)))
      break
    }
    case 'rename-column': {
      const col = e.col as string, to = e.to as string
      const before = effectiveColumns(t)
      const existing = before.find((c) => c.name === col)
      if (!existing || !to || before.some((c) => c.name === to)) break
      const owned = t.userColumns.find((c) => c.name === col)
      if (owned) owned.name = to
      // A rename of a declared-only column "claims" it under the new name —
      // the old declared name may still reappear (see effectiveColumns), now
      // as a fresh column, if the program keeps declaring it.
      else t.userColumns.push({ name: to, type: existing.type })
      t.rows.forEach((r) => { r[to] = r[col]; delete r[col] })
      t.rows = t.rows.map((r) => conformRow(r, effectiveColumns(t)))
      break
    }
    case 'set-column-type': {
      const col = e.col as string, type = e.type as ColumnType
      const owned = t.userColumns.find((c) => c.name === col)
      if (owned) owned.type = type
      // Retyping a declared-only column "claims" it, same as a rename above.
      else if (effectiveColumns(t).some((c) => c.name === col)) t.userColumns.push({ name: col, type })
      break
    }
    case 'add-row': {
      const row: Row = {}
      for (const c of effectiveColumns(t)) row[c.name] = defaultFor(c.type)
      t.rows.push(row)
      break
    }
    case 'remove-row': {
      const i = e.row as number
      if (i >= 0 && i < t.rows.length) t.rows.splice(i, 1)
      break
    }
    case 'duplicate-row': {
      const i = e.row as number
      const row = t.rows[i]
      if (row) t.rows.splice(i + 1, 0, { ...row })
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
  // True for a table created via record() (see below) — a pure event stream,
  // never a row-editable table, regardless of what has()/get() report. The
  // table panel uses this to skip offering row/column editing controls for it.
  isLog(name: string): boolean
  get(name: string): EditableTableData | undefined
  createTable(name: string): void
  removeTable(name: string): void
  renameTable(name: string, newName: string): boolean
  // Called by the DSL's editable(name, schema): appends a create event on
  // first sight (optionally seeding rows), a declare-schema event when the
  // declared schema changed, and returns the folded (current) rows. The
  // effective columns are always a function of the *current* declared schema
  // plus a fold over the table's own genuine edit events (see
  // effectiveColumns/mergeColumns) — never a snapshot of "whatever the
  // columns happened to be last time". So a column that's only ever been
  // declared, never touched by the user, tracks the program's schema exactly
  // (added when declared, gone when not); a column the user added or
  // edited via the table panel survives regardless of what's declared.
  ensure(name: string, schema: Record<string, ColumnType>, seedRows?: Row[]): Row[]
  addColumn(name: string, colName: string, type: ColumnType): void
  removeColumn(name: string, colName: string): void
  setColumnType(name: string, colName: string, type: ColumnType): void
  renameColumn(name: string, colName: string, newName: string): boolean
  addRow(name: string): void
  removeRow(name: string, index: number): void
  // Insert a copy of the row at `index` immediately after it.
  duplicateRow(name: string, index: number): void
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

  return {
    log,
    listNames: () => [...view().keys()],
    has: (name) => view().has(name),
    isLog: (name) => view().get(name)?.log ?? false,

    get(name: string): EditableTableData | undefined {
      const t = view().get(name)
      return t ? { columns: effectiveColumns(t), rows: t.rows, events: t.events } : undefined
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
      // not append create/declare-schema events. Serve the historical rows
      // (or the seed, if the program references a table that didn't exist at
      // that run).
      if (replay) {
        const t = replay.get(name)
        if (t) return t.rows
        return (seedRows ?? []).map((r) => conformRow(r, wantCols))
      }
      const existing = tables.get(name)
      if (!existing) {
        append({ kind: 'create', table: name, columns: wantCols, rows: seedRows, declared: true })
      } else if (JSON.stringify(existing.declared) !== JSON.stringify(wantCols)) {
        append({ kind: 'declare-schema', table: name, columns: wantCols })
      }
      return tables.get(name)!.rows
    },

    addColumn(name: string, colName: string, type: ColumnType): void {
      colName = colName.trim()
      const t = tables.get(name)
      if (!t || !colName || effectiveColumns(t).some((c) => c.name === colName)) return
      append({ kind: 'add-column', table: name, col: colName, type })
    },

    removeColumn(name: string, colName: string): void {
      const t = tables.get(name)
      if (!t || !effectiveColumns(t).some((c) => c.name === colName)) return
      append({ kind: 'remove-column', table: name, col: colName })
    },

    setColumnType(name: string, colName: string, type: ColumnType): void {
      const t = tables.get(name)
      const col = t && effectiveColumns(t).find((c) => c.name === colName)
      if (!col || col.type === type) return
      append({ kind: 'set-column-type', table: name, col: colName, type })
    },

    renameColumn(name: string, colName: string, newName: string): boolean {
      newName = newName.trim()
      const t = tables.get(name)
      if (!t || !newName || newName === colName) return false
      const cols = effectiveColumns(t)
      if (!cols.some((c) => c.name === colName) || cols.some((c) => c.name === newName)) return false
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

    duplicateRow(name: string, index: number): void {
      const t = tables.get(name)
      if (!t || index < 0 || index >= t.rows.length) return
      append({ kind: 'duplicate-row', table: name, row: index })
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
      if (!tables.has(table)) append({ kind: 'create', table, columns: [], log: true })
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
