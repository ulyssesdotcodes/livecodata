// Slider overlay — the humble view over the streaming slider table
// (../sliders.ts). It draws one labelled range control per slider the program
// defines (its "sliders" view), positioned over the visual output. Every
// interaction forwards straight to a callback main.ts wires to the SliderInput;
// no recording logic lives here.
//
// A slider is two-way. While the user is NOT touching it, playback pushes the
// recorded value at the playhead into showValues() each tick and the thumb
// follows the loop. The instant the user grabs it (the first input of a gesture)
// that id is marked dragging: onGrab fires (clearing its old take so it records
// anew), showValues skips it so the ticking playhead can't fight the drag, and
// every move records via onInput. Releasing (pointerup anywhere, change, or
// blur — covering mouse and keyboard) fires onRelease and sync resumes.

import { createSignal, For, Show, type Accessor } from 'solid-js'
import { listenGlobal } from './dom.js'
import type { SliderDef } from '../sliders.js'

export interface SliderPanelCallbacks {
  // A slider moved — record `value` at the current playhead position.
  onInput(id: string, value: number): void
  // The user grabbed a slider (first move of a gesture) — drop its recorded
  // take so the gesture records a fresh one.
  onGrab(id: string): void
  // The user let go — recorded automation drives the thumb again.
  onRelease(id: string): void
}

export interface SliderPanelState {
  defs: SliderDef[]
  values: Record<string, number>
}

export interface SliderPanelController {
  view: Accessor<SliderPanelState>
  // Replace the slider definitions (from the program's "sliders" view). New
  // ids start at their default; values for removed ids are dropped.
  setDefs(defs: SliderDef[]): void
  // Push playback-sampled values (each tick). Ids the user is currently
  // dragging are skipped so the thumb follows the hand, not the recording.
  showValues(values: Record<string, number>): void
  // Forwarded from the component on each interaction (kept here so `dragging`
  // and the value signal stay in one place).
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
        const values: Record<string, number> = {}
        for (const d of defs) values[d.id] = d.id in s.values ? s.values[d.id] : d.default
        return { defs, values }
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
  // A drag can end anywhere on the page (pointer released off the thumb), so the
  // release listens globally — release() is a no-op for ids that weren't dragging.
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
