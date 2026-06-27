import { buildFrameIndex, stateAtFrame, type FrameIndex } from './rasterize.js'
import { buildEffectIndex, effectChainAtFrame } from './effects.js'
import { buildTimeline, type Timeline } from './timeline.js'
import { activeLineage } from './lineage.js'
import { FPS } from './constants.js'
import type { Row } from './lineage.js'
import type { SceneAPI } from './three-scene.js'
import type { EffectEntry } from './effects.js'

export interface PlaybackOptions {
  onTick?: (tick: number, active: Map<string, Set<number>>, srcFrame: number) => void
  onPlay?: () => void
}

export interface PlaybackAPI {
  load(sceneRows: Row[], timelineRows: Row[], effectRows: Row[]): void
}

export function initPlayback(
  controlsEl: HTMLElement,
  sceneAPI: SceneAPI,
  { onTick, onPlay }: PlaybackOptions = {},
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
  scrubber.min = '0'
  scrubber.max = '100'
  scrubber.step = String(1 / FPS)
  scrubber.value = '0'

  controlsEl.appendChild(topRow)
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
    const states = stateAtFrame(frameIndex, src)
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
    sceneAPI.setEffects(effectChainAtFrame(effectIndex, src) as EffectEntry[])
    onTick?.(t, activeLineage(states), src)
  }

  function reset(t: number = 0): void {
    sceneAPI.reset()
    aliveObjects = new Set()
    scrubber.value = String(t)
    setFill(t)
    showIndex(t)
    if (frameIndex.map.size) applyAtIndex(t)
  }

  function load(sceneRows: Row[], timelineRows: Row[], effectRows: Row[]): void {
    state = 'idle'
    btn.textContent = '▶  Play'
    startTime = null
    pausedIndex = 0
    frameIndex = buildFrameIndex(sceneRows ?? [])
    effectIndex = buildEffectIndex(effectRows ?? [])
    timeline = buildTimeline(timelineRows ?? [])
    maxIndex = (timeline.length ? timeline.length - 1 : frameIndex.maxFrame) / FPS
    scrubber.max = String(maxIndex || 100)
    reset(0)
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

    const t = position()
    showIndex(t)

    if (!isScrubbing) {
      scrubber.value = String(Math.min(t, maxIndex))
      setFill(Math.min(t, maxIndex))
    }

    applyAtIndex(t)

    if (t >= maxIndex) {
      scrubber.value = String(maxIndex)
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
