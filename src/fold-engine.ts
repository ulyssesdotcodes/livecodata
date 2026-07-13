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
import { buildSoftMesh, bakeSoftMotion, pickPinned, FLAT_ANGLE } from './fold-relax.js'

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
  // rotation sense per face (0 for static faces): each connected flap is
  // one rigid body and gets ONE sense, voted from the solved layer order
  // over its overlapping moving/static face pairs so it swings out on the
  // side it lands on. Independent flaps in one step (e.g. both wings) can
  // swing to opposite sides.
  dirs: number[]
  // the crease network for the soft solver: every edge of the face graph
  // with its dihedral target before and after this fold (0 flat, ±FLAT
  // folded — sign in the sheet's material frame)
  EV: [number, number][]
  angleFrom: number[]
  angleTo: number[]
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
  const [H, EAto] = COMP.FO_Ff_EF_2_H_EA(FO, Ff, EF)
  const layers = linearize(H, Ff.length)
  if (layers === undefined) {
    throw new FoldError('chosen state has cyclic layering; try another kind/pick')
  }
  const layersFrom: number[] = FVy.map(() => 0)
  for (let f = 0; f < F_map2.length; ++f) {
    for (const f_ of F_map2[f]) layersFrom[f_] = st.layers[f]
  }
  const dirs = flapDirs(FVy, Vx as Vec2[], FM, line, FO, layers)
  // dihedral targets: the start state's angles come from the carried-over
  // orders (FOO) with the movers' parity mirrored (they haven't reflected
  // yet); the end state's from the solved orders. Empirically calibrated:
  // a valley ('V') is a NEGATIVE dihedral in the solver's convention.
  const FfFrom = Ff.map((f: boolean, fi: number) => FM[fi] ? !f : f)
  const EAfrom = COMP.FO_Ff_EF_2_H_EA(FOO, FfFrom, EF)[1] as string[]
  const angleOf = (ea: string): number =>
    ea === 'V' ? -FLAT_ANGLE : ea === 'M' ? FLAT_ANGLE : 0
  return {
    state: { V: Vy, FV: FVy, FO, Ff, sheet: Sy as Vec2[], layers, eps: FOLDn.eps },
    anim: {
      Vfrom: Vx as Vec2[], moving: FM, line, layersFrom, dirs,
      EV: FOLDn.EV as [number, number][],
      angleFrom: EAfrom.map(angleOf),
      angleTo: (EAto as string[]).map(angleOf),
    },
    type: TYPE_LABEL[sel.type],
    nStates: Number(n),
  }
}

// One rigid rotation sense per connected flap. Faces sharing a vertex are
// one rigid body; each flap's sense is voted from where its faces land in
// the solved stacking: a flap that ends on top must swing out toward +z,
// which for a face starting on side s of the line means sense = s.
const flapDirs = (
  FV: number[][], Vfrom: Vec2[], moving: boolean[], line: Line,
  FO: FaceOrder[], layers: number[],
): number[] => {
  const [u, d] = line
  const n = FV.length
  // union-find over moving faces sharing any vertex
  const comp = Array.from({ length: n }, (_, i) => i)
  const find = (i: number): number => {
    while (comp[i] !== i) { comp[i] = comp[comp[i]]; i = comp[i] }
    return i
  }
  const byVertex = new Map<number, number>()
  for (let fi = 0; fi < n; ++fi) {
    if (!moving[fi]) continue
    for (const vi of FV[fi]) {
      const other = byVertex.get(vi)
      if (other === undefined) byVertex.set(vi, fi)
      else comp[find(fi)] = find(other)
    }
  }
  const side = (fi: number): number => {
    let sum = 0
    for (const vi of FV[fi]) sum += Vfrom[vi][0] * u[0] + Vfrom[vi][1] * u[1] - d
    return Math.sign(sum)
  }
  const votes = new Map<number, number>()
  for (const [f, g] of FO) {
    if (moving[f] === moving[g]) continue
    const mover = moving[f] ? f : g
    const still = moving[f] ? g : f
    const c = find(mover)
    votes.set(c, (votes.get(c) ?? 0) +
      Math.sign(layers[mover] - layers[still]) * side(mover))
  }
  return FV.map((_, fi) => {
    if (!moving[fi]) return 0
    const v = votes.get(find(fi)) ?? 0
    return v >= 0 ? 1 : -1
  })
}

// Positions of the animated fold at fraction t ∈ [0, 1]: moving flaps
// rotate about the fold line, out of plane, landing on the reflected
// position at t = 1. Returns [x, y, z] per vertex.
export const animatedPositions = (
  outcome: FoldOutcome, t: number,
): [number, number, number][] => {
  const { Vfrom, moving, line, dirs } = outcome.anim
  const FV = outcome.state.FV
  const [u, d] = line
  const theta = Math.PI * Math.min(1, Math.max(0, t))
  const cos = Math.cos(theta)
  const sin = Math.sin(theta)
  const sense: number[] = Vfrom.map(() => 0)
  for (let fi = 0; fi < FV.length; ++fi) {
    if (!moving[fi]) continue
    for (const vi of FV[fi]) sense[vi] = dirs[fi]
  }
  return Vfrom.map((p, vi) => {
    const h = M.dot(p, u) - d
    if (sense[vi] === 0 || Math.abs(h) < 1e-12) return [p[0], p[1], 0]
    // one rigid rotation per flap about the line (axis in the sheet
    // plane), swinging out on the side the flap will land on
    const hh = h * cos
    return [p[0] + (hh - h) * u[0], p[1] + (hh - h) * u[1], sense[vi] * h * sin]
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
  dirs: number[]        // rotation sense per face (0 = static); each flap
                        // swings out on the side it lands on
  // baked soft motion (reverse folds, sinks, …): keyframed vertex
  // positions from the compliant solver, display frame, flattened
  // [frame][vertex][xyz]. Simple folds stay on the rigid swing.
  soft?: { frames: number; pos: number[] }
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
      dirs: out.anim.dirs,
      // simple folds keep the crisp rigid hinge; so do held folds
      // (to < 1) — their whole point is the displayed pose, which must be
      // the exact mirrored geometry, not a solver mid-frame
      soft: out.type === 'Pureland' || spec.to < 1 ? undefined : bakeStep(out, scale),
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

// Bake the compliant in-between motion for one non-simple step: the mesh
// relaxes from the flat start (seeded a hair along each flap's rigid
// swing, so every flap breaks symmetry toward the side it lands on) while
// the crease targets ramp to the end state's angles. Positions come out
// in the display frame, flattened [frame][vertex][xyz].
const SOFT_FRAMES = 16

const bakeStep = (out: FoldOutcome, scale: number): { frames: number; pos: number[] } => {
  const { FV, sheet } = out.state
  const { Vfrom, moving, line, dirs, EV, angleFrom, angleTo } = out.anim
  const [EF] = X.EV_FV_2_EF_FE(EV, FV)
  const mesh = buildSoftMesh(FV, sheet, EV, EF, angleFrom, angleTo,
    pickPinned(FV, sheet, moving))
  const seed = new Float64Array(sheet.length * 3)
  const [u, d] = line
  const theta = Math.PI * 0.05
  const sense: number[] = sheet.map(() => 0)
  for (let fi = 0; fi < FV.length; ++fi) {
    if (!moving[fi]) continue
    for (const vi of FV[fi]) sense[vi] = dirs[fi]
  }
  Vfrom.forEach((p, vi) => {
    const h = p[0] * u[0] + p[1] * u[1] - d
    if (sense[vi] === 0 || Math.abs(h) < 1e-12) {
      seed[vi * 3] = p[0]; seed[vi * 3 + 1] = p[1]; seed[vi * 3 + 2] = 0
    } else {
      const hh = h * Math.cos(theta)
      seed[vi * 3] = p[0] + (hh - h) * u[0]
      seed[vi * 3 + 1] = p[1] + (hh - h) * u[1]
      seed[vi * 3 + 2] = sense[vi] * h * Math.sin(theta)
    }
  })
  const baked = bakeSoftMotion(mesh, seed, { frames: SOFT_FRAMES, iterations: 800 })
  const pos: number[] = []
  for (const frame of baked) {
    for (let vi = 0; vi < sheet.length; ++vi) {
      pos.push((frame[vi * 3] - 0.5) * scale, (frame[vi * 3 + 1] - 0.5) * scale, frame[vi * 3 + 2] * scale)
    }
  }
  return { frames: baked.length, pos }
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

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
  const sense: number[] = step.Vfrom.map(() => 0)
  for (let fi = 0; fi < step.FV.length; ++fi) {
    if (!step.moving[fi]) continue
    for (const vi of step.FV[fi]) sense[vi] = step.dirs[fi]
  }
  const rigid = (vi: number, theta2: number): [number, number, number] => {
    const p = step.Vfrom[vi]
    const h = p[0] * u[0] + p[1] * u[1] - d
    if (sense[vi] === 0 || Math.abs(h) < 1e-12) return [p[0], p[1], 0]
    const hh = h * Math.cos(theta2)
    return [p[0] + (hh - h) * u[0], p[1] + (hh - h) * u[1], sense[vi] * h * Math.sin(theta2)]
  }
  let pos: [number, number, number][]
  if (step.soft !== undefined) {
    // sample the baked compliant motion, easing the residuals into the
    // exact endpoint geometry at both ends of the swing
    const { frames, pos: P } = step.soft
    const nv = step.Vfrom.length
    const x = t * (frames - 1)
    const f0 = Math.min(frames - 1, Math.floor(x))
    const f1 = Math.min(frames - 1, f0 + 1)
    const fx = x - f0
    const a = 1 - smooth(0, 0.15, t)
    const b = smooth(0.85, 1, t)
    pos = step.Vfrom.map((_, vi) => {
      const out: [number, number, number] = [0, 0, 0]
      const start = rigid(vi, 0)
      const end = rigid(vi, Math.PI)
      for (let c = 0; c < 3; ++c) {
        const baked = P[(f0 * nv + vi) * 3 + c] * (1 - fx) + P[(f1 * nv + vi) * 3 + c] * fx
        out[c] = baked +
          a * (start[c] - P[vi * 3 + c]) +
          b * (end[c] - P[((frames - 1) * nv + vi) * 3 + c])
      }
      return out
    })
  } else {
    pos = step.Vfrom.map((_, vi) => rigid(vi, theta))
  }
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
