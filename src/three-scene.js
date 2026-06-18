import * as THREE from 'three'

export function initThree(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  renderer.setPixelRatio(window.devicePixelRatio)

  const scene = new THREE.Scene()
  scene.background = new THREE.Color(0x1a1a2e)

  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100)
  camera.position.set(0, 0, 3)

  const geometry = new THREE.TorusKnotGeometry(0.7, 0.25, 120, 20)
  const material = new THREE.MeshStandardMaterial({
    color: 0x0f3460,
    metalness: 0.4,
    roughness: 0.3,
    emissive: 0x16213e,
  })
  const mesh = new THREE.Mesh(geometry, material)
  scene.add(mesh)

  const light = new THREE.DirectionalLight(0xe94560, 2)
  light.position.set(2, 3, 4)
  scene.add(light)

  scene.add(new THREE.AmbientLight(0x0f3460, 3))

  function resize() {
    const { clientWidth: w, clientHeight: h } = canvas.parentElement
    renderer.setSize(w, h, false)
    camera.aspect = w / h
    camera.updateProjectionMatrix()
  }

  resize()
  new ResizeObserver(resize).observe(canvas.parentElement)

  function animate(t) {
    mesh.rotation.x = t * 0.0003
    mesh.rotation.y = t * 0.0005
    renderer.render(scene, camera)
    requestAnimationFrame(animate)
  }

  requestAnimationFrame(animate)
}
