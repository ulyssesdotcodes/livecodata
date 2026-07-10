// Past-session selector. A dropdown over the persisted session store (see
// sessions.js): each option is a past session labeled by its table names and the
// time it was last touched. Picking one reopens it; "+ New" starts a fresh
// session. The currently-open session is shown selected — and, if it hasn't been
// persisted yet, as a "current session (new)" placeholder.
//
// A static "Examples" optgroup at the bottom lists built-in sample programs;
// selecting one calls onExample(index) instead of onOpen.
//
// Split humble-object style: createSessionSelector holds the list/active-id
// state and the open/new/example decisions; <SessionSelector> just renders it.
// `children` is a slot for extra chrome on the same row (the room chip).

import { createSignal, For, Show, type Accessor, type JSX } from 'solid-js'
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

export interface SessionSelectorController {
  sessions: Accessor<SessionSummary[]>
  activeId: Accessor<string | null>
  examples: ExampleEntry[]
  // Reopen a past session (a no-op when it's already the active one).
  open(id: string): void
  startNew(): void
  openExample(index: number): void
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

export function createSessionSelector({ onOpen, onNew, onExample, examples = [] }: SessionSelectorOptions = {}): SessionSelectorController {
  const [sessions, setSessions] = createSignal<SessionSummary[]>([])
  const [activeId, setActiveId] = createSignal<string | null>(null)

  return {
    sessions,
    activeId,
    examples,
    open(id: string): void {
      if (id !== activeId()) onOpen?.(id)
    },
    startNew(): void {
      onNew?.()
    },
    openExample(index: number): void {
      onExample?.(index)
    },
    setSessions(list: SessionSummary[], id: string | null): void {
      setSessions(list)
      setActiveId(id)
    },
  }
}

export function SessionSelector(props: { ctl: SessionSelectorController; children?: JSX.Element }) {
  const { ctl } = props

  const handleChange = (e: Event & { currentTarget: HTMLSelectElement }): void => {
    const id = e.currentTarget.value
    if (!id) return
    if (id.startsWith(EXAMPLE_PREFIX)) {
      const idx = parseInt(id.slice(EXAMPLE_PREFIX.length), 10)
      // Snap the dropdown back to the active session: picking an example
      // isn't a selection change, and nothing reactive moves (activeId is
      // untouched), so the <select>'s transient state needs resetting here.
      if (ctl.activeId() != null) e.currentTarget.value = ctl.activeId()!
      ctl.openExample(idx)
      return
    }
    ctl.open(id)
  }

  return (
    <div class="session-selector">
      <span class="session-label">sessions</span>
      <select class="session-select" onChange={handleChange}>
        <Show when={!ctl.sessions().some((s) => s.id === ctl.activeId())}>
          <option value={ctl.activeId() ?? ''} selected>current session (new)</option>
        </Show>
        <For each={ctl.sessions()}>
          {(s) => <option value={s.id} selected={s.id === ctl.activeId()}>{labelFor(s)}</option>}
        </For>
        <Show when={ctl.examples.length}>
          <optgroup label="Examples">
            <For each={ctl.examples}>
              {(ex, i) => <option value={EXAMPLE_PREFIX + i()}>{ex.label}</option>}
            </For>
          </optgroup>
        </Show>
      </select>
      <button class="session-new" onClick={() => ctl.startNew()}>+ New</button>
      {props.children}
    </div>
  )
}
