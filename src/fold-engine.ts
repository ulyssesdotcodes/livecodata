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
import { buildReverseMech, reverseRecordOf, type ReverseRecord } from './fold-mech.js'
import { bakedMotionDepth } from './tri-clearance.js'

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

// total display order from the pairwise order relation; undefined on
// cycles. The relation is partial — where it leaves freedom, prefer the
// carried previous ranks (prio) so faces never swap display layers
// between steps without a solved reason; gratuitous swaps make offset
// paths cross mid-swing and shimmer.
const linearize = (H: Map<string, number>, n: number, prio: number[]): number[] | undefined => {
  const Adj: number[][] = Array(n).fill(0).map(() => [])
  const inDeg = Array(n).fill(0)
  for (const [k, o] of H) {
    if (o !== -1) continue
    const [f1, f2] = M.decode(k)
    Adj[f1].push(f2)
    inDeg[f2]++
  }
  // Kahn's, top face first: among the available faces always take the one
  // that used to sit highest
  const idx = Array(n).fill(-1)
  const done = Array(n).fill(false)
  for (let i = 0; i < n; ++i) {
    let pick = -1
    for (let f = 0; f < n; ++f) {
      if (done[f] || inDeg[f] > 0) continue
      if (pick < 0 || prio[f] > prio[pick] || (prio[f] === prio[pick] && f < pick)) pick = f
    }
    if (pick < 0) return undefined // cycle
    idx[pick] = i
    done[pick] = true
    for (const g of Adj[pick]) inDeg[g]--
  }
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

// A crease without a fold: cut every ply along the line, keep the
// geometry exactly as it is. This is origami pre-creasing — it gives the
// paper hinge lines that later folds (and the soft solver) bend along.
export const creaseStep = (st: FoldState, line: Line): FoldState => {
  ensureCon()
  const [FVd, Vd, Sd, , F_map] = COMP.split_FOLD_on_line(
    { FV: st.FV, V: st.V, Vf: st.sheet, eps: st.eps }, line)
  const [FOLDn, CELLn] = COMP.V_FV_2_FOLD_CELL(Vd, FVd)
  const FO = COMP.map_order(CELLn.BI, F_map, st.FO) as FaceOrder[]
  const layers: number[] = FVd.map(() => 0)
  for (let parent = 0; parent < F_map.length; ++parent) {
    for (const piece of F_map[parent]) layers[piece] = st.layers[parent]
  }
  return {
    V: Vd as Vec2[], FV: FVd, FO, Ff: FOLDn.Ff,
    sheet: Sd as Vec2[], layers, eps: FOLDn.eps,
  }
}

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
  const layersFrom: number[] = FVy.map(() => 0)
  for (let f = 0; f < F_map2.length; ++f) {
    for (const f_ of F_map2[f]) layersFrom[f_] = st.layers[f]
  }
  const layers = linearize(H, Ff.length, layersFrom)
  if (layers === undefined) {
    throw new FoldError('chosen state has cyclic layering; try another kind/pick')
  }
  // the hinge invariant: every vertex shared by a moving and a static face
  // must lie ON the fold line — otherwise reflecting the flap stretches
  // the static paper it stays attached to (an invalid fold the layer
  // solver cannot see: the states stay flat, but only by tearing the
  // sheet's isometry). Fail loudly instead of folding wrong silently.
  {
    const onMoving: boolean[] = Vx.map(() => false)
    const onStatic: boolean[] = Vx.map(() => false)
    FVy.forEach((F: number[], fi: number) => {
      for (const vi of F) {
        if (FM[fi]) onMoving[vi] = true
        else onStatic[vi] = true
      }
    })
    const [u, d] = line
    for (let vi = 0; vi < Vx.length; ++vi) {
      if (!onMoving[vi] || !onStatic[vi]) continue
      const off = Math.abs(Vx[vi][0] * u[0] + Vx[vi][1] * u[1] - d)
      if (off > 1e-6) {
        throw new FoldError(
          `the selected flap's hinge leaves the fold line by ${off.toFixed(3)} — ` +
          'the paper would stretch; move the line through the flap\'s corner ' +
          'or pick a different flap')
      }
    }
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
  crease: boolean  // kind "crease": cut only, nothing folds, no timeline slot
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
  // baked motion (reverse folds, sinks, …): keyframed vertex positions,
  // display frame, flattened [frame][vertex][xyz]. Simple folds stay on
  // the rigid swing. Mechanism bakes also carry zDirs — each face's
  // layer-offset direction per frame ([frame][face][xyz]), the world ẑ
  // carried along by the face's rigid assembly so the display stack rides
  // the paper instead of shearing through it when assemblies stand up.
  soft?: { frames: number; pos: number[]; zDirs?: number[] }
  // folding on a table: the display parity before and after this step.
  // A step whose fold acts on the underside turns the model over first
  // (flipTo ≠ flipFrom — the flip animates in the step's opening window),
  // so the working side always faces up and the back stays flat.
  flipFrom: number
  flipTo: number
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
  // the paper direction that displays as the viewer's vertical (set by
  // spawn from the object's rz): turn-overs rotate about this axis so the
  // model mirrors left-right on screen instead of tumbling. Default [0,1].
  flipAxis?: Vec2
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

const isCrease = (r: Record<string, unknown>): boolean =>
  (strAt(r, 'kind') ?? '').toLowerCase() === 'crease'

export const parseFoldRows = (rows: Record<string, unknown>[]): FoldTableRowSpec[] => {
  const specs: FoldTableRowSpec[] = []
  let foldCount = 0
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
    if (moveRaw === undefined && !isCrease(r)) {
      throw new FoldError(`step "${name}": needs move ("x,y" sheet points, ";"-separated)`)
    }
    const move = (moveRaw ?? '').split(';').filter((m) => m.trim() !== '')
      .map((m) => parsePoint(m, 'move', name))
    let kind: string | undefined
    let crease = false
    const kindRaw = strAt(r, 'kind')
    if (kindRaw !== undefined) {
      if (kindRaw.toLowerCase() === 'crease') {
        crease = true
      } else {
        kind = KINDS.includes(kindRaw) ? kindRaw : KIND_ALIASES[kindRaw.toLowerCase()]
        if (kind === undefined) {
          throw new FoldError(`step "${name}": unknown kind "${kindRaw}" (try simple, reverse, sink, crease, …)`)
        }
      }
    }
    if (!crease) foldCount += 1
    const at = posAt(r, 'at') ?? foldCount
    const dur = posAt(r, 'dur') ?? 0.75
    const to = Math.min(1, posAt(r, 'to') ?? 1)
    specs.push({
      name, line: lineThrough(p1, p2), move,
      kind, pick: numAt(r, 'pick'),
      at, dur, to, crease,
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
  const reverses: ReverseRecord[] = []
  const priorLines: Line[] = []
  let parity = 0
  for (const spec of specs) {
    if (spec.crease) {
      try {
        st = creaseStep(st, spec.line)
      } catch (e) {
        if (e instanceof FoldError) throw new FoldError(`step "${spec.name}": ${e.message}`)
        throw e
      }
      continue
    }
    let out: FoldOutcome
    try {
      out = foldStep(st, spec)
    } catch (e) {
      if (e instanceof FoldError) throw new FoldError(`step "${spec.name}": ${e.message}`)
      throw e
    }
    // simple folds keep the crisp rigid hinge; so do held folds
    // (to < 1) — their whole point is the displayed pose. Shallow folds
    // relax softly; deep stacks, where relaxation reads as crumpling,
    // get the mechanism instead: the book opens around the spine on the
    // table, the point flips through, and everything presses flat again.
    // Every bake must pass the clearance gate (no plunging through the
    // stack) or the step falls back — relax to mechanism, mechanism to
    // the rigid swing.
    const soft = bakeMotion(out, spec, reverses, priorLines, scale, size, parity)
    // folding on a table: a fold acting on the underside means the folder
    // turns the model over first (mechanism steps open upward off their
    // anchored bottom cover, so they never flip)
    const down = soft?.zDirs ? false : foldsDown(out)
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
      soft,
      // parity is ABSOLUTE: the side being worked must face the viewer,
      // so a step folding engine-down shows flipped (1) and a step
      // folding engine-up shows upright (0), flipping over in between
      // whenever the parity changes. Mechanism steps open toward the
      // viewer from their anchored cover at either parity, so they keep
      // whatever parity they inherit.
      flipFrom: parity,
      flipTo: soft?.zDirs ? parity : down ? 1 : 0,
    })
    parity = steps[steps.length - 1].flipTo
    const rec = reverseRecordOf(out)
    if (rec) reverses.push(rec)
    priorLines.push(spec.line)
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
const SOFT_MAX_FACES = 20

const bakeStep = (out: FoldOutcome, scale: number): { frames: number; pos: number[] } => {
  const { FV, sheet } = out.state
  const { Vfrom, moving, line, dirs, EV, angleFrom, angleTo } = out.anim
  const [EF] = X.EV_FV_2_EF_FE(EV, FV)
  // the pocket: the plies the moving point passes between are exactly the
  // static faces that overlap a mover in the solved stack — only THEIR
  // pressed creases open to let the point through, the rest of the model
  // stays pressed (a folder opens one pocket, not the whole bird)
  const pocket = FV.map(() => false)
  for (const [f, g] of out.state.FO) {
    if (moving[f] !== moving[g]) pocket[moving[f] ? g : f] = true
  }
  const flank = EV.map((_, ei) => {
    if (Math.abs(angleTo[ei] - angleFrom[ei]) > 1e-9) return false
    if (Math.abs(angleFrom[ei]) < 1e-9) return false
    return EF[ei].some((fi: number) => pocket[fi])
  })
  const mesh = buildSoftMesh(FV, sheet, EV, EF, angleFrom, angleTo,
    pickPinned(FV, sheet, moving), flank)
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
  const baked = bakeSoftMotion(mesh, seed, { frames: SOFT_FRAMES })
  const pos: number[] = []
  for (const frame of baked) {
    for (let vi = 0; vi < sheet.length; ++vi) {
      pos.push((frame[vi * 3] - 0.5) * scale, (frame[vi * 3 + 1] - 0.5) * scale, frame[vi * 3 + 2] * scale)
    }
  }
  return { frames: baked.length, pos }
}

// Bake the analytic reverse-fold mechanism for one step. Frames are exact
// rigid placements (machine-precision closure), so the endpoint blend in
// foldTablePositions is a no-op safety net.
const bakeMech = (
  out: FoldOutcome, reverses: ReverseRecord[], pageLines: Line[], scale: number,
  parity: number,
): { frames: number; pos: number[]; zDirs: number[] } | undefined => {
  const mech = buildReverseMech(out, reverses, pageLines)
  if (!mech) return undefined
  // on a deep model, earlier reverse folds are finished features — a
  // made neck should stay a neck — so don't open the book to the exact
  // branch point (that would fully un-press them); crack it open and let
  // the point sweep through, the small seam error bending across the
  // shared vertices. Shallow collapses in progress keep the exact
  // full-open motion.
  const betaCap = mech.slavePairs > 0 && out.state.FV.length > SOFT_MAX_FACES
    ? MECH_BETA_CAP : undefined
  // folding on a table with the worked side facing the viewer: hold one
  // cover flat and open the book toward the side the display shows the
  // viewer (engine +z upright, −z when the display parity is flipped).
  // Which anchor achieves that depends on where the swinging material
  // sits relative to the spine, so probe the mid-frame and re-anchor if
  // the book opened the wrong way.
  let baked = mech.frames(SOFT_FRAMES, { anchor: parity ? 'a' : 'b', betaCap })
  const opensWrongWay = (b: { pos: number[][] }): boolean => {
    if (b.pos.length < SOFT_FRAMES) return false
    const midFrame = b.pos[Math.floor(SOFT_FRAMES / 2)]
    let zSum = 0
    out.state.FV.forEach((F, fi) => {
      if (!out.anim.moving[fi]) return
      for (const vi of F) zSum += midFrame[vi * 3 + 2]
    })
    return (parity ? -zSum : zSum) < 0
  }
  if (opensWrongWay(baked)) {
    baked = mech.frames(SOFT_FRAMES, { anchor: parity ? 'b' : 'a', betaCap })
  }
  if (baked.pos.length < SOFT_FRAMES) return undefined
  const nv = out.state.sheet.length
  const pos: number[] = []
  for (const frame of baked.pos) {
    for (let vi = 0; vi < nv; ++vi) {
      pos.push((frame[vi * 3] - 0.5) * scale, (frame[vi * 3 + 1] - 0.5) * scale, frame[vi * 3 + 2] * scale)
    }
  }
  return { frames: baked.pos.length, pos, zDirs: baked.zdir.flat() }
}

// Routing gates: a baked motion that drives paper through paper deeper
// than its budget is worse than the rigid swing — throw it away. The
// relaxed solver gets a tight budget (its plunges measure ~9 stack
// thicknesses when it fails). The mechanism gets a page-brush allowance:
// paper that spans the opening spine without a crease there (it would
// need to bend, which rigid assemblies cannot) brushes through the
// opposite cover's overhang by a bounded amount that vanishes at the
// apex — the way real pages brush past each other.
const GATE_RELAX_DEPTH = 2 * STACK_DEPTH
const GATE_MECH_DEPTH = 4.5 * STACK_DEPTH
// paper may bow — the approved collapse pockets stretch edges up to ~60%
// transiently — but a relaxed bake past this is teleporting, not bowing,
// and falls back to the mechanism / rigid swing
const GATE_RELAX_STRAIN = 0.65
// how far the book opens when earlier reverse folds ride along (~35°)
const MECH_BETA_CAP = 0.6
// fraction of a flipping step's swing spent turning the model over
const FLIP_WINDOW = 0.3

// One step's motion at fraction t (display frame, before layer offsets
// and parity): the rigid hinge swing, or a baked motion eased into the
// exact endpoints. Shared by playback and the compile-time gates, so what
// is judged is exactly what is shown.
interface StepMotion {
  Vfrom: Vec2[]
  line: Line
  moving: boolean[]
  dirs: number[]
  FV: number[][]
  soft?: { frames: number; pos: number[]; zDirs?: number[] }
}

const sampleStepMotion = (m: StepMotion, t: number): {
  pos: [number, number, number][]
  zDir?: [number, number, number][]
  // per-face sign of the layer-offset target: a face whose assembly ends
  // the step flipped (carried ẑ pointing down) needs the mirrored scalar
  // so direction × scalar lands exactly on the next step's stacking
  sig?: number[]
} => {
  const [u, d] = m.line
  const sense: number[] = m.Vfrom.map(() => 0)
  for (let fi = 0; fi < m.FV.length; ++fi) {
    if (!m.moving[fi]) continue
    for (const vi of m.FV[fi]) sense[vi] = m.dirs[fi]
  }
  const rigid = (vi: number, theta: number): [number, number, number] => {
    const p = m.Vfrom[vi]
    const h = p[0] * u[0] + p[1] * u[1] - d
    if (sense[vi] === 0 || Math.abs(h) < 1e-12) return [p[0], p[1], 0]
    const hh = h * Math.cos(theta)
    return [p[0] + (hh - h) * u[0], p[1] + (hh - h) * u[1], sense[vi] * h * Math.sin(theta)]
  }
  if (m.soft === undefined) {
    return { pos: m.Vfrom.map((_, vi) => rigid(vi, Math.PI * t)) }
  }
  // sample the baked motion, easing the residuals into the exact endpoint
  // geometry at both ends of the swing
  const { frames, pos: P, zDirs } = m.soft
  const nv = m.Vfrom.length
  const x = t * (frames - 1)
  const f0 = Math.min(frames - 1, Math.floor(x))
  const f1 = Math.min(frames - 1, f0 + 1)
  const fx = x - f0
  const a = 1 - smooth(0, 0.15, t)
  const b = smooth(0.85, 1, t)
  const pos = m.Vfrom.map((_, vi): [number, number, number] => {
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
  let zDir: [number, number, number][] | undefined
  let sig: number[] | undefined
  if (zDirs) {
    const nf = m.FV.length
    zDir = m.FV.map((_, fi) => {
      const v: [number, number, number] = [0, 0, 0]
      for (let c = 0; c < 3; ++c) {
        v[c] = zDirs[(f0 * nf + fi) * 3 + c] * (1 - fx) + zDirs[(f1 * nf + fi) * 3 + c] * fx
      }
      const n = Math.hypot(v[0], v[1], v[2]) || 1
      return [v[0] / n, v[1] / n, v[2] / n]
    })
    sig = m.FV.map((_, fi) => (zDirs[((frames - 1) * nf + fi) * 3 + 2] < 0 ? -1 : 1))
  }
  return { pos, zDir, sig }
}

// worst edge stretch of a bake AS DISPLAYED — sampled through the same
// playback path, so strain the endpoint blend masks (a slightly off final
// frame) doesn't count and strain it exposes (a lurch just after the
// exact start) does
const bakeStrain = (
  bake: { frames: number; pos: number[] }, out: FoldOutcome, scale: number,
): number => {
  const { FV } = out.state
  const [u, d] = out.anim.line
  const motion: StepMotion = {
    Vfrom: out.anim.Vfrom.map((p): Vec2 => [(p[0] - 0.5) * scale, (p[1] - 0.5) * scale]),
    line: [u, (d - (u[0] + u[1]) * 0.5) * scale],
    moving: out.anim.moving,
    dirs: out.anim.dirs,
    FV,
    soft: bake,
  }
  const seen = new Set<string>()
  const edges: [number, number, number][] = []
  for (const F of FV) {
    for (let i = 0, j = F.length - 1; i < F.length; j = i++) {
      const key = F[i] < F[j] ? `${F[i]}:${F[j]}` : `${F[j]}:${F[i]}`
      if (seen.has(key)) continue
      seen.add(key)
      const rest = Math.hypot(
        motion.Vfrom[F[i]][0] - motion.Vfrom[F[j]][0], motion.Vfrom[F[i]][1] - motion.Vfrom[F[j]][1])
      if (rest > 1e-9) edges.push([F[i], F[j], rest])
    }
  }
  let worst = 0
  const S = 24
  for (let i = 1; i < S; ++i) {
    const { pos } = sampleStepMotion(motion, i / S)
    for (const [a, b, rest] of edges) {
      const len = Math.hypot(pos[a][0] - pos[b][0], pos[a][1] - pos[b][1], pos[a][2] - pos[b][2])
      worst = Math.max(worst, Math.abs(len - rest) / rest)
    }
  }
  return worst
}
const bakePassesGate = (
  bake: { frames: number; pos: number[] } | undefined,
  FV: number[][], nv: number, size: number, budget: number,
): boolean => {
  if (!bake) return false
  const frames = [...Array(bake.frames).keys()].map((f) => ({
    pos: (vi: number): [number, number, number] => [
      bake.pos[(f * nv + vi) * 3], bake.pos[(f * nv + vi) * 3 + 1], bake.pos[(f * nv + vi) * 3 + 2]],
  }))
  return bakedMotionDepth(FV, frames) <= budget * size
}

// which way a step's action swings: area-weighted vote over the moving
// faces of the side each swings toward (sense × side of the line)
const foldsDown = (out: FoldOutcome): boolean => {
  const { FV, sheet } = out.state
  const { Vfrom, moving, dirs, line } = out.anim
  const [u, d] = line
  let v = 0
  FV.forEach((F, fi) => {
    if (!moving[fi] || dirs[fi] === 0) return
    let cx = 0
    let cy = 0
    for (const vi of F) { cx += Vfrom[vi][0] / F.length; cy += Vfrom[vi][1] / F.length }
    const h = cx * u[0] + cy * u[1] - d
    let a = 0
    for (let i = 0, j = F.length - 1; i < F.length; j = i++) {
      a += sheet[F[j]][0] * sheet[F[i]][1] - sheet[F[i]][0] * sheet[F[j]][1]
    }
    v += Math.abs(a / 2) * Math.sign(dirs[fi] * h)
  })
  return v < 0
}

// Motion routing for one step: rigid for simple and held folds; relaxed
// soft motion for shallow folds; the analytic mechanism for deep stacks
// (or as fallback when relaxation plunges); rigid when nothing passes.
// When the mechanism's bake fails the gate, earlier fold lines are freed
// one at a time (most recent first) so overhanging pages can fan out of
// the way instead of sweeping through the opposite cover.
const bakeMotion = (
  out: FoldOutcome, spec: FoldTableRowSpec, reverses: ReverseRecord[],
  priorLines: Line[], scale: number, size: number, parity: number,
): FoldProgramStep['soft'] => {
  if (out.type === 'Pureland' || spec.to < 1) return undefined
  const FV = out.state.FV
  const nv = out.state.sheet.length
  if (FV.length <= SOFT_MAX_FACES) {
    const relax = bakeStep(out, scale)
    const strain = bakeStrain(relax, out, scale)
    if (typeof process !== 'undefined' && process.env?.GATE_DEBUG) {
      console.log(`  [gate] relax strain=${(strain * 100).toFixed(1)}% depthOk=${bakePassesGate(relax, FV, nv, size, GATE_RELAX_DEPTH)}`)
    }
    if (bakePassesGate(relax, FV, nv, size, GATE_RELAX_DEPTH) &&
        strain <= GATE_RELAX_STRAIN) return relax
  }
  const recent = [...priorLines].reverse()
  for (let nPages = 0; nPages <= recent.length; ++nPages) {
    const mech = bakeMech(out, reverses, recent.slice(0, nPages), scale, parity)
    if (bakePassesGate(mech, FV, nv, size, GATE_MECH_DEPTH)) return mech
  }
  return undefined
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
): {
  FV: number[][]; pos: [number, number, number][]; moving: boolean[]
  zOff: number[]
  // layer-offset direction per face when the motion carries one (mechanism
  // bakes); undefined = world z, as in flat states
  zDir?: [number, number, number][]
} => {
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
  const tRaw = Math.min(1, Math.max(0, fold - k))
  const step = program.steps[k]
  // a flipping step turns the model over in its opening window, then the
  // fold plays in the remainder — like a folder turning the paper before
  // working on what used to be the back
  const flipping = step.flipTo !== step.flipFrom
  const t = flipping ? Math.max(0, (tRaw - FLIP_WINDOW) / (1 - FLIP_WINDOW)) : tRaw
  const flipT = flipping
    ? step.flipFrom + (step.flipTo - step.flipFrom) * smooth(0, FLIP_WINDOW, tRaw)
    : step.flipFrom
  const sampled = sampleStepMotion(
    { Vfrom: step.Vfrom, line: step.line, moving: step.moving, dirs: step.dirs, FV: step.FV, soft: step.soft }, t)
  let pos = sampled.pos
  let zDir = sampled.zDir
  const sig = sampled.sig
  // each face's display height eases from where its paper sat before this
  // fold to where it ends up, so consecutive steps join without a jump
  const zOff = step.FV.map((_, fi) => {
    const from = step.layersFrom[fi] - mid
    const target = (sig?.[fi] ?? 1) * (step.layers[fi] - mid)
    return program.gap * (from + (target - from) * t)
  })
  // display parity: turn the whole model over about the y axis (in place —
  // the resting stack is centred on the paper plane, so a half-turn lands
  // where it started)
  if (flipT !== 0) {
    // rotate about the in-plane axis that displays as the viewer's
    // vertical, so the model mirrors left-right on screen. Exact
    // half-turns stay exactly flat (no trig residue): x' = 2(â·x)â − x.
    const [ax, ay] = program.flipAxis ?? [0, 1]
    const rot = flipT === 1
      ? ([x, y, z]: [number, number, number]): [number, number, number] => {
          const dd = ax * x + ay * y
          return [2 * dd * ax - x, 2 * dd * ay - y, -z]
        }
      : ([x, y, z]: [number, number, number]): [number, number, number] => {
          // Rodrigues about â = (ax, ay, 0) by π·flipT
          const c = Math.cos(Math.PI * flipT)
          const s = Math.sin(Math.PI * flipT)
          const dd = (ax * x + ay * y) * (1 - c)
          return [
            x * c + ay * z * s + ax * dd,
            y * c - ax * z * s + ay * dd,
            (ax * y - ay * x) * s + z * c,
          ]
        }
    pos = pos.map(rot)
    zDir = (zDir ?? step.FV.map((): [number, number, number] => [0, 0, 1])).map(rot)
  }
  return { FV: step.FV, pos, moving: step.moving, zOff, zDir }
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
