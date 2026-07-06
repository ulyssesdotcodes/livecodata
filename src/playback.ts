import { buildFrameIndex, stateAtFrame, type FrameIndex } from './rasterize.js'
import { buildHydraIndex, hydraFrameAt } from './hydra.js'
import { buildTimeline, type Timeline } from './timeline.js'
import { activeLineage } from './lineage.js'
import { resolveBindings, type EvalCtx } from './dsl.js'
import { FPS } from './constants.js'
import type { Row } from './lineage.js'
import type { SceneAPI } from './three-scene.js'
import type { HydraAPI } from './hydra-scene.js'

export interface TapControl {
  tap(): void
  clear(): void
  rows(): Row[]
  // Wall-clock epoch (ms) of the first tap in the current sequence, once at
  // least two taps have established a tempo — the instant "beat 0" is
  // anchored to (a person tapping a tempo starts on beat 1, so that first tap
  // is the one that actually landed on the grid). Null before that (no tempo
  // yet), in which case phase follows whenever Play was pressed, same as
  // before tap-tempo existed.
  anchor?(): number | null
}

// The tick value "now" should show, if a tap-established tempo is locked to
// the real-world clock: elapsed time since the sequence's first tap, wrapped
// into one loop. Anchoring phase to that instant (rather than to whenever
// Play was pressed) means "beat 0" always falls at the same absolute moment —
// which is what keeps independently-started clients (or repeated Play
// presses) in phase with each other.
export function wallAlignedTick(nowMs: number, anchorMs: number, loopSeconds: number): number {
  if (loopSeconds <= 0) return 0
  let phase = ((nowMs - anchorMs) / 1000) % loopSeconds
  if (phase < 0) phase += loopSeconds
  return phase
}

export interface PlaybackOptions {
  // srcSeconds: the source/content position shown, in seconds (converted from
  // the internal frame count) — the unit graphed tables' `index` columns use.
  onTick?: (tick: number, active: Map<string, Set<number>>, srcSeconds: number) => void
  onPlay?: () => void
  // Called each time the loop wraps (the playhead passes the end and jumps back).
  onLoop?: () => void
  tapControl?: TapControl
  // Streaming context for the frame being shown: resolves midi() bindings against
  // the live MIDI table, sampled at the playhead's *source* frame — the same
  // content-space coordinate events are recorded in (see currentSourceSeconds).
  midiCtxAt?: (srcFrame: number) => EvalCtx
}

export interface PlaybackAPI {
  load(sceneRows: Row[], timelineRows: Row[], hydraRows: Row[]): void
  setTimeline(timelineRows: Row[]): void
  // The content/source position (seconds) currently on screen — playback time
  // mapped through the (loop-wrapped) timeline. Live MIDI events are stamped
  // here, so a recorded sweep's speed follows the timeline mapping: if it
  // changes later (e.g. a slower fit), the sweep speeds up or slows down right
  // along with everything else on screen, rather than staying fixed to
  // wall-clock time.
  currentSourceSeconds(): number
}

export function initPlayback(
  controlsEl: HTMLElement,
  sceneAPI: SceneAPI,
  hydraAPI: HydraAPI,
  { onTick, onPlay, onLoop, tapControl, midiCtxAt }: PlaybackOptions = {},
): PlaybackAPI {
  type PlayState = 'idle' | 'playing' | 'paused'
  let state: PlayState = 'idle'
  let startTime: number | null = null
  let pausedIndex = 0
  let frameIndex: FrameIndex = buildFrameIndex([])
  let hydraIndex: Row[] = buildHydraIndex([])
  let timeline: Timeline = buildTimeline([])
  let aliveObjects = new Set<unknown>()
  let maxIndex = 0
  let isScrubbing = false
  let loop = true // when playback reaches the end, wrap back to the start

  const topRow = document.createElement('div')
  topRow.className = 'playback-row'

  const btn = document.createElement('button')
  btn.id = 'play-pause-btn'
  btn.textContent = '▶  Play'

  const loopBtn = document.createElement('button')
  loopBtn.id = 'loop-btn'
  loopBtn.textContent = '🔁 Loop'
  loopBtn.title = 'Loop playback'
  loopBtn.classList.toggle('active', loop)
  loopBtn.onclick = () => {
    loop = !loop
    loopBtn.classList.toggle('active', loop)
  }

  const timeEl = document.createElement('span')
  timeEl.id = 'playback-time'
  timeEl.textContent = '0.00s'

  topRow.appendChild(btn)
  topRow.appendChild(loopBtn)
  topRow.appendChild(timeEl)

  // Tap-beat row: record wall-time presses and show the tempo derived from them
  // (the same table the DSL's beats()/tempo() read). Only when a controller is given.
  let tapRow: HTMLDivElement | null = null
  if (tapControl) {
    tapRow = document.createElement('div')
    tapRow.className = 'playback-row tap-row'

    const tapBtn = document.createElement('button')
    tapBtn.id = 'tap-beat-btn'
    tapBtn.textContent = '🥁 Tap'
    tapBtn.title = 'Tap a beat to set the tempo (used by beats() timelines)'

    const bpmEl = document.createElement('span')
    bpmEl.id = 'tap-bpm'

    const clearBtn = document.createElement('button')
    clearBtn.id = 'tap-clear-btn'
    clearBtn.textContent = '✕'
    clearBtn.title = 'Clear taps'

    const showTempo = (): void => {
      const rows = tapControl.rows()
      const n = rows.length
      const beat = n > 1 ? (rows[n - 1].time as number) / (n - 1) : null
      bpmEl.textContent = beat ? `${(60 / beat).toFixed(1)} BPM` : 'tap…'
    }

    tapBtn.onclick = () => { tapControl.tap(); showTempo() }
    clearBtn.onclick = () => { tapControl.clear(); showTempo() }
    showTempo()

    tapRow.appendChild(tapBtn)
    tapRow.appendChild(bpmEl)
    tapRow.appendChild(clearBtn)
  }

  const scrubber = document.createElement('input')
  scrubber.type = 'range'
  scrubber.id = 'scrub-bar'
  scrubber.min = '0'
  scrubber.max = '100'
  scrubber.step = String(1 / FPS)
  scrubber.value = '0'

  controlsEl.appendChild(topRow)
  if (tapRow) controlsEl.appendChild(tapRow)
  controlsEl.appendChild(scrubber)

  function setFill(t: number): void {
    const pct = maxIndex > 0 ? Math.min(100, (t / maxIndex) * 100) : 0
    scrubber.style.background =
      `linear-gradient(to right, #e94560 ${pct}%, #1a3a5e ${pct}%)`
  }

  function showIndex(t: number): void {
    const src = timeline.frameAt(Math.floor(t * FPS))
    if (timeline.length) {
      timeEl.textContent = `${t.toFixed(2)}s→${(src / FPS).toFixed(2)}s`
    } else {
      timeEl.textContent = `${t.toFixed(2)}s`
    }
  }

  function applyAtIndex(t: number): void {
    const src = timeline.frameAt(Math.floor(t * FPS))
    // Streaming context for this frame: midi() bindings baked into the scene /
    // effects resolve against the live MIDI table at the *source* frame — the
    // same content-space coordinate the whole baked scene is keyed to (and the
    // domain events are recorded in). That's what makes a recorded sweep track
    // the timeline: if the mapping later changes (e.g. a slower fit), tick sweeps
    // through this shared coordinate at a different rate, so the recorded points
    // are reached sooner/later right along with everything else on screen.
    const ctx = midiCtxAt ? midiCtxAt(src) : null
    const baked = stateAtFrame(frameIndex, src)
    const states = ctx ? baked.map((s) => resolveBindings(s, ctx)) : baked
    const present = new Set<unknown>()
    for (const s of states) {
      present.add(s.id)
      if (!aliveObjects.has(s.id)) {
        sceneAPI.createObject(s as Record<string, unknown>)
        aliveObjects.add(s.id)
      } else {
        sceneAPI.updateObject(s as Record<string, unknown>)
      }
    }
    for (const id of aliveObjects) {
      if (!present.has(id)) {
        sceneAPI.destroyObject(id)
        aliveObjects.delete(id)
      }
    }
    const sketch = hydraFrameAt(hydraIndex, src)
    hydraAPI.setSketch(sketch && ctx ? { ...sketch, vars: resolveBindings(sketch.vars, ctx) } : sketch)
    hydraAPI.tick(src / FPS)
    // Graphed/table views key their rows by `index` in seconds, so report the
    // source position in seconds too (src is an internal frame count).
    onTick?.(t, activeLineage(states), src / FPS)
  }

  // Is there anything to play? A program can define a hydra sketch with no 3D
  // scene at all (see the "Hydra Sketch" sample), so playback isn't gated on
  // frameIndex alone.
  function hasContent(): boolean {
    return frameIndex.map.size > 0 || hydraIndex.length > 0
  }

  function reset(t: number = 0): void {
    sceneAPI.reset()
    aliveObjects = new Set()
    scrubber.value = String(t)
    setFill(t)
    showIndex(t)
    if (hasContent()) applyAtIndex(t)
  }

  // Where the playhead currently sits, in seconds, whatever the play state.
  function currentTime(): number {
    return state === 'playing' ? position() : pausedIndex
  }

  // The wall-clock-aligned tick for right now, or null when there's no tap
  // tempo (or nothing to loop over) to lock to.
  function wallAlignedPhase(): number | null {
    const anchorMs = tapControl?.anchor?.() ?? null
    if (anchorMs == null || maxIndex <= 0) return null
    return wallAlignedTick(Date.now(), anchorMs, maxIndex)
  }

  // The content/source position (seconds) currently on screen — the playhead's
  // tick wrapped by the loop exactly as rendering wraps it (tick()), then mapped
  // through the timeline, exactly as applyAtIndex computes `src`. This is where
  // a live MIDI event gets stamped: recording this shared content coordinate
  // (rather than raw tick/wall-clock time) is what makes a recorded sweep follow
  // the timeline — if the mapping changes later (e.g. a slower fit), tick moves
  // through this same coordinate at a different rate, speeding up or slowing
  // down the recorded sweep right along with everything else on screen.
  function currentSourceSeconds(): number {
    let t = currentTime()
    if (loop && maxIndex > 0 && t >= maxIndex) t %= maxIndex
    return timeline.frameAt(Math.floor(t * FPS)) / FPS
  }

  // Playback length in seconds: follow the timeline when present, else the
  // longer of the scene cache and the hydra sketch's own last keyframe (a
  // hydra-only program has no scene at all to size the loop from).
  function recomputeMax(): void {
    const hydraMaxFrame = hydraIndex.length ? (hydraIndex[hydraIndex.length - 1].index as number) : 0
    const contentMax = Math.max(frameIndex.maxFrame, hydraMaxFrame)
    maxIndex = (timeline.length ? timeline.length - 1 : contentMax) / FPS
    scrubber.max = String(maxIndex || 100)
  }

  // Re-anchor the clock + scrubber to time `t` (clamped) and reconcile the scene
  // there, keeping the current play state. Shared by load() and setTimeline() so a
  // re-cook resumes from where we were rather than rewinding. applyAtIndex diffs
  // the scene, so swapping caches updates objects in place instead of flashing.
  function retimeTo(t: number): void {
    const top = maxIndex || 0
    t = Math.min(Math.max(0, t), top)
    pausedIndex = Math.min(pausedIndex, top)
    if (state === 'playing') startTime = performance.now() - t * 1000
    scrubber.value = String(t)
    setFill(t)
    showIndex(t)
    if (hasContent()) {
      applyAtIndex(t)
    } else {
      sceneAPI.reset()
      hydraAPI.reset()
      aliveObjects = new Set()
    }
  }

  // Swap in a freshly cooked frame cache (+ optional timeline). A re-evaluate
  // does NOT move the playhead: keep the current position and play state, only
  // replacing the baked data. (First load is at 0 because that's where we are.)
  function load(sceneRows: Row[], timelineRows: Row[], hydraRows: Row[]): void {
    frameIndex = buildFrameIndex(sceneRows ?? [])
    hydraIndex = buildHydraIndex(hydraRows ?? [])
    timeline = buildTimeline(timelineRows ?? [])
    recomputeMax()
    retimeTo(currentTime())
  }

  // Swap the timeline (tick → frame remap) in place — used when the tap-beat
  // tempo changes a beats() timeline; retimes the current position without
  // reloading the scene cache, so tapping along while it plays doesn't restart
  // it. While playing, a new tap re-anchors "beat 0" to itself immediately
  // (rather than waiting for the next loop wrap) — each tap you add is
  // supposed to line the beat grid up with itself right away. Only while
  // playing: retimeTo doesn't persist a paused position (see its pausedIndex
  // comment), so snapping while idle would show a phase the next Play press
  // wouldn't actually resume from.
  function setTimeline(timelineRows: Row[]): void {
    timeline = buildTimeline(timelineRows ?? [])
    recomputeMax()
    const aligned = state === 'playing' ? wallAlignedPhase() : null
    retimeTo(aligned ?? currentTime())
  }

  scrubber.addEventListener('input', () => {
    isScrubbing = true
    const t = parseFloat(scrubber.value)
    showIndex(t)
    setFill(t)
    if (hasContent()) applyAtIndex(t)
  })

  window.addEventListener('pointerup', () => {
    if (!isScrubbing) return
    isScrubbing = false
    const t = parseFloat(scrubber.value)
    pausedIndex = t
    if (state === 'playing' && startTime !== null) startTime = performance.now() - t * 1000
  })

  btn.onclick = toggle

  function toggle(): void {
    if (!hasContent()) return
    if (state === 'playing') {
      state = 'paused'
      pausedIndex = position()
      btn.textContent = '▶  Play'
    } else if (state === 'paused') {
      state = 'playing'
      startTime = performance.now() - pausedIndex * 1000
      btn.textContent = '⏸  Pause'
      onPlay?.()
      tick()
    } else {
      startFresh()
    }
  }

  function startFresh(): void {
    // Start already in phase with the tap-established tempo (if any), instead
    // of always at t=0 — so pressing Play doesn't reset "beat 0" to this
    // moment, it joins the beat grid wherever it currently is.
    const aligned = wallAlignedPhase() ?? 0
    reset(aligned)
    pausedIndex = aligned
    startTime = performance.now() - aligned * 1000
    state = 'playing'
    btn.textContent = '⏸  Pause'
    onPlay?.()
    tick()
  }

  function position(): number {
    return (performance.now() - (startTime ?? 0)) / 1000
  }

  function tick(): void {
    if (state !== 'playing') return

    let t = position()

    // Loop: once past the end, wrap back to the start and re-anchor startTime so
    // playback time stays bounded. Skip when there is nothing to loop over.
    // Re-derives the wall-aligned phase (rather than just `t %= maxIndex`) so a
    // tap tempo stays locked to the real-world clock on every wrap — self-
    // correcting any drift between performance.now() and Date.now(), and (the
    // point of it) keeping independently-started clients in phase with each
    // other, not just internally consistent.
    if (loop && maxIndex > 0 && t >= maxIndex) {
      t = wallAlignedPhase() ?? (t % maxIndex)
      startTime = performance.now() - t * 1000
      onLoop?.()
    }

    showIndex(t)

    if (!isScrubbing) {
      scrubber.value = String(Math.min(t, maxIndex))
      setFill(Math.min(t, maxIndex))
    }

    applyAtIndex(t)

    if (!loop && t >= maxIndex) {
      scrubber.value = String(maxIndex)
      setFill(maxIndex)
      showIndex(maxIndex)
      state = 'idle'
      pausedIndex = maxIndex // so a re-cook keeps the playhead at the end
      btn.textContent = '▶  Play'
      return
    }

    requestAnimationFrame(tick)
  }

  return { load, setTimeline, currentSourceSeconds }
}
