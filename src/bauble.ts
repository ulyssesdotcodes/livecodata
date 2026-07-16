// livecodata bauble — table-driven 3D SDF sketches (bauble, ianthehenry's
// signed-distance-function playground: Janet code compiled to a GLSL raymarcher)
// ----------------------------------------------------------------------------
// A second sketch visualizer next to hydra: where hydra post-processes 2D
// textures, bauble raymarches a 3D scene described in Janet — (sphere 100),
// (union …), (rotate … :y t) — compiled to a fragment shader by the
// bauble-runtime wasm build of bauble.studio. Like hydra, the sketch lives in
// a table, and the format mirrors the hydra table exactly.
//
// The "bauble" view is a table of *events*, placed on the loop by a 1-indexed
// `beat` column — beat 1 is the top of the loop, beat b sits (b − 1) beats in.
// Each row's `event` says what it does:
//   - "setCode"     : `code` becomes the bauble sketch — a Janet expression
//                      evaluating to a shape, e.g. "(rotate (box 50) :y t)"
//                      (`t` is the playback clock in seconds, riding the same
//                      timeline as everything else — pausing/scrubbing pauses/
//                      scrubs the sketch).
//   - "setVariable" : `name`/`value` binds one variable the sketch can read,
//                      compiled in as a Janet definition — (def name value) —
//                      ahead of the code (freq, amount, …). Unlike hydra's
//                      per-frame props functions, bauble variables are BAKED
//                      into the compiled shader: changing one recompiles the
//                      sketch (Janet → GLSL → shader), so drive variables from
//                      the beat grid, not from something that sweeps every
//                      frame. The exception is the reserved camera trio —
//                      "camera-x" / "camera-y" (orbit, in turns) and
//                      "camera-zoom" (distance multiplier) — which the renderer
//                      consumes as plain uniforms (see bauble-scene.ts), so a
//                      slider- or midi-driven camera move never recompiles.
//
// Sampling at a frame folds every event seen at/before it in order: setCode
// replaces the running code string, setVariable folds into the most-recent
// value of each named variable — the same fold hydra.ts does, minus hydra's
// meta-programming events (bauble code is one Janet expression, not a chain to
// splice). Both the sketch and the values driving it are plain table data the
// user can inspect and wire up from the rest of the dataflow. This module is
// pure (no wasm / WebGL / DOM dependency); compiling and rendering live in
// bauble-scene.ts.
// ----------------------------------------------------------------------------

import { beatToFrame } from './constants.js'
import type { Row } from './lineage.js'

export interface BaubleFrame {
  // The Janet sketch source (one shape expression, possibly multiple forms).
  code: string
  // Variable name → value, compiled in as (def name value) prefix forms —
  // except the reserved camera names, which the renderer reads directly.
  vars: Record<string, unknown>
}

// The event kinds a bauble table understands. Deliberately just the two data
// events (the format hydra started with): the sketch and its inputs.
const BAUBLE_EVENTS = new Set(['setCode', 'setVariable'])

// A bauble row is either of those events.
export function isBaubleRow(row: Row | null | undefined): boolean {
  return row != null && typeof row.event === 'string' && BAUBLE_EVENTS.has(row.event)
}

export function baubleRows(rows: Row[] | null | undefined): Row[] {
  return (rows ?? []).filter(isBaubleRow)
}

// Place each row on the frame grid (from its 1-indexed `beat`; rows without one
// sit at beat 1 / frame 0) and sort ascending, so sampling is a frame comparison
// (mirrors hydra.ts). The computed frame is stored on `index`, the field
// baubleFrameAt samples against. An optional 0-indexed `loop` column next to
// `beat` places a row in a later pass of the loop (multi-loop sequences): rows
// sort by (loop, frame), so the sketch evolves across passes and sampling folds
// every earlier pass in full.
export function buildBaubleIndex(rows: Row[] | null | undefined): Row[] {
  return baubleRows(rows)
    .map((row) => ({
      ...row,
      index: beatToFrame((row.beat as number | undefined) ?? 1),
      loop: typeof row.loop === 'number' ? Math.max(0, Math.floor(row.loop)) : 0,
    }))
    .sort((a, b) => ((a.loop as number) - (b.loop as number)) || ((a.index as number) - (b.index as number)))
}

// How many passes of the loop the sketch spans — the largest `loop` + 1.
export function baubleLoops(index: Row[]): number {
  return index.reduce((m, r) => Math.max(m, (r.loop as number | undefined) ?? 0), 0) + 1
}

// The active sketch at frame `f` of loop pass `loop`: every event from earlier
// passes in full, plus this pass's events at/before f, folded in order —
// setCode replaces the code, setVariable folds into the most-recent value of
// each named variable (later events override earlier ones, so a row can change
// just one variable while the sketch stays put). Returns null until a setCode
// is reached — playback then leaves the bauble layer blank.
export function baubleFrameAt(index: Row[], f: number, loop = 0): BaubleFrame | null {
  const frame = Math.floor(f)
  if (frame < 0) return null
  let code: string | null = null
  const vars: Record<string, unknown> = {}
  for (const row of index) {
    const l = (row.loop as number | undefined) ?? 0
    if (l > loop || (l === loop && (row.index as number) > frame)) break
    if (row.event === 'setCode') {
      if (typeof row.code === 'string') code = row.code
    } else if (row.event === 'setVariable') {
      if (typeof row.name === 'string') vars[row.name] = row.value
    }
  }
  return code == null ? null : { code, vars }
}

// The reserved variable names the renderer consumes directly as camera
// uniforms — never compiled into the Janet script, so driving them per frame
// (slider, midi) never recompiles the shader. camera-x/-y orbit the camera
// (in turns of a full revolution — 0.25 is a quarter turn), camera-zoom
// scales its distance (1 is the default framing, smaller is closer).
export const BAUBLE_CAMERA_VARS = ['camera-x', 'camera-y', 'camera-zoom'] as const

export function isBaubleCameraVar(name: string): boolean {
  return (BAUBLE_CAMERA_VARS as readonly string[]).includes(name)
}

// Render one variable value as a Janet expression. Finite numbers and booleans
// become literals; a non-blank string is inserted verbatim, so a value can be
// any Janet expression — "(sin t)", "[1 0 0]" — not just a constant. Anything
// else (blank/unset cells, objects) yields null: the variable is skipped
// rather than compiled into a broken (def …).
function janetValue(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return String(value)
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  return null
}

// The complete Janet script for a sampled frame: one (def name value) per
// variable (in fold order — camera vars excluded, the renderer owns those),
// then the sketch code. This string is what bauble-scene.ts hands to the
// compiler, and its identity is the recompile gate: same string, no recompile.
export function baubleScript(frame: BaubleFrame): string {
  const defs: string[] = []
  for (const [name, value] of Object.entries(frame.vars)) {
    if (isBaubleCameraVar(name)) continue
    const v = janetValue(value)
    if (v != null) defs.push(`(def ${name} ${v})`)
  }
  return defs.length ? `${defs.join('\n')}\n${frame.code}` : frame.code
}

// The compiled script as of one table row: every bauble event folded in order
// up to and INCLUDING the row at `rowIndex` in the raw `rows` array, exactly as
// it would compile at that event's beat. Returns null when that row isn't a
// bauble event, or when no setCode has established any code yet by that point.
// Unlike sampling a frame, this stops at the row itself — so two events on the
// same beat show the running script after each in turn, not just the beat's end
// state. Powers the table panel's per-row "compiled code" info popover
// (mirrors hydraCodeUpToRow).
export function baubleCodeUpToRow(rows: Row[] | null | undefined, rowIndex: number): string | null {
  const all = rows ?? []
  if (!isBaubleRow(all[rowIndex])) return null
  const index = buildBaubleIndex(all.map((row, i) => ({ ...row, __row: i })))
  const pos = index.findIndex((r) => (r as { __row?: number }).__row === rowIndex)
  if (pos < 0) return null
  const at = index[pos]
  const frame = baubleFrameAt(index.slice(0, pos + 1), at.index as number, at.loop as number)
  return frame ? baubleScript(frame) : null
}
