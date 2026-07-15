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
//                      "src(s0).modulate(noise(2))" (s0 is the rendered Three.js
//                      scene). The terminal `.out(oN)` is appended for you from
//                      the `out` column (o0 by default), so the code needn't
//                      write it — an explicit `.out(...)` is normalised to the
//                      column's output.
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
//   - "setSource"   : swaps the head of the chain — the leading generator, e.g.
//                      src(s0) or osc(20) — for `code`, keeping every effect
//                      after it. Repoint a sketch at a new source (or bring the
//                      new source's own leading effects with it) without
//                      restating the chain that follows.
//   - "append"      : appends `code` — a chain fragment starting with a dot,
//                      e.g. ".modulate(noise(3), 0.2)" — to the end of the
//                      current chain, just before its `.out()`. Grows the
//                      effect chain one link at a time.
//   - "layer"       : composites `code` (another full sketch) over the current
//                      one with a hydra blend operator named by `mode` — one of
//                      blend / add / mult (which also take an amount) or diff /
//                      layer / mask (which don't). `mode` defaults to blend (a
//                      lerp crossfade). For the amount-taking modes, `value` is
//                      an optional constant, or a string expression evaluated
//                      fresh every frame with `props` in scope (e.g. "props.mix"
//                      or "Math.sin(props.time)") so the amount can be driven
//                      live from a setVariable, a slider, or hydra's own time.
//   - "transition"  : wipes from the program built up so far (the "before",
//                      layers and all) to the program built up after it (the
//                      "after") over `value` beats, using `code` as a MASK: where
//                      the mask is black the before shows, where it's white the
//                      after shows (composited through the mask's luminance). The
//                      mask is the USER's sketch and the user animates it from all
//                      black to all white across the window however they like — a
//                      wipe, a dissolve, an iris. To drive it, three names are in
//                      scope inside the mask code: `transitionStart` and
//                      `transitionEnd` (the window bounds in `props.time` units)
//                      and `transitionPos(t)` (that time normalised to 0 → 1 over
//                      the window, clamped) — e.g. a plain fade is
//                      `solid().luma((props) => 1 - transitionPos(props.time))`.
//                      transitionPos reads hydra's own playback clock, so the
//                      wipe is beat-aligned, tempo-independent, and pauses/scrubs
//                      with the timeline; the window bounds bake as constants, so
//                      the sketch string stays byte-stable and nothing recompiles
//                      per frame. The before is snapshotted at the transition's
//                      beat; the after is the output's live program, so you build
//                      the destination with ordinary events placed at the same
//                      beat (just after the transition): setCode to cut to a new
//                      program (code/transition/code), a layer to reveal an
//                      overlay (code/transition/layer), and so on. When the window
//                      elapses the wipe collapses to just the after program (like
//                      setCode replacing old code), so it leaves nothing behind.
//                      With no `code`, it falls back to a plain crossfade. Once a
//                      transition is present the output is retargeted to its
//                      `.out(oN)` (see the `output` column) so the before and
//                      after composite cleanly.
//
// The `out` column names the hydra output a row drives — o0 (the visible output)
// by default, or o1/o2/… to build a multi-output program. It is also the
// terminal `.out(oN)` the fold appends to each output's program, so no event's
// code has to write its own `.out(...)`. Events fold PER OUTPUT: each output's
// rows evolve their own running code string, wholly independent of the other
// outputs', and the sampled sketch is every output's program concatenated (each
// ending in its own `.out(oN)`). So a transition on o0 blends only o0's
// before/after, an osc rendered to o1 can be read back as src(o1) from o0, and
// the single-output tables that predate the column keep folding as before
// (everything defaults to o0).
//
// Sampling at a frame folds every event seen at/before it in order: setCode/
// setSource/append/replace/layer/transition evolve one running code string per
// output, and setVariable folds into the most-recent value of each named
// variable. So both the sketch and the
// values driving it are plain table data the user can inspect and wire up from
// the rest of the dataflow (physics, beats, math, …). Because a new variable is
// just rows carrying a new `name`, not a new table column, adding one doesn't
// require widening the schema — see editable-tables.ts's `ensure()` for why
// that matters. This module is pure (no hydra-ts / DOM dependency); the actual
// GPU rendering lives in hydra-scene.ts.
// ----------------------------------------------------------------------------

import { beatToFrame, beatsToFrames, FPS } from './constants.js'
import type { Row } from './lineage.js'

export interface HydraFrame {
  // The sketch source to evaluate (ends in .out()).
  code: string
  // Variable name → value, injected into the sketch's scope.
  vars: Record<string, unknown>
}

// The event kinds a hydra table understands: the two sketch/value events plus
// the meta-programming transforms that rewrite the accumulated code.
const HYDRA_EVENTS = new Set(['setCode', 'setVariable', 'setSource', 'replace', 'append', 'layer', 'transition'])

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

// Split a sketch into its head generator call and the rest of the chain. The
// head is the leading `identifier(...)` (balanced parens — so args with nested
// calls, decimals, or `(props) => …` arrows split cleanly); the rest is
// everything after it (the `.method(...)…out()` tail, or empty). Best-effort,
// for the single-chain sketches these tables hold: a head with no call, or
// unbalanced parens, yields the whole string as the head and an empty rest.
function splitHead(code: string): [string, string] {
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

// Hydra's compositing operators a `layer` event can pick via `mode`, mapped to
// whether each takes an amount (blend/add/mult crossfade or scale; diff/layer/
// mask don't). The keys double as the enum options offered in the table.
const BLEND_OPS: Record<string, boolean> = {
  blend: true, add: true, mult: true, diff: false, layer: false, mask: false,
}
export const HYDRA_BLEND_MODES: string[] = Object.keys(BLEND_OPS)

// Whether a `value` cell carries a usable amount (vs. an unset/blank cell), so a
// `layer` in an amount-taking mode only emits the extra argument when one's set,
// otherwise leaning on the operator's own hydra default.
function hasAmount(value: unknown): boolean {
  return (typeof value === 'number' && Number.isFinite(value))
    || (typeof value === 'string' && value.trim() !== '')
}

// Render a `layer` amount. A finite number (or numeric string) becomes a
// literal; any other string is an expression evaluated per frame with `props`
// in scope — used verbatim if it's already a function (contains `=>`), else
// wrapped into `(props) => (…)`.
function amountExpr(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  const s = typeof value === 'string' ? value.trim() : ''
  if (s === '') return '0.5'
  const n = Number(s)
  if (!Number.isNaN(n)) return String(n)
  return s.includes('=>') ? `(${s})` : `(props) => (${s})`
}

// The hydra output a row drives: o0 (the visible output) unless the `out` cell
// names another (o1, o2, …). Anything that isn't an `o`+digits token falls back
// to o0, so a blank or malformed cell behaves like the default. This is also the
// terminal `.out(oN)` the fold appends, so a setCode's code never has to write
// its own `.out(...)`.
const OUTPUT_RE = /^o\d+$/
function outputOf(row: Row): string {
  const o = typeof row.out === 'string' ? row.out.trim() : ''
  return OUTPUT_RE.test(o) ? o : 'o0'
}

// A `transition` snapshotted mid-fold: the `before` chain (frozen at the
// transition's beat), its `mask` sketch (or '' for a plain crossfade), and the
// grid-frame window (`startFrame`, `durFrames`) the wipe animates across. The
// window is exposed to the mask sketch in `props.time` units (seconds — see
// hydra-scene.ts, which drives props.time as srcFrameF / FPS): `transitionStart`
// = startFrame / FPS, `transitionEnd` = (startFrame + durFrames) / FPS, and
// `transitionPos(t)` normalises a time to 0 → 1 across them, clamped. These bake
// as constants, so the mask animates on hydra's own clock (beat-aligned,
// tempo-independent) without the string changing per frame; when the window
// elapses the fold drops the transition (see foldOutput) and the string
// collapses to the bare after program.
interface Transition {
  before: string
  mask: string
  startFrame: number
  durFrames: number
}

// The window bounds a transition exposes to its mask sketch, in `props.time`
// (seconds) units, plus the `transitionPos(t)` helper that normalises a time to
// 0 → 1 across them (clamped) — the tools the user drives the black→white mask
// with.
function transitionWindow(t: Transition): { start: number; end: number; posFn: string } {
  const start = t.startFrame / FPS
  const dur = t.durFrames / FPS
  return {
    start,
    end: start + dur,
    posFn: `(t) => Math.min(Math.max((t - ${start}) / ${dur}, 0), 1)`,
  }
}

// Fold one output's events (already sorted, filtered to this output) into its
// running code string, exactly like the single-output fold used to: setCode
// replaces it, setSource/append/replace/layer transform it, transition records
// a wipe to apply at the end, and setVariable folds into the shared `vars`.
// Returns null until a setCode is reached (nothing to show yet); with no
// transitions the string is returned untouched, so pre-existing single-o0
// tables fold byte-for-byte as before.
function foldOutput(
  rows: Row[], frame: number, loop: number, output: string,
  vars: Record<string, unknown>,
): string | null {
  let code: string | null = null
  const transitions: Transition[] = []
  for (const row of rows) {
    const l = (row.loop as number | undefined) ?? 0
    if (l > loop || (l === loop && (row.index as number) > frame)) break
    switch (row.event) {
      case 'setCode':
        if (typeof row.code === 'string') code = row.code
        break
      case 'setVariable':
        if (typeof row.name === 'string') vars[row.name] = row.value
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
        // Extend the chain with a `.method(...)` fragment, before its `.out()`.
        if (code != null && typeof row.code === 'string' && row.code.trim() !== '') {
          code = `${chainOf(code)}${row.code.trim()}.out(${output})`
        }
        break
      case 'layer':
        // Composite another sketch over the current one with the chosen blend
        // operator (default blend), adding an amount only for the modes that
        // take one and only when a `value` is set.
        if (code != null && typeof row.code === 'string' && row.code.trim() !== '') {
          const mode = typeof row.mode === 'string' && row.mode in BLEND_OPS ? row.mode : 'blend'
          const amt = BLEND_OPS[mode] && hasAmount(row.value) ? `, ${amountExpr(row.value)}` : ''
          code = `${chainOf(code)}.${mode}(${chainOf(row.code.trim())}${amt}).out(${output})`
        }
        break
      case 'transition': {
        // Snapshot the current program as the "before" and remember the wipe;
        // it's applied to the final "after" (the code that keeps folding after
        // it) once the whole output is folded. A no-op with nothing to wipe yet.
        // Only while the window is still live: once it has fully elapsed the
        // wipe is done, so we drop it and let the "after" stand alone — the same
        // way a new setCode replaces the old code rather than layering over it
        // forever (which would also pile finished wipes up without bound).
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

  // Apply the wipes from the innermost (latest) out: the final program is the
  // last transition's "after", and each earlier transition blends its own
  // frozen "before" over the wipe that follows it — so nested transitions
  // compose in beat order, the earliest wrapping all the later ones. Strip any
  // `.out(...)` the code carries first (chainOf); the terminal output is
  // (re)appended once below from the `out` column.
  let result = chainOf(code)
  for (let i = transitions.length - 1; i >= 0; i--) {
    const t = transitions[i]
    const { start, end, posFn } = transitionWindow(t)
    if (t.mask !== '') {
      // Composite before (mask black) under after (mask white) through the
      // mask's luminance. The mask is the user's own sketch, animated from black
      // to white across the window using the transitionStart/End/Pos we bind
      // around it — so they choose the wipe, we just wire the clock in.
      const mask = `((transitionStart, transitionEnd, transitionPos) => (${chainOf(t.mask)}))(${start}, ${end}, ${posFn})`
      result = `${t.before}.layer((${result}).mask(${mask}))`
    } else {
      // No mask → a plain crossfade over the same window.
      result = `${t.before}.blend((${result}), (props) => (${posFn})(props.time))`
    }
  }
  // Terminate on the `out` column's output, so a setCode's code never needs its
  // own `.out(...)` (and an explicit one is normalised to the column's choice).
  return `${result}.out(${output})`
}

// The active sketch at frame `f` of loop pass `loop`: every output's events from
// earlier passes in full, plus this pass's events at/before f, folded in order
// (see foldOutput) into one running code string PER output, then concatenated
// (each output ends in its own `.out(oN)`). setCode replaces an output's code;
// setSource/append/replace/layer transform it; transition wipes to the after
// program; setVariable folds into the most-recent value of each named variable
// (later events override earlier ones, so a row can change just one variable
// while the sketch stays put). Returns null until some output reaches a setCode
// event — playback then falls back to showing the raw scene.
export function hydraFrameAt(index: Row[], f: number, loop = 0): HydraFrame | null {
  const frame = Math.floor(f)
  if (frame < 0) return null
  // Split the (already (loop, frame)-sorted) rows into per-output streams,
  // preserving order; fold each independently and concatenate in output-name
  // order for a stable, deterministic program.
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
    const code = foldOutput(groups.get(out)!, frame, loop, out, vars)
    if (code != null) codes.push(code)
  }
  return codes.length === 0 ? null : { code: codes.join('\n'), vars }
}

// The compiled sketch as of one table row: every hydra event folded in order up
// to and INCLUDING the row at `rowIndex` in the raw `rows` array (an editable
// hydra table's current fold), exactly as it would render at that event's beat.
// Returns null when that row isn't a hydra event, or when no setCode has
// established any code yet by that point. Unlike sampling a frame, this stops at
// the row itself — so two events on the same beat show the running code after
// each in turn, not just the beat's end state. Powers the table panel's per-row
// "compiled code" info popover.
export function hydraCodeUpToRow(rows: Row[] | null | undefined, rowIndex: number): string | null {
  const all = rows ?? []
  if (!isHydraRow(all[rowIndex])) return null
  // Tag rows with their original position so the target is findable after the
  // (loop, frame) sort, then fold only the prefix up to and including it.
  const index = buildHydraIndex(all.map((row, i) => ({ ...row, __row: i })))
  const pos = index.findIndex((r) => (r as { __row?: number }).__row === rowIndex)
  if (pos < 0) return null
  const at = index[pos]
  return hydraFrameAt(index.slice(0, pos + 1), at.index as number, at.loop as number)?.code ?? null
}
