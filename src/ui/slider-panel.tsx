// Slider overlay: one labelled range control per slider the program defines,
// drawn over the visual output. A slider is two-way — while untouched,
// playback pushes the recorded value at the playhead into showValues() and
// the thumb follows the loop; grabbing one marks its id dragging (onGrab
// clears its old take, showValues skips it so the playhead can't fight the
// drag) and each move records via onInput, until release.

import { createSignal, For, Show, type Accessor } from 'solid-js'
import { listenGlobal } from './dom.js'
import { sameSliderDef, type SliderDef } from '../sliders.js'

export interface SliderPanelCallbacks {
  onInput(id: string, value: number): void
  onGrab(id: string): void
  onRelease(id: string): void
}

export interface SliderPanelState {
  defs: SliderDef[]
  values: Record<string, number>
}

export interface SliderPanelController {
  view: Accessor<SliderPanelState>
  // New ids start at their default; values for removed ids are dropped.
  setDefs(defs: SliderDef[]): void
  // Ids being dragged are skipped so the thumb follows the hand, not the
  // recording.
  showValues(values: Record<string, number>): void
  input(id: string, value: number): void
  release(id: string): void
}

export function createSliderPanel(cb: SliderPanelCallbacks): SliderPanelController {
  const [view, setView] = createSignal<SliderPanelState>({ defs: [], values: {} })
  const dragging = new Set<string>()

  const setValue = (id: string, value: number): void => {
    setView((s) => ({ defs: s.defs, values: { ...s.values, [id]: value } }))
  }

  return {
    view,
    setDefs(defs: SliderDef[]): void {
      setView((s) => {
        // Reuse the prior def object for any slider whose definition is
        // unchanged so <For> keeps its <input> node. updateSliderDefs re-runs
        // on every store change — including the record a drag itself emits —
        // and rebuilds fresh SliderDef objects each time; swapping the node
        // out from under a live touch drag aborts it on mobile.
        const prev = new Map(s.defs.map((d) => [d.id, d]))
        const next = defs.map((d) => {
          const old = prev.get(d.id)
          return old && sameSliderDef(old, d) ? old : d
        })
        const unchanged = next.length === s.defs.length && next.every((d, i) => d === s.defs[i])
        if (unchanged) return s
        const values: Record<string, number> = {}
        for (const d of next) values[d.id] = d.id in s.values ? s.values[d.id] : d.default
        return { defs: next, values }
      })
    },
    showValues(values: Record<string, number>): void {
      setView((s) => {
        const next = { ...s.values }
        for (const id in values) if (!dragging.has(id)) next[id] = values[id]
        return { defs: s.defs, values: next }
      })
    },
    input(id: string, value: number): void {
      if (!dragging.has(id)) {
        dragging.add(id)
        cb.onGrab(id)
      }
      setValue(id, value)
      cb.onInput(id, value)
    },
    release(id: string): void {
      if (!dragging.delete(id)) return
      cb.onRelease(id)
    },
  }
}

export function SliderPanel(props: { ctl: SliderPanelController }) {
  const view = props.ctl.view
  // A drag can end anywhere on the page, so the release listens globally;
  // release() is a no-op for ids that weren't dragging.
  listenGlobal(window, 'pointerup', () => { for (const d of view().defs) props.ctl.release(d.id) })

  const valueOf = (d: SliderDef): number => {
    const v = view().values[d.id]
    return v === undefined ? d.default : v
  }
  const fmt = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(2))

  return (
    <Show when={view().defs.length > 0}>
      <div id="slider-panel">
        <For each={view().defs}>
          {(d) => (
            <label class="slider-row">
              <span class="slider-id">{d.id}</span>
              <input
                type="range"
                class="slider-input"
                min={String(d.min)}
                max={String(d.max)}
                step={String(d.step)}
                value={String(valueOf(d))}
                onInput={(e) => props.ctl.input(d.id, parseFloat(e.currentTarget.value))}
                onChange={() => props.ctl.release(d.id)}
                onBlur={() => props.ctl.release(d.id)}
              />
              <span class="slider-value">{fmt(valueOf(d))}</span>
            </label>
          )}
        </For>
      </div>
    </Show>
  )
}
