import { buildFrameIndex, stateAtFrame } from './rasterize.js'
import { buildTimeline } from './timeline.js'
import { activeLineage } from './lineage.js'

const FPS = 60 // one row == one frame; playback advances FPS indices per second

export function initPlayback(controlsEl, sceneAPI, { onTick } = {}) {
  let state = 'idle'
  let startTime = null
  let pausedIndex = 0
  let frameIndex = buildFrameIndex([])
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
  timeEl.textContent = 'f0'

  topRow.appendChild(btn)
  topRow.appendChild(timeEl)

  const scrubber = document.createElement('input')
  scrubber.type = 'range'
  scrubber.id = 'scrub-bar'
  scrubber.min = 0
  scrubber.max = 100
  scrubber.step = 1
  scrubber.value = 0

  controlsEl.appendChild(topRow)
  controlsEl.appendChild(scrubber)

  // ── Helpers ──

  function setFill(i) {
    const pct = maxIndex > 0 ? Math.min(100, (i / maxIndex) * 100) : 0
    scrubber.style.background =
      `linear-gradient(to right, #e94560 ${pct}%, #1a3a5e ${pct}%)`
  }

  function showIndex(i) {
    const src = timeline.frameAt(i)
    // Show tick→source frame when the timeline remaps time, else just the frame.
    timeEl.textContent = timeline.length ? `f${Math.round(i)}→f${src}` : 'f' + Math.round(i)
  }

  // Drive the scene from the dense cache at the tick's *source* frame (mapped
  // through the timeline): every object present is created/updated, anything
  // alive but absent is destroyed.
  function applyAtIndex(i) {
    const src = timeline.frameAt(i)
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
    // Report both the playback tick and the *source* frame it maps to (they
    // differ when a timeline retimes/reverses), plus the provenance of the
    // on-screen state — so panel cursors track the source frame, not the tick.
    onTick?.(i, activeLineage(states), src)
  }

  function reset(i = 0) {
    sceneAPI.reset()
    aliveObjects = new Set()
    scrubber.value = i
    setFill(i)
    showIndex(i)
    if (frameIndex.map.size) applyAtIndex(i)
  }

  // ── Public: load a fresh dense frame cache (+ optional timeline) and rewind ──

  function load(sceneRows, timelineRows) {
    state = 'idle'
    btn.textContent = '▶  Play'
    startTime = null
    pausedIndex = 0
    frameIndex = buildFrameIndex(sceneRows ?? [])
    timeline = buildTimeline(timelineRows ?? [])
    // Playback length follows the timeline when present, else the cache.
    maxIndex = timeline.length ? timeline.length - 1 : frameIndex.maxFrame
    scrubber.max = maxIndex || 100
    reset(0)
  }

  // ── Scrubber events ──

  scrubber.addEventListener('input', () => {
    isScrubbing = true
    const i = parseFloat(scrubber.value)
    showIndex(i)
    setFill(i)
    if (frameIndex.map.size) applyAtIndex(i)
  })

  window.addEventListener('pointerup', () => {
    if (!isScrubbing) return
    isScrubbing = false
    const i = parseFloat(scrubber.value)
    pausedIndex = i
    if (state === 'playing') startTime = performance.now() - (i / FPS) * 1000
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
      startTime = performance.now() - (pausedIndex / FPS) * 1000
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
    return ((performance.now() - startTime) / 1000) * FPS
  }

  function tick() {
    if (state !== 'playing') return

    const i = position()
    showIndex(i)

    if (!isScrubbing) {
      scrubber.value = Math.min(i, maxIndex)
      setFill(Math.min(i, maxIndex))
    }

    applyAtIndex(i)

    if (i >= maxIndex) {
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
