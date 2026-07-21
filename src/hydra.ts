// livecodata hydra — table-driven video synth (hydra-ts). The "hydra" view is a
// table of events placed on the loop by a 1-indexed `beat` column; sampling a
// frame folds every event at/before it, per `out` output, into one running
// sketch string plus the latest value of each setVariable. This module is pure;
// GPU rendering lives in hydra-scene.ts.

import { beatToFrame, beatsToFrames, FPS } from './constants.js'
import { isBinding, isStreamingNode, evalExpr, substituteExpr } from './dsl.js'
import type { Row } from './lineage.js'

export interface HydraFrame {
  code: string
  vars: Record<string, unknown>
}

const HYDRA_EVENTS = new Set(['setCode', 'setVariable', 'setSource', 'replace', 'append', 'layer', 'transition'])

export function isHydraRow(row: Row | null | undefined): boolean {
  return row != null && typeof row.event === 'string' && HYDRA_EVENTS.has(row.event)
}

export function hydraRows(rows: Row[] | null | undefined): Row[] {
  return (rows ?? []).filter(isHydraRow)
}

// Place each row on the frame grid from its 1-indexed `beat` (frame stored on
// `index`, the field hydraFrameAt samples against) and sort by frame. The beat
// axis is absolute: a beat past the loop's end lands the row in a later pass
// (the visualizer wraps the playhead into this grid — see visualizer.ts).
export function buildHydraIndex(rows: Row[] | null | undefined): Row[] {
  return hydraRows(rows)
    .map((row) => ({
      ...row,
      index: beatToFrame((row.beat as number | undefined) ?? 1),
    }))
    .sort((a, b) => (a.index as number) - (b.index as number))
}

// Strip a trailing `.out(...)` off a sketch, leaving the bare chain the
// meta-programming events extend or compose. Exported for the sibling `post`
// fold (src/post.ts), which reuses the same chain surgery.
const OUT_TAIL = /\.out\s*\([^)]*\)\s*;?\s*$/
export function chainOf(code: string): string {
  return code.replace(OUT_TAIL, '')
}

// Split a sketch into its head generator call (balanced parens) and the rest
// of the chain. Best-effort: a head with no call, or unbalanced parens, yields
// the whole string as the head. Exported for reuse by src/post.ts's setSource.
export function splitHead(code: string): [string, string] {
  const s = code.trimStart()
  let i = 0
  while (i < s.length && /[\w$]/.test(s[i])) i++
  if (s[i] !== '(') return [s, '']
  for (let depth = 0; i < s.length; i++) {
    if (s[i] === '(') depth++
    else if (s[i] === ')' && --depth === 0) { i++; break }
  }
  return [s.slice(0, i), s.slice(i)]
}

// Blend operators a `layer` event can pick via `mode`, mapped to whether each
// takes an amount. The keys double as the table's enum options.
const BLEND_OPS: Record<string, boolean> = {
  blend: true, add: true, mult: true, diff: false, layer: false, mask: false,
}
export const HYDRA_BLEND_MODES: string[] = Object.keys(BLEND_OPS)

function hasAmount(value: unknown): boolean {
  return (typeof value === 'number' && Number.isFinite(value))
    || (typeof value === 'string' && value.trim() !== '')
}

// Render a `layer` amount: numbers become literals; any other string is an
// expression evaluated per frame with `props` in scope.
function amountExpr(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  const s = typeof value === 'string' ? value.trim() : ''
  if (s === '') return '0.5'
  const n = Number(s)
  if (!Number.isNaN(n)) return String(n)
  return s.includes('=>') ? `(${s})` : `(props) => (${s})`
}

// The hydra output a row drives; a blank or malformed `out` cell means o0.
const OUTPUT_RE = /^o\d+$/
function outputOf(row: Row): string {
  const o = typeof row.out === 'string' ? row.out.trim() : ''
  return OUTPUT_RE.test(o) ? o : 'o0'
}

// A `transition` snapshotted mid-fold: the frozen "before" chain, its mask
// sketch ('' = plain crossfade), and the grid-frame wipe window. The window is
// exposed to the mask in `props.time` (seconds) units and bakes as constants,
// so the mask animates on hydra's own clock without the sketch string changing
// per frame.
export interface Transition {
  before: string
  mask: string
  startFrame: number
  durFrames: number
}

// The window bounds a transition exposes to its mask sketch, in `props.time`
// (seconds) units, plus the clamped 0 → 1 `transitionPos(t)` helper. Exported
// for src/post.ts, which mirrors hydra's transition windowing.
export function transitionWindow(t: Transition): { start: number; end: number; posFn: string } {
  const start = t.startFrame / FPS
  const dur = t.durFrames / FPS
  return {
    start,
    end: start + dur,
    posFn: `(t) => Math.min(Math.max((t - ${start}) / ${dur}, 0), 1)`,
  }
}

// A setVariable value with its own row substituted in for field() reads —
// resolveBindings later sees the vars map as the row, which would read a
// sibling variable instead. A still-streaming value stays a binding.
function rowScopedValue(row: Row): unknown {
  const v = row.value
  if (!isBinding(v)) return v
  const node = substituteExpr(v.$expr, { fields: row })
  return isStreamingNode(node) ? { $expr: node } : evalExpr(node, row, 0)
}

// Fold one output's events (already sorted, filtered to this output) into its
// running code string; setVariable folds into the shared `vars`. Returns null
// until a setCode establishes some code.
function foldOutput(
  rows: Row[], frame: number, output: string,
  vars: Record<string, unknown>,
): string | null {
  let code: string | null = null
  const transitions: Transition[] = []
  for (const row of rows) {
    if ((row.index as number) > frame) break
    switch (row.event) {
      case 'setCode':
        if (typeof row.code === 'string') code = row.code
        break
      case 'setVariable':
        if (typeof row.name === 'string') vars[row.name] = rowScopedValue(row)
        break
      case 'setSource':
        // Swap the head generator, keeping every effect (and .out()) after it.
        if (code != null && typeof row.code === 'string' && row.code.trim() !== '') {
          code = `${chainOf(row.code.trim())}${splitHead(code)[1]}`
        }
        break
      case 'replace':
        // Literal substring swap over the whole current sketch.
        if (code != null && typeof row.find === 'string' && row.find !== '') {
          code = code.split(row.find).join(row.value == null ? '' : String(row.value))
        }
        break
      case 'append':
        if (code != null && typeof row.code === 'string' && row.code.trim() !== '') {
          code = `${chainOf(code)}${row.code.trim()}.out(${output})`
        }
        break
      case 'layer':
        if (code != null && typeof row.code === 'string' && row.code.trim() !== '') {
          const mode = typeof row.mode === 'string' && row.mode in BLEND_OPS ? row.mode : 'blend'
          const amt = BLEND_OPS[mode] && hasAmount(row.value) ? `, ${amountExpr(row.value)}` : ''
          code = `${chainOf(code)}.${mode}(${chainOf(row.code.trim())}${amt}).out(${output})`
        }
        break
      case 'transition': {
        // Snapshot the current code as the "before"; the wipe is applied to the
        // final "after" once the whole output is folded. Elapsed windows are
        // dropped so finished wipes don't pile up without bound.
        if (code != null) {
          const durBeats = typeof row.value === 'number' && row.value > 0 ? row.value : 1
          const durFrames = Math.max(1, beatsToFrames(durBeats))
          const startFrame = row.index as number
          if (frame < startFrame + durFrames) {
            transitions.push({
              before: chainOf(code),
              mask: typeof row.code === 'string' ? row.code.trim() : '',
              startFrame,
              durFrames,
            })
          }
        }
        break
      }
    }
  }
  if (code == null) return null

  // Apply the wipes from the innermost (latest) out: each earlier transition
  // blends its frozen "before" over the wipe that follows it, so nested
  // transitions compose in beat order.
  let result = chainOf(code)
  for (let i = transitions.length - 1; i >= 0; i--) {
    const t = transitions[i]
    const { start, end, posFn } = transitionWindow(t)
    if (t.mask !== '') {
      // Composite before (mask black) under after (mask white) through the
      // mask's luminance, binding transitionStart/End/Pos around the user's
      // mask sketch.
      const mask = `((transitionStart, transitionEnd, transitionPos) => (${chainOf(t.mask)}))(${start}, ${end}, ${posFn})`
      result = `${t.before}.layer((${result}).mask(${mask}))`
    } else {
      result = `${t.before}.blend((${result}), (props) => (${posFn})(props.time))`
    }
  }
  // Terminate on the `out` column's output, so a setCode's code never needs
  // its own `.out(...)` (an explicit one is normalised to the column's choice).
  return `${result}.out(${output})`
}

// The active sketch at (absolute) frame `f`: every event at/before it folds
// in, one running code string per output, concatenated. Sampling a frame in a
// later pass of the loop is just sampling further along the grid, so earlier
// passes fold in full for free. Returns null until some output reaches a
// setCode — playback then falls back to showing the raw scene.
export function hydraFrameAt(index: Row[], f: number): HydraFrame | null {
  const frame = Math.floor(f)
  if (frame < 0) return null
  // Fold each output's stream independently; concatenate in output-name order
  // for a deterministic program.
  const groups = new Map<string, Row[]>()
  for (const row of index) {
    const out = outputOf(row)
    const g = groups.get(out)
    if (g) g.push(row)
    else groups.set(out, [row])
  }
  const vars: Record<string, unknown> = {}
  const codes: string[] = []
  for (const out of [...groups.keys()].sort()) {
    const code = foldOutput(groups.get(out)!, frame, out, vars)
    if (code != null) codes.push(code)
  }
  return codes.length === 0 ? null : { code: codes.join('\n'), vars }
}

// The compiled sketch as of one table row: events folded up to and INCLUDING
// the row at `rowIndex`. Unlike sampling a frame, this stops at the row itself,
// so two events on the same beat show the running code after each in turn.
// Powers the table panel's per-row "compiled code" popover.
export function hydraCodeUpToRow(rows: Row[] | null | undefined, rowIndex: number): string | null {
  const all = rows ?? []
  if (!isHydraRow(all[rowIndex])) return null
  // Tag rows with their original position so the target is findable after the
  // frame sort.
  const index = buildHydraIndex(all.map((row, i) => ({ ...row, __row: i })))
  const pos = index.findIndex((r) => (r as { __row?: number }).__row === rowIndex)
  if (pos < 0) return null
  const at = index[pos]
  return hydraFrameAt(index.slice(0, pos + 1), at.index as number)?.code ?? null
}
