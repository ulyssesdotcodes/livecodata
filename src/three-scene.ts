import * as THREE from 'three'

export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface SceneAPI {
  createObject(id: unknown, shape: unknown, position: Vec3, rotation: Vec3, color: number | null, dims: Record<string, unknown>): void
  updateObject(id: unknown, position: Vec3, rotation: Vec3): void
  setColor(id: unknown, color: number | null): void
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

  function animate(): void {
    renderer.render(scene, camera)
    requestAnimationFrame(animate)
  }
  requestAnimationFrame(animate)

  const objects = new Map<unknown, THREE.Mesh>()
  let colorIdx = 0

  return {
    createObject(id: unknown, shape: unknown, position: Vec3, rotation: Vec3, color: number | null, dims: Record<string, unknown>): void {
      if (objects.has(id)) return
      const geo = makeGeometry(shape as string, dims)
      const mat = new THREE.MeshStandardMaterial({
        color: color != null ? color : PALETTE[colorIdx % PALETTE.length],
        metalness: 0.35,
        roughness: 0.4,
      })
      colorIdx++
      const mesh = new THREE.Mesh(geo, mat)
      mesh.name = String(id)
      mesh.position.set(position.x, position.y, position.z)
      mesh.rotation.set(rotation.x, rotation.y, rotation.z)
      scene.add(mesh)
      objects.set(id, mesh)
    },

    updateObject(id: unknown, position: Vec3, rotation: Vec3): void {
      const mesh = objects.get(id)
      if (!mesh) return
      mesh.position.set(position.x, position.y, position.z)
      mesh.rotation.set(rotation.x, rotation.y, rotation.z)
    },

    setColor(id: unknown, color: number | null): void {
      const mesh = objects.get(id)
      if (!mesh || color == null) return
      ;(mesh.material as THREE.MeshStandardMaterial).color.set(color)
    },

    destroyObject(id: unknown): void {
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
      colorIdx = 0
    },
  }
}
