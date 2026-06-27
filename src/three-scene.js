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

// Post-processing pass factories, keyed by effect type (see effects.js
// EFFECT_TYPES). Each builds the Three.js pass; params are written separately by
// applyEffectParams so a pass instance is reused across frames (preserving
// stateful effects like afterimage's frame trail).
const EFFECT_PASS = {
  bloom:      () => new UnrealBloomPass(new THREE.Vector2(256, 256), 1, 0.4, 0.85),
  afterimage: () => new AfterimagePass(),
  dotscreen:  () => new DotScreenPass(),
  rgbshift:   () => new ShaderPass(RGBShiftShader),
  film:       () => new FilmPass(),
  glitch:     () => new GlitchPass(),
  halftone:   () => new HalftonePass({}),
}

// Write a resolved effect's params onto its live pass. Each effect maps its
// param keys onto the pass's uniforms/properties.
function applyEffectParams(type, pass, p = {}) {
  const u = pass.uniforms
  switch (type) {
    case 'bloom':
      if (p.strength != null) pass.strength = p.strength
      if (p.radius != null) pass.radius = p.radius
      if (p.threshold != null) pass.threshold = p.threshold
      break
    case 'afterimage':
      if (p.damp != null) u.damp.value = p.damp
      break
    case 'dotscreen':
      if (p.scale != null) u.scale.value = p.scale
      if (p.angle != null) u.angle.value = p.angle
      if (p.centerX != null || p.centerY != null) {
        u.center.value.set(p.centerX ?? u.center.value.x, p.centerY ?? u.center.value.y)
      }
      break
    case 'rgbshift':
      if (p.amount != null) u.amount.value = p.amount
      if (p.angle != null) u.angle.value = p.angle
      break
    case 'film':
      if (p.intensity != null) u.intensity.value = p.intensity
      if (p.grayscale != null) u.grayscale.value = !!p.grayscale
      break
    case 'glitch':
      pass.goWild = !!p.wild
      break
    case 'halftone':
      for (const k of ['radius', 'scatter', 'shape', 'blending', 'rotateR', 'rotateG', 'rotateB']) {
        if (p[k] != null && u[k]) u[k].value = p[k]
      }
      break
  }
}

const SHAPE_BUILDERS = {
  box:      () => new THREE.BoxGeometry(0.5, 0.5, 0.5),
  sphere:   () => new THREE.SphereGeometry(0.3, 32, 32),
  cylinder: () => new THREE.CylinderGeometry(0.2, 0.2, 0.6, 32),
  cone:     () => new THREE.ConeGeometry(0.3, 0.6, 32),
  torus:    () => new THREE.TorusGeometry(0.25, 0.08, 16, 64),
}

const PALETTE = [0x4a9eff, 0xff6b6b, 0x51cf66, 0xffd43b, 0xcc5de8, 0xff922b]

export function initThree(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  renderer.setPixelRatio(window.devicePixelRatio)

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x1a1a2e)

  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100)
  camera.position.set(0, 0, 5)

  const dirLight = new THREE.DirectionalLight(0xe94560, 2)
  dirLight.position.set(2, 3, 4)
  scene.add(dirLight)
  scene.add(new THREE.AmbientLight(0x4466aa, 2))

  // Post-processing pipeline. The composer is only rendered through when one or
  // more effects are active; otherwise we render the scene straight to the
  // canvas. `passes` maps effect id → live pass instance so instances are reused
  // across frames (params just get updated), and stateful effects keep state.
  const composer = new EffectComposer(renderer)
  const renderPass = new RenderPass(scene, camera)
  const outputPass = new OutputPass()
  composer.addPass(renderPass)
  composer.addPass(outputPass)
  const passes = new Map() // id → { type, pass }
  let effectsActive = false
  const clock = new THREE.Clock()

  function resize() {
    const { clientWidth: w, clientHeight: h } = canvas.parentElement
    renderer.setSize(w, h, false)
    composer.setSize(w, h)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }

  resize()
  new ResizeObserver(resize).observe(canvas.parentElement)

  function animate() {
    if (effectsActive) composer.render(clock.getDelta())
    else renderer.render(scene, camera)
    requestAnimationFrame(animate)
  }
  requestAnimationFrame(animate)

  const objects = new Map()
  let colorIdx = 0

  return {
    createObject(id, shape, position, rotation, color) {
      if (objects.has(id)) return
      const geo = (SHAPE_BUILDERS[shape] ?? SHAPE_BUILDERS.box)()
      const mat = new THREE.MeshStandardMaterial({
        color: color != null ? color : PALETTE[colorIdx % PALETTE.length],
        metalness: 0.35,
        roughness: 0.4,
      })
      colorIdx++
      const mesh = new THREE.Mesh(geo, mat)
      mesh.name = id
      mesh.position.set(position.x, position.y, position.z)
      mesh.rotation.set(rotation.x, rotation.y, rotation.z)
      scene.add(mesh)
      objects.set(id, mesh)
    },

    updateObject(id, position, rotation) {
      const mesh = objects.get(id)
      if (!mesh) return
      mesh.position.set(position.x, position.y, position.z)
      mesh.rotation.set(rotation.x, rotation.y, rotation.z)
    },

    setColor(id, color) {
      const mesh = objects.get(id)
      if (!mesh || color == null) return
      mesh.material.color.set(color)
    },

    destroyObject(id) {
      const mesh = objects.get(id)
      if (!mesh) return
      scene.remove(mesh)
      mesh.geometry.dispose()
      mesh.material.dispose()
      objects.delete(id)
    },

    // Reconcile the post-processing chain with a resolved effect list (ordered,
    // from effects.effectChainAtFrame). Pass instances are created for new ids,
    // disposed for removed ones, and reused otherwise — so the composer is only
    // rebuilt when the chain's structure changes, and params update in place.
    setEffects(chain = []) {
      // Drop passes whose id left the chain or whose effect type changed.
      const byId = new Map(chain.map((e) => [e.id, e]))
      for (const [id, entry] of passes) {
        if (entry.type !== byId.get(id)?.effect) {
          entry.pass.dispose?.()
          passes.delete(id)
        }
      }

      // Create/reuse a pass per chain entry, update its params, and order them.
      // OutputPass stays at the tail (tone-mapping + sRGB); the composer renders
      // the last enabled pass to screen automatically.
      const ordered = []
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
      const pw = composer._width * composer._pixelRatio
      const ph = composer._height * composer._pixelRatio
      for (const pass of ordered) pass.setSize?.(pw, ph)
    },

    reset() {
      for (const mesh of objects.values()) {
        scene.remove(mesh)
        mesh.geometry.dispose()
        mesh.material.dispose()
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
