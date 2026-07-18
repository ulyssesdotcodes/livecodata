// livecodata post — the post-processing chain language (pure half). Code cells
// evaluate like hydra sketches: `new Function` over a fixed scope of head
// factories (`scene()`, later `src(bN)` and generators), each returning a chain
// builder whose fluent ops (`.edges(...)`, `.blur(...)`, …) accumulate an
// immutable op list. Nothing GPU happens here — the op list is data; the TSL
// factories that turn it into a node graph live in post-scene.ts (which owns
// the `three` imports). This module carries the op REGISTRY (the single source
// of truth for op names, arg counts, and the live/structural classification of
// each arg) plus the eval, structural-signature, and live-arg traversal that
// both the fold (post.ts) and the engine (post-scene.ts) share.

// Every op argument is either `live` — bound to a `uniform()` node the engine
// rewrites each frame (a plain number lowers to a constant-valued uniform, a
// function is evaluated per frame against the props object) — or `structural`:
// baked into the compiled shader, so changing one selects a different
// precompiled state. This is what lets generic table columns drive arbitrary
// parameters: `edges(0.25, 1)` never recompiles when 0.25 changes, only when
// the structural colorMode does.
export type ArgClass = 'live' | 'structural'
export type OpKind = 'head' | 'fx' | 'combine'

export interface ArgSpec {
  name: string
  arg: ArgClass
  default: number
}

export interface OpSpec {
  kind: OpKind
  args: ArgSpec[]
  doc: string
}

// The op registry. Each entry's `make` (the TSL factory) is registered
// separately in post-scene.ts under the same name; keeping the factories out of
// this module keeps it (and its tests) free of the `three` import graph.
export const POST_OPS: Record<string, OpSpec> = {
  scene: { kind: 'head', args: [], doc: 'The rendered Three.js scene as the chain head — the color plane every effect starts from.' },
  src: { kind: 'head', args: [{ name: 'bus', arg: 'structural', default: 1 }], doc: 'A feedback bus (src(b1)..src(b3)) as the chain head — samples that bus\'s previous frame for one-frame-behind feedback.' },
  blend: { kind: 'combine', args: [{ name: 'amount', arg: 'live', default: 0.5 }], doc: 'Cross-fade another chain over this one by `amount` (0–1, live).' },
  add: { kind: 'combine', args: [], doc: 'Add another chain to this one.' },
  mult: { kind: 'combine', args: [], doc: 'Multiply this chain by another.' },
  diff: { kind: 'combine', args: [], doc: 'Absolute difference between this chain and another.' },
  mask: { kind: 'combine', args: [], doc: 'Multiply this chain by another chain\'s luminance.' },
  layer: { kind: 'combine', args: [], doc: 'Composite another chain over this one using the layer\'s alpha.' },
  transition: { kind: 'head', args: [{ name: 'mix', arg: 'live', default: 0 }, { name: 'threshold', arg: 'structural', default: 0.1 }, { name: 'useTexture', arg: 'structural', default: 0 }], doc: 'Wipe from one chain to another; the fold builds it from a transition event (crossfade, or a mask chain).' },
  edges: {
    kind: 'fx',
    args: [
      { name: 'threshold', arg: 'live', default: 0.2 },
      { name: 'colorMode', arg: 'structural', default: 0 },
    ],
    doc: 'Sobel edge detection. `threshold` (live) cuts weak edges; `colorMode` (structural) picks the look: 0 = white-on-black, 1 = edges over the source, 2 = hue by edge direction.',
  },
  blur: {
    kind: 'fx',
    args: [{ name: 'radius', arg: 'live', default: 4 }],
    doc: 'Separable Gaussian blur (horizontal then vertical). `radius` (live) scales the sample spread with no recompile.',
  },
  bloom: {
    kind: 'fx',
    args: [
      { name: 'strength', arg: 'live', default: 0.6 },
      { name: 'radius', arg: 'live', default: 0.5 },
      { name: 'threshold', arg: 'live', default: 0 },
    ],
    doc: 'Additive bloom over bright areas. `strength`, `radius` (0–1), and `threshold` are all live.',
  },
  pixelate: {
    kind: 'fx',
    args: [{ name: 'size', arg: 'live', default: 6 }],
    doc: 'Quantize to square blocks `size` pixels across (live).',
  },
  posterize: {
    kind: 'fx',
    args: [{ name: 'steps', arg: 'live', default: 4 }],
    doc: 'Quantize each colour channel to `steps` levels (live).',
  },
  invert: { kind: 'fx', args: [], doc: 'Invert the colour (1 − c).' },
  rgbshift: {
    kind: 'fx',
    args: [{ name: 'amount', arg: 'live', default: 0.005 }],
    doc: 'Chromatic aberration: split the red and blue channels apart by `amount` in UV space (live).',
  },
  mosaic: {
    kind: 'fx',
    args: [{ name: 'scale', arg: 'live', default: 8 }],
    doc: 'Mirror-tile the image into a `scale`×`scale` kaleidoscope grid (live).',
  },
  strobe: {
    kind: 'fx',
    args: [{ name: 'speed', arg: 'live', default: 4 }],
    doc: 'Beat-locked brightness strobe: pulses on the beat clock at `speed` cycles per beat (deterministic — no wall time).',
  },
  film: {
    kind: 'fx',
    args: [{ name: 'intensity', arg: 'live', default: 0.3 }],
    doc: 'Film grain seeded by the beat clock (deterministic; scrubs and pauses with the timeline). `intensity` is live.',
  },
  rgbsplit: { kind: 'fx', args: [], doc: 'Beat-quantized channel-strobe: offsets the R/B channels in steps locked to the beat clock.' },
}

export const POST_HEADS: string[] = Object.keys(POST_OPS).filter((n) => POST_OPS[n].kind === 'head')

// A live arg carries either a constant (lowered to a uniform holding it) or a
// per-frame function of the props object; a structural arg carries a baked
// number.
export type LiveValue = number | ((props: Record<string, unknown>) => number)
export interface OpArgVal {
  cls: ArgClass
  value: LiveValue
}
export interface OpCall {
  op: string
  kind: OpKind
  args: OpArgVal[]
  // Chain arguments: a combine (blend/layer/mask/…) carries one; a transition
  // carries the before/after (and optional mask) chains it wipes between.
  chainArgs?: OpChain[]
}
export type OpChain = OpCall[]

// Classify one call site's raw arguments against the op's registry spec. A
// structural slot bakes to a number (its default when not a number); a live
// slot keeps a number or a function verbatim, coercing a numeric string and
// falling back to the default for anything unusable.
function makeCall(op: string, kind: OpKind, spec: ArgSpec[], raw: unknown[], chainArgs?: OpChain[]): OpCall {
  const args = spec.map((s, i): OpArgVal => {
    const r = raw[i]
    if (s.arg === 'structural') {
      return { cls: 'structural', value: typeof r === 'number' && Number.isFinite(r) ? r : s.default }
    }
    if (typeof r === 'function') return { cls: 'live', value: r as (p: Record<string, unknown>) => number }
    if (typeof r === 'number' && Number.isFinite(r)) return { cls: 'live', value: r }
    if (typeof r === 'string' && r.trim() !== '') {
      const n = Number(r)
      return { cls: 'live', value: Number.isFinite(n) ? n : s.default }
    }
    return { cls: 'live', value: s.default }
  })
  return { op, kind, args, chainArgs }
}

// The fluent chain builder a head factory returns. Every fx/combine op in the
// registry is a method here; combine ops take another chain (or a bare head
// value) as their first argument.
class ChainBuilder {
  ops: OpChain
  constructor(head: OpCall) {
    this.ops = [head]
  }
}

function installOps(): void {
  for (const [name, spec] of Object.entries(POST_OPS)) {
    if (spec.kind === 'head') continue
    if (spec.kind === 'combine') {
      ;(ChainBuilder.prototype as unknown as Record<string, unknown>)[name] = function (this: ChainBuilder, chain: unknown, ...rest: unknown[]): ChainBuilder {
        this.ops.push(makeCall(name, spec.kind, spec.args, rest, [chainOps(chain)]))
        return this
      }
    } else {
      ;(ChainBuilder.prototype as unknown as Record<string, unknown>)[name] = function (this: ChainBuilder, ...rest: unknown[]): ChainBuilder {
        this.ops.push(makeCall(name, spec.kind, spec.args, rest))
        return this
      }
    }
  }
}
installOps()

function chainOps(value: unknown): OpChain {
  if (value instanceof ChainBuilder) return value.ops
  throw new Error('post: combine op expected a chain argument')
}

// The eval scope: head factories plus the bus tokens (b1..b3) and the
// transition builder. `scene`/`src` return a fresh ChainBuilder; `transition`
// wraps the fold's before/after (and optional mask) chains.
function headScope(): Record<string, unknown> {
  const scope: Record<string, unknown> = {}
  scope.scene = (): ChainBuilder => new ChainBuilder(makeCall('scene', 'head', POST_OPS.scene.args, []))
  scope.src = (bus: unknown): ChainBuilder => new ChainBuilder(makeCall('src', 'head', POST_OPS.src.args, [bus]))
  scope.b1 = 1
  scope.b2 = 2
  scope.b3 = 3
  // A transition is the head of the output chain the fold produces: it wipes
  // `before` → `after` by `pos` (0→1), optionally through a black-and-white
  // `mask` chain (null = crossfade). The pos function reads the playback clock.
  scope.transition = (before: unknown, after: unknown, mask: unknown, pos: unknown, threshold?: unknown): ChainBuilder => {
    const useTexture = mask instanceof ChainBuilder ? 1 : 0
    const call = makeCall('transition', 'head', POST_OPS.transition.args, [pos, threshold, useTexture])
    call.chainArgs = useTexture
      ? [chainOps(before), chainOps(after), chainOps(mask)]
      : [chainOps(before), chainOps(after)]
    return new ChainBuilder(call)
  }
  return scope
}

// Evaluate a post code cell to its op list. The cell is an expression like
// `scene().edges((p) => p.th, 1).bloom(0.3)`; it runs against the head scope
// and must return a chain builder. Throws on a syntax error or an unknown op.
export function evalPostCode(code: string): OpChain {
  const scope = headScope()
  const keys = Object.keys(scope)
  const fn = new Function(...keys, `"use strict"; return (${code});`)
  const result = fn(...keys.map((k) => scope[k])) as unknown
  if (!(result instanceof ChainBuilder)) throw new Error('post: code cell must return a chain (did you start with scene()?)')
  return result.ops
}

// The structural signature of a chain: op names with structural args inlined
// and live args masked to `#`. Two chains share a precompiled state exactly
// when their signatures match, so a live-literal edit (or a function arg) never
// forces a new graph.
export function chainSignature(chain: OpChain): string {
  return chain
    .map((op) => {
      const args = op.args.map((a) => (a.cls === 'structural' ? String(a.value) : '#')).join(',')
      const sub = op.chainArgs ? `{${op.chainArgs.map(chainSignature).join('|')}}` : ''
      return `${op.op}(${args})${sub}`
    })
    .join('.')
}

// Visit every live arg in the deterministic order the engine binds uniforms:
// each op in chain order, its own live args in arg order, then (for a combine)
// its sub-chain. buildGraph in post-scene.ts walks identically, so the i-th
// visited value maps to the i-th created uniform.
export function forEachLiveArg(chain: OpChain, cb: (value: LiveValue) => void): void {
  for (const op of chain) {
    for (const a of op.args) if (a.cls === 'live') cb(a.value)
    if (op.chainArgs) for (const sub of op.chainArgs) forEachLiveArg(sub, cb)
  }
}

// Resolve every live arg to a number against `props` (functions evaluated,
// constants passed through), in binding order.
export function collectLiveValues(chain: OpChain, props: Record<string, unknown>): number[] {
  const out: number[] = []
  forEachLiveArg(chain, (v) => {
    const n = typeof v === 'function' ? Number(v(props)) : v
    out.push(Number.isFinite(n) ? n : 0)
  })
  return out
}
