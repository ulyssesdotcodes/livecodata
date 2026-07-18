// livecodata post-scene — the TSL engine behind the post view. Turns the op
// lists folded by post.ts into a `three` node graph rendered by a RenderPipeline
// over the same scene three-scene.ts draws, BEFORE hydra samples the canvas as
// s0. All compilation happens at setProgram (cook/apply): every distinct folded
// state is built and warm-rendered once, so playback only writes uniforms and
// swaps between precompiled pipelines — never compiles on a beat.
//
// Works on the WebGL2 fallback (TSL compiles to GLSL there) — nothing gates on
// the backend. Determinism: no TSL `time`/`performance.now()` anywhere; all
// time/beat reaches ops through the props object the visualizer assembles from
// the playback clock.

import * as THREE from 'three/webgpu'
import * as TSL from 'three/tsl'
import { gaussianBlur } from 'three/addons/tsl/display/GaussianBlurNode.js'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { sobel } from 'three/addons/tsl/display/SobelOperatorNode.js'
import { POST_OPS, forEachLiveArg, collectLiveValues, type OpChain, type OpCall } from './post-lang.js'
import { postFrameAt, type PostFrame } from './post.js'
import type { Row } from './lineage.js'

// TSL's node-builder types are far stricter than the runtime (every op is
// overloaded per vector width); typing each intermediate adds no safety to
// shader-graph code, so we treat the namespace as untyped — the shader is the
// contract. (Same stance as compute/particles.ts.)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Node = any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const t: any = TSL

export interface PostAPI {
  // Enumerate + compile + warm-render every folded state of `index`.
  setProgram(index: Row[]): void
  // Select the precompiled state for this frame and write its live uniforms.
  setFrame(frame: PostFrame | null, props: Record<string, unknown>): void
  // Render the active state through its pipeline; returns false when inactive so
  // three-scene falls back to the plain renderer path.
  render(): boolean
  resize(): void
  reset(): void
}

const BLUR_SIGMA = 4

// One live-uniform accumulator for buildGraph — factories push their uniforms
// in live-arg order so setFrame can rebind them positionally.
interface Reg {
  live(init: number): Node
  add(u: Node): void
}

// The initial value for op arg `i`: its constant when the arg is a plain number,
// else the registry default (a function-valued arg is overwritten every frame).
function liveInit(op: OpCall, i: number): number {
  const v = op.args[i]?.value
  return typeof v === 'number' ? v : (POST_OPS[op.op]?.args[i]?.default ?? 0)
}

// The TSL factory per op. Each returns the output node given its input; live
// args are registered via `reg` in arg order (matching forEachLiveArg).
type Factory = (input: Node, op: OpCall, reg: Reg, scenePassColor: Node) => Node

const FACTORIES: Record<string, Factory> = {
  scene: (_input, _op, _reg, scenePassColor) => scenePassColor,

  edges: (input, op, reg) => {
    const th = reg.live(liveInit(op, 0))
    const colorMode = op.args[1]?.value as number
    const G: Node = (sobel(input) as Node).r
    const mask = t.step(th, G)
    if (colorMode === 1) return t.vec4(t.vec3(input.rgb).add(t.vec3(mask)), 1) // edges over source
    if (colorMode === 2) return t.vec4(t.vec3(G, G.mul(0.5), t.oneMinus(G)).mul(mask), 1) // hue by magnitude
    return t.vec4(t.vec3(mask), 1) // white edges on black
  },

  blur: (input, op, reg) => gaussianBlur(input, reg.live(liveInit(op, 0)), BLUR_SIGMA),

  bloom: (input, op, reg) => {
    const b = bloom(input, liveInit(op, 0), liveInit(op, 1), liveInit(op, 2))
    reg.add(b.strength)
    reg.add(b.radius)
    reg.add(b.threshold)
    return t.vec4(input).add(b)
  },

  pixelate: (input, op, reg) => {
    const size = reg.live(liveInit(op, 0))
    const tex = t.convertToTexture(input)
    const cells = t.screenSize.div(size)
    const q = t.uv().mul(cells).floor().add(0.5).div(cells)
    return tex.sample(q)
  },
}

interface Graph {
  node: Node
  uniforms: Node[]
}

// Build the node graph for one out's chain, collecting live uniforms in the
// deterministic forEachLiveArg order so setFrame binds them positionally.
function buildGraph(chain: OpChain, scenePassColor: Node): Graph {
  const uniforms: Node[] = []
  const reg: Reg = {
    live: (init) => { const u = t.uniform(init); uniforms.push(u); return u },
    add: (u) => { uniforms.push(u) },
  }
  let node: Node | null = null
  for (const op of chain) {
    const factory = FACTORIES[op.op]
    if (!factory) throw new Error(`post: no TSL factory for op "${op.op}"`)
    node = factory(node, op, reg, scenePassColor)
  }
  // Guard the invariant buildGraph and setFrame rely on: uniform count equals
  // the chain's live-arg count, so positional rebinding stays aligned.
  let liveCount = 0
  forEachLiveArg(chain, () => liveCount++)
  if (liveCount !== uniforms.length) {
    throw new Error(`post: op factory bound ${uniforms.length} uniforms for ${liveCount} live args`)
  }
  return { node: node!, uniforms }
}

interface State {
  pipeline: Node // THREE.RenderPipeline
  uniforms: Node[]
  warmed: boolean
}

export function initPost(three: { renderer: THREE.WebGPURenderer; scene: THREE.Scene; camera: THREE.Camera }): PostAPI {
  const { renderer, scene, camera } = three

  // One scene pass shared by every state graph (Phase 1: plain color; MRT demand
  // scanning arrives with the aux planes). Its color texture is the `scene()`
  // head every chain starts from.
  const scenePass = t.pass(scene, camera)
  const scenePassColor = scenePass.getTextureNode('output')

  const states = new Map<string, State>()
  let active: State | null = null

  function buildState(stateId: string, frame: PostFrame): State {
    // Phase 1: only `main` is rendered; buses (b1..b3) arrive with feedback.
    const main = frame.chains.find((c) => c.out === 'main') ?? frame.chains[0]
    const graph = buildGraph(main.chain, scenePassColor)
    const pipeline = new THREE.RenderPipeline(renderer, graph.node)
    const state: State = { pipeline, uniforms: graph.uniforms, warmed: false }
    states.set(stateId, state)
    return state
  }

  // Warm-render every state once so backend pipeline creation happens now (the
  // cook pause), not on a beat. Gated on renderer.init() — the first load can
  // arrive before the backend is chosen.
  function warmAll(): void {
    void renderer.init().then(() => {
      for (const state of states.values()) {
        if (state.warmed) continue
        try {
          state.pipeline.render()
          state.warmed = true
        } catch (e) {
          console.error('post: warm render failed', e)
        }
      }
    })
  }

  return {
    setProgram(index): void {
      states.clear()
      active = null
      if (index.length === 0) return
      // Enumerate every distinct folded state — one per event frame. (Transition
      // window ends join this set with the transition phase.)
      const frames = [...new Set(index.map((r) => r.index as number))].sort((a, b) => a - b)
      const seen = new Set<string>()
      for (const f of frames) {
        const frame = postFrameAt(index, f)
        if (!frame || seen.has(frame.stateId)) continue
        seen.add(frame.stateId)
        try {
          buildState(frame.stateId, frame)
        } catch (e) {
          console.error('post: state build failed', e)
        }
      }
      active = states.values().next().value ?? null
      warmAll()
    },

    setFrame(frame, props): void {
      if (!frame) { active = null; return }
      let state = states.get(frame.stateId)
      if (!state) {
        // A frame outside the enumerated set (should not happen once transition
        // ends are enumerated) — build it lazily so playback never crashes.
        try {
          state = buildState(frame.stateId, frame)
          warmAll()
        } catch (e) {
          console.error('post: lazy state build failed', e)
          return
        }
      }
      active = state
      const main = frame.chains.find((c) => c.out === 'main') ?? frame.chains[0]
      const values = collectLiveValues(main.chain, props)
      const n = Math.min(values.length, state.uniforms.length)
      for (let i = 0; i < n; i++) state.uniforms[i].value = values[i]
    },

    render(): boolean {
      if (!active) return false
      active.pipeline.render()
      return true
    },

    resize(): void {
      // RenderPipeline and its effect RTs track the renderer's drawing-buffer
      // size themselves; nothing to do here yet.
    },

    reset(): void {
      active = null
    },
  }
}
