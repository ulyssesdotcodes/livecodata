// Past-session selector. A dropdown over the persisted session store (see
// sessions.js): each option is a past session labeled by its table names and the
// time it was last touched. Picking one reopens it; "+ New" starts a fresh
// session. The currently-open session is shown selected — and, if it hasn't been
// persisted yet, as a "current session (new)" placeholder.
//
// A static "Examples" optgroup at the bottom lists built-in sample programs;
// selecting one calls onExample(index) instead of onOpen.

import { render } from 'solid-js/web'
import { createSignal, createEffect, For, Show } from 'solid-js'
import type { SessionSummary } from '../sessions.js'

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
  const [sessions, setSessions] = createSignal<SessionSummary[]>([])
  const [activeId, setActiveId] = createSignal<string | null>(null)

  const el = document.createElement('div')
  el.className = 'session-selector'

  render(() => {
    let selectEl: HTMLSelectElement | undefined

    const handleChange = (): void => {
      if (!selectEl) return
      const id = selectEl.value
      if (!id) return
      if (id.startsWith(EXAMPLE_PREFIX)) {
        const idx = parseInt(id.slice(EXAMPLE_PREFIX.length), 10)
        // Reset selection back to the active session so the dropdown doesn't
        // stay on the example.
        if (activeId() != null) selectEl.value = activeId()!
        onExample?.(idx)
        return
      }
      if (id !== activeId()) onOpen?.(id)
    }

    // Reflect the active session in the dropdown — set after the <option>s
    // have rendered (assigning <select>.value before its options exist
    // silently no-ops).
    createEffect(() => {
      const id = activeId()
      sessions()
      if (selectEl && id != null) selectEl.value = id
    })

    return (
      <>
        <span class="session-label">sessions</span>
        <select class="session-select" ref={selectEl} onChange={handleChange}>
          <Show when={!sessions().some((s) => s.id === activeId())}>
            <option value={activeId() ?? ''}>current session (new)</option>
          </Show>
          <For each={sessions()}>
            {(s) => <option value={s.id}>{labelFor(s)}</option>}
          </For>
          <Show when={examples.length}>
            <optgroup label="Examples">
              <For each={examples}>
                {(ex, i) => <option value={EXAMPLE_PREFIX + i()}>{ex.label}</option>}
              </For>
            </optgroup>
          </Show>
        </select>
        <button class="session-new" onClick={() => onNew?.()}>+ New</button>
      </>
    )
  }, el)

  return {
    el,
    setSessions(list: SessionSummary[], id: string | null): void {
      setSessions(list)
      setActiveId(id)
    },
  }
}
