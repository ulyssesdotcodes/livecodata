// livecodata post — table-driven TSL post-processing. The "post" view is
// hydra's sibling: a table of events placed on the loop by a 1-indexed `beat`
// column, folded per `out` into one running chain string, then evaluated to an
// immutable op list (see post-lang.ts). This module is pure — no GPU, no
// `three`; the node graph is built and rendered by post-scene.ts. It reuses
// hydra.ts's chain surgery (chainOf/splitHead/transitionWindow) so the two
// folds stay byte-compatible.

import { beatToFrame, beatsToFrames, FPS } from './constants.js'
import { chainOf, splitHead } from './hydra.js'
import { EASINGS, type Easings } from './dsl.js'
import { evalPostCode, chainSignature, type OpChain } from './post-lang.js'
import type { Row } from './lineage.js'

// One folded frame: the precompiled-state id (structural signature across every
// out), the op list per out, and the latest value of each variable.
export interface PostFrame {
  stateId: string
  chains: { out: string; chain: OpChain }[]
  vars: Record<string, unknown>
}

// Every event the post view understands. setSource/append/layer/transition and
// impulse are recognised (so their rows fold and display) even where later
// phases own their full behaviour.
const POST_EVENTS = new Set([
  'setCode', 'setSource', 'append', 'replace', 'layer', 'transition', 'setVariable', 'impulse',
])

export function isPostRow(row: Row | null | undefined): boolean {
  return row != null && typeof row.event === 'string' && POST_EVENTS.has(row.event)
}

export function postRows(rows: Row[] | null | undefined): Row[] {
  return (rows ?? []).filter(isPostRow)
}

// Place each row on the frame grid from its 1-indexed `beat` (frame stored on
// `index`) and sort by frame — identical to buildHydraIndex, so a beat past the
// loop's end lands the row in a later pass (the visualizer wraps the playhead).
export function buildPostIndex(rows: Row[] | null | undefined): Row[] {
  return postRows(rows)
    .map((row) => ({
      ...row,
      index: beatToFrame((row.beat as number | undefined) ?? 1),
    }))
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

// The output a row drives: one of main/b1/b2/b3, defaulting to main.
const OUTPUTS = new Set(['main', 'b1', 'b2', 'b3'])
function outputOf(row: Row): string {
  const o = typeof row.out === 'string' ? row.out.trim() : ''
  return OUTPUTS.has(o) ? o : 'main'
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
interface Transition {
  before: string
  mask: string
  startFrame: number
  durFrames: number
}

// Fold one output's events (sorted, filtered to this output) into its running
// chain string. Returns null until a setCode establishes some code. Unlike
// hydra there is no terminal `.out(oN)` — the `out` column names the target and
// the bare chain stands on its own. setVariable/impulse are folded separately
// (foldVars), since variables are global to the program, not per-output.
function foldOutput(rows: Row[], frame: number): string | null {
  let code: string | null = null
  const transitions: Transition[] = []
  for (const row of rows) {
    if ((row.index as number) > frame) break
    switch (row.event) {
      case 'setCode':
        if (typeof row.code === 'string' && row.code.trim() !== '') code = chainOf(row.code.trim())
        break
      case 'setSource':
        // Swap the head, keep the effect tail (splitHead), like hydra.
        if (code != null && typeof row.code === 'string' && row.code.trim() !== '') {
          code = `${chainOf(row.code.trim())}${splitHead(code)[1]}`
        }
        break
      case 'append':
        if (code != null && typeof row.code === 'string' && row.code.trim() !== '') {
          code = `${chainOf(code)}${row.code.trim()}`
        }
        break
      case 'replace':
        if (code != null && typeof row.find === 'string' && row.find !== '') {
          code = code.split(row.find).join(row.value == null ? '' : String(row.value))
        }
        break
      case 'layer':
        if (code != null && typeof row.code === 'string' && row.code.trim() !== '') {
          const mode = typeof row.mode === 'string' && LAYER_MODES.has(row.mode) ? row.mode : 'blend'
          const amt = LAYER_AMOUNT.has(mode) ? `, ${amountExpr(row.value)}` : ''
          code = `${chainOf(code)}.${mode}(${chainOf(row.code.trim())}${amt})`
        }
        break
      case 'transition': {
        // Snapshot the current chain as "before"; the wipe applies to the final
        // "after" once folded. Elapsed windows are dropped (see postStateFrames
        // for why the window END is its own enumerated state).
        if (code != null) {
          const durBeats = typeof row.dur === 'number' && row.dur > 0 ? row.dur : 1
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
  // Apply wipes innermost-first so nested transitions compose in beat order.
  let result = chainOf(code)
  for (let i = transitions.length - 1; i >= 0; i--) {
    const tr = transitions[i]
    const start = tr.startFrame / FPS
    const dur = tr.durFrames / FPS
    const posFn = `(p) => Math.min(Math.max((p.time - ${start}) / ${dur}, 0), 1)`
    const mask = tr.mask !== '' ? `(${chainOf(tr.mask)})` : 'null'
    result = `transition((${tr.before}), (${result}), ${mask}, ${posFn})`
  }
  return result
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)
const easingOf = (name: unknown, fallback: keyof Easings): ((t: number) => number) =>
  EASINGS[(typeof name === 'string' && name in EASINGS ? name : fallback) as keyof Easings]

// The base (step-or-tween) value of one variable at `frame`, from its
// setVariable rows in index order (all at/before frame). The last row is the
// active one: with a `dur` it interpolates from the previous row's value using
// EASINGS[ease] over dur beats; otherwise it steps. A non-numeric value (or a
// missing previous value) degenerates to a step, so `$expr` bindings pass
// through untouched.
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

// The summed contribution of one variable's active impulses at `frame`. Each
// adds value·env(u) over `dur` beats, u = elapsed fraction, env decaying 1→0
// shaped by `ease` (default easeOut); expired or not-yet-started rows are inert.
function impulseSum(impulses: Row[], frame: number): number {
  let sum = 0
  for (const r of impulses) {
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

// Fold every setVariable/impulse row (global to the program, all outs) into the
// variable map at `frame`: each name's base value plus its active impulses.
export function foldVars(index: Row[], frame: number): Record<string, unknown> {
  const sets = new Map<string, Row[]>()
  const imps = new Map<string, Row[]>()
  for (const row of index) {
    if ((row.index as number) > frame) break
    if (typeof row.name !== 'string') continue
    if (row.event === 'setVariable') (sets.get(row.name) ?? sets.set(row.name, []).get(row.name)!).push(row)
    else if (row.event === 'impulse') (imps.get(row.name) ?? imps.set(row.name, []).get(row.name)!).push(row)
  }
  const vars: Record<string, unknown> = {}
  for (const name of new Set([...sets.keys(), ...imps.keys()])) {
    const base = sets.has(name) ? baseValue(sets.get(name)!, frame) : undefined
    const impulse = imps.has(name) ? impulseSum(imps.get(name)!, frame) : 0
    if (typeof base === 'number' && Number.isFinite(base)) vars[name] = base + impulse
    else if (base === undefined && imps.has(name)) vars[name] = impulse
    else vars[name] = base
  }
  return vars
}

// The active program at (absolute) frame `f`: every event at/before it folds
// in, one running chain per output. Each output's chain is evaluated to an op
// list; the state id is the structural signature across all outputs, so two
// frames sharing structure share a precompiled graph. Returns null until some
// output reaches a setCode — playback then leaves the post stage inactive.
export function postFrameAt(index: Row[], f: number): PostFrame | null {
  const frame = Math.floor(f)
  if (frame < 0) return null
  const groups = new Map<string, Row[]>()
  for (const row of index) {
    const out = outputOf(row)
    const g = groups.get(out)
    if (g) g.push(row)
    else groups.set(out, [row])
  }
  const vars = foldVars(index, frame)
  const chains: { out: string; chain: OpChain }[] = []
  for (const out of [...groups.keys()].sort()) {
    const codeStr = foldOutput(groups.get(out)!, frame)
    if (codeStr == null) continue
    let chain: OpChain
    try {
      chain = evalPostCode(codeStr)
    } catch (err) {
      // A broken cell (mid-edit or an unknown op) drops that output rather than
      // the whole frame — the rest of the program still renders.
      console.error('post: chain eval failed:', (err as Error).message)
      continue
    }
    chains.push({ out, chain })
  }
  if (chains.length === 0) return null
  const stateId = chains.map((c) => `${c.out}:${chainSignature(c.chain)}`).join('|')
  return { stateId, chains, vars }
}

// The compiled state as of one table row: events folded up to and INCLUDING the
// row at `rowIndex`. Powers the table panel's per-row popover; returns the
// folded chain source per output (not the op list), mirroring hydra/bauble.
export function postCodeUpToRow(rows: Row[] | null | undefined, rowIndex: number): string | null {
  const all = rows ?? []
  if (!isPostRow(all[rowIndex])) return null
  const index = buildPostIndex(all.map((row, i) => ({ ...row, __row: i })))
  const pos = index.findIndex((r) => (r as { __row?: number }).__row === rowIndex)
  if (pos < 0) return null
  const at = index[pos]
  const upto = index.slice(0, pos + 1)
  const frame = at.index as number
  const groups = new Map<string, Row[]>()
  for (const row of upto) {
    const out = outputOf(row)
    const g = groups.get(out)
    if (g) g.push(row)
    else groups.set(out, [row])
  }
  const codes: string[] = []
  for (const out of [...groups.keys()].sort()) {
    const codeStr = foldOutput(groups.get(out)!, frame)
    if (codeStr != null) codes.push(groups.size > 1 ? `${out}: ${codeStr}` : codeStr)
  }
  return codes.length ? codes.join('\n') : null
}
