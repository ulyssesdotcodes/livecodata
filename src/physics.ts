// livecodata physics
// ----------------------------------------------------------------------------
// Bakes a JoltPhysics rigid-body simulation from a base scene table and turns
// the result back into rows the rest of the DSL already understands.
// ----------------------------------------------------------------------------

import initJolt from 'jolt-physics'
import type { Row } from './lineage.js'
import type { SimulateOptions } from './dsl.js'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JoltModule = any

const LAYER_NON_MOVING = 0
const LAYER_MOVING = 1
const NUM_OBJECT_LAYERS = 2
const NUM_BROAD_PHASE_LAYERS = 2

const SHAPE_DEFAULTS: Record<string, Record<string, number>> = {
  box:      { hx: 0.25, hy: 0.25, hz: 0.25 },
  sphere:   { r: 0.3 },
  cylinder: { r: 0.2, h: 0.3 },
  cone:     { r: 0.3, h: 0.3 },
  torus:    { r: 0.3 },
}

let _joltPromise: Promise<JoltModule> | null = null

export interface PhysicsEngineInstance {
  readonly Jolt: unknown
  simulate(baseRows: Row[], opts?: SimulateOptions): Row[]
}

export async function initPhysics(): Promise<PhysicsEngineInstance> {
  if (!_joltPromise) _joltPromise = initJolt()
  const Jolt = await _joltPromise
  return new PhysicsEngine(Jolt)
}

class PhysicsEngine implements PhysicsEngineInstance {
  readonly Jolt: JoltModule

  constructor(Jolt: JoltModule) {
    this.Jolt = Jolt
  }

  simulate(baseRows: Row[], opts?: SimulateOptions): Row[] {
    return simulateScene(this.Jolt, baseRows, opts)
  }
}

interface Quaternion {
  x: number
  y: number
  z: number
  w: number
}

interface EulerAngles {
  rx: number
  ry: number
  rz: number
}

function eulerToQuat(rx: number, ry: number, rz: number): Quaternion {
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

function quatToEuler(x: number, y: number, z: number, w: number): EulerAngles {
  const x2 = x + x, y2 = y + y, z2 = z + z
  const xx = x * x2, xy = x * y2, xz = x * z2
  const yy = y * y2, yz = y * z2, zz = z * z2
  const wx = w * x2, wy = w * y2, wz = w * z2
  const m11 = 1 - (yy + zz), m12 = xy - wz, m13 = xz + wy
  const m22 = 1 - (xx + zz), m23 = yz - wx
  const m32 = yz + wx, m33 = 1 - (xx + yy)

  const ry = Math.asin(Math.max(-1, Math.min(1, m13)))
  let rx: number, rz: number
  if (Math.abs(m13) < 0.9999999) {
    rx = Math.atan2(-m23, m33)
    rz = Math.atan2(-m12, m11)
  } else {
    rx = Math.atan2(m32, m22)
    rz = 0
  }
  return { rx, ry, rz }
}

function makeJoltInterface(Jolt: JoltModule): JoltModule {
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

function makeShape(Jolt: JoltModule, row: Row): JoltModule {
  const shape = (row.shape as string | undefined) ?? 'box'
  const d = SHAPE_DEFAULTS[shape] ?? SHAPE_DEFAULTS.box
  switch (shape) {
    case 'sphere':
    case 'torus':
      return new Jolt.SphereShape((row.r as number | undefined) ?? d.r, null)
    case 'cylinder':
    case 'cone':
      return new Jolt.CylinderShape((row.h as number | undefined) ?? d.h, (row.r as number | undefined) ?? d.r, 0.05, null)
    case 'box':
    default: {
      const half = new Jolt.Vec3((row.hx as number | undefined) ?? d.hx, (row.hy as number | undefined) ?? d.hy, (row.hz as number | undefined) ?? d.hz)
      const s = new Jolt.BoxShape(half, 0.05, null)
      Jolt.destroy(half)
      return s
    }
  }
}

function motionType(Jolt: JoltModule, motion: string | undefined): JoltModule {
  switch (motion) {
    case 'static':    return Jolt.EMotionType_Static
    case 'kinematic': return Jolt.EMotionType_Kinematic
    default:          return Jolt.EMotionType_Dynamic
  }
}

export function simulateScene(Jolt: JoltModule, baseRows: Row[], opts: SimulateOptions = {}): Row[] {
  const {
    steps = 120,
    gravity = -9.81,
    fps = 60,
    sampleEvery = 1,
    collisions = true,
  } = opts

  const creates = (baseRows ?? []).filter((r) => ((r.type as string | undefined) ?? 'create') === 'create' && r.id != null)

  const jolt = makeJoltInterface(Jolt)
  const physicsSystem = jolt.GetPhysicsSystem()
  const bodyInterface = physicsSystem.GetBodyInterface()

  const grav = new Jolt.Vec3(0, gravity, 0)
  physicsSystem.SetGravity(grav)
  Jolt.destroy(grav)

  const idByBody = new Map<number, unknown>()
  const moving: { id: unknown; bodyId: JoltModule }[] = []

  for (const row of creates) {
    const motion = row.motion as string | undefined
    const layer = motion === 'static' ? LAYER_NON_MOVING : LAYER_MOVING
    const shape = makeShape(Jolt, row)

    const pos = new Jolt.RVec3((row.px as number | undefined) ?? 0, (row.py as number | undefined) ?? 0, (row.pz as number | undefined) ?? 0)
    const q = eulerToQuat((row.rx as number | undefined) ?? 0, (row.ry as number | undefined) ?? 0, (row.rz as number | undefined) ?? 0)
    const rot = new Jolt.Quat(q.x, q.y, q.z, q.w)
    const settings = new Jolt.BodyCreationSettings(shape, pos, rot, motionType(Jolt, motion), layer)
    if (row.restitution != null) settings.mRestitution = row.restitution as number
    if (row.friction != null) settings.mFriction = row.friction as number

    const body = bodyInterface.CreateBody(settings)
    bodyInterface.AddBody(body.GetID(), Jolt.EActivation_Activate)

    if (motion !== 'static' && (row.vx != null || row.vy != null || row.vz != null)) {
      const v = new Jolt.Vec3((row.vx as number | undefined) ?? 0, (row.vy as number | undefined) ?? 0, (row.vz as number | undefined) ?? 0)
      bodyInterface.SetLinearVelocity(body.GetID(), v)
      Jolt.destroy(v)
    }

    const bodyKey = body.GetID().GetIndexAndSequenceNumber() as number
    idByBody.set(bodyKey, row.id)
    if (motion !== 'static') moving.push({ id: row.id, bodyId: body.GetID() })

    Jolt.destroy(settings)
    Jolt.destroy(rot)
    Jolt.destroy(pos)
  }

  const collisionRows: Row[] = []
  let frame = 0
  let listener: JoltModule | null = null
  if (collisions) {
    listener = new Jolt.ContactListenerJS()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    listener.OnContactAdded = (b1: any, b2: any, manifold: any) => {
      b1 = Jolt.wrapPointer(b1, Jolt.Body)
      b2 = Jolt.wrapPointer(b2, Jolt.Body)
      manifold = Jolt.wrapPointer(manifold, Jolt.ContactManifold)
      const idA = idByBody.get(b1.GetID().GetIndexAndSequenceNumber() as number)
      const idB = idByBody.get(b2.GetID().GetIndexAndSequenceNumber() as number)
      if (idA == null || idB == null) return
      const p = manifold.GetWorldSpaceContactPointOn1(0)
      const cx = p.GetX() as number, cy = p.GetY() as number, cz = p.GetZ() as number
      collisionRows.push({ id: idA, type: 'collision', index: frame / fps, other: idB, cx, cy, cz })
      collisionRows.push({ id: idB, type: 'collision', index: frame / fps, other: idA, cx, cy, cz })
    }
    listener.OnContactPersisted = () => {}
    listener.OnContactRemoved = () => {}
    listener.OnContactValidate = () => Jolt.ValidateResult_AcceptAllContactsForThisBodyPair
    physicsSystem.SetContactListener(listener)
  }

  const updateRows: Row[] = []
  const dt = 1 / fps
  const stride = Math.max(1, Math.round(sampleEvery))
  for (frame = 1; frame <= steps; frame++) {
    jolt.Step(dt, 1)
    if (frame % stride !== 0) continue
    for (const { id, bodyId } of moving) {
      const p = bodyInterface.GetPosition(bodyId)
      const r = bodyInterface.GetRotation(bodyId)
      const e = quatToEuler(r.GetX() as number, r.GetY() as number, r.GetZ() as number, r.GetW() as number)
      updateRows.push({
        id, type: 'update', index: frame / fps,
        px: p.GetX() as number, py: p.GetY() as number, pz: p.GetZ() as number,
        rx: e.rx, ry: e.ry, rz: e.rz,
      })
    }
  }

  if (listener) {
    physicsSystem.SetContactListener(null)
    Jolt.destroy(listener)
  }
  Jolt.destroy(jolt)

  const baseOut = creates.map((r) => ({ ...r, index: (r.index as number | undefined) ?? 0 }))
  const out = [...baseOut, ...updateRows, ...collisionRows]
  out.sort((a, b) => ((a.index as number) ?? 0) - ((b.index as number) ?? 0))
  return out
}
