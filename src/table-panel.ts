// Table-panel model — the non-view half of the combined table + graph panel.
// Everything here is pure (formatting, tab-name assembly, display ordering,
// auto-chart resolution, playhead row lookup); the DOM half is a humble
// SolidJS view in ui/table-panel.tsx that renders these results and forwards
// clicks to the EditableTableStore.
//
// Two kinds of tables share the tab strip: code-generated *views* (from the
// current run's cook, read-only) and user *editable tables* (from the
// event-sourced EditableTableStore — created with the "+ table" button, or
// declared in the DSL via editable(name, schema)). Editable tables render with
// inline controls (add/rename/retype column, add/remove row, click-to-edit
// cells). Every edit appends a change event to
// the store's log; the interactive tab shows the fold (current state) while a
// read-only `name·events` tab (injected by main as a plain view) shows the
// history. Cells of type "code" don't edit inline — clicking one hands the
// text to the main code editor via onEditCell.
//
// A third kind, log tables (EditableTableStore.isLog — e.g. "activity"'s
// Apply/peer-join/peer-leave stream), are in the store but never row-editable:
// they have no fold state worth showing, so main injects their own events
// directly under their bare name (no separate "·events" tab) and they render
// through the plain read-only path.

import { chartDataFor, numericColumns, resolveSpec, type GraphSpec, type ChartData } from './graph-panel.js'
import type { Table } from './dsl.js'
import type { Row } from './lineage.js'
import type { EditableTableStore, ColumnType, EditableColumn } from './editable-tables.js'

export const MAX_ROWS = 1000
export const COLUMN_TYPES: ColumnType[] = ['number', 'string', 'boolean', 'code']

// Suffix of the injected read-only edit-history views (`foo·events`). Kept out
// of auto-charting: their numeric seq/t columns aren't data to plot.
export const EVENTS_SUFFIX = '·events'

export interface TablePanelOptions {
  // Clicking a code-typed cell routes here (the main editor takes over) instead
  // of opening an inline input.
  onEditCell?: (table: string, rowIndex: number, col: string, value: string) => void
  onCtrlEnter?: () => void
  // Multiplayer presence: fired when the shown tab changes (including the
  // initial render), so this replica can announce which table it has open.
  onSelectTable?: (name: string | null) => void
}

// A collaborator's presence, as this panel draws it: their color rings the
// tab they have open, and outlines the last cell they edited when that cell
// is on the currently shown table. Row is the storage index the store's
// set-cell events use.
export interface PeerPresence {
  client: string
  user: string
  color: string
  table: string | null
  lastEdit: { table: string; row: number; col: string } | null
}

export interface TablePanel {
  selectTable(name: string | null): void
  setTables(newStore: Map<string, Table>): void
  setGraphs(newSpecs: GraphSpec[] | null): void
  // idx: the playhead's source position as a *beat* — the same unit rows'
  // `beat` column uses, and what the chart's x-axis is drawn in.
  highlightIndex(idx: number): void
  highlightLineage(active: Map<string, Set<number>> | null): void
  resetAutoscroll(): void
  // Multiplayer presence indicators: a color ring on the tab(s) each peer has
  // open, and an outline on the last cell a peer edited (when its table is
  // the one currently shown).
  setPresence(peers: PeerPresence[]): void
}

// The peers currently viewing `table` (its tab open in their table panel).
export function viewersOf(peers: PeerPresence[], table: string): PeerPresence[] {
  return peers.filter((p) => p.table === table)
}

// The color ring style for a table tab, given the peers currently viewing it
// (stacked outward, one ring per peer, in case several share a tab).
export function tabRingStyle(peers: PeerPresence[], table: string): string {
  return viewersOf(peers, table).map((p, i) => `0 0 0 ${(i + 1) * 2}px ${p.color}`).join(', ')
}

// Every peer whose last edit landed on `row`/`col` of `table` — for outlining
// that cell (and naming who) when `table` is the one currently shown. Usually
// zero or one, but two peers can share a last-edited cell (e.g. both last
// touched the same row before either moved on), so this returns all of them.
export function lastEditors(peers: PeerPresence[], table: string, row: number, col: string): PeerPresence[] {
  return peers.filter((p) => p.lastEdit && p.lastEdit.table === table && p.lastEdit.row === row && p.lastEdit.col === col)
}

export function formatCell(col: string, value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'function') return value.name ? `ƒ ${value.name}` : 'ƒ'
  if (col === 'color' && typeof value === 'number') {
    return '0x' + value.toString(16).padStart(6, '0')
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : value.toFixed(3)
  }
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

export function formatEditableCell(type: ColumnType, value: unknown): string {
  if (value == null) return ''
  if (type === 'boolean') return value ? 'true' : 'false'
  if (type === 'number') {
    const n = Number(value)
    if (!Number.isFinite(n)) return ''
    return Number.isInteger(n) ? String(n) : n.toFixed(3)
  }
  return String(value)
}

// The tab strip's names: every cooked view plus every editable table, with an
// editable table's interactive tab kept right before its `name·events` history
// tab.
export function allNames(views: Map<string, Table>, editableStore: EditableTableStore): string[] {
  const names: string[] = []
  for (const n of views.keys()) {
    if (n.endsWith(EVENTS_SUFFIX)) {
      const base = n.slice(0, -EVENTS_SUFFIX.length)
      if (editableStore.has(base) && !names.includes(base)) names.push(base)
    }
    if (!names.includes(n)) names.push(n)
  }
  for (const n of editableStore.listNames()) if (!names.includes(n)) names.push(n)
  return names
}

export function nextTableName(views: Map<string, Table>, editableStore: EditableTableStore): string {
  let i = 1
  while (views.has(`table${i}`) || editableStore.has(`table${i}`)) i++
  return `table${i}`
}

// Which tab should be shown given the available names: keep the current one if
// it still exists, else prefer "events", else the last tab.
export function fallbackTab(names: string[], current: string | null): string | null {
  if (!names.length) return null
  if (current != null && names.includes(current)) return current
  return names.includes('events') ? 'events' : names[names.length - 1]
}

// The chart to draw for `name`, if any: an explicit .graph() spec wins;
// otherwise data views auto-chart their numeric columns. Event-history tables
// (`foo·events`, `code`, and log tables like "activity") never auto-chart —
// their numeric seq/t columns aren't data to plot.
export function chartFor(
  name: string | null,
  views: Map<string, Table>,
  graphByName: Map<string, GraphSpec>,
  editableStore: EditableTableStore,
): ChartData | null {
  if (!name) return null
  let spec = graphByName.get(name)
  if (!spec && !name.endsWith(EVENTS_SUFFIX) && name !== 'code' && !editableStore.isLog(name)) {
    const t = views.get(name)
    if (t && t.rows.length) {
      const numericCols = numericColumns(t.rows, t.columns)
      if (numericCols.length) spec = { table: t, columns: numericCols, viewName: name }
    }
  }
  if (!spec) return null
  const { rows, cols } = resolveSpec(spec)
  return chartDataFor(rows, spec.table.columns, cols, name)
}

// Display order only: rows are shown sorted by `beat` (ascending, stable —
// rows sharing a beat keep their relative order) when the table has one,
// same convention as every other beat-keyed table here. The returned values
// are always the rows' real storage indices — the ones editableStore's row
// methods are keyed by — never display positions, so editing/duplicating/
// deleting a row is unaffected by sorting.
export function displayOrder(rows: Row[], columns: EditableColumn[]): number[] {
  const order = rows.map((_row, i) => i)
  if (columns.some((c) => c.name === 'beat')) {
    order.sort((a, b) => (Number(rows[a].beat) || 0) - (Number(rows[b].beat) || 0))
  }
  return order
}

// The last row whose `indexCol` value is at or before the playhead beat `idx`
// (-1 when the playhead sits before every row).
export function activeRowIndex(rows: Row[], indexCol: string, idx: number): number {
  let activeIdx = -1
  for (let i = 0; i < rows.length; i++) {
    if ((rows[i][indexCol] as number) <= idx) activeIdx = i
    else break
  }
  return activeIdx
}
