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
//
// The strip never scrubs: a background pointerdown (missing every handle) is
// inert. Playback's wall-aligned phase (see wallAlignedPhase in playback.ts)
// makes a scrub position non-sticky anyway, and scrubbing only fought handle
// dragging for the same gesture space. The playhead/elapsed tint stay as a
// pure display of playback, driven by `vs` alone.
//
// Hovering a handle shows the same floating readout a drag does (the resting
// store values) and highlights the row in the table panel — one channel
// (onStripRowChange) carries "the row the strip is pointing at" for both.

import { createSignal, createMemo, onMount, onCleanup, For, Show, type Accessor } from 'solid-js'
import {
  beatToX, xToBeat, gridLines, handlesFor, hitTest, pendingTimelineRows,
  resolveHandle, dragModeFor, snapDelta, dragUpdate, withPreview,
  valuesDiffer, exceedsDragThreshold, laneCountFor, coverageBands, meaningfulSummary,
  type StripGeometry, type Handle, type HitPart, type DragOptions, type SnapMode,
} from '../timeline-strip.js'
import { buildTimeline } from '../timeline.js'
import { formatEditableCell } from '../table-panel.js'
import { listenGlobal } from './dom.js'
import type { PlaybackViewState } from '../playback.js'
import type { Row } from '../lineage.js'
import type { EditableTableStore, EditableColumn } from '../editable-tables.js'
import type { PeerPresence } from '../table-panel.js'

// The strip's height grows per lane band up to this many — a timeline with
// more passes than this still gets all its lanes (hit-testing and rendering
// both use the real count), just thinner ones, plus an overflow badge.
const MAX_VISIBLE_LANES = 4

// Accent color for the strip's focused-handle ring — matches the playhead
// (#e94560), the strip's one other "this is the important one" signal.
const FOCUS_RING = '0 0 0 2px #e94560'

// Horizontal margin the floating drag readout keeps from the strip's own
// edges (it isn't measured, so this is a fixed safety margin rather than a
// true width-aware clamp).
const READOUT_MARGIN = 8

export function TimelineStrip(props: {
  vs: Accessor<PlaybackViewState>
  timelineRows: Accessor<Row[]>
  store: EditableTableStore
  currentTable: Accessor<string | null>
  onSelectRow?: (table: string, row: number | null) => void
  presence: Accessor<PeerPresence[]>
  focusedRow: Accessor<number | null>
  // The row the strip is pointing at — fired with the row when a hover lands
  // on a handle or a gesture crosses the drag threshold, and with null when
  // the pointer leaves / the gesture ends (drop, cancel, Escape) — so the
  // table panel can give that row a row-level highlight for exactly as long
  // as the strip is interacting with it (see .row-strip-active in style.css).
  onStripRowChange?: (row: { table: string; row: number } | null) => void
  // Fired right after a drag's one store.setRow actually lands — never for a
  // no-op release or a sub-threshold click. main.ts wires this to the same
  // "re-evaluate at the current seed" call onEditCell's commit uses, so a
  // drop applies immediately instead of sitting pending.
  onDragCommit?: () => void
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
  const [preview, setPreview] = createSignal<{ table: string; row: number; part: HitPart; values: Record<string, unknown>; ghost: boolean } | null>(null)

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

  // The floating readout's lines, stacked: the row's meaningful columns —
  // what it IS (event kind, a code cell's first line, names/values) — never
  // its position, which the strip shows visually and the handle's own
  // unlabeled tag states precisely. Handle-state annotations ride at the end.
  function readoutLines(row: Row, columns: EditableColumn[], h: Handle): string[] {
    const lines = meaningfulSummary(row, columns)
    if (h.disabled) lines.push('disabled')
    if (h.ghost) lines.push('ghost placement')
    if (h.pass) lines.push(`pass ${h.pass + 1}`)
    return lines
  }

  // The hovered, dragged, or selected placement — the one handle the readout
  // and the unlabeled position tag describe. A live gesture (preview/hover)
  // wins over the resting selection, so the readout tracks the pointer but
  // falls back to the selected row when idle — that selection is the shared
  // `focusedRow` (set by a handle click here *or* a table-panel row click), so
  // selecting a row either way pins its info here. `ghost` picks the same
  // placement out of handles() a multi-placement row re-derives on every move —
  // the row's primary handle otherwise, which covers the overwhelmingly common
  // case of a row with no loop-event ghosts.
  const activeHandle = createMemo<Handle | null>(() => {
    const cur = currentData()
    if (!cur) return null
    const p = preview()
    const fr = props.focusedRow()
    const target = p && cur.name === p.table ? p
      : hover() ?? (fr != null ? { row: fr, ghost: false } : null)
    if (!target) return null
    const hs = handles()
    return hs.find((hh) => hh.row === target.row && hh.ghost === target.ghost) ?? hs.find((hh) => hh.row === target.row) ?? null
  })

  // Floating readout position and lines — live for exactly as long as a
  // handle is hovered or dragged, and hidden entirely for a row with nothing
  // meaningful beyond its position (the tag on the handle covers that).
  const readout = createMemo<{ left: number; lines: string[] } | null>(() => {
    const cur = currentData()
    const h = activeHandle()
    const row = h ? cur?.rows[h.row] : undefined
    if (!cur || !h || !row) return null
    const lines = readoutLines(row, cur.columns, h)
    if (!lines.length) return null
    const geo = geometry()
    const x = beatToX(geo, h.beat)
    const left = Math.max(READOUT_MARGIN, Math.min(geo.width - READOUT_MARGIN, x))
    return { left, lines }
  })

  // The unlabeled position tag on the active handle itself: `beat` or
  // `beat–end` — over the strip, where position is already the visual story,
  // so no labels. Post-preview, so the numbers track a drag live.
  function posTag(h: Handle): string {
    const num = (v: number): string => formatEditableCell('number', v)
    return h.end != null ? `${num(h.beat)}–${num(h.end)}` : num(h.beat)
  }
  const isActiveHandle = (h: Handle): boolean => {
    const a = activeHandle()
    return !!a && a.row === h.row && a.ghost === h.ghost
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

  // Idle hover (no gesture in progress): the handle under the pointer — the
  // cursor affordance, the floating readout, and the panel's row highlight
  // all read it. `row`/`ghost` mirror the preview's shape so the readout memo
  // treats a hover and a drag through the same lookup.
  const [hover, setHover] = createSignal<{ row: number; ghost: boolean; part: HitPart } | null>(null)
  // Last row reported to onStripRowChange — hover fires per pointermove, so
  // dedupe to actual row changes rather than spamming the panel every frame.
  let reportedRow: string | null = null
  function reportStripRow(next: { table: string; row: number } | null): void {
    const key = next ? `${next.table}::${next.row}` : null
    if (key === reportedRow) return
    reportedRow = key
    props.onStripRowChange?.(next)
  }

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
    setPreview({ table: g.table, row: g.handle.row, part: g.part, values, ghost: g.handle.ghost })
  }

  // One store.setRow for the whole gesture (a no-op if the drag snapped back
  // to where it started, or if it never crossed the threshold), then focus
  // the row exactly like a plain click. onDragCommit fires only when the
  // store actually changed — never for a no-op release or a plain click —
  // so main.ts's auto-apply runs exactly once per gesture that moved data.
  function commitGesture(g: Gesture): void {
    if (g.moved) {
      const p = preview()
      const cur = currentData()
      if (p && cur && cur.name === p.table) {
        const row = cur.rows[p.row]
        if (row && valuesDiffer(row, p.values)) {
          props.store.setRow(p.table, p.row, p.values)
          props.onDragCommit?.()
        }
      }
    }
    props.onSelectRow?.(g.table, g.handle.row)
    reportStripRow(null)
    setPreview(null)
    // The pointer may have been dragged (or released) off the strip — a stale
    // hover would pin the readout there; the next pointermove re-derives it.
    setHover(null)
  }

  function cancelGesture(): void {
    if (!gesture) return
    el?.releasePointerCapture(gesture.pointerId)
    gesture = null
    setPreview(null)
    setHover(null)
    reportStripRow(null)
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
    if (!cur || !el) { clearHover(); return }
    const rect = el.getBoundingClientRect()
    const x = e.clientX - rect.left
    const lane = laneAt(e.clientY)
    const hit = hitTest(handles(), geometry(), x, lane)
    const handle = hit ? resolveHandle(handles(), geometry(), hit, x, lane) : null
    if (!hit || !handle) { clearHover(); return }
    setHover({ row: handle.row, ghost: handle.ghost, part: hit.part })
    reportStripRow({ table: cur.name, row: handle.row })
  }

  function clearHover(): void {
    setHover(null)
    reportStripRow(null)
  }

  // A pointerdown that lands on a handle (per the model's hitTest, not DOM
  // element identity — handles bubble their pointerdown up to this element)
  // begins a pending gesture — a click or a drag, decided on pointerup/
  // pointermove by the movement threshold. A background miss is inert (see
  // the file-header note on why the strip doesn't scrub).
  function onPointerDown(e: PointerEvent): void {
    const cur = currentData()
    if (!cur || !el) return
    const rect = el.getBoundingClientRect()
    const x = e.clientX - rect.left
    const lane = laneAt(e.clientY)
    const hit = hitTest(handles(), geometry(), x, lane)
    // A background press (missing every handle) deselects — clearing the shared
    // row selection hides the pinned info readout (and the row's highlight).
    if (!hit) { props.onSelectRow?.(cur.name, null); return }
    const handle = resolveHandle(handles(), geometry(), hit, x, lane)
    if (!handle) return
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
  }
  function onPointerMove(e: PointerEvent): void {
    if (!gesture) { updateHover(e); return }
    const g = gesture
    if (!g.moved) {
      if (!exceedsDragThreshold(e.clientX - g.startClientX, e.clientY - g.startClientY)) return
      g.moved = true
      // The moment it's a real drag (not just yet a click) — focus and
      // row-highlight the dragged row live, not only once the pointer lifts.
      props.onSelectRow?.(g.table, g.handle.row)
      reportStripRow({ table: g.table, row: g.handle.row })
    }
    updateGesturePreview(g, e)
  }
  function onPointerUp(): void {
    if (!gesture) return
    const g = gesture
    gesture = null
    commitGesture(g)
  }
  function onPointerCancel(): void {
    if (gesture) cancelGesture()
  }
  function onPointerLeave(): void {
    // Not during a gesture: pointer capture routes moves here even outside
    // the strip, and the gesture's own exit paths clear the row highlight.
    if (!gesture) clearHover()
  }

  return (
    // The readout floats above `.timeline-strip`'s own overflow:hidden (which
    // clips the handles layer's long labels horizontally — see the pass
    // badge's comment below), so it renders as a sibling in a plain
    // (overflow: visible) wrapper instead of inside the strip itself.
    <div class="timeline-strip-wrap">
      <Show when={readout()}>
        {(r) => (
          <div class="timeline-strip-readout" style={{ left: `${r().left}px` }}>
            <For each={r().lines}>{(line) => <div class="timeline-strip-readout-line">{line}</div>}</For>
          </div>
        )}
      </Show>
      <div
        class="timeline-strip"
        ref={el}
        classList={{
          'timeline-strip-multilane': laneCount() > 1,
          'timeline-strip-dragging-move': preview()?.part === 'body',
          'timeline-strip-dragging-resize': preview()?.part === 'start' || preview()?.part === 'end',
          'timeline-strip-hover-grab': !preview() && hover()?.part === 'body',
          'timeline-strip-hover-resize': !preview() && (hover()?.part === 'start' || hover()?.part === 'end'),
        }}
        style={{ '--lane-rows': String(visibleLanes()) }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onPointerLeave={onPointerLeave}
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
                  <Show when={isActiveHandle(h)}>
                    <span class="timeline-strip-handle-postag">{posTag(h)}</span>
                  </Show>
                </div>
              )}
            </For>
          </div>
        )}
      </Show>
      <div class="timeline-strip-playhead" style={{ left: `${playheadX()}px` }} />
      </div>
    </div>
  )
}
