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
import { formatEditableCell } from './table-panel.js'
import { placeBeat, timelineSegments, buildTimeline, type Timeline, type TimelineSegment } from './timeline.js'

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
  // Which stored column `beat`/`end` round-trip through on a drag — 'beat'
  // for every table but the origami fold table, whose own name for it is
  // `at` (see positionField). Omitted (not just 'beat') for the common case.
  posField?: 'beat' | 'at'
  lane: number
  // A later placement of the same row (a loop event playing it more than
  // once) — draggable, but not the "primary" one a click should focus.
  ghost: boolean
  disabled: boolean
  // Set (> 0) when this placement wrapped past one pass's worth of beats —
  // an active timeline's span with loops > 1, or (with no timeline) the
  // GUI loop length — so later content forms another pass instead of
  // running off the strip. Omitted (not just 0) for the common unwrapped
  // case, so existing handle-shape assertions don't need to know about it.
  pass?: number
}

// Which pass `beat` falls in, and its beat local to that pass — a beat past
// one `unit`-length pass wraps into the next rather than rendering off-strip
// (notes/timeline-strip-plan.md "Beats past maxBeats"). `maxPass` clamps to
// an active timeline's actual loop count (so the map's shared terminal instant
// resolves to the last pass, not a phantom one after it); omitted when passes
// are unbounded (content run long with no timeline defined).
function wrapPass(beat: number, unit: number, maxPass?: number): { local: number; pass: number } {
  if (!(unit > 0)) return { local: beat, pass: 0 }
  let pass = Math.max(0, Math.floor((beat - 1) / unit))
  if (maxPass !== undefined) pass = Math.min(pass, maxPass)
  return { local: beat - pass * unit, pass }
}

// Positional/bookkeeping columns the hover/drag readout skips: position is
// what the strip already shows visually (and as the unlabeled tag on the
// handle itself), so the readout is reserved for what identifies the row.
// `at` is the origami fold table's own name for its beat column (see
// positionField below).
const POSITIONAL_COLS = new Set(['beat', 'end', 'dur', 'loop', 'disabled', 'at'])

// Which column holds a content table's source beat: `beat` for every table
// but the origami fold table, whose `at` column plays the same role (the
// fold solver's own name for it — see fold-engine.ts).
function positionField(colNames: Set<string>): 'beat' | 'at' {
  return colNames.has('beat') ? 'beat' : 'at'
}

// First non-blank line of a code cell, whitespace-collapsed and capped — a
// sketch identifies its row at a glance without flooding the readout.
function codeSnippet(code: string, max = 48): string {
  const line = code.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? ''
  const collapsed = line.replace(/\s+/g, ' ')
  return collapsed.length > max ? collapsed.slice(0, max - 1) + '…' : collapsed
}

// The row's *meaningful* columns, one readout line each (the view stacks
// them): what the row IS — its event kind (unlabeled, it's the identity), a
// code cell's first line, and the remaining non-blank values labeled by
// column — never its position (POSITIONAL_COLS), which the strip shows
// visually. Column order is the schema's, so each event type naturally leads
// with whatever its table puts first; capped at `max` lines.
export function meaningfulSummary(row: Row, columns: EditableColumn[], max = 4): string[] {
  const parts: string[] = []
  for (const c of columns) {
    if (parts.length >= max) break
    if (POSITIONAL_COLS.has(c.name)) continue
    const v = row[c.name]
    if (v == null || v === '' || v === false) continue
    if (c.name === 'event') parts.push(String(v))
    else if (c.type === 'code') parts.push(codeSnippet(String(v)))
    else parts.push(`${c.name} ${formatEditableCell(c.type, v)}`)
  }
  return parts
}

// Applies an in-progress drag's not-yet-committed values to one row before
// handle derivation, so every placement of that row (a loop event's ghosts
// included) recomputes from the dragged position — merging at the Handle
// level instead would miss ghosts, since they're re-derived from the row via
// placeBeat, not copied from the primary handle.
export function withPreview(rows: Row[], preview: { row: number; values: Record<string, unknown> } | null): Row[] {
  if (!preview) return rows
  const row = rows[preview.row]
  if (!row) return rows
  const next = rows.slice()
  next[preview.row] = { ...row, ...preview.values }
  return next
}

export function handlesFor(name: string, rows: Row[], columns: EditableColumn[], timelineRows: Row[], loopBeats?: number): Handle[] {
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
  // of that source beat (placeBeat) gets its own handle. Either way, a
  // placement can land past one pass's worth of beats — a multi-pass active
  // timeline's span, or (with none) the GUI loop length — and wraps into a
  // "pass n" badge (wrapPass) rather than rendering off-strip. An active
  // timeline's passes get their own lane (matching the coverage shading,
  // which is lane-per-pass too — see coverageBands); with no timeline there
  // are no lanes to place a later pass into, so it stays in lane 0 with just
  // the badge.
  const segments = timelineSegments(timelineRows)
  const timeline = segments.length ? buildTimeline(timelineRows) : null
  const wrapUnit = timeline ? timeline.beats : loopBeats
  const maxPass = timeline ? Math.max(0, timeline.loops - 1) : undefined
  const posField = positionField(colNames)
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const beat = num(row[posField])
    if (beat === undefined) continue
    const dur = colNames.has('dur') ? num(row.dur) : undefined
    const disabled = row.disabled === true
    const placements = segments.length ? placeBeat(segments, beat) : [{ beat, stretch: 1 }]
    placements.forEach((p, idx) => {
      const w = wrapUnit && wrapUnit > 0 ? wrapPass(p.beat, wrapUnit, maxPass) : { local: p.beat, pass: 0 }
      handles.push({
        row: i,
        kind: dur !== undefined ? 'span' : 'point',
        beat: w.local,
        end: dur !== undefined ? w.local + dur * p.stretch : undefined,
        endField: dur !== undefined ? 'dur' : undefined,
        ...(posField === 'at' ? { posField: 'at' as const } : {}),
        lane: timeline ? w.pass : 0,
        ghost: idx > 0,
        disabled,
        ...(w.pass > 0 ? { pass: w.pass } : {}),
      })
    })
  }
  return handles
}

// How many lane bands the strip needs: at least the current table's own
// handles (the `timeline` table's `loop` column, or a content table's
// pass-wrapped ghosts), and at least the timeline's own pass count — so
// lanes still show (for the coverage layer's sake) when the open table has
// no handle past lane 0, e.g. a content table with nothing looping.
export function laneCountFor(handles: Handle[], timelineRows: Row[]): number {
  const fromHandles = handles.reduce((m, h) => Math.max(m, h.lane + 1), 1)
  return Math.max(fromHandles, buildTimeline(timelineRows).loops)
}

export interface CoverageBand {
  p0: number
  p1: number
  lane: number
  kind?: TimelineSegment['kind']
}

// One tinted band per compiled segment, its beats mapped from the extended
// playback axis (see timeline.ts's compile) onto its own pass's local
// 0..span axis and tagged with which lane that pass is — mirrors
// handlesFor's content-row wrap, but exact rather than approximate: a
// segment never straddles a pass boundary (compile builds every segment
// within one loop's `beat + L*span` offset), so its p0 and p1 always fall
// in the same lane.
export function coverageBands(timelineRows: Row[]): CoverageBand[] {
  const timeline = buildTimeline(timelineRows)
  if (!timeline.active) return []
  const span = timeline.beats
  const maxLane = Math.max(0, timeline.loops - 1)
  return timelineSegments(timelineRows).map((seg) => {
    const lane = span > 0 ? Math.min(maxLane, Math.max(0, Math.floor((seg.p0 - 1) / span))) : 0
    const off = lane * span
    return { p0: seg.p0 - off, p1: seg.p1 - off, lane, kind: seg.kind }
  })
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
// same spot. Null means background — the strip's view treats that as inert
// (it no longer scrubs).
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

// hitTest only identifies a row+part, not which physical Handle answered it —
// a row played by a loop event has one ghost per placement, each at its own
// x, and a drag needs the actual placement grabbed (its beat/end/lane) to
// compute dBeats against. Re-scans just that row's candidates by the same
// edge-vs-body distance hitTest itself used; the common case (one placement)
// short-circuits without the scan.
export function resolveHandle(handles: Handle[], geometry: StripGeometry, hit: HitResult, x: number, lane: number): Handle | undefined {
  const candidates = handles.filter((h) => h.row === hit.row && h.lane === lane)
  if (candidates.length <= 1) return candidates[0]
  let best: Handle | undefined
  let bestDist = Infinity
  for (const h of candidates) {
    const target = hit.part === 'end' ? (h.end ?? h.beat) : h.beat
    const dist = Math.abs(x - beatToX(geometry, target))
    if (dist < bestDist) { bestDist = dist; best = h }
  }
  return best
}

export type SnapMode = 'quarter' | 'coarse' | 'free'

// Quarter-beat by default, whole beats under 'coarse' (Shift), unsnapped
// under 'free' (Alt) — always clamped to the first beat.
export function snap(beat: number, opts: { mode?: SnapMode } = {}): number {
  const mode = opts.mode ?? 'quarter'
  const snapped = mode === 'coarse' ? Math.round(beat) : mode === 'free' ? beat : Math.round(beat * 4) / 4
  return Math.max(1, snapped)
}

// Snaps a drag delta so the point it actually moves (`anchor` — the handle's
// own beat for a move/start drag, its end for an end drag) lands exactly on
// the snap grid. Snapping the raw delta itself would only land on-grid when
// the handle's starting position already was.
export function snapDelta(anchor: number, dBeats: number, opts: { mode?: SnapMode } = {}): number {
  return snap(anchor + dBeats, opts) - anchor
}

export type DragMode = 'move' | 'start' | 'end'

// hitTest's part vocabulary ('start'/'end'/'body') maps directly onto
// dragUpdate's mode vocabulary ('start'/'end'/'move') — a handle's body is
// dragged by moving it, an edge by resizing that edge.
export function dragModeFor(part: HitPart): DragMode {
  return part === 'body' ? 'move' : part
}

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
  const { row, beat, end, endField, pass, posField = 'beat' } = handle
  // A wrapped placement's `beat`/`end` are local to its own pass (wrapPass) —
  // sourceBeatAt needs that pass back to re-derive the right extended-axis
  // point, the same `loop` argument buildTimeline's own multi-pass playback
  // uses.
  const toSource = (b: number): number => (opts.timeline?.active ? opts.timeline.sourceBeatAt(b, pass ?? 0) : b)

  if (mode === 'move') {
    const nextBeat = Math.max(1, beat + dBeats)
    const values: Record<string, unknown> = { [posField]: toSource(nextBeat) }
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
      return { row, values: { [posField]: toSource(nextBeat), dur: toSource(fixedEnd) - toSource(nextBeat) } }
    }
    return { row, values: { [posField]: toSource(nextBeat) } }
  }

  // mode === 'end'
  const nextEnd = Math.max((end ?? beat) + dBeats, beat + minSpan)
  if (endField === 'dur') return { row, values: { dur: toSource(nextEnd) - toSource(beat) } }
  return { row, values: { end: toSource(nextEnd) } }
}

// Whether a drag's payload actually changes the stored row — a gesture that
// snaps back to where it started (or a sub-threshold press that never became
// a drag) must commit nothing.
export function valuesDiffer(row: Row, values: Record<string, unknown>): boolean {
  return Object.entries(values).some(([k, v]) => row[k] !== v)
}

// Pointerdown-to-drag movement threshold, squared to skip a sqrt per move.
export function exceedsDragThreshold(dx: number, dy: number, thresholdPx = 3): boolean {
  return dx * dx + dy * dy > thresholdPx * thresholdPx
}
