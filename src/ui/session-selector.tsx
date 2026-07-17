// Past-session selector: a dropdown over the persisted session store —
// picking a session reopens it, "+ New" starts fresh, a static "Examples"
// optgroup loads built-in programs, and archived sessions sink into an
// "Archived" optgroup below. The controller holds list/active-id state and
// the decisions; <SessionSelector> renders it. `children` is a slot for
// extra chrome on the same row (the room chip).

import { createSignal, For, Show, type Accessor, type JSX } from 'solid-js'
import type { SessionSummary } from '../sessions.js'
import { Icon } from './icon.js'

export interface ExampleEntry {
  label: string
}

const EXAMPLE_PREFIX = '__example__:'

interface SessionSelectorOptions {
  onOpen?: (id: string) => void
  onNew?: () => void
  onExample?: (index: number) => void
  // Rename/archive act on the stored record only; the caller re-lists on
  // completion, which is what updates this dropdown.
  onRename?: (id: string, name: string) => void
  onArchive?: (id: string, archived: boolean) => void
  examples?: ExampleEntry[]
}

export interface SessionSelectorController {
  sessions: Accessor<SessionSummary[]>
  activeId: Accessor<string | null>
  examples: ExampleEntry[]
  open(id: string): void
  startNew(): void
  openExample(index: number): void
  // Rename/archive act on the *active* session; no-ops until it's persisted.
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
      // moves nothing reactive, so the <select> needs resetting by hand.
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
        <button class="session-rename" title="rename session" aria-label="rename session" onClick={() => setRenaming(true)}>
          <Icon name="edit-2" />
        </button>
        <button
          class="session-archive"
          title={activeSummary()?.archived ? 'unarchive session' : 'archive session'}
          aria-label={activeSummary()?.archived ? 'unarchive session' : 'archive session'}
          onClick={() => { const s = activeSummary(); if (s) ctl.setArchived(!s.archived) }}
        >
          <Icon name={activeSummary()?.archived ? 'inbox' : 'archive'} />
        </button>
      </Show>
      <button class="session-new" title="new session" aria-label="new session" onClick={() => ctl.startNew()}>
        <Icon name="plus" />
      </button>
      {props.children}
    </div>
  )
}
