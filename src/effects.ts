// livecodata effects — post-processing effect events → per-frame effect chain
// ----------------------------------------------------------------------------
// A second channel of the sparse "events" table. Alongside the object events
// (create/update/color/destroy) that rasterize.js bakes into world state, the
// events table can carry post-processing effect events that drive a Three.js
// EffectComposer chain layered on top of the rendered scene.
// ----------------------------------------------------------------------------

import { FPS } from './constants.js'
import type { Row } from './lineage.js'

export const EFFECT_TYPES: Record<string, Record<string, number>> = {
  bloom:      { strength: 1.0, radius: 0.4, threshold: 0.85 },
  afterimage: { damp: 0.92 },
  dotscreen:  { scale: 1.0, angle: 1.57, centerX: 0.5, centerY: 0.5 },
  rgbshift:   { amount: 0.005, angle: 0.0 },
  film:       { intensity: 0.5, grayscale: 0 },
  glitch:     { wild: 0 },
  halftone:   { radius: 4, scatter: 0, shape: 1, blending: 1 },
}

const EFFECT_EVENT_TYPES = new Set(['addEffect', 'updateEffect', 'removeEffect'])

export function isEffectEvent(row: Row | null | undefined): boolean {
  return row != null && EFFECT_EVENT_TYPES.has(row.type as string)
}

export function effectEvents(rows: Row[] | null | undefined): Row[] {
  return (rows ?? []).filter(isEffectEvent)
}

export function buildEffectIndex(effectRows: Row[] | null | undefined): Map<unknown, Row[]> {
  const map = new Map<unknown, Row[]>()
  for (const row of effectRows ?? []) {
    if (!isEffectEvent(row) || row.id == null) continue
    if (!map.has(row.id)) map.set(row.id, [])
    map.get(row.id)!.push({
      ...row,
      index: Math.round(((row.index as number | undefined) ?? 0) * FPS),
      dur: row.dur != null ? (row.dur as number) * FPS : 0,
    })
  }
  for (const evs of map.values()) evs.sort((a, b) => (a.index as number) - (b.index as number))
  return map
}

export interface EffectEntry {
  id: unknown
  effect: string
  input: unknown
  params: Record<string, unknown>
}

function sampleEffect(events: Row[], f: number): EffectEntry | null {
  let active = false
  let addEv: Row | null = null
  let input: unknown = undefined
  for (const e of events) {
    if ((e.index as number) > f) break
    if (e.type === 'addEffect') { active = true; addEv = e; input = e.input ?? null }
    else if (e.type === 'removeEffect') { active = false; addEv = null }
  }
  if (!active || !addEv) return null

  let params: Record<string, unknown> = {
    ...(EFFECT_TYPES[addEv.effect as string] ?? {}),
    ...((addEv.params as Record<string, unknown> | undefined) ?? {}),
  }

  for (const e of events) {
    if ((e.index as number) > f) break
    if (e.type !== 'updateEffect') continue
    if (e.input !== undefined) input = e.input
    const target = (e.params as Record<string, unknown> | undefined) ?? {}
    const dur = e.dur as number
    if (dur > 0 && f < (e.index as number) + dur) {
      const p = (f - (e.index as number)) / dur
      const easeFn = e.ease as ((t: number) => number) | undefined
      const t = typeof easeFn === 'function' ? easeFn(p) : p
      const next: Record<string, unknown> = { ...params }
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

  return { id: addEv.id, effect: addEv.effect as string, input: input ?? null, params }
}

function orderChain(effects: EffectEntry[]): EffectEntry[] {
  const byId = new Map(effects.map((e) => [e.id, e]))
  const placed: EffectEntry[] = []
  const placedIds = new Set<unknown>()
  let remaining = effects.slice()
  let progress = true
  while (remaining.length && progress) {
    progress = false
    const next: EffectEntry[] = []
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

export function effectChainAtFrame(index: Map<unknown, Row[]>, f: number): EffectEntry[] {
  const frame = Math.floor(f)
  if (frame < 0) return []
  const effects: EffectEntry[] = []
  for (const events of index.values()) {
    const s = sampleEffect(events, frame)
    if (s) effects.push(s)
  }
  return orderChain(effects)
}
