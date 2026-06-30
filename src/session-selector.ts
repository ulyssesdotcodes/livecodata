// Past-session selector. A dropdown over the persisted session store (see
// sessions.js): each option is a past session labeled by its table names and the
// time it was last touched. Picking one reopens it; "+ New" starts a fresh
// session. The currently-open session is shown selected — and, if it hasn't been
// persisted yet, as a "current session (new)" placeholder.
//
// A static "Examples" optgroup at the bottom lists built-in sample programs;
// selecting one calls onExample(index) instead of onOpen.

import type { SessionSummary } from './sessions.js'

export interface ExampleEntry {
  label: string
}

const EXAMPLE_PREFIX = '__example__:'

interface SessionSelectorOptions {
  onOpen?: (id: string) => void
  onNew?: () => void
  onExample?: (index: number) => void
  examples?: ExampleEntry[]
}

export interface SessionSelectorAPI {
  el: HTMLElement
  setSessions(sessions: SessionSummary[], activeId: string | null): void
}

function fmtTime(ms: number | null | undefined): string {
  if (!ms) return ''
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function labelFor(s: SessionSummary): string {
  const tables = s.tables && s.tables.length ? s.tables.join(', ') : '(empty)'
  const when = fmtTime(s.updatedAt)
  return when ? `${tables} · ${when}` : tables
}

export function initSessionSelector({ onOpen, onNew, onExample, examples = [] }: SessionSelectorOptions = {}): SessionSelectorAPI {
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

  let currentId: string | null = null

  select.addEventListener('change', () => {
    const id = select.value
    if (!id) return
    if (id.startsWith(EXAMPLE_PREFIX)) {
      const idx = parseInt(id.slice(EXAMPLE_PREFIX.length), 10)
      // Reset selection back to active session so the dropdown doesn't stay on the example.
      if (currentId != null) select.value = currentId
      onExample?.(idx)
      return
    }
    if (id !== currentId) onOpen?.(id)
  })

  newBtn.onclick = () => onNew?.()

  // Build the static examples optgroup once (labels don't change at runtime).
  let examplesGroup: HTMLOptGroupElement | null = null
  if (examples.length) {
    examplesGroup = document.createElement('optgroup')
    examplesGroup.label = 'Examples'
    examples.forEach((ex, i) => {
      const opt = document.createElement('option')
      opt.value = EXAMPLE_PREFIX + i
      opt.textContent = ex.label
      examplesGroup!.appendChild(opt)
    })
  }

  return {
    el: root,
    setSessions(sessions: SessionSummary[], activeId: string | null): void {
      currentId = activeId
      select.innerHTML = ''
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
      if (examplesGroup) select.appendChild(examplesGroup)
      if (activeId != null) select.value = activeId
    },
  }
}
