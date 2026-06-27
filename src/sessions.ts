// livecodata multi-session store
// ----------------------------------------------------------------------------
// Persists *multiple* authoring sessions to localStorage so past sessions can be
// browsed and reopened from the session selector.
// ----------------------------------------------------------------------------

const STORAGE_KEY = 'livecodata.sessions'
const STORAGE_VERSION = 1

interface MinimalStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

interface SessionRecord {
  id: string
  createdAt: number
  updatedAt: number
  tables: string[]
  log: string
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
  save(id: string, data: { serialized: string; tables?: string[] }): SessionRecord
  load(id: string): string | null
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

    save(id: string, { serialized, tables = [] }: { serialized: string; tables?: string[] }): SessionRecord {
      const sessions = readAll()
      const now = Date.now()
      const idx = sessions.findIndex((s) => s.id === id)
      const createdAt = idx >= 0 ? sessions[idx].createdAt ?? now : now
      const record: SessionRecord = { id, createdAt, updatedAt: now, tables, log: serialized }
      if (idx >= 0) sessions[idx] = record
      else sessions.push(record)
      writeAll(sessions)
      return record
    },

    load(id: string): string | null {
      const s = readAll().find((s) => s.id === id)
      return s ? s.log : null
    },

    remove(id: string): void {
      writeAll(readAll().filter((s) => s.id !== id))
    },
  }
}
