// livecodata hydra-scene — the hydra-synth GPU layer
// ----------------------------------------------------------------------------
// Wraps a hydra-synth instance whose source s0 is the Three.js scene canvas and
// whose output o0 is the visible canvas. The rendered 3D scene therefore becomes
// just another texture for hydra to post-process. setSketch() takes a sampled
// HydraFrame (see hydra.ts) and evaluates its code with the synth functions and
// the row's variables in scope. Only re-evaluates when the (code, vars) pair
// changes — re-running a sketch recompiles shaders, so we avoid doing it every
// animation frame.
// ----------------------------------------------------------------------------

import Hydra from 'hydra-synth'
import type { HydraFrame } from './hydra.js'

export interface HydraAPI {
  setSketch(frame: HydraFrame | null): void
  reset(): void
}

// Shown when the program defines no hydra view, or before its first code row:
// pass the rendered Three.js scene straight through to the output untouched.
const PASSTHROUGH = 'src(s0).out(o0)'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Synth = Record<string, any>

export function initHydra(canvas: HTMLCanvasElement, source: HTMLCanvasElement): HydraAPI {
  // makeGlobal:false keeps the synth functions on the instance instead of the
  // window; detectAudio:false avoids a microphone permission prompt; stream
  // capture is unused here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const hydra = new (Hydra as any)({
    canvas,
    detectAudio: false,
    makeGlobal: false,
    enableStreamCapture: false,
  })
  const synth = hydra.synth as Synth

  // Wire the Three.js canvas in as source s0; `dynamic` re-uploads the texture
  // every frame so the live 3D render keeps flowing through.
  synth.s0.init({ src: source, dynamic: true })

  function resize(): void {
    const parent = canvas.parentElement
    if (!parent) return
    const w = parent.clientWidth
    const h = parent.clientHeight
    if (w && h) hydra.setResolution(w, h)
  }
  resize()
  if (canvas.parentElement) new ResizeObserver(resize).observe(canvas.parentElement)

  // The synth function/buffer names (osc, src, modulate, s0, o0, …) become the
  // parameters of the compiled sketch, so a sketch can call them directly even
  // though makeGlobal is false.
  const synthKeys = Object.keys(synth)

  let lastSig: string | null = null

  function run(code: string, vars: Record<string, unknown>): void {
    const varKeys = Object.keys(vars)
    try {
      const fn = new Function(...synthKeys, ...varKeys, code)
      fn(...synthKeys.map((k) => synth[k]), ...varKeys.map((k) => vars[k]))
    } catch (err) {
      console.error('hydra sketch error:', err)
    }
  }

  function setSketch(frame: HydraFrame | null): void {
    const code = frame?.code ?? PASSTHROUGH
    const vars = frame?.vars ?? {}
    const sig = code + '|' + JSON.stringify(vars)
    if (sig === lastSig) return
    lastSig = sig
    run(code, vars)
  }

  // Start in passthrough so the scene is visible the moment hydra comes up.
  setSketch(null)

  return {
    setSketch,
    reset(): void {
      lastSig = null
      setSketch(null)
    },
  }
}
