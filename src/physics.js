// livecodata physics
// ----------------------------------------------------------------------------
// Bakes a JoltPhysics rigid-body simulation from a base scene table and turns
// the result back into rows the rest of the DSL already understands. The base
// scene is a table of "create" rows (the same shape/position/color rows the
// three-scene renderer consumes); each row may carry a few physics-only fields:
//
//   motion   "dynamic" | "static" | "kinematic"   (default "dynamic")
//   px,py,pz  spawn position                       (default 0)
//   rx,ry,rz  spawn rotation, Euler XYZ radians     (default 0)
//   vx,vy,vz  initial linear velocity (dynamic)     (default 0)
//   shape     box | sphere | cylinder | cone | torus
//   r         radius          (sphere/cylinder/cone/torus)
//   hx,hy,hz  box half-extents
//   h         cylinder/cone half-height
//   restitution, friction     per-body surface props
//
// simulate() steps the world `steps` frames and APPENDS to the table:
//   * an "update" row per dynamic/kinematic body per sampled frame, carrying the
//     baked px,py,pz / rx,ry,rz the playback clock interpolates between, and
//   * a "collision" row each time two bodies first touch — { id, other, index,
//     cx,cy,cz } at the world-space contact point. (Contact points use cx,cy,cz
//     rather than px,py,pz so playback never mistakes them for movement
//     keyframes.)
// All `index` values are in **seconds** (frame / fps), matching the DSL convention.
//
// The Jolt asm.js build loads asynchronously, so initPhysics() is the async door
// in; the engine it returns runs each simulate() synchronously during a cook.
// ----------------------------------------------------------------------------

// The wasm-compat build is a single self-contained file (wasm inlined), so it
// works both in the browser bundle and under node --test without a separate
// .wasm asset to locate.
import initJolt from 'jolt-physics'

// Object layers: statics never collide with each other, movers collide with all.
const LAYER_NON_MOVING = 0
const LAYER_MOVING = 1
const NUM_OBJECT_LAYERS = 2
const NUM_BROAD_PHASE_LAYERS = 2

// Collision-shape sizes that match the meshes in three-scene.js, so the baked
// motion lines up with what gets drawn. Overridable per row (see header).
const SHAPE_DEFAULTS = {
  box:      { hx: 0.25, hy: 0.25, hz: 0.25 },
  sphere:   { r: 0.3 },
  cylinder: { r: 0.2, h: 0.3 },
  cone:     { r: 0.3, h: 0.3 }, // Jolt has no cone primitive — approximate w/ a cylinder
  torus:    { r: 0.3 },         // ditto, approximate the bounding sphere
}

let _joltPromise = null

// Load the Jolt module once (it's a multi-MB asm.js blob) and hand back an engine
// whose .simulate(baseRows, opts) bakes a scene synchronously. Safe to call more
// than once; the underlying module is cached.
export async function initPhysics() {
  if (!_joltPromise) _joltPromise = initJolt()
  const Jolt = await _joltPromise
  return new PhysicsEngine(Jolt)
}

class PhysicsEngine {
  constructor(Jolt) {
    this.Jolt = Jolt
  }

  simulate(baseRows, opts) {
    return simulateScene(this.Jolt, baseRows, opts)
  }
}

// ── Euler <-> Quaternion (THREE's 'XYZ' convention, so it matches the renderer) ──

function eulerToQuat(rx, ry, rz) {
  const c1 = Math.cos(rx / 2), s1 = Math.sin(rx / 2)
  const c2 = Math.cos(ry / 2), s2 = Math.sin(ry / 2)
  const c3 = Math.cos(rz / 2), s3 = Math.sin(rz / 2)
  return {
    x: s1 * c2 * c3 + c1 * s2 * s3,
    y: c1 * s2 * c3 - s1 * c2 * s3,
    z: c1 * c2 * s3 + s1 * s2 * c3,
    w: c1 * c2 * c3 - s1 * s2 * s3,
  }
}

function quatToEuler(x, y, z, w) {
  // Build the rotation matrix entries we need, then read XYZ Euler angles.
  const x2 = x + x, y2 = y + y, z2 = z + z
  const xx = x * x2, xy = x * y2, xz = x * z2
  const yy = y * y2, yz = y * z2, zz = z * z2
  const wx = w * x2, wy = w * y2, wz = w * z2
  const m11 = 1 - (yy + zz), m12 = xy - wz, m13 = xz + wy
  const m22 = 1 - (xx + zz), m23 = yz - wx
  const m32 = yz + wx, m33 = 1 - (xx + yy)

  const ry = Math.asin(Math.max(-1, Math.min(1, m13)))
  let rx, rz
  if (Math.abs(m13) < 0.9999999) {
    rx = Math.atan2(-m23, m33)
    rz = Math.atan2(-m12, m11)
  } else {
    rx = Math.atan2(m32, m22)
    rz = 0
  }
  return { rx, ry, rz }
}

// Wire up the broad-phase / object-layer collision filtering Jolt needs before
// a JoltInterface can be constructed. Mirrors the canonical Jolt JS sample setup.
function makeJoltInterface(Jolt) {
  const settings = new Jolt.JoltSettings()

  const objectFilter = new Jolt.ObjectLayerPairFilterTable(NUM_OBJECT_LAYERS)
  objectFilter.EnableCollision(LAYER_NON_MOVING, LAYER_MOVING)
  objectFilter.EnableCollision(LAYER_MOVING, LAYER_MOVING)

  const bpInterface = new Jolt.BroadPhaseLayerInterfaceTable(NUM_OBJECT_LAYERS, NUM_BROAD_PHASE_LAYERS)
  bpInterface.MapObjectToBroadPhaseLayer(LAYER_NON_MOVING, new Jolt.BroadPhaseLayer(0))
  bpInterface.MapObjectToBroadPhaseLayer(LAYER_MOVING, new Jolt.BroadPhaseLayer(1))

  settings.mObjectLayerPairFilter = objectFilter
  settings.mBroadPhaseLayerInterface = bpInterface
  settings.mObjectVsBroadPhaseLayerFilter = new Jolt.ObjectVsBroadPhaseLayerFilterTable(
    bpInterface, NUM_BROAD_PHASE_LAYERS, objectFilter, NUM_OBJECT_LAYERS,
  )

  const jolt = new Jolt.JoltInterface(settings)
  Jolt.destroy(settings)
  return jolt
}

function makeShape(Jolt, row) {
  const shape = row.shape ?? 'box'
  const d = SHAPE_DEFAULTS[shape] ?? SHAPE_DEFAULTS.box
  switch (shape) {
    case 'sphere':
    case 'torus':
      return new Jolt.SphereShape(row.r ?? d.r, null)
    case 'cylinder':
    case 'cone':
      return new Jolt.CylinderShape(row.h ?? d.h, row.r ?? d.r, 0.05, null)
    case 'box':
    default: {
      const half = new Jolt.Vec3(row.hx ?? d.hx, row.hy ?? d.hy, row.hz ?? d.hz)
      const s = new Jolt.BoxShape(half, 0.05, null)
      Jolt.destroy(half)
      return s
    }
  }
}

function motionType(Jolt, motion) {
  switch (motion) {
    case 'static':    return Jolt.EMotionType_Static
    case 'kinematic': return Jolt.EMotionType_Kinematic
    default:          return Jolt.EMotionType_Dynamic
  }
}

// Bake a scene. Pure-ish: builds a throwaway Jolt world, steps it, returns rows,
// and tears the world back down (so repeated cooks don't pile up native memory).
export function simulateScene(Jolt, baseRows, opts = {}) {
  const {
    steps = 120,
    gravity = -9.81,
    fps = 60,
    sampleEvery = 1,
    collisions = true,
  } = opts

  const creates = (baseRows ?? []).filter((r) => (r.type ?? 'create') === 'create' && r.id != null)

  const jolt = makeJoltInterface(Jolt)
  const physicsSystem = jolt.GetPhysicsSystem()
  const bodyInterface = physicsSystem.GetBodyInterface()

  const grav = new Jolt.Vec3(0, gravity, 0)
  physicsSystem.SetGravity(grav)
  Jolt.destroy(grav)

  // Map a Jolt body id back to our string id, and remember which bodies move so
  // we only emit update rows for those.
  const idByBody = new Map()
  const moving = [] // { id, bodyId }

  for (const row of creates) {
    const motion = row.motion ?? 'dynamic'
    const layer = motion === 'static' ? LAYER_NON_MOVING : LAYER_MOVING
    const shape = makeShape(Jolt, row)

    const pos = new Jolt.RVec3(row.px ?? 0, row.py ?? 0, row.pz ?? 0)
    const q = eulerToQuat(row.rx ?? 0, row.ry ?? 0, row.rz ?? 0)
    const rot = new Jolt.Quat(q.x, q.y, q.z, q.w)
    const settings = new Jolt.BodyCreationSettings(shape, pos, rot, motionType(Jolt, motion), layer)
    if (row.restitution != null) settings.mRestitution = row.restitution
    if (row.friction != null) settings.mFriction = row.friction

    const body = bodyInterface.CreateBody(settings)
    bodyInterface.AddBody(body.GetID(), Jolt.EActivation_Activate)

    if (motion !== 'static' && (row.vx != null || row.vy != null || row.vz != null)) {
      const v = new Jolt.Vec3(row.vx ?? 0, row.vy ?? 0, row.vz ?? 0)
      bodyInterface.SetLinearVelocity(body.GetID(), v)
      Jolt.destroy(v)
    }

    const bodyKey = body.GetID().GetIndexAndSequenceNumber()
    idByBody.set(bodyKey, row.id)
    if (motion !== 'static') moving.push({ id: row.id, bodyId: body.GetID() })

    Jolt.destroy(settings)
    Jolt.destroy(rot)
    Jolt.destroy(pos)
  }

  // Capture the first contact between any two bodies as a collision row.
  const collisionRows = []
  let frame = 0
  let listener = null
  if (collisions) {
    listener = new Jolt.ContactListenerJS()
    listener.OnContactAdded = (b1, b2, manifold) => {
      b1 = Jolt.wrapPointer(b1, Jolt.Body)
      b2 = Jolt.wrapPointer(b2, Jolt.Body)
      manifold = Jolt.wrapPointer(manifold, Jolt.ContactManifold)
      const idA = idByBody.get(b1.GetID().GetIndexAndSequenceNumber())
      const idB = idByBody.get(b2.GetID().GetIndexAndSequenceNumber())
      if (idA == null || idB == null) return
      const p = manifold.GetWorldSpaceContactPointOn1(0)
      const cx = p.GetX(), cy = p.GetY(), cz = p.GetZ()
      collisionRows.push({ id: idA, type: 'collision', index: frame / fps, other: idB, cx, cy, cz })
      collisionRows.push({ id: idB, type: 'collision', index: frame / fps, other: idA, cx, cy, cz })
    }
    listener.OnContactPersisted = () => {}
    listener.OnContactRemoved = () => {}
    listener.OnContactValidate = () => Jolt.ValidateResult_AcceptAllContactsForThisBodyPair
    physicsSystem.SetContactListener(listener)
  }

  const updateRows = []
  const dt = 1 / fps
  const stride = Math.max(1, Math.round(sampleEvery))
  for (frame = 1; frame <= steps; frame++) {
    jolt.Step(dt, 1)
    if (frame % stride !== 0) continue
    for (const { id, bodyId } of moving) {
      const p = bodyInterface.GetPosition(bodyId)
      const r = bodyInterface.GetRotation(bodyId)
      const e = quatToEuler(r.GetX(), r.GetY(), r.GetZ(), r.GetW())
      updateRows.push({
        id, type: 'update', index: frame / fps,
        px: p.GetX(), py: p.GetY(), pz: p.GetZ(),
        rx: e.rx, ry: e.ry, rz: e.rz,
      })
    }
  }

  if (listener) {
    physicsSystem.SetContactListener(null)
    Jolt.destroy(listener)
  }
  Jolt.destroy(jolt)

  // Normalize base creates to index 0 so the renderer spawns them up front, then
  // hand back everything in index order, ready to .save("events").
  const baseOut = creates.map((r) => ({ ...r, index: r.index ?? 0 }))
  const out = [...baseOut, ...updateRows, ...collisionRows]
  out.sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  return out
}
