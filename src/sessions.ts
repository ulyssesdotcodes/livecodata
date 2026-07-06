// livecodata multi-session store
// ----------------------------------------------------------------------------
// Persists *multiple* authoring sessions to localStorage so past sessions can be
// browsed and reopened from the session selector. A session is the editable-table
// store's serialized event log (see editable-tables.ts) — the program ("code")
// and every other editable table all ride that one log — plus the list of runs
// (Apply bookmarks) the session bar scrubs, each a per-table index into that log.
// Together they are the *entire* durable state; the generated view names are kept
// alongside purely to label the session in the dropdown ("base, sim, events,
// scene · 2026-01-01 12:00"), not to reconstruct anything — that's re-derived by
// re-running "code"'s current program.
// ----------------------------------------------------------------------------

import type { SessionRun } from './editable-tables.js'

const STORAGE_KEY = 'livecodata.sessions'
const STORAGE_VERSION = 1

interface MinimalStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

// A stored session: the whole editable-table store's serialized event log
// (`events`) plus the list of runs (`runs`) — the "latest event table data + a
// list of runs" a session is (see main.ts). `tables` are just view names for
// the dropdown label.
interface SessionRecord {
  id: string
  createdAt: number
  updatedAt: number
  tables: string[]
  events: string
  runs: SessionRun[]
}

export interface SessionSummary {
  id: string
  createdAt: number | null
  updatedAt: number | null
  tables: string[]
}

interface StoredData {
  version: number
  sessions: SessionRecord[]
}

export interface SessionStore {
  newId(): string
  list(): SessionSummary[]
  save(id: string, data: { events: string; tables?: string[]; runs?: SessionRun[] }): SessionRecord
  load(id: string): string | null
  // The saved run list (empty for a legacy session that predates runs).
  runs(id: string): SessionRun[]
  remove(id: string): void
}

export function createSessionStore(storage: MinimalStorage = globalThis.localStorage as MinimalStorage): SessionStore {
  function readAll(): SessionRecord[] {
    try {
      const raw = storage?.getItem(STORAGE_KEY)
      if (!raw) return []
      const data = JSON.parse(raw) as StoredData
      return data && Array.isArray(data.sessions) ? data.sessions : []
    } catch {
      return []
    }
  }

  function writeAll(sessions: SessionRecord[]): void {
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, sessions }))
    } catch { /* quota / no storage */ }
  }

  return {
    newId(): string {
      return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    },

    list(): SessionSummary[] {
      return readAll()
        .map((s, i) => ({
          id: s.id,
          createdAt: s.createdAt ?? null,
          updatedAt: s.updatedAt ?? s.createdAt ?? null,
          tables: Array.isArray(s.tables) ? s.tables : [],
          _pos: i,
        }))
        .sort((a, b) => ((b.updatedAt ?? 0) - (a.updatedAt ?? 0)) || b._pos - a._pos)
        .map(({ _pos: _unused, ...s }) => s)
    },

    save(id: string, { events, tables = [], runs = [] }: { events: string; tables?: string[]; runs?: SessionRun[] }): SessionRecord {
      const sessions = readAll()
      const now = Date.now()
      const idx = sessions.findIndex((s) => s.id === id)
      const createdAt = idx >= 0 ? sessions[idx].createdAt ?? now : now
      const record: SessionRecord = { id, createdAt, updatedAt: now, tables, events, runs }
      if (idx >= 0) sessions[idx] = record
      else sessions.push(record)
      writeAll(sessions)
      return record
    },

    load(id: string): string | null {
      const s = readAll().find((s) => s.id === id)
      return s ? s.events : null
    },

    runs(id: string): SessionRun[] {
      const s = readAll().find((s) => s.id === id)
      return s && Array.isArray(s.runs) ? s.runs : []
    },

    remove(id: string): void {
      writeAll(readAll().filter((s) => s.id !== id))
    },
  }
}
