// livecodata hydra-scene — the hydra-ts GPU layer
// ----------------------------------------------------------------------------
// Wraps a hydra-ts instance whose source s0 is the Three.js scene canvas and
// whose output o0 is the visible canvas. The rendered 3D scene therefore becomes
// just another texture for hydra to post-process. setSketch() takes a sampled
// HydraFrame (see hydra.ts) and evaluates its code with the synth functions in
// scope; the row's variables are exposed to the sketch through hydra-ts's
// `props` callback, NOT baked into the compiled code, so a variable can change
// every frame without recompiling the sketch (recompiling a hydra program
// rebuilds its shaders and restarts any feedback/phase state, which is visible
// as a stutter). Write a variable-driven parameter as a function, e.g.
// `osc((props) => props.speed, 0.1)` — hydra-ts calls it fresh every frame with
// the current props, matching HydraFrame.vars.
//
// tick() is not self-driven: unlike hydra-synth, hydra-ts does not start its own
// render loop (its Loop class is only started if you call .start()), so the
// playback clock is the only thing advancing hydra's time — pausing/scrubbing
// the timeline pauses/scrubs the sketch right along with the 3D scene, instead
// of hydra free-running on its own wall clock in the background.
// ----------------------------------------------------------------------------

import { Hydra } from 'hydra-ts'
import createREGL from 'regl'
import type { HydraFrame } from './hydra.js'

export interface HydraAPI {
  setSketch(frame: HydraFrame | null): void
  // Advance hydra's clock to match the playback timeline's current source
  // position (seconds) and render one frame there.
  tick(timeSeconds: number): void
  reset(): void
}

// Shown when the program defines no hydra view, or before its first code row:
// pass the rendered Three.js scene straight through to the output untouched.
const PASSTHROUGH = 'src(s0).out(o0)'

export function initHydra(canvas: HTMLCanvasElement, source: HTMLCanvasElement): HydraAPI {
  const width = canvas.width || 1280
  const height = canvas.height || 720
  const regl = createREGL({ canvas, pixelRatio: 1 })

  // The current sketch's variables (see hydra.ts's HydraFrame.vars), read fresh
  // by hydra-ts on every draw call — this is what lets a variable's value
  // change every frame without recompiling: `props` is invoked live, not
  // captured at compile time. hydra-ts merges this object with its own
  // per-frame fields (time, bpm, fps, resolution, speed, stats) LAST, so a
  // sketch variable sharing one of those names is always shadowed — it will
  // read hydra's own value instead of the table's.
  let currentVars: Record<string, unknown> = {}

  const hydra = new Hydra({ regl, width, height, props: () => currentVars })

  // Wire the Three.js canvas in as source s0; `dynamic` re-uploads the texture
  // every frame so the live 3D render keeps flowing through.
  hydra.sources[0].init({ src: source, dynamic: true })

  // The compiled sketch's scope: hydra's own generator functions (osc, src,
  // modulate, …, bound so `.out()` defaults to o0) plus each source/output by
  // name (s0, s1, …, o0, o1, …), exactly like a hydra-synth sketch's globals.
  const scope: Record<string, unknown> = { ...hydra.generators }
  hydra.sources.forEach((s, i) => { scope['s' + i] = s })
  hydra.outputs.forEach((o, i) => { scope['o' + i] = o })
  const scopeKeys = Object.keys(scope)
  const scopeValues = scopeKeys.map((k) => scope[k])

  function resize(): void {
    const parent = canvas.parentElement
    if (!parent) return
    const w = parent.clientWidth
    const h = parent.clientHeight
    if (w && h) {
      // Unlike hydra-synth, hydra-ts's setResolution only resizes its internal
      // FBOs — it doesn't own the canvas, so the actual drawing-buffer size is
      // ours to set (and regl needs an explicit nudge to notice it changed).
      canvas.width = w
      canvas.height = h
      regl._refresh()
      hydra.setResolution(w, h)
      hydra.tick(0) // redraw at the new resolution even while paused
    }
  }
  resize()
  if (canvas.parentElement) new ResizeObserver(resize).observe(canvas.parentElement)

  let lastCode: string | null = null

  function compile(code: string): void {
    try {
      const fn = new Function(...scopeKeys, code)
      fn(...scopeValues)
    } catch (err) {
      console.error('hydra sketch error:', err)
    }
  }

  function setSketch(frame: HydraFrame | null): void {
    const code = frame?.code ?? PASSTHROUGH
    currentVars = frame?.vars ?? {}
    if (code === lastCode) return
    lastCode = code
    compile(code)
  }

  let lastTimeSeconds = 0

  function tick(timeSeconds: number): void {
    hydra.tick((timeSeconds - lastTimeSeconds) * 1000)
    lastTimeSeconds = timeSeconds
  }

  // Start in passthrough so the scene is visible the moment hydra comes up.
  setSketch(null)
  tick(0)

  return {
    setSketch,
    tick,
    reset(): void {
      lastCode = null
      lastTimeSeconds = 0
      setSketch(null)
      tick(0)
    },
  }
}
