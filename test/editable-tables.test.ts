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
  assert.deepEqual(store.get('t1'), { columns: [{ name: 'value', type: 'number' }], rows: [] })
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

test('renameTable moves data and rejects collisions', () => {
  const store = createEditableTableStore(memStorage())
  store.createTable('t1')
  store.createTable('t2')
  assert.ok(store.renameTable('t1', 'scores'))
  assert.ok(!store.has('t1'))
  assert.ok(store.has('scores'))
  assert.ok(!store.renameTable('scores', 't2'), 'refuses to clobber an existing table')
})

test('ensure creates on first use and reconciles columns on later calls, preserving matching data', () => {
  const store = createEditableTableStore(memStorage())
  const rows = store.ensure('scores', { name: 'string', score: 'number' })
  assert.deepEqual(rows, [])
  store.addRow('scores')
  store.setCell('scores', 0, 'name', 'ada')
  store.setCell('scores', 0, 'score', 100)

  // Re-declaring with an extra column keeps existing data and defaults the new field.
  const rows2 = store.ensure('scores', { name: 'string', score: 'number', bonus: 'boolean' })
  assert.deepEqual(rows2, [{ name: 'ada', score: 100, bonus: false }])

  // Dropping a column from the schema drops it from the rows too.
  const rows3 = store.ensure('scores', { name: 'string' })
  assert.deepEqual(rows3, [{ name: 'ada' }])
})

test('persists across store instances sharing storage', () => {
  const storage = memStorage()
  const a = createEditableTableStore(storage)
  a.createTable('t1')
  a.setCell('t1', 0, 'value', 1) // no row yet — no-op
  a.addRow('t1')
  a.setCell('t1', 0, 'value', 9)

  const b = createEditableTableStore(storage)
  assert.deepEqual(b.get('t1')!.rows, [{ value: 9 }])
})
