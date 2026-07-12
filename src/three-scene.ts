import * as THREE from 'three'
import { createFoldPlayer, type FoldProgram, type FoldPlayer } from './origami.js'

export interface SceneAPI {
  createObject(row: Record<string, unknown>): void
  updateObject(row: Record<string, unknown>): void
  destroyObject(id: unknown): void
  reset(): void
}

// Live hydra outputs as face textures. hydra runs in its own WebGL context,
// so a GPU texture can't be shared directly — hydra-scene.ts mirrors each
// claimed output into a small 2D canvas every tick (see its face taps), and
// this scene wraps that canvas in a CanvasTexture. The bridge is claim/release
// refcounted on both sides so readback only runs while something shows it.
export interface HydraFaceBridge {
  claim(index: number): HTMLCanvasElement | null
  release(index: number): void
}

// A `map` field naming a hydra output ("o0".."o3") puts that output on every
// face; `map0`..`map5` override single faces of a box, in Three.js's box
// material order: +x, -x, +y (top), -y (bottom), +z (front), -z (back).
function hydraOutputIndex(v: unknown): number | null {
  return typeof v === 'string' && /^o\d$/.test(v) ? +v.slice(1) : null
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

// ABC play blocks: a `letter` field on a row stamps that letter on every face
// via a canvas texture — cream face, rounded accent frame, big letter in the
// row's own color. Cached per letter+color: playback re-creates objects on
// every reset/scrub, and the same block should reuse its texture rather than
// re-rasterizing (and re-uploading) it each time.
const letterTextures = new Map<string, THREE.CanvasTexture>()

function letterTexture(letter: string, color: number): THREE.CanvasTexture {
  const key = letter + ':' + color
  const cached = letterTextures.get(key)
  if (cached) return cached
  const size = 256
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const accent = '#' + color.toString(16).padStart(6, '0')
  ctx.fillStyle = '#f3ead2'
  ctx.fillRect(0, 0, size, size)
  ctx.strokeStyle = accent
  ctx.lineWidth = 14
  ctx.beginPath()
  ctx.roundRect(18, 18, size - 36, size - 36, 28)
  ctx.stroke()
  ctx.fillStyle = accent
  ctx.font = 'bold 148px Georgia, "Times New Roman", serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(letter, size / 2, size / 2 + 8)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  letterTextures.set(key, tex)
  return tex
}

// A live sheet of folding paper: the player owns the vertex buffer, the two
// meshes (colored front / paper-white back) and the crease lines all render
// straight out of it. Playback is pure kinematics: each fold step rigidly
// rotates the faces it moves about its fold line by (step angle × the row's
// fold fraction), so the only independently moving pieces are faces created
// by a previous fold and a pose is a pure function of the fractions. Faces
// are positioned independently, so the geometry is per-face (non-indexed).
interface OrigamiObject {
  root: THREE.Group
  player: FoldPlayer
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
  const program = row.program as FoldProgram
  const player = createFoldPlayer(program)

  const posAttr = new THREE.BufferAttribute(player.positions, 3)
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

  const linePosAttr = new THREE.BufferAttribute(player.linePositions, 3)
  linePosAttr.setUsage(THREE.DynamicDrawUsage)
  const lineGeometry = new THREE.BufferGeometry()
  lineGeometry.setAttribute('position', linePosAttr)
  const line = new THREE.LineBasicMaterial({ color: 0x1c1713, transparent: true, opacity: 0.5 })

  const root = new THREE.Group()
  root.add(new THREE.Mesh(geometry, front))
  root.add(new THREE.Mesh(geometry, back))
  root.add(new THREE.LineSegments(lineGeometry, line))

  const targets: Record<string, number> = {}
  for (const g of program.groups) targets[g] = 0

  const obj: OrigamiObject = {
    root, player, posAttr, linePosAttr, targets, front, back, line, geometry, lineGeometry,
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
export function initThree(canvas: HTMLCanvasElement, sizeFrom: HTMLElement, hydraFaces?: HydraFaceBridge): SceneAPI {
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

  // One CanvasTexture per claimed hydra output, shared by every face that
  // shows it, refcounted alongside the bridge's own claim count. The source
  // canvas repaints every hydra tick, so each live texture is re-uploaded
  // every rendered frame (see animate).
  const hydraTextures = new Map<number, { tex: THREE.CanvasTexture; refs: number }>()

  function claimHydraTexture(index: number): THREE.CanvasTexture | null {
    if (!hydraFaces) return null
    const entry = hydraTextures.get(index)
    if (entry) {
      hydraFaces.claim(index)
      entry.refs++
      return entry.tex
    }
    const source = hydraFaces.claim(index)
    if (!source) return null
    const tex = new THREE.CanvasTexture(source)
    tex.colorSpace = THREE.SRGBColorSpace
    hydraTextures.set(index, { tex, refs: 1 })
    return tex
  }

  function releaseHydraTexture(index: number): void {
    const entry = hydraTextures.get(index)
    if (!entry) return
    hydraFaces?.release(index)
    if (--entry.refs <= 0) {
      entry.tex.dispose()
      hydraTextures.delete(index)
    }
  }

  function disposeMesh(mesh: THREE.Mesh): void {
    mesh.geometry.dispose()
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const m of new Set(mats)) m.dispose() // shared CanvasTextures are disposed by the refcount below, letter textures by their cache
    for (const index of (mesh.userData.hydraClaims as number[] | undefined) ?? []) releaseHydraTexture(index)
  }

  function animate(): void {
    for (const o of origamis.values()) {
      o.player.step(o.targets)
      o.posAttr.needsUpdate = true
      o.linePosAttr.needsUpdate = true
    }
    for (const { tex } of hydraTextures.values()) tex.needsUpdate = true
    renderer.render(scene, camera)
    requestAnimationFrame(animate)
  }
  requestAnimationFrame(animate)

  return {
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
      const baseColor = color != null ? color as number : PALETTE[colorIdx % PALETTE.length]
      const lettered = typeof row.letter === 'string' && row.letter !== ''
      // A lettered face's paint lives in the texture; the material stays white
      // so the map's colors come through unmultiplied.
      const makeBase = (): THREE.MeshStandardMaterial => new THREE.MeshStandardMaterial({
        color: lettered ? 0xffffff : baseColor,
        map: lettered ? letterTexture(row.letter as string, baseColor) : null,
        metalness: lettered ? 0.05 : 0.35,
        roughness: lettered ? 0.7 : 0.4,
      })
      colorIdx++

      // Hydra-mapped faces: `map` covers every face, `map0`..`map5` override
      // single box faces. Basic (unlit) material, so the output's own colors
      // reach the screen unshaded — a hydra face is a little video screen,
      // not a lit surface. One material per output per object; faces without
      // an output fall back to the base (color or letter) material.
      const claims: number[] = []
      const hydraMats = new Map<number, THREE.MeshBasicMaterial>()
      const hydraMat = (index: number): THREE.MeshBasicMaterial | null => {
        const cached = hydraMats.get(index)
        if (cached) {
          const again = claimHydraTexture(index) // one claim per face keeps refcounts exact
          if (again) claims.push(index)
          return cached
        }
        const tex = claimHydraTexture(index)
        if (!tex) return null
        claims.push(index)
        const m = new THREE.MeshBasicMaterial({ map: tex })
        hydraMats.set(index, m)
        return m
      }

      const mapAll = hydraOutputIndex(row.map)
      const perFace = [0, 1, 2, 3, 4, 5].map((f) => hydraOutputIndex(row['map' + f]))
      let material: THREE.Material | THREE.Material[]
      if (perFace.some((i) => i != null) && geo instanceof THREE.BoxGeometry) {
        let base: THREE.MeshStandardMaterial | null = null
        material = perFace.map((i) => {
          const index = i ?? mapAll
          const hm = index != null ? hydraMat(index) : null
          if (hm) return hm
          if (!base) base = makeBase()
          return base
        })
      } else {
        material = (mapAll != null ? hydraMat(mapAll) : null) ?? makeBase()
      }

      const mesh = new THREE.Mesh(geo, material)
      mesh.userData.lettered = lettered
      mesh.userData.hydraClaims = claims
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
      // A lettered block's color is baked into its texture — tinting the white
      // material with the row's color would stain the whole face — and a
      // hydra-faced object (single or per-face materials) has no row color at all.
      const m = mesh.material
      if (color != null && !mesh.userData.lettered && !Array.isArray(m) && (m as THREE.MeshStandardMaterial).isMeshStandardMaterial) {
        (m as THREE.MeshStandardMaterial).color.set(color as number)
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
      disposeMesh(mesh)
      objects.delete(id)
    },

    reset(): void {
      for (const mesh of objects.values()) {
        scene.remove(mesh)
        disposeMesh(mesh)
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
