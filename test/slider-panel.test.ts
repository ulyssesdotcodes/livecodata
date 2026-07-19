// Tests for the slider overlay controller (src/ui/slider-panel.tsx). The DOM
// half renders view() through <For>, which reconciles by object identity — so
// the controller must preserve a def's object across a setDefs that doesn't
// change it, or <For> tears down and rebuilds the live <input>.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSliderPanel } from '../src/ui/slider-panel.js'
import type { SliderDef } from '../src/sliders.js'

const def = (id: string, over: Partial<SliderDef> = {}): SliderDef =>
  ({ id, min: 0, max: 1, default: 0, step: 0.001, ...over })

const noopCb = { onInput() {}, onGrab() {}, onRelease() {} }

// The mobile-drag regression: setDefs re-runs while a slider is being dragged
// (the drag's store write re-fires the refresh), and <For> keys on object
// identity — so a def left unchanged must keep its object, or its live <input>
// is rebuilt and the touch drag aborts. A genuinely changed def gets a new one.
test('setDefs keeps the object for an unchanged def and only replaces changed ones', () => {
  const ctl = createSliderPanel(noopCb)
  ctl.setDefs([def('height', { min: -3, max: 3 }), def('warp')])
  const before = ctl.view().defs

  ctl.setDefs([def('height', { min: -5, max: 5 }), def('warp')])
  const after = ctl.view().defs
  assert.equal(after[1], before[1], 'the untouched "warp" def keeps its object')
  assert.notEqual(after[0], before[0], 'the retuned "height" def is a new object')
})

test('setDefs adds new ids at their default and drops removed ones', () => {
  const ctl = createSliderPanel(noopCb)
  ctl.setDefs([def('a', { default: 0.4 })])
  ctl.setDefs([def('a', { default: 0.4 }), def('b', { default: 0.7 })])
  assert.deepEqual(ctl.view().values, { a: 0.4, b: 0.7 })

  ctl.setDefs([def('b', { default: 0.7 })])
  assert.deepEqual(ctl.view().values, { b: 0.7 }, 'removed id is dropped')
})
