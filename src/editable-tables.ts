// livecodata editable tables — event-sourced
// ----------------------------------------------------------------------------
// User-authored tables, as opposed to the code-generated views produced by
// running the DSL program. What is *stored* is never the table itself but the
// append-only log of change events — add-row, set-cell, rename-column, … —
// on the same event-log primitive that backs the session's run log. The
// visible table is a fold of those events up to now, so every editable table
// is really two tables: the interactive current state (`name`) and the
// read-only edit history (`name·events`). Editing a cell doesn't overwrite
// anything; it appends.
//
// A program reads one via the DSL's editable(name, schema) — see dsl.ts —
// which appends a create (or schema-reconcile) event on first sight and
// returns the folded rows. That's the "specify types in the code editor"
// path; the table panel's own +table / +column UI is the other way to
// create/shape one. Column type "code" marks cells edited in the main code
// editor (click the cell) rather than inline.
// ----------------------------------------------------------------------------

import { createEventLog, type StampedEvent } from './event-log.js'
import type { Row } from './lineage.js'

export type ColumnType = 'number' | 'string' | 'boolean' | 'code'

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

const STORAGE_KEY = 'livecodata.tableEvents'

interface MinimalStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
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

export interface EditableTableStore {
  listNames(): string[]
  has(name: string): boolean
  get(name: string): EditableTableData | undefined
  createTable(name: string): void
  removeTable(name: string): void
  renameTable(name: string, newName: string): boolean
  // Called by the DSL's editable(name, schema): appends a create event on first
  // use (optionally seeding rows), a schema-reconcile event when the declared
  // columns differ, and returns the folded (current) rows.
  ensure(name: string, schema: Record<string, ColumnType>, seedRows?: Row[]): Row[]
  addColumn(name: string, colName: string, type: ColumnType): void
  removeColumn(name: string, colName: string): void
  setColumnType(name: string, colName: string, type: ColumnType): void
  renameColumn(name: string, colName: string, newName: string): boolean
  addRow(name: string): void
  removeRow(name: string, index: number): void
  setCell(name: string, index: number, colName: string, value: unknown): void
  // Fired after any change event lands (a fold consumer should re-read).
  onChange(cb: () => void): void
}

export function createEditableTableStore(
  storage: MinimalStorage | null = typeof localStorage !== 'undefined' ? localStorage : null,
): EditableTableStore {
  const log = createEventLog()
  // The fold, kept incrementally: append() applies the new event to this map.
  let tables = new Map<string, TableState>()
  const listeners: (() => void)[] = []

  function refold(): void {
    tables = new Map()
    for (const e of log.all()) applyEvent(tables, e)
  }

  try {
    const raw = storage?.getItem(STORAGE_KEY)
    if (raw && log.load(raw)) refold()
  } catch { /* corrupt / no storage — start empty */ }

  function append(payload: Record<string, unknown> & { kind: string; table: string }): void {
    const e = log.append(payload)
    applyEvent(tables, e)
    try { storage?.setItem(STORAGE_KEY, log.serialize()) } catch { /* quota / no storage */ }
    listeners.forEach((cb) => cb())
  }

  const schemaColumns = (schema: Record<string, ColumnType>): EditableColumn[] =>
    Object.entries(schema).map(([n, t]) => ({ name: n, type: t }))

  return {
    listNames: () => [...tables.keys()],
    has: (name) => tables.has(name),

    get(name: string): EditableTableData | undefined {
      const t = tables.get(name)
      return t ? { columns: t.columns, rows: t.rows, events: t.events } : undefined
    },

    createTable(name: string): void {
      if (tables.has(name)) return
      append({ kind: 'create', table: name, columns: [{ name: 'value', type: 'number' }] })
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
      const existing = tables.get(name)
      if (!existing) {
        append({ kind: 'create', table: name, columns: wantCols, rows: seedRows })
      } else if (JSON.stringify(existing.columns) !== JSON.stringify(wantCols)) {
        append({ kind: 'schema', table: name, columns: wantCols })
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

    onChange(cb: () => void): void {
      listeners.push(cb)
    },
  }
}
