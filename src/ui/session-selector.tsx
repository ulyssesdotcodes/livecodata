// Past-session selector. A dropdown over the persisted session store (see
// sessions.js): each option is a past session labeled by its table names and the
// time it was last touched. Picking one reopens it; "+ New" starts a fresh
// session. The currently-open session is shown selected — and, if it hasn't been
// persisted yet, as a "current session (new)" placeholder.
//
// A static "Examples" optgroup at the bottom lists built-in sample programs;
// selecting one calls onExample(index) instead of onOpen.

import { createSignal, For, Show } from 'solid-js'
import { mountComponent } from './dom.js'
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
  // Extra element rendered after the "+ New" button — main.ts slots the room
  // chip here (it belongs to the multiplayer subsystem, not the selector).
  trailing?: HTMLElement
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

export function initSessionSelector({ onOpen, onNew, onExample, examples = [], trailing }: SessionSelectorOptions = {}): SessionSelectorAPI {
  const [sessions, setSessions] = createSignal<SessionSummary[]>([])
  const [activeId, setActiveId] = createSignal<string | null>(null)

  const { el } = mountComponent(() => {
    const handleChange = (e: Event & { currentTarget: HTMLSelectElement }): void => {
      const id = e.currentTarget.value
      if (!id) return
      if (id.startsWith(EXAMPLE_PREFIX)) {
        const idx = parseInt(id.slice(EXAMPLE_PREFIX.length), 10)
        // Snap the dropdown back to the active session: picking an example
        // isn't a selection change, and nothing reactive moves (activeId is
        // untouched), so the <select>'s transient state needs resetting here.
        if (activeId() != null) e.currentTarget.value = activeId()!
        onExample?.(idx)
        return
      }
      if (id !== activeId()) onOpen?.(id)
    }

    return (
      <div class="session-selector">
        <span class="session-label">sessions</span>
        <select class="session-select" onChange={handleChange}>
          <Show when={!sessions().some((s) => s.id === activeId())}>
            <option value={activeId() ?? ''} selected>current session (new)</option>
          </Show>
          <For each={sessions()}>
            {(s) => <option value={s.id} selected={s.id === activeId()}>{labelFor(s)}</option>}
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
        {trailing}
      </div>
    )
  })

  return {
    el,
    setSessions(list: SessionSummary[], id: string | null): void {
      setSessions(list)
      setActiveId(id)
    },
  }
}
