// Past-session selector. A dropdown over the persisted session store (see
// sessions.js): each option is a past session labeled by its table names and the
// time it was last touched. Picking one reopens it; "+ New" starts a fresh
// session. The currently-open session is shown selected — and, if it hasn't been
// persisted yet, as a "current session (new)" placeholder.

function fmtTime(ms) {
  if (!ms) return ''
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function labelFor(s) {
  const tables = s.tables && s.tables.length ? s.tables.join(', ') : '(empty)'
  const when = fmtTime(s.updatedAt)
  return when ? `${tables} · ${when}` : tables
}

export function initSessionSelector({ onOpen, onNew } = {}) {
  const root = document.createElement('div')
  root.className = 'session-selector'

  const label = document.createElement('span')
  label.className = 'session-label'
  label.textContent = 'sessions'

  const select = document.createElement('select')
  select.className = 'session-select'

  const newBtn = document.createElement('button')
  newBtn.className = 'session-new'
  newBtn.textContent = '+ New'

  root.append(label, select, newBtn)

  let currentId = null

  select.addEventListener('change', () => {
    const id = select.value
    if (id && id !== currentId) onOpen?.(id)
  })

  newBtn.onclick = () => onNew?.()

  return {
    el: root,
    // Rebuild the dropdown from session summaries and select `activeId`.
    setSessions(sessions, activeId) {
      currentId = activeId
      select.innerHTML = ''
      // A brand-new session isn't in the store until the user authors something;
      // surface it as a placeholder so the dropdown still reflects where you are.
      if (!sessions.some((s) => s.id === activeId)) {
        const opt = document.createElement('option')
        opt.value = activeId ?? ''
        opt.textContent = 'current session (new)'
        select.appendChild(opt)
      }
      sessions.forEach((s) => {
        const opt = document.createElement('option')
        opt.value = s.id
        opt.textContent = labelFor(s)
        select.appendChild(opt)
      })
      if (activeId != null) select.value = activeId
    },
  }
}
