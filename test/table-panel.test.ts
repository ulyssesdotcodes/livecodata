// Tests for the table-panel model (src/table-panel.ts) — the pure half of the
// combined table+graph panel. The DOM half (ui/table-panel.tsx) renders these
// results verbatim, so this is where the panel's rules are pinned.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatCell, formatEditableCell, allNames, nextTableName, fallbackTab, chartFor,
  displayOrder, activeRowIndex, viewersOf, tabRingStyle, lastEditors,
  EVENTS_SUFFIX, type PeerPresence,
} from '../src/table-panel.js'
import { Table } from '../src/dsl.js'
import type { GraphSpec } from '../src/graph-panel.js'
import { createEditableTableStore } from '../src/editable-tables.js'
import type { Row } from '../src/lineage.js'

const table = (rows: Row[]): Table => new Table(rows)

// --- formatting -------------------------------------------------------------

test('formatCell: numbers, colors, functions, objects, null', () => {
  assert.equal(formatCell('x', null), '')
  assert.equal(formatCell('x', undefined), '')
  assert.equal(formatCell('x', 3), '3')
  assert.equal(formatCell('x', 3.14159), '3.142')
  assert.equal(formatCell('color', 0xff00ff), '0xff00ff')
  assert.equal(formatCell('color', 0x0000ab), '0x0000ab', 'hex colors keep leading zeros')
  assert.equal(formatCell('other', 255), '255', 'hex formatting only applies to the color column')
  assert.equal(formatCell('x', function wave() {}), 'ƒ wave')
  assert.equal(formatCell('x', () => 0), 'ƒ')
  assert.equal(formatCell('x', { a: 1 }), '{"a":1}')
})

test('formatEditableCell renders by declared column type', () => {
  assert.equal(formatEditableCell('boolean', true), 'true')
  assert.equal(formatEditableCell('boolean', 0), 'false')
  assert.equal(formatEditableCell('number', '2.5'), '2.500')
  assert.equal(formatEditableCell('number', 7), '7')
  assert.equal(formatEditableCell('number', 'junk'), '', 'non-numeric input in a number column shows empty')
  assert.equal(formatEditableCell('string', 42), '42')
  assert.equal(formatEditableCell('code', null), '')
})

// --- presence helpers ---------------------------------------------------------

const peer = (client: string, table: string | null, lastEdit: PeerPresence['lastEdit'] = null): PeerPresence =>
  ({ client, user: client, color: `#${client}`, table, lastEdit })

test('viewersOf / tabRingStyle stack one ring per viewing peer', () => {
  const peers = [peer('a', 't1'), peer('b', 't1'), peer('c', 't2')]
  assert.deepEqual(viewersOf(peers, 't1').map((p) => p.client), ['a', 'b'])
  assert.equal(tabRingStyle(peers, 't1'), '0 0 0 2px #a, 0 0 0 4px #b')
  assert.equal(tabRingStyle(peers, 'none'), '')
})

test('lastEditors matches only the exact table/row/col of a peer last edit', () => {
  const peers = [
    peer('a', 't1', { table: 't1', row: 2, col: 'x' }),
    peer('b', 't2', { table: 't1', row: 2, col: 'x' }),
    peer('c', 't1', { table: 't1', row: 2, col: 'y' }),
  ]
  assert.deepEqual(lastEditors(peers, 't1', 2, 'x').map((p) => p.client), ['a', 'b'])
  assert.deepEqual(lastEditors(peers, 't1', 1, 'x'), [])
})

// --- tab strip ---------------------------------------------------------------

test('allNames folds an editable table\'s ·events history into its own tab, not a separate one', () => {
  const store = createEditableTableStore()
  store.createTable('notes')
  const views = new Map<string, Table>([
    ['events', table([])],
    [`notes${EVENTS_SUFFIX}`, table([])],
    ['scene', table([])],
  ])
  assert.deepEqual(allNames(views, store), ['events', 'notes', 'scene'])
})

test('allNames appends editable tables that have no cooked view', () => {
  const store = createEditableTableStore()
  store.createTable('extra')
  const views = new Map<string, Table>([['events', table([])]])
  assert.deepEqual(allNames(views, store), ['events', 'extra'])
})

test('nextTableName skips names taken by views or editable tables', () => {
  const store = createEditableTableStore()
  store.createTable('table1')
  const views = new Map<string, Table>([['table2', table([])]])
  assert.equal(nextTableName(views, store), 'table3')
})

test('fallbackTab keeps the current tab, else prefers events, else the last tab', () => {
  assert.equal(fallbackTab([], 'x'), null)
  assert.equal(fallbackTab(['a', 'b'], 'a'), 'a')
  assert.equal(fallbackTab(['a', 'events', 'b'], 'gone'), 'events')
  assert.equal(fallbackTab(['a', 'b'], 'gone'), 'b')
})

// --- auto-chart resolution -----------------------------------------------------

const NUMERIC_ROWS: Row[] = [
  { beat: 1, x: 1, label: 'a' },
  { beat: 2, x: 4, label: 'b' },
  { beat: 3, x: 2, label: 'c' },
]

test('chartFor auto-charts a data view: numeric columns, beat as x axis', () => {
  const store = createEditableTableStore()
  const views = new Map<string, Table>([['sim', table(NUMERIC_ROWS)]])
  const chart = chartFor('sim', views, new Map(), store)
  assert.ok(chart)
  assert.deepEqual(chart.cols, ['x'], 'beat is the x axis, label is not numeric')
  assert.equal(chart.hasIndex, true)
  assert.equal(chart.xMin, 1)
  assert.equal(chart.xMax, 3)
  assert.equal(chart.xOf(NUMERIC_ROWS[1], 1), 2, 'x is the row beat, not the ordinal')
})

test('chartFor falls back to row ordinals when there is no beat column', () => {
  const store = createEditableTableStore()
  const views = new Map<string, Table>([['sim', table([{ x: 5 }, { x: 6 }])]])
  const chart = chartFor('sim', views, new Map(), store)
  assert.ok(chart)
  assert.equal(chart.hasIndex, false)
  assert.deepEqual([chart.xMin, chart.xMax], [0, 1])
})

test('chartFor never auto-charts event histories, code, or log tables', () => {
  const store = createEditableTableStore()
  store.record('activity', 'peer-join')
  const views = new Map<string, Table>([
    [`notes${EVENTS_SUFFIX}`, table(NUMERIC_ROWS)],
    ['code', table(NUMERIC_ROWS)],
    ['activity', table(NUMERIC_ROWS)],
    ['strings', table([{ label: 'a' }])],
  ])
  assert.equal(chartFor(`notes${EVENTS_SUFFIX}`, views, new Map(), store), null)
  assert.equal(chartFor('code', views, new Map(), store), null)
  assert.equal(chartFor('activity', views, new Map(), store), null)
  assert.equal(chartFor('strings', views, new Map(), store), null, 'nothing numeric to plot')
  assert.equal(chartFor(null, views, new Map(), store), null)
})

test('an explicit .graph() spec wins over auto-charting and picks its columns', () => {
  const store = createEditableTableStore()
  const rows: Row[] = [{ beat: 1, x: 1, y: 10 }, { beat: 2, x: 2, y: 20 }]
  const t = table(rows)
  const views = new Map<string, Table>([['sim', t]])
  const graphByName = new Map<string, GraphSpec>([['sim', { table: t, columns: ['y'] }]])
  const chart = chartFor('sim', views, graphByName, store)
  assert.ok(chart)
  assert.deepEqual(chart.cols, ['y'])
})

// --- rows under the playhead ---------------------------------------------------

test('displayOrder sorts by beat (stable) but returns storage indices', () => {
  const rows: Row[] = [{ beat: 3 }, { beat: 1 }, { beat: 3 }, { beat: 2 }]
  const cols = [{ name: 'beat', type: 'number' as const }]
  assert.deepEqual(displayOrder(rows, cols), [1, 3, 0, 2], 'ties keep their storage order')
  assert.deepEqual(displayOrder(rows, [{ name: 'x', type: 'number' as const }]), [0, 1, 2, 3], 'no beat column: storage order')
})

test('activeRowIndex is the last row at or before the playhead beat', () => {
  const rows: Row[] = [{ beat: 1 }, { beat: 2 }, { beat: 4 }]
  assert.equal(activeRowIndex(rows, 'beat', 0.5), -1, 'playhead before every row')
  assert.equal(activeRowIndex(rows, 'beat', 2), 1)
  assert.equal(activeRowIndex(rows, 'beat', 3.9), 1)
  assert.equal(activeRowIndex(rows, 'beat', 100), 2)
})
