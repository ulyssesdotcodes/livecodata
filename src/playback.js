export function initPlayback(controlsEl, sceneAPI, tablePanel) {
  let state = 'idle'   // 'idle' | 'playing' | 'paused'
  let startTime = null
  let pausedElapsed = 0
  let appliedSet = new Set()
  let sortedEvents = []
  // Maps sortedEvents index → original table row index for highlighting
  let sortedToOriginal = []

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
    const rawEvents = tablePanel.getEvents()
    if (rawEvents.length === 0) return

    sceneAPI.reset()
    tablePanel.clearHighlights()

    // Sort by time, remembering original row index
    const indexed = rawEvents.map((e, i) => ({ ...e, _orig: i }))
    indexed.sort((a, b) => a.time - b.time)
    sortedEvents = indexed
    sortedToOriginal = indexed.map(e => e._orig)

    appliedSet = new Set()
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

    sortedEvents.forEach((event, idx) => {
      if (!appliedSet.has(idx) && t >= event.time) {
        appliedSet.add(idx)
        applyEvent(event)
        tablePanel.highlightRow(sortedToOriginal[idx])
      }
    })

    if (appliedSet.size >= sortedEvents.length) {
      state = 'idle'
      pausedElapsed = 0
      btn.textContent = '▶  Play'
      return
    }

    requestAnimationFrame(tick)
  }

  function applyEvent(event) {
    const pos = { x: event.px, y: event.py, z: event.pz }
    const rot = { x: event.rx, y: event.ry, z: event.rz }

    if (event.type === 'create')  sceneAPI.createObject(event.id, event.shape, pos, rot)
    if (event.type === 'update')  sceneAPI.updateObject(event.id, pos, rot)
    if (event.type === 'destroy') sceneAPI.destroyObject(event.id)
  }
}
