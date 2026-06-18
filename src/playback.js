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

// Returns interpolated { pos, rot } for an object at time t, or null if not alive.
function getObjectState(events, t) {
  if (!events.length || events[0].type !== 'create' || t < events[0].time) return null

  // If a destroy event has passed, object is gone
  if (events.some(e => e.type === 'destroy' && e.time <= t)) return null

  // Only create/update events act as position keyframes
  const keyframes = events.filter(e => e.type !== 'destroy')

  let from = keyframes[0]
  let to = null
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

  const btn = document.createElement('button')
  btn.id = 'play-pause-btn'
  btn.textContent = '▶  Play'

  const timeEl = document.createElement('span')
  timeEl.id = 'playback-time'
  timeEl.textContent = '0.0s'

  controlsEl.appendChild(btn)
  controlsEl.appendChild(timeEl)

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
    const events = tablePanel.getEvents()
    if (!events.length) return

    sceneAPI.reset()
    tablePanel.clearHighlights()
    aliveObjects = new Set()
    timelines = buildTimelines(events)
    maxTime = Math.max(...events.map(e => e.time))
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

    // Highlight the most recently passed event row
    const allEvents = tablePanel.getEvents()
    let lastIdx = -1, lastTime = -1
    allEvents.forEach((e, i) => {
      if (e.time <= t && e.time > lastTime) { lastTime = e.time; lastIdx = i }
    })
    if (lastIdx !== -1) tablePanel.highlightRow(lastIdx)

    if (t >= maxTime) {
      state = 'idle'
      btn.textContent = '▶  Play'
      return
    }

    requestAnimationFrame(tick)
  }
}
