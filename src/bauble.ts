// livecodata bauble — table-driven 3D SDF sketches (bauble.studio: Janet code
// compiled to a GLSL raymarcher). The "bauble" view mirrors the hydra table:
// setCode/setVariable events placed by a 1-indexed `beat` column, folded at a
// frame into a Janet script. Unlike hydra's per-frame props, variables BAKE
// into the compiled shader (changing one recompiles) — except the reserved
// camera-x/-y/-zoom trio, which the renderer consumes as plain uniforms. This
// module is pure; compiling and rendering live in bauble-scene.ts.

import { beatToFrame } from './constants.js'
import type { Row } from './lineage.js'

export interface BaubleFrame {
  code: string
  vars: Record<string, unknown>
}

// Deliberately just the two data events — none of hydra's meta-programming
// transforms (bauble code is one Janet expression, not a chain to splice).
const BAUBLE_EVENTS = new Set(['setCode', 'setVariable'])

export function isBaubleRow(row: Row | null | undefined): boolean {
  return row != null && typeof row.event === 'string' && BAUBLE_EVENTS.has(row.event)
}

export function baubleRows(rows: Row[] | null | undefined): Row[] {
  return (rows ?? []).filter(isBaubleRow)
}

// Place each row on the frame grid from its 1-indexed `beat` (frame stored on
// `index`, the field baubleFrameAt samples against) and sort by (loop, frame);
// an optional 0-indexed `loop` column places a row in a later pass of the loop.
export function buildBaubleIndex(rows: Row[] | null | undefined): Row[] {
  return baubleRows(rows)
    .map((row) => ({
      ...row,
      index: beatToFrame((row.beat as number | undefined) ?? 1),
      loop: typeof row.loop === 'number' ? Math.max(0, Math.floor(row.loop)) : 0,
    }))
    .sort((a, b) => ((a.loop as number) - (b.loop as number)) || ((a.index as number) - (b.index as number)))
}

export function baubleLoops(index: Row[]): number {
  return index.reduce((m, r) => Math.max(m, (r.loop as number | undefined) ?? 0), 0) + 1
}

// The active sketch at frame `f` of loop pass `loop`: earlier passes fold in
// full, then this pass's events at/before f. Returns null until a setCode is
// reached — playback then leaves the bauble layer blank.
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

// Reserved names the renderer consumes directly as camera uniforms — never
// compiled into the Janet script, so driving them per frame never recompiles.
// camera-x/-y orbit in turns; camera-zoom scales distance (1 = default framing).
export const BAUBLE_CAMERA_VARS = ['camera-x', 'camera-y', 'camera-zoom'] as const

export function isBaubleCameraVar(name: string): boolean {
  return (BAUBLE_CAMERA_VARS as readonly string[]).includes(name)
}

// Render one variable value as a Janet expression; strings insert verbatim so
// a value can be any Janet expression. Null means skip the variable rather
// than compile a broken (def …).
function janetValue(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return String(value)
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  return null
}

// The complete Janet script for a sampled frame: one (def name value) per
// variable (camera vars excluded — the renderer owns those), then the code.
// Its string identity is bauble-scene.ts's recompile gate.
export function baubleScript(frame: BaubleFrame): string {
  const defs: string[] = []
  for (const [name, value] of Object.entries(frame.vars)) {
    if (isBaubleCameraVar(name)) continue
    const v = janetValue(value)
    if (v != null) defs.push(`(def ${name} ${v})`)
  }
  return defs.length ? `${defs.join('\n')}\n${frame.code}` : frame.code
}

// The compiled script as of one table row: events folded up to and INCLUDING
// the row at `rowIndex` — stops at the row itself, so two events on the same
// beat show the running script after each in turn (mirrors hydraCodeUpToRow).
// Powers the table panel's per-row "compiled code" popover.
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
