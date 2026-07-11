// livecodata origami — crease patterns folded live
// ----------------------------------------------------------------------------
// A rigid-ish origami engine in two halves:
//
//   compilePattern(spec)  — pure 2D computational geometry. Take a square sheet
//     plus a list of crease LINES (each with a group name and a target fold
//     angle) and build a fold model: planarize the segments (split them at
//     every crossing), extract the faces of the resulting planar graph,
//     triangulate each face, and record a hinge for every edge shared by two
//     triangles. Crease hinges drive toward their target angle; "facet" hinges
//     (triangulation diagonals) drive toward 0, which is what keeps a flat
//     panel acting like stiff paper. The output is plain JSON — it travels in
//     a table row (shape: "origami", pattern: <CompiledPattern>).
//
//   createFoldSolver(pattern) — a small spring-mass solver over that model
//     (axial springs on every edge + angular springs on every hinge), stepped
//     each render frame toward per-group fold FRACTIONS (0 = flat sheet,
//     1 = the crease's full target angle). The fractions are just numeric
//     fields on scene rows, so folds ride the normal beat/keyframe machinery —
//     and because the solver integrates from wherever the paper currently is,
//     scrubbing backwards physically unfolds it.
//
// Angle convention: the sheet starts flat in the XY plane with its front
// (colored) side facing +z. A positive target angle is a VALLEY fold as seen
// from the front (the two faces fold toward +z / the viewer); negative is a
// MOUNTAIN fold. Angles are in degrees in specs, radians inside the solver.
// ----------------------------------------------------------------------------

export type Vec2 = [number, number]

export interface CreaseSpec {
  x1: number
  y1: number
  x2: number
  y2: number
  group: string
  // Target fold angle in degrees at fold fraction 1. +valley / −mountain.
  angle: number
}

export interface PatternSpec {
  // Half-extent of the square sheet (paper spans [-size, size]²).
  size: number
  creases: CreaseSpec[]
}

export interface Hinge {
  // The shared edge (a, b), directed as it appears (CCW) in the first face.
  e: [number, number]
  // Wing vertices: [third vertex of the face containing a→b, third vertex of
  // the face containing b→a].
  w: [number, number]
  // Crease group, or null for a facet hinge (triangulation diagonal).
  group: string | null
  // Target dihedral in radians at fold fraction 1 (0 for facets).
  target: number
}

export interface CompiledPattern {
  size: number
  vertices: Vec2[]
  faces: [number, number, number][]
  hinges: Hinge[]
  // Edges drawn as crease/border lines (facet diagonals excluded).
  lines: [number, number][]
  groups: string[]
}

const EPS = 1e-7

// ── 2D helpers ────────────────────────────────────────────────────────────────

const sub2 = (a: Vec2, b: Vec2): Vec2 => [a[0] - b[0], a[1] - b[1]]
const cross2 = (a: Vec2, b: Vec2): number => a[0] * b[1] - a[1] * b[0]
const len2 = (a: Vec2): number => Math.hypot(a[0], a[1])

// Clip segment p→q to the square [-s, s]² (Liang–Barsky). Null if fully outside.
function clipToSquare(p: Vec2, q: Vec2, s: number): [Vec2, Vec2] | null {
  let t0 = 0
  let t1 = 1
  const d: Vec2 = sub2(q, p)
  const checks: [number, number][] = [
    [-d[0], p[0] + s], // x >= -s
    [d[0], s - p[0]],  // x <= s
    [-d[1], p[1] + s], // y >= -s
    [d[1], s - p[1]],  // y <= s
  ]
  for (const [den, num] of checks) {
    if (Math.abs(den) < EPS) {
      if (num < 0) return null
      continue
    }
    const t = num / den
    if (den < 0) {
      if (t > t1) return null
      if (t > t0) t0 = t
    } else {
      if (t < t0) return null
      if (t < t1) t1 = t
    }
  }
  if (t1 - t0 < EPS) return null
  return [
    [p[0] + t0 * d[0], p[1] + t0 * d[1]],
    [p[0] + t1 * d[0], p[1] + t1 * d[1]],
  ]
}

// Point on segment (inclusive), within tolerance.
function onSegment(p: Vec2, a: Vec2, b: Vec2, eps: number): boolean {
  const ab = sub2(b, a)
  const ap = sub2(p, a)
  const L = len2(ab)
  if (L < eps) return false
  if (Math.abs(cross2(ab, ap)) / L > eps) return false
  const t = (ap[0] * ab[0] + ap[1] * ab[1]) / (L * L)
  return t >= -eps && t <= 1 + eps
}

interface Seg {
  a: Vec2
  b: Vec2
  group: string | null // null → border of the sheet
  angle: number
}

// ── Planarization: segments → vertices + unique edges ────────────────────────

interface PlanarGraph {
  vertices: Vec2[]
  // edge key "i,j" (i<j) → metadata
  edges: Map<string, { a: number; b: number; group: string | null; angle: number }>
}

function planarize(segs: Seg[], snapEps: number): PlanarGraph {
  const vertices: Vec2[] = []
  const addVertex = (p: Vec2): number => {
    for (let i = 0; i < vertices.length; i++) {
      if (Math.abs(vertices[i][0] - p[0]) < snapEps && Math.abs(vertices[i][1] - p[1]) < snapEps) return i
    }
    vertices.push([p[0], p[1]])
    return vertices.length - 1
  }

  // Split points per segment, as params t along the segment.
  const cuts: number[][] = segs.map(() => [0, 1])
  const paramOn = (s: Seg, p: Vec2): number => {
    const d = sub2(s.b, s.a)
    const L2 = d[0] * d[0] + d[1] * d[1]
    return (((p[0] - s.a[0]) * d[0] + (p[1] - s.a[1]) * d[1])) / L2
  }

  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const s = segs[i]
      const t = segs[j]
      const r = sub2(s.b, s.a)
      const q = sub2(t.b, t.a)
      const denom = cross2(r, q)
      if (Math.abs(denom) > EPS) {
        // Proper (or endpoint-touching) crossing.
        const w = sub2(t.a, s.a)
        const u = cross2(w, q) / denom
        const v = cross2(w, r) / denom
        if (u > -EPS && u < 1 + EPS && v > -EPS && v < 1 + EPS) {
          cuts[i].push(Math.min(1, Math.max(0, u)))
          cuts[j].push(Math.min(1, Math.max(0, v)))
        }
      } else {
        // Parallel: handle T-junctions of collinear/overlapping pieces by
        // projecting each endpoint onto the other segment.
        for (const p of [t.a, t.b]) if (onSegment(p, s.a, s.b, snapEps)) cuts[i].push(paramOn(s, p))
        for (const p of [s.a, s.b]) if (onSegment(p, t.a, t.b, snapEps)) cuts[j].push(paramOn(t, p))
      }
    }
  }

  const edges: PlanarGraph['edges'] = new Map()
  segs.forEach((s, si) => {
    const d = sub2(s.b, s.a)
    const ts = [...new Set(cuts[si].map((t) => Math.min(1, Math.max(0, t))))].sort((x, y) => x - y)
    let prev: number | null = null
    for (const t of ts) {
      const vi = addVertex([s.a[0] + t * d[0], s.a[1] + t * d[1]])
      if (prev !== null && prev !== vi) {
        const [a, b] = prev < vi ? [prev, vi] : [vi, prev]
        // Later segments override earlier ones on the same edge — so a preset
        // can re-assign a stretch of an existing crease.
        edges.set(`${a},${b}`, { a, b, group: s.group, angle: s.angle })
      }
      prev = vi
    }
  })

  // Drop dangling (degree-1) crease edges — a crease that ends mid-face can't
  // fold anything and would break face extraction. Iterate: removing one edge
  // can strand another.
  for (;;) {
    const degree = new Map<number, number>()
    for (const e of edges.values()) {
      degree.set(e.a, (degree.get(e.a) ?? 0) + 1)
      degree.set(e.b, (degree.get(e.b) ?? 0) + 1)
    }
    let removed = false
    for (const [k, e] of edges) {
      if ((degree.get(e.a) ?? 0) < 2 || (degree.get(e.b) ?? 0) < 2) {
        edges.delete(k)
        removed = true
      }
    }
    if (!removed) break
  }

  return { vertices, edges }
}

// ── Face extraction (planar straight-line graph, CCW interior faces) ─────────

function extractFaces(g: PlanarGraph): number[][] {
  // Sorted neighbor lists per vertex (CCW by angle).
  const nbrs = new Map<number, number[]>()
  for (const e of g.edges.values()) {
    if (!nbrs.has(e.a)) nbrs.set(e.a, [])
    if (!nbrs.has(e.b)) nbrs.set(e.b, [])
    nbrs.get(e.a)!.push(e.b)
    nbrs.get(e.b)!.push(e.a)
  }
  const angleOf = (from: number, to: number): number => {
    const p = g.vertices[from]
    const q = g.vertices[to]
    return Math.atan2(q[1] - p[1], q[0] - p[0])
  }
  for (const [v, list] of nbrs) list.sort((x, y) => angleOf(v, x) - angleOf(v, y))

  const visited = new Set<string>()
  const faces: number[][] = []
  for (const e of g.edges.values()) {
    for (const [u0, v0] of [[e.a, e.b], [e.b, e.a]] as [number, number][]) {
      if (visited.has(`${u0},${v0}`)) continue
      // Walk the face keeping the interior on the left: at each vertex, take
      // the neighbor just clockwise of the reversed incoming edge.
      const loop: number[] = []
      let u = u0
      let v = v0
      for (let guard = 0; guard < g.edges.size * 2 + 4; guard++) {
        visited.add(`${u},${v}`)
        loop.push(u)
        const list = nbrs.get(v)!
        const back = angleOf(v, u)
        // Neighbor with the largest angle strictly less than `back` (cyclic).
        let best = -1
        let bestAngle = -Infinity
        let max = -1
        let maxAngle = -Infinity
        for (const w of list) {
          const aw = angleOf(v, w)
          if (aw < back - 1e-12 && aw > bestAngle) {
            bestAngle = aw
            best = w
          }
          if (aw > maxAngle) {
            maxAngle = aw
            max = w
          }
        }
        const next = best !== -1 ? best : max
        u = v
        v = next
        if (u === u0 && v === v0) break
      }
      // Signed area: keep CCW (interior) faces, drop the outer face.
      let area = 0
      for (let i = 0; i < loop.length; i++) {
        const p = g.vertices[loop[i]]
        const q = g.vertices[loop[(i + 1) % loop.length]]
        area += p[0] * q[1] - q[0] * p[1]
      }
      if (area > EPS && loop.length >= 3) faces.push(loop)
    }
  }
  return faces
}

// ── Triangulation (ear clipping; polygons are small and hole-free) ───────────

function triangulate(loop: number[], vertices: Vec2[]): [number, number, number][] {
  const tris: [number, number, number][] = []
  const idx = [...loop]
  const area2 = (a: number, b: number, c: number): number =>
    cross2(sub2(vertices[b], vertices[a]), sub2(vertices[c], vertices[a]))
  const inTri = (p: Vec2, a: number, b: number, c: number): boolean => {
    const s1 = cross2(sub2(vertices[b], vertices[a]), sub2(p, vertices[a]))
    const s2 = cross2(sub2(vertices[c], vertices[b]), sub2(p, vertices[b]))
    const s3 = cross2(sub2(vertices[a], vertices[c]), sub2(p, vertices[c]))
    return s1 > EPS && s2 > EPS && s3 > EPS
  }

  let guard = idx.length * idx.length + 8
  while (idx.length > 3 && guard-- > 0) {
    let clipped = false
    // Pass 1: a strictly convex ear with no contained vertex.
    for (let i = 0; i < idx.length; i++) {
      const a = idx[(i + idx.length - 1) % idx.length]
      const b = idx[i]
      const c = idx[(i + 1) % idx.length]
      if (area2(a, b, c) <= EPS) continue
      let blocked = false
      for (const o of idx) {
        if (o === a || o === b || o === c) continue
        if (inTri(vertices[o], a, b, c)) {
          blocked = true
          break
        }
      }
      if (blocked) continue
      tris.push([a, b, c])
      idx.splice(i, 1)
      clipped = true
      break
    }
    if (clipped) continue
    // Pass 2: only collinear (zero-area) ears remain — drop one silently.
    for (let i = 0; i < idx.length; i++) {
      const a = idx[(i + idx.length - 1) % idx.length]
      const b = idx[i]
      const c = idx[(i + 1) % idx.length]
      if (Math.abs(area2(a, b, c)) <= EPS) {
        idx.splice(i, 1)
        clipped = true
        break
      }
    }
    if (!clipped) break // degenerate leftovers; bail rather than loop forever
  }
  if (idx.length === 3 && Math.abs(area2(idx[0], idx[1], idx[2])) > EPS) {
    tris.push([idx[0], idx[1], idx[2]])
  }
  return tris
}

// ── Compile: spec → fold model ────────────────────────────────────────────────

export function compilePattern(spec: PatternSpec): CompiledPattern {
  const s = spec.size
  const snapEps = Math.max(1e-6, s * 1e-4)
  const border: Seg[] = [
    { a: [-s, -s], b: [s, -s], group: null, angle: 0 },
    { a: [s, -s], b: [s, s], group: null, angle: 0 },
    { a: [s, s], b: [-s, s], group: null, angle: 0 },
    { a: [-s, s], b: [-s, -s], group: null, angle: 0 },
  ]
  const creaseSegs: Seg[] = []
  for (const c of spec.creases) {
    const clipped = clipToSquare([c.x1, c.y1], [c.x2, c.y2], s)
    if (!clipped) continue
    if (len2(sub2(clipped[1], clipped[0])) < snapEps * 4) continue
    creaseSegs.push({ a: clipped[0], b: clipped[1], group: c.group, angle: c.angle })
  }

  const g = planarize([...border, ...creaseSegs], snapEps)
  const loops = extractFaces(g)
  const faces: [number, number, number][] = []
  for (const loop of loops) faces.push(...triangulate(loop, g.vertices))

  // Classify a triangle edge: crease (group/angle), border, or facet. Exact
  // vertex-pair lookup against the SURVIVING planar edges first (so creases
  // dropped as dangling don't ghost-classify a facet diagonal that happens to
  // lie along them); midpoint fallback for edges whose collinear mid-vertex
  // was dropped during ear clipping.
  const survivors = [...g.edges.values()].filter((e) => e.group !== null)
  const classify = (i: number, j: number): Seg | null => {
    const key = i < j ? `${i},${j}` : `${j},${i}`
    const hit = g.edges.get(key)
    if (hit) {
      return hit.group !== null
        ? { a: g.vertices[hit.a], b: g.vertices[hit.b], group: hit.group, angle: hit.angle }
        : border[0] // any border seg — only .group === null is read
    }
    const m: Vec2 = [
      (g.vertices[i][0] + g.vertices[j][0]) / 2,
      (g.vertices[i][1] + g.vertices[j][1]) / 2,
    ]
    for (const e of survivors) {
      if (onSegment(m, g.vertices[e.a], g.vertices[e.b], snapEps)) {
        return { a: g.vertices[e.a], b: g.vertices[e.b], group: e.group, angle: e.angle }
      }
    }
    for (const seg of border) if (onSegment(m, seg.a, seg.b, snapEps)) return seg
    return null
  }

  // Adjacency: directed edge a→b → its triangle's third vertex.
  const third = new Map<string, number>()
  for (const [a, b, c] of faces) {
    third.set(`${a},${b}`, c)
    third.set(`${b},${c}`, a)
    third.set(`${c},${a}`, b)
  }

  const hinges: Hinge[] = []
  const lineSet = new Map<string, [number, number]>()
  const groups: string[] = []
  const seen = new Set<string>()
  for (const [a, b, c] of faces) {
    for (const [i, j] of [[a, b], [b, c], [c, a]] as [number, number][]) {
      const key = i < j ? `${i},${j}` : `${j},${i}`
      if (seen.has(key)) continue
      seen.add(key)
      const wA = third.get(`${i},${j}`)
      const wB = third.get(`${j},${i}`)
      const seg = classify(i, j)
      const isBorder = seg !== null && seg.group === null
      const isCrease = seg !== null && seg.group !== null
      if (isBorder || isCrease) lineSet.set(key, [i, j])
      if (wA === undefined || wB === undefined) continue // border: one face only
      hinges.push({
        e: [i, j],
        w: [wA, wB],
        group: isCrease ? seg.group : null,
        target: isCrease ? (seg.angle * Math.PI) / 180 : 0,
      })
      if (isCrease && !groups.includes(seg.group!)) groups.push(seg.group!)
    }
  }

  return {
    size: s,
    vertices: g.vertices,
    faces,
    hinges,
    lines: [...lineSet.values()],
    groups,
  }
}

// ── Fold solver ───────────────────────────────────────────────────────────────

export interface FoldSolver {
  // xyz-interleaved vertex positions — read after step(), write to a geometry.
  readonly positions: Float32Array
  readonly pattern: CompiledPattern
  // Advance the paper toward per-group fold fractions (0..1; values outside
  // that range over/under-fold). `substeps` trades accuracy for time.
  step(fracs: Record<string, number>, substeps?: number): void
  // Back to the flat sheet, at rest.
  reset(): void
}

interface AxialEdge {
  a: number
  b: number
  rest: number
  k: number
}

// Signed dihedral angle at a hinge: 0 when flat, positive when the wings fold
// toward +z of face A's normal (a valley seen from the front). `out` receives
// the angle gradient w.r.t. the four stencil vertices when provided.
export function hingeAngle(
  p: Float32Array,
  h: Hinge,
  grad?: { e0: number[]; e1: number[]; w0: number[]; w1: number[] },
): number {
  const [i0, i1] = h.e
  const [i2, i3] = h.w
  const ax = p[i0 * 3]
  const ay = p[i0 * 3 + 1]
  const az = p[i0 * 3 + 2]
  const bx = p[i1 * 3]
  const by = p[i1 * 3 + 1]
  const bz = p[i1 * 3 + 2]
  const cx = p[i2 * 3]
  const cy = p[i2 * 3 + 1]
  const cz = p[i2 * 3 + 2]
  const dx = p[i3 * 3]
  const dy = p[i3 * 3 + 1]
  const dz = p[i3 * 3 + 2]

  // Edge vector and the two (unnormalized) face normals.
  const ex = bx - ax
  const ey = by - ay
  const ez = bz - az
  // nA = e × (c − a)  (face A = a, b, c CCW)
  const cax = cx - ax
  const cay = cy - ay
  const caz = cz - az
  const nAx = ey * caz - ez * cay
  const nAy = ez * cax - ex * caz
  const nAz = ex * cay - ey * cax
  // nB = (d − a) × e  (face B = b, a, d CCW)
  const dax = dx - ax
  const day = dy - ay
  const daz = dz - az
  const nBx = day * ez - daz * ey
  const nBy = daz * ex - dax * ez
  const nBz = dax * ey - day * ex

  const eLen = Math.hypot(ex, ey, ez)
  const nA2 = nAx * nAx + nAy * nAy + nAz * nAz
  const nB2 = nBx * nBx + nBy * nBy + nBz * nBz
  if (eLen < 1e-12 || nA2 < 1e-18 || nB2 < 1e-18) {
    if (grad) {
      grad.e0[0] = grad.e0[1] = grad.e0[2] = 0
      grad.e1[0] = grad.e1[1] = grad.e1[2] = 0
      grad.w0[0] = grad.w0[1] = grad.w0[2] = 0
      grad.w1[0] = grad.w1[1] = grad.w1[2] = 0
    }
    return 0
  }

  // θ = atan2((nB × nA) · ê, nA · nB); positive = the wings folding toward the
  // faces' +normal side (+z on the flat sheet) — a valley seen from the front.
  const crx = nBy * nAz - nBz * nAy
  const cry = nBz * nAx - nBx * nAz
  const crz = nBx * nAy - nBy * nAx
  const sinPart = (crx * ex + cry * ey + crz * ez) / eLen
  const cosPart = nAx * nBx + nAy * nBy + nAz * nBz
  const theta = Math.atan2(sinPart, cosPart)

  if (grad) {
    // Standard hinge-angle gradients (Bridson et al.): wings move along their
    // face normals, edge endpoints take the complementary share.
    const gwA = eLen / nA2
    const gwB = eLen / nB2
    grad.w0[0] = gwA * nAx
    grad.w0[1] = gwA * nAy
    grad.w0[2] = gwA * nAz
    grad.w1[0] = gwB * nBx
    grad.w1[1] = gwB * nBy
    grad.w1[2] = gwB * nBz
    // Projections of the wings onto the edge (as fractions of the edge).
    const e2 = eLen * eLen
    const tA = ((cx - ax) * ex + (cy - ay) * ey + (cz - az) * ez) / e2
    const tB = ((dx - ax) * ex + (dy - ay) * ey + (dz - az) * ez) / e2
    grad.e0[0] = -(1 - tA) * grad.w0[0] - (1 - tB) * grad.w1[0]
    grad.e0[1] = -(1 - tA) * grad.w0[1] - (1 - tB) * grad.w1[1]
    grad.e0[2] = -(1 - tA) * grad.w0[2] - (1 - tB) * grad.w1[2]
    grad.e1[0] = -tA * grad.w0[0] - tB * grad.w1[0]
    grad.e1[1] = -tA * grad.w0[1] - tB * grad.w1[1]
    grad.e1[2] = -tA * grad.w0[2] - tB * grad.w1[2]
  }
  return theta
}

// Solver tuning. Axial springs are much stiffer than fold springs, so panels
// stay near-rigid while creases ease toward their targets; a low facet
// stiffness lets faces bend a little, which classic patterns (the petal fold!)
// genuinely require mid-fold. Damping settles the paper quickly.
export interface SolverOptions {
  axial?: number
  fold?: number
  facet?: number
  damping?: number
}

const MAX_ANGLE = Math.PI * 0.985

export function createFoldSolver(pattern: CompiledPattern, opts: SolverOptions = {}): FoldSolver {
  const AXIAL_EA = opts.axial ?? 24
  const FOLD_K = opts.fold ?? 0.9
  const FACET_K = opts.facet ?? 0.2
  const DAMP = opts.damping ?? 0.975
  const n = pattern.vertices.length
  const positions = new Float32Array(n * 3)
  const velocity = new Float32Array(n * 3)

  const axial: AxialEdge[] = []
  {
    const seen = new Set<string>()
    for (const [a, b, c] of pattern.faces) {
      for (const [i, j] of [[a, b], [b, c], [c, a]] as [number, number][]) {
        const key = i < j ? `${i},${j}` : `${j},${i}`
        if (seen.has(key)) continue
        seen.add(key)
        const dx = pattern.vertices[j][0] - pattern.vertices[i][0]
        const dy = pattern.vertices[j][1] - pattern.vertices[i][1]
        const rest = Math.hypot(dx, dy)
        axial.push({ a: i, b: j, rest, k: AXIAL_EA / Math.max(rest, 0.05) })
      }
    }
  }

  const hingeRest = pattern.hinges.map((h) => {
    const dx = pattern.vertices[h.e[1]][0] - pattern.vertices[h.e[0]][0]
    const dy = pattern.vertices[h.e[1]][1] - pattern.vertices[h.e[0]][1]
    return Math.hypot(dx, dy)
  })

  // Stable timestep from the stiffest axial spring (unit masses).
  let kMax = AXIAL_EA
  for (const e of axial) kMax = Math.max(kMax, e.k)
  const dt = 0.9 / (2 * Math.PI * Math.sqrt(kMax))

  // Unwrapped hinge angles: atan2 wraps at ±π, but paper can legitimately pass
  // through the flat-folded state (no collision handling). Tracking each
  // hinge's angle continuously keeps the spring pushing BACK toward the target
  // instead of chasing it around the circle after a snap-through.
  const thetaPrev = new Float32Array(pattern.hinges.length)

  const force = new Float32Array(n * 3)
  const grad = {
    e0: [0, 0, 0],
    e1: [0, 0, 0],
    w0: [0, 0, 0],
    w1: [0, 0, 0],
  }

  function reset(): void {
    for (let i = 0; i < n; i++) {
      positions[i * 3] = pattern.vertices[i][0]
      positions[i * 3 + 1] = pattern.vertices[i][1]
      positions[i * 3 + 2] = 0
    }
    velocity.fill(0)
    thetaPrev.fill(0)
  }
  reset()

  function substep(targets: number[]): void {
    force.fill(0)

    for (const e of axial) {
      const ax = positions[e.a * 3]
      const ay = positions[e.a * 3 + 1]
      const az = positions[e.a * 3 + 2]
      let dx = positions[e.b * 3] - ax
      let dy = positions[e.b * 3 + 1] - ay
      let dz = positions[e.b * 3 + 2] - az
      const L = Math.hypot(dx, dy, dz)
      if (L < 1e-12) continue
      const f = e.k * (L - e.rest) / L
      dx *= f
      dy *= f
      dz *= f
      force[e.a * 3] += dx
      force[e.a * 3 + 1] += dy
      force[e.a * 3 + 2] += dz
      force[e.b * 3] -= dx
      force[e.b * 3 + 1] -= dy
      force[e.b * 3 + 2] -= dz
    }

    for (let hi = 0; hi < pattern.hinges.length; hi++) {
      const h = pattern.hinges[hi]
      let theta = hingeAngle(positions, h, grad)
      const prev = thetaPrev[hi]
      if (theta - prev > Math.PI) theta -= 2 * Math.PI
      else if (theta - prev < -Math.PI) theta += 2 * Math.PI
      thetaPrev[hi] = theta
      // A crease that isn't being driven is just paper: blend its stiffness
      // from facet-soft up to full fold stiffness as its target angle grows.
      // Matters mid-sequence — an unused crease at full stiffness biases the
      // sheet at the near-singular passages (e.g. through a petal fold).
      const target = targets[hi]
      const drive = h.group === null ? 0 : Math.min(1, Math.abs(target) / 0.1)
      const k = (FACET_K + (FOLD_K - FACET_K) * drive) * hingeRest[hi]
      const f = -k * (theta - targets[hi])
      const [i0, i1] = h.e
      const [i2, i3] = h.w
      force[i0 * 3] += f * grad.e0[0]
      force[i0 * 3 + 1] += f * grad.e0[1]
      force[i0 * 3 + 2] += f * grad.e0[2]
      force[i1 * 3] += f * grad.e1[0]
      force[i1 * 3 + 1] += f * grad.e1[1]
      force[i1 * 3 + 2] += f * grad.e1[2]
      force[i2 * 3] += f * grad.w0[0]
      force[i2 * 3 + 1] += f * grad.w0[1]
      force[i2 * 3 + 2] += f * grad.w0[2]
      force[i3 * 3] += f * grad.w1[0]
      force[i3 * 3 + 1] += f * grad.w1[1]
      force[i3 * 3 + 2] += f * grad.w1[2]
    }

    for (let i = 0; i < n * 3; i++) {
      const v = (velocity[i] + force[i] * dt) * DAMP
      velocity[i] = v
      positions[i] += v * dt
    }
  }

  function step(fracs: Record<string, number>, substeps = 50): void {
    const targets = pattern.hinges.map((h) => {
      if (h.group === null) return 0
      const frac = fracs[h.group] ?? 0
      const t = h.target * frac
      return Math.max(-MAX_ANGLE, Math.min(MAX_ANGLE, t))
    })
    for (let i = 0; i < substeps; i++) substep(targets)
  }

  return { positions, pattern, step, reset }
}

// ── Rigid (kinematic) solver ──────────────────────────────────────────────────
// The clean way to animate a fold sequence: trust the folds as written. Every
// hinge sits at exactly its target angle (crease target × group fraction;
// facet diagonals at 0), and each face is positioned by composing those exact
// rotations along a spanning tree of the face-adjacency graph. Panels stay
// perfectly rigid, undriven creases stay perfectly flat, and there is no
// physics state to tangle.
//
// Because a rotation about a crease commutes through the parent's transform,
// every local rotation is about the crease's ORIGINAL 2D line:
//   T_child = T_parent · RotLine2D(edge, θ)
//
// Where the crease pattern's loops disagree mid-fold, the raw tree solution
// tears at the non-tree edges. A STITCHING pass (shape matching) closes those
// tears so the sheet behaves like uncut paper: iterate a few times between
// averaging every shared vertex across its faces' copies and rigidly
// re-fitting each face to the averaged corners. Faces stay exactly rigid;
// the residual closure error becomes small, evenly-spread offsets between
// neighbouring faces instead of one open gap.

export interface RigidSolver {
  // xyz per face corner (faces × 9): neighbouring faces may sit slightly
  // offset (the stitched remainder of loop error), so positions are per-face.
  readonly positions: Float32Array
  // xyz pairs per pattern line (lines × 6), each drawn with one adjacent
  // face's transform.
  readonly linePositions: Float32Array
  readonly pattern: CompiledPattern
  step(fracs: Record<string, number>, stitchIterations?: number): void
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
  // R = c·I + s·[u]× + t·uuᵀ with u = (ux, uy, 0)
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
  // translation: p − R·p
  out[3] = px - (r00 * px + r01 * py)
  out[7] = py - (r10 * px + r11 * py)
  out[11] = -(r20 * px + r21 * py)
}

interface TreeEdge {
  child: number
  parent: number
  hinge: number
  // The hinge edge endpoints ordered so that, from the PARENT's side, a
  // positive fold angle folds the child toward +z (a valley from the front) —
  // matching the spring solver's convention and the sample's degrees.
  ax: number
  ay: number
  bx: number
  by: number
}

export function createRigidSolver(pattern: CompiledPattern): RigidSolver {
  const nf = pattern.faces.length

  // Face lookup by its three vertices, to resolve each hinge's two faces.
  const faceByKey = new Map<string, number>()
  pattern.faces.forEach((f, i) => {
    faceByKey.set([...f].sort((a, b) => a - b).join(','), i)
  })
  const faceOf = (i: number, j: number, w: number): number =>
    faceByKey.get([i, j, w].sort((a, b) => a - b).join(','))!

  interface Adj { other: number; hinge: number; otherIsB: boolean }
  const adj: Adj[][] = Array.from({ length: nf }, () => [])
  pattern.hinges.forEach((h, hi) => {
    const fa = faceOf(h.e[0], h.e[1], h.w[0])
    const fb = faceOf(h.e[0], h.e[1], h.w[1])
    adj[fa].push({ other: fb, hinge: hi, otherIsB: true })
    adj[fb].push({ other: fa, hinge: hi, otherIsB: false })
  })

  // Root: the face whose centroid is nearest the sheet's centre, so tears
  // spread outward symmetrically.
  let root = 0
  let best = Infinity
  pattern.faces.forEach(([a, b, c], i) => {
    const x = (pattern.vertices[a][0] + pattern.vertices[b][0] + pattern.vertices[c][0]) / 3
    const y = (pattern.vertices[a][1] + pattern.vertices[b][1] + pattern.vertices[c][1]) / 3
    const dd = x * x + y * y
    if (dd < best) {
      best = dd
      root = i
    }
  })

  // BFS spanning tree.
  const tree: TreeEdge[] = []
  const seen = new Array<boolean>(nf).fill(false)
  seen[root] = true
  const queue = [root]
  while (queue.length) {
    const p = queue.shift()!
    for (const { other, hinge, otherIsB } of adj[p]) {
      if (seen[other]) continue
      seen[other] = true
      const h = pattern.hinges[hinge]
      // h.e is directed as it appears (CCW) in face A, so A lies LEFT of
      // e0→e1 and B lies right. A positive fold angle must move the child
      // toward +z (valley from the front, matching hingeAngle and the
      // sample's degrees): rotating about e1→e0 lifts the right side, about
      // e0→e1 the left.
      const [i, j] = otherIsB ? [h.e[1], h.e[0]] : [h.e[0], h.e[1]]
      tree.push({
        child: other, parent: p, hinge,
        ax: pattern.vertices[i][0], ay: pattern.vertices[i][1],
        bx: pattern.vertices[j][0], by: pattern.vertices[j][1],
      })
      queue.push(other)
    }
  }

  // One adjacent face per drawn line (for its transform).
  const lineFace = pattern.lines.map(([i, j]) => {
    for (let f = 0; f < nf; f++) {
      const tri = pattern.faces[f]
      if (tri.includes(i) && tri.includes(j)) return f
    }
    return 0
  })

  const positions = new Float32Array(nf * 9)
  const linePositions = new Float32Array(pattern.lines.length * 6)
  const transforms: Affine[] = Array.from({ length: nf }, () => new Float64Array(IDENTITY))
  const local: Affine = new Float64Array(12)

  const apply = (t: Affine, x: number, y: number, out: Float32Array, o: number): void => {
    out[o] = t[0] * x + t[1] * y + t[3]
    out[o + 1] = t[4] * x + t[5] * y + t[7]
    out[o + 2] = t[8] * x + t[9] * y + t[11]
  }

  // ── Stitching (shape matching) ──
  // Every pattern vertex lists its (face × 3 + corner) copies; each stitch
  // iteration averages the copies, then rigidly re-fits every face to its
  // averaged corners via matched orthonormal frames (rest frame is planar, so
  // the fit is a closed-form Procrustes on a triangle).
  const nv = pattern.vertices.length
  const copies: number[][] = Array.from({ length: nv }, () => [])
  pattern.faces.forEach((tri, f) => tri.forEach((v, k) => copies[v].push(f * 3 + k)))
  const avg = new Float64Array(nv * 3)
  const work = new Float64Array(nf * 9) // double-precision face corners

  // Rest per-face data: corners, centroid, and orthonormal in-plane frame
  // (u1, u2) with u3 = +z implied (faces are CCW).
  const restU = new Float64Array(nf * 4) // u1x u1y u2x u2y
  const restC = new Float64Array(nf * 2)
  for (let f = 0; f < nf; f++) {
    const [a, b, c] = pattern.faces[f]
    const ax = pattern.vertices[a][0]
    const ay = pattern.vertices[a][1]
    const bx = pattern.vertices[b][0]
    const by = pattern.vertices[b][1]
    const cx = pattern.vertices[c][0]
    const cy = pattern.vertices[c][1]
    let u1x = bx - ax
    let u1y = by - ay
    const L = Math.hypot(u1x, u1y)
    u1x /= L
    u1y /= L
    let u2x = cx - ax
    let u2y = cy - ay
    const dot = u2x * u1x + u2y * u1y
    u2x -= dot * u1x
    u2y -= dot * u1y
    const L2 = Math.hypot(u2x, u2y)
    u2x /= L2
    u2y /= L2
    restU[f * 4] = u1x
    restU[f * 4 + 1] = u1y
    restU[f * 4 + 2] = u2x
    restU[f * 4 + 3] = u2y
    restC[f * 2] = (ax + bx + cx) / 3
    restC[f * 2 + 1] = (ay + by + cy) / 3
  }

  // Refit face f's transform so its rest triangle lands on the corners
  // currently in `work` — exactly rigid by construction. Returns false when
  // the target corners are too degenerate to define a frame.
  const refit = (f: number): boolean => {
    const o = f * 9
    const q1x = work[o]
    const q1y = work[o + 1]
    const q1z = work[o + 2]
    let v1x = work[o + 3] - q1x
    let v1y = work[o + 4] - q1y
    let v1z = work[o + 5] - q1z
    const L1 = Math.hypot(v1x, v1y, v1z)
    if (L1 < 1e-12) return false
    v1x /= L1
    v1y /= L1
    v1z /= L1
    let v2x = work[o + 6] - q1x
    let v2y = work[o + 7] - q1y
    let v2z = work[o + 8] - q1z
    const dot = v2x * v1x + v2y * v1y + v2z * v1z
    v2x -= dot * v1x
    v2y -= dot * v1y
    v2z -= dot * v1z
    const L2 = Math.hypot(v2x, v2y, v2z)
    if (L2 < 1e-12) return false
    v2x /= L2
    v2y /= L2
    v2z /= L2
    const v3x = v1y * v2z - v1z * v2y
    const v3y = v1z * v2x - v1x * v2z
    const v3z = v1x * v2y - v1y * v2x
    // R = V · Eᵀ where E's columns are (u1, u2, +z). Only R's first two
    // columns matter to `apply` (rest z = 0), but the third feeds nothing.
    const u1x = restU[f * 4]
    const u1y = restU[f * 4 + 1]
    const u2x = restU[f * 4 + 2]
    const u2y = restU[f * 4 + 3]
    const t = transforms[f]
    t[0] = v1x * u1x + v2x * u2x
    t[1] = v1x * u1y + v2x * u2y
    t[2] = v3x
    t[4] = v1y * u1x + v2y * u2x
    t[5] = v1y * u1y + v2y * u2y
    t[6] = v3y
    t[8] = v1z * u1x + v2z * u2x
    t[9] = v1z * u1y + v2z * u2y
    t[10] = v3z
    // translation from centroids: t = q̄ − R·p̄
    const qcx = (work[o] + work[o + 3] + work[o + 6]) / 3
    const qcy = (work[o + 1] + work[o + 4] + work[o + 7]) / 3
    const qcz = (work[o + 2] + work[o + 5] + work[o + 8]) / 3
    const pcx = restC[f * 2]
    const pcy = restC[f * 2 + 1]
    t[3] = qcx - (t[0] * pcx + t[1] * pcy)
    t[7] = qcy - (t[4] * pcx + t[5] * pcy)
    t[11] = qcz - (t[8] * pcx + t[9] * pcy)
    return true
  }

  const writeFace = (f: number): void => {
    const [a, b, c] = pattern.faces[f]
    const t = transforms[f]
    for (let k = 0; k < 3; k++) {
      const [x, y] = pattern.vertices[k === 0 ? a : k === 1 ? b : c]
      const o = f * 9 + k * 3
      work[o] = t[0] * x + t[1] * y + t[3]
      work[o + 1] = t[4] * x + t[5] * y + t[7]
      work[o + 2] = t[8] * x + t[9] * y + t[11]
    }
  }

  function step(fracs: Record<string, number>, stitchIterations = 40): void {
    transforms[root].set(IDENTITY)
    for (const te of tree) {
      const h = pattern.hinges[te.hinge]
      const theta = h.group === null ? 0 : h.target * (fracs[h.group] ?? 0)
      if (theta === 0) {
        transforms[te.child].set(transforms[te.parent])
      } else {
        rotAboutLine2D(te.ax, te.ay, te.bx, te.by, theta, local)
        mulAffine(transforms[te.parent], local, transforms[te.child])
      }
    }
    for (let f = 0; f < nf; f++) writeFace(f)

    // Stitch: pull every shared vertex's copies together, keeping each face
    // exactly rigid. Converges fast because the tree solution is already
    // right everywhere except across the non-tree hinges.
    const eps2 = 1e-14 * pattern.size * pattern.size
    for (let it = 0; it < stitchIterations; it++) {
      let spread = 0
      for (let v = 0; v < nv; v++) {
        const list = copies[v]
        let sx = 0
        let sy = 0
        let sz = 0
        for (const c of list) {
          sx += work[c * 3]
          sy += work[c * 3 + 1]
          sz += work[c * 3 + 2]
        }
        const inv = 1 / list.length
        sx *= inv
        sy *= inv
        sz *= inv
        avg[v * 3] = sx
        avg[v * 3 + 1] = sy
        avg[v * 3 + 2] = sz
        for (const c of list) {
          const dx = work[c * 3] - sx
          const dy = work[c * 3 + 1] - sy
          const dz = work[c * 3 + 2] - sz
          const d2 = dx * dx + dy * dy + dz * dz
          if (d2 > spread) spread = d2
        }
      }
      if (spread < eps2) break
      for (let f = 0; f < nf; f++) {
        const [a, b, c] = pattern.faces[f]
        const o = f * 9
        work[o] = avg[a * 3]
        work[o + 1] = avg[a * 3 + 1]
        work[o + 2] = avg[a * 3 + 2]
        work[o + 3] = avg[b * 3]
        work[o + 4] = avg[b * 3 + 1]
        work[o + 5] = avg[b * 3 + 2]
        work[o + 6] = avg[c * 3]
        work[o + 7] = avg[c * 3 + 1]
        work[o + 8] = avg[c * 3 + 2]
        if (refit(f)) writeFace(f)
      }
    }

    positions.set(work)
    pattern.lines.forEach(([i, j], li) => {
      const t = transforms[lineFace[li]]
      apply(t, pattern.vertices[i][0], pattern.vertices[i][1], linePositions, li * 6)
      apply(t, pattern.vertices[j][0], pattern.vertices[j][1], linePositions, li * 6 + 3)
    })
  }

  step({})
  return { positions, linePositions, pattern, step }
}

// ── Presets ───────────────────────────────────────────────────────────────────
// The traditional crane isn't a built-in preset here — it's the "Origami
// Crane" sample program (src/samples.ts), which builds its crease pattern as
// a literal array of objects passed to origami().creases([...]), so the whole
// thing is visible and live-editable rather than hidden behind a function
// call. This module only ships the generic engine plus small parametric
// presets like the fan below.

// An accordion fan: `pleats` alternating full-width folds. One group per
// pleat ("fan0", "fan1", …) so a schedule can ripple them in sequence, or pass
// { group } to gang them into a single fold.
export function fanPattern(pleats = 7, opts: { group?: string; angle?: number } = {}): PatternSpec {
  const creases: CreaseSpec[] = []
  const angle = opts.angle ?? 165
  for (let i = 1; i <= pleats; i++) {
    const x = -1 + (2 * i) / (pleats + 1)
    creases.push({
      x1: x,
      y1: -1,
      x2: x,
      y2: 1,
      group: opts.group ?? `fan${i - 1}`,
      angle: i % 2 ? angle : -angle,
    })
  }
  return { size: 1, creases }
}
