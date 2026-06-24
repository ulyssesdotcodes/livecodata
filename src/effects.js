// livecodata effects — post-processing effect events → per-frame effect chain
// ----------------------------------------------------------------------------
// A second channel of the sparse "events" table. Alongside the object events
// (create/update/color/destroy) that rasterize.js bakes into world state, the
// events table can carry post-processing effect events that drive a Three.js
// EffectComposer chain layered on top of the rendered scene.
//
// Effect event rows (sparse), keyed by effect instance `id`:
//   add     — { id, type:"addEffect",    effect, index, input?, params? }
//   update  — { id, type:"updateEffect", index, params, dur?, ease?, input? }
//   remove  — { id, type:"removeEffect", index }
//
//   id      — effect instance id (unique per effect in the chain)
//   effect  — effect type: "bloom", "afterimage", "dotscreen", … (EFFECT_TYPES)
//   input   — id of the effect this one reads from, or null/omitted to read the
//             base render output. Wires the linear composer chain.
//   params  — effect parameters (see EFFECT_TYPES for the tunable fields)
//   index   — time (seconds) the event fires
//   dur/ease— optional: an updateEffect with a dur eases its numeric params from
//             their current values to the target over `dur` seconds (`ease`
//             shapes the curve), so effect parameters animate like color pulses.
//
// This module is pure data — no Three.js. three-scene.js consumes the resolved
// chain and materializes/updates the actual composer passes; playback.js asks
// for the chain at the current frame each tick.
// ----------------------------------------------------------------------------

import { FPS } from './constants.js' // converts seconds ↔ frame indices

// The known effect types and their tunable parameters' defaults. A param left
// unset on an event falls back to these, and only numeric params here are
// eased during an updateEffect transition. Mirrors the Three.js passes wired up
// in three-scene.js (keys map straight onto pass uniforms / properties there).
export const EFFECT_TYPES = {
  bloom:      { strength: 1.0, radius: 0.4, threshold: 0.85 },
  afterimage: { damp: 0.92 },
  dotscreen:  { scale: 1.0, angle: 1.57, centerX: 0.5, centerY: 0.5 },
  rgbshift:   { amount: 0.005, angle: 0.0 },
  film:       { intensity: 0.5, grayscale: 0 },
  glitch:     { wild: 0 },
  halftone:   { radius: 4, scatter: 0, shape: 1, blending: 1 },
}

const EFFECT_EVENT_TYPES = new Set(['addEffect', 'updateEffect', 'removeEffect'])

// Is this events-table row a post-processing effect event (vs. an object event)?
export function isEffectEvent(row) {
  return row != null && EFFECT_EVENT_TYPES.has(row.type)
}

// Pull the effect events out of a mixed events table (object + effect rows).
export function effectEvents(rows) {
  return (rows ?? []).filter(isEffectEvent)
}

// Group effect events by instance id, convert their second-based timing to
// integer frames, and sort each id's events by time. The per-frame resolver
// (effectChainAtFrame) reads this index. Mirrors rasterize.buildTimelines.
export function buildEffectIndex(effectRows) {
  const map = new Map()
  for (const row of effectRows ?? []) {
    if (!isEffectEvent(row) || row.id == null) continue
    if (!map.has(row.id)) map.set(row.id, [])
    map.get(row.id).push({
      ...row,
      index: Math.round((row.index ?? 0) * FPS),
      dur: row.dur != null ? row.dur * FPS : 0,
    })
  }
  for (const evs of map.values()) evs.sort((a, b) => a.index - b.index)
  return map
}

// Resolve one effect's state at frame `f`, or null if it isn't active then.
// Active = the latest add/remove event at/before f is an add. Params start from
// the add's params (over the type defaults) and fold forward through each
// updateEffect; an update with a dur eases its numeric params from their
// current values toward the target while the transition is in flight.
function sampleEffect(events, f) {
  let active = false
  let addEv = null
  let input
  for (const e of events) {
    if (e.index > f) break
    if (e.type === 'addEffect') { active = true; addEv = e; input = e.input ?? null }
    else if (e.type === 'removeEffect') { active = false; addEv = null }
  }
  if (!active || !addEv) return null

  let params = { ...(EFFECT_TYPES[addEv.effect] ?? {}), ...(addEv.params ?? {}) }

  for (const e of events) {
    if (e.index > f) break
    if (e.type !== 'updateEffect') continue
    if (e.input !== undefined) input = e.input
    const target = e.params ?? {}
    if (e.dur > 0 && f < e.index + e.dur) {
      // Transition in progress: ease each targeted numeric param from its
      // current value toward the target; non-numeric params snap at the end.
      const p = (f - e.index) / e.dur
      const t = typeof e.ease === 'function' ? e.ease(p) : p
      const next = { ...params }
      for (const k of Object.keys(target)) {
        const from = params[k], to = target[k]
        next[k] = (typeof from === 'number' && typeof to === 'number')
          ? from + (to - from) * t
          : (t >= 1 ? to : from)
      }
      params = next
    } else {
      params = { ...params, ...target }
    }
  }

  return { id: addEv.id, effect: addEv.effect, input: input ?? null, params }
}

// Order an unordered set of active effects into a linear composer chain by
// following their `input` wiring: effects reading the base render (input null /
// dangling) come first, then each effect after the one it reads from. A stable
// topological pass; any remaining cycle is appended in discovery order.
function orderChain(effects) {
  const byId = new Map(effects.map((e) => [e.id, e]))
  const placed = []
  const placedIds = new Set()
  let remaining = effects.slice()
  let progress = true
  while (remaining.length && progress) {
    progress = false
    const next = []
    for (const e of remaining) {
      const ready = e.input == null || !byId.has(e.input) || placedIds.has(e.input)
      if (ready) { placed.push(e); placedIds.add(e.id); progress = true }
      else next.push(e)
    }
    remaining = next
  }
  placed.push(...remaining)
  return placed
}

// The ordered effect chain active at frame `f` (fractional frames floor). Each
// entry is { id, effect, input, params } with params fully resolved. An empty
// chain means render the scene with no post-processing.
export function effectChainAtFrame(index, f) {
  const frame = Math.floor(f)
  if (frame < 0) return []
  const effects = []
  for (const events of index.values()) {
    const s = sampleEffect(events, frame)
    if (s) effects.push(s)
  }
  return orderChain(effects)
}
