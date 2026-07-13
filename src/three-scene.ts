import * as THREE from 'three'
import { FontLoader, type Font } from 'three/addons/loaders/FontLoader.js'
import { TextGeometry } from 'three/addons/geometries/TextGeometry.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import helvetiker from 'three/examples/fonts/helvetiker_regular.typeface.json'
import { foldTablePositions, type FoldTableProgram } from './fold-engine.js'
import { SHAPE_DEFAULTS } from './shapes.js'

export interface SceneAPI {
  createObject(row: Record<string, unknown>): void
  updateObject(row: Record<string, unknown>): void
  destroyObject(id: unknown): void
  reset(): void
  // The scene camera. Driven by the DSL when the scene has a `shape: "camera"`
  // object (see cameraPose); otherwise it holds the default pose. Also exposed
  // for tooling (screenshot harnesses, debug orbits).
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

// ── Text ────────────────────────────────────────────────────────────────────
// A `shape: "text"` object is real extruded 3D geometry (three.js TextGeometry),
// so it catches the scene lights and has depth like every other mesh, and rides
// the same px/py/pz + rx/ry/rz transform. The font (helvetiker) is bundled and
// parsed synchronously — no asset fetch — so an object builds the instant its
// create row is seen, exactly like a box or sphere. `size` is the world-space
// cap height (per line); newlines split into stacked, centered lines. Only the
// helvetiker glyph set (Latin + common punctuation) renders; an unknown glyph is
// skipped. `color` is a plain material color, updated live like any other mesh.

export interface TextParams { text: string; size: number; color: number }

const TEXT_DEFAULTS = { size: 0.5, color: 0xffffff }

// The subset of a row that determines a text object, merged with defaults. Only
// `text` and `size` shape the (glyph) GEOMETRY; `color` is carried for the
// initial material but, like every other mesh, recolors without a rebuild.
export function textParams(row: Record<string, unknown>): TextParams {
  return {
    text: row.text == null ? '' : String(row.text),
    size: typeof row.size === 'number' ? (row.size as number) : TEXT_DEFAULTS.size,
    color: row.color != null ? (row.color as number) : TEXT_DEFAULTS.color,
  }
}

// Whether an update row's string or size has drifted from what a text object's
// geometry was last built with — those (and only those) mean the glyph geometry
// must be regenerated; a color change is a cheap material swap, handled like any
// other mesh and deliberately excluded here.
export function textGeometryChanged(prev: TextParams, row: Record<string, unknown>): boolean {
  const p = textParams(row)
  return p.text !== prev.text || p.size !== prev.size
}

interface TextObject {
  mesh: THREE.Mesh
  geometry: THREE.BufferGeometry
  material: THREE.MeshStandardMaterial
  params: TextParams
}

// The bundled font is parsed once, lazily, on the first text object — parsing is
// synchronous (FontLoader.parse), so it stays off the module-load path (and out
// of tests that only exercise the pure helpers above).
let _font: Font | null = null
function getFont(): Font {
  if (!_font) _font = new FontLoader().parse(helvetiker as unknown as Parameters<FontLoader['parse']>[0])
  return _font
}

// Build (multi-line) extruded text geometry centered on the origin, so the
// mesh's position/rotation place its CENTER — consistent with the other shapes.
function makeTextGeometry(params: TextParams): THREE.BufferGeometry {
  const lines = params.text.split('\n')
  const font = getFont()
  const lineH = params.size * 1.4
  const parts: THREE.BufferGeometry[] = []
  lines.forEach((line, i) => {
    if (!line.length) return
    const g = new TextGeometry(line, {
      font, size: params.size, depth: params.size * 0.15, curveSegments: 6,
      bevelEnabled: true, bevelThickness: params.size * 0.02, bevelSize: params.size * 0.015, bevelSegments: 2,
    })
    // A line of only unknown glyphs yields no geometry — skip it rather than
    // feeding an attribute-less geometry into the merge.
    if (!g.getAttribute('position')) { g.dispose(); return }
    g.translate(0, -i * lineH, 0)
    parts.push(g)
  })
  if (!parts.length) return new THREE.BufferGeometry()
  const merged = parts.length === 1 ? parts[0] : mergeGeometries(parts, false)!
  if (parts.length > 1) parts.forEach((g) => g.dispose())
  merged.center()
  return merged
}

function applyTextTransform(mesh: THREE.Mesh, row: Record<string, unknown>): void {
  const { px, py, pz, rx, ry, rz } = row
  mesh.position.set((px as number) ?? 0, (py as number) ?? 0, (pz as number) ?? 0)
  mesh.rotation.set((rx as number) ?? 0, (ry as number) ?? 0, (rz as number) ?? 0)
}

function makeText(row: Record<string, unknown>): TextObject {
  const params = textParams(row)
  const geometry = makeTextGeometry(params)
  const material = new THREE.MeshStandardMaterial({ color: params.color, metalness: 0.3, roughness: 0.4 })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = String(row.id)
  applyTextTransform(mesh, row)
  return { mesh, geometry, material, params }
}

// Regenerate the glyph geometry — called only when textGeometryChanged().
function rebuildTextGeometry(obj: TextObject, row: Record<string, unknown>): void {
  const params = textParams(row)
  obj.geometry.dispose()
  obj.geometry = makeTextGeometry(params)
  obj.mesh.geometry = obj.geometry
  obj.params = params
}

function disposeText(obj: TextObject): void {
  obj.geometry.dispose()
  obj.material.dispose()
}

// ── Camera ──────────────────────────────────────────────────────────────────
// A `shape: "camera"` object doesn't add a mesh — it drives the scene camera.
// px/py/pz place the eye and tx/ty/tz the look-at target (default origin);
// optional `fov` sets the vertical field of view in degrees (a lower fov reads
// as a longer lens / dolly-zoom). Because it flows through events → rasterize
// like any object, camera moves are just keyframes on the beat timeline and
// interpolate for free. Default pose matches the app's initial camera: eye at
// (0,0,5) looking at the origin, 60° fov.

export interface CameraPose { px: number; py: number; pz: number; tx: number; ty: number; tz: number; fov: number | null }

export const CAMERA_DEFAULT: CameraPose = { px: 0, py: 0, pz: 5, tx: 0, ty: 0, tz: 0, fov: 60 }

const num = (v: unknown, d: number): number => (typeof v === 'number' ? v : d)

// Resolve a camera row to a concrete pose, falling back to the default eye/
// target so a partial row (e.g. only pz given) is still well-defined. `fov` is
// null when the row doesn't set it, so the current fov is left untouched.
export function cameraPose(row: Record<string, unknown>): CameraPose {
  return {
    px: num(row.px, CAMERA_DEFAULT.px), py: num(row.py, CAMERA_DEFAULT.py), pz: num(row.pz, CAMERA_DEFAULT.pz),
    tx: num(row.tx, CAMERA_DEFAULT.tx), ty: num(row.ty, CAMERA_DEFAULT.ty), tz: num(row.tz, CAMERA_DEFAULT.tz),
    fov: typeof row.fov === 'number' ? (row.fov as number) : null,
  }
}

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
  const { FV, pos, zOff } = foldTablePositions(program, obj.fold)
  const P = obj.posAttr.array as Float32Array
  let n = 0
  for (let fi = 0; fi < FV.length; ++fi) {
    const F = FV[fi]
    const z = zOff[fi]
    for (let j = 1; j + 1 < F.length; ++j) {
      for (const vi of [F[0], F[j], F[j + 1]]) {
        const v = pos[vi]
        P[n++] = v[0]; P[n++] = v[1]; P[n++] = v[2] + z
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
    const z = zOff[fi]
    let i = F.length - 1
    for (let j = 0; j < F.length; ++j) {
      const a = F[i], b = F[j]
      i = j
      const key = a < b ? `${a},${b}` : `${b},${a}`
      if (seen.has(key)) continue
      seen.add(key)
      L[m++] = pos[a][0]; L[m++] = pos[a][1]; L[m++] = pos[a][2] + z
      L[m++] = pos[b][0]; L[m++] = pos[b][1]; L[m++] = pos[b][2] + z
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
  const texts = new Map<unknown, TextObject>()
  const cameras = new Set<unknown>()
  let colorIdx = 0

  function applyCamera(row: Record<string, unknown>): void {
    const p = cameraPose(row)
    camera.position.set(p.px, p.py, p.pz)
    camera.up.set(0, 1, 0)
    camera.lookAt(p.tx, p.ty, p.tz)
    if (p.fov != null && p.fov !== camera.fov) {
      camera.fov = p.fov
      camera.updateProjectionMatrix()
    }
  }

  function resetCamera(): void {
    const d = CAMERA_DEFAULT
    camera.position.set(d.px, d.py, d.pz)
    camera.up.set(0, 1, 0)
    camera.lookAt(d.tx, d.ty, d.tz)
    if (camera.fov !== d.fov) {
      camera.fov = d.fov!
      camera.updateProjectionMatrix()
    }
  }

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
      if (objects.has(id) || origamis.has(id) || texts.has(id) || cameras.has(id)) return
      if (shape === 'camera') {
        applyCamera(row)
        cameras.add(id)
        return
      }
      if (shape === 'origami' && row.program) {
        const obj = makeOrigami(row)
        scene.add(obj.root)
        origamis.set(id, obj)
        return
      }
      if (shape === 'text') {
        const obj = makeText(row)
        scene.add(obj.mesh)
        texts.set(id, obj)
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
      if (cameras.has(id)) {
        applyCamera(row)
        return
      }
      const origami = origamis.get(id)
      if (origami) {
        applyOrigamiRow(origami, row)
        return
      }
      const text = texts.get(id)
      if (text) {
        applyTextTransform(text.mesh, row)
        if (color != null) text.material.color.set(color as number)
        if (textGeometryChanged(text.params, row)) rebuildTextGeometry(text, row)
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
      if (cameras.has(id)) {
        cameras.delete(id)
        if (cameras.size === 0) resetCamera()
        return
      }
      const origami = origamis.get(id)
      if (origami) {
        scene.remove(origami.root)
        disposeOrigami(origami)
        origamis.delete(id)
        return
      }
      const text = texts.get(id)
      if (text) {
        scene.remove(text.mesh)
        disposeText(text)
        texts.delete(id)
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
      for (const text of texts.values()) {
        scene.remove(text.mesh)
        disposeText(text)
      }
      texts.clear()
      cameras.clear()
      resetCamera()
      colorIdx = 0
    },
  }
}
