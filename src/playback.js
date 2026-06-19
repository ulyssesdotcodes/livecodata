const FPS = 60 // one row == one frame; playback advances FPS indices per second

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
  for (const evs of map.values()) evs.sort((a, b) => a.index - b.index)
  return map
}

// Sample one object's full state at index i, or null if it doesn't exist yet
// (or has been destroyed). Position/rotation are interpolated between movement
// keyframes; color is a step function (latest color-bearing event <= i).
function sampleObject(events, i) {
  const createEv = events.find(e => e.type === 'create')
  if (!createEv || i < createEv.index) return null
  if (events.some(e => e.type === 'destroy' && e.index <= i)) return null

  const keyframes = events.filter(hasPosition)
  let from = keyframes[0], to = null
  for (const kf of keyframes) {
    if (kf.index <= i) from = kf
    else if (!to)      to   = kf
  }

  let pos, rot
  if (from && to) {
    const f = (i - from.index) / (to.index - from.index)
    pos = { x: lerp(from.px, to.px, f), y: lerp(from.py, to.py, f), z: lerp(from.pz, to.pz, f) }
    rot = { x: lerp(from.rx, to.rx, f), y: lerp(from.ry, to.ry, f), z: lerp(from.rz, to.rz, f) }
  } else if (from) {
    pos = { x: from.px, y: from.py, z: from.pz }
    rot = { x: from.rx, y: from.ry, z: from.rz }
  } else {
    pos = { x: 0, y: 0, z: 0 }
    rot = { x: 0, y: 0, z: 0 }
  }

  // Color: latest event (in index order) carrying a color, up to i.
  let color = null
  for (const e of events) {
    if (e.index <= i && e.color != null) color = e.color
  }

  return { shape: createEv.shape, pos, rot, color }
}

export function initPlayback(controlsEl, sceneAPI, { onTick } = {}) {
  let state = 'idle'
  let startTime = null
  let pausedIndex = 0
  let timelines = new Map()
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
    timeEl.textContent = 'f' + Math.round(i)
  }

  function applyAtIndex(i) {
    for (const [id, events] of timelines) {
      const s = sampleObject(events, i)
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
    onTick?.(i)
  }

  function reset(i = 0) {
    sceneAPI.reset()
    aliveObjects = new Set()
    scrubber.value = i
    setFill(i)
    showIndex(i)
    if (timelines.size) applyAtIndex(i)
  }

  // ── Public: load a fresh events table and rewind ──

  function load(eventRows) {
    state = 'idle'
    btn.textContent = '▶  Play'
    startTime = null
    pausedIndex = 0
    timelines = buildTimelines(eventRows ?? [])
    maxIndex = (eventRows ?? []).reduce((m, e) => Math.max(m, e.index ?? 0), 0)
    scrubber.max = maxIndex || 100
    reset(0)
  }

  // ── Scrubber events ──

  scrubber.addEventListener('input', () => {
    isScrubbing = true
    const i = parseFloat(scrubber.value)
    showIndex(i)
    setFill(i)
    if (timelines.size) applyAtIndex(i)
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
    if (!timelines.size) return
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
