import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTimeline } from '../src/timeline.js'
import {
  beatToX,
  xToBeat,
  gridLines,
  handlesFor,
  hitTest,
  resolveHandle,
  snap,
  snapDelta,
  dragModeFor,
  dragUpdate,
  valuesDiffer,
  exceedsDragThreshold,
  withPreview,
  pendingTimelineRows,
  laneCountFor,
  coverageBands,
  meaningfulSummary,
  type Handle,
} from '../src/timeline-strip.js'
import type { EditableColumn } from '../src/editable-tables.js'

const cols = (...names: string[]): EditableColumn[] => names.map((name) => ({ name, type: 'number' }))

// --- geometry ----------------------------------------------------------------

test('beatToX/xToBeat round-trip: beat 1 sits at x=0, beat maxBeats+1 at the right edge', () => {
  const geometry = { width: 320, maxBeats: 16 }
  assert.equal(beatToX(geometry, 1), 0)
  assert.equal(beatToX(geometry, 17), 320)
  assert.equal(xToBeat(geometry, 0), 1)
  assert.equal(xToBeat(geometry, 320), 17)
  assert.equal(xToBeat(geometry, beatToX(geometry, 9)), 9)
})

// --- grid ----------------------------------------------------------------

test('gridLines: minor tick per beat, major every 4, labels only major', () => {
  const lines = gridLines(8, 800)
  assert.equal(lines.length, 9, 'beats 1..maxBeats+1')
  assert.deepEqual(lines.map((l) => l.kind), ['major', 'minor', 'minor', 'minor', 'major', 'minor', 'minor', 'minor', 'major'])
  assert.deepEqual(lines.filter((l) => l.label).map((l) => l.beat), [1, 5, 9])
})

test('gridLines: labels drop wholesale once major spacing collides (<24px)', () => {
  const roomy = gridLines(8, 800) // 100px/beat, 400px between majors
  const cramped = gridLines(800, 800) // 1px/beat, 4px between majors
  assert.ok(roomy.some((l) => l.label))
  assert.ok(cramped.every((l) => !l.label))
})

// --- handlesFor ----------------------------------------------------------------

test('handlesFor: timeline rows become until-next span handles; loop picks the lane, disabled rows drop out', () => {
  const rows = [
    { beat: 1, loop: 0 },
    { beat: 5, loop: 0 },
    { beat: 1, loop: 1, disabled: true },
  ]
  const handles = handlesFor('timeline', rows, cols('beat', 'loop'), rows, 8)
  assert.deepEqual(
    handles.map((h) => ({ row: h.row, kind: h.kind, beat: h.beat, end: h.end, lane: h.lane, disabled: h.disabled })),
    [
      { row: 0, kind: 'span', beat: 1, end: 5, lane: 0, disabled: false },
      { row: 1, kind: 'span', beat: 5, end: 9, lane: 0, disabled: false },
    ],
    'row 0 runs to row 1; row 1 runs to the end of its 8-beat pass; the disabled row gets no handle',
  )
})

test('handlesFor: with no timeline defined, a content row is identity — one non-ghost handle at its own beat', () => {
  const rows = [{ beat: 3, dur: 2 }]
  const handles = handlesFor('three', rows, cols('beat', 'dur'), [])
  assert.deepEqual(handles, [
    { row: 0, kind: 'span', beat: 3, end: 5, lane: 0, ghost: false, disabled: false },
  ])
})

test('handlesFor: a content row played by a loop event gets one handle per placement, first primary, rest ghosts', () => {
  const timelineRows = [{ event: 'loop', beat: 1, from: 1, to: 5 }]
  const rows = [{ id: 'a', beat: 1 }]
  // Loop-beats 8 closes the pass at beat 9 — two 4-beat cycles.
  const handles = handlesFor('hits', rows, cols('beat'), timelineRows, 8)
  assert.deepEqual(
    handles.map((h) => ({ beat: h.beat, ghost: h.ghost })),
    [{ beat: 1, ghost: false }, { beat: 5, ghost: true }],
  )
})

// --- handlesFor: phase 5 (lanes + pass wrapping) ----------------------------

test('handlesFor: a content row placed across a multi-pass timeline lands each ghost in its own pass lane', () => {
  // Two "loop" passes, each cycling source 1..5 twice across their own
  // 8-beat span — a content row at source beat 3 (the cycle's midpoint)
  // lands twice per pass, once per cycle.
  const timelineRows = [
    { event: 'loop', beat: 1, from: 1, to: 5, loop: 0 },
    { event: 'loop', beat: 1, from: 1, to: 5, loop: 1 },
  ]
  const rows = [{ beat: 3 }]
  const handles = handlesFor('hits', rows, cols('beat'), timelineRows, 8)
  assert.deepEqual(
    handles.map((h) => ({ beat: h.beat, lane: h.lane, ghost: h.ghost })),
    [
      { beat: 3, lane: 0, ghost: false },
      { beat: 7, lane: 0, ghost: true },
      { beat: 3, lane: 1, ghost: true },
      { beat: 7, lane: 1, ghost: true },
    ],
    'pass 2\'s placements repeat pass 1\'s local shape, just in lane 1',
  )
})

test('handlesFor: a content row whose beat runs past loopBeats wraps into a later pass, tagged but still in lane 0', () => {
  // No timeline defined, so there's no lane to place a later pass into —
  // only a badge (see notes/timeline-strip-plan.md "Beats past maxBeats").
  const rows = [{ beat: 20 }]
  const handles = handlesFor('hits', rows, cols('beat'), [], 8)
  assert.deepEqual(
    handles.map((h) => ({ beat: h.beat, lane: h.lane, pass: h.pass })),
    [{ beat: 4, lane: 0, pass: 2 }],
    '(20 - 1) % 8 + 1 == 4, in the third 8-beat pass',
  )
})

// --- laneCountFor ----------------------------------------------------------

test('laneCountFor: the max of the open handles\' own lanes and the timeline\'s own pass count', () => {
  const twoPassTimeline = [
    { event: 'hold', beat: 1, from: 1, loop: 0 },
    { event: 'hold', beat: 1, from: 1, loop: 1 },
  ]
  assert.equal(laneCountFor([], twoPassTimeline), 2, 'a two-pass timeline needs 2 lanes even with no handles past lane 0')
  const handles: Handle[] = [{ row: 0, kind: 'point', beat: 1, lane: 3, ghost: false, disabled: false }]
  assert.equal(laneCountFor(handles, []), 4, 'a handle already in lane 3 needs 4 lanes even with no timeline')
})

// --- coverageBands -----------------------------------------------------------

test('coverageBands: each pass\'s segments map onto its own local axis, tagged with that pass\'s lane and event kind', () => {
  const timelineRows = [
    { event: 'hold', beat: 1, from: 1, loop: 0 },
    { event: 'hold', beat: 1, from: 1, loop: 1 },
  ]
  assert.deepEqual(
    coverageBands(timelineRows, 8).map((b) => ({ p0: b.p0, p1: b.p1, lane: b.lane, kind: b.kind })),
    [
      { p0: 1, p1: 9, lane: 0, kind: 'hold' },
      { p0: 1, p1: 9, lane: 1, kind: 'hold' },
    ],
  )
})

test('coverageBands: no active timeline yields no bands', () => {
  assert.deepEqual(coverageBands([]), [])
})

// --- pendingTimelineRows ----------------------------------------------------

test('pendingTimelineRows: a row whose live beat or pass drifted from the applied cook is pending; a disabled row is skipped (the applied view excludes it too)', () => {
  const rows = [
    { beat: 1, loop: 0 },
    { beat: 20, disabled: true },
    { beat: 9, loop: 0 },
  ]
  const applied = [
    { beat: 1, loop: 0 },
    { beat: 9, loop: 1 }, // row 2's pass moved after Apply
  ]
  assert.deepEqual(pendingTimelineRows(rows, applied), new Set([2]))
})

test('pendingTimelineRows: an unapplied trailing row past the applied cook length is pending', () => {
  const rows = [{ beat: 1 }, { beat: 9 }]
  const applied = [{ beat: 1 }]
  assert.deepEqual(pendingTimelineRows(rows, applied), new Set([1]))
})

// --- hitTest ----------------------------------------------------------------

test('hitTest: an edge wins over the body within tolerance; background misses return null', () => {
  const geometry = { width: 400, maxBeats: 16 }
  const handles: Handle[] = [
    { row: 0, kind: 'span', beat: 1, end: 9, lane: 0, ghost: false, disabled: false },
  ]
  const startX = beatToX(geometry, 1)
  const midX = beatToX(geometry, 5)
  assert.deepEqual(hitTest(handles, geometry, startX + 2, 0), { row: 0, part: 'start' })
  assert.deepEqual(hitTest(handles, geometry, midX, 0), { row: 0, part: 'body' })
  assert.equal(hitTest(handles, geometry, geometry.width, 0), null, 'no handle in lane at that x')
})

// --- snap ----------------------------------------------------------------

test('snap: quarter-beat by default, whole beats under coarse, unsnapped under free, clamped to >= 1', () => {
  assert.equal(snap(3.1), 3.0, 'nearest quarter')
  assert.equal(snap(3.13), 3.25)
  assert.equal(snap(3.6, { mode: 'coarse' }), 4)
  assert.equal(snap(3.567, { mode: 'free' }), 3.567)
  assert.equal(snap(-2), 1, 'clamped to the first beat')
})

// --- dragUpdate ----------------------------------------------------------------

test('dragUpdate move on a span only writes beat — dur (a length) rides along, preserving duration', () => {
  const handle: Handle = { row: 2, kind: 'span', beat: 5, end: 13, lane: 0, ghost: false, disabled: false }
  const { row, values } = dragUpdate(handle, 'move', 3)
  assert.equal(row, 2)
  assert.deepEqual(values, { beat: 8 })
})

test('dragUpdate end-edge drag writes dur back, respecting the minimum span', () => {
  const handle: Handle = { row: 0, kind: 'span', beat: 5, end: 6, lane: 0, ghost: false, disabled: false }
  // Dragging the end edge far to the left would collapse the span below minSpan.
  const { values } = dragUpdate(handle, 'end', -10, { minSpan: 0.25 })
  assert.deepEqual(values, { dur: 0.25 })
})

test('dragUpdate maps a content-table drop back through the timeline sourceBeatAt', () => {
  // Half speed: source 1..5 stretched across playback 1..9 (loop-beats 8).
  const timeline = buildTimeline([{ event: 'retime', beat: 1, from: 1, to: 5 }], 8)
  const handle: Handle = { row: 0, kind: 'point', beat: 1, lane: 0, ghost: false, disabled: false }
  // Drag the handle from playback beat 1 to playback beat 5 (the midpoint).
  const { values } = dragUpdate(handle, 'move', 4, { timeline })
  assert.equal(values.beat, timeline.sourceBeatAt(5), 'stored source beat matches the visual landing spot')
  assert.equal(values.beat, 3)
})

test('dragUpdate maps a wrapped ghost back through its own pass, not pass 0', () => {
  // Two holds a pass apart, each freezing on a different source beat — the
  // only way to tell which pass's sourceBeatAt actually ran.
  const timeline = buildTimeline([
    { event: 'hold', beat: 1, from: 3, loop: 0 },
    { event: 'hold', beat: 1, from: 7, loop: 1 },
  ])
  const handle: Handle = { row: 0, kind: 'point', beat: 2, lane: 1, ghost: true, disabled: false, pass: 1 }
  const { values } = dragUpdate(handle, 'move', 0, { timeline })
  assert.equal(values.beat, 7, "pass 2's hold source (7), not pass 1's (3)")
})

// --- dragUpdate: lanes never move on a horizontal drag ----------------------

test('dragUpdate never touches loop — a horizontal drag on a lane-1 timeline row keeps its pass, only beat moves', () => {
  const handle: Handle = { row: 1, kind: 'span', beat: 9, end: 17, lane: 1, ghost: false, disabled: false }
  const { values } = dragUpdate(handle, 'move', 2)
  assert.deepEqual(values, { beat: 11 })
  assert.ok(!('loop' in values), "a horizontal drag's payload never carries the row's pass assignment")
})

// --- drag gesture helpers (phase 4) ----------------------------------------

test('exceedsDragThreshold: below the threshold is a click, beyond it a drag, diagonal movement included', () => {
  assert.equal(exceedsDragThreshold(2, 0), false)
  assert.equal(exceedsDragThreshold(3, 0), false, 'exactly at the threshold is still a click')
  assert.equal(exceedsDragThreshold(4, 0), true)
  assert.equal(exceedsDragThreshold(3, 1), true, 'diagonal distance can exceed the threshold even though neither component alone does')
})

test('dragModeFor: hitTest parts map onto dragUpdate modes, body becomes a move', () => {
  assert.equal(dragModeFor('body'), 'move')
  assert.equal(dragModeFor('start'), 'start')
  assert.equal(dragModeFor('end'), 'end')
})

test('snapDelta: snaps the point the drag actually moves, not the raw delta, so an off-grid start still lands on-grid', () => {
  // Handle starts at beat 3.1, off the quarter grid. Adding the raw delta
  // would land at 3.6; snapDelta's returned delta must instead land the
  // anchor exactly where snap() would put 3.6 — not the same as snapping
  // the raw 0.5 delta on its own.
  const anchor = 3.1
  const rawDBeats = 0.5
  assert.equal(anchor + snapDelta(anchor, rawDBeats), snap(anchor + rawDBeats))
  assert.notEqual(snapDelta(anchor, rawDBeats), snap(rawDBeats), 'not the same as snapping the delta in isolation')
  assert.equal(snapDelta(anchor, rawDBeats, { mode: 'free' }), rawDBeats, 'free mode is a pass-through')
})

test('withPreview: patches one row with a drag-in-progress payload, leaving the rest and a no-op untouched', () => {
  const rows = [{ beat: 1 }, { beat: 5, dur: 2 }]
  assert.deepEqual(withPreview(rows, null), rows)
  const patched = withPreview(rows, { row: 1, values: { beat: 7 } })
  assert.deepEqual(patched, [{ beat: 1 }, { beat: 7, dur: 2 }])
  assert.deepEqual(rows[1], { beat: 5, dur: 2 }, 'the original row is untouched')
})

test('valuesDiffer: true only when a payload actually changes a stored field', () => {
  assert.equal(valuesDiffer({ beat: 3 }, { beat: 3 }), false)
  assert.equal(valuesDiffer({ beat: 3, end: 5 }, { beat: 3, end: 5.5 }), true)
})

test('resolveHandle: picks the specific ghost placement under the pointer, not just any handle on that row', () => {
  const geometry = { width: 800, maxBeats: 16 }
  const handles: Handle[] = [
    { row: 0, kind: 'point', beat: 1, lane: 0, ghost: false, disabled: false },
    { row: 0, kind: 'point', beat: 9, lane: 0, ghost: true, disabled: false },
  ]
  const xNearGhost = beatToX(geometry, 9)
  const hit = hitTest(handles, geometry, xNearGhost, 0)
  assert.deepEqual(hit, { row: 0, part: 'body' })
  const handle = resolveHandle(handles, geometry, hit!, xNearGhost, 0)
  assert.equal(handle?.ghost, true, 'the ghost placement actually under the pointer, not the primary one')
})

test('meaningfulSummary: identity columns per event type, never position', () => {
  const timelineCols: EditableColumn[] = [
    { name: 'beat', type: 'number' }, { name: 'loop', type: 'number' },
    { name: 'event', type: 'enum', options: ['retime', 'loop', 'hold', 'speed'] },
    { name: 'from', type: 'number' }, { name: 'to', type: 'number' },
    { name: 'disabled', type: 'boolean' },
  ]
  assert.deepEqual(
    meaningfulSummary({ beat: 1, loop: 0, event: 'retime', from: 1, to: 4, disabled: false }, timelineCols),
    ['retime', 'from 1', 'to 4'],
    'event kind unlabeled, params labeled, beat/loop/disabled-false skipped',
  )
  const codeCols: EditableColumn[] = [
    { name: 'beat', type: 'number' },
    { name: 'event', type: 'string' },
    { name: 'code', type: 'code', language: 'hydra' },
  ]
  const sketch = 'osc(10, 0.1)\n  .rotate(1)\n  .out(o0)'
  assert.deepEqual(meaningfulSummary({ beat: 3, event: 'setCode', code: sketch }, codeCols), ['setCode', 'osc(10, 0.1)'])
  const longLine = 'x'.repeat(80)
  assert.ok(meaningfulSummary({ code: longLine }, [{ name: 'code', type: 'code' }])[0].endsWith('…'), 'long code truncates')
})

test('meaningfulSummary: caps entries and is empty for a position-only row', () => {
  const wide: EditableColumn[] = Array.from({ length: 8 }, (_v, i) => ({ name: `c${i}`, type: 'number' as const }))
  const row = Object.fromEntries(wide.map((c, i) => [c.name, i + 1]))
  assert.equal(meaningfulSummary(row, wide).length, 4)
  assert.deepEqual(meaningfulSummary({ beat: 2, dur: 1 }, [{ name: 'beat', type: 'number' }, { name: 'dur', type: 'number' }]), [])
})
