// Visualizer — the one interface between the playback engine (which owns time)
// and anything that renders content. The engine never learns what a visualizer
// draws; adding one is: add its rows to replay.ts's CookedResult, implement
// this interface (usually a pure index module + a thin GPU/DOM API, like
// hydra.ts + hydra-scene.ts — keep that split), register it in main.ts.
// Origami renders through the scene visualizer, not a separate one.

import { buildFrameIndex, sampleFrame } from './rasterize.js'
import { buildHydraIndex, hydraFrameAt } from './hydra.js'
import { buildBaubleIndex, baubleFrameAt } from './bauble.js'
import { resolveBindings, type EvalCtx } from './dsl.js'
import { FPS } from './constants.js'
import type { Row } from './lineage.js'
import type { SceneAPI } from './three-scene.js'
import type { HydraAPI } from './hydra-scene.js'
import type { BaubleAPI } from './bauble-scene.js'

// Wall-clock instants (ms) each kind's multi-loop sequence counts passes from
// — the `at` stamp of the newest apply that changed it. Shared by every
// replica in a room, which is what puts them all on the same pass.
export interface LoopEpochs {
  scene?: number
  timeline?: number
  hydra?: number
  bauble?: number
}

// The row sets a cooked program feeds the visualizers — a structurally
// assignable subset of replay.ts's CookedResult, so the engine forwards the
// whole object without knowing the names.
export interface CookedVisualRows {
  sceneRows: Row[]
  hydraRows: Row[]
  // Optional so pre-bauble callers (and their test fixtures) stay assignable.
  baubleRows?: Row[]
  loopEpochs?: LoopEpochs
}

export interface VisualizerFrame {
  // Fractional source frame — the playhead sweeps continuously between frames.
  srcFrameF: number
  // The loop length in frames — the GUI beat count, supplied by the engine.
  // Content whose beat runs past this span forms later passes of the loop.
  loopFrames: number
  // Streaming context midi() bindings resolve against; null when no stream.
  ctx: EvalCtx | null
  // Wall-aligned loops completed since an absolute instant (ms) — supplied by
  // the engine, which owns time. A multi-pass visualizer shows passAt(its loop
  // epoch) modulo its own pass count.
  passAt: (epochMs: number) => number
}

export interface Visualizer {
  // Swap in freshly cooked rows. Reconciliation state survives on purpose: a
  // re-cook updates what's on screen in place rather than tearing it down.
  load(cooked: CookedVisualRows): void
  hasContent(): boolean
  // Reconcile the display to this frame. Returns the rows "on screen" there —
  // the engine folds them into the lineage highlight.
  applyFrame(frame: VisualizerFrame): Row[]
  // Drop reconciliation state so the next applyFrame starts from scratch.
  // Must NOT blank a display applyFrame is about to repaint — see blank().
  clear(): void
  // Nothing to show at all: clear and blank the display.
  blank(): void
}

// The Three.js scene: baked scene rows sampled per frame, diffed against the
// set of live objects so playback only creates/destroys what changed.
export function createSceneVisualizer(sceneAPI: SceneAPI): Visualizer {
  let frameIndex = buildFrameIndex([])
  let alive = new Set<unknown>()
  // 0 (the Unix epoch) until stamped — the same arbitrary-but-shared reference
  // the no-tap phase anchor uses.
  let epoch = 0

  function clear(): void {
    sceneAPI.reset()
    alive = new Set()
  }

  return {
    load(cooked): void {
      frameIndex = buildFrameIndex(cooked.sceneRows ?? [])
      if (typeof cooked.loopEpochs?.scene === 'number') epoch = cooked.loopEpochs.scene
    },
    hasContent: () => frameIndex.map.size > 0,
    applyFrame({ srcFrameF, loopFrames, ctx, passAt }): Row[] {
      // Same pass rule as hydra/bauble: frames land on the loop, so a last
      // event on beat 21 of a 16-beat loop makes a 32-beat sequence (beat 13,
      // a plain 16-beat one). The clamp holds the final pose through the last
      // pass's tail rather than blanking mid-pass.
      const loops = loopFrames > 0 ? Math.floor(frameIndex.maxFrame / loopFrames) + 1 : 1
      const offset = loops > 1 ? (passAt(epoch) % loops) * loopFrames : 0
      const frameF = Math.min(offset + srcFrameF, frameIndex.maxFrame)
      const baked = sampleFrame(frameIndex, frameF)
      const states = ctx ? baked.map((s) => resolveBindings(s, ctx)) : baked
      const present = new Set<unknown>()
      for (const s of states) {
        present.add(s.id)
        if (!alive.has(s.id)) {
          sceneAPI.createObject(s as Record<string, unknown>)
          alive.add(s.id)
        } else {
          sceneAPI.updateObject(s as Record<string, unknown>)
        }
      }
      for (const id of alive) {
        if (!present.has(id)) {
          sceneAPI.destroyObject(id)
          alive.delete(id)
        }
      }
      return states
    },
    clear,
    blank: clear,
  }
}

// The hydra layer: the sampled sketch is absolute (setSketch replaces the
// whole program), so there is no reconciliation state to clear. tick() drives
// hydra's clock from the source position, so scrubbing scrubs the sketch.
export function createHydraVisualizer(hydraAPI: HydraAPI): Visualizer {
  let index: Row[] = buildHydraIndex([])
  let maxIndex = 0
  let epoch = 0

  return {
    load(cooked): void {
      index = buildHydraIndex(cooked.hydraRows ?? [])
      maxIndex = index.reduce((m, r) => Math.max(m, r.index as number), 0)
      if (typeof cooked.loopEpochs?.hydra === 'number') epoch = cooked.loopEpochs.hydra
    },
    hasContent: () => index.length > 0,
    applyFrame({ srcFrameF, loopFrames, ctx, passAt }): Row[] {
      // floor: an event at exactly beat loopBeats+1 opens a new pass — that's
      // how a later pass is authored. The absolute frame also drives the
      // clock, so transitions animate across passes.
      const loops = loopFrames > 0 ? Math.floor(maxIndex / loopFrames) + 1 : 1
      const frameF = (loops > 1 ? (passAt(epoch) % loops) * loopFrames : 0) + srcFrameF
      const sketch = hydraFrameAt(index, Math.floor(frameF))
      // Resolve midi/slider bindings, then expose every slider's value as
      // `props.sliders` (an explicit user variable named "sliders" still wins).
      if (sketch) {
        const vars = ctx ? resolveBindings(sketch.vars, ctx) : sketch.vars
        const sliders = ctx?.sliders?.()
        hydraAPI.setSketch(sliders ? { ...sketch, vars: { sliders, ...vars } } : (ctx ? { ...sketch, vars } : sketch))
      } else {
        hydraAPI.setSketch(sketch)
      }
      hydraAPI.tick(frameF / FPS)
      return []
    },
    clear(): void {
      // setSketch is absolute — resetting here would force a visible sketch
      // recompile on every fresh play.
    },
    blank(): void {
      hydraAPI.reset()
    },
  }
}

// The bauble layer: like hydra, setSketch is absolute and the same recompile
// economics apply, so clear() must not reset.
export function createBaubleVisualizer(baubleAPI: BaubleAPI): Visualizer {
  let index: Row[] = buildBaubleIndex([])
  let maxIndex = 0
  let epoch = 0

  return {
    load(cooked): void {
      index = buildBaubleIndex(cooked.baubleRows ?? [])
      maxIndex = index.reduce((m, r) => Math.max(m, r.index as number), 0)
      if (typeof cooked.loopEpochs?.bauble === 'number') epoch = cooked.loopEpochs.bauble
    },
    hasContent: () => index.length > 0,
    applyFrame({ srcFrameF, loopFrames, ctx, passAt }): Row[] {
      // Pass derivation mirrors the hydra visualizer's; the absolute frame
      // also drives `t`, keeping (ss t …) transition windows on one clock.
      const loops = loopFrames > 0 ? Math.floor(maxIndex / loopFrames) + 1 : 1
      const frameF = (loops > 1 ? (passAt(epoch) % loops) * loopFrames : 0) + srcFrameF
      const sketch = baubleFrameAt(index, Math.floor(frameF))
      // NB: unlike hydra there is no props escape hatch — a resolved variable
      // bakes into the compiled script, so a binding that sweeps every frame
      // recompiles every frame; bind sweeping inputs to the camera vars.
      baubleAPI.setSketch(sketch && ctx ? { ...sketch, vars: resolveBindings(sketch.vars, ctx) } : sketch)
      baubleAPI.tick(frameF / FPS)
      return []
    },
    clear(): void {
      // setSketch is absolute — see the hydra visualizer's clear().
    },
    blank(): void {
      baubleAPI.reset()
    },
  }
}
