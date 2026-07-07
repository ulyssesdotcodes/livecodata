// livecodata hydra — table-driven video synth (hydra-ts, a port of ojack's hydra)
// ----------------------------------------------------------------------------
// Replaces the Three.js post-processing chain with hydra. Instead of a chain of
// effect passes, the visuals are post-processed by a *hydra sketch* — and that
// sketch lives in a table, exactly like every other thing in livecodata.
//
// The "hydra" view is a table of sketch keyframe rows, placed on the loop by a
// 1-indexed `beat` column — beat 1 is the top of the loop, beat b sits (b − 1)
// beats in. So in a 16-beat loop a row at beat 9 comes in at the start of the
// third measure (halfway through). Each row may carry:
//   - code : a hydra sketch string, e.g. "src(s0).modulate(noise(2)).out()"
//            (s0 is the rendered Three.js scene; o0 is the output).
//   - any other column : a *variable* in scope while the sketch runs (freq,
//            amount, …). These are the "variables which are used by the sketch".
//            Reference one as a function, e.g. `osc((props) => props.freq)` —
//            hydra-ts calls it fresh every frame, so its value can change
//            without recompiling the sketch (see hydra-scene.ts). Avoid naming
//            a variable after one of hydra's own per-frame fields (time, bpm,
//            fps, resolution, speed, stats) — those always win over an
//            injected value of the same name (see hydra-scene.ts's `props`).
//
// Sampling at a frame yields the most-recent code plus the most-recent value of
// each variable seen at/before that frame, so both the sketch and the values
// driving it are plain table data the user can inspect and wire up from the rest
// of the dataflow (physics, beats, math, …). This module is pure (no hydra-ts /
// DOM dependency); the actual GPU rendering lives in hydra-scene.ts.
// ----------------------------------------------------------------------------

import { beatToFrame } from './constants.js'
import type { Row } from './lineage.js'

// Columns that steer sampling rather than feed the sketch as variables. `index`
// is the frame position buildHydraIndex writes (see below) — internal, never a
// sketch variable.
const CONTROL_FIELDS = new Set(['beat', 'index', 'code', 'dur', 'ease'])

export interface HydraFrame {
  // The sketch source to evaluate (ends in .out()).
  code: string
  // Variable name → value, injected into the sketch's scope.
  vars: Record<string, unknown>
}

function variableKeys(row: Row): string[] {
  return Object.keys(row).filter((k) => !CONTROL_FIELDS.has(k))
}

// A hydra row is one that contributes a sketch (`code`) or at least one variable.
export function isHydraRow(row: Row | null | undefined): boolean {
  return row != null && (typeof row.code === 'string' || variableKeys(row).length > 0)
}

export function hydraRows(rows: Row[] | null | undefined): Row[] {
  return (rows ?? []).filter(isHydraRow)
}

// Place each row on the frame grid (from its 1-indexed `beat`; rows without one
// sit at beat 1 / frame 0) and sort ascending, so sampling is a frame comparison
// (mirrors rasterize/effects). The computed frame is stored on `index`, the
// field hydraFrameAt samples against.
export function buildHydraIndex(rows: Row[] | null | undefined): Row[] {
  return hydraRows(rows)
    .map((row) => ({ ...row, index: beatToFrame((row.beat as number | undefined) ?? 1) }))
    .sort((a, b) => (a.index as number) - (b.index as number))
}

// The active sketch at frame `f`: the latest `code` at/before f, plus the latest
// value of each variable at/before f (later rows override earlier ones, so a row
// can change just a variable while the sketch stays put). Returns null until a
// code row is reached — playback then falls back to showing the raw scene.
export function hydraFrameAt(index: Row[], f: number): HydraFrame | null {
  const frame = Math.floor(f)
  if (frame < 0) return null
  let code: string | null = null
  const vars: Record<string, unknown> = {}
  for (const row of index) {
    if ((row.index as number) > frame) break
    if (typeof row.code === 'string') code = row.code
    for (const k of variableKeys(row)) vars[k] = row[k]
  }
  return code == null ? null : { code, vars }
}
