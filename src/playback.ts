import { buildFrameIndex, stateAtFrame, type FrameIndex } from './rasterize.js'
import { buildEffectIndex, effectChainAtFrame } from './effects.js'
import { buildTimeline, type Timeline } from './timeline.js'
import { activeLineage } from './lineage.js'
import { resolveBindings, type EvalCtx } from './dsl.js'
import { FPS } from './constants.js'
import type { Row } from './lineage.js'
import type { SceneAPI } from './three-scene.js'
import type { EffectEntry } from './effects.js'

export interface TapControl {
  tap(): void
  clear(): void
  rows(): Row[]
}

export interface PlaybackOptions {
  onTick?: (tick: number, active: Map<string, Set<number>>, srcFrame: number) => void
  onPlay?: () => void
  tapControl?: TapControl
  // Streaming context for the frame being shown: resolves midi() bindings against
  // the live MIDI table sampled at the playhead's source frame.
  midiCtxAt?: (srcFrame: number) => EvalCtx
}

export interface PlaybackAPI {
  load(sceneRows: Row[], timelineRows: Row[], effectRows: Row[]): void
  setTimeline(timelineRows: Row[]): void
  // The source position (seconds) currently shown — where live MIDI events get
  // stamped so they pin to this loop position.
  currentSourceSeconds(): number
}

export function initPlayback(
  controlsEl: HTMLElement,
  sceneAPI: SceneAPI,
  { onTick, onPlay, tapControl, midiCtxAt }: PlaybackOptions = {},
): PlaybackAPI {
  type PlayState = 'idle' | 'playing' | 'paused'
  let state: PlayState = 'idle'
  let startTime: number | null = null
  let pausedIndex = 0
  let frameIndex: FrameIndex = buildFrameIndex([])
  let effectIndex: Map<unknown, Row[]> = buildEffectIndex([])
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
    // effects resolve here against the live MIDI table at the source frame.
    const ctx = midiCtxAt ? midiCtxAt(src) : null
    const baked = stateAtFrame(frameIndex, src)
    const states = ctx ? baked.map((s) => resolveBindings(s, ctx)) : baked
    const present = new Set<unknown>()
    for (const s of states) {
      present.add(s.id)
      const pos = { x: s.px as number, y: s.py as number, z: s.pz as number }
      const rot = { x: s.rx as number, y: s.ry as number, z: s.rz as number }
      if (!aliveObjects.has(s.id)) {
        sceneAPI.createObject(s.id, s.shape, pos, rot, s.color as number | null)
        aliveObjects.add(s.id)
      } else {
        sceneAPI.updateObject(s.id, pos, rot)
        sceneAPI.setColor(s.id, s.color as number | null)
      }
    }
    for (const id of aliveObjects) {
      if (!present.has(id)) {
        sceneAPI.destroyObject(id)
        aliveObjects.delete(id)
      }
    }
    let chain = effectChainAtFrame(effectIndex, src) as EffectEntry[]
    if (ctx) chain = chain.map((e) => ({ ...e, params: resolveBindings(e.params as Row, ctx) }))
    sceneAPI.setEffects(chain)
    onTick?.(t, activeLineage(baked), src)
  }

  function reset(t: number = 0): void {
    sceneAPI.reset()
    aliveObjects = new Set()
    scrubber.value = String(t)
    setFill(t)
    showIndex(t)
    if (frameIndex.map.size) applyAtIndex(t)
  }

  // Where the playhead currently sits, in seconds, whatever the play state.
  function currentTime(): number {
    return state === 'playing' ? position() : pausedIndex
  }

  // The *source* position (seconds) currently shown — playback time mapped
  // through the timeline. This is where a live MIDI event gets stamped, so a note
  // played while looping pins to the loop position it was heard at.
  function currentSourceSeconds(): number {
    return timeline.frameAt(Math.floor(currentTime() * FPS)) / FPS
  }

  // Playback length in seconds: follow the timeline when present, else the cache.
  function recomputeMax(): void {
    maxIndex = (timeline.length ? timeline.length - 1 : frameIndex.maxFrame) / FPS
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
    if (frameIndex.map.size) {
      applyAtIndex(t)
    } else {
      sceneAPI.reset()
      aliveObjects = new Set()
    }
  }

  // Swap in a freshly cooked frame cache (+ optional timeline). A re-evaluate
  // does NOT move the playhead: keep the current position and play state, only
  // replacing the baked data. (First load is at 0 because that's where we are.)
  function load(sceneRows: Row[], timelineRows: Row[], effectRows: Row[]): void {
    frameIndex = buildFrameIndex(sceneRows ?? [])
    effectIndex = buildEffectIndex(effectRows ?? [])
    timeline = buildTimeline(timelineRows ?? [])
    recomputeMax()
    retimeTo(currentTime())
  }

  // Swap the timeline (tick → frame remap) in place — used when the tap-beat
  // tempo changes a beats() timeline; retimes the current position without
  // reloading the scene cache, so tapping along while it plays doesn't restart it.
  function setTimeline(timelineRows: Row[]): void {
    timeline = buildTimeline(timelineRows ?? [])
    recomputeMax()
    retimeTo(currentTime())
  }

  scrubber.addEventListener('input', () => {
    isScrubbing = true
    const t = parseFloat(scrubber.value)
    showIndex(t)
    setFill(t)
    if (frameIndex.map.size) applyAtIndex(t)
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
    if (!frameIndex.map.size) return
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
    reset(0)
    pausedIndex = 0
    startTime = performance.now()
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
    if (loop && maxIndex > 0 && t >= maxIndex) {
      t %= maxIndex
      startTime = performance.now() - t * 1000
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
