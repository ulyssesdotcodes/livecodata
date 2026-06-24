import { buildFrameIndex, stateAtFrame } from './rasterize.js'
import { buildEffectIndex, effectChainAtFrame } from './effects.js'
import { buildTimeline } from './timeline.js'
import { activeLineage } from './lineage.js'
import { FPS } from './constants.js' // used to convert seconds ↔ frame indices

export function initPlayback(controlsEl, sceneAPI, { onTick } = {}) {
  let state = 'idle'
  let startTime = null
  let pausedIndex = 0
  let frameIndex = buildFrameIndex([])
  let effectIndex = buildEffectIndex([])
  let timeline = buildTimeline([])
  let aliveObjects = new Set()
  let maxIndex = 0
  let isScrubbing = false

  // ── DOM ──
  const topRow = document.createElement('div')
  topRow.className = 'playback-row'

  const btn = document.createElement('button')
  btn.id = 'play-pause-btn'
  btn.textContent = '▶  Play'

  const timeEl = document.createElement('span')
  timeEl.id = 'playback-time'
  timeEl.textContent = '0.00s'

  topRow.appendChild(btn)
  topRow.appendChild(timeEl)

  const scrubber = document.createElement('input')
  scrubber.type = 'range'
  scrubber.id = 'scrub-bar'
  scrubber.min = 0
  scrubber.max = 100
  scrubber.step = 1 / FPS
  scrubber.value = 0

  controlsEl.appendChild(topRow)
  controlsEl.appendChild(scrubber)

  // ── Helpers ──

  function setFill(t) {
    const pct = maxIndex > 0 ? Math.min(100, (t / maxIndex) * 100) : 0
    scrubber.style.background =
      `linear-gradient(to right, #e94560 ${pct}%, #1a3a5e ${pct}%)`
  }

  function showIndex(t) {
    const src = timeline.frameAt(Math.floor(t * FPS))
    // Show tick→source when the timeline remaps time, else just seconds.
    if (timeline.length) {
      timeEl.textContent = `${t.toFixed(2)}s→${(src / FPS).toFixed(2)}s`
    } else {
      timeEl.textContent = `${t.toFixed(2)}s`
    }
  }

  // Drive the scene from the dense cache at the tick's *source* frame (mapped
  // through the timeline): every object present is created/updated, anything
  // alive but absent is destroyed. `t` is playback time in seconds.
  function applyAtIndex(t) {
    const src = timeline.frameAt(Math.floor(t * FPS))
    const states = stateAtFrame(frameIndex, src)
    const present = new Set()
    for (const s of states) {
      present.add(s.id)
      const pos = { x: s.px, y: s.py, z: s.pz }
      const rot = { x: s.rx, y: s.ry, z: s.rz }
      if (!aliveObjects.has(s.id)) {
        sceneAPI.createObject(s.id, s.shape, pos, rot, s.color)
        aliveObjects.add(s.id)
      } else {
        sceneAPI.updateObject(s.id, pos, rot)
        sceneAPI.setColor(s.id, s.color)
      }
    }
    for (const id of aliveObjects) {
      if (!present.has(id)) {
        sceneAPI.destroyObject(id)
        aliveObjects.delete(id)
      }
    }
    // Resolve the post-processing chain active at the source frame and reconcile
    // it onto the renderer's composer (no-op when there are no effect events).
    sceneAPI.setEffects(effectChainAtFrame(effectIndex, src))
    // Report both the playback time (seconds) and the *source* frame it maps to
    // (they differ when a timeline retimes/reverses), plus the provenance of the
    // on-screen state — so panel cursors track the source frame, not the tick.
    onTick?.(t, activeLineage(states), src)
  }

  function reset(t = 0) {
    sceneAPI.reset()
    aliveObjects = new Set()
    scrubber.value = t
    setFill(t)
    showIndex(t)
    if (frameIndex.map.size) applyAtIndex(t)
  }

  // ── Public: load a fresh dense frame cache (+ optional timeline) and rewind ──

  function load(sceneRows, timelineRows, effectRows) {
    state = 'idle'
    btn.textContent = '▶  Play'
    startTime = null
    pausedIndex = 0
    frameIndex = buildFrameIndex(sceneRows ?? [])
    effectIndex = buildEffectIndex(effectRows ?? [])
    timeline = buildTimeline(timelineRows ?? [])
    // Playback length in seconds: follow the timeline when present, else the cache.
    maxIndex = (timeline.length ? timeline.length - 1 : frameIndex.maxFrame) / FPS
    scrubber.max = maxIndex || 100
    reset(0)
  }

  // ── Scrubber events ──

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
    if (state === 'playing') startTime = performance.now() - t * 1000
  })

  // ── Play / pause ──

  btn.onclick = toggle

  function toggle() {
    if (!frameIndex.map.size) return
    if (state === 'playing') {
      state = 'paused'
      pausedIndex = position()
      btn.textContent = '▶  Play'
    } else if (state === 'paused') {
      state = 'playing'
      startTime = performance.now() - pausedIndex * 1000
      btn.textContent = '⏸  Pause'
      tick()
    } else {
      startFresh()
    }
  }

  function startFresh() {
    reset(0)
    pausedIndex = 0
    startTime = performance.now()
    state = 'playing'
    btn.textContent = '⏸  Pause'
    tick()
  }

  function position() {
    return (performance.now() - startTime) / 1000
  }

  function tick() {
    if (state !== 'playing') return

    const t = position()
    showIndex(t)

    if (!isScrubbing) {
      scrubber.value = Math.min(t, maxIndex)
      setFill(Math.min(t, maxIndex))
    }

    applyAtIndex(t)

    if (t >= maxIndex) {
      scrubber.value = maxIndex
      setFill(maxIndex)
      showIndex(maxIndex)
      state = 'idle'
      btn.textContent = '▶  Play'
      return
    }

    requestAnimationFrame(tick)
  }

  return { load }
}
