// Session bar. A scrubber over the *authoring* log (session time), distinct from
// the frame scrubber under the scene (playback time). Dragging it replays the
// session: the program live at that run is re-cooked and shown. The "latest"
// button jumps back to the newest run.

export function initSessionBar({ onScrub } = {}) {
  const root = document.createElement('div')
  root.className = 'session-bar'

  const label = document.createElement('span')
  label.className = 'session-label'
  label.textContent = 'session'

  const range = document.createElement('input')
  range.type = 'range'
  range.className = 'session-range'
  range.min = '0'
  range.max = '0'
  range.step = '1'
  range.value = '0'

  const live = document.createElement('button')
  live.className = 'session-live'
  live.textContent = '⤓ latest'
  live.style.visibility = 'hidden'

  root.append(label, range, live)

  let count = 0

  function update() {
    const pos = parseInt(range.value, 10)
    const atLatest = pos >= count - 1
    label.textContent = count ? `run ${pos + 1}/${count}` : 'session'
    live.style.visibility = atLatest || count === 0 ? 'hidden' : 'visible'
    root.classList.toggle('replaying', !atLatest && count > 0)
  }

  range.addEventListener('input', () => {
    update()
    onScrub?.(parseInt(range.value, 10))
  })

  live.onclick = () => {
    range.value = String(Math.max(0, count - 1))
    update()
    onScrub?.(Math.max(0, count - 1))
  }

  return {
    el: root,
    // Point the bar at a (possibly grown) log and snap to its latest run.
    setLog(log) {
      count = log.length
      range.max = String(Math.max(0, count - 1))
      range.value = String(Math.max(0, count - 1))
      update()
    },
    // Reflect an externally-chosen position (keeps label/live in sync).
    setPosition(pos) {
      range.value = String(pos)
      update()
    },
  }
}
