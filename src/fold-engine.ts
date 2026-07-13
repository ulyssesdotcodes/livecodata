// Fold engine: a table of fold steps evaluated as exact flat-folded states.
//
// Each state is the folded 2D geometry of the sheet in one stable world
// frame: `V` holds folded coordinates, `FV` faces over shared vertex
// indices (sheet topology — welding is by index, so faces can never tear),
// `sheet` the unfolded coordinate of every vertex, `FO` the pairwise layer
// order. A step folds along a straight line drawn in that world frame:
// faces crossing the line are split, the selected flaps reflect across it,
// and the layer order of the result is solved exactly (taco/tortilla
// constraint propagation, seeded with the previous state's order) by the
// vendored flat-folder core. Between two consecutive states the motion is
// a rigid rotation of the moving flaps about the fold line: after the
// split, every edge between a moving and a static face lies ON the line,
// so the swing is a perfect compound hinge with shared vertices.
import { M } from './vendor/flatfolder/math.js'
import { X } from './vendor/flatfolder/conversion.js'
import { CON } from './vendor/flatfolder/constraints.js'
import { NOTE } from './vendor/flatfolder/note.js'
import { COMP, TYPE_LABEL } from './vendor/linefolder/compute.js'

NOTE.show = false
let conBuilt = false
const ensureCon = (): void => {
  if (!conBuilt) { CON.build(); conBuilt = true }
}

export type Vec2 = [number, number]
export type Line = [Vec2, number] // unit normal u, offset d: dot(u, x) = d
export type FaceOrder = [number, number, number]

export interface FoldState {
  V: Vec2[]             // folded coords per vertex (stable world frame)
  FV: number[][]        // faces as vertex index loops
  FO: FaceOrder[]       // pairwise layer order [f, g, ±1]
  Ff: boolean[]         // per-face parity (true = face-down)
  sheet: Vec2[]         // unfolded sheet coords per vertex
  layers: number[]      // per-face layer index for display stacking
  eps: number
}

export interface FoldSpec {
  line: Line
  move: Vec2[]          // sheet-space marker points: which flaps move
  kind?: string         // filter states by classification (TYPE_LABEL)
  pick?: number         // index among matching states (sorted, default 0)
}

export interface FoldAnim {
  Vfrom: Vec2[]         // pre-fold coords (same indexing as state.V)
  moving: boolean[]     // per face
  line: Line
  // stacking of the pre-fold state carried onto this step's faces (split
  // pieces inherit their parent's layer) — nudges interpolate from these
  layersFrom: number[]
  // which side the flap swings through: +1 = toward +z (it ends on top of
  // the paper it folds onto), -1 = behind. Voted from the solved layer
  // order over every overlapping moving/static face pair.
  dir: 1 | -1
}

export interface FoldOutcome {
  state: FoldState
  anim: FoldAnim
  type: string          // classification of the chosen state
  nStates: number       // how many valid layer orders existed
}

export class FoldError extends Error {}

export const KINDS: readonly string[] = TYPE_LABEL

export const lineThrough = (p1: Vec2, p2: Vec2): Line => {
  const len = M.dist(p1, p2)
  if (len < 1e-12) throw new FoldError('fold line needs two distinct points')
  let u = M.perp(M.div(M.sub(p2, p1), len)) as Vec2
  let d = M.dot(p1, u)
  if (d < 0) { u = M.mul(u, -1) as Vec2; d = -d }
  return [u, d]
}

const pointInPoly = (pt: Vec2, poly: Vec2[]): boolean => {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if ((yi > pt[1]) !== (yj > pt[1]) &&
        pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

const edgesOf = (FV: number[][]): [number, number][] => {
  const s = new Set<string>()
  for (const F of FV) {
    let i = F.length - 1
    for (let j = 0; j < F.length; ++j) { s.add(M.encode_order_pair([F[i], F[j]])); i = j }
  }
  return Array.from(s).sort().map((k) => M.decode(k))
}

// total display order from the pairwise order relation; undefined on cycles
const linearize = (H: Map<string, number>, n: number): number[] | undefined => {
  const Adj: number[][] = Array(n).fill(0).map(() => [])
  for (const [k, o] of H) {
    if (o !== -1) continue
    const [f1, f2] = M.decode(k)
    Adj[f1].push(f2)
  }
  const L: number[] = []
  const seen = Array(n).fill(false)
  const stack: [number, number][] = []
  for (let s = 0; s < n; ++s) {
    if (seen[s]) continue
    stack.push([s, 0])
    seen[s] = true
    while (stack.length > 0) {
      const top = stack[stack.length - 1]
      if (top[1] < Adj[top[0]].length) {
        const next = Adj[top[0]][top[1]++]
        if (!seen[next]) { seen[next] = true; stack.push([next, 0]) }
      } else {
        L.push(top[0])
        stack.pop()
      }
    }
  }
  L.reverse()
  const idx = Array(n).fill(0)
  for (let i = 0; i < n; ++i) idx[L[i]] = i
  for (const [k, o] of H) {
    if (o !== -1) continue
    const [f1, f2] = M.decode(k)
    if (idx[f1] > idx[f2]) return undefined
  }
  // topological order puts the TOP face first — invert so bigger layer =
  // higher in the stack (matches flat-folder's own per-cell display order)
  return idx.map((i) => n - 1 - i)
}

export const initialState = (corners?: Vec2[]): FoldState => {
  ensureCon()
  const V: Vec2[] = corners ?? [[0, 0], [1, 0], [1, 1], [0, 1]]
  const FV = [V.map((_, i) => i)]
  const [FOLD] = COMP.V_FV_2_FOLD_CELL(V.map((v) => [...v] as Vec2), FV)
  return {
    V: V.map((v) => [...v] as Vec2),
    FV,
    FO: [],
    Ff: FOLD.Ff,
    sheet: V.map((v) => [...v] as Vec2),
    layers: [0],
    eps: FOLD.eps,
  }
}

const MAX_STATES = 100000n

export const foldStep = (st: FoldState, spec: FoldSpec): FoldOutcome => {
  ensureCon()
  const line = spec.line
  // 1. split every face crossing the line; sheet coords interpolate along
  const [FVd, Vd, Sd, VD, F_map] = COMP.split_FOLD_on_line(
    { FV: st.FV, V: st.V, Vf: st.sheet, eps: st.eps }, line)
  // 2. flap regions bounded by the line; markers select the moving ones
  const FG = COMP.get_groups(FVd, VD) as number[]
  const clicked = new Set<number>()
  for (const m of spec.move) {
    const fi = FVd.findIndex((F: number[]) => pointInPoly(m, F.map((i) => Sd[i])))
    if (fi < 0) throw new FoldError(`move point ${m[0]},${m[1]} is outside the sheet`)
    clicked.add(FG[fi])
  }
  const FM_ = FVd.map((_: number[], i: number) => clicked.has(FG[i]))
  if (!FM_.some(Boolean)) throw new FoldError('nothing moves: no flap selected')
  if (FM_.every(Boolean)) throw new FoldError('everything moves: the fold line must cross the model')
  // 3. re-merge faces cut only in passing; reflect the moving flaps
  const FRd = COMP.EF_FM_HC_2_FR_RF(
    X.EV_FV_2_EF_FE(edgesOf(FVd), FVd)[0], FM_, new Set())[0]
  const [Vx, FVy, FM, FOO, F_map2] = COMP.filter_clicked_and_reflect(
    Vd, st.FV, FVd, F_map, FM_, st.FO, FRd)
  const [Sy] = COMP.filter_clicked_and_reflect(
    Sd, st.FV, FVd, F_map, FM_, st.FO, FRd)
  const Vy = COMP.reflect(Vx, FVy, FM, line) as Vec2[]
  // 4. solve the layer order, seeded with surviving previous orders
  const [FOLDn, CELLn] = COMP.V_FV_2_FOLD_CELL(Vy, FVy)
  const { Ff, EV, EF, FE } = FOLDn
  const { BF, BI } = CELLn
  const FOcarry: FaceOrder[] = []
  for (const [f, g, o] of st.FO) {
    for (const f_ of F_map2[f]) {
      for (const g_ of F_map2[g]) {
        if (!BI.has(M.encode_order_pair([f_, g_]))) continue
        if (!FM[f_] && !FM[g_]) FOcarry.push([f_, g_, o])
      }
    }
  }
  const BA_map = new Map<string, number>()
  for (const [f, g, o] of FOcarry) {
    const a1 = (Ff[g] === (o > 0)) ? 1 : 2
    BA_map.set(M.encode_order_pair([f, g]), (f < g) ? a1 : ((a1 === 1) ? 2 : 1))
  }
  const BA0 = BF.map((s: string) => BA_map.get(s) ?? 0)
  const [GB, GA] = COMP.solve(FOLDn, CELLn, BA0)
  if (GA === undefined) {
    throw new FoldError('no valid folded state: this fold cannot lie flat')
  }
  const n = GA.reduce((s: bigint, A: number[]) => s * BigInt(A.length), 1n)
  if (n > MAX_STATES) throw new FoldError(`too many folded states to enumerate (${n})`)
  // 5. enumerate and classify the valid states; choose by kind/pick
  const Gn = GA.map((A: number[]) => A.length)
  const GI = GA.map(() => 0)
  const found: { gi: number[]; type: number; nRF: number; ord: number }[] = []
  for (let i = 0n; i < n; ++i) {
    const edges = X.BF_GB_GA_GI_2_edges(BF, GB, GA, GI)
    const FOi = X.edges_Ff_2_FO(edges, Ff) as FaceOrder[]
    const [type, RF] = COMP.classify(Vy, EV, EF, FE, Ff, FM, FOi, FOO)
    found.push({ gi: GI.map((x: number) => x), type, nRF: RF.length, ord: found.length })
    for (let j = 0; j < GI.length; ++j) {
      if (GI[j] !== Gn[j] - 1) { GI[j] += 1; break }
      GI[j] = 0
    }
  }
  let candidates = found
  if (spec.kind !== undefined) {
    const t = TYPE_LABEL.indexOf(spec.kind)
    if (t < 0) throw new FoldError(`unknown kind "${spec.kind}" (use one of ${TYPE_LABEL.join(', ')})`)
    candidates = found.filter((s) => s.type === t)
    if (candidates.length === 0) {
      const present = [...new Set(found.map((s) => TYPE_LABEL[s.type]))].join(', ')
      throw new FoldError(`no "${spec.kind}" state here; valid kinds: ${present}`)
    }
  } else {
    const best = Math.min(...found.map((s) => s.type))
    candidates = found.filter((s) => s.type === best)
  }
  candidates.sort((a, b) => (a.nRF - b.nRF) || (a.ord - b.ord))
  const sel = candidates[Math.min(spec.pick ?? 0, candidates.length - 1)]
  const edges = X.BF_GB_GA_GI_2_edges(BF, GB, GA, sel.gi)
  const FO = X.edges_Ff_2_FO(edges, Ff) as FaceOrder[]
  const [H] = COMP.FO_Ff_EF_2_H_EA(FO, Ff, EF)
  const layers = linearize(H, Ff.length)
  if (layers === undefined) {
    throw new FoldError('chosen state has cyclic layering; try another kind/pick')
  }
  const layersFrom: number[] = FVy.map(() => 0)
  for (let f = 0; f < F_map2.length; ++f) {
    for (const f_ of F_map2[f]) layersFrom[f_] = st.layers[f]
  }
  let votes = 0
  for (const [f, g] of FO) {
    if (FM[f] === FM[g]) continue
    const mover = FM[f] ? f : g
    const still = FM[f] ? g : f
    votes += Math.sign(layers[mover] - layers[still])
  }
  const dir: 1 | -1 = votes >= 0 ? 1 : -1
  return {
    state: { V: Vy, FV: FVy, FO, Ff, sheet: Sy as Vec2[], layers, eps: FOLDn.eps },
    anim: { Vfrom: Vx as Vec2[], moving: FM, line, layersFrom, dir },
    type: TYPE_LABEL[sel.type],
    nStates: Number(n),
  }
}

// Positions of the animated fold at fraction t ∈ [0, 1]: moving flaps
// rotate about the fold line, out of plane, landing on the reflected
// position at t = 1. Returns [x, y, z] per vertex.
export const animatedPositions = (
  outcome: FoldOutcome, t: number,
): [number, number, number][] => {
  const { Vfrom, moving, line, dir } = outcome.anim
  const FV = outcome.state.FV
  const [u, d] = line
  const theta = Math.PI * Math.min(1, Math.max(0, t))
  const cos = Math.cos(theta)
  const sin = Math.sin(theta)
  const isMoving: boolean[] = Vfrom.map(() => false)
  for (let fi = 0; fi < FV.length; ++fi) {
    if (!moving[fi]) continue
    for (const vi of FV[fi]) isMoving[vi] = true
  }
  return Vfrom.map((p, vi) => {
    const h = M.dot(p, u) - d
    if (!isMoving[vi] || Math.abs(h) < 1e-12) return [p[0], p[1], 0]
    // rotate the signed distance h about the line (axis in the sheet
    // plane), swinging out on the side the flap will land on
    const hh = h * cos
    const z = dir * Math.abs(h) * sin
    return [p[0] + (hh - h) * u[0], p[1] + (hh - h) * u[1], z]
  })
}

// ── Fold table → render program ─────────────────────────────────────────────
// A fold table is the authoring surface: one row per fold. p1/p2 give the
// fold line (two points, unit-square world frame), move the sheet-space
// marker(s) of the flap(s) to fold, kind/pick disambiguate among the valid
// layer orders, at/dur schedule the swing on the beat timeline. Compiling
// runs the engine row by row and bakes everything a renderer needs into a
// plain-data program: per step the faces, pre-swing coordinates, fold line,
// moving flags and final layer indices (centered and scaled for display).

export interface FoldTableRowSpec {
  name: string
  line: Line
  move: Vec2[]
  kind?: string
  pick?: number
  at: number
  dur: number
  to: number   // terminal swing fraction: 1 = flat, 0.5 = held at 90°
}

export interface FoldProgramStep {
  name: string
  type: string
  t0: number
  t1: number
  to: number
  FV: number[][]
  Vfrom: Vec2[]      // display frame
  line: Line         // display frame
  moving: boolean[]
  layers: number[]      // stacking after this fold lands
  layersFrom: number[]  // stacking before it, on this step's face set
  dir: 1 | -1           // swing side (toward +z when the flap ends on top)
}

export interface FoldTableProgram {
  kind: 'fold-table'
  size: number
  initial: { FV: number[][]; V: Vec2[] }
  steps: FoldProgramStep[]
  end: number        // beat when the last swing lands
  // display stacking: layer index * gap = z offset; one gap for the whole
  // program so the stack never jumps between steps
  gap: number
  maxLayer: number
}

const KIND_ALIASES: Record<string, string> = {
  simple: 'Pureland', pureland: 'Pureland',
  reverse: 'Inside Reverse', inside: 'Inside Reverse',
  'inside reverse': 'Inside Reverse', outside: 'Outside Reverse',
  'outside reverse': 'Outside Reverse', 'mixed reverse': 'Mixed Reverse',
  'open sink': 'Open Sink', 'closed sink': 'Closed Sink',
  'mixed sink': 'Mixed Sink', sink: 'Open Sink', complex: 'Complex',
}

const parsePoint = (v: unknown, what: string, name: string): Vec2 => {
  const parts = String(v).split(',').map((s) => Number(s.trim()))
  if (parts.length !== 2 || parts.some((x) => !Number.isFinite(x))) {
    throw new FoldError(`step "${name}": ${what} must be "x,y", got ${JSON.stringify(v)}`)
  }
  return parts as Vec2
}

// Editable tables materialize every schema column, so unset cells arrive
// as "" (string columns) or non-numbers — treat those as absent, never as
// values (Number("") is 0, which would silently zero a fold's timing).
const strAt = (r: Record<string, unknown>, key: string): string | undefined => {
  const v = r[key]
  if (v == null) return undefined
  const s = String(v).trim()
  return s === '' ? undefined : s
}
const numAt = (r: Record<string, unknown>, key: string): number | undefined => {
  const v = r[key]
  if (v == null || (typeof v === 'string' && v.trim() === '')) return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}
// number columns default to 0 in the table panel, and 0 is meaningless for
// these (a fold at beat 0, a zero-length swing, a fold that doesn't move) —
// so non-positive means unset too
const posAt = (r: Record<string, unknown>, key: string): number | undefined => {
  const n = numAt(r, key)
  return n !== undefined && n > 0 ? n : undefined
}

export const parseFoldRows = (rows: Record<string, unknown>[]): FoldTableRowSpec[] => {
  const specs: FoldTableRowSpec[] = []
  rows.forEach((r, i) => {
    if (r == null) return
    const name = strAt(r, 'step') ?? `fold${i + 1}`
    const p1raw = strAt(r, 'p1')
    const p2raw = strAt(r, 'p2')
    if (p1raw === undefined || p2raw === undefined) {
      throw new FoldError(`step "${name}": needs p1 and p2 ("x,y") for its fold line`)
    }
    const p1 = parsePoint(p1raw, 'p1', name)
    const p2 = parsePoint(p2raw, 'p2', name)
    const moveRaw = strAt(r, 'move')
    if (moveRaw === undefined) throw new FoldError(`step "${name}": needs move ("x,y" sheet points, ";"-separated)`)
    const move = moveRaw.split(';').map((m) => parsePoint(m, 'move', name))
    let kind: string | undefined
    const kindRaw = strAt(r, 'kind')
    if (kindRaw !== undefined) {
      kind = KINDS.includes(kindRaw) ? kindRaw : KIND_ALIASES[kindRaw.toLowerCase()]
      if (kind === undefined) {
        throw new FoldError(`step "${name}": unknown kind "${kindRaw}" (try simple, reverse, sink, …)`)
      }
    }
    const at = posAt(r, 'at') ?? specs.length + 1
    const dur = posAt(r, 'dur') ?? 0.75
    const to = Math.min(1, posAt(r, 'to') ?? 1)
    specs.push({
      name, line: lineThrough(p1, p2), move,
      kind, pick: numAt(r, 'pick'),
      at, dur, to,
    })
  })
  return specs
}

export const compileFoldTable = (
  rows: Record<string, unknown>[], opts: { size?: number } = {},
): FoldTableProgram => {
  const size = opts.size ?? 1
  const scale = 2 * size
  const toDisplay = (p: Vec2): Vec2 => [(p[0] - 0.5) * scale, (p[1] - 0.5) * scale]
  const lineToDisplay = ([u, d]: Line): Line => [u, (d - (u[0] + u[1]) * 0.5) * scale]
  const specs = parseFoldRows(rows)
  let st = initialState()
  const initial = { FV: st.FV.map((F) => [...F]), V: st.V.map(toDisplay) }
  const steps: FoldProgramStep[] = []
  for (const spec of specs) {
    let out: FoldOutcome
    try {
      out = foldStep(st, spec)
    } catch (e) {
      if (e instanceof FoldError) throw new FoldError(`step "${spec.name}": ${e.message}`)
      throw e
    }
    steps.push({
      name: spec.name,
      type: out.type,
      t0: spec.at,
      t1: spec.at + spec.dur,
      to: spec.to,
      FV: out.state.FV.map((F) => [...F]),
      Vfrom: out.anim.Vfrom.map(toDisplay),
      line: lineToDisplay(out.anim.line),
      moving: out.anim.moving,
      layers: out.state.layers,
      layersFrom: out.anim.layersFrom,
      dir: out.anim.dir,
    })
    st = out.state
  }
  for (let i = 1; i < steps.length; ++i) {
    if (steps[i].t0 < steps[i - 1].t1 - 1e-9) {
      throw new FoldError(`step "${steps[i].name}": starts at beat ${steps[i].t0} before step "${steps[i - 1].name}" lands at ${steps[i - 1].t1} — folds happen one at a time`)
    }
  }
  for (let i = 0; i < steps.length - 1; ++i) {
    if (steps[i].to < 1) {
      throw new FoldError(`step "${steps[i].name}": only the last step may stop short of flat (to < 1)`)
    }
  }
  let maxLayer = 1
  for (const step of steps) {
    for (const l of step.layers) maxLayer = Math.max(maxLayer, l)
  }
  return {
    kind: 'fold-table', size, initial, steps,
    end: steps.length > 0 ? steps[steps.length - 1].t1 : 1,
    gap: (STACK_DEPTH * size) / maxLayer,
    maxLayer,
  }
}

// total thickness of the whole layer stack, relative to the paper size —
// each layer gets an equal slice, so deep models stay visually thin
const STACK_DEPTH = 0.05

// Fold-progress value → per-vertex [x, y, z] positions plus the face set to
// draw. fold = k + t means step k+1 is mid-swing at fraction t; whole
// numbers are the exact flat states. Every renderer (three.js, tests)
// consumes this one function.
export const foldTablePositions = (
  program: FoldTableProgram, fold: number,
): { FV: number[][]; pos: [number, number, number][]; moving: boolean[]; zOff: number[] } => {
  const N = program.steps.length
  const mid = program.maxLayer / 2
  if (N === 0 || fold <= 0) {
    return {
      FV: program.initial.FV,
      pos: program.initial.V.map((p) => [p[0], p[1], 0]),
      moving: program.initial.FV.map(() => false),
      zOff: program.initial.FV.map(() => program.gap * (0 - mid)),
    }
  }
  const k = Math.min(Math.floor(fold), N - 1)
  const t = Math.min(1, Math.max(0, fold - k))
  const step = program.steps[k]
  const [u, d] = step.line
  const theta = Math.PI * t
  const cos = Math.cos(theta)
  const sin = Math.sin(theta)
  const isMoving: boolean[] = step.Vfrom.map(() => false)
  for (let fi = 0; fi < step.FV.length; ++fi) {
    if (!step.moving[fi]) continue
    for (const vi of step.FV[fi]) isMoving[vi] = true
  }
  const pos: [number, number, number][] = step.Vfrom.map((p, vi) => {
    const h = p[0] * u[0] + p[1] * u[1] - d
    if (!isMoving[vi] || Math.abs(h) < 1e-12) return [p[0], p[1], 0]
    const hh = h * cos
    return [p[0] + (hh - h) * u[0], p[1] + (hh - h) * u[1], step.dir * Math.abs(h) * sin]
  })
  // each face's display height eases from where its paper sat before this
  // fold to where it ends up, so consecutive steps join without a jump
  const zOff = step.FV.map((_, fi) =>
    program.gap * (step.layersFrom[fi] + (step.layers[fi] - step.layersFrom[fi]) * t - mid))
  return { FV: step.FV, pos, moving: step.moving, zOff }
}

// The fold value a beat-timed schedule reaches at a given beat — steps swing
// during [t0, t1] and hold in between.
export const foldValueAt = (program: FoldTableProgram, beat: number): number => {
  let v = 0
  for (let i = 0; i < program.steps.length; ++i) {
    const { t0, t1, to } = program.steps[i]
    if (beat <= t0) break
    v = i + to * Math.min(1, (beat - t0) / (t1 - t0))
  }
  return v
}
