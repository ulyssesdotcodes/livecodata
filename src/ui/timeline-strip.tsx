// The timeline strip — the humble Solid view over ../timeline-strip.ts (the
// pure geometry/grid/handle model) and ../timeline.ts (coverage shading).
// Replaces the transport's `#scrub-bar` range input.
//
// Phase 3 (this file): a read-only handles layer for the currently open
// editable table's rows, synced with the table panel (hover tooltip, click
// focuses the row, panel focus and peer presence ring the matching handle).
// Dragging (phase 4) lands later — see notes/timeline-strip-plan.md.

import { createSignal, createMemo, onMount, onCleanup, For, Show, type Accessor } from 'solid-js'
import {
  beatToX, xToBeat, gridLines, handlesFor, hitTest, pendingTimelineRows,
  type StripGeometry, type Handle,
} from '../timeline-strip.js'
import { timelineSegments } from '../timeline.js'
import { fmtNum } from '../graph-panel.js'
import type { PlaybackEngine, PlaybackViewState } from '../playback.js'
import type { Row } from '../lineage.js'
import type { EditableTableStore } from '../editable-tables.js'
import type { PeerPresence } from '../table-panel.js'

// One minor grid tick (a beat) per ArrowLeft/ArrowRight, matching the grid's
// own step so keyboard nudges land exactly on a tick.
const KEY_NUDGE_BEATS = 1

// Accent color for the strip's focused-handle ring — matches the playhead
// (#e94560), the strip's one other "this is the important one" signal.
const FOCUS_RING = '0 0 0 2px #e94560'

export function TimelineStrip(props: {
  vs: Accessor<PlaybackViewState>
  engine: PlaybackEngine
  timelineRows: Accessor<Row[]>
  store: EditableTableStore
  currentTable: Accessor<string | null>
  onSelectRow?: (table: string, row: number) => void
  presence: Accessor<PeerPresence[]>
  focusedRow: Accessor<number | null>
}) {
  let el: HTMLDivElement | undefined
  const [width, setWidth] = createSignal(0)

  onMount(() => {
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width
      if (w != null) setWidth(w)
    })
    ro.observe(el)
    onCleanup(() => ro.disconnect())
  })

  // vs() updates every animation frame while playing. Reading only the one
  // field each memo needs (rather than depending on vs() as a whole) means a
  // memo's default equality check absorbs frames where that field didn't
  // change, so the grid/coverage layers below don't rebuild every tick — only
  // scrubPos (and the layers derived from it) update at frame rate.
  const maxBeats = createMemo(() => props.vs().maxBeats)
  const scrubPos = createMemo(() => props.vs().scrubPos)

  const geometry = createMemo<StripGeometry>(() => ({ width: width(), maxBeats: maxBeats() }))
  const grid = createMemo(() => gridLines(geometry().maxBeats, geometry().width))
  const coverage = createMemo(() => {
    const geo = geometry()
    return timelineSegments(props.timelineRows()).map((seg) => {
      const left = beatToX(geo, seg.p0)
      return { left, width: Math.max(0, beatToX(geo, seg.p1) - left) }
    })
  })

  // The only two things that move per playback frame.
  const playheadX = createMemo(() => beatToX(geometry(), scrubPos() + 1))

  // --- handles: the currently open table's rows ---------------------------
  // store.onChange has no unsubscribe; the strip is mounted once for the
  // app's lifetime (ui/app.tsx), so one subscription for life is fine —
  // mirrors table-panel.tsx's own `tick`.
  const [tick, setTick] = createSignal(0)
  props.store.onChange(() => setTick((t) => t + 1))

  // A genuinely editable, non-log table — same test table-panel.tsx uses to
  // decide whether the open tab gets row/column editing at all.
  const currentData = createMemo(() => {
    tick()
    const name = props.currentTable()
    if (!name || !props.store.has(name) || props.store.isLog(name)) return null
    const data = props.store.get(name)
    return data ? { name, ...data } : null
  })

  // Handle placement reads the store's *own* `timeline` rows — pending, live
  // — even though the coverage layer above reads the applied `timelineRows`
  // prop: a content table's handles should track this session's in-progress
  // retiming as it's being edited, not wait for Apply (see notes/timeline-
  // strip-plan.md's "live/applied split" — the grid already works this way).
  const liveTimelineRows = createMemo(() => {
    tick()
    return props.store.get('timeline')?.rows ?? []
  })

  const handles = createMemo(() => {
    const cur = currentData()
    return cur ? handlesFor(cur.name, cur.rows, cur.columns, liveTimelineRows()) : []
  })

  const laneCount = createMemo(() => handles().reduce((m, h) => Math.max(m, h.lane + 1), 1))

  // Dashed-outline "pending" style: v1 only detects drift for the `timeline`
  // table itself (see pendingTimelineRows) — every other table's handles skip
  // this check and never render pending this phase.
  const pendingRows = createMemo(() => {
    const cur = currentData()
    if (!cur || cur.name !== 'timeline') return new Set<number>()
    return pendingTimelineRows(cur.rows, props.timelineRows())
  })

  // Any collaborator whose last edit landed on this row, any column — like
  // table-panel.ts's lastEditors, but column-agnostic: a handle represents
  // the whole row's position, not one cell.
  function peerRingColor(table: string, row: number): string | undefined {
    return props.presence().find((p) => p.lastEdit && p.lastEdit.table === table && p.lastEdit.row === row)?.color
  }

  function handleTitle(row: Row, h: Handle): string {
    const parts: string[] = []
    if (typeof row.event === 'string' && row.event) parts.push(row.event)
    parts.push(`beat ${fmtNum(h.beat)}`)
    if (h.end != null) parts.push(h.endField === 'dur' ? `dur ${fmtNum(h.end - h.beat)}` : `end ${fmtNum(h.end)}`)
    if (h.disabled) parts.push('disabled')
    if (h.ghost) parts.push('ghost placement')
    return parts.join(' · ')
  }

  function handleBox(h: Handle): { left: string; width?: string; top: string; height: string } {
    const geo = geometry()
    const top = `${(h.lane / laneCount()) * 100}%`
    const height = `${100 / laneCount()}%`
    if (h.kind === 'span' && h.end != null) {
      const left = beatToX(geo, h.beat)
      const width = Math.max(1, beatToX(geo, h.end) - left)
      return { left: `${left}px`, width: `${width}px`, top, height }
    }
    return { left: `${beatToX(geo, h.beat)}px`, top, height }
  }

  function ringStyle(table: string, h: Handle): string | undefined {
    const focused = !h.ghost && h.row === props.focusedRow()
    const peerColor = peerRingColor(table, h.row)
    const rings: string[] = []
    if (focused) rings.push(FOCUS_RING)
    if (peerColor) rings.push(`0 0 0 ${focused ? 4 : 2}px ${peerColor}`)
    return rings.length ? rings.join(', ') : undefined
  }

  // Client-x → elapsed beats (0-based, matching PlaybackViewState.scrubPos),
  // clamped to the strip's range — the inverse of playheadX above.
  function elapsedBeatAt(clientX: number): number {
    const rect = el!.getBoundingClientRect()
    const geo = geometry()
    const beat = xToBeat(geo, clientX - rect.left)
    return Math.max(0, Math.min(geo.maxBeats, beat - 1))
  }

  // Which lane a pointer's client-y falls in — the inverse of handleBox's
  // top/height split, both dividing the strip's full height evenly.
  function laneAt(clientY: number): number {
    const count = laneCount()
    if (count <= 1) return 0
    const rect = el!.getBoundingClientRect()
    if (!(rect.height > 0)) return 0
    return Math.min(count - 1, Math.max(0, Math.floor(((clientY - rect.top) / rect.height) * count)))
  }

  // Background drag scrubs; a pointerdown that lands on a handle (per the
  // model's hitTest, not DOM element identity — handles bubble their
  // pointerdown up to this element) selects that row instead and does not
  // start a scrub.
  let dragging = false
  function onPointerDown(e: PointerEvent): void {
    const cur = currentData()
    if (cur) {
      const rect = el!.getBoundingClientRect()
      const hit = hitTest(handles(), geometry(), e.clientX - rect.left, laneAt(e.clientY))
      if (hit) {
        props.onSelectRow?.(cur.name, hit.row)
        return
      }
    }
    dragging = true
    el?.setPointerCapture(e.pointerId)
    props.engine.scrub(elapsedBeatAt(e.clientX))
  }
  function onPointerMove(e: PointerEvent): void {
    if (!dragging) return
    props.engine.scrub(elapsedBeatAt(e.clientX))
  }
  function endDrag(): void {
    if (!dragging) return
    dragging = false
    props.engine.endScrub()
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const dir = e.key === 'ArrowLeft' ? -1 : 1
    const vsNow = props.vs()
    props.engine.scrub(Math.max(0, Math.min(vsNow.maxBeats, vsNow.scrubPos + dir * KEY_NUDGE_BEATS)))
    props.engine.endScrub()
  }

  return (
    <div
      class="timeline-strip"
      ref={el}
      tabIndex={0}
      role="slider"
      aria-label="Playback position"
      aria-valuemin={0}
      aria-valuemax={props.vs().maxBeats}
      aria-valuenow={props.vs().scrubPos}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
    >
      <For each={coverage()}>
        {(seg) => <div class="timeline-strip-coverage" style={{ left: `${seg.left}px`, width: `${seg.width}px` }} />}
      </For>
      <div class="timeline-strip-elapsed" style={{ width: `${playheadX()}px` }} />
      <For each={grid()}>
        {(line) => (
          <div class={`timeline-strip-tick timeline-strip-tick-${line.kind}`} style={{ left: `${line.x}px` }}>
            {line.label != null && <span class="timeline-strip-tick-label">{line.label}</span>}
          </div>
        )}
      </For>
      <Show when={currentData()}>
        {(cur) => (
          <div class="timeline-strip-handles">
            <For each={handles()}>
              {(h) => (
                <div
                  class={`timeline-strip-handle timeline-strip-handle-${h.kind}`}
                  classList={{
                    'timeline-strip-handle-ghost': h.ghost,
                    'timeline-strip-handle-disabled': h.disabled,
                    'timeline-strip-handle-pending': pendingRows().has(h.row),
                  }}
                  style={{ ...handleBox(h), 'box-shadow': ringStyle(cur().name, h) }}
                  title={handleTitle(cur().rows[h.row] ?? {}, h)}
                >
                  <Show when={h.kind === 'point'}>
                    <span class="timeline-strip-handle-dot" />
                  </Show>
                  <Show when={h.kind === 'span'}>
                    <span class="timeline-strip-handle-edge timeline-strip-handle-edge-start" />
                    <span class="timeline-strip-handle-edge timeline-strip-handle-edge-end" />
                  </Show>
                </div>
              )}
            </For>
          </div>
        )}
      </Show>
      <div class="timeline-strip-playhead" style={{ left: `${playheadX()}px` }} />
    </div>
  )
}
