import * as THREE from 'three'
import { foldTablePositions, type FoldTableProgram } from './fold-engine.js'
import { SHAPE_DEFAULTS } from './shapes.js'

export interface SceneAPI {
  createObject(row: Record<string, unknown>): void
  updateObject(row: Record<string, unknown>): void
  destroyObject(id: unknown): void
  reset(): void
  // The scene camera, exposed for tooling (screenshot harnesses, debug
  // orbits). The app itself never moves it.
  readonly camera: THREE.PerspectiveCamera
}

export interface GeometryDims { hx: number; hy: number; hz: number; r: number; h: number }

// The subset of a row's fields that determine geometry size, merged with the
// shape's defaults — used both to build the geometry and, on later frames, to
// detect a size change that means the geometry must be rebuilt.
export function geometryDims(shape: string, dims: Record<string, unknown>): GeometryDims {
  const d = { ...(SHAPE_DEFAULTS[shape] ?? SHAPE_DEFAULTS.box), ...dims }
  return { hx: d.hx as number, hy: d.hy as number, hz: d.hz as number, r: d.r as number, h: d.h as number }
}

function sameDims(a: GeometryDims, b: GeometryDims): boolean {
  return a.hx === b.hx && a.hy === b.hy && a.hz === b.hz && a.r === b.r && a.h === b.h
}

// Whether an update row's shape/size has drifted from what a mesh was last
// built with — a re-run that resizes or reshapes an existing object (a
// house-of-cards card's thickness, a shape swapped sphere<->box) needs its
// THREE.js geometry disposed and rebuilt, not just repositioned.
export function geometryChanged(prevShape: string, prevDims: GeometryDims, row: Record<string, unknown>): boolean {
  const shape = (row.shape as string | undefined) ?? prevShape
  return shape !== prevShape || !sameDims(geometryDims(shape, row), prevDims)
}

function makeGeometry(shape: string, dims: Record<string, unknown>): THREE.BufferGeometry {
  const { hx, hy, hz, r, h } = geometryDims(shape, dims)
  switch (shape) {
    case 'sphere':   return new THREE.SphereGeometry(r, 32, 32)
    case 'cylinder': return new THREE.CylinderGeometry(r, r, h * 2, 32)
    case 'cone':     return new THREE.ConeGeometry(r, h * 2, 32)
    case 'torus':    return new THREE.TorusGeometry(r, 0.08, 16, 64)
    case 'box':
    default:         return new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2)
  }
}

const PALETTE = [0x4a9eff, 0xff6b6b, 0x51cf66, 0xffd43b, 0xcc5de8, 0xff922b]

// A live sheet of folding paper: the compiled fold-table program holds, for
// every step, the face set, pre-swing coordinates, fold line, moving flags
// and layer indices. One numeric field drives playback: `fold` = how many
// folds have landed, fractional = the next flap mid-swing about its fold
// line (a rigid compound hinge — shared vertices, no tearing). Faces render
// as a per-face triangle soup so each face can be nudged along z by its
// layer index; edges render as line segments from the same positions.
interface OrigamiObject {
  root: THREE.Group
  program: FoldTableProgram
  fold: number
  shown: number
  posAttr: THREE.BufferAttribute
  linePosAttr: THREE.BufferAttribute
  front: THREE.MeshStandardMaterial
  back: THREE.MeshStandardMaterial
  line: THREE.LineBasicMaterial
  geometry: THREE.BufferGeometry
  lineGeometry: THREE.BufferGeometry
}

const PAPER_BACK = 0xf4efe2

function fillOrigami(obj: OrigamiObject): void {
  const { program } = obj
  const { FV, pos, zOff, zDir } = foldTablePositions(program, obj.fold)
  // layer offsets ride the paper: along the face's carried direction when
  // the motion provides one, else world z (the flat-state stacking axis)
  const offX = (fi: number): number => (zDir ? zDir[fi][0] * zOff[fi] : 0)
  const offY = (fi: number): number => (zDir ? zDir[fi][1] * zOff[fi] : 0)
  const offZ = (fi: number): number => (zDir ? zDir[fi][2] * zOff[fi] : zOff[fi])
  const P = obj.posAttr.array as Float32Array
  let n = 0
  for (let fi = 0; fi < FV.length; ++fi) {
    const F = FV[fi]
    const ox = offX(fi), oy = offY(fi), oz = offZ(fi)
    for (let j = 1; j + 1 < F.length; ++j) {
      for (const vi of [F[0], F[j], F[j + 1]]) {
        const v = pos[vi]
        P[n++] = v[0] + ox; P[n++] = v[1] + oy; P[n++] = v[2] + oz
      }
    }
  }
  obj.geometry.setDrawRange(0, n / 3)
  obj.posAttr.needsUpdate = true
  const L = obj.linePosAttr.array as Float32Array
  let m = 0
  const seen = new Set<string>()
  for (let fi = 0; fi < FV.length; ++fi) {
    const F = FV[fi]
    const ox = offX(fi), oy = offY(fi), oz = offZ(fi)
    let i = F.length - 1
    for (let j = 0; j < F.length; ++j) {
      const a = F[i], b = F[j]
      i = j
      const key = a < b ? `${a},${b}` : `${b},${a}`
      if (seen.has(key)) continue
      seen.add(key)
      L[m++] = pos[a][0] + ox; L[m++] = pos[a][1] + oy; L[m++] = pos[a][2] + oz
      L[m++] = pos[b][0] + ox; L[m++] = pos[b][1] + oy; L[m++] = pos[b][2] + oz
    }
  }
  obj.lineGeometry.setDrawRange(0, m / 3)
  obj.linePosAttr.needsUpdate = true
  obj.shown = obj.fold
}

function makeOrigami(row: Record<string, unknown>): OrigamiObject {
  const program = row.program as FoldTableProgram
  let maxTris = Math.max(1, program.initial.FV.reduce((s, F) => s + F.length - 2, 0))
  let maxEdges = Math.max(1, program.initial.FV.reduce((s, F) => s + F.length, 0))
  for (const step of program.steps) {
    maxTris = Math.max(maxTris, step.FV.reduce((s, F) => s + F.length - 2, 0))
    maxEdges = Math.max(maxEdges, step.FV.reduce((s, F) => s + F.length, 0))
  }

  const posAttr = new THREE.BufferAttribute(new Float32Array(maxTris * 9), 3)
  posAttr.setUsage(THREE.DynamicDrawUsage)
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', posAttr)

  const color = row.color != null ? (row.color as number) : 0xd94f2a
  const backColor = row.backColor != null ? (row.backColor as number) : PAPER_BACK
  // Two single-sided materials so the paper's front and back read differently
  // (classic origami: colored face, white back — set backColor to fold
  // colored-side-down, the way a crane is folded so it ends up colored).
  // flatShading derives face normals in-shader, so no normal attribute
  // needs recomputing per frame.
  const common = {
    metalness: 0.05,
    roughness: 0.85,
    flatShading: true,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  }
  const front = new THREE.MeshStandardMaterial({ ...common, color, side: THREE.FrontSide })
  const back = new THREE.MeshStandardMaterial({ ...common, color: backColor, side: THREE.BackSide })

  const linePosAttr = new THREE.BufferAttribute(new Float32Array(maxEdges * 6), 3)
  linePosAttr.setUsage(THREE.DynamicDrawUsage)
  const lineGeometry = new THREE.BufferGeometry()
  lineGeometry.setAttribute('position', linePosAttr)
  const line = new THREE.LineBasicMaterial({ color: 0x1c1713, transparent: true, opacity: 0.5 })

  const root = new THREE.Group()
  root.add(new THREE.Mesh(geometry, front))
  root.add(new THREE.Mesh(geometry, back))
  root.add(new THREE.LineSegments(lineGeometry, line))

  const obj: OrigamiObject = {
    root, program, fold: 0, shown: -1,
    posAttr, linePosAttr, front, back, line, geometry, lineGeometry,
  }
  applyOrigamiRow(obj, row)
  fillOrigami(obj)
  return obj
}

function applyOrigamiRow(obj: OrigamiObject, row: Record<string, unknown>): void {
  const { px, py, pz, rx, ry, rz, color } = row
  obj.root.position.set((px as number) ?? 0, (py as number) ?? 0, (pz as number) ?? 0)
  obj.root.rotation.set((rx as number) ?? 0, (ry as number) ?? 0, (rz as number) ?? 0)
  if (color != null) obj.front.color.set(color as number)
  if (typeof row.fold === 'number') obj.fold = row.fold
}

function disposeOrigami(obj: OrigamiObject): void {
  obj.geometry.dispose()
  obj.lineGeometry.dispose()
  obj.front.dispose()
  obj.back.dispose()
  obj.line.dispose()
}

// The Three.js scene renders to its own canvas, which is *not* shown directly —
// hydra (see hydra-scene.ts) takes it as a source texture and post-processes it
// onto the visible canvas. So this module is pure scene + render, no effects.
export function initThree(canvas: HTMLCanvasElement, sizeFrom: HTMLElement): SceneAPI {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  renderer.setPixelRatio(window.devicePixelRatio)

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x000000)

  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100)
  camera.position.set(0, 0, 5)

  const dirLight = new THREE.DirectionalLight(0xe94560, 2)
  dirLight.position.set(2, 3, 4)
  scene.add(dirLight)
  scene.add(new THREE.AmbientLight(0x4466aa, 2))

  function resize(): void {
    const { clientWidth: w, clientHeight: h } = sizeFrom
    if (!w || !h) return
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }

  resize()
  new ResizeObserver(resize).observe(sizeFrom)

  const objects = new Map<unknown, THREE.Mesh>()
  const origamis = new Map<unknown, OrigamiObject>()
  let colorIdx = 0

  function animate(): void {
    for (const o of origamis.values()) {
      if (o.shown !== o.fold) fillOrigami(o)
    }
    renderer.render(scene, camera)
    requestAnimationFrame(animate)
  }
  requestAnimationFrame(animate)

  return {
    camera,
    createObject(row: Record<string, unknown>): void {
      const { id, shape, px, py, pz, rx, ry, rz, color } = row
      if (objects.has(id) || origamis.has(id)) return
      if (shape === 'origami' && row.program) {
        const obj = makeOrigami(row)
        scene.add(obj.root)
        origamis.set(id, obj)
        return
      }
      const geo = makeGeometry(shape as string, row)
      const mat = new THREE.MeshStandardMaterial({
        color: color != null ? color as number : PALETTE[colorIdx % PALETTE.length],
        metalness: 0.35,
        roughness: 0.4,
      })
      colorIdx++
      const mesh = new THREE.Mesh(geo, mat)
      mesh.name = String(id)
      mesh.position.set(px as number, py as number, pz as number)
      mesh.rotation.set(rx as number ?? 0, ry as number ?? 0, rz as number ?? 0)
      mesh.userData.shape = shape
      mesh.userData.dims = geometryDims(shape as string, row)
      scene.add(mesh)
      objects.set(id, mesh)
    },

    updateObject(row: Record<string, unknown>): void {
      const { id, px, py, pz, rx, ry, rz, color } = row
      const origami = origamis.get(id)
      if (origami) {
        applyOrigamiRow(origami, row)
        return
      }
      const mesh = objects.get(id)
      if (!mesh) return
      mesh.position.set(px as number, py as number, pz as number)
      mesh.rotation.set(rx as number ?? 0, ry as number ?? 0, rz as number ?? 0)
      if (color != null) (mesh.material as THREE.MeshStandardMaterial).color.set(color as number)
      const prevShape = mesh.userData.shape as string
      if (geometryChanged(prevShape, mesh.userData.dims, row)) {
        const shape = (row.shape as string | undefined) ?? prevShape
        mesh.geometry.dispose()
        mesh.geometry = makeGeometry(shape, row)
        mesh.userData.shape = shape
        mesh.userData.dims = geometryDims(shape, row)
      }
    },

    destroyObject(id: unknown): void {
      const origami = origamis.get(id)
      if (origami) {
        scene.remove(origami.root)
        disposeOrigami(origami)
        origamis.delete(id)
        return
      }
      const mesh = objects.get(id)
      if (!mesh) return
      scene.remove(mesh)
      mesh.geometry.dispose()
      ;(mesh.material as THREE.MeshStandardMaterial).dispose()
      objects.delete(id)
    },

    reset(): void {
      for (const mesh of objects.values()) {
        scene.remove(mesh)
        mesh.geometry.dispose()
        ;(mesh.material as THREE.MeshStandardMaterial).dispose()
      }
      objects.clear()
      for (const origami of origamis.values()) {
        scene.remove(origami.root)
        disposeOrigami(origami)
      }
      origamis.clear()
      colorIdx = 0
    },
  }
}
