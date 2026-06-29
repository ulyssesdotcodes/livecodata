import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { AfterimagePass } from 'three/addons/postprocessing/AfterimagePass.js'
import { DotScreenPass } from 'three/addons/postprocessing/DotScreenPass.js'
import { FilmPass } from 'three/addons/postprocessing/FilmPass.js'
import { GlitchPass } from 'three/addons/postprocessing/GlitchPass.js'
import { HalftonePass } from 'three/addons/postprocessing/HalftonePass.js'
import { RGBShiftShader } from 'three/addons/shaders/RGBShiftShader.js'
import type { Pass } from 'three/addons/postprocessing/Pass.js'
import type { EffectEntry } from './effects.js'

export interface Vec3 {
  x: number
  y: number
  z: number
}

export interface SceneAPI {
  createObject(id: unknown, shape: unknown, position: Vec3, rotation: Vec3, color: number | null): void
  updateObject(id: unknown, position: Vec3, rotation: Vec3): void
  setColor(id: unknown, color: number | null): void
  destroyObject(id: unknown): void
  setEffects(chain: EffectEntry[]): void
  reset(): void
}

type PassFactory = () => Pass

const EFFECT_PASS: Record<string, PassFactory> = {
  bloom:      () => new UnrealBloomPass(new THREE.Vector2(256, 256), 1, 0.4, 0.85),
  afterimage: () => new AfterimagePass(),
  dotscreen:  () => new DotScreenPass(),
  rgbshift:   () => new ShaderPass(RGBShiftShader),
  film:       () => new FilmPass(),
  glitch:     () => new GlitchPass(),
  halftone:   () => new HalftonePass({}),
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPass = any

function applyEffectParams(type: string, pass: AnyPass, p: Record<string, unknown> = {}): void {
  const u = pass.uniforms as Record<string, { value: unknown }> | undefined
  switch (type) {
    case 'bloom':
      if (p.strength != null) pass.strength = p.strength as number
      if (p.radius != null) pass.radius = p.radius as number
      if (p.threshold != null) pass.threshold = p.threshold as number
      break
    case 'afterimage':
      if (p.damp != null && u) u.damp.value = p.damp as number
      break
    case 'dotscreen':
      if (p.scale != null && u) u.scale.value = p.scale as number
      if (p.angle != null && u) u.angle.value = p.angle as number
      if ((p.centerX != null || p.centerY != null) && u) {
        (u.center.value as THREE.Vector2).set(
          p.centerX != null ? p.centerX as number : (u.center.value as THREE.Vector2).x,
          p.centerY != null ? p.centerY as number : (u.center.value as THREE.Vector2).y,
        )
      }
      break
    case 'rgbshift':
      if (p.amount != null && u) u.amount.value = p.amount as number
      if (p.angle != null && u) u.angle.value = p.angle as number
      break
    case 'film':
      if (p.intensity != null && u) u.intensity.value = p.intensity as number
      if (p.grayscale != null && u) u.grayscale.value = !!p.grayscale
      break
    case 'glitch':
      pass.goWild = !!p.wild
      break
    case 'halftone':
      for (const k of ['radius', 'scatter', 'shape', 'blending', 'rotateR', 'rotateG', 'rotateB']) {
        if (p[k] != null && u?.[k]) u[k].value = p[k] as number
      }
      break
  }
}

const SHAPE_BUILDERS: Record<string, () => THREE.BufferGeometry> = {
  box:      () => new THREE.BoxGeometry(0.5, 0.5, 0.5),
  sphere:   () => new THREE.SphereGeometry(0.3, 32, 32),
  cylinder: () => new THREE.CylinderGeometry(0.2, 0.2, 0.6, 32),
  cone:     () => new THREE.ConeGeometry(0.3, 0.6, 32),
  torus:    () => new THREE.TorusGeometry(0.25, 0.08, 16, 64),
}

const PALETTE = [0x4a9eff, 0xff6b6b, 0x51cf66, 0xffd43b, 0xcc5de8, 0xff922b]

interface PassEntry {
  type: string
  pass: AnyPass
}

export function initThree(canvas: HTMLCanvasElement): SceneAPI {
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

  const composer = new EffectComposer(renderer)
  const renderPass = new RenderPass(scene, camera)
  const outputPass = new OutputPass()
  composer.addPass(renderPass)
  composer.addPass(outputPass)
  const passes = new Map<unknown, PassEntry>()
  let effectsActive = false
  const clock = new THREE.Clock()

  function resize(): void {
    const parent = canvas.parentElement
    if (!parent) return
    const { clientWidth: w, clientHeight: h } = parent
    renderer.setSize(w, h, false)
    composer.setSize(w, h)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }

  resize()
  new ResizeObserver(resize).observe(canvas.parentElement!)

  function animate(): void {
    if (effectsActive) composer.render(clock.getDelta())
    else renderer.render(scene, camera)
    requestAnimationFrame(animate)
  }
  requestAnimationFrame(animate)

  const objects = new Map<unknown, THREE.Mesh>()
  let colorIdx = 0

  return {
    createObject(id: unknown, shape: unknown, position: Vec3, rotation: Vec3, color: number | null): void {
      if (objects.has(id)) return
      const geo = (SHAPE_BUILDERS[shape as string] ?? SHAPE_BUILDERS.box)()
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

    setEffects(chain: EffectEntry[] = []): void {
      const byId = new Map(chain.map((e) => [e.id, e]))
      for (const [id, entry] of passes) {
        if (entry.type !== byId.get(id)?.effect) {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-call
          entry.pass.dispose?.()
          passes.delete(id)
        }
      }

      const ordered: AnyPass[] = []
      for (const e of chain) {
        const builder = EFFECT_PASS[e.effect]
        if (!builder) continue
        let entry = passes.get(e.id)
        if (!entry) { entry = { type: e.effect, pass: builder() }; passes.set(e.id, entry) }
        applyEffectParams(e.effect, entry.pass, e.params)
        ordered.push(entry.pass)
      }

      composer.passes = [renderPass, ...ordered, outputPass]
      effectsActive = ordered.length > 0
      // Propagate current dimensions to newly-created passes. Bypassing
      // insertPass() means setSize() isn't called automatically, which breaks
      // size-dependent passes like HalftonePass (width/height uniforms stay at 1).
      const _c = composer as unknown as { _width: number; _height: number; _pixelRatio: number }
      const pw = _c._width * _c._pixelRatio
      const ph = _c._height * _c._pixelRatio
      for (const pass of ordered) pass.setSize?.(pw, ph)
    },

    reset(): void {
      for (const mesh of objects.values()) {
        scene.remove(mesh)
        mesh.geometry.dispose()
        ;(mesh.material as THREE.MeshStandardMaterial).dispose()
      }
      objects.clear()
      colorIdx = 0
      for (const { pass } of passes.values()) pass.dispose?.()
      passes.clear()
      composer.passes = [renderPass, outputPass]
      effectsActive = false
    },
  }
}
