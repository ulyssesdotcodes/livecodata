// livecodata bauble — table-driven 3D SDF sketches (bauble.studio: Janet code
// compiled to a GLSL raymarcher). The "bauble" view mirrors the hydra table:
// events placed by a 1-indexed `beat` column, folded at a frame into a Janet
// script. setCode replaces the sketch; the meta events rewrite the accumulated
// code structurally — a bauble sketch is one s-expression to wrap or combine,
// not a chain to splice like hydra's: transform/duplicate/combine/replace edit
// it, slice/tile/radial are named wrappers for the classic SDF moves, and
// transition morphs from the program so far to the program after it over
// `value` beats, on the t clock (byte-stable — no recompile mid-wipe).
// Unlike hydra's per-frame props, setVariable values BAKE into the compiled
// shader (changing one recompiles) — except the reserved camera-x/-y/-zoom
// trio, which the renderer consumes as plain uniforms. This module is pure;
// compiling and rendering live in bauble-scene.ts.

import { beatToFrame, beatsToFrames, FPS } from './constants.js'
import type { Row } from './lineage.js'

export interface BaubleFrame {
  code: string
  vars: Record<string, unknown>
}

// The two data events plus the meta-programming transforms that rewrite the
// accumulated code (each a no-op until a setCode establishes some).
const BAUBLE_EVENTS = new Set([
  'setCode', 'setVariable',
  'transform', 'duplicate', 'combine', 'replace',
  'transition', 'slice', 'tile', 'radial',
])

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

// Apply a transform form to a subject shape expression. A standalone `_`
// (delimited by whitespace/brackets/string bounds — never part of a longer
// symbol) is the hole: every occurrence becomes the subject, so a form can use
// the shape twice ("(union _ (mirror _ :x))"). With no hole the subject is
// inserted as the form's first argument — bauble's own "shape first"
// convention — and a bare symbol becomes a call: "symmetry" → "(symmetry S)".
const HOLE = /(^|[\s()[\]{}])_(?=[\s()[\]{}]|$)/g
export function applyForm(form: string, subject: string): string {
  const f = form.trim()
  HOLE.lastIndex = 0
  if (HOLE.test(f)) return f.replace(HOLE, (_, pre: string) => `${pre}${subject}`)
  const head = f.match(/^\(\s*[^\s()[\]{}]+/)
  if (head) return `${f.slice(0, head[0].length)} ${subject}${f.slice(head[0].length)}`
  return `(${f} ${subject})`
}

// The combiners a duplicate/combine event picks via `mode`, mapped to how each
// spends the `value` cell: the `:r` smooth-blend radius, or morph's trailing
// blend amount. The keys double as the enum options in the table.
const COMBINE_OPS: Record<string, 'radius' | 'amount'> = {
  union: 'radius', intersect: 'radius', subtract: 'radius', morph: 'amount',
}
export const BAUBLE_COMBINE_MODES: string[] = Object.keys(COMBINE_OPS)

// A `value` cell as a combiner argument — strings verbatim, so the radius or
// amount can be any Janet expression. Null omits it (bauble's own default
// applies: a hard union, morph's 0.5).
function combineValue(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  return null
}

function combineShapes(mode: string, a: string, b: string, value: unknown): string {
  const v = combineValue(value)
  if (COMBINE_OPS[mode] === 'amount') return v != null ? `(${mode} ${a} ${b} ${v})` : `(${mode} ${a} ${b})`
  return v != null ? `(${mode} :r ${v} ${a} ${b})` : `(${mode} ${a} ${b})`
}

// The axis a slice/radial row works about — the `axis` cell when it names one,
// y otherwise (a blank or malformed cell behaves like the default).
function axisOf(row: Row): string {
  const a = typeof row.axis === 'string' ? row.axis.trim() : ''
  return a === 'x' || a === 'y' || a === 'z' ? a : 'y'
}

// A `transition` snapshotted mid-fold: the `before` program (frozen at the
// transition's beat) and the grid-frame window the wipe morphs across. The
// window bakes into the emitted code in `t` units (seconds — bauble-scene.ts
// drives t as srcFrameF / FPS) as (ss t start end), so the wipe animates on
// the playback clock without the string changing per frame — no recompile
// mid-wipe, and it pauses/scrubs with the timeline. Once the window elapses
// the fold drops the transition (see baubleFrameAt) and the code collapses to
// the bare after program, exactly like hydra's transitions.
interface Transition {
  before: string
  startFrame: number
  durFrames: number
}

// The active sketch at frame `f` of loop pass `loop`: earlier passes fold in
// full, then this pass's events at/before f — setCode replaces the code, the
// meta events evolve it, setVariable folds into the latest value per name.
// Returns null until a setCode is reached — playback then leaves the bauble
// layer blank.
export function baubleFrameAt(index: Row[], f: number, loop = 0): BaubleFrame | null {
  const frame = Math.floor(f)
  if (frame < 0) return null
  let code: string | null = null
  const vars: Record<string, unknown> = {}
  const transitions: Transition[] = []
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
      case 'transform':
        if (code != null && typeof row.code === 'string' && row.code.trim() !== '') {
          code = applyForm(row.code, code)
        }
        break
      case 'duplicate': {
        // Combine the shape with a copy of itself run through `code` (blank =
        // a verbatim copy).
        if (code != null) {
          const mode = typeof row.mode === 'string' && row.mode in COMBINE_OPS ? row.mode : 'union'
          const copyForm = typeof row.code === 'string' ? row.code.trim() : ''
          const copy = copyForm === '' ? code : applyForm(copyForm, code)
          code = combineShapes(mode, code, copy, row.value)
        }
        break
      }
      case 'combine':
        // Composite another whole shape onto the current one.
        if (code != null && typeof row.code === 'string' && row.code.trim() !== '') {
          const mode = typeof row.mode === 'string' && row.mode in COMBINE_OPS ? row.mode : 'union'
          code = combineShapes(mode, code, row.code.trim(), row.value)
        }
        break
      case 'replace':
        // Literal substring swap over the whole current sketch (no regex).
        if (code != null && typeof row.find === 'string' && row.find !== '') {
          code = code.split(row.find).join(row.value == null ? '' : String(row.value))
        }
        break
      case 'slice':
        // Cut the shape open as a shell: onion at `value` thickness (3 when
        // unset), the cutter subtracted being `code` (any shape) or a
        // half-space about the `axis` cell.
        if (code != null) {
          const thickness = combineValue(row.value) ?? '3'
          const cutter = typeof row.code === 'string' && row.code.trim() !== ''
            ? row.code.trim()
            : `(half-space :${axisOf(row)})`
          code = `(subtract (onion ${code} ${thickness}) ${cutter})`
        }
        break
      case 'tile':
        // Repeat the shape on an infinite lattice: a number `value` spaces all
        // three axes evenly, a string is a vec3 (or any Janet expression)
        // verbatim. No spacing → no-op (a zero-spaced lattice is degenerate).
        if (code != null) {
          const v = row.value
          const spacing = typeof v === 'number' && Number.isFinite(v) && v > 0
            ? `[${v} ${v} ${v}]`
            : typeof v === 'string' && v.trim() !== '' ? v.trim() : null
          if (spacing != null) code = `(tile ${code} ${spacing})`
        }
        break
      case 'radial':
        // Repeat the shape in a circular array of `value` copies (6 when
        // unset) about the `axis` cell.
        if (code != null) {
          const count = typeof row.value === 'number' && Number.isFinite(row.value) && row.value >= 1
            ? Math.floor(row.value)
            : 6
          code = `(radial ${code} :${axisOf(row)} ${count})`
        }
        break
      case 'transition': {
        // Snapshot the program so far as the "before" and remember the wipe;
        // it morphs to the final "after" (the code that keeps folding after
        // it) once the fold completes — but only while its window is live:
        // once elapsed the wipe is done and the after stands alone, so
        // finished wipes never pile up.
        if (code != null) {
          const durBeats = typeof row.value === 'number' && row.value > 0 ? row.value : 1
          const durFrames = Math.max(1, beatsToFrames(durBeats))
          const startFrame = row.index as number
          if (frame < startFrame + durFrames) {
            transitions.push({ before: code, startFrame, durFrames })
          }
        }
        break
      }
    }
  }
  if (code == null) return null

  // Apply the wipes from the innermost (latest) out: the final program is the
  // last transition's "after", and each earlier transition morphs its own
  // frozen "before" toward the wipe that follows it — nested transitions
  // compose in beat order, the earliest wrapping all the later ones. (ss t
  // start end) ramps 0 → 1 across the window on the playback clock.
  for (let i = transitions.length - 1; i >= 0; i--) {
    const tr = transitions[i]
    const start = tr.startFrame / FPS
    const end = (tr.startFrame + tr.durFrames) / FPS
    code = `(morph ${tr.before} ${code} (ss t ${start} ${end}))`
  }
  return { code, vars }
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
