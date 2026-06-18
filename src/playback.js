function lerp(a, b, t) { return a + (b - a) * t }

function buildTimelines(events) {
  const map = new Map()
  events.forEach(e => {
    if (!map.has(e.id)) map.set(e.id, [])
    map.get(e.id).push({ ...e })
  })
  for (const evs of map.values()) evs.sort((a, b) => a.time - b.time)
  return map
}

function getObjectState(events, t) {
  if (!events.length || events[0].type !== 'create' || t < events[0].time) return null
  if (events.some(e => e.type === 'destroy' && e.time <= t)) return null

  const keyframes = events.filter(e => e.type !== 'destroy')
  let from = keyframes[0], to = null
  for (const kf of keyframes) {
    if (kf.time <= t) from = kf
    else if (!to)     to   = kf
  }

  if (!to) {
    return {
      pos: { x: from.px, y: from.py, z: from.pz },
      rot: { x: from.rx, y: from.ry, z: from.rz },
    }
  }

  const f = (t - from.time) / (to.time - from.time)
  return {
    pos: { x: lerp(from.px, to.px, f), y: lerp(from.py, to.py, f), z: lerp(from.pz, to.pz, f) },
    rot: { x: lerp(from.rx, to.rx, f), y: lerp(from.ry, to.ry, f), z: lerp(from.rz, to.rz, f) },
  }
}

export function initPlayback(controlsEl, sceneAPI, tablePanel) {
  let state = 'idle'
  let startTime = null
  let pausedElapsed = 0
  let timelines = new Map()
  let aliveObjects = new Set()
  let maxTime = 0
  let isScrubbing = false

  // DOM
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
      const s = getObjectState(events, t)
      if (s && !aliveObjects.has(id)) {
        const createEv = events.find(e => e.type === 'create')
        sceneAPI.createObject(id, createEv.shape, s.pos, s.rot)
        aliveObjects.add(id)
      } else if (!s && aliveObjects.has(id)) {
        sceneAPI.destroyObject(id)
        aliveObjects.delete(id)
      } else if (s) {
        sceneAPI.updateObject(id, s.pos, s.rot)
      }
    }

    const allEvents = tablePanel.getEvents()
    let lastIdx = -1, lastTime = -1
    allEvents.forEach((e, i) => {
      if (e.time <= t && e.time > lastTime) { lastTime = e.time; lastIdx = i }
    })
    if (lastIdx !== -1) tablePanel.highlightRow(lastIdx)
    else tablePanel.clearHighlights()
  }

  function initTimelines() {
    const events = tablePanel.getEvents()
    if (!events.length) return false
    timelines = buildTimelines(events)
    maxTime = Math.max(...events.map(e => e.time))
    scrubber.max = maxTime
    return true
  }

  // ── Scrubber events ──

  scrubber.addEventListener('pointerdown', () => {
    isScrubbing = true
    if (!timelines.size) {
      if (initTimelines()) {
        sceneAPI.reset()
        aliveObjects = new Set()
      }
    }
  })

  scrubber.addEventListener('input', () => {
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
    if (!initTimelines()) return
    sceneAPI.reset()
    tablePanel.clearHighlights()
    aliveObjects = new Set()
    scrubber.value = 0
    setFill(0)
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
}
