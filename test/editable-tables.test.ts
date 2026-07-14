import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createEditableTableStore, schemaColumns, cellValid, invalidColumns,
  type EditableColumn,
} from '../src/editable-tables.js'

test('createTable seeds default beat and loop columns', () => {
  const store = createEditableTableStore()
  store.createTable('t1')
  assert.ok(store.has('t1'))
  const t = store.get('t1')!
  assert.deepEqual(t.columns, [{ name: 'beat', type: 'number' }, { name: 'loop', type: 'number' }])
  assert.deepEqual(t.rows, [])
})

test('addRow / setCell / removeRow', () => {
  const store = createEditableTableStore()
  store.createTable('t1')
  store.addRow('t1')
  store.addRow('t1')
  assert.deepEqual(store.get('t1')!.rows, [{ beat: 0, loop: 0 }, { beat: 0, loop: 0 }])
  store.setCell('t1', 0, 'beat', 42)
  assert.equal(store.get('t1')!.rows[0].beat, 42)
  store.removeRow('t1', 0)
  assert.deepEqual(store.get('t1')!.rows, [{ beat: 0, loop: 0 }])
})

test('duplicateRow inserts a copy of the row right after it, with its own identity going forward', () => {
  const store = createEditableTableStore()
  store.createTable('t1')
  store.addRow('t1')
  store.setCell('t1', 0, 'beat', 3)
  store.addRow('t1')
  store.setCell('t1', 1, 'beat', 9)

  store.duplicateRow('t1', 0)
  assert.deepEqual(store.get('t1')!.rows, [{ beat: 3, loop: 0 }, { beat: 3, loop: 0 }, { beat: 9, loop: 0 }])

  // The duplicate is independent — editing it doesn't touch the original.
  store.setCell('t1', 1, 'beat', 5)
  assert.deepEqual(store.get('t1')!.rows, [{ beat: 3, loop: 0 }, { beat: 5, loop: 0 }, { beat: 9, loop: 0 }])

  assert.equal(store.get('t1')!.rows.length, 3, 'duplicating an out-of-range row is a no-op')
  store.duplicateRow('t1', 99)
  assert.equal(store.get('t1')!.rows.length, 3)
})

test('every edit is stored as an event; the visible table is the fold', () => {
  const store = createEditableTableStore()
  store.createTable('t1')
  store.addRow('t1')
  store.setCell('t1', 0, 'beat', 3)
  store.setCell('t1', 0, 'beat', 7)

  // The current state reflects only the latest value…
  assert.deepEqual(store.get('t1')!.rows, [{ beat: 7, loop: 0 }])

  // …but the history keeps both writes, in order, with stamps.
  const events = store.get('t1')!.events
  assert.deepEqual(events.map((e) => e.kind), ['create', 'add-row', 'set-cell', 'set-cell'])
  assert.deepEqual(events.slice(2).map((e) => e.value), [3, 7])
  assert.ok(events.every((e, i) => typeof e.seq === 'number' && typeof e.t === 'number' && (i === 0 || (e.seq as number) > (events[i - 1].seq as number))))
})

test('addColumn backfills existing rows with a default; removeColumn drops it', () => {
  const store = createEditableTableStore()
  store.createTable('t1')
  store.addRow('t1')
  store.addColumn('t1', 'label', 'string')
  assert.deepEqual(store.get('t1')!.rows, [{ beat: 0, loop: 0, label: '' }])
  store.removeColumn('t1', 'beat')
  assert.deepEqual(store.get('t1')!.rows, [{ loop: 0, label: '' }])
})

test('a boolean column named "disabled" hides a row from ensure() without deleting it', () => {
  const store = createEditableTableStore()
  store.ensure('kf', { v: 'number' }, [{ v: 1 }, { v: 2 }, { v: 3 }])
  store.addColumn('kf', 'disabled', 'boolean')
  store.setCell('kf', 1, 'disabled', true)

  // The table panel still sees every row…
  assert.deepEqual(store.get('kf')!.rows.map((r) => r.v), [1, 2, 3])
  // …but the program (ensure()'s return) sees the middle row omitted.
  assert.deepEqual(
    store.ensure('kf', { v: 'number' }, [{ v: 1 }, { v: 2 }, { v: 3 }]).map((r) => r.v),
    [1, 3],
  )

  // Unchecking it brings the row back for the program.
  store.setCell('kf', 1, 'disabled', false)
  assert.deepEqual(
    store.ensure('kf', { v: 'number' }, [{ v: 1 }, { v: 2 }, { v: 3 }]).map((r) => r.v),
    [1, 2, 3],
  )
})

test('adding a "disabled" column defaults every existing row to false (still visible to the program)', () => {
  const store = createEditableTableStore()
  store.ensure('kf', { v: 'number' }, [{ v: 1 }, { v: 2 }])
  store.addColumn('kf', 'disabled', 'boolean')
  assert.deepEqual(store.get('kf')!.rows, [{ v: 1, disabled: false }, { v: 2, disabled: false }])
  assert.deepEqual(store.ensure('kf', { v: 'number' }, [{ v: 1 }, { v: 2 }]).map((r) => r.v), [1, 2])
})

test('toggling "disabled" is an ordinary set-cell edit, with no dedicated event kind', () => {
  const store = createEditableTableStore()
  store.createTable('t1')
  store.addColumn('t1', 'disabled', 'boolean')
  store.addRow('t1')
  store.setCell('t1', 0, 'disabled', true)
  assert.equal(store.get('t1')!.events.at(-1)!.kind, 'set-cell')
})

test('toggling "disabled" dirties the row like any other edit — it stops following later re-seeds', () => {
  const store = createEditableTableStore()
  store.ensure('kf', { v: 'number' }, [{ v: 1 }, { v: 2 }])
  store.addColumn('kf', 'disabled', 'boolean')
  store.setCell('kf', 0, 'disabled', true)

  // Same rule as any other cell edit: touching the row claims it from the
  // program, so a later re-seed leaves its value alone.
  store.ensure('kf', { v: 'number' }, [{ v: 100 }, { v: 200 }])
  assert.deepEqual(store.get('kf')!.rows.map((r) => r.v), [1, 200])
})

test('renameColumn moves the value under the new key', () => {
  const store = createEditableTableStore()
  store.createTable('t1')
  store.addRow('t1')
  store.setCell('t1', 0, 'beat', 7)
  assert.ok(store.renameColumn('t1', 'beat', 'score'))
  assert.deepEqual(store.get('t1')!.rows, [{ score: 7, loop: 0 }])
  assert.deepEqual(store.get('t1')!.columns, [{ name: 'score', type: 'number' }, { name: 'loop', type: 'number' }])
})

test('renameTable moves state (and its event history) and rejects collisions', () => {
  const store = createEditableTableStore()
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

test('ensure creates on first use (with seed rows), and later re-declares grow/shrink freely — a purely-declared column tracks the schema exactly', () => {
  const store = createEditableTableStore()
  const rows = store.ensure('scores', { name: 'string', score: 'number' }, [{ name: 'ada', score: 100 }])
  assert.deepEqual(rows, [{ name: 'ada', score: 100 }])

  // Re-declaring with an extra column keeps existing data and defaults the new field.
  const rows2 = store.ensure('scores', { name: 'string', score: 'number', bonus: 'boolean' })
  assert.deepEqual(rows2, [{ name: 'ada', score: 100, bonus: false }])

  // Dropping columns from the declared schema drops them too — nothing the
  // user did explicitly claimed them, so they're purely the program's to decide.
  const rows3 = store.ensure('scores', { name: 'string' })
  assert.deepEqual(rows3, [{ name: 'ada' }])
})

test('a column added via the table panel survives even after the program stops declaring the table at all', () => {
  const store = createEditableTableStore()
  store.ensure('scores', { name: 'string' }, [{ name: 'ada' }])
  // Simulates "+ column" in the table panel — not declared in the program's code.
  store.addColumn('scores', 'extra', 'number')
  assert.deepEqual(store.get('scores')!.rows, [{ name: 'ada', extra: 0 }])

  // Apply/Run again with the same code-declared schema (extra isn't mentioned):
  // the table-panel column must survive.
  const rows = store.ensure('scores', { name: 'string' })
  assert.deepEqual(rows, [{ name: 'ada', extra: 0 }])
})

test('re-seeding replaces the code rows the user has not touched, and keeps the ones they edited', () => {
  const store = createEditableTableStore()
  store.ensure('kf', { beat: 'number', v: 'number' }, [{ beat: 1, v: 10 }, { beat: 2, v: 20 }, { beat: 3, v: 30 }])
  // The user tweaks the middle row.
  store.setCell('kf', 1, 'v', 999)
  assert.deepEqual(store.get('kf')!.rows, [{ beat: 1, v: 10 }, { beat: 2, v: 999 }, { beat: 3, v: 30 }])

  // The program's seed changes (every row) and re-runs: the two untouched rows
  // follow the new seed, the edited row stays pinned to the user's value.
  store.ensure('kf', { beat: 'number', v: 'number' }, [{ beat: 1, v: 11 }, { beat: 2, v: 22 }, { beat: 3, v: 33 }])
  assert.deepEqual(store.get('kf')!.rows, [{ beat: 1, v: 11 }, { beat: 2, v: 999 }, { beat: 3, v: 33 }])
})

test('re-seeding leaves everything alone when the seed is unchanged (no event, no row churn)', () => {
  const store = createEditableTableStore()
  const seed = [{ beat: 1, v: 10 }, { beat: 2, v: 20 }]
  store.ensure('kf', { beat: 'number', v: 'number' }, seed)
  store.setCell('kf', 0, 'v', 5)
  const before = store.get('kf')!.events.length

  // Same seed literal on the next Run: no seed-rows event, edit preserved.
  store.ensure('kf', { beat: 'number', v: 'number' }, seed)
  assert.equal(store.get('kf')!.events.length, before, 'an unchanged seed appends nothing')
  assert.deepEqual(store.get('kf')!.rows, [{ beat: 1, v: 5 }, { beat: 2, v: 20 }])
})

test('re-seeding keeps user-added rows, and never overwrites/drops them', () => {
  const store = createEditableTableStore()
  store.ensure('kf', { v: 'number' }, [{ v: 1 }, { v: 2 }])
  store.addRow('kf')
  store.setCell('kf', 2, 'v', 7) // the user's own row
  assert.deepEqual(store.get('kf')!.rows.map((r) => r.v), [1, 2, 7])

  // Seed shrinks to one row: the surviving code slot re-seeds, the extra
  // pristine code row drops, the user's added row stays put.
  store.ensure('kf', { v: 'number' }, [{ v: 100 }])
  assert.deepEqual(store.get('kf')!.rows.map((r) => r.v), [100, 7])

  // Seed grows again: new code rows append after the user's row.
  store.ensure('kf', { v: 'number' }, [{ v: 100 }, { v: 200 }, { v: 300 }])
  assert.deepEqual(store.get('kf')!.rows.map((r) => r.v), [100, 7, 200, 300])
})

test('a code row the user deleted is not resurrected by a later re-seed', () => {
  const store = createEditableTableStore()
  store.ensure('kf', { v: 'number' }, [{ v: 1 }, { v: 2 }, { v: 3 }])
  store.removeRow('kf', 1) // delete the pristine middle code row
  assert.deepEqual(store.get('kf')!.rows.map((r) => r.v), [1, 3])

  // Re-run with a fully changed seed: slot 1 stays gone; the others re-seed.
  store.ensure('kf', { v: 'number' }, [{ v: 10 }, { v: 20 }, { v: 30 }])
  assert.deepEqual(store.get('kf')!.rows.map((r) => r.v), [10, 30])
})

test('a table-panel table is never re-seeded by a later editable() seed (the program never owned its rows)', () => {
  const store = createEditableTableStore()
  store.createTable('t') // "+ table": beat/loop columns, user-owned
  store.addRow('t')
  store.setCell('t', 0, 'beat', 5)
  // The program now declares the same name with a seed. Its columns reconcile,
  // but its rows are the user's — the seed must not add or replace anything.
  store.ensure('t', { beat: 'number', loop: 'number' }, [{ beat: 9, loop: 0 }])
  assert.deepEqual(store.get('t')!.rows, [{ beat: 5, loop: 0 }])
})

test('re-seeding survives serialize/load — provenance is rebuilt purely from the event log', () => {
  const a = createEditableTableStore()
  a.ensure('kf', { v: 'number' }, [{ v: 1 }, { v: 2 }])
  a.setCell('kf', 0, 'v', 99)

  const b = createEditableTableStore()
  assert.ok(b.load(a.serialize()))
  // The reloaded store must apply a re-seed with the same edited/pristine split.
  b.ensure('kf', { v: 'number' }, [{ v: 10 }, { v: 20 }])
  assert.deepEqual(b.get('kf')!.rows.map((r) => r.v), [99, 20])
})

test('retainDeclared prunes a code-created table the program stopped declaring, and only that', () => {
  const store = createEditableTableStore()
  store.ensure('code', { code: 'code' }, [{ code: 'x' }]) // the program itself — never pruned
  store.ensure('a', { v: 'number' }, [{ v: 1 }])          // code-created editable table
  store.ensure('b', { v: 'number' }, [{ v: 2 }])          // code-created editable table
  store.createTable('u')                                   // user "+ table"
  store.record('activity', 'apply')                        // a log stream

  // The program's next Run declares only "a": "b" should stop being editable.
  const removed = store.retainDeclared(['a'])
  assert.deepEqual(removed, ['b'])
  assert.ok(store.has('a'), 'still-declared table stays')
  assert.ok(!store.has('b'), 'undeclared code table is dropped — no longer editable')
  assert.ok(store.has('u'), 'a user "+ table" is never pruned')
  assert.ok(store.has('code'), '"code" is never pruned')
  assert.ok(store.has('activity'), 'a log stream is never pruned')
})

test('retainDeclared is a no-op while replaying a past run', () => {
  const store = createEditableTableStore()
  store.ensure('code', { code: 'code' }, [{ code: 'x' }])
  store.ensure('a', { v: 'number' }, [{ v: 1 }])
  const run = store.recordRun()

  store.setReplayView(run)
  assert.deepEqual(store.retainDeclared([]), [], 'nothing removed during a scrubbed preview')
  store.setReplayView(null)
  assert.ok(store.has('a'), 'the head log is untouched by the replay-time call')
})

test('re-declaring retypes a purely-declared column in place; a column the user retyped keeps its type', () => {
  const store = createEditableTableStore()
  store.ensure('t', { a: 'string' })
  store.addColumn('t', 'b', 'number')
  store.ensure('t', { a: 'number' }) // "a" was never touched via the table panel — follows the declare
  assert.deepEqual(store.get('t')!.columns, [{ name: 'a', type: 'number' }, { name: 'b', type: 'number' }])

  store.setColumnType('t', 'b', 'string') // table panel retype "claims" b
  store.ensure('t', { a: 'number', b: 'number' }) // code still thinks b is a number
  assert.deepEqual(store.get('t')!.columns, [{ name: 'a', type: 'number' }, { name: 'b', type: 'string' }], 'the table-panel retype wins')
})

test('removing a column via the table panel keeps it gone even if the program keeps declaring it', () => {
  const store = createEditableTableStore()
  store.ensure('t', { a: 'string', b: 'number' })
  store.removeColumn('t', 'b')
  assert.deepEqual(store.get('t')!.columns.map((c) => c.name), ['a'])

  // Re-declaring the SAME schema (still mentioning "b") does not resurrect it.
  store.ensure('t', { a: 'string', b: 'number' })
  assert.deepEqual(store.get('t')!.columns.map((c) => c.name), ['a'])
})

test('ensure appends no event when the schema already matches (no event spam per run)', () => {
  const store = createEditableTableStore()
  store.ensure('t', { value: 'number' })
  const before = store.get('t')!.events.length
  store.ensure('t', { value: 'number' })
  store.ensure('t', { value: 'number' })
  assert.equal(store.get('t')!.events.length, before)
})

test('serialize/load round-trips the whole store — the unit a session persists', () => {
  const a = createEditableTableStore()
  a.createTable('t1')
  a.setCell('t1', 0, 'beat', 1) // no row yet — invalid, appends nothing
  a.addRow('t1')
  a.setCell('t1', 0, 'beat', 9)
  a.createTable('t2')

  const b = createEditableTableStore()
  assert.ok(b.load(a.serialize()))
  assert.deepEqual(b.get('t1')!.rows, [{ beat: 9, loop: 0 }])
  assert.deepEqual(b.get('t1')!.events.map((e) => e.kind), ['create', 'add-row', 'set-cell'])
  assert.ok(b.has('t2'), 'every table in the store round-trips, not just one')
})

test('loads a legacy session whose create event stored the editable() schema object as columns', () => {
  // Older sessions serialized a create event's `columns` as the raw editable()
  // schema ({ name: type }) rather than today's [{ name, type }] array. The
  // schema is a product of running the program, not table data — so a session
  // that has table data must still load, with its columns recovered.
  const legacy = JSON.stringify({
    version: 1, start: 1,
    events: [{
      kind: 'create', table: 'nums',
      columns: { beat: 'number', px: 'number', disabled: 'boolean' },
      rows: [{ beat: 1, px: 5, disabled: false }, { beat: 2, px: 9, disabled: false }],
      declared: true, seq: 0, t: 0, src: 'a',
    }],
  })
  const store = createEditableTableStore()
  assert.ok(store.load(legacy), 'a session with table data loads despite a legacy schema shape')
  assert.deepEqual(store.get('nums')!.columns, [
    { name: 'beat', type: 'number' }, { name: 'px', type: 'number' }, { name: 'disabled', type: 'boolean' },
  ], 'columns are recovered from the legacy schema object')
  assert.deepEqual(store.get('nums')!.rows, [
    { beat: 1, px: 5, disabled: false }, { beat: 2, px: 9, disabled: false },
  ], 'the table data is intact')
})

test('a single unfoldable event does not sink the rest of a session load', () => {
  // Belt-and-suspenders: even an event the fold cannot make sense of must not
  // abort the load — every other table in the session still comes through.
  const good = createEditableTableStore()
  good.createTable('keep')
  good.addRow('keep')
  good.setCell('keep', 0, 'beat', 7)
  const parsed = JSON.parse(good.serialize())
  // Splice in an event the fold cannot touch at all (null — reading e.table throws).
  parsed.events.push(null)

  const store = createEditableTableStore()
  assert.ok(store.load(JSON.stringify(parsed)))
  assert.deepEqual(store.get('keep')!.rows, [{ beat: 7, loop: 0 }], 'the good table survives the bad event')
})

test('load replaces the store entirely and notifies; clear empties it and notifies', () => {
  const store = createEditableTableStore()
  store.createTable('t1')
  let fired = 0
  store.onChange(() => fired++)

  const other = createEditableTableStore()
  other.createTable('only-in-other')
  assert.ok(store.load(other.serialize()))
  assert.ok(!store.has('t1'), 'previous state is gone, not merged')
  assert.ok(store.has('only-in-other'))
  assert.equal(fired, 1)

  store.clear()
  assert.ok(!store.has('only-in-other'))
  assert.equal(fired, 2)
})

test('load rejects garbage without touching existing state', () => {
  const store = createEditableTableStore()
  store.createTable('t1')
  assert.equal(store.load('not json'), false)
  assert.ok(store.has('t1'), 'existing state is untouched on a failed load')
})

test('onChange fires for appended events, not for rejected mutations', () => {
  const store = createEditableTableStore()
  let fired = 0
  store.onChange(() => fired++)
  store.createTable('t1')       // +1
  store.createTable('t1')       // duplicate — rejected
  store.addRow('t1')            // +1
  store.removeRow('t1', 99)     // out of range — rejected
  store.setCell('t1', 5, 'value', 1) // no such row — rejected
  assert.equal(fired, 2)
})

test('setRow atomically sets several cells as one event', () => {
  const store = createEditableTableStore()
  store.ensure('code', { code: 'code', seed: 'number' }, [{ code: 'a', seed: 1 }])
  store.setRow('code', 0, { code: 'b', seed: 2 })
  assert.deepEqual(store.get('code')!.rows, [{ code: 'b', seed: 2 }])
  const events = store.get('code')!.events
  assert.deepEqual(events.map((e) => e.kind), ['create', 'set-row'])
  assert.deepEqual(events[1].values, { code: 'b', seed: 2 })
})

test('code is a valid column type (defaults to empty string)', () => {
  const store = createEditableTableStore()
  store.ensure('h', { beat: 'number', code: 'code' })
  store.addRow('h')
  assert.deepEqual(store.get('h')!.rows, [{ beat: 0, code: '' }])
  store.setCell('h', 0, 'code', 'src(s0).out()')
  assert.equal(store.get('h')!.rows[0].code, 'src(s0).out()')
})

test('schemaColumns: a string[] spec is enum shorthand; the object form is explicit', () => {
  const cols = schemaColumns({
    beat: 'number',
    event: ['setCode', 'layer'],
    mode: { type: 'enum', options: ['blend', 'add'] },
    plain: { type: 'string' },
  })
  assert.deepEqual(cols, [
    { name: 'beat', type: 'number' },
    { name: 'event', type: 'enum', options: ['setCode', 'layer'] },
    { name: 'mode', type: 'enum', options: ['blend', 'add'] },
    { name: 'plain', type: 'string' },
  ])
})

test('an enum column defaults a new row to its first option, and rides serialize/load', () => {
  const store = createEditableTableStore()
  store.ensure('h', { beat: 'number', event: ['setCode', 'layer'] })
  store.addRow('h')
  assert.deepEqual(store.get('h')!.rows, [{ beat: 0, event: 'setCode' }])
  // options survive the round-trip (they're plain fields on the column events)
  const store2 = createEditableTableStore()
  assert.ok(store2.load(store.serialize()))
  const evCol = store2.get('h')!.columns.find((c) => c.name === 'event')!
  assert.deepEqual(evCol, { name: 'event', type: 'enum', options: ['setCode', 'layer'] })
})

test('cellValid: blanks pass; a non-blank value must fit its type; enum must be in options', () => {
  const num: EditableColumn = { name: 'v', type: 'number' }
  const en: EditableColumn = { name: 'e', type: 'enum', options: ['a', 'b'] }
  // blank/unset is always allowed (these event tables are sparse)
  assert.equal(cellValid('', num), true)
  assert.equal(cellValid(null, en), true)
  // numbers
  assert.equal(cellValid(3, num), true)
  assert.equal(cellValid('3', num), false)
  assert.equal(cellValid(NaN, num), false)
  // enums
  assert.equal(cellValid('a', en), true)
  assert.equal(cellValid('c', en), false)
  // string/code accept any non-blank
  assert.equal(cellValid('anything', { name: 's', type: 'string' }), true)
})

test('invalidColumns names the cells that do not fit — empty when the row conforms', () => {
  const cols = schemaColumns({
    beat: 'number',
    event: ['setCode', 'layer'],
    value: 'number',
  })
  assert.deepEqual(invalidColumns({ beat: 1, event: 'layer', value: 5 }, cols), [])
  // a misspelled enum and text-in-a-number cell are both flagged
  assert.deepEqual(
    invalidColumns({ beat: 1, event: 'laayer', value: 'oops' }, cols),
    ['event', 'value'],
  )
})

test('recordRun snapshots every table\'s log index as one Apply bookmark', () => {
  const store = createEditableTableStore()
  store.ensure('code', { code: 'code' }, [{ code: 'a' }]) // 1 event
  store.createTable('nums')                               // 1 event
  store.addRow('nums')                                    // 1 event
  const run = store.recordRun()

  assert.equal(run.tables.code, 1, 'one code event so far')
  assert.equal(run.tables.nums, 2, 'create + add-row')
  assert.equal(run.at, 3, 'the run is a prefix of the whole shared log')
  assert.deepEqual(store.runs().map((r) => r.at), [3])
})

test('setReplayView restores every table to its state at a past run', () => {
  const store = createEditableTableStore()
  store.ensure('code', { code: 'code' }, [{ code: 'v1' }])
  store.createTable('nums')
  store.addRow('nums')
  store.setCell('nums', 0, 'beat', 10)
  const run1 = store.recordRun()

  // A second batch of edits, then a second run.
  store.setRow('code', 0, { code: 'v2' })
  store.setCell('nums', 0, 'beat', 99)
  store.addRow('nums')
  store.recordRun()

  // Head shows the latest state.
  assert.equal(store.get('code')!.rows[0].code, 'v2')
  assert.deepEqual(store.get('nums')!.rows, [{ beat: 99, loop: 0 }, { beat: 0, loop: 0 }])

  // Scrub back to run 1 — reads serve the historical fold.
  store.setReplayView(run1)
  assert.equal(store.get('code')!.rows[0].code, 'v1')
  assert.deepEqual(store.get('nums')!.rows, [{ beat: 10, loop: 0 }])

  // Returning to head restores the latest state.
  store.setReplayView(null)
  assert.equal(store.get('code')!.rows[0].code, 'v2')
  assert.deepEqual(store.get('nums')!.rows, [{ beat: 99, loop: 0 }, { beat: 0, loop: 0 }])
})

test('ensure is read-only while replaying — a scrubbed cook appends nothing', () => {
  const store = createEditableTableStore()
  store.ensure('code', { code: 'code' }, [{ code: 'a' }])
  const run = store.recordRun()
  const lenBefore = store.get('code')!.events.length

  store.setReplayView(run)
  // A table the historical program references but that didn't exist then:
  // returns the seed without mutating the log.
  assert.deepEqual(store.ensure('ghost', { v: 'number' }, [{ v: 5 }]), [{ v: 5 }])
  store.setReplayView(null)
  assert.ok(!store.has('ghost'), 'no create event leaked from the replay cook')
  assert.equal(store.get('code')!.events.length, lenBefore, 'code untouched')
})

test('an edit while replaying returns to head, never rewriting history', () => {
  const store = createEditableTableStore()
  store.createTable('nums')
  store.addRow('nums')
  store.setCell('nums', 0, 'beat', 1)
  const run1 = store.recordRun()
  store.setCell('nums', 0, 'beat', 2)
  store.recordRun()

  store.setReplayView(run1)
  assert.equal(store.get('nums')!.rows[0].beat, 1, 'viewing the past')
  // Editing lands on the head (beat 2 → 3), not on the replayed past.
  store.setCell('nums', 0, 'beat', 3)
  assert.equal(store.get('nums')!.rows[0].beat, 3)
  assert.equal(store.runs().length, 2, 'no new run recorded by a plain edit')
})

test('deriveRunsFromCode reconstructs one run per recorded program Run (legacy sessions)', () => {
  const store = createEditableTableStore()
  store.ensure('code', { code: 'code' }, [{ code: 'r1' }]) // code Run 1 (create)
  store.createTable('nums')
  store.setRow('code', 0, { code: 'r2' })                  // code Run 2 (set-row)

  store.deriveRunsFromCode()
  const runs = store.runs()
  assert.equal(runs.length, 2, 'one run per code event')

  // Replaying the derived first run shows the program as it was at Run 1,
  // before "nums" existed.
  store.setReplayView(runs[0])
  assert.equal(store.get('code')!.rows[0].code, 'r1')
  assert.ok(!store.has('nums'), 'nums was created after Run 1')
  store.setReplayView(null)
  assert.equal(store.get('code')!.rows[0].code, 'r2')
})

test('load and clear reset the run list', () => {
  const store = createEditableTableStore()
  store.createTable('t')
  store.recordRun()
  assert.equal(store.runs().length, 1)

  const other = createEditableTableStore()
  other.createTable('x')
  assert.ok(store.load(other.serialize()))
  assert.equal(store.runs().length, 0, 'load resets runs')

  store.recordRun()
  store.clear()
  assert.equal(store.runs().length, 0, 'clear resets runs')
})

test('record() auto-creates a columnless table and appends the event to its history', () => {
  const store = createEditableTableStore()
  store.record('activity', 'apply')
  assert.ok(store.has('activity'))
  const t = store.get('activity')!
  assert.deepEqual(t.columns, [])
  assert.deepEqual(t.rows, [], 'not a row-editable table — just an event stream')
  // events[0] is the auto-create itself (same as any other table's history).
  assert.equal(t.events.length, 2)
  assert.equal(t.events[0].kind, 'create')
  assert.equal(t.events[1].kind, 'apply')

  // A payload rides alongside kind/table, same as any other event.
  store.record('activity', 'peer-join', { client: 'abc' })
  assert.equal(store.get('activity')!.events.length, 3)
  assert.equal(store.get('activity')!.events[2].client, 'abc')

  // Doesn't re-create (and so doesn't reset) an existing table.
  store.record('activity', 'apply')
  assert.equal(store.get('activity')!.events.length, 4)
})

test('record() rides the same log multiplayer syncs — merges in on another replica', () => {
  const a = createEditableTableStore({ src: 'a' })
  const b = createEditableTableStore({ src: 'b' })
  a.record('activity', 'apply')
  b.log.merge(a.log.all())
  assert.equal(b.get('activity')?.events.length, 2)
  assert.equal(b.get('activity')?.events[1].kind, 'apply')
})
