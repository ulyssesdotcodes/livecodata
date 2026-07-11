// livecodata origami — folding as instructions
// -----------------------------------------------------------------------------
// The engine follows how origami is actually written down (and how Origami
// Editor 3D works): each instruction FOLDS or REFLECTS the paper along a line
// through two points on known edges — the paper's own edge, or an edge created
// by a previous fold. Nobody authors a crease pattern: the pattern is what the
// instructions leave behind.
//
//   compileFoldProgram(rows) — run the instructions against an exact folded
//     model. The model is a set of FACES, each a convex polygon in sheet
//     coordinates carried by a rigid isometry into the folded plane; between
//     steps the paper is exactly flat-folded, so the whole state lives in 2D.
//     Each step resolves its two point references in the CURRENT folded model,
//     cuts every face the fold line crosses, mirrors (or rotates) the chosen
//     side, and records the step: fold axis, signed angle, the faces it moves,
//     and its timing. The output is plain JSON that rides a scene row
//     (shape: "origami", program: <FoldProgram>).
//
//   createFoldPlayer(program) — pure kinematic playback. A face's position is
//     the composition of its steps' rotations at the current fold fractions
//     (0 = before the step, 1 = folded), so the only independently moving
//     pieces are faces created by a previous fold — paper never bends inside
//     a face, and a pose is a pure function of the fractions: scrubbing
//     backwards physically unfolds the sheet.
//
// Point references (the p1/p2/move columns) are always ON A KNOWN EDGE:
//   "bottom@t" / "top@t" / "left@t" / "right@t"
//                the point a fraction t (default 0.5) along that edge of the
//                PAPER — bottom/top run left→right, left/right run
//                bottom→top. A material point of the paper, found wherever
//                folding has carried it; coincident layers need no
//                disambiguation.
//   "name@t"     the point a fraction t along the edge CREATED by the
//                earlier fold `name`, measured along the fold line as the
//                fold made it (stacked layers merge into one edge).
//   "name@t@x,y" the same, with a folded-coordinates hint picking between
//                stretches when the fold's line crossed the paper in several
//                separate places.
// Raw coordinates are rejected: every position is an edge of the paper or a
// previous fold's edge — that IS the instruction language.
// -----------------------------------------------------------------------------

export type Vec2 = [number, number]

// ── 2D rigid isometries (sheet → folded plane; det ±1) ───────────────────────

export interface Iso {
  a: number
  b: number
  c: number
  d: number
  tx: number
  ty: number
}

const IDENTITY_ISO: Iso = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }

export const applyIso = (T: Iso, p: Vec2): Vec2 => [
  T.a * p[0] + T.b * p[1] + T.tx,
  T.c * p[0] + T.d * p[1] + T.ty,
]

const applyIsoDir = (T: Iso, d: Vec2): Vec2 => [T.a * d[0] + T.b * d[1], T.c * d[0] + T.d * d[1]]

const composeIso = (A: Iso, B: Iso): Iso => ({
  a: A.a * B.a + A.b * B.c,
  b: A.a * B.b + A.b * B.d,
  c: A.c * B.a + A.d * B.c,
  d: A.c * B.b + A.d * B.d,
  tx: A.a * B.tx + A.b * B.ty + A.tx,
  ty: A.c * B.tx + A.d * B.ty + A.ty,
})

const invertIso = (T: Iso): Iso => {
  const dt = T.a * T.d - T.b * T.c
  const a = T.d / dt
  const b = -T.b / dt
  const c = -T.c / dt
  const d = T.a / dt
  return { a, b, c, d, tx: -(a * T.tx + b * T.ty), ty: -(c * T.tx + d * T.ty) }
}

// Reflection across the line through p with unit direction u: M = 2uuᵀ − I.
const reflectAcross = (p: Vec2, u: Vec2): Iso => {
  const a = u[0] * u[0] - u[1] * u[1]
  const b = 2 * u[0] * u[1]
  return {
    a, b, c: b, d: -a,
    tx: p[0] - (a * p[0] + b * p[1]),
    ty: p[1] - (b * p[0] - a * p[1]),
  }
}

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
  // paper it hinges on, about the crease this step made.
  theta: number
  // A full 180° fold — the exact model treats it as a reflection.
  flat: boolean
  // Indices into program.faces of the faces this step rotates.
  moving: number[]
  // The creases this step made, as SHEET segments oriented along the fold
  // line as it lay at the moment of the fold (lo/hi are positions along that
  // line). The player hinges faces about these material lines, so re-driving
  // an earlier fold mid-step moves its creases with the paper. `sign` is the
  // parity of the layer the crease was cut into (+1 face-up, −1 face-down):
  // the fold angle is uniform in the PAPER's frame, so a crease on a
  // mirrored layer turns the other way in the world — one reflection folds
  // the front layer toward the viewer and the back layer away.
  spans: { a: Vec2; b: Vec2; lo: number; hi: number; sign: number }[]
  // The step this group was split from by a range re-drive, or null.
  parent: string | null
  at: number
  dur: number
}

export interface FoldProgram {
  size: number
  // The final faces: convex CCW sheet polygons, plus the EXACT isometry
  // placing each in the folded plane after every flat step (for tests and
  // for resolving; non-flat folds don't move the tracked state).
  faces: { poly: Vec2[]; T: Iso }[]
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

// Where a material point of the sheet currently sits in the folded model.
export function foldedPosition(
  faces: { poly: Vec2[]; T: Iso }[],
  p: Vec2,
): Vec2 | null {
  for (const f of faces) {
    if (pointInPoly(p, f.poly)) return applyIso(f.T, p)
  }
  return null
}

// ── Compilation ───────────────────────────────────────────────────────────────

interface Face {
  poly: Vec2[]
  T: Iso
  movedAt: number[]
}

// One contiguous stretch of the edge a fold created, parametrized along the
// fold line AT THE MOMENT OF THE FOLD (so "name@t" means a fraction of the
// edge as the fold made it — a material point of the paper — and later folds
// may bend or carry it anywhere). Members map spans of the stretch back to
// sheet segments; stacked layers overlap and merge into one stretch.
interface EdgeRun {
  lo: number
  hi: number
  members: { a: Vec2; b: Vec2; lo: number; hi: number }[]
}

interface Resolved {
  sheet: Vec2
  folded: Vec2
}

// Do two convex polygons share a boundary segment of positive length?
function shareEdge(pa: Vec2[], pb: Vec2[]): boolean {
  for (let i = 0; i < pa.length; i++) {
    const a1 = pa[i]
    const a2 = pa[(i + 1) % pa.length]
    const u = sub2(a2, a1)
    const L = len2(u)
    if (L < EPS) continue
    for (let j = 0; j < pb.length; j++) {
      const b1 = pb[j]
      const b2 = pb[(j + 1) % pb.length]
      // Collinear?
      if (Math.abs(cross2(u, sub2(b1, a1))) > 1e-7 * L) continue
      if (Math.abs(cross2(u, sub2(b2, a1))) > 1e-7 * L) continue
      // Overlap along u?
      const t1 = dot2(u, sub2(b1, a1)) / (L * L)
      const t2 = dot2(u, sub2(b2, a1)) / (L * L)
      const lo = Math.max(0, Math.min(t1, t2))
      const hi = Math.min(1, Math.max(t1, t2))
      if (hi - lo > 1e-6) return true
    }
  }
  return false
}

export function compileFoldProgram(
  rows: ReadonlyArray<Record<string, unknown>>,
  opts: { size?: number } = {},
): CompiledFold {
  const size = opts.size ?? 1
  const s = size
  const faces: Face[] = [{
    poly: [[-s, -s], [s, -s], [s, s], [-s, s]],
    T: { ...IDENTITY_ISO },
    movedAt: [],
  }]
  const edgesByGroup = new Map<string, EdgeRun[]>()
  const warnings: string[] = []
  const groups: string[] = []
  const schedule: ScheduleRow[] = []
  interface StepRec {
    group: string
    theta: number
    flat: boolean
    k: number
    spans: { a: Vec2; b: Vec2; lo: number; hi: number; sign: number }[]
    parent: string | null
    at: number
    dur: number
  }
  const steps: StepRec[] = []
  let nextAt = 1

  const parsePoint = (raw: string): Vec2 | null => {
    const m = raw.split(',')
    if (m.length !== 2) return null
    const x = Number(m[0])
    const y = Number(m[1])
    return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null
  }

  const resolveMaterial = (p: Vec2, label: string): Resolved => {
    for (const f of faces) {
      if (pointInPoly(p, f.poly)) return { sheet: p, folded: applyIso(f.T, p) }
    }
    throw new Error(`${label}: point ${p[0]},${p[1]} is not on the paper (sheet spans [-${s}, ${s}]²)`)
  }

  // Resolve "name@t[@near]": the point a fraction t along the edge fold
  // `name` created, measured along the fold line AS THE FOLD MADE IT — a
  // material point of the paper, found again wherever later folds carried
  // it. When the fold line crossed the paper in several separate stretches,
  // `near` (folded coordinates) picks between them.
  const resolveEdgeRef = (name: string, t: number, near: Vec2 | null, label: string): Resolved => {
    const runs = edgesByGroup.get(name)
    if (!runs) {
      throw new Error(`${label}: no fold named "${name}" before this step (known: ${[...edgesByGroup.keys()].join(', ') || 'none'})`)
    }
    const pointOn = (r: EdgeRun): Resolved => {
      const q = r.lo + t * (r.hi - r.lo)
      // The member span covering q maps it back to a sheet point.
      let best = r.members[0]
      let bestGap = Infinity
      for (const m of r.members) {
        const gap = q < m.lo ? m.lo - q : q > m.hi ? q - m.hi : 0
        if (gap < bestGap) {
          bestGap = gap
          best = m
        }
      }
      const qc = Math.min(best.hi, Math.max(best.lo, q))
      const w = best.hi - best.lo < EPS ? 0 : (qc - best.lo) / (best.hi - best.lo)
      const sheet: Vec2 = [
        best.a[0] + w * (best.b[0] - best.a[0]),
        best.a[1] + w * (best.b[1] - best.a[1]),
      ]
      return resolveMaterial(sheet, label)
    }

    if (runs.length === 1) return pointOn(runs[0])
    const candidates = runs.map(pointOn)
    // Coincident layers resolve to the same folded point — no ambiguity.
    const first = candidates[0]
    if (candidates.every((c) => len2(sub2(c.folded, first.folded)) < 1e-6)) return first
    if (near) {
      let best = candidates[0]
      let bestD = Infinity
      for (const c of candidates) {
        const d = len2(sub2(c.folded, near))
        if (d < bestD) {
          bestD = d
          best = c
        }
      }
      return best
    }
    warnings.push(
      `${label}: "${name}@${t}" matches ${candidates.length} edges — took the one at `
      + `${first.folded[0].toFixed(3)},${first.folded[1].toFixed(3)}; add "@x,y" to pick another`,
    )
    return first
  }

  // The four edges of the paper: bottom/top run left→right, left/right run
  // bottom→top, so "@0" is always the lower-left end.
  const PAPER_EDGES: Record<string, [Vec2, Vec2]> = {
    bottom: [[-s, -s], [s, -s]],
    top: [[-s, s], [s, s]],
    left: [[-s, -s], [-s, s]],
    right: [[s, -s], [s, s]],
  }

  // Every position is a point ON A KNOWN EDGE: an edge of the paper, or the
  // edge a previous fold created. Raw coordinates are rejected — that IS the
  // instruction language.
  const resolveRef = (raw: unknown, label: string): Resolved => {
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new Error(`${label}: missing point`)
    }
    const parts = raw.split('@').map((p) => p.trim())
    const name = parts[0]
    const t = parts.length > 1 && parts[1] !== '' ? Number(parts[1]) : 0.5
    if (!Number.isFinite(t)) throw new Error(`${label}: bad fraction in "${raw}"`)
    const paperEdge = PAPER_EDGES[name]
    if (paperEdge) {
      const [a, b] = paperEdge
      return resolveMaterial([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])], label)
    }
    if (edgesByGroup.has(name)) {
      const near = parts.length > 2 ? parsePoint(parts[2]) : null
      return resolveEdgeRef(name, t, near, label)
    }
    throw new Error(
      `${label}: "${raw}" is not a known edge — positions are a paper edge `
      + `("bottom@t", "top@t", "left@t", "right@t") or an earlier fold's edge `
      + `("name@t"; known folds: ${[...edgesByGroup.keys()].join(', ') || 'none yet'})`,
    )
  }

  // Carve the portion [ta, tb] (fractions along the fold's edge as it was
  // made) out of `group` into a derived group of its own, so a re-drive can
  // open one pocket of a crease while the rest stays pressed. The derived
  // group inherits the fold's schedule so far, and the same range always
  // maps to the same derived group.
  const splitRange = (group: string, ta: number, tb: number, label: string): string => {
    const dname = `${group}~${ta}-${tb}`
    if (groups.includes(dname)) return dname
    const parentRec = steps.find((st) => st.group === group)!
    const runs = edgesByGroup.get(group)!
    const keep: StepRec['spans'] = []
    const carved: StepRec['spans'] = []
    for (const sp of parentRec.spans) {
      // The run this span lies in sets the range's absolute positions.
      const run = runs.find((r) => sp.lo >= r.lo - 1e-6 && sp.hi <= r.hi + 1e-6)
      if (!run) {
        keep.push(sp)
        continue
      }
      const qa = run.lo + ta * (run.hi - run.lo)
      const qb = run.lo + tb * (run.hi - run.lo)
      const lo = Math.max(sp.lo, qa)
      const hi = Math.min(sp.hi, qb)
      if (hi - lo < 1e-6) {
        keep.push(sp)
        continue
      }
      const pt = (q: number): Vec2 => {
        const w = (q - sp.lo) / (sp.hi - sp.lo)
        return [sp.a[0] + w * (sp.b[0] - sp.a[0]), sp.a[1] + w * (sp.b[1] - sp.a[1])]
      }
      if (lo - sp.lo > 1e-6) keep.push({ a: sp.a, b: pt(lo), lo: sp.lo, hi: lo, sign: sp.sign })
      carved.push({ a: pt(lo), b: pt(hi), lo, hi, sign: sp.sign })
      if (sp.hi - hi > 1e-6) keep.push({ a: pt(hi), b: sp.b, lo: hi, hi: sp.hi, sign: sp.sign })
    }
    if (!carved.length) {
      warnings.push(`${label}: "${group}@${ta}".."${group}@${tb}" carves nothing off fold "${group}"`)
      return group
    }
    parentRec.spans = keep
    steps.push({
      group: dname,
      theta: parentRec.theta,
      flat: parentRec.flat,
      k: parentRec.k,
      spans: carved,
      parent: group,
      at: parentRec.at,
      dur: parentRec.dur,
    })
    groups.push(dname)
    // Until now the carved portion moved with its fold — inherit that.
    for (const r of [...schedule]) {
      if (r.fold === group) schedule.push({ ...r, fold: dname })
    }
    return dname
  }

  rows.forEach((row, i) => {
    if (!row) return
    const group = row.step != null && row.step !== '' ? String(row.step) : `step${i}`
    const at = typeof row.at === 'number' ? row.at : nextAt
    const dur = typeof row.dur === 'number' && row.dur > 0 ? row.dur : 1
    nextAt = Math.max(nextAt, at + dur)

    const hasLine = row.p1 != null && row.p1 !== '' && row.p2 != null && row.p2 !== ''
    const isRedrive = groups.includes(group)
    // A fold's own row ramps to 1 unless told otherwise — `to` 0 there is
    // meaningless (the folded model always treats the fold as made), and
    // editable tables fill blank number cells with 0. Re-drive rows keep
    // any value: 0 opens the crease flat, −1 refolds it the OTHER way
    // (the same flat endpoint reached through the opposite half-space).
    const to = typeof row.to === 'number' && !(hasLine && !isRedrive && row.to === 0) ? row.to : 1

    if (isRedrive || !hasLine) {
      // Re-drive an earlier fold (flap, open, refold). Animation only — the
      // exact model keeps treating the fold as made, and later point
      // references assume the folded state. With p1/p2 the row drives just
      // the PORTION of the fold's edge between those two points (they must
      // be "name@t" references on the fold itself) — how a collapse opens
      // one pocket of a crease while the rest of it stays pressed.
      if (!isRedrive) {
        warnings.push(`row ${i + 1}: no fold named "${group}" to re-drive — skipped`)
        return
      }
      let target = group
      if (hasLine) {
        const ownT = (raw: unknown, which: string): number => {
          const parts = typeof raw === 'string' ? raw.split('@').map((p) => p.trim()) : []
          const t = parts.length > 1 ? Number(parts[1]) : NaN
          if (parts[0] !== group || !Number.isFinite(t)) {
            throw new Error(
              `fold "${group}" is defined twice — a row re-driving part of it gives ${which} `
              + `as a point on its own edge ("${group}@t")`,
            )
          }
          return Math.min(1, Math.max(0, t))
        }
        const ta = ownT(row.p1, 'p1')
        const tb = ownT(row.p2, 'p2')
        target = splitRange(group, Math.min(ta, tb), Math.max(ta, tb), `row ${i + 1}`)
      }
      schedule.push({ fold: target, at, dur, to, ease: row.ease })
      return
    }

    const label = `fold "${group}"`
    const r1 = resolveRef(row.p1, `${label} p1`)
    const r2 = resolveRef(row.p2, `${label} p2`)
    const P = r1.folded
    const span = sub2(r2.folded, P)
    if (len2(span) < 1e-6) {
      throw new Error(`${label}: p1 and p2 sit at the same folded point — no line`)
    }
    const D = norm2(span)

    const op = row.op === 'fold' ? 'fold' : 'reflect'
    let deg = typeof row.deg === 'number' ? row.deg : 180
    if (op === 'reflect' && Math.abs(deg) !== 180) {
      warnings.push(`${label}: a reflection is a flat 180° fold — deg ${deg} ignored`)
      deg = 180
    }
    const flat = Math.abs(Math.abs(deg) - 180) < 1e-9
    const dir = typeof row.dir === 'number' && row.dir < 0 ? -1 : 1

    // Which side of the line moves.
    let sideSign = 1
    if (row.move != null && row.move !== '') {
      const mv = resolveRef(row.move, `${label} move`)
      const c = cross2(D, sub2(mv.folded, P))
      if (Math.abs(c) < 1e-6) throw new Error(`${label}: move point sits on the fold line`)
      sideSign = Math.sign(c)
    }

    // Cut every face the line crosses (in its own sheet coordinates), and
    // classify each piece by which side of the folded line it lands on.
    interface Piece {
      face: number
      poly: Vec2[]
      side: number
      chord: [Vec2, Vec2] | null // sheet coords, when this face was split
    }
    const pieces: Piece[] = []
    faces.forEach((f, fi) => {
      const inv = invertIso(f.T)
      const p0 = applyIso(inv, P)
      const u0 = applyIsoDir(inv, D)
      const cut = cutConvex(f.poly, p0, u0)
      const sideOf = (poly: Vec2[]): number =>
        Math.sign(cross2(D, sub2(applyIso(f.T, polyCentroid(poly)), P)))
      if (cut.left && cut.right) {
        pieces.push({ face: fi, poly: cut.left, side: sideOf(cut.left), chord: cut.chord })
        pieces.push({ face: fi, poly: cut.right, side: sideOf(cut.right), chord: cut.chord })
      } else {
        pieces.push({ face: fi, poly: f.poly, side: sideOf(f.poly), chord: null })
      }
    })

    // The moving set: everything on the chosen side (reflect), or just the
    // flap connected to `move` through the paper (fold).
    const onSide = pieces.filter((p) => p.side === sideSign)
    let moving: Set<Piece>
    if (op === 'reflect') {
      moving = new Set(onSide)
    } else {
      if (row.move == null || row.move === '') {
        throw new Error(`${label}: op "fold" moves the flap connected to \`move\` — set a move point`)
      }
      const mv = resolveRef(row.move, `${label} move`)
      const seed = onSide.find((p) => pointInPoly(mv.sheet, p.poly))
      if (!seed) {
        throw new Error(`${label}: the move point isn't on the moving side of the line`)
      }
      moving = new Set([seed])
      for (;;) {
        let grew = false
        for (const p of onSide) {
          if (moving.has(p)) continue
          for (const m of moving) {
            if (shareEdge(p.poly, m.poly)) {
              moving.add(p)
              grew = true
              break
            }
          }
        }
        if (!grew) break
      }
    }
    if (!moving.size) {
      warnings.push(`${label}: nothing on that side of the line — skipped`)
      return
    }

    // Commit: split the faces whose halves part ways, mirror the movers.
    const k = steps.length
    const R = reflectAcross(P, D)
    const spans: { a: Vec2; b: Vec2; lo: number; hi: number; sign: number }[] = []
    const nextFaces: Face[] = []
    for (let fi = 0; fi < faces.length; fi++) {
      const f = faces[fi]
      const mine = pieces.filter((p) => p.face === fi)
      if (mine.length === 1) {
        if (moving.has(mine[0])) {
          f.movedAt.push(k)
          if (flat) f.T = composeIso(R, f.T)
        }
        nextFaces.push(f)
        continue
      }
      const mover = mine.find((p) => moving.has(p))
      if (!mover) {
        nextFaces.push(f) // cut but nothing moved: leave the face whole
        continue
      }
      const stay = mine.find((p) => p !== mover)!
      // Record the crease as a span of the fold line (oriented p1→p2), with
      // the parity of the layer it was cut into: the fold angle is uniform
      // in the paper's frame, so a crease cut into a face-down layer turns
      // the other way in the world (front folds toward you, back away).
      const [c1, c2] = mover.chord!
      const t1 = dot2(D, sub2(applyIso(f.T, c1), P))
      const t2 = dot2(D, sub2(applyIso(f.T, c2), P))
      const sign = f.T.a * f.T.d - f.T.b * f.T.c > 0 ? 1 : -1
      spans.push(t1 <= t2
        ? { a: c1, b: c2, lo: t1, hi: t2, sign }
        : { a: c2, b: c1, lo: t2, hi: t1, sign })
      nextFaces.push({ poly: stay.poly, T: f.T, movedAt: [...f.movedAt] })
      nextFaces.push({
        poly: mover.poly,
        T: flat ? composeIso(R, f.T) : f.T,
        movedAt: [...f.movedAt, k],
      })
    }
    faces.length = 0
    faces.push(...nextFaces)
    // Merge the spans into contiguous stretches of the new edge — stacked
    // layers overlap into one; separate stretches stay separate.
    spans.sort((x, y) => x.lo - y.lo)
    const runs: EdgeRun[] = []
    for (const sp of spans) {
      const cur = runs[runs.length - 1]
      if (cur && sp.lo <= cur.hi + 1e-6) {
        cur.members.push(sp)
        cur.hi = Math.max(cur.hi, sp.hi)
      } else {
        runs.push({ lo: sp.lo, hi: sp.hi, members: [sp] })
      }
    }
    edgesByGroup.set(group, runs)

    if (!flat) {
      warnings.push(
        `${label}: a ${deg}° fold leaves the paper off the table — later point `
        + `references treat it as unfolded`,
      )
    }

    // Rotating by +θ about a span (oriented along the fold line) lifts the
    // line's LEFT side toward the viewer, seen in the pre-fold state.
    const theta = (dir * sideSign * Math.abs(deg) * Math.PI) / 180
    steps.push({ group, theta, flat, k, spans, parent: null, at, dur })
    groups.push(group)
    schedule.push({ fold: group, at, dur, to, ease: row.ease })
  })

  const program: FoldProgram = {
    size,
    faces: faces.map((f) => ({ poly: f.poly, T: f.T })),
    steps: steps.map((st) => ({
      group: st.group,
      theta: st.theta,
      flat: st.flat,
      moving: faces.reduce<number[]>((acc, f, i) => {
        if (f.movedAt.includes(st.k)) acc.push(i)
        return acc
      }, []),
      spans: st.spans,
      parent: st.parent,
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
  // the only independently moving pieces are faces created by a fold, and
  // re-driving an earlier fold mid-step carries its creases with the paper —
  // instructions that dip an underlying fold while a reflection completes
  // animate the way hands collapse paper.
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
// sliver of daylight (no z-fighting) while the EXACT model stays exact. The
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

  // ── Hinges: every shared face edge is a crease some fold made ──
  interface Hinge {
    fa: number
    fb: number
    // Sheet line oriented along the fold's span, so rotating fb by +θ about
    // p→q (relative to fa) is the fold's own direction.
    px: number
    py: number
    qx: number
    qy: number
    step: number
    // Layer parity of the crease (from its span): the fold angle is uniform
    // in the paper's frame, so a crease on a face-down layer turns the other
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
  // Pick the tree's hinges (a range split keeps its fold's age):
  //   1. FIRST-LAYER creases (cut into face-up paper), oldest first — a fold
  //      made later moves whole layered assemblies through their older
  //      connections, and re-driving the crease between two layers steers
  //      a collapse.
  //   2. SECOND-LAYER creases (cut into face-down layers) only where nothing
  //      else connects, newest first. When a reflection folds through a
  //      stack, its crease on the mirrored layer is the vertex mechanism's
  //      DEPENDENT crease — its angle follows the other three (one way
  //      pressed, the other way in a collapse) — so it must be where the
  //      loop closes, not a driven hinge.
  const stepAge = program.steps.map((st, si) => {
    if (!st.parent) return si
    const pi = program.steps.findIndex((s) => s.group === st.parent)
    return pi >= 0 ? pi : si
  })
  const tree: TreeEdge[] = []
  {
    const rank = (i: number): number => {
      const h = hinges[i]
      const age = stepAge[h.step]
      return h.sign > 0 ? age : 1e6 - age
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
      const theta = thetas[h.step]
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
