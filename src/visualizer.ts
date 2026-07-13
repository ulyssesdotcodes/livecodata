// Visualizer — the one interface between the playback engine and anything
// that renders content.
// ----------------------------------------------------------------------------
// The playback engine (playback.ts) owns time: the beat clock, the loop, the
// timeline remap, scrubbing. What actually shows up on screen is a list of
// Visualizers — today the Three.js scene and the hydra post-processing layer,
// tomorrow whatever else — each of which knows how to (1) pull its rows out of
// a cooked program, (2) index them on the shared frame grid, and (3) reconcile
// its display to a source frame. The engine never learns what a visualizer
// draws; adding a new one is: add its rows to replay.ts's CookedResult,
// implement this interface (usually wrapping a pure index module like
// hydra.ts + a thin GPU/DOM API like hydra-scene.ts — keep that split), and
// register it in main.ts's visualizer list.
//
// Origami note: folding paper renders through the scene visualizer (fold
// programs are scene objects riding SceneAPI) — it is not a separate
// Visualizer, so origami work doesn't touch this seam.

import { buildFrameIndex, sampleFrame } from './rasterize.js'
import { buildHydraIndex, hydraFrameAt, hydraLoops } from './hydra.js'
import { resolveBindings, type EvalCtx } from './dsl.js'
import { FPS } from './constants.js'
import type { Row } from './lineage.js'
import type { SceneAPI } from './three-scene.js'
import type { HydraAPI } from './hydra-scene.js'

// Absolute wall-clock instants (ms) each content kind's multi-loop sequence
// counts passes from — per kind, the `at` stamp of the newest apply that
// changed it (see playback.ts's loopEpochsFromApplies). Shared by every
// replica in a room, which is what puts them all on the same pass.
export interface LoopEpochs {
  scene?: number
  timeline?: number
  hydra?: number
}

// The row sets a cooked program feeds the visualizers — a subset of replay.ts's
// CookedResult (which is structurally assignable), so each visualizer picks its
// own slice and the engine forwards the whole object without knowing the names.
// `loopEpochs` rides along the same way: each visualizer keeps its own kind's
// stamp (the engine keeps the timeline's).
export interface CookedVisualRows {
  sceneRows: Row[]
  hydraRows: Row[]
  loopEpochs?: LoopEpochs
}

export interface VisualizerFrame {
  // Fractional source frame on the shared frame grid (see constants.ts) —
  // fractional because the playhead sweeps continuously between cache frames.
  srcFrameF: number
  // Streaming context at the rounded source frame (midi() bindings resolve
  // against it), or null when no stream is live.
  ctx: EvalCtx | null
  // How many wall-aligned loops have completed since an absolute instant (ms)
  // — supplied by the engine, which owns time. A visualizer whose rows span
  // several passes of the loop (a `loop` column next to `beat`) picks the pass
  // to show as passAt(its loop epoch) modulo its own pass count; the content
  // half (pass count, per-pass span) stays in the visualizer's index.
  passAt: (epochMs: number) => number
}

export interface Visualizer {
  // Swap in freshly cooked rows. Reconciliation state survives on purpose: a
  // re-cook updates what's on screen in place rather than tearing it down.
  load(cooked: CookedVisualRows): void
  // Frames of content that should size the loop. 0 when this visualizer has
  // no say (hydra sketches loop whatever length the user picks).
  contentFrames(): number
  hasContent(): boolean
  // Reconcile the display to this frame. Returns the rows "on screen" there —
  // the engine folds them into the lineage highlight.
  applyFrame(frame: VisualizerFrame): Row[]
  // Drop reconciliation state so the next applyFrame starts from scratch
  // (play pressed from idle). Must NOT blank a display that applyFrame is
  // about to repaint anyway — see blank() for that.
  clear(): void
  // There is nothing to show at all (program cooked to no content): clear
  // and blank the display.
  blank(): void
}

// The Three.js scene: baked scene rows sampled per frame, diffed against the
// set of live objects so playback only creates/destroys what changed.
export function createSceneVisualizer(sceneAPI: SceneAPI): Visualizer {
  let frameIndex = buildFrameIndex([])
  let alive = new Set<unknown>()
  // The shared apply stamp scene pass-counting is based on — 0 (the Unix
  // epoch) until stamped, the same arbitrary-but-shared reference the no-tap
  // phase anchor uses.
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
    // Per-pass span, not the cache's total extent: a multi-loop cache still
    // wraps the playhead every loop, with the pass picked by the loop count
    // (loopFrames == maxFrame when there's no loop column).
    contentFrames: () => frameIndex.loopFrames,
    hasContent: () => frameIndex.map.size > 0,
    applyFrame({ srcFrameF, ctx, passAt }): Row[] {
      // A multi-loop cache is one extended frame grid (loops * loopFrames):
      // offset into the pass the wall-aligned loop count selects, cycling
      // through the sequence. Single-loop caches sample exactly as before.
      const frameF = frameIndex.loops > 1
        ? (passAt(epoch) % frameIndex.loops) * frameIndex.loopFrames + srcFrameF
        : srcFrameF
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
// whole program), so there is no reconciliation state to clear — but blanking
// resets to the passthrough sketch. tick() drives hydra's clock from the
// source position, so pausing/scrubbing the timeline pauses/scrubs the sketch.
export function createHydraVisualizer(hydraAPI: HydraAPI): Visualizer {
  let index: Row[] = buildHydraIndex([])
  let loops = 1
  let epoch = 0

  return {
    load(cooked): void {
      index = buildHydraIndex(cooked.hydraRows ?? [])
      loops = hydraLoops(index)
      if (typeof cooked.loopEpochs?.hydra === 'number') epoch = cooked.loopEpochs.hydra
    },
    contentFrames: () => 0,
    hasContent: () => index.length > 0,
    applyFrame({ srcFrameF, ctx, passAt }): Row[] {
      const pass = loops > 1 ? passAt(epoch) % loops : 0
      const sketch = hydraFrameAt(index, Math.floor(srcFrameF), pass)
      hydraAPI.setSketch(sketch && ctx ? { ...sketch, vars: resolveBindings(sketch.vars, ctx) } : sketch)
      hydraAPI.tick(srcFrameF / FPS)
      return []
    },
    clear(): void {
      // setSketch is absolute — nothing incremental to drop, and resetting
      // here would force a visible sketch recompile on every fresh play.
    },
    blank(): void {
      hydraAPI.reset()
    },
  }
}
