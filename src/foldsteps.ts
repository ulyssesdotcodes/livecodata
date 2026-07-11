// Fold-instruction engine: origami specified the way instructions (and the
// Huzita–Hatori axioms) specify it — as ALIGNMENTS, not crease angles.
//
//   valley / mountain  "fold point (x1,y1) ONTO (x2,y2)" — axiom O2: the
//                      crease is the perpendicular bisector, derived, never
//                      typed. The flap on (x1,y1)'s side swings over as one
//                      rigid body (that is what a simple fold IS, so nothing
//                      can tear or pass through anything mid-motion).
//   unfold             reverse an earlier step by name.
//   collapse           several creases moving together (a base collapse).
//                      Rows WITH timing are driven; rows WITHOUT timing are
//                      followers whose angles are solved each frame from the
//                      rigid-origami closure condition around the vertex —
//                      the product of the hinge rotations must be the
//                      identity — so the paper moves on its true folding
//                      path instead of tearing between key poses.
//
// After every step the paper is an exact FLAT FOLDING in the mathematical
// sense: each face's placement is a composition of reflections, plus a layer
// index. Layers make the stacking explicit — rendering nudges each face by
// layer × ε, so flat states read as real stacked paper and faces never
// z-fight or pass through each other at rest.

import { mulAffine, rotAboutLine2D, IDENTITY_AFFINE, type Affine } from './origami.js'

export interface StepRow {
  step?: unknown
  op?: unknown
  x1?: unknown
  y1?: unknown
  x2?: unknown
  y2?: unknown
  deg?: unknown
  at?: unknown
  dur?: unknown
  [key: string]: unknown
}

// ── Compiled model (pure data; rides along on the create row) ───────────────

interface FoldInstance {
  kind: 'fold'
  group: string
  theta: number // signed target angle in radians (valley +, mountain −)
  moving: number[]
  // Per-moving-face rotation axis in that face's ORIGINAL coordinates: the
  // world crease pulled back through the face's flat state, directed so +θ
  // lifts the flap toward +z.
  axes: number[] // [ax, ay, bx, by] × moving.length
  layerTo: number[] // per moving face
}

interface CollapseHinge {
  // outward unit direction from the vertex, in original coordinates
  ux: number
  uy: number
  driven: boolean
  target: number // radians (driven); followers: seed sign in `seed`
  seed: number
}

interface CollapseInstance {
  kind: 'collapse'
  group: string
  vx: number
  vy: number
  hinges: CollapseHinge[] // sorted CCW by angle
  sector: number[] // face → sector index (sector j lies CCW after hinge j)
  root: number // anchored sector
  layerTo: number[] // per face (all faces), the flat-folded stacking
}

export type OpInstance = FoldInstance | CollapseInstance

export interface FoldedModel {
  size: number
  vertices: [number, number][]
  faces: number[][] // convex polygons, CCW, indices into vertices
  groups: string[]
  ops: OpInstance[]
  // sequence() rows: { fold, at, dur, to } — captured by the DSL
  schedule: { fold: string; at: number; dur: number; to: number }[]
}

// ── 2D flat state ────────────────────────────────────────────────────────────
// A face's placement after flat folds is a planar isometry (det −1 when the
// face is mirrored = paper turned over there).

interface Iso2 {
  a: number
  b: number
  c: number
  d: number
  tx: number
  ty: number
}

const ISO_ID: Iso2 = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }

const isoApply = (t: Iso2, x: number, y: number): [number, number] =>
  [t.a * x + t.b * y + t.tx, t.c * x + t.d * y + t.ty]

// isometries: inverse linear part is the transpose scaled by det (±1)
const isoInvApply = (t: Iso2, x: number, y: number): [number, number] => {
  const det = t.a * t.d - t.b * t.c
  const px = x - t.tx
  const py = y - t.ty
  return [(t.d * px - t.b * py) / det, (-t.c * px + t.a * py) / det]
}

// reflection across the line through (qx,qy) with unit direction (dx,dy)
const reflect = (qx: number, qy: number, dx: number, dy: number): Iso2 => {
  const a = dx * dx - dy * dy
  const b = 2 * dx * dy
  // R = [a b; b -a]; t = q − R·q
  return { a, b, c: b, d: -a, tx: qx - (a * qx + b * qy), ty: qy - (b * qx - a * qy) }
}

const isoMul = (s: Iso2, t: Iso2): Iso2 => ({
  a: s.a * t.a + s.b * t.c,
  b: s.a * t.b + s.b * t.d,
  c: s.c * t.a + s.d * t.c,
  d: s.c * t.b + s.d * t.d,
  tx: s.a * t.tx + s.b * t.ty + s.tx,
  ty: s.c * t.tx + s.d * t.ty + s.ty,
})

// ── mesh with progressive convex splitting ───────────────────────────────────

interface Mesh {
  verts: [number, number][]
  faces: number[][]
}

const EPS = 1e-9

function addVert(mesh: Mesh, x: number, y: number): number {
  for (let i = 0; i < mesh.verts.length; i++) {
    if (Math.abs(mesh.verts[i][0] - x) < 1e-7 && Math.abs(mesh.verts[i][1] - y) < 1e-7) return i
  }
  mesh.verts.push([x, y])
  return mesh.verts.length - 1
}

// Split face by the line { p : n·(p − q) = 0 } (all in original coords).
// Returns [negSide, posSide] index polygons (either may be null).
function splitPoly(
  mesh: Mesh, poly: number[], qx: number, qy: number, nx: number, ny: number,
): [number[] | null, number[] | null] {
  const side = poly.map((vi) => {
    const [x, y] = mesh.verts[vi]
    const s = nx * (x - qx) + ny * (y - qy)
    return Math.abs(s) < 1e-7 ? 0 : Math.sign(s)
  })
  if (!side.includes(1) || !side.includes(-1)) return side.includes(1) ? [null, poly] : [poly, null]
  const neg: number[] = []
  const pos: number[] = []
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length
    const si = side[i]
    const sj = side[j]
    if (si <= 0) neg.push(poly[i])
    if (si >= 0) pos.push(poly[i])
    if (si * sj < 0) {
      const [xi, yi] = mesh.verts[poly[i]]
      const [xj, yj] = mesh.verts[poly[j]]
      const di = nx * (xi - qx) + ny * (yi - qy)
      const dj = nx * (xj - qx) + ny * (yj - qy)
      const t = di / (di - dj)
      const vi = addVert(mesh, xi + (xj - xi) * t, yi + (yj - yi) * t)
      neg.push(vi)
      pos.push(vi)
    }
  }
  return [neg.length >= 3 ? neg : null, pos.length >= 3 ? pos : null]
}

const centroid = (mesh: Mesh, poly: number[]): [number, number] => {
  let x = 0
  let y = 0
  for (const vi of poly) {
    x += mesh.verts[vi][0]
    y += mesh.verts[vi][1]
  }
  return [x / poly.length, y / poly.length]
}

// ── closure solve (rigid-origami single-vertex loop) ─────────────────────────
// Around an interior vertex the composition of the hinge rotations, in cyclic
// order, must equal the identity. Driven hinges follow the schedule; follower
// hinges are solved by Gauss–Newton on the rotation-log residual. Everything
// is a pure function of the drive value v (solved by substepping from flat),
// so scrubbing the timeline is exact and history-free.

type Mat3 = Float64Array

const rot3 = (ux: number, uy: number, theta: number, out: Mat3): void => {
  // axis (ux, uy, 0), |u| = 1
  const c = Math.cos(theta)
  const s = Math.sin(theta)
  const t = 1 - c
  out[0] = c + t * ux * ux
  out[1] = t * ux * uy
  out[2] = s * uy
  out[3] = t * ux * uy
  out[4] = c + t * uy * uy
  out[5] = -s * ux
  out[6] = -s * uy
  out[7] = s * ux
  out[8] = c
}

const mul3 = (a: Mat3, b: Mat3, out: Mat3): void => {
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c]
    }
  }
}

// rotation log: axis·angle 3-vector of R
const log3 = (R: Mat3): [number, number, number] => {
  const tr = R[0] + R[4] + R[8]
  const cosA = Math.min(1, Math.max(-1, (tr - 1) / 2))
  const angle = Math.acos(cosA)
  if (angle < 1e-12) return [0, 0, 0]
  const k = angle / (2 * Math.sin(angle))
  return [k * (R[7] - R[5]), k * (R[2] - R[6]), k * (R[3] - R[1])]
}

function solveClosure(hinges: CollapseHinge[], v: number, out: Float64Array): void {
  const n = hinges.length
  const free: number[] = []
  hinges.forEach((h, i) => {
    if (!h.driven) free.push(i)
  })
  out.fill(0)
  if (v <= 0) return
  const R = new Float64Array(9)
  const T = new Float64Array(9)
  const P: Float64Array[] = Array.from({ length: n }, () => new Float64Array(9))
  const tmp = new Float64Array(9)
  const substeps = Math.max(2, Math.ceil(v * 24))
  for (let s = 1; s <= substeps; s++) {
    const u = (v * s) / substeps
    for (let i = 0; i < n; i++) if (hinges[i].driven) out[i] = hinges[i].target * u
    if (s === 1) for (const i of free) out[i] = hinges[i].seed * 0.3 * u
    for (let iter = 0; iter < 8; iter++) {
      // R = Π Rot(u_i, θ_i); P[i] = prefix before hinge i
      R.set([1, 0, 0, 0, 1, 0, 0, 0, 1])
      for (let i = 0; i < n; i++) {
        P[i].set(R)
        rot3(hinges[i].ux, hinges[i].uy, out[i], T)
        mul3(R, T, tmp)
        R.set(tmp)
      }
      const r = log3(R)
      const err = Math.hypot(r[0], r[1], r[2])
      if (err < 1e-11) break
      // J columns (free hinges only): w_i = P_i · axis_i
      const J: number[][] = free.map((i) => {
        const p = P[i]
        const ux = hinges[i].ux
        const uy = hinges[i].uy
        return [p[0] * ux + p[1] * uy, p[3] * ux + p[4] * uy, p[6] * ux + p[7] * uy]
      })
      // least-norm Δ = −Jᵀ (J Jᵀ)⁻¹ r   (J is 3×nf laid out as nf columns)
      const A = new Float64Array(9) // J Jᵀ (3×3)
      for (const w of J) {
        for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) A[a * 3 + b] += w[a] * w[b]
      }
      A[0] += 1e-9
      A[4] += 1e-9
      A[8] += 1e-9
      const y = solve3(A, r)
      if (!y) break
      for (let k = 0; k < free.length; k++) {
        const w = J[k]
        const d = -(w[0] * y[0] + w[1] * y[1] + w[2] * y[2])
        out[free[k]] += Math.max(-0.5, Math.min(0.5, d))
      }
    }
  }
}

function solve3(A: Float64Array, b: [number, number, number]): [number, number, number] | null {
  const m = Array.from(A)
  const x = [b[0], b[1], b[2]]
  for (let col = 0; col < 3; col++) {
    let piv = col
    for (let r = col + 1; r < 3; r++) if (Math.abs(m[r * 3 + col]) > Math.abs(m[piv * 3 + col])) piv = r
    if (Math.abs(m[piv * 3 + col]) < 1e-14) return null
    if (piv !== col) {
      for (let c = 0; c < 3; c++) {
        const t = m[col * 3 + c]
        m[col * 3 + c] = m[piv * 3 + c]
        m[piv * 3 + c] = t
      }
      const t = x[col]
      x[col] = x[piv]
      x[piv] = t
    }
    for (let r = 0; r < 3; r++) {
      if (r === col) continue
      const f = m[r * 3 + col] / m[col * 3 + col]
      for (let c = col; c < 3; c++) m[r * 3 + c] -= f * m[col * 3 + c]
      x[r] -= f * x[col]
    }
  }
  return [x[0] / m[0], x[1] / m[4], x[2] / m[8]]
}

// ── compile ──────────────────────────────────────────────────────────────────

interface TimedOp {
  step: string
  op: string
  rows: StepRow[]
  at: number
  dur: number
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

export function compileFoldSteps(rowsIn: StepRow[], size = 1): FoldedModel {
  const rows = rowsIn.filter((r) => r && r.step != null && r.op != null)

  // Group rows into timed op instances. Fold/unfold rows are one instance
  // each; a collapse step's rows (driven + followers) form one instance,
  // timed by its driven rows.
  const timeline: TimedOp[] = []
  const collapseByStep = new Map<string, TimedOp>()
  for (const r of rows) {
    const step = String(r.step)
    const op = String(r.op)
    if (op === 'collapse') {
      let inst = collapseByStep.get(step)
      if (!inst) {
        inst = { step, op, rows: [], at: Infinity, dur: 1 }
        collapseByStep.set(step, inst)
        timeline.push(inst)
      }
      inst.rows.push(r)
      const at = num(r.at)
      if (at != null && at < inst.at) {
        inst.at = at
        inst.dur = num(r.dur) ?? 1
      }
    } else {
      const at = num(r.at)
      if (at == null) throw new Error(`origami step "${step}" (${op}): needs an \`at\` beat`)
      timeline.push({ step, op, rows: [r], at, dur: num(r.dur) ?? 1 })
    }
  }
  timeline.sort((a, b) => a.at - b.at)
  for (const t of timeline) {
    if (t.op === 'collapse' && !Number.isFinite(t.at)) {
      throw new Error(`origami collapse "${t.step}": at least one row needs \`at\`/\`dur\` timing (the driven creases)`)
    }
  }

  const schedule: FoldedModel['schedule'] = timeline.map((t) => ({
    fold: t.step, at: t.at, dur: t.dur, to: t.op === 'unfold' ? 0 : 1,
  }))

  // Simulate the timeline over a mesh, splitting faces as creases arrive.
  // Runs twice: pass 1 discovers every split; pass 2 re-runs on the final
  // face set so instance data is keyed to stable face indices.
  const simulate = (mesh: Mesh, collect: boolean): OpInstance[] => {
    const nf = (): number => mesh.faces.length
    let state: Iso2[] = mesh.faces.map(() => ({ ...ISO_ID }))
    let layer: number[] = mesh.faces.map(() => 0)
    // per-step saved snapshots so `unfold` can restore
    const snapshots = new Map<string, { state: Iso2[]; layer: number[] }>()
    const ops: OpInstance[] = []

    for (const inst of timeline) {
      if (inst.op === 'unfold') {
        const snap = snapshots.get(inst.step)
        if (!snap) throw new Error(`origami unfold "${inst.step}": no such fold before it`)
        state = snap.state.map((s) => ({ ...s }))
        layer = [...snap.layer]
        // pad in case pass-1 splitting grew the mesh after the snapshot
        while (state.length < nf()) {
          state.push({ ...ISO_ID })
          layer.push(0)
        }
        continue
      }

      if (inst.op === 'valley' || inst.op === 'mountain') {
        const r = inst.rows[0]
        const p1x = num(r.x1)
        const p1y = num(r.y1)
        const p2x = num(r.x2)
        const p2y = num(r.y2)
        if (p1x == null || p1y == null || p2x == null || p2y == null) {
          throw new Error(`origami ${inst.op} "${inst.step}": needs x1,y1 (the point that moves) and x2,y2 (where it lands)`)
        }
        const deg = Math.abs(num(r.deg) ?? 180)
        const dir = inst.op === 'valley' ? 1 : -1
        // axiom O2: crease = perpendicular bisector of p1 → p2
        const mx = (p1x + p2x) / 2
        const my = (p1y + p2y) / 2
        let nx = p2x - p1x
        let ny = p2y - p1y
        const nl = Math.hypot(nx, ny)
        if (nl < EPS) throw new Error(`origami ${inst.op} "${inst.step}": the two points coincide`)
        nx /= nl
        ny /= nl
        // crease direction, oriented so the moving side (p1's side) is LEFT
        // of a→b — then +θ rotates the flap toward +z (valley).
        let dx = -ny
        let dy = nx
        if (dx * (p1y - my) - dy * (p1x - mx) < 0) {
          dx = -dx
          dy = -dy
        }

        // split every face the crease crosses (pulled back per face)
        for (let f = 0; f < nf(); f++) {
          const T = state[f]
          const [qx, qy] = isoInvApply(T, mx, my)
          const det = T.a * T.d - T.b * T.c
          // isometry: pull back the normal with the transpose (times det)
          const nqx = (T.a * nx + T.c * ny) * 1
          const nqy = (T.b * nx + T.d * ny) * 1
          const [negP, posP] = splitPoly(mesh, mesh.faces[f], qx, qy, nqx, nqy)
          if (negP && posP) {
            mesh.faces[f] = negP
            mesh.faces.push(posP)
            state.push({ ...state[f] })
            layer.push(layer[f])
            void det
          }
        }

        // moving faces: view-space centroid on p1's side of the crease
        const moving: number[] = []
        const axes: number[] = []
        const p1side = Math.sign(nx * (p1x - mx) + ny * (p1y - my))
        for (let f = 0; f < nf(); f++) {
          const [cx0, cy0] = centroid(mesh, mesh.faces[f])
          const [cx, cy] = isoApply(state[f], cx0, cy0)
          const s = nx * (cx - mx) + ny * (cy - my)
          if (Math.sign(s) === p1side && Math.abs(s) > 1e-7) {
            moving.push(f)
            // directed world axis (a → b) pulled back through this face's state
            const [ax, ay] = isoInvApply(state[f], mx, my)
            const [bx, by] = isoInvApply(state[f], mx + dx, my + dy)
            axes.push(ax, ay, bx, by)
          }
        }

        snapshots.set(inst.step, { state: state.map((s) => ({ ...s })), layer: [...layer] })

        // new flat state (only exactly-flat folds change the flat state)
        const flat = deg > 179
        const layerTo: number[] = []
        if (flat) {
          const refl = reflect(mx, my, dx, dy)
          let statMax = -Infinity
          let statMin = Infinity
          let movMax = -Infinity
          let movMin = Infinity
          const movSet = new Set(moving)
          for (let f = 0; f < nf(); f++) {
            if (movSet.has(f)) {
              movMax = Math.max(movMax, layer[f])
              movMin = Math.min(movMin, layer[f])
            } else {
              statMax = Math.max(statMax, layer[f])
              statMin = Math.min(statMin, layer[f])
            }
          }
          if (statMax === -Infinity) {
            statMax = 0
            statMin = 0
          }
          for (const f of moving) {
            const l = dir > 0
              ? statMax + 1 + (movMax - layer[f]) // valley: reversed stack on top
              : statMin - 1 - (layer[f] - movMin) // mountain: reversed stack below
            layerTo.push(l)
          }
          moving.forEach((f, k) => {
            state[f] = isoMul(refl, state[f])
            layer[f] = layerTo[k]
          })
        } else {
          for (const f of moving) layerTo.push(layer[f])
        }

        if (collect) {
          ops.push({
            kind: 'fold', group: inst.step, theta: dir * (deg * Math.PI) / 180,
            moving, axes, layerTo,
          })
        }
        continue
      }

      // collapse
      {
        // all lines must pass through one common vertex, on flat paper
        for (const s of state) {
          const d = Math.abs(s.a - 1) + Math.abs(s.b) + Math.abs(s.c) + Math.abs(s.d - 1) + Math.abs(s.tx) + Math.abs(s.ty)
          if (d > 1e-6) throw new Error(`origami collapse "${inst.step}": the paper must be fully unfolded first (for now)`)
        }
        const lines = inst.rows.map((r) => {
          const x1 = num(r.x1)
          const y1 = num(r.y1)
          const x2 = num(r.x2)
          const y2 = num(r.y2)
          if (x1 == null || y1 == null || x2 == null || y2 == null) {
            throw new Error(`origami collapse "${inst.step}": every row needs a crease line x1,y1,x2,y2`)
          }
          return { x1, y1, x2, y2, deg: num(r.deg) ?? 180, driven: num(r.at) != null }
        })
        // common vertex = intersection of the first two lines
        const inter = lineIntersect(lines[0], lines[1])
        if (!inter) throw new Error(`origami collapse "${inst.step}": creases must cross at one vertex`)
        const [vx, vy] = inter
        for (const L of lines) {
          const d = distToLine(vx, vy, L)
          if (d > 1e-6) throw new Error(`origami collapse "${inst.step}": all creases must pass through one vertex (for now)`)
        }

        // split faces by every line
        for (const L of lines) {
          const nx = -(L.y2 - L.y1)
          const ny = L.x2 - L.x1
          const nl = Math.hypot(nx, ny)
          for (let f = 0; f < nf(); f++) {
            const [negP, posP] = splitPoly(mesh, mesh.faces[f], L.x1, L.y1, nx / nl, ny / nl)
            if (negP && posP) {
              mesh.faces[f] = negP
              mesh.faces.push(posP)
              state.push({ ...state[f] })
              layer.push(layer[f])
            }
          }
        }

        // hinges: each line contributes its half-lines from V that actually
        // reach the paper; sorted CCW
        const hinges: CollapseHinge[] = []
        for (const L of lines) {
          for (const [ex, ey] of [[L.x1, L.y1], [L.x2, L.y2]] as const) {
            const dx = ex - vx
            const dy = ey - vy
            const len = Math.hypot(dx, dy)
            if (len < 1e-7) continue
            hinges.push({
              ux: dx / len, uy: dy / len,
              driven: L.driven,
              target: (L.deg * Math.PI) / 180,
              seed: Math.sign(L.deg) || 1,
            })
          }
        }
        hinges.sort((a, b) => Math.atan2(a.uy, a.ux) - Math.atan2(b.uy, b.ux))

        // sectors: face → the hinge wedge its centroid falls in
        const hAngles = hinges.map((h) => Math.atan2(h.uy, h.ux))
        const sector: number[] = []
        for (let f = 0; f < nf(); f++) {
          const [cx, cy] = centroid(mesh, mesh.faces[f])
          let ang = Math.atan2(cy - vy, cx - vx)
          let j = hinges.length - 1
          for (let i = 0; i < hinges.length; i++) {
            if (ang >= hAngles[i]) j = i
          }
          // faces whose centroid angle precedes the first hinge belong to the
          // wrap-around sector (after the last hinge)
          if (ang < hAngles[0]) j = hinges.length - 1
          sector.push(j)
          void ang
        }
        // root: the sector facing the viewer's lower half (reads steadiest)
        let root = 0
        let best = Infinity
        for (let j = 0; j < hinges.length; j++) {
          const a0 = hAngles[j]
          const a1 = j + 1 < hinges.length ? hAngles[j + 1] : hAngles[0] + 2 * Math.PI
          const mid = (a0 + a1) / 2
          const d = Math.abs(Math.atan2(Math.sin(mid + Math.PI / 2), Math.cos(mid + Math.PI / 2)))
          if (d < best) {
            best = d
            root = j
          }
        }

        snapshots.set(inst.step, { state: state.map((s) => ({ ...s })), layer: [...layer] })

        // final layers: z-order just before fully flat
        const theta = new Float64Array(hinges.length)
        solveClosure(hinges, 1 - 1e-4, theta)
        const S = sectorTransforms(hinges, vx, vy, theta, root)
        const zc: { f: number; z: number }[] = []
        for (let f = 0; f < nf(); f++) {
          const [cx, cy] = centroid(mesh, mesh.faces[f])
          const t = S[sector[f]]
          zc.push({ f, z: t[8] * cx + t[9] * cy + t[11] })
        }
        zc.sort((a, b) => a.z - b.z)
        const layerTo: number[] = new Array(nf()).fill(0)
        // rank z-bands into layers (faces within a band share a layer)
        let lay = 0
        for (let i = 0; i < zc.length; i++) {
          if (i > 0 && zc[i].z - zc[i - 1].z > 1e-6) lay++
          layerTo[zc[i].f] = lay
        }

        // settle the flat state: snap driven to target, followers to flat
        const thetaEnd = new Float64Array(hinges.length)
        hinges.forEach((h, i) => {
          thetaEnd[i] = h.driven ? h.target : 0
        })
        const Send = sectorTransforms(hinges, vx, vy, thetaEnd, root)
        for (let f = 0; f < nf(); f++) {
          const t = Send[sector[f]]
          // by closure the end state is exactly planar: take its 2D part
          const flat2: Iso2 = { a: t[0], b: t[1], c: t[4], d: t[5], tx: t[3], ty: t[7] }
          state[f] = isoMul(flat2, state[f])
          layer[f] = layerTo[f]
        }

        if (collect) {
          ops.push({ kind: 'collapse', group: inst.step, vx, vy, hinges, sector, root, layerTo })
        }
      }
    }
    return ops
  }

  // pass 1: discover splits
  const s = size
  const mesh: Mesh = {
    verts: [[-s, -s], [s, -s], [s, s], [-s, s]],
    faces: [[0, 1, 2, 3]],
  }
  simulate(mesh, false)
  // pass 2: stable face set
  const ops = simulate(mesh, true)

  const groups = [...new Set(timeline.map((t) => t.step))]
  return { size, vertices: mesh.verts, faces: mesh.faces, groups, ops, schedule }
}

function lineIntersect(
  a: { x1: number; y1: number; x2: number; y2: number },
  b: { x1: number; y1: number; x2: number; y2: number },
): [number, number] | null {
  const d1x = a.x2 - a.x1
  const d1y = a.y2 - a.y1
  const d2x = b.x2 - b.x1
  const d2y = b.y2 - b.y1
  const den = d1x * d2y - d1y * d2x
  if (Math.abs(den) < 1e-12) return null
  const t = ((b.x1 - a.x1) * d2y - (b.y1 - a.y1) * d2x) / den
  return [a.x1 + d1x * t, a.y1 + d1y * t]
}

const distToLine = (px: number, py: number, L: { x1: number; y1: number; x2: number; y2: number }): number => {
  const dx = L.x2 - L.x1
  const dy = L.y2 - L.y1
  const len = Math.hypot(dx, dy)
  return Math.abs(dy * (px - L.x1) - dx * (py - L.y1)) / len
}

// Sector placements: walking CCW from the root sector, crossing hinge i
// multiplies by Rot(axis_i, θ_i) on the right (axes are lines through V in
// original coordinates, so the composition telescopes exactly like the
// rigid solver's tree).
function sectorTransforms(
  hinges: CollapseHinge[], vx: number, vy: number, theta: Float64Array, root: number,
): Affine[] {
  const n = hinges.length
  const S: Affine[] = Array.from({ length: n }, () => new Float64Array(IDENTITY_AFFINE))
  const R: Affine = new Float64Array(12)
  const tmp: Affine = new Float64Array(12)
  let cur: Affine = new Float64Array(IDENTITY_AFFINE)
  // crossing from sector j into sector j+1 crosses hinge j+1
  for (let k = 1; k < n; k++) {
    const j = (root + k) % n
    rotAboutLine2D(vx, vy, vx + hinges[j].ux, vy + hinges[j].uy, theta[j], R)
    mulAffine(cur, R, tmp)
    cur = new Float64Array(tmp)
    S[j].set(cur)
  }
  return S
}

// ── runtime solver ───────────────────────────────────────────────────────────

export interface FoldedSolver {
  readonly positions: Float32Array
  readonly linePositions: Float32Array
  readonly groups: string[]
  step(fracs: Record<string, number>): void
}

const LAYER_EPS = 0.012

const smooth = (t: number): number => t * t * (3 - 2 * t)

export function createFoldedSolver(model: FoldedModel): FoldedSolver {
  const nf = model.faces.length
  // convex fan triangulation, non-indexed
  let triCount = 0
  for (const poly of model.faces) triCount += poly.length - 2
  const positions = new Float32Array(triCount * 9)
  let edgeCount = 0
  for (const poly of model.faces) edgeCount += poly.length
  const linePositions = new Float32Array(edgeCount * 6)

  const transforms: Affine[] = Array.from({ length: nf }, () => new Float64Array(IDENTITY_AFFINE))
  const layers = new Float64Array(nf)
  const R: Affine = new Float64Array(12)
  const tmp: Affine = new Float64Array(12)
  const theta = new Float64Array(
    Math.max(1, ...model.ops.map((o) => (o.kind === 'collapse' ? o.hinges.length : 0))),
  )

  const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)

  function step(fracs: Record<string, number>): void {
    for (const t of transforms) t.set(IDENTITY_AFFINE)
    layers.fill(0)

    for (const op of model.ops) {
      const v = clamp01(fracs[op.group] ?? 0)
      if (op.kind === 'fold') {
        if (v <= 0) continue
        const ang = op.theta * v
        for (let k = 0; k < op.moving.length; k++) {
          const f = op.moving[k]
          rotAboutLine2D(op.axes[k * 4], op.axes[k * 4 + 1], op.axes[k * 4 + 2], op.axes[k * 4 + 3], ang, R)
          mulAffine(transforms[f], R, tmp)
          transforms[f].set(tmp)
          layers[f] += (op.layerTo[k] - layers[f]) * smooth(v)
        }
      } else {
        if (v <= 0) continue
        solveClosure(op.hinges, v, theta)
        const S = sectorTransforms(op.hinges, op.vx, op.vy, theta, op.root)
        const w = smooth(clamp01((v - 0.75) / 0.25))
        for (let f = 0; f < nf; f++) {
          mulAffine(transforms[f], S[op.sector[f]], tmp)
          transforms[f].set(tmp)
          layers[f] += (op.layerTo[f] - layers[f]) * w
        }
      }
    }

    let p = 0
    let lp = 0
    for (let f = 0; f < nf; f++) {
      const poly = model.faces[f]
      const t = transforms[f]
      const zoff = layers[f] * LAYER_EPS * model.size
      const px: number[] = []
      const py: number[] = []
      const pz: number[] = []
      for (const vi of poly) {
        const [x, y] = model.vertices[vi]
        px.push(t[0] * x + t[1] * y + t[3])
        py.push(t[4] * x + t[5] * y + t[7])
        pz.push(t[8] * x + t[9] * y + t[11] + zoff)
      }
      for (let k = 1; k + 1 < poly.length; k++) {
        positions[p] = px[0]
        positions[p + 1] = py[0]
        positions[p + 2] = pz[0]
        positions[p + 3] = px[k]
        positions[p + 4] = py[k]
        positions[p + 5] = pz[k]
        positions[p + 6] = px[k + 1]
        positions[p + 7] = py[k + 1]
        positions[p + 8] = pz[k + 1]
        p += 9
      }
      for (let k = 0; k < poly.length; k++) {
        const k2 = (k + 1) % poly.length
        linePositions[lp] = px[k]
        linePositions[lp + 1] = py[k]
        linePositions[lp + 2] = pz[k]
        linePositions[lp + 3] = px[k2]
        linePositions[lp + 4] = py[k2]
        linePositions[lp + 5] = pz[k2]
        lp += 6
      }
    }
  }

  step({})
  return { positions, linePositions, groups: model.groups, step }
}
