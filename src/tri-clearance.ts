// Triangle clearance primitives, shared by the engine's compile-time
// motion probe and the paper-clearance tests: does a baked animation drive
// paper through paper, and how deeply?
export type V3 = [number, number, number]

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const norm = (a: V3): number => Math.hypot(a[0], a[1], a[2])

const PLANE_EPS = 1e-9

// length of the proper intersection segment of two triangles (0 when they
// miss, touch, or are coplanar)
export const triCrossLength = (t1: [V3, V3, V3], t2: [V3, V3, V3]): number => {
  const n2 = cross(sub(t2[1], t2[0]), sub(t2[2], t2[0]))
  const d2 = dot(n2, t2[0])
  const dv1 = t1.map((p) => dot(n2, p) - d2)
  const s2 = norm(n2)
  if (s2 < 1e-15) return 0
  const flat1 = dv1.map((d) => Math.abs(d / s2) < PLANE_EPS)
  if (flat1.every(Boolean)) return 0 // coplanar
  const side1 = dv1.map((d, i) => (flat1[i] ? 0 : Math.sign(d)))
  if (!side1.includes(1) || !side1.includes(-1)) return 0

  const n1 = cross(sub(t1[1], t1[0]), sub(t1[2], t1[0]))
  const d1 = dot(n1, t1[0])
  const dv2 = t2.map((p) => dot(n1, p) - d1)
  const s1 = norm(n1)
  if (s1 < 1e-15) return 0
  const flat2 = dv2.map((d) => Math.abs(d / s1) < PLANE_EPS)
  const side2 = dv2.map((d, i) => (flat2[i] ? 0 : Math.sign(d)))
  if (!side2.includes(1) || !side2.includes(-1)) return 0

  // both triangles straddle the other's plane: intersect along L = p + t·D
  const D = cross(n1, n2)
  const axis = [0, 1, 2].reduce((m, i) => (Math.abs(D[i]) > Math.abs(D[m]) ? i : m), 0)
  const interval = (t: [V3, V3, V3], dv: number[]): [number, number] | undefined => {
    const ts: number[] = []
    for (let i = 0; i < 3; ++i) {
      const j = (i + 1) % 3
      if (dv[i] === 0 && dv[j] === 0) continue
      if (dv[i] * dv[j] < 0 || (dv[i] === 0) !== (dv[j] === 0)) {
        const f = dv[i] / (dv[i] - dv[j])
        ts.push(t[i][axis] + f * (t[j][axis] - t[i][axis]))
      }
    }
    if (ts.length < 2) return undefined
    return [Math.min(...ts), Math.max(...ts)]
  }
  const i1 = interval(t1, dv1)
  const i2 = interval(t2, dv2)
  if (!i1 || !i2) return 0
  const lo = Math.max(i1[0], i2[0])
  const hi = Math.min(i1[1], i2[1])
  if (hi <= lo) return 0
  return (hi - lo) * (norm(D) / Math.abs(D[axis]))
}

// how deeply two triangles interpenetrate: the smaller of the two maximum
// extents past each other's planes (0 unless they properly cross)
export const triCrossDepth = (t1: [V3, V3, V3], t2: [V3, V3, V3]): number => {
  const n2 = cross(sub(t2[1], t2[0]), sub(t2[2], t2[0]))
  const s2 = norm(n2)
  if (s2 < 1e-15) return 0
  const d2 = dot(n2, t2[0]) / s2
  const dv1 = t1.map((p) => dot(n2, p) / s2 - d2)
  if (Math.min(...dv1) > -PLANE_EPS || Math.max(...dv1) < PLANE_EPS) return 0
  const n1 = cross(sub(t1[1], t1[0]), sub(t1[2], t1[0]))
  const s1 = norm(n1)
  if (s1 < 1e-15) return 0
  const d1 = dot(n1, t1[0]) / s1
  const dv2 = t2.map((p) => dot(n1, p) / s1 - d1)
  if (Math.min(...dv2) > -PLANE_EPS || Math.max(...dv2) < PLANE_EPS) return 0
  if (triCrossLength(t1, t2) < 1e-9) return 0
  const e1 = Math.min(-Math.min(...dv1), Math.max(...dv1))
  const e2 = Math.min(-Math.min(...dv2), Math.max(...dv2))
  return Math.min(e1, e2)
}

// approximate in-plane overlap of two near-coplanar triangles closer than
// `gapMin` apart: fraction of sample points of t1 inside t2's prism within
// gapMin, times t1's area
export const triShearArea = (t1: [V3, V3, V3], t2: [V3, V3, V3], gapMin: number): number => {
  const n2 = cross(sub(t2[1], t2[0]), sub(t2[2], t2[0]))
  const s2 = norm(n2)
  if (s2 < 1e-15) return 0
  const n2u: V3 = [n2[0] / s2, n2[1] / s2, n2[2] / s2]
  const d2 = dot(n2u, t2[0])
  const e0 = sub(t2[1], t2[0])
  const e1 = sub(t2[2], t2[0])
  const d00 = dot(e0, e0)
  const d01 = dot(e0, e1)
  const d11 = dot(e1, e1)
  const den = d00 * d11 - d01 * d01
  if (Math.abs(den) < 1e-18) return 0
  const inside = (p: V3): boolean => {
    const h = dot(n2u, p) - d2
    if (Math.abs(h) > gapMin) return false
    const q: V3 = [p[0] - h * n2u[0] - t2[0][0], p[1] - h * n2u[1] - t2[0][1], p[2] - h * n2u[2] - t2[0][2]]
    const d20 = dot(q, e0)
    const d21 = dot(q, e1)
    const v = (d11 * d20 - d01 * d21) / den
    const w = (d00 * d21 - d01 * d20) / den
    return v >= -1e-9 && w >= -1e-9 && v + w <= 1 + 1e-9
  }
  let hit = 0
  const S = 6
  let total = 0
  for (let i = 1; i < S; ++i) {
    for (let j = 1; j < S - i; ++j) {
      const a = i / S
      const b = j / S
      const p: V3 = [
        t1[0][0] * (1 - a - b) + t1[1][0] * a + t1[2][0] * b,
        t1[0][1] * (1 - a - b) + t1[1][1] * a + t1[2][1] * b,
        t1[0][2] * (1 - a - b) + t1[1][2] * a + t1[2][2] * b,
      ]
      total++
      if (inside(p)) hit++
    }
  }
  if (hit === 0) return 0
  const area1 = norm(cross(sub(t1[1], t1[0]), sub(t1[2], t1[0]))) / 2
  return (hit / total) * area1
}

// worst interpenetration depth across baked frames, faces at zero display
// thickness — the engine's routing gate. Face pairs sharing a vertex are
// joined at a crease and skipped.
export const bakedMotionDepth = (
  FV: number[][], frames: { pos: (vi: number) => V3 }[],
): number => {
  const nF = FV.length
  const shares: boolean[][] = Array.from({ length: nF }, () => Array(nF).fill(false))
  for (let a = 0; a < nF; ++a) {
    const set = new Set(FV[a])
    for (let b = a + 1; b < nF; ++b) shares[a][b] = FV[b].some((v) => set.has(v))
  }
  let depth = 0
  for (const frame of frames) {
    const tris: [V3, V3, V3][][] = []
    const bboxes: [V3, V3][] = []
    for (const F of FV) {
      const own: [V3, V3, V3][] = []
      const lo: V3 = [Infinity, Infinity, Infinity]
      const hi: V3 = [-Infinity, -Infinity, -Infinity]
      for (let j = 1; j + 1 < F.length; ++j) own.push([frame.pos(F[0]), frame.pos(F[j]), frame.pos(F[j + 1])])
      for (const vi of F) {
        const p = frame.pos(vi)
        for (let c = 0; c < 3; ++c) { lo[c] = Math.min(lo[c], p[c]); hi[c] = Math.max(hi[c], p[c]) }
      }
      tris.push(own)
      bboxes.push([lo, hi])
    }
    for (let a = 0; a < nF; ++a) {
      for (let b = a + 1; b < nF; ++b) {
        if (shares[a][b]) continue
        const [alo, ahi] = bboxes[a]
        const [blo, bhi] = bboxes[b]
        if (alo[0] > bhi[0] || blo[0] > ahi[0] ||
            alo[1] > bhi[1] || blo[1] > ahi[1] ||
            alo[2] > bhi[2] || blo[2] > ahi[2]) continue
        for (const t1 of tris[a]) {
          for (const t2 of tris[b]) depth = Math.max(depth, triCrossDepth(t1, t2))
        }
      }
    }
  }
  return depth
}
