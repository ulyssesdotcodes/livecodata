import * as THREE from 'three'

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

  function resize() {
    const { clientWidth: w, clientHeight: h } = canvas.parentElement
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }

  resize()
  new ResizeObserver(resize).observe(canvas.parentElement)

  function animate() {
    renderer.render(scene, camera)
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

    reset() {
      for (const mesh of objects.values()) {
        scene.remove(mesh)
        mesh.geometry.dispose()
        mesh.material.dispose()
      }
      objects.clear()
      colorIdx = 0
    },
  }
}
