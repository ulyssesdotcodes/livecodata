import * as THREE from 'three'
import { createRigidSolver, type CompiledPattern, type RigidSolver } from './origami.js'

export interface SceneAPI {
  createObject(row: Record<string, unknown>): void
  updateObject(row: Record<string, unknown>): void
  destroyObject(id: unknown): void
  reset(): void
}

const SHAPE_DEFAULTS: Record<string, Record<string, number>> = {
  box:      { hx: 0.25, hy: 0.25, hz: 0.25 },
  sphere:   { r: 0.3 },
  cylinder: { r: 0.2, h: 0.3 },
  cone:     { r: 0.3, h: 0.3 },
  torus:    { r: 0.3 },
}

function makeGeometry(shape: string, dims: Record<string, unknown>): THREE.BufferGeometry {
  const d = { ...(SHAPE_DEFAULTS[shape] ?? SHAPE_DEFAULTS.box), ...dims }
  const hx = d.hx as number, hy = d.hy as number, hz = d.hz as number
  const r  = d.r  as number, h  = d.h  as number
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

// A live sheet of folding paper: the solver owns the vertex buffer, the two
// meshes (colored front / paper-white back) and the crease lines all render
// straight out of it. The solver is kinematic: every hinge sits at exactly
// its target angle (crease target × the row's fold fraction), faces are
// positioned by composing those exact rotations, and where the crease
// pattern's loops disagree mid-fold the sheet simply breaks apart — so
// faces can't share vertices, and the geometry is per-face (non-indexed).
interface OrigamiObject {
  root: THREE.Group
  solver: RigidSolver
  posAttr: THREE.BufferAttribute
  linePosAttr: THREE.BufferAttribute
  targets: Record<string, number>
  front: THREE.MeshStandardMaterial
  back: THREE.MeshStandardMaterial
  line: THREE.LineBasicMaterial
  geometry: THREE.BufferGeometry
  lineGeometry: THREE.BufferGeometry
}

const PAPER_BACK = 0xf4efe2

function makeOrigami(row: Record<string, unknown>): OrigamiObject {
  const pattern = row.pattern as CompiledPattern
  const solver = createRigidSolver(pattern)

  const posAttr = new THREE.BufferAttribute(solver.positions, 3)
  posAttr.setUsage(THREE.DynamicDrawUsage)
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', posAttr)

  const color = row.color != null ? (row.color as number) : 0xd94f2a
  // Two single-sided materials so the paper's front and back read differently
  // (classic origami: colored face, white back). flatShading derives face
  // normals in-shader, so no normal attribute needs recomputing per frame.
  const common = {
    metalness: 0.05,
    roughness: 0.85,
    flatShading: true,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  }
  const front = new THREE.MeshStandardMaterial({ ...common, color, side: THREE.FrontSide })
  const back = new THREE.MeshStandardMaterial({ ...common, color: PAPER_BACK, side: THREE.BackSide })

  const linePosAttr = new THREE.BufferAttribute(solver.linePositions, 3)
  linePosAttr.setUsage(THREE.DynamicDrawUsage)
  const lineGeometry = new THREE.BufferGeometry()
  lineGeometry.setAttribute('position', linePosAttr)
  const line = new THREE.LineBasicMaterial({ color: 0x1c1713, transparent: true, opacity: 0.5 })

  const root = new THREE.Group()
  root.add(new THREE.Mesh(geometry, front))
  root.add(new THREE.Mesh(geometry, back))
  root.add(new THREE.LineSegments(lineGeometry, line))

  const targets: Record<string, number> = {}
  for (const g of pattern.groups) targets[g] = 0

  const obj: OrigamiObject = {
    root, solver, posAttr, linePosAttr, targets, front, back, line, geometry, lineGeometry,
  }
  applyOrigamiRow(obj, row)
  return obj
}

function applyOrigamiRow(obj: OrigamiObject, row: Record<string, unknown>): void {
  const { px, py, pz, rx, ry, rz, color } = row
  obj.root.position.set((px as number) ?? 0, (py as number) ?? 0, (pz as number) ?? 0)
  obj.root.rotation.set((rx as number) ?? 0, (ry as number) ?? 0, (rz as number) ?? 0)
  if (color != null) obj.front.color.set(color as number)
  for (const g of Object.keys(obj.targets)) {
    if (typeof row[g] === 'number') obj.targets[g] = row[g] as number
  }
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
      o.solver.step(o.targets)
      o.posAttr.needsUpdate = true
      o.linePosAttr.needsUpdate = true
    }
    renderer.render(scene, camera)
    requestAnimationFrame(animate)
  }
  requestAnimationFrame(animate)

  return {
    createObject(row: Record<string, unknown>): void {
      const { id, shape, px, py, pz, rx, ry, rz, color } = row
      if (objects.has(id) || origamis.has(id)) return
      if (shape === 'origami' && row.pattern) {
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
