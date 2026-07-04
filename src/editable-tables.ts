// livecodata editable tables
// ----------------------------------------------------------------------------
// User-authored tables, as opposed to the code-generated views produced by
// running the DSL program. An editable table has an explicit column schema
// (name + type) and rows the user edits directly in the table panel. Unlike
// views, its rows are *not* recomputed on every Run — they live here, in a
// store that survives across runs (and reloads, via localStorage), so editing
// a cell doesn't get clobbered the next time the program is cooked.
//
// A program can still read one via the DSL's editable(name, schema) — see
// dsl.ts — which reconciles the stored columns against the declared schema
// (add/drop columns, keep matching data) and returns the live rows. That's
// the "specify types in the code editor" path; the table panel's own +table /
// +column UI is the other way to create/shape one.
// ----------------------------------------------------------------------------

import type { Row } from './lineage.js'

export type ColumnType = 'number' | 'string' | 'boolean'

export interface EditableColumn {
  name: string
  type: ColumnType
}

export interface EditableTableData {
  columns: EditableColumn[]
  rows: Row[]
}

const STORAGE_KEY = 'livecodata.editableTables'

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

export interface EditableTableStore {
  listNames(): string[]
  has(name: string): boolean
  get(name: string): EditableTableData | undefined
  createTable(name: string): void
  removeTable(name: string): void
  renameTable(name: string, newName: string): boolean
  // Called by the DSL's editable(name, schema): creates the table on first use,
  // otherwise reconciles its columns against `schema` (added/removed/retyped),
  // and returns the (now-matching) live rows.
  ensure(name: string, schema: Record<string, ColumnType>): Row[]
  addColumn(name: string, colName: string, type: ColumnType): void
  removeColumn(name: string, colName: string): void
  setColumnType(name: string, colName: string, type: ColumnType): void
  renameColumn(name: string, colName: string, newName: string): boolean
  addRow(name: string): void
  removeRow(name: string, index: number): void
  setCell(name: string, index: number, colName: string, value: unknown): void
}

export function createEditableTableStore(
  storage: MinimalStorage | null = typeof localStorage !== 'undefined' ? localStorage : null,
): EditableTableStore {
  let tables = new Map<string, EditableTableData>()

  try {
    const raw = storage?.getItem(STORAGE_KEY)
    if (raw) {
      const data = JSON.parse(raw) as Record<string, EditableTableData>
      tables = new Map(Object.entries(data))
    }
  } catch { /* corrupt / no storage — start empty */ }

  function persist(): void {
    try {
      const obj: Record<string, EditableTableData> = {}
      for (const [k, v] of tables) obj[k] = v
      storage?.setItem(STORAGE_KEY, JSON.stringify(obj))
    } catch { /* quota / no storage */ }
  }

  return {
    listNames: () => [...tables.keys()],
    has: (name) => tables.has(name),
    get: (name) => tables.get(name),

    createTable(name: string): void {
      if (tables.has(name)) return
      tables.set(name, { columns: [{ name: 'value', type: 'number' }], rows: [] })
      persist()
    },

    removeTable(name: string): void {
      if (!tables.delete(name)) return
      persist()
    },

    renameTable(name: string, newName: string): boolean {
      newName = newName.trim()
      if (!newName || !tables.has(name) || tables.has(newName)) return false
      tables.set(newName, tables.get(name)!)
      tables.delete(name)
      persist()
      return true
    },

    ensure(name: string, schema: Record<string, ColumnType>): Row[] {
      const wantCols: EditableColumn[] = Object.entries(schema).map(([n, t]) => ({ name: n, type: t }))
      const existing = tables.get(name)
      if (!existing) {
        const rows: Row[] = []
        tables.set(name, { columns: wantCols, rows })
        persist()
        return rows
      }
      const rows = existing.rows.map((r) => {
        const next: Row = {}
        for (const c of wantCols) next[c.name] = c.name in r ? r[c.name] : defaultFor(c.type)
        return next
      })
      existing.columns = wantCols
      existing.rows = rows
      persist()
      return rows
    },

    addColumn(name: string, colName: string, type: ColumnType): void {
      colName = colName.trim()
      const t = tables.get(name)
      if (!t || !colName || t.columns.some((c) => c.name === colName)) return
      t.columns.push({ name: colName, type })
      const d = defaultFor(type)
      t.rows.forEach((r) => { r[colName] = d })
      persist()
    },

    removeColumn(name: string, colName: string): void {
      const t = tables.get(name)
      if (!t) return
      t.columns = t.columns.filter((c) => c.name !== colName)
      t.rows.forEach((r) => { delete r[colName] })
      persist()
    },

    setColumnType(name: string, colName: string, type: ColumnType): void {
      const col = tables.get(name)?.columns.find((c) => c.name === colName)
      if (!col) return
      col.type = type
      persist()
    },

    renameColumn(name: string, colName: string, newName: string): boolean {
      newName = newName.trim()
      const t = tables.get(name)
      const col = t?.columns.find((c) => c.name === colName)
      if (!t || !col || !newName || newName === colName || t.columns.some((c) => c.name === newName)) return false
      col.name = newName
      t.rows.forEach((r) => {
        r[newName] = r[colName]
        delete r[colName]
      })
      persist()
      return true
    },

    addRow(name: string): void {
      const t = tables.get(name)
      if (!t) return
      const row: Row = {}
      for (const c of t.columns) row[c.name] = defaultFor(c.type)
      t.rows.push(row)
      persist()
    },

    removeRow(name: string, index: number): void {
      const t = tables.get(name)
      if (!t || index < 0 || index >= t.rows.length) return
      t.rows.splice(index, 1)
      persist()
    },

    setCell(name: string, index: number, colName: string, value: unknown): void {
      const row = tables.get(name)?.rows[index]
      if (!row) return
      row[colName] = value
      persist()
    },
  }
}
