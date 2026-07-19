// The timeline strip — the humble Solid view over ../timeline-strip.ts (the
// pure geometry/grid/handle/drag model) and ../timeline.ts (coverage shading,
// source-beat mapping).
// Replaces the transport's `#scrub-bar` range input.
//
// Phase 4: dragging. A handle's pointerdown starts a pending gesture rather
// than an immediate click; a small movement threshold decides whether
// pointerup is a click (select the row, as phase 3) or the end of a drag
// (commit one store.setRow with the dragged values). Mid-drag, the dragged
// row's values are only ever previewed locally (the `preview` signal, merged
// over the store row by `withPreview` before handle derivation) — nothing
// touches the store until release, so peers see the handle jump once, not a
// pointermove's worth of history events.
//
// Phase 5: lanes + pass wrapping. A multi-pass timeline (`loop` column > 0)
// grows the strip into one lane band per pass — both the `timeline` table's
// own handles (lane = their `loop` value) and the coverage shading (see
// coverageBands) split per pass, so a pass's events line up with its own
// tint. A content table's beat that runs past one pass's length wraps into
// a later pass too (wrapPass, in the model), landing in that pass's lane
// with a small badge; with no timeline active there's no lane to place it
// in, so it stays put with just the badge.

import { createSignal, createMemo, onMount, onCleanup, For, Show, type Accessor } from 'solid-js'
import {
  beatToX, xToBeat, gridLines, handlesFor, hitTest, pendingTimelineRows,
  resolveHandle, dragModeFor, snapDelta, dragUpdate, withPreview,
  valuesDiffer, exceedsDragThreshold, laneCountFor, coverageBands,
  type StripGeometry, type Handle, type HitPart, type DragOptions, type SnapMode,
} from '../timeline-strip.js'
import { buildTimeline } from '../timeline.js'
import { fmtNum } from '../graph-panel.js'
import { listenGlobal } from './dom.js'
import type { PlaybackEngine, PlaybackViewState } from '../playback.js'
import type { Row } from '../lineage.js'
import type { EditableTableStore } from '../editable-tables.js'
import type { PeerPresence } from '../table-panel.js'

// One minor grid tick (a beat) per ArrowLeft/ArrowRight, matching the grid's
// own step so keyboard nudges land exactly on a tick.
const KEY_NUDGE_BEATS = 1

// The strip's height grows per lane band up to this many — a timeline with
// more passes than this still gets all its lanes (hit-testing and rendering
// both use the real count), just thinner ones, plus an overflow badge.
const MAX_VISIBLE_LANES = 4

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
  // Lane-per-pass (coverageBands), same split as the handles layer below —
  // a pass's coverage tint lines up with that pass's lane band.
  const coverage = createMemo(() => {
    const geo = geometry()
    return coverageBands(props.timelineRows()).map((band) => {
      const left = beatToX(geo, band.p0)
      return { left, width: Math.max(0, beatToX(geo, band.p1) - left), lane: band.lane, kind: band.kind }
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

  // The in-progress drag's not-yet-committed values — a signal, not a plain
  // variable, so this memo (and the tooltip/label/dragging-style reads below)
  // re-render as the pointer moves. Cleared on commit or cancel; the store
  // itself is never touched mid-gesture.
  const [preview, setPreview] = createSignal<{ table: string; row: number; part: HitPart; values: Record<string, unknown> } | null>(null)

  const handles = createMemo(() => {
    const cur = currentData()
    if (!cur) return []
    const p = preview()
    const rows = p && p.table === cur.name ? withPreview(cur.rows, p) : cur.rows
    return handlesFor(cur.name, rows, cur.columns, liveTimelineRows(), props.vs().loopBeats)
  })

  // Lane bands: at least the open table's own handles (live — the
  // `timeline` table's `loop` column, or a content table's pass-wrapped
  // ghosts) and at least the applied cook's own pass count, so the coverage
  // layer's lanes still show when the currently open table has no handle
  // past lane 0 (e.g. a plain content table under a multi-pass timeline).
  const laneCount = createMemo(() => Math.max(
    laneCountFor(handles(), liveTimelineRows()),
    buildTimeline(props.timelineRows()).loops,
  ))
  // Rendered lane bands cap at MAX_VISIBLE_LANES — past that the strip
  // stops growing taller (lane bands just thin out further, still exactly
  // laneCount of them) and an overflow badge names the real count.
  const visibleLanes = createMemo(() => Math.min(laneCount(), MAX_VISIBLE_LANES))

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
    if (h.pass) parts.push(`pass ${h.pass + 1}`)
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

  // A handle drag in progress — a plain (non-reactive) var: geometry/pointer
  // bookkeeping the drag needs frame to frame, distinct from `preview` (the
  // reactive signal the render actually reads). `moved` flips once the
  // pointer clears the click/drag threshold; until then pointerup is a click.
  interface Gesture {
    table: string
    handle: Handle
    part: HitPart
    pointerId: number
    startClientX: number
    startClientY: number
    moved: boolean
  }
  let gesture: Gesture | null = null

  // Background scrub — unrelated to a handle gesture, kept as its own flag
  // exactly as before phase 4.
  let scrubbing = false

  // Idle hover (no gesture, no scrub): which part sits under the pointer,
  // purely for the grab/ew-resize cursor affordance.
  const [hoverPart, setHoverPart] = createSignal<HitPart | null>(null)

  function snapModeFor(e: PointerEvent): SnapMode {
    return e.shiftKey ? 'coarse' : e.altKey ? 'free' : 'quarter'
  }

  // Pointer dx (converted to beats via the geometry, snapped per the live
  // modifier keys) → the model's dragUpdate payload, previewed locally.
  function updateGesturePreview(g: Gesture, e: PointerEvent): void {
    if (!el) return
    const geo = geometry()
    const rect = el.getBoundingClientRect()
    const rawDBeats = xToBeat(geo, e.clientX - rect.left) - xToBeat(geo, g.startClientX - rect.left)
    const anchor = g.part === 'end' ? (g.handle.end ?? g.handle.beat) : g.handle.beat
    const dBeats = snapDelta(anchor, rawDBeats, { mode: snapModeFor(e) })
    const opts: DragOptions = {}
    // The `timeline` table's own rows are already playback-axis positions —
    // only a content table's drop needs mapping back through sourceBeatAt.
    if (g.table !== 'timeline') {
      const tl = buildTimeline(liveTimelineRows())
      if (tl.active) opts.timeline = tl
    }
    const { values } = dragUpdate(g.handle, dragModeFor(g.part), dBeats, opts)
    setPreview({ table: g.table, row: g.handle.row, part: g.part, values })
  }

  // One store.setRow for the whole gesture (a no-op if the drag snapped back
  // to where it started), then focus the row exactly like a plain click.
  function commitGesture(g: Gesture): void {
    if (g.moved) {
      const p = preview()
      const cur = currentData()
      if (p && cur && cur.name === p.table) {
        const row = cur.rows[p.row]
        if (row && valuesDiffer(row, p.values)) props.store.setRow(p.table, p.row, p.values)
      }
    }
    props.onSelectRow?.(g.table, g.handle.row)
    setPreview(null)
  }

  function cancelGesture(): void {
    if (!gesture) return
    el?.releasePointerCapture(gesture.pointerId)
    gesture = null
    setPreview(null)
  }

  // Escape cancels a drag wherever keyboard focus happens to be — a mouse
  // drag rarely leaves focus on the strip itself.
  listenGlobal(window, 'keydown', (e) => {
    if (e.key === 'Escape' && gesture) {
      e.preventDefault()
      cancelGesture()
    }
  })

  function updateHover(e: PointerEvent): void {
    const cur = currentData()
    if (!cur || !el) { setHoverPart(null); return }
    const rect = el.getBoundingClientRect()
    const hit = hitTest(handles(), geometry(), e.clientX - rect.left, laneAt(e.clientY))
    setHoverPart(hit?.part ?? null)
  }

  // Background drag scrubs; a pointerdown that lands on a handle (per the
  // model's hitTest, not DOM element identity — handles bubble their
  // pointerdown up to this element) begins a pending gesture instead — a
  // click or a drag, decided on pointerup/pointermove by the movement
  // threshold.
  function onPointerDown(e: PointerEvent): void {
    const cur = currentData()
    if (cur && el) {
      const rect = el.getBoundingClientRect()
      const x = e.clientX - rect.left
      const lane = laneAt(e.clientY)
      const hit = hitTest(handles(), geometry(), x, lane)
      if (hit) {
        const handle = resolveHandle(handles(), geometry(), hit, x, lane)
        if (handle) {
          gesture = {
            table: cur.name,
            handle,
            part: hit.part,
            pointerId: e.pointerId,
            startClientX: e.clientX,
            startClientY: e.clientY,
            moved: false,
          }
          el.setPointerCapture(e.pointerId)
          return
        }
      }
    }
    scrubbing = true
    el?.setPointerCapture(e.pointerId)
    props.engine.scrub(elapsedBeatAt(e.clientX))
  }
  function onPointerMove(e: PointerEvent): void {
    if (gesture) {
      const g = gesture
      if (!g.moved) {
        if (!exceedsDragThreshold(e.clientX - g.startClientX, e.clientY - g.startClientY)) return
        g.moved = true
      }
      updateGesturePreview(g, e)
      return
    }
    if (scrubbing) {
      props.engine.scrub(elapsedBeatAt(e.clientX))
      return
    }
    updateHover(e)
  }
  function onPointerUp(): void {
    if (gesture) {
      const g = gesture
      gesture = null
      commitGesture(g)
      return
    }
    endDrag()
  }
  function onPointerCancel(): void {
    if (gesture) { cancelGesture(); return }
    endDrag()
  }
  function endDrag(): void {
    if (!scrubbing) return
    scrubbing = false
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
      classList={{
        'timeline-strip-multilane': laneCount() > 1,
        'timeline-strip-dragging-move': preview()?.part === 'body',
        'timeline-strip-dragging-resize': preview()?.part === 'start' || preview()?.part === 'end',
        'timeline-strip-hover-grab': !preview() && hoverPart() === 'body',
        'timeline-strip-hover-resize': !preview() && (hoverPart() === 'start' || hoverPart() === 'end'),
      }}
      style={{ '--lane-rows': String(visibleLanes()) }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onKeyDown={onKeyDown}
    >
      <Show when={laneCount() > 1}>
        <For each={Array.from({ length: laneCount() })}>
          {(_, i) => (
            <div class="timeline-strip-lane" style={{ top: `${(i() / laneCount()) * 100}%`, height: `${100 / laneCount()}%` }}>
              <span class="timeline-strip-lane-label">pass {i() + 1}</span>
            </div>
          )}
        </For>
      </Show>
      <Show when={laneCount() > MAX_VISIBLE_LANES}>
        <div class="timeline-strip-lane-overflow">{laneCount()} passes</div>
      </Show>
      <For each={coverage()}>
        {(seg) => (
          <div
            class={`timeline-strip-coverage timeline-strip-coverage-${seg.kind ?? 'plain'}`}
            style={{
              left: `${seg.left}px`,
              width: `${seg.width}px`,
              top: `${(seg.lane / laneCount()) * 100}%`,
              height: `${100 / laneCount()}%`,
            }}
          />
        )}
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
                    'timeline-strip-handle-dragging': preview()?.table === cur().name && preview()?.row === h.row,
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
                  <Show when={h.pass}>
                    <span class="timeline-strip-handle-pass">{`pass ${(h.pass ?? 0) + 1}`}</span>
                  </Show>
                  <Show when={preview()?.table === cur().name && preview()?.row === h.row}>
                    <span class="timeline-strip-handle-label">
                      {h.end != null ? `${fmtNum(h.beat)}–${fmtNum(h.end)}` : fmtNum(h.beat)}
                    </span>
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
