// livecodata post — table-driven TSL post-processing. The "post" view is
// hydra's sibling: a table of events placed on the loop by a 1-indexed `beat`
// column, folded into ONE running effect chain applied to the rendered scene,
// then evaluated to an immutable op list (see post-lang.ts). The scene is the
// implicit source and there is one output, so the code reads like hydra
// (`edges(0.2).bloom(1.2)`) with no routing. This module is pure — no GPU, no
// `three`; the node graph is built and rendered by post-scene.ts.

import { beatToFrame, beatsToFrames, FPS } from './constants.js'
import { EASINGS, type Easings } from './dsl.js'
import { evalPostCode, chainSignature, type OpChain } from './post-lang.js'
import type { Row } from './lineage.js'

// One folded frame: the precompiled-state id (the chain's structural
// signature), the op list, and the latest value of each variable.
export interface PostFrame {
  stateId: string
  chain: OpChain
  vars: Record<string, unknown>
}

const POST_EVENTS = new Set(['chain', 'add', 'remove', 'layer', 'transition', 'set', 'pulse'])

export function isPostRow(row: Row | null | undefined): boolean {
  return row != null && typeof row.event === 'string' && POST_EVENTS.has(row.event)
}

export function postRows(rows: Row[] | null | undefined): Row[] {
  return (rows ?? []).filter(isPostRow)
}

// Place each row on the frame grid from its 1-indexed `beat` (frame stored on
// `index`) and sort by frame — like buildHydraIndex, so a beat past the loop's
// end lands the row in a later pass (the visualizer wraps the playhead).
export function buildPostIndex(rows: Row[] | null | undefined): Row[] {
  return postRows(rows)
    .map((row) => ({ ...row, index: beatToFrame((row.beat as number | undefined) ?? 1) }))
    .sort((a, b) => (a.index as number) - (b.index as number))
}

// The frames whose folded state must be precompiled: every event frame, plus
// each transition's END frame (the fold changes when a wipe window expires with
// no row there — the verified fused-fx failure mode). setProgram enumerates
// these; a warm-compile audit checks no other frame introduces a new state.
export function postStateFrames(index: Row[]): number[] {
  const frames = new Set<number>()
  for (const row of index) {
    const f = row.index as number
    frames.add(f)
    if (row.event === 'transition') {
      const durBeats = typeof row.dur === 'number' && row.dur > 0 ? row.dur : 1
      frames.add(f + Math.max(1, beatsToFrames(durBeats)))
    }
  }
  return [...frames].sort((a, b) => a - b)
}

// Split a chain string into its top-level op-call segments (balanced-paren
// aware, so dots inside args — decimals, nested calls — never split). The
// leading identifier of each segment names the op.
function splitOps(chain: string): string[] {
  const segs: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < chain.length; i++) {
    const c = chain[i]
    if (c === '(' || c === '[') depth++
    else if (c === ')' || c === ']') depth--
    else if (c === '.' && depth === 0) { segs.push(chain.slice(start, i)); start = i + 1 }
  }
  segs.push(chain.slice(start))
  return segs.filter((s) => s.trim() !== '')
}

// Drop every op named `name` from a chain, then rejoin — the beat-time bypass
// behind the `remove` event. Dropping the first op is fine: the next op becomes
// top-level (implicit scene), which is still a valid chain.
function removeOp(chain: string, name: string): string {
  const nameOf = (s: string): string => s.match(/^\s*([\w$]+)/)?.[1] ?? ''
  return splitOps(chain).filter((s) => nameOf(s) !== name).join('.')
}

// Blend modes the `layer` event can pick, and whether each takes an amount.
// Only `blend` carries an amount in the op registry; the rest composite raw.
const LAYER_AMOUNT = new Set(['blend'])
const LAYER_MODES = new Set(['blend', 'add', 'mult', 'diff', 'mask'])

// A layer amount as a code fragment: a number is a literal; any other non-empty
// string is a per-frame props expression (hydra-identical).
function amountExpr(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  const s = typeof value === 'string' ? value.trim() : ''
  if (s === '') return '0.5'
  const n = Number(s)
  if (!Number.isNaN(n)) return String(n)
  return s.includes('=>') ? `(${s})` : `(p) => (${s})`
}

// A transition snapshotted mid-fold: the frozen "before" chain, its mask chain
// ('' = plain crossfade), and the grid-frame wipe window.
interface Transition { before: string; mask: string; startFrame: number; durFrames: number }

// Fold the event stream into the running chain string at `frame`. Returns null
// (post stage inactive → scene shows through) until the chain is non-empty.
// setVariable/pulse are handled separately (foldVars); this is chain shape only.
function foldChain(index: Row[], frame: number): string | null {
  let code = ''
  const transitions: Transition[] = []
  for (const row of index) {
    if ((row.index as number) > frame) break
    const c = typeof row.code === 'string' ? row.code.trim() : ''
    switch (row.event) {
      case 'chain':
        code = c
        break
      case 'add':
        if (c !== '') code = code === '' ? c.replace(/^\./, '') : `${code}.${c.replace(/^\./, '')}`
        break
      case 'remove':
        if (code !== '' && typeof row.name === 'string' && row.name !== '') code = removeOp(code, row.name)
        break
      case 'layer':
        if (c !== '') {
          const mode = typeof row.mode === 'string' && LAYER_MODES.has(row.mode) ? row.mode : 'blend'
          const amt = LAYER_AMOUNT.has(mode) ? `, ${amountExpr(row.value)}` : ''
          const base = code === '' ? 'scene()' : code
          code = `${base}.${mode}(${c}${amt})`
        }
        break
      case 'transition': {
        // Snapshot the current chain as "before"; the wipe applies to the final
        // "after" once folded. Elapsed windows drop (postStateFrames enumerates
        // the window END as its own state).
        const durBeats = typeof row.dur === 'number' && row.dur > 0 ? row.dur : 1
        const durFrames = Math.max(1, beatsToFrames(durBeats))
        const startFrame = row.index as number
        if (frame < startFrame + durFrames) {
          transitions.push({ before: code === '' ? 'scene()' : code, mask: c, startFrame, durFrames })
        }
        break
      }
    }
  }
  if (code === '' && transitions.length === 0) return null
  // Apply wipes innermost-first so nested transitions compose in beat order.
  let result = code === '' ? 'scene()' : code
  for (let i = transitions.length - 1; i >= 0; i--) {
    const tr = transitions[i]
    const start = tr.startFrame / FPS
    const dur = tr.durFrames / FPS
    const posFn = `(p) => Math.min(Math.max((p.time - ${start}) / ${dur}, 0), 1)`
    const mask = tr.mask !== '' ? `(${tr.mask})` : 'null'
    result = `transition((${tr.before}), (${result}), ${mask}, ${posFn})`
  }
  return result
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)
const easingOf = (name: unknown, fallback: keyof Easings): ((t: number) => number) =>
  EASINGS[(typeof name === 'string' && name in EASINGS ? name : fallback) as keyof Easings]

// The base (step-or-tween) value of one variable at `frame`, from its `set`
// rows in index order (all at/before frame). The last row is the active one:
// with a `dur` it interpolates from the previous row's value via EASINGS[ease]
// over dur beats; otherwise it steps. A non-numeric value (or a missing
// previous value) degenerates to a step, so `$expr` bindings pass through.
function baseValue(sets: Row[], frame: number): unknown {
  if (sets.length === 0) return undefined
  let prev: unknown = undefined
  for (let i = 0; i < sets.length - 1; i++) prev = sets[i].value
  const r = sets[sets.length - 1]
  const target = r.value
  const dur = typeof r.dur === 'number' && r.dur > 0 ? r.dur : 0
  if (dur > 0 && typeof target === 'number' && typeof prev === 'number') {
    const durFrames = Math.max(1, beatsToFrames(dur))
    const u = clamp01((frame - (r.index as number)) / durFrames)
    return prev + (target - prev) * easingOf(r.ease, 'linear')(u)
  }
  return target
}

// The summed contribution of one variable's active pulses at `frame`. Each adds
// value·env(u) over `dur` beats, u = elapsed fraction, env decaying 1→0 shaped
// by `ease` (default easeOut); expired or not-yet-started rows are inert.
function pulseSum(pulses: Row[], frame: number): number {
  let sum = 0
  for (const r of pulses) {
    const dur = typeof r.dur === 'number' && r.dur > 0 ? r.dur : 0
    if (dur <= 0) continue
    const start = r.index as number
    const durFrames = Math.max(1, beatsToFrames(dur))
    if (frame < start || frame >= start + durFrames) continue
    const val = typeof r.value === 'number' ? r.value : 0
    const u = clamp01((frame - start) / durFrames)
    sum += val * (1 - easingOf(r.ease, 'easeOut')(u))
  }
  return sum
}

// Fold every set/pulse row into the variable map at `frame`: each name's base
// value plus its active pulses.
export function foldVars(index: Row[], frame: number): Record<string, unknown> {
  const sets = new Map<string, Row[]>()
  const pulses = new Map<string, Row[]>()
  for (const row of index) {
    if ((row.index as number) > frame) break
    if (typeof row.name !== 'string') continue
    const bucket = row.event === 'set' ? sets : row.event === 'pulse' ? pulses : null
    if (bucket) (bucket.get(row.name) ?? bucket.set(row.name, []).get(row.name)!).push(row)
  }
  const vars: Record<string, unknown> = {}
  for (const name of new Set([...sets.keys(), ...pulses.keys()])) {
    const base = sets.has(name) ? baseValue(sets.get(name)!, frame) : undefined
    const pulse = pulses.has(name) ? pulseSum(pulses.get(name)!, frame) : 0
    if (typeof base === 'number' && Number.isFinite(base)) vars[name] = base + pulse
    else if (base === undefined && pulses.has(name)) vars[name] = pulse
    else vars[name] = base
  }
  return vars
}

// The active program at (absolute) frame `f`: every event at/before it folds
// into one running chain, evaluated to an op list. The state id is its
// structural signature, so frames sharing structure share a precompiled graph.
// Returns null until the chain is non-empty — playback then leaves post inactive.
export function postFrameAt(index: Row[], f: number): PostFrame | null {
  const frame = Math.floor(f)
  if (frame < 0) return null
  const codeStr = foldChain(index, frame)
  if (codeStr == null) return null
  // Let a broken chain (syntax error, unknown op, a trailing line comment the
  // `return (...)` wrap can't close) throw. The cook compiles every state up
  // front, so the error surfaces to the user there rather than being swallowed.
  const chain = evalPostCode(codeStr)
  return { stateId: chainSignature(chain), chain, vars: foldVars(index, frame) }
}

// The compiled chain source as of one table row: events folded up to and
// INCLUDING the row at `rowIndex`. Powers the table panel's per-row popover.
export function postCodeUpToRow(rows: Row[] | null | undefined, rowIndex: number): string | null {
  const all = rows ?? []
  if (!isPostRow(all[rowIndex])) return null
  const index = buildPostIndex(all.map((row, i) => ({ ...row, __row: i })))
  const pos = index.findIndex((r) => (r as { __row?: number }).__row === rowIndex)
  if (pos < 0) return null
  return foldChain(index.slice(0, pos + 1), index[pos].index as number)
}
