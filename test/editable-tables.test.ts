import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEditableTableStore } from '../src/editable-tables.js'

function memStorage(): { getItem(k: string): string | null; setItem(k: string, v: string): void } {
  const map = new Map<string, string>()
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, v) },
  }
}

test('createTable seeds a default numeric column', () => {
  const store = createEditableTableStore(memStorage())
  store.createTable('t1')
  assert.ok(store.has('t1'))
  const t = store.get('t1')!
  assert.deepEqual(t.columns, [{ name: 'value', type: 'number' }])
  assert.deepEqual(t.rows, [])
})

test('addRow / setCell / removeRow', () => {
  const store = createEditableTableStore(memStorage())
  store.createTable('t1')
  store.addRow('t1')
  store.addRow('t1')
  assert.deepEqual(store.get('t1')!.rows, [{ value: 0 }, { value: 0 }])
  store.setCell('t1', 0, 'value', 42)
  assert.equal(store.get('t1')!.rows[0].value, 42)
  store.removeRow('t1', 0)
  assert.deepEqual(store.get('t1')!.rows, [{ value: 0 }])
})

test('every edit is stored as an event; the visible table is the fold', () => {
  const store = createEditableTableStore(memStorage())
  store.createTable('t1')
  store.addRow('t1')
  store.setCell('t1', 0, 'value', 3)
  store.setCell('t1', 0, 'value', 7)

  // The current state reflects only the latest value…
  assert.deepEqual(store.get('t1')!.rows, [{ value: 7 }])

  // …but the history keeps both writes, in order, with stamps.
  const events = store.get('t1')!.events
  assert.deepEqual(events.map((e) => e.kind), ['create', 'add-row', 'set-cell', 'set-cell'])
  assert.deepEqual(events.slice(2).map((e) => e.value), [3, 7])
  assert.ok(events.every((e, i) => typeof e.seq === 'number' && typeof e.t === 'number' && (i === 0 || (e.seq as number) > (events[i - 1].seq as number))))
})

test('addColumn backfills existing rows with a default; removeColumn drops it', () => {
  const store = createEditableTableStore(memStorage())
  store.createTable('t1')
  store.addRow('t1')
  store.addColumn('t1', 'label', 'string')
  assert.deepEqual(store.get('t1')!.rows, [{ value: 0, label: '' }])
  store.removeColumn('t1', 'value')
  assert.deepEqual(store.get('t1')!.rows, [{ label: '' }])
})

test('renameColumn moves the value under the new key', () => {
  const store = createEditableTableStore(memStorage())
  store.createTable('t1')
  store.addRow('t1')
  store.setCell('t1', 0, 'value', 7)
  assert.ok(store.renameColumn('t1', 'value', 'score'))
  assert.deepEqual(store.get('t1')!.rows, [{ score: 7 }])
  assert.deepEqual(store.get('t1')!.columns, [{ name: 'score', type: 'number' }])
})

test('renameTable moves state (and its event history) and rejects collisions', () => {
  const store = createEditableTableStore(memStorage())
  store.createTable('t1')
  store.addRow('t1')
  store.createTable('t2')
  assert.ok(store.renameTable('t1', 'scores'))
  assert.ok(!store.has('t1'))
  assert.ok(store.has('scores'))
  // The history rides along through the rename.
  assert.deepEqual(store.get('scores')!.events.map((e) => e.kind), ['create', 'add-row', 'rename-table'])
  assert.ok(!store.renameTable('scores', 't2'), 'refuses to clobber an existing table')
})

test('ensure creates on first use (with seed rows) and reconciles columns on later calls', () => {
  const store = createEditableTableStore(memStorage())
  const rows = store.ensure('scores', { name: 'string', score: 'number' }, [{ name: 'ada', score: 100 }])
  assert.deepEqual(rows, [{ name: 'ada', score: 100 }])

  // Re-declaring with an extra column keeps existing data and defaults the new field.
  const rows2 = store.ensure('scores', { name: 'string', score: 'number', bonus: 'boolean' })
  assert.deepEqual(rows2, [{ name: 'ada', score: 100, bonus: false }])

  // Dropping a column from the schema drops it from the rows too.
  const rows3 = store.ensure('scores', { name: 'string' })
  assert.deepEqual(rows3, [{ name: 'ada' }])
})

test('ensure appends no event when the schema already matches (no event spam per run)', () => {
  const store = createEditableTableStore(memStorage())
  store.ensure('t', { value: 'number' })
  const before = store.get('t')!.events.length
  store.ensure('t', { value: 'number' })
  store.ensure('t', { value: 'number' })
  assert.equal(store.get('t')!.events.length, before)
})

test('persists the event log: a second store instance re-folds the same state', () => {
  const storage = memStorage()
  const a = createEditableTableStore(storage)
  a.createTable('t1')
  a.setCell('t1', 0, 'value', 1) // no row yet — invalid, appends nothing
  a.addRow('t1')
  a.setCell('t1', 0, 'value', 9)

  const b = createEditableTableStore(storage)
  assert.deepEqual(b.get('t1')!.rows, [{ value: 9 }])
  assert.deepEqual(b.get('t1')!.events.map((e) => e.kind), ['create', 'add-row', 'set-cell'])
})

test('onChange fires for appended events, not for rejected mutations', () => {
  const store = createEditableTableStore(memStorage())
  let fired = 0
  store.onChange(() => fired++)
  store.createTable('t1')       // +1
  store.createTable('t1')       // duplicate — rejected
  store.addRow('t1')            // +1
  store.removeRow('t1', 99)     // out of range — rejected
  store.setCell('t1', 5, 'value', 1) // no such row — rejected
  assert.equal(fired, 2)
})

test('code is a valid column type (defaults to empty string)', () => {
  const store = createEditableTableStore(memStorage())
  store.ensure('h', { index: 'number', code: 'code' })
  store.addRow('h')
  assert.deepEqual(store.get('h')!.rows, [{ index: 0, code: '' }])
  store.setCell('h', 0, 'code', 'src(s0).out()')
  assert.equal(store.get('h')!.rows[0].code, 'src(s0).out()')
})
