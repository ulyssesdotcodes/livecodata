function lerp(a, b, t) { return a + (b - a) * t }

// An event carries position data (and is a movement keyframe) when it has
// numeric px. create/update events do; color/destroy events don't.
function hasPosition(e) { return typeof e.px === 'number' }

function buildTimelines(events) {
  const map = new Map()
  events.forEach(e => {
    if (e.id == null) return
    if (!map.has(e.id)) map.set(e.id, [])
    map.get(e.id).push({ ...e })
  })
  for (const evs of map.values()) evs.sort((a, b) => a.time - b.time)
  return map
}

// Sample one object's full state at time t, or null if it doesn't exist yet
// (or has been destroyed). Position/rotation are interpolated between movement
// keyframes; color is a step function (latest color-bearing event <= t).
function sampleObject(events, t) {
  const createEv = events.find(e => e.type === 'create')
  if (!createEv || t < createEv.time) return null
  if (events.some(e => e.type === 'destroy' && e.time <= t)) return null

  const keyframes = events.filter(hasPosition)
  let from = keyframes[0], to = null
  for (const kf of keyframes) {
    if (kf.time <= t) from = kf
    else if (!to)     to   = kf
  }

  let pos, rot
  if (from && to) {
    const f = (t - from.time) / (to.time - from.time)
    pos = { x: lerp(from.px, to.px, f), y: lerp(from.py, to.py, f), z: lerp(from.pz, to.pz, f) }
    rot = { x: lerp(from.rx, to.rx, f), y: lerp(from.ry, to.ry, f), z: lerp(from.rz, to.rz, f) }
  } else if (from) {
    pos = { x: from.px, y: from.py, z: from.pz }
    rot = { x: from.rx, y: from.ry, z: from.rz }
  } else {
    pos = { x: 0, y: 0, z: 0 }
    rot = { x: 0, y: 0, z: 0 }
  }

  // Color: latest event (in time order) carrying a color, up to t.
  let color = null
  for (const e of events) {
    if (e.time <= t && e.color != null) color = e.color
  }

  return { shape: createEv.shape, pos, rot, color }
}

export function initPlayback(controlsEl, sceneAPI, { onTick } = {}) {
  let state = 'idle'
  let startTime = null
  let pausedElapsed = 0
  let timelines = new Map()
  let aliveObjects = new Set()
  let maxTime = 0
  let isScrubbing = false

  // ── DOM ──
  const topRow = document.createElement('div')
  topRow.className = 'playback-row'

  const btn = document.createElement('button')
  btn.id = 'play-pause-btn'
  btn.textContent = '▶  Play'

  const timeEl = document.createElement('span')
  timeEl.id = 'playback-time'
  timeEl.textContent = '0.0s'

  topRow.appendChild(btn)
  topRow.appendChild(timeEl)

  const scrubber = document.createElement('input')
  scrubber.type = 'range'
  scrubber.id = 'scrub-bar'
  scrubber.min = 0
  scrubber.max = 10
  scrubber.step = 0.01
  scrubber.value = 0

  controlsEl.appendChild(topRow)
  controlsEl.appendChild(scrubber)

  // ── Helpers ──

  function setFill(t) {
    const pct = maxTime > 0 ? Math.min(100, (t / maxTime) * 100) : 0
    scrubber.style.background =
      `linear-gradient(to right, #e94560 ${pct}%, #1a3a5e ${pct}%)`
  }

  function applyAtTime(t) {
    for (const [id, events] of timelines) {
      const s = sampleObject(events, t)
      if (s && !aliveObjects.has(id)) {
        sceneAPI.createObject(id, s.shape, s.pos, s.rot, s.color)
        aliveObjects.add(id)
      } else if (!s && aliveObjects.has(id)) {
        sceneAPI.destroyObject(id)
        aliveObjects.delete(id)
      } else if (s) {
        sceneAPI.updateObject(id, s.pos, s.rot)
        sceneAPI.setColor(id, s.color)
      }
    }
    onTick?.(t)
  }

  function reset(t = 0) {
    sceneAPI.reset()
    aliveObjects = new Set()
    scrubber.value = t
    setFill(t)
    timeEl.textContent = t.toFixed(1) + 's'
    if (timelines.size) applyAtTime(t)
  }

  // ── Public: load a fresh events table and rewind ──

  function load(eventRows) {
    state = 'idle'
    btn.textContent = '▶  Play'
    startTime = null
    pausedElapsed = 0
    timelines = buildTimelines(eventRows ?? [])
    maxTime = (eventRows ?? []).reduce((m, e) => Math.max(m, e.time ?? 0), 0)
    scrubber.max = maxTime || 10
    reset(0)
  }

  // ── Scrubber events ──

  scrubber.addEventListener('input', () => {
    isScrubbing = true
    const t = parseFloat(scrubber.value)
    timeEl.textContent = t.toFixed(1) + 's'
    setFill(t)
    if (timelines.size) applyAtTime(t)
  })

  window.addEventListener('pointerup', () => {
    if (!isScrubbing) return
    isScrubbing = false
    const t = parseFloat(scrubber.value)
    pausedElapsed = t
    if (state === 'playing') startTime = performance.now() - t * 1000
  })

  // ── Play / pause ──

  btn.onclick = toggle

  function toggle() {
    if (!timelines.size) return
    if (state === 'playing') {
      state = 'paused'
      pausedElapsed = elapsed()
      btn.textContent = '▶  Play'
    } else if (state === 'paused') {
      state = 'playing'
      startTime = performance.now() - pausedElapsed * 1000
      btn.textContent = '⏸  Pause'
      tick()
    } else {
      startFresh()
    }
  }

  function startFresh() {
    reset(0)
    pausedElapsed = 0
    startTime = performance.now()
    state = 'playing'
    btn.textContent = '⏸  Pause'
    tick()
  }

  function elapsed() {
    return (performance.now() - startTime) / 1000
  }

  function tick() {
    if (state !== 'playing') return

    const t = elapsed()
    timeEl.textContent = t.toFixed(1) + 's'

    if (!isScrubbing) {
      scrubber.value = Math.min(t, maxTime)
      setFill(Math.min(t, maxTime))
    }

    applyAtTime(t)

    if (t >= maxTime) {
      scrubber.value = maxTime
      setFill(maxTime)
      state = 'idle'
      btn.textContent = '▶  Play'
      return
    }

    requestAnimationFrame(tick)
  }

  return { load }
}
