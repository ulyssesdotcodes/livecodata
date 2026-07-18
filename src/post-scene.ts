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
import { postFrameAt, postStateFrames, type PostFrame } from './post.js'
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
  setProgram(index: Row[]): void
  setFrame(frame: PostFrame | null, props: Record<string, unknown>): void
  render(): boolean
  resize(): void
  reset(): void
}

const BLUR_SIGMA = 4

// The initial value for op arg `i`: its constant when the arg is a plain number,
// else the registry default (a function-valued arg is overwritten every frame).
function liveInit(op: OpCall, i: number): number {
  const v = op.args[i]?.value
  return typeof v === 'number' ? v : (POST_OPS[op.op]?.args[i]?.default ?? 0)
}

// A src(bN) sampling node paired with the bus it reads — the engine repoints its
// `.value` at that bus's previous-frame target each render.
interface SrcRef { bus: number; node: Node }

interface Graph {
  node: Node
  uniforms: Node[]
  srcRefs: SrcRef[]
  chain: OpChain
}

export function initPost(three: { renderer: THREE.WebGPURenderer; scene: THREE.Scene; camera: THREE.Camera }): PostAPI {
  const { renderer, scene, camera } = three

  const scenePass = t.pass(scene, camera)
  const scenePassColor = scenePass.getTextureNode('output')

  // Feedback buses: a ping-pong RenderTarget pair per used index, shared across
  // states so feedback survives a state switch (it drops on resize, like hydra).
  interface Bus { index: number; targets: [THREE.RenderTarget, THREE.RenderTarget]; cur: number }
  const buses = new Map<number, Bus>()
  function ensureBus(index: number): Bus {
    let bus = buses.get(index)
    if (!bus) {
      const size = renderer.getDrawingBufferSize(new THREE.Vector2())
      const mk = (): THREE.RenderTarget => new THREE.RenderTarget(Math.max(1, size.x), Math.max(1, size.y), { depthBuffer: false })
      bus = { index, targets: [mk(), mk()], cur: 0 }
      buses.set(index, bus)
    }
    return bus
  }

  // Build a chain's node graph, collecting live uniforms and src refs in the
  // deterministic forEachLiveArg order (own live args of each op, then its chain
  // args) so setFrame binds uniforms positionally.
  function buildGraph(chain: OpChain): Graph {
    const uniforms: Node[] = []
    const srcRefs: SrcRef[] = []
    const live = (init: number): Node => { const u = t.uniform(init); uniforms.push(u); return u }

    function build(c: OpChain): Node {
      let node: Node | null = null
      for (const op of c) node = buildOp(op, node)
      return node
    }

    function buildOp(op: OpCall, input: Node): Node {
      switch (op.op) {
        case 'scene':
          return scenePassColor
        case 'src': {
          const busIndex = op.args[0].value as number
          const texNode = t.texture(ensureBus(busIndex).targets[0].texture)
          srcRefs.push({ bus: busIndex, node: texNode })
          return texNode
        }
        case 'edges': {
          const th = live(liveInit(op, 0))
          const colorMode = op.args[1]?.value as number
          const G: Node = (sobel(input) as Node).r
          const m = t.step(th, G)
          if (colorMode === 1) return t.vec4(t.vec3(input.rgb).add(t.vec3(m)), 1)
          if (colorMode === 2) return t.vec4(t.vec3(G, G.mul(0.5), t.oneMinus(G)).mul(m), 1)
          return t.vec4(t.vec3(m), 1)
        }
        case 'blur':
          return gaussianBlur(input, live(liveInit(op, 0)), BLUR_SIGMA)
        case 'bloom': {
          // BloomNode wraps its own uniforms — push those (in arg order) instead
          // of creating ours, keeping the forEachLiveArg alignment.
          const b = bloom(input, liveInit(op, 0), liveInit(op, 1), liveInit(op, 2))
          uniforms.push(b.strength, b.radius, b.threshold)
          return t.vec4(input).add(b)
        }
        case 'pixelate': {
          const size = live(liveInit(op, 0))
          const tex = t.convertToTexture(input)
          const cells = t.screenSize.div(size)
          const q = t.uv().mul(cells).floor().add(0.5).div(cells)
          return tex.sample(q)
        }
        case 'transition': {
          const pos = live(liveInit(op, 0))
          const threshold = op.args[1].value as number
          const useTexture = op.args[2].value as number
          const before = t.convertToTexture(build(op.chainArgs![0]))
          const after = t.convertToTexture(build(op.chainArgs![1]))
          if (useTexture) {
            const mask = t.convertToTexture(build(op.chainArgs![2]))
            const f = t.smoothstep(pos.sub(threshold), pos.add(threshold), t.luminance(t.vec3(mask)))
            return t.mix(after, before, f)
          }
          return t.mix(before, after, pos)
        }
        // Combines (blend has a live amount; the rest composite raw).
        case 'blend':
          return t.mix(t.vec4(input), t.vec4(build(op.chainArgs![0])), live(liveInit(op, 0)))
        case 'add':
          return t.vec4(input).add(t.vec4(build(op.chainArgs![0])))
        case 'mult':
          return t.vec4(input).mul(t.vec4(build(op.chainArgs![0])))
        case 'diff':
          return t.abs(t.vec4(input).sub(t.vec4(build(op.chainArgs![0]))))
        case 'mask':
          return t.vec4(input).mul(t.luminance(t.vec3(build(op.chainArgs![0]))))
        case 'layer': {
          const b = t.vec4(build(op.chainArgs![0]))
          return t.mix(t.vec4(input), b, b.a)
        }
        default:
          throw new Error(`post: no TSL factory for op "${op.op}"`)
      }
    }

    const node = build(chain)
    let liveCount = 0
    forEachLiveArg(chain, () => liveCount++)
    if (liveCount !== uniforms.length) {
      throw new Error(`post: bound ${uniforms.length} uniforms for ${liveCount} live args`)
    }
    return { node, uniforms, srcRefs, chain }
  }

  interface BusGraph extends Graph { index: number; quad: Node }
  interface State {
    main: { pipeline: Node; graph: Graph } | null
    buses: BusGraph[]
    warmed: boolean
  }
  const states = new Map<string, State>()
  let active: State | null = null

  function buildState(frame: PostFrame): State {
    const byOut = new Map(frame.chains.map((c) => [c.out, c.chain]))
    let main: State['main'] = null
    const mainChain = byOut.get('main')
    if (mainChain) {
      const graph = buildGraph(mainChain)
      main = { pipeline: new THREE.RenderPipeline(renderer, graph.node), graph }
    }
    const busGraphs: BusGraph[] = []
    for (const idx of [1, 2, 3]) {
      const bc = byOut.get('b' + idx)
      if (!bc) continue
      ensureBus(idx)
      const graph = buildGraph(bc)
      const mat = new THREE.NodeMaterial()
      mat.fragmentNode = graph.node
      const quad = new THREE.QuadMesh(mat)
      busGraphs.push({ ...graph, index: idx, quad })
    }
    const state: State = { main, buses: busGraphs, warmed: false }
    states.set(frame.stateId, state)
    return state
  }

  function warmAll(): void {
    void renderer.init().then(() => {
      for (const state of states.values()) {
        if (state.warmed) continue
        try {
          for (const bg of state.buses) {
            renderer.setRenderTarget(buses.get(bg.index)!.targets[0])
            bg.quad.render(renderer)
          }
          renderer.setRenderTarget(null)
          state.main?.pipeline.render()
          state.warmed = true
        } catch (e) {
          console.error('post: warm render failed', e)
        }
      }
    })
  }

  function writeUniforms(graph: Graph, props: Record<string, unknown>): void {
    const values = collectLiveValues(graph.chain, props)
    const n = Math.min(values.length, graph.uniforms.length)
    for (let i = 0; i < n; i++) graph.uniforms[i].value = values[i]
  }

  return {
    setProgram(index): void {
      states.clear()
      active = null
      if (index.length === 0) return
      const seen = new Set<string>()
      for (const f of postStateFrames(index)) {
        const frame = postFrameAt(index, f)
        if (!frame || seen.has(frame.stateId)) continue
        seen.add(frame.stateId)
        try {
          buildState(frame)
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
        try {
          state = buildState(frame)
          warmAll()
        } catch (e) {
          console.error('post: lazy state build failed', e)
          return
        }
      }
      active = state
      if (state.main) writeUniforms(state.main.graph, props)
      for (const bg of state.buses) writeUniforms(bg, props)
    },

    render(): boolean {
      if (!active) return false
      // Buses in index order to their write targets, sampling the previous frame
      // (targets[cur]); then flip so main reads this frame's output.
      for (const bg of active.buses) {
        const bus = buses.get(bg.index)!
        for (const ref of bg.srcRefs) {
          const rb = buses.get(ref.bus)
          if (rb) ref.node.value = rb.targets[rb.cur].texture
        }
        renderer.setRenderTarget(bus.targets[1 - bus.cur])
        bg.quad.render(renderer)
      }
      renderer.setRenderTarget(null)
      for (const bg of active.buses) { const bus = buses.get(bg.index)!; bus.cur = 1 - bus.cur }
      if (!active.main) return false
      for (const ref of active.main.graph.srcRefs) {
        const rb = buses.get(ref.bus)
        if (rb) ref.node.value = rb.targets[rb.cur].texture
      }
      active.main.pipeline.render()
      return true
    },

    resize(): void {
      const size = renderer.getDrawingBufferSize(new THREE.Vector2())
      for (const bus of buses.values()) {
        for (const rt of bus.targets) rt.setSize(Math.max(1, size.x), Math.max(1, size.y))
      }
    },

    reset(): void {
      active = null
    },
  }
}
