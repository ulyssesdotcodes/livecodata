// The timeline strip — the humble Solid view over ../timeline-strip.ts (the
// pure geometry/grid model) and ../timeline.ts (coverage shading). Replaces
// the transport's `#scrub-bar` range input.
//
// Phase 2 (this file): beat grid, timeline coverage shading, playhead +
// elapsed tint, and scrub parity with the old range input (pointer drag,
// keyboard nudge). The handles layer for the open table's rows (drag-to-edit)
// lands in a later phase — see notes/timeline-strip-plan.md — so the layer
// stack below is ordered to leave room for it between coverage and playhead
// without disturbing this phase's rendering.

import { createSignal, createMemo, onMount, onCleanup, For, type Accessor } from 'solid-js'
import { beatToX, xToBeat, gridLines, type StripGeometry } from '../timeline-strip.js'
import { timelineSegments } from '../timeline.js'
import type { PlaybackEngine, PlaybackViewState } from '../playback.js'
import type { Row } from '../lineage.js'

// One minor grid tick (a beat) per ArrowLeft/ArrowRight, matching the grid's
// own step so keyboard nudges land exactly on a tick.
const KEY_NUDGE_BEATS = 1

export function TimelineStrip(props: {
  vs: Accessor<PlaybackViewState>
  engine: PlaybackEngine
  timelineRows: Accessor<Row[]>
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

  // Client-x → elapsed beats (0-based, matching PlaybackViewState.scrubPos),
  // clamped to the strip's range — the inverse of playheadX above.
  function elapsedBeatAt(clientX: number): number {
    const rect = el!.getBoundingClientRect()
    const geo = geometry()
    const beat = xToBeat(geo, clientX - rect.left)
    return Math.max(0, Math.min(geo.maxBeats, beat - 1))
  }

  // Background drag scrubs (there's no handles layer yet to hit-test against
  // in this phase) — pointer capture so the drag tracks outside the strip's
  // bounds; playback-controls.tsx's global pointerup is the fallback if
  // capture is ever lost (e.g. a cancelled touch).
  let dragging = false
  function onPointerDown(e: PointerEvent): void {
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
      <div class="timeline-strip-playhead" style={{ left: `${playheadX()}px` }} />
    </div>
  )
}
