// Draggable divider between the editor pane and table pane. The table's
// height is kept as a fraction of the shared column so the split stays
// proportional across window resizes; dragging sets it live in pixels, and
// the fraction is recomputed and persisted (see settings.ts) on release.

import { onCleanup, onMount } from 'solid-js'
import { getSidePanelSplit, setSidePanelSplit } from '../settings.js'

const MIN_PANE_PX = 80

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

export function PaneDivider(props: { container: () => HTMLElement | undefined; tablePane: () => HTMLElement | undefined }) {
  let dividerEl: HTMLDivElement | undefined
  let dragging = false

  function applyFraction(fraction: number) {
    const container = props.container()
    const table = props.tablePane()
    if (!container || !table) return
    const total = container.getBoundingClientRect().height
    const px = clamp(fraction * total, MIN_PANE_PX, Math.max(MIN_PANE_PX, total - MIN_PANE_PX))
    table.style.flex = `0 0 ${px}px`
  }

  function onPointerDown(e: PointerEvent) {
    dragging = true
    dividerEl?.setPointerCapture(e.pointerId)
    e.preventDefault()
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragging) return
    const container = props.container()
    const table = props.tablePane()
    if (!container || !table) return
    const rect = container.getBoundingClientRect()
    const newTableHeight = clamp(rect.bottom - e.clientY, MIN_PANE_PX, Math.max(MIN_PANE_PX, rect.height - MIN_PANE_PX))
    table.style.flex = `0 0 ${newTableHeight}px`
  }

  function onPointerUp(e: PointerEvent) {
    if (!dragging) return
    dragging = false
    dividerEl?.releasePointerCapture(e.pointerId)
    const container = props.container()
    const table = props.tablePane()
    if (!container || !table) return
    const total = container.getBoundingClientRect().height
    if (total > 0) setSidePanelSplit(clamp(table.getBoundingClientRect().height / total, 0.1, 0.9))
  }

  onMount(() => {
    applyFraction(getSidePanelSplit())
    const container = props.container()
    if (!container) return
    const ro = new ResizeObserver(() => {
      if (!dragging) applyFraction(getSidePanelSplit())
    })
    ro.observe(container)
    onCleanup(() => ro.disconnect())
  })

  return (
    <div
      id="pane-divider"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize editor and table panes"
      ref={dividerEl}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  )
}
