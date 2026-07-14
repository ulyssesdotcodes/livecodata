// Past-session selector. A dropdown over the persisted session store (see
// sessions.js): each option is a past session labeled by its name (when the
// user has set one — see the ✎ rename control) or its table names, plus the
// time it was last touched. Picking one reopens it; "+ New" starts a fresh
// session. The currently-open session is shown selected — and, if it hasn't
// been persisted yet, as a "current session (new)" placeholder.
//
// A static "Examples" optgroup lists built-in sample programs; selecting one
// calls onExample(index) instead of onOpen. Archived sessions sink into an
// "Archived" optgroup *below* the examples — still openable, just out of the
// everyday list — and the active session can be archived/unarchived with the
// button next to the dropdown.
//
// Split humble-object style: createSessionSelector holds the list/active-id
// state and the open/new/example/rename/archive decisions; <SessionSelector>
// just renders it. `children` is a slot for extra chrome on the same row (the
// room chip).

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
  // Persist a user-facing name / the archived flag for a session. Both act on
  // the stored record only (the open session's log is untouched); the caller
  // re-lists on completion, which is what updates this dropdown.
  onRename?: (id: string, name: string) => void
  onArchive?: (id: string, archived: boolean) => void
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
  // Name / archive the *active* session (no-ops until it has been persisted —
  // the view only offers these once the active id appears in the list).
  rename(name: string): void
  setArchived(archived: boolean): void
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
  const name = s.name.trim()
  const base = name || (s.tables && s.tables.length ? s.tables.join(', ') : '(empty)')
  const when = fmtTime(s.updatedAt)
  return when ? `${base} · ${when}` : base
}

export function createSessionSelector({ onOpen, onNew, onExample, onRename, onArchive, examples = [] }: SessionSelectorOptions = {}): SessionSelectorController {
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
    rename(name: string): void {
      const id = activeId()
      if (id) onRename?.(id, name.trim())
    },
    setArchived(archived: boolean): void {
      const id = activeId()
      if (id) onArchive?.(id, archived)
    },
    setSessions(list: SessionSummary[], id: string | null): void {
      setSessions(list)
      setActiveId(id)
    },
  }
}

export function SessionSelector(props: { ctl: SessionSelectorController; children?: JSX.Element }) {
  const { ctl } = props
  // While renaming, the dropdown swaps for a text input pre-filled with the
  // active session's current name; Enter/blur commits, Escape cancels.
  const [renaming, setRenaming] = createSignal(false)

  const activeSummary = (): SessionSummary | undefined => ctl.sessions().find((s) => s.id === ctl.activeId())
  const liveSessions = (): SessionSummary[] => ctl.sessions().filter((s) => !s.archived)
  const archivedSessions = (): SessionSummary[] => ctl.sessions().filter((s) => s.archived)

  const commitRename = (value: string): void => {
    setRenaming(false)
    ctl.rename(value)
  }

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
      <Show
        when={!renaming()}
        fallback={
          <input
            class="session-name-input"
            value={activeSummary()?.name ?? ''}
            placeholder="session name"
            ref={(el) => queueMicrotask(() => { el.focus(); el.select() })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename(e.currentTarget.value)
              else if (e.key === 'Escape') setRenaming(false)
            }}
            onBlur={(e) => { if (renaming()) commitRename(e.currentTarget.value) }}
          />
        }
      >
        <select class="session-select" onChange={handleChange}>
          <Show when={!ctl.sessions().some((s) => s.id === ctl.activeId())}>
            <option value={ctl.activeId() ?? ''} selected>current session (new)</option>
          </Show>
          <For each={liveSessions()}>
            {(s) => <option value={s.id} selected={s.id === ctl.activeId()}>{labelFor(s)}</option>}
          </For>
          <Show when={ctl.examples.length}>
            <optgroup label="Examples">
              <For each={ctl.examples}>
                {(ex, i) => <option value={EXAMPLE_PREFIX + i()}>{ex.label}</option>}
              </For>
            </optgroup>
          </Show>
          <Show when={archivedSessions().length}>
            <optgroup label="Archived">
              <For each={archivedSessions()}>
                {(s) => <option value={s.id} selected={s.id === ctl.activeId()}>{labelFor(s)}</option>}
              </For>
            </optgroup>
          </Show>
        </select>
      </Show>
      <Show when={activeSummary()}>
        <button class="session-rename" title="rename session" onClick={() => setRenaming(true)}>✎</button>
        <button
          class="session-archive"
          title={activeSummary()?.archived ? 'unarchive session' : 'archive session'}
          onClick={() => { const s = activeSummary(); if (s) ctl.setArchived(!s.archived) }}
        >
          {activeSummary()?.archived ? 'unarchive' : 'archive'}
        </button>
      </Show>
      <button class="session-new" onClick={() => ctl.startNew()}>+ New</button>
      {props.children}
    </div>
  )
}
