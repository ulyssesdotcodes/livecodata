import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEditableTableStore } from '../src/editable-tables.js'

test('createTable seeds a default beat column', () => {
  const store = createEditableTableStore()
  store.createTable('t1')
  assert.ok(store.has('t1'))
  const t = store.get('t1')!
  assert.deepEqual(t.columns, [{ name: 'beat', type: 'number' }])
  assert.deepEqual(t.rows, [])
})

test('addRow / setCell / removeRow', () => {
  const store = createEditableTableStore()
  store.createTable('t1')
  store.addRow('t1')
  store.addRow('t1')
  assert.deepEqual(store.get('t1')!.rows, [{ beat: 0 }, { beat: 0 }])
  store.setCell('t1', 0, 'beat', 42)
  assert.equal(store.get('t1')!.rows[0].beat, 42)
  store.removeRow('t1', 0)
  assert.deepEqual(store.get('t1')!.rows, [{ beat: 0 }])
})

test('every edit is stored as an event; the visible table is the fold', () => {
  const store = createEditableTableStore()
  store.createTable('t1')
  store.addRow('t1')
  store.setCell('t1', 0, 'beat', 3)
  store.setCell('t1', 0, 'beat', 7)

  // The current state reflects only the latest value…
  assert.deepEqual(store.get('t1')!.rows, [{ beat: 7 }])

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
  assert.deepEqual(store.get('t1')!.rows, [{ beat: 0, label: '' }])
  store.removeColumn('t1', 'beat')
  assert.deepEqual(store.get('t1')!.rows, [{ label: '' }])
})

test('renameColumn moves the value under the new key', () => {
  const store = createEditableTableStore()
  store.createTable('t1')
  store.addRow('t1')
  store.setCell('t1', 0, 'beat', 7)
  assert.ok(store.renameColumn('t1', 'beat', 'score'))
  assert.deepEqual(store.get('t1')!.rows, [{ score: 7 }])
  assert.deepEqual(store.get('t1')!.columns, [{ name: 'score', type: 'number' }])
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

test('ensure creates on first use (with seed rows) and reconciles columns on later calls', () => {
  const store = createEditableTableStore()
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
  assert.deepEqual(b.get('t1')!.rows, [{ beat: 9 }])
  assert.deepEqual(b.get('t1')!.events.map((e) => e.kind), ['create', 'add-row', 'set-cell'])
  assert.ok(b.has('t2'), 'every table in the store round-trips, not just one')
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
  assert.deepEqual(store.get('nums')!.rows, [{ beat: 99 }, { beat: 0 }])

  // Scrub back to run 1 — reads serve the historical fold.
  store.setReplayView(run1)
  assert.equal(store.get('code')!.rows[0].code, 'v1')
  assert.deepEqual(store.get('nums')!.rows, [{ beat: 10 }])

  // Returning to head restores the latest state.
  store.setReplayView(null)
  assert.equal(store.get('code')!.rows[0].code, 'v2')
  assert.deepEqual(store.get('nums')!.rows, [{ beat: 99 }, { beat: 0 }])
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
