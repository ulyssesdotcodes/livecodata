import { test } from 'node:test'
import assert from 'node:assert/strict'
import { currentMouseRows, createMouseInput, type MouseStore } from '../src/mouse.js'
import type { StampedEvent } from '../src/event-log.js'

// In-memory stand-in for the editable-table store the app backs the mouse
// log with (same shape as the slider/midi fakes).
function fakeStore(): MouseStore {
  const events: StampedEvent[] = []
  let seq = 0
  const listeners: (() => void)[] = []
  return {
    record(kind: string, payload: Record<string, unknown> = {}): void {
      events.push({ kind, table: 'mouse', seq: seq++, t: 0, ...payload })
      listeners.forEach((f) => f())
    },
    events: () => events.slice(),
    onChange: (cb: () => void) => { listeners.push(cb) },
  }
}

const RAY = { x: 0.5, y: -0.25, px: 0, py: 0, pz: 5, dx: 0, dy: 0, dz: -1 }

test('clicks accumulate in recording order, carrying beat and camera ray', () => {
  const rows = currentMouseRows([
    { kind: 'click', seq: 0, t: 0, beat: 9, loop: 1, ...RAY },
    { kind: 'click', seq: 1, t: 0, beat: 2.5, loop: 2, x: -1, y: 1, px: 1, py: 2, pz: 3, dx: 0.6, dy: 0, dz: -0.8 },
  ])
  assert.equal(rows.length, 2, 'every click since the last clear survives the fold')
  assert.equal(rows[0].beat, 9, 'recording order, not beat order — row indices are stable ids')
  assert.deepEqual(
    { beat: rows[1].beat, loop: rows[1].loop, dx: rows[1].dx, dz: rows[1].dz, px: rows[1].px },
    { beat: 2.5, loop: 2, dx: 0.6, dz: -0.8, px: 1 },
  )
})

test('a clear resets the accumulated clicks', () => {
  const rows = currentMouseRows([
    { kind: 'click', seq: 0, t: 0, beat: 1, ...RAY },
    { kind: 'clear', seq: 1, t: 0 },
    { kind: 'click', seq: 2, t: 0, beat: 4, ...RAY },
  ])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].beat, 4)
})

test('the input stamps each click with the playhead beat and loop', () => {
  const store = fakeStore()
  let beat = 2.5
  let loop = 1
  const input = createMouseInput({ store, getIndex: () => beat, getLoop: () => loop })
  input.click(RAY)
  beat = 7.25
  loop = 3
  input.click(RAY)

  const rows = input.rows()
  assert.deepEqual(rows.map((r) => [r.beat, r.loop]), [[2.5, 1], [7.25, 3]])
  assert.ok(input.eventRows().every((r) => r.kind === 'click'), 'raw log mirrors the recorded events')

  input.clear()
  assert.equal(input.rows().length, 0, 'fold refreshes on store change')
})
