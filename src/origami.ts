// livecodata origami — folds specified, not inferred
// -----------------------------------------------------------------------------
// A fold program is a TABLE OF CREASES. Every row gives one crease as a
// literal segment in sheet coordinates, which pieces of paper it moves
// (named by sample points), its signed angle, and its timing. Nothing is
// derived from a folded model: what you write is exactly what folds.
//
//   compileFolds(rows) — cut the sheet along each row's segment and record
//     the step: its hinge segments (spans), the faces it rotates, the signed
//     angle, and its schedule. The output is plain JSON that rides a scene
//     row (shape: "origami", program: <FoldProgram>).
//
//   createFoldPlayer(program) — pure kinematic playback. Faces hinge about
//     the material crease segments along a spanning tree of the face graph;
//     a pose is a pure function of the per-step fold fractions (0 = open,
//     1 = folded, −1 = folded the other way), so scrubbing backwards
//     physically unfolds the sheet. Vertices are welded: paper edges are
//     true edges that can never split — a set of creases that could not
//     fold together shows up as face stretch, never as a tear.
//
// Row columns:
//   step    the fold's name — rows sharing a name extend the same step
//           (a fold through a stack creases several layers at once; give
//           each layer's crease its own row), and rows with no p1/p2
//           re-drive it (keyframes)
//   p1,p2   the crease segment, sheet coordinates "x,y" (the sheet spans
//           [-size, size]²)
//   move    sample points "x,y" (";"-separated) inside the pieces this
//           step rotates — only pieces TOUCHING the crease need naming;
//           anything connected rides along through the hinge tree
//   sign    which way this crease turns for positive fractions (+1
//           default; flipping it is the same as swapping p1/p2). Layers of
//           a stack often need opposite senses — if a flap tears away
//           mid-fold, flip its crease's sign
//   deg     the fold's full signed angle (default 180; ±180 folds flat)
//   at,dur,to  timing, and how far to drive (fractions of deg)
//
// There is no validation that a set of creases can fold without tearing —
// the player renders whatever is written, and impossible poses read as
// paper strain. (A static tear-check is a planned addition.)
// -----------------------------------------------------------------------------

export type Vec2 = [number, number]

// ── 2D helpers ────────────────────────────────────────────────────────────────

const EPS = 1e-9

const sub2 = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]]
const cross2 = (a: Vec2, b: Vec2): number => a[0] * b[1] - a[1] * b[0]
const dot2 = (a: Vec2, b: Vec2): number => a[0] * b[0] + a[1] * b[1]
const len2 = (a: Vec2): number => Math.hypot(a[0], a[1])
const norm2 = (a: Vec2): Vec2 => {
  const L = len2(a)
  return [a[0] / L, a[1] / L]
}

const polyArea = (poly: Vec2[]): number => {
  let s = 0
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]
    const q = poly[(i + 1) % poly.length]
    s += p[0] * q[1] - q[0] * p[1]
  }
  return s / 2
}

const polyCentroid = (poly: Vec2[]): Vec2 => {
  let x = 0
  let y = 0
  for (const p of poly) {
    x += p[0]
    y += p[1]
  }
  return [x / poly.length, y / poly.length]
}

// Point in (or on) a convex CCW polygon.
const pointInPoly = (p: Vec2, poly: Vec2[], eps = 1e-7): boolean => {
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    if (cross2(sub2(b, a), sub2(p, a)) < -eps) return false
  }
  return true
}

// Split a convex CCW polygon by the line through p with direction u.
// left = the part with cross(u, v−p) > 0. Returns null pieces when the
// polygon is entirely on one side; chord = the cut segment when it splits.
interface Cut {
  left: Vec2[] | null
  right: Vec2[] | null
  chord: [Vec2, Vec2] | null
}

function cutConvex(poly: Vec2[], p: Vec2, u: Vec2): Cut {
  const side = poly.map((v) => cross2(u, sub2(v, p)))
  let hasL = false
  let hasR = false
  for (const s of side) {
    if (s > EPS) hasL = true
    else if (s < -EPS) hasR = true
  }
  if (!hasL || !hasR) {
    return { left: hasL ? poly : null, right: hasR ? poly : null, chord: null }
  }
  const left: Vec2[] = []
  const right: Vec2[] = []
  const onLine: Vec2[] = []
  const push = (list: Vec2[], v: Vec2): void => {
    const last = list[list.length - 1]
    if (!last || Math.abs(last[0] - v[0]) > EPS || Math.abs(last[1] - v[1]) > EPS) list.push(v)
  }
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    const sa = side[i]
    const sb = side[(i + 1) % poly.length]
    if (sa >= -EPS) push(left, a)
    if (sa <= EPS) push(right, a)
    if (Math.abs(sa) <= EPS) push(onLine, a)
    if ((sa > EPS && sb < -EPS) || (sa < -EPS && sb > EPS)) {
      const t = sa / (sa - sb)
      const x: Vec2 = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]
      push(left, x)
      push(right, x)
      push(onLine, x)
    }
  }
  // Degenerate slivers count as "no cut" on that side.
  if (Math.abs(polyArea(left)) < 1e-9 || Math.abs(polyArea(right)) < 1e-9) {
    const keepLeft = Math.abs(polyArea(left)) >= Math.abs(polyArea(right))
    return { left: keepLeft ? poly : null, right: keepLeft ? null : poly, chord: null }
  }
  // The chord: the two extreme on-line points along u.
  let lo = Infinity
  let hi = -Infinity
  let c1: Vec2 = onLine[0]
  let c2: Vec2 = onLine[0]
  for (const v of onLine) {
    const t = dot2(u, sub2(v, p))
    if (t < lo) {
      lo = t
      c1 = v
    }
    if (t > hi) {
      hi = t
      c2 = v
    }
  }
  return { left, right, chord: [c1, c2] }
}

// ── The compiled program ──────────────────────────────────────────────────────

export interface FoldStep {
  group: string
  // Total signed rotation in radians of the moving side relative to the
  // paper it hinges on, about this step's creases.
  theta: number
  // A full ±180° fold — playback backs off a sliver so stacked layers keep
  // daylight.
  flat: boolean
  // Indices into program.faces of the faces this step rotates.
  moving: number[]
  // The creases, as sheet segments. `sign` is the layer parity the crease
  // was written for (+1 face-up, −1 mirrored): the fold angle is uniform in
  // the PAPER's frame, so a crease on a mirrored layer turns the other way
  // in the world — one fold through a stack moves the front layer toward
  // the viewer and the back layer away.
  spans: { a: Vec2; b: Vec2; sign: number }[]
  at: number
  dur: number
}

export interface FoldProgram {
  size: number
  // The face partition: convex CCW sheet polygons.
  faces: { poly: Vec2[] }[]
  steps: FoldStep[]
  groups: string[]
  warnings: string[]
}

export interface ScheduleRow {
  fold: string
  at: number
  dur: number
  to: number
  ease?: unknown
}

export interface CompiledFold {
  program: FoldProgram
  schedule: ScheduleRow[]
}

// ── Compilation: cut where told, mark what's named ────────────────────────────

export function compileFolds(
  rows: ReadonlyArray<Record<string, unknown>>,
  opts: { size?: number } = {},
): CompiledFold {
  const size = opts.size ?? 1
  const s = size
  interface Face {
    poly: Vec2[]
    movedAt: number[]
  }
  const faces: Face[] = [{ poly: [[-s, -s], [s, -s], [s, s], [-s, s]], movedAt: [] }]
  interface StepRec {
    group: string
    theta: number
    flat: boolean
    spans: { a: Vec2; b: Vec2; sign: number }[]
    at: number
    dur: number
  }
  const steps: StepRec[] = []
  const groups: string[] = []
  const warnings: string[] = []
  const schedule: ScheduleRow[] = []
  let nextAt = 1

  const parsePoint = (raw: unknown): Vec2 | null => {
    if (typeof raw !== 'string' || raw.trim() === '') return null
    const m = raw.split(',')
    if (m.length !== 2) return null
    const x = Number(m[0])
    const y = Number(m[1])
    return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null
  }

  rows.forEach((row, i) => {
    if (!row) return
    const group = row.step != null && row.step !== '' ? String(row.step) : `step${i}`
    const at = typeof row.at === 'number' && row.at > 0 ? row.at : nextAt
    const dur = typeof row.dur === 'number' && row.dur > 0 ? row.dur : 0
    nextAt = Math.max(nextAt, at + (dur || 1))
    const to = typeof row.to === 'number' ? row.to : 1

    const a = parsePoint(row.p1)
    const b = parsePoint(row.p2)

    if (!a || !b) {
      // A keyframe row: re-drive an earlier step.
      if (!groups.includes(group)) {
        warnings.push(`row ${i + 1}: no fold named "${group}" to drive — skipped`)
        return
      }
      schedule.push({ fold: group, at, dur: dur || 1, to, ease: row.ease })
      return
    }

    const L = len2(sub2(b, a))
    if (L < 1e-6) {
      throw new Error(`fold "${group}": p1 and p2 are the same point — no crease`)
    }
    const u = norm2(sub2(b, a))

    // The step this row extends (rows sharing a name are one fold whose
    // creases run through several layers).
    let k = steps.findIndex((st) => st.group === group)
    if (k < 0) {
      const deg = typeof row.deg === 'number' && row.deg !== 0 ? row.deg : 180
      steps.push({
        group,
        theta: (deg * Math.PI) / 180,
        flat: Math.abs(Math.abs(deg) - 180) < 1e-9,
        spans: [],
        at,
        dur: dur || 1,
      })
      groups.push(group)
      k = steps.length - 1
    } else if (typeof row.deg === 'number' && row.deg !== 0
      && Math.abs((row.deg * Math.PI) / 180 - steps[k].theta) > 1e-9) {
      warnings.push(`fold "${group}": rows disagree on deg — keeping the first (${(steps[k].theta * 180) / Math.PI}°)`)
    }
    const st = steps[k]

    // Cut every face the SEGMENT overlaps (the cut follows the full chord
    // through each face; the crease it records is just this segment, so a
    // chord that runs past the segment is an ordinary panel boundary until
    // some other row claims it).
    const nextFaces: Face[] = []
    for (const f of faces) {
      const cut = cutConvex(f.poly, a, u)
      if (!cut.left || !cut.right || !cut.chord) {
        nextFaces.push(f)
        continue
      }
      const t1 = dot2(u, sub2(cut.chord[0], a))
      const t2 = dot2(u, sub2(cut.chord[1], a))
      const lo = Math.min(t1, t2)
      const hi = Math.max(t1, t2)
      if (Math.min(hi, L) - Math.max(lo, 0) < 1e-6) {
        nextFaces.push(f) // the line crosses, but not within this crease
        continue
      }
      nextFaces.push({ poly: cut.left, movedAt: [...f.movedAt] })
      nextFaces.push({ poly: cut.right, movedAt: [...f.movedAt] })
    }
    faces.length = 0
    faces.push(...nextFaces)

    // The crease itself, on its layer.
    const sign = typeof row.sign === 'number' && row.sign < 0 ? -1 : 1
    st.spans.push({ a, b, sign })

    // Mark the pieces this row rotates.
    const movesRaw = typeof row.move === 'string' ? row.move : ''
    const pts = movesRaw.split(';').map(parsePoint).filter((p): p is Vec2 => !!p)
    if (!pts.length) {
      warnings.push(`fold "${group}" row ${i + 1}: no move point — the crease exists but rotates nothing`)
    }
    for (const p of pts) {
      const f = faces.find((f) => pointInPoly(p, f.poly))
      if (!f) {
        warnings.push(`fold "${group}": move point ${p[0]},${p[1]} is not on the paper`)
        continue
      }
      if (!f.movedAt.includes(k)) f.movedAt.push(k)
    }

    // A crease row with timing also drives its ramp; dur 0 = geometry only.
    if (dur > 0) schedule.push({ fold: group, at, dur, to, ease: row.ease })
  })

  const program: FoldProgram = {
    size,
    faces: faces.map((f) => ({ poly: f.poly })),
    steps: steps.map((st, k) => ({
      group: st.group,
      theta: st.theta,
      flat: st.flat,
      moving: faces.reduce<number[]>((acc, f, i) => {
        if (f.movedAt.includes(k)) acc.push(i)
        return acc
      }, []),
      spans: st.spans,
      at: st.at,
      dur: st.dur,
    })),
    groups,
    warnings,
  }
  return { program, schedule }
}

// ── Playback ──────────────────────────────────────────────────────────────────

export interface FoldPlayer {
  // xyz per face corner (fan-triangulated, non-indexed) — read after step().
  readonly positions: Float32Array
  // xyz pairs, one segment per unique face edge (creases + paper border).
  readonly linePositions: Float32Array
  readonly groups: string[]
  readonly program: FoldProgram
  // Position every face for the given per-fold fractions (0 = before that
  // fold, 1 = folded; scrubbing back physically unfolds). Faces hinge about
  // the MATERIAL crease lines along a spanning tree of the face graph, so
  // the only independently moving pieces are faces a crease separates, and
  // re-driving an earlier fold mid-step carries its creases with the paper.
  step(fracs: Record<string, number>): void
}

type Affine = Float64Array // row-major 3x4

const IDENTITY: Affine = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0])

function mulAffine(a: Affine, b: Affine, out: Affine): void {
  for (let r = 0; r < 3; r++) {
    const r4 = r * 4
    for (let c = 0; c < 4; c++) {
      out[r4 + c] = a[r4] * b[c] + a[r4 + 1] * b[4 + c] + a[r4 + 2] * b[8 + c]
        + (c === 3 ? a[r4 + 3] : 0)
    }
  }
}

// Rotation by θ about the z=0 line through p → q (Rodrigues, then conjugate by
// the translation taking the origin to p).
function rotAboutLine2D(px: number, py: number, qx: number, qy: number, theta: number, out: Affine): void {
  let ux = qx - px
  let uy = qy - py
  const L = Math.hypot(ux, uy)
  ux /= L
  uy /= L
  const c = Math.cos(theta)
  const s = Math.sin(theta)
  const t = 1 - c
  const r00 = c + t * ux * ux
  const r01 = t * ux * uy
  const r02 = s * uy
  const r10 = t * ux * uy
  const r11 = c + t * uy * uy
  const r12 = -s * ux
  const r20 = -s * uy
  const r21 = s * ux
  const r22 = c
  out[0] = r00; out[1] = r01; out[2] = r02
  out[4] = r10; out[5] = r11; out[6] = r12
  out[8] = r20; out[9] = r21; out[10] = r22
  out[3] = px - (r00 * px + r01 * py)
  out[7] = py - (r10 * px + r11 * py)
  out[11] = -(r20 * px + r21 * py)
}

// Fully-folded flat steps stop just short of 180° so stacked layers keep a
// sliver of daylight (no z-fighting) while the written spec stays exact. The
// welded mesh spreads the deficit as a whisper of face flex, so keep it small.
const FLAT_MAX = Math.PI * 0.998

// The overlap segment two convex sheet polygons share, or null.
function sharedSegment(pa: Vec2[], pb: Vec2[]): [Vec2, Vec2] | null {
  for (let i = 0; i < pa.length; i++) {
    const a1 = pa[i]
    const a2 = pa[(i + 1) % pa.length]
    const u = sub2(a2, a1)
    const L = len2(u)
    if (L < EPS) continue
    for (let j = 0; j < pb.length; j++) {
      const b1 = pb[j]
      const b2 = pb[(j + 1) % pb.length]
      if (Math.abs(cross2(u, sub2(b1, a1))) > 1e-7 * L) continue
      if (Math.abs(cross2(u, sub2(b2, a1))) > 1e-7 * L) continue
      const t1 = dot2(u, sub2(b1, a1)) / (L * L)
      const t2 = dot2(u, sub2(b2, a1)) / (L * L)
      const lo = Math.max(0, Math.min(t1, t2))
      const hi = Math.min(1, Math.max(t1, t2))
      if (hi - lo > 1e-6) {
        return [
          [a1[0] + lo * u[0], a1[1] + lo * u[1]],
          [a1[0] + hi * u[0], a1[1] + hi * u[1]],
        ]
      }
    }
  }
  return null
}

export function createFoldPlayer(program: FoldProgram): FoldPlayer {
  const faces = program.faces
  const nf = faces.length

  // Fan triangulation (faces are convex by construction).
  let corners = 0
  const faceTriStart: number[] = []
  for (const f of faces) {
    faceTriStart.push(corners)
    corners += (f.poly.length - 2) * 3
  }
  const positions = new Float32Array(corners * 3)

  // ── Welded vertices: paper edges are TRUE edges ──
  // Every distinct sheet point is one animated vertex, shared by every face
  // whose boundary carries it (as a corner or mid-edge). Each frame computes
  // one position per vertex — the average of its faces' rigid predictions —
  // so the mesh is watertight by construction: edges can never split,
  // whatever the fold fractions do; any disagreement between faces reads as
  // the slight flex of real paper instead of a tear.
  const vkey = (p: Vec2): string => `${p[0].toFixed(6)},${p[1].toFixed(6)}`
  const verts: Vec2[] = []
  const vertIndex = new Map<string, number>()
  faces.forEach((f) => {
    for (const p of f.poly) {
      const k = vkey(p)
      if (!vertIndex.has(k)) {
        vertIndex.set(k, verts.length)
        verts.push(p)
      }
    }
  })
  const nv = verts.length
  const onBoundary = (v: Vec2, poly: Vec2[]): boolean => {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]
      const b = poly[(i + 1) % poly.length]
      const d = sub2(b, a)
      const L = len2(d)
      if (L < EPS) continue
      if (Math.abs(cross2(d, sub2(v, a))) > 1e-7 * L) continue
      const t = dot2(d, sub2(v, a)) / (L * L)
      if (t >= -1e-7 && t <= 1 + 1e-7) return true
    }
    return false
  }
  const vertFaces: number[][] = verts.map((v) =>
    faces.reduce<number[]>((acc, f, fi) => {
      if (onBoundary(v, f.poly)) acc.push(fi)
      return acc
    }, []))
  const vertPos = new Float64Array(nv * 3)
  // Face corner → welded vertex.
  const cornerVert: number[][] = faces.map((f) => f.poly.map((p) => vertIndex.get(vkey(p))!))

  // Unique edges by welded endpoints (creases + paper border).
  const edges: [number, number][] = []
  {
    const seen = new Set<string>()
    faces.forEach((f, fi) => {
      for (let i = 0; i < f.poly.length; i++) {
        const va = cornerVert[fi][i]
        const vb = cornerVert[fi][(i + 1) % f.poly.length]
        const key = va < vb ? `${va}|${vb}` : `${vb}|${va}`
        if (seen.has(key)) continue
        seen.add(key)
        edges.push([va, vb])
      }
    })
  }
  const linePositions = new Float32Array(edges.length * 6)

  // ── Hinges: every shared face edge is a crease some step wrote ──
  interface Hinge {
    fa: number
    fb: number
    // Sheet line oriented along the step's span, so rotating fb by +θ about
    // p→q (relative to fa) is the fold's own direction.
    px: number
    py: number
    qx: number
    qy: number
    step: number
    // Layer parity of the crease (from its span): the fold angle is uniform
    // in the PAPER's frame, so a crease on a mirrored layer turns the other
    // way in the world.
    sign: number
  }
  const hinges: Hinge[] = []
  for (let i = 0; i < nf; i++) {
    for (let j = i + 1; j < nf; j++) {
      const seg = sharedSegment(faces[i].poly, faces[j].poly)
      if (!seg) continue
      const mid: Vec2 = [(seg[0][0] + seg[1][0]) / 2, (seg[0][1] + seg[1][1]) / 2]
      let found = false
      for (let si = 0; si < program.steps.length && !found; si++) {
        for (const sp of program.steps[si].spans) {
          const d = sub2(sp.b, sp.a)
          const L = len2(d)
          if (L < EPS) continue
          if (Math.abs(cross2(d, sub2(mid, sp.a))) > 1e-6 * L) continue
          const t = dot2(d, sub2(mid, sp.a)) / (L * L)
          if (t < -1e-6 || t > 1 + 1e-6) continue
          const aMoves = program.steps[si].moving.includes(i)
          const bMoves = program.steps[si].moving.includes(j)
          if (aMoves === bMoves) continue
          // Orient the shared segment along the span; the mover is fb.
          const flip = dot2(d, sub2(seg[1], seg[0])) < 0
          const [p, q] = flip ? [seg[1], seg[0]] : [seg[0], seg[1]]
          hinges.push({
            fa: bMoves ? i : j,
            fb: bMoves ? j : i,
            px: p[0], py: p[1], qx: q[0], qy: q[1],
            step: si,
            sign: sp.sign ?? 1,
          })
          found = true
          break
        }
      }
    }
  }

  // Spanning tree rooted at the stillest face (fewest folds moved it; ties
  // to the sheet's centre), so the model stays put while flaps move.
  const movedCount = new Array<number>(nf).fill(0)
  for (const st of program.steps) for (const i of st.moving) movedCount[i]++
  let root = 0
  let best = Infinity
  faces.forEach((f, i) => {
    const c = polyCentroid(f.poly)
    const score = movedCount[i] * 1e6 + c[0] * c[0] + c[1] * c[1]
    if (score < best) {
      best = score
      root = i
    }
  })
  interface TreeEdge {
    child: number
    parent: number
    hinge: Hinge
    childIsMover: boolean
  }
  // Pick the tree's hinges:
  //   1. FIRST-LAYER creases (written for face-up paper), oldest first — a
  //      fold made later moves whole layered assemblies through their older
  //      connections, and re-driving the crease between two layers steers
  //      a collapse.
  //   2. MIRRORED-LAYER creases only where nothing else connects, newest
  //      first: when a fold runs through a stack, the mirrored layer's
  //      crease is the mechanism's DEPENDENT crease — its angle follows the
  //      others — so it must be where the loop closes, not a driven hinge.
  const tree: TreeEdge[] = []
  {
    const rank = (i: number): number => {
      const h = hinges[i]
      return h.sign > 0 ? h.step : 1e6 - h.step
    }
    const order = hinges.map((_, i) => i).sort((x, y) => rank(x) - rank(y) || x - y)
    const comp = Array.from({ length: nf }, (_, i) => i)
    const find = (i: number): number => {
      while (comp[i] !== i) {
        comp[i] = comp[comp[i]]
        i = comp[i]
      }
      return i
    }
    const adj: { other: number; hinge: Hinge }[][] = Array.from({ length: nf }, () => [])
    for (const hi of order) {
      const h = hinges[hi]
      const ra = find(h.fa)
      const rb = find(h.fb)
      if (ra === rb) continue
      comp[ra] = rb
      adj[h.fa].push({ other: h.fb, hinge: h })
      adj[h.fb].push({ other: h.fa, hinge: h })
    }
    const seen = new Array<boolean>(nf).fill(false)
    seen[root] = true
    const queue = [root]
    while (queue.length) {
      const p = queue.shift()!
      for (const { other, hinge } of adj[p]) {
        if (seen[other]) continue
        seen[other] = true
        tree.push({ child: other, parent: p, hinge, childIsMover: hinge.fb === other })
        queue.push(other)
      }
    }
  }

  const thetas = new Float64Array(program.steps.length)
  const faceM: Affine[] = Array.from({ length: nf }, () => new Float64Array(IDENTITY))
  const rot: Affine = new Float64Array(12)
  const tmp: Affine = new Float64Array(12)

  function step(fracs: Record<string, number>): void {
    program.steps.forEach((st, si) => {
      const raw = st.theta * (fracs[st.group] ?? 0)
      thetas[si] = st.flat ? Math.sign(raw) * Math.min(Math.abs(raw), FLAT_MAX) : raw
    })
    faceM[root].set(IDENTITY)
    for (const te of tree) {
      const h = te.hinge
      // Fold angles live in the PAPER's frame — a valley is a valley on its
      // own layer — so a crease on a mirrored layer turns the other way in
      // the world: one fold through a stack moves the front layer toward
      // the viewer and the back layer away.
      const theta = thetas[h.step] * h.sign
      if (theta === 0) {
        faceM[te.child].set(faceM[te.parent])
        continue
      }
      rotAboutLine2D(h.px, h.py, h.qx, h.qy, te.childIsMover ? theta : -theta, rot)
      mulAffine(faceM[te.parent], rot, tmp)
      faceM[te.child].set(tmp)
    }
    // Weld: one position per sheet vertex — the average of its faces' rigid
    // predictions — so every edge stays a true edge.
    for (let vi = 0; vi < nv; vi++) {
      const v = verts[vi]
      const list = vertFaces[vi]
      let x = 0
      let y = 0
      let z = 0
      for (const fi of list) {
        const M = faceM[fi]
        x += M[0] * v[0] + M[1] * v[1] + M[3]
        y += M[4] * v[0] + M[5] * v[1] + M[7]
        z += M[8] * v[0] + M[9] * v[1] + M[11]
      }
      const inv = 1 / list.length
      vertPos[vi * 3] = x * inv
      vertPos[vi * 3 + 1] = y * inv
      vertPos[vi * 3 + 2] = z * inv
    }
    for (let fi = 0; fi < nf; fi++) {
      const f = faces[fi]
      let o = faceTriStart[fi] * 3
      const put = (k: number): void => {
        const vi = cornerVert[fi][k]
        positions[o] = vertPos[vi * 3]
        positions[o + 1] = vertPos[vi * 3 + 1]
        positions[o + 2] = vertPos[vi * 3 + 2]
        o += 3
      }
      for (let i = 1; i + 1 < f.poly.length; i++) {
        put(0)
        put(i)
        put(i + 1)
      }
    }
    edges.forEach(([va, vb], ei) => {
      const o = ei * 6
      linePositions[o] = vertPos[va * 3]
      linePositions[o + 1] = vertPos[va * 3 + 1]
      linePositions[o + 2] = vertPos[va * 3 + 2]
      linePositions[o + 3] = vertPos[vb * 3]
      linePositions[o + 4] = vertPos[vb * 3 + 1]
      linePositions[o + 5] = vertPos[vb * 3 + 2]
    })
  }

  step({})
  return { positions, linePositions, groups: program.groups, program, step }
}
