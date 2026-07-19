// The timeline strip's pure model — geometry, grid, handle derivation, hit
// testing and drag math. No DOM; src/ui/timeline-strip.tsx is the view.
//
// Coordinate rules (see notes/timeline-strip-plan.md "Coordinate rules"):
// beats are 1-indexed positions, the strip's px axis is 0..maxBeats elapsed
// beats, so beat b sits at elapsed (b - 1). The `timeline` table's own rows
// already live on this playback axis (identity); every other table's `beat`
// is a *source* beat, placed onto the axis through `placeBeat`.

import type { Row } from './lineage.js'
import type { EditableColumn } from './editable-tables.js'
import { placeBeat, timelineSegments, type Timeline } from './timeline.js'

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

export interface StripGeometry {
  width: number
  maxBeats: number
}

export function beatToX(geometry: StripGeometry, beat: number): number {
  const { width, maxBeats } = geometry
  if (!(maxBeats > 0)) return 0
  return ((beat - 1) / maxBeats) * width
}

export function xToBeat(geometry: StripGeometry, x: number): number {
  const { width, maxBeats } = geometry
  if (!(width > 0)) return 1
  return (x / width) * maxBeats + 1
}

export interface GridLine {
  beat: number
  x: number
  kind: 'minor' | 'major'
  // Present only on major ticks, and only when major ticks are far enough
  // apart to read — dropped wholesale (not thinned) once they'd collide.
  label?: string
}

const MAJOR_EVERY = 4
const MIN_LABEL_SPACING_PX = 24

export function gridLines(maxBeats: number, width: number): GridLine[] {
  if (!(maxBeats > 0) || !(width > 0)) return []
  const geometry: StripGeometry = { width, maxBeats }
  const pxPerBeat = width / maxBeats
  const showLabels = pxPerBeat * MAJOR_EVERY >= MIN_LABEL_SPACING_PX
  const lastBeat = Math.floor(maxBeats) + 1
  const lines: GridLine[] = []
  for (let beat = 1; beat <= lastBeat; beat++) {
    const major = (beat - 1) % MAJOR_EVERY === 0
    lines.push({
      beat,
      x: beatToX(geometry, beat),
      kind: major ? 'major' : 'minor',
      label: major && showLabels ? String(beat) : undefined,
    })
  }
  return lines
}

// One draggable descriptor. `row` (storage index) is the identity that
// survives re-sorting and re-derivation mid-drag.
export interface Handle {
  row: number
  kind: 'point' | 'span'
  // Playback-axis position (post placeBeat for non-timeline tables).
  beat: number
  end?: number
  // Which stored column the far edge writes back to — 'end' rows (the
  // `timeline` table) move both edges together on a move; 'dur' rows (a
  // length, not a second position) only get touched by an edge drag.
  endField?: 'end' | 'dur'
  lane: number
  // A later placement of the same row (a loop event playing it more than
  // once) — draggable, but not the "primary" one a click should focus.
  ghost: boolean
  disabled: boolean
}

export function handlesFor(name: string, rows: Row[], columns: EditableColumn[], timelineRows: Row[]): Handle[] {
  const colNames = new Set(columns.map((c) => c.name))
  const handles: Handle[] = []

  if (name === 'timeline') {
    const hasLoop = colNames.has('loop')
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      const beat = num(row.beat)
      if (beat === undefined) continue
      const end = (colNames.has('end') ? num(row.end) : undefined) ?? beat
      handles.push({
        row: i,
        kind: 'span',
        beat,
        end,
        endField: 'end',
        lane: hasLoop ? Math.max(0, Math.floor(num(row.loop) ?? 0)) : 0,
        ghost: false,
        disabled: row.disabled === true,
      })
    }
    return handles
  }

  // Content table: beat is a source beat. With no timeline defined this is
  // the identity map (the common case); with one, every playback placement
  // of that source beat (placeBeat) gets its own handle.
  const segments = timelineSegments(timelineRows)
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const beat = num(row.beat)
    if (beat === undefined) continue
    const dur = colNames.has('dur') ? num(row.dur) : undefined
    const disabled = row.disabled === true
    const placements = segments.length ? placeBeat(segments, beat) : [{ beat, stretch: 1 }]
    placements.forEach((p, idx) => {
      handles.push({
        row: i,
        kind: dur !== undefined ? 'span' : 'point',
        beat: p.beat,
        end: dur !== undefined ? p.beat + dur * p.stretch : undefined,
        endField: dur !== undefined ? 'dur' : undefined,
        lane: 0,
        ghost: idx > 0,
        disabled,
      })
    })
  }
  return handles
}

// Which storage rows of the `timeline` table have drifted from the applied
// cook (the strip's dashed-outline "pending" style). v1 only covers this
// table: its store rows and the applied cook's `table("timeline")` rows line
// up index-for-index once disabled rows are excluded (ensure()'s
// visibleRows filters the same way before a program ever sees them), so a
// straight positional comparison works without needing row identity carried
// through the cook.
export function pendingTimelineRows(rows: Row[], appliedRows: Row[]): Set<number> {
  const pending = new Set<number>()
  let pos = 0
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (row.disabled === true) continue
    const applied = appliedRows[pos]
    pos++
    if (!applied || num(row.beat) !== num(applied.beat) || num(row.end) !== num(applied.end)) pending.add(i)
  }
  return pending
}

export type HitPart = 'start' | 'end' | 'body'

export interface HitResult {
  row: number
  part: HitPart
}

const EDGE_TOLERANCE_PX = 6

// Which handle (and which part of it) sits under a pointer at `(x, lane)`.
// Edges win over body within EDGE_TOLERANCE_PX; among body hits a point
// handle (a precise target) wins over a span's body (a broad one) at the
// same spot. Null means background — the caller falls back to scrub.
interface Candidate {
  result: HitResult
  priority: number
  dist: number
}

// A later candidate only replaces the best one so far if it's a strictly
// higher-priority tier, or a closer match within the same tier.
function better(prev: Candidate | null, next: Candidate): Candidate {
  if (!prev || next.priority > prev.priority || (next.priority === prev.priority && next.dist < prev.dist)) return next
  return prev
}

export function hitTest(handles: Handle[], geometry: StripGeometry, x: number, lane: number): HitResult | null {
  let best: Candidate | null = null

  for (const h of handles) {
    if (h.lane !== lane) continue
    const startX = beatToX(geometry, h.beat)
    if (h.kind === 'span' && h.end !== undefined) {
      const endX = beatToX(geometry, h.end)
      const dStart = Math.abs(x - startX)
      const dEnd = Math.abs(x - endX)
      if (dStart <= EDGE_TOLERANCE_PX) best = better(best, { result: { row: h.row, part: 'start' }, priority: 2, dist: dStart })
      if (dEnd <= EDGE_TOLERANCE_PX) best = better(best, { result: { row: h.row, part: 'end' }, priority: 2, dist: dEnd })
      if (x >= startX && x <= endX) {
        best = better(best, { result: { row: h.row, part: 'body' }, priority: 1, dist: Math.min(dStart, dEnd) })
      }
    } else if (Math.abs(x - startX) <= EDGE_TOLERANCE_PX) {
      best = better(best, { result: { row: h.row, part: 'body' }, priority: 1.5, dist: Math.abs(x - startX) })
    }
  }
  return best ? best.result : null
}

export type SnapMode = 'quarter' | 'coarse' | 'free'

// Quarter-beat by default, whole beats under 'coarse' (Shift), unsnapped
// under 'free' (Alt) — always clamped to the first beat.
export function snap(beat: number, opts: { mode?: SnapMode } = {}): number {
  const mode = opts.mode ?? 'quarter'
  const snapped = mode === 'coarse' ? Math.round(beat) : mode === 'free' ? beat : Math.round(beat * 4) / 4
  return Math.max(1, snapped)
}

export type DragMode = 'move' | 'start' | 'end'

export interface DragOptions {
  // Minimum span (beats) a 'start'/'end' drag may shrink a span to.
  minSpan?: number
  // Set when dragging a non-'timeline' table's handle under an active
  // timeline: inverts the playback-axis drop position back to the row's
  // stored source beat via sourceBeatAt, so storage matches where the
  // handle visually landed.
  timeline?: Timeline
}

export interface DragResult {
  row: number
  values: Record<string, unknown>
}

const DEFAULT_MIN_SPAN = 0.25

export function dragUpdate(handle: Handle, mode: DragMode, dBeats: number, opts: DragOptions = {}): DragResult {
  const minSpan = opts.minSpan ?? DEFAULT_MIN_SPAN
  const { row, beat, end, endField } = handle
  const toSource = (b: number): number => (opts.timeline?.active ? opts.timeline.sourceBeatAt(b) : b)

  if (mode === 'move') {
    const nextBeat = Math.max(1, beat + dBeats)
    const values: Record<string, unknown> = { beat: toSource(nextBeat) }
    // A 'dur' span's length is stored in source beats, untouched by a pure
    // move; an 'end' span (the timeline table) shifts its far edge too, so
    // its window keeps the same playback duration.
    if (end !== undefined && endField === 'end') values.end = toSource(end + dBeats)
    return { row, values }
  }

  if (mode === 'start') {
    const fixedEnd = end ?? beat
    const nextBeat = Math.max(1, Math.min(beat + dBeats, fixedEnd - minSpan))
    if (endField === 'dur') {
      return { row, values: { beat: toSource(nextBeat), dur: toSource(fixedEnd) - toSource(nextBeat) } }
    }
    return { row, values: { beat: toSource(nextBeat) } }
  }

  // mode === 'end'
  const nextEnd = Math.max((end ?? beat) + dBeats, beat + minSpan)
  if (endField === 'dur') return { row, values: { dur: toSource(nextEnd) - toSource(beat) } }
  return { row, values: { end: toSource(nextEnd) } }
}
