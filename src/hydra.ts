// livecodata hydra — table-driven video synth (hydra-ts, a port of ojack's hydra)
// ----------------------------------------------------------------------------
// Replaces the Three.js post-processing chain with hydra. Instead of a chain of
// effect passes, the visuals are post-processed by a *hydra sketch* — and that
// sketch lives in a table, exactly like every other thing in livecodata.
//
// The "hydra" view is a table of *events*, placed on the loop by a 1-indexed
// `beat` column — beat 1 is the top of the loop, beat b sits (b − 1) beats in.
// So in a 16-beat loop a row at beat 9 comes in at the start of the third
// measure (halfway through). Each row's `event` says what it does. Two kinds
// carry the sketch and its inputs:
//   - "setCode"     : `code` becomes the hydra sketch string, e.g.
//                      "src(s0).modulate(noise(2)).out()" (s0 is the rendered
//                      Three.js scene; o0 is the output).
//   - "setVariable" : `name`/`value` sets one variable in scope while the
//                      sketch runs (freq, amount, …). Reference one as a
//                      function, e.g. `osc((props) => props.freq)` — hydra-ts
//                      calls it fresh every frame, so its value can change
//                      without recompiling the sketch (see hydra-scene.ts).
//                      Avoid naming a variable after one of hydra's own
//                      per-frame fields (time, bpm, fps, resolution, speed,
//                      stats) — those always win over an injected value of the
//                      same name (see hydra-scene.ts's `props`).
//
// The rest are *meta-programming* events: instead of replacing the sketch, they
// TRANSFORM the code accumulated so far, so the table can edit its own program
// as the loop plays. Each is a no-op until a setCode has established some code
// to transform:
//   - "replace"     : rewrites the current code, swapping every occurrence of
//                      the literal string `find` for `value` (a plain
//                      substring replace — no regex). Retarget a source, retune
//                      a constant, or swap one generator for another without
//                      restating the whole sketch.
//   - "append"      : appends `code` — a chain fragment starting with a dot,
//                      e.g. ".modulate(noise(3), 0.2)" — to the end of the
//                      current chain, just before its `.out()`. Grows the
//                      effect chain one link at a time.
//   - "layer"       : blends `code` (another full sketch) over the current one
//                      by a lerp amount `value`: the frame becomes
//                      current.blend(row, value). `value` is a constant, or a
//                      string expression evaluated fresh every frame with
//                      `props` in scope (e.g. "props.mix" or
//                      "Math.sin(props.time)"), so the mix can be driven live
//                      from a setVariable, a slider, or hydra's own time.
//
// Sampling at a frame folds every event seen at/before it in order: setCode/
// replace/append/layer evolve one running code string, and setVariable folds
// into the most-recent value of each named variable. So both the sketch and the
// values driving it are plain table data the user can inspect and wire up from
// the rest of the dataflow (physics, beats, math, …). Because a new variable is
// just rows carrying a new `name`, not a new table column, adding one doesn't
// require widening the schema — see editable-tables.ts's `ensure()` for why
// that matters. This module is pure (no hydra-ts / DOM dependency); the actual
// GPU rendering lives in hydra-scene.ts.
// ----------------------------------------------------------------------------

import { beatToFrame } from './constants.js'
import type { Row } from './lineage.js'

export interface HydraFrame {
  // The sketch source to evaluate (ends in .out()).
  code: string
  // Variable name → value, injected into the sketch's scope.
  vars: Record<string, unknown>
}

// The event kinds a hydra table understands: the two sketch/value events plus
// the meta-programming transforms that rewrite the accumulated code.
const HYDRA_EVENTS = new Set(['setCode', 'setVariable', 'replace', 'append', 'layer'])

// A hydra row is any of those events.
export function isHydraRow(row: Row | null | undefined): boolean {
  return row != null && typeof row.event === 'string' && HYDRA_EVENTS.has(row.event)
}

export function hydraRows(rows: Row[] | null | undefined): Row[] {
  return (rows ?? []).filter(isHydraRow)
}

// Place each row on the frame grid (from its 1-indexed `beat`; rows without one
// sit at beat 1 / frame 0) and sort ascending, so sampling is a frame comparison
// (mirrors rasterize/effects). The computed frame is stored on `index`, the
// field hydraFrameAt samples against. An optional 0-indexed `loop` column next
// to `beat` places a row in a later pass of the loop (multi-loop sequences):
// rows sort by (loop, frame), so the sketch evolves across passes and sampling
// folds every earlier pass in full.
export function buildHydraIndex(rows: Row[] | null | undefined): Row[] {
  return hydraRows(rows)
    .map((row) => ({
      ...row,
      index: beatToFrame((row.beat as number | undefined) ?? 1),
      loop: typeof row.loop === 'number' ? Math.max(0, Math.floor(row.loop)) : 0,
    }))
    .sort((a, b) => ((a.loop as number) - (b.loop as number)) || ((a.index as number) - (b.index as number)))
}

// How many passes of the loop the sketch spans — the largest `loop` + 1.
export function hydraLoops(index: Row[]): number {
  return index.reduce((m, r) => Math.max(m, (r.loop as number | undefined) ?? 0), 0) + 1
}

// Strip a trailing `.out(...)` (with any target, whitespace, or semicolon) off
// a sketch, leaving the bare source/effect chain — the form the meta-programming
// events extend or compose before re-terminating with `.out(o0)`. If the code
// has no trailing `.out()` (already a chain), it's returned unchanged.
const OUT_TAIL = /\.out\s*\([^)]*\)\s*;?\s*$/
function chainOf(code: string): string {
  return code.replace(OUT_TAIL, '')
}

// Render a lerp amount for a `layer` blend. A finite number (or a numeric
// string) becomes a literal; any other non-empty string is an expression
// evaluated per frame with `props` in scope — used verbatim if it's already a
// function (contains `=>`), else wrapped into `(props) => (…)`. Empty/invalid
// falls back to an even 0.5 mix.
function amountExpr(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  const s = typeof value === 'string' ? value.trim() : ''
  if (s === '') return '0.5'
  const n = Number(s)
  if (!Number.isNaN(n)) return String(n)
  return s.includes('=>') ? `(${s})` : `(props) => (${s})`
}

// The active sketch at frame `f` of loop pass `loop`: every event from earlier
// passes in full, plus this pass's events at/before f, folded in order onto one
// running code string. setCode replaces it; replace/append/layer transform it;
// setVariable folds into the most-recent value of each named variable (later
// events override earlier ones, so a row can change just one variable while the
// sketch stays put). Returns null until a setCode event is reached — playback
// then falls back to showing the raw scene. The meta events are no-ops while
// `code` is still null (nothing to transform yet).
export function hydraFrameAt(index: Row[], f: number, loop = 0): HydraFrame | null {
  const frame = Math.floor(f)
  if (frame < 0) return null
  let code: string | null = null
  const vars: Record<string, unknown> = {}
  for (const row of index) {
    const l = (row.loop as number | undefined) ?? 0
    if (l > loop || (l === loop && (row.index as number) > frame)) break
    switch (row.event) {
      case 'setCode':
        if (typeof row.code === 'string') code = row.code
        break
      case 'setVariable':
        if (typeof row.name === 'string') vars[row.name] = row.value
        break
      case 'replace':
        // Literal substring swap over the whole current sketch.
        if (code != null && typeof row.find === 'string' && row.find !== '') {
          code = code.split(row.find).join(row.value == null ? '' : String(row.value))
        }
        break
      case 'append':
        // Extend the chain with a `.method(...)` fragment, before its `.out()`.
        if (code != null && typeof row.code === 'string' && row.code.trim() !== '') {
          code = `${chainOf(code)}${row.code.trim()}.out(o0)`
        }
        break
      case 'layer':
        // Blend another sketch over the current one by a (possibly live) lerp.
        if (code != null && typeof row.code === 'string' && row.code.trim() !== '') {
          code = `${chainOf(code)}.blend(${chainOf(row.code.trim())}, ${amountExpr(row.value)}).out(o0)`
        }
        break
    }
  }
  return code == null ? null : { code, vars }
}
