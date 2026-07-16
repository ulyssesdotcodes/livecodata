// livecodata multi-session store
// ----------------------------------------------------------------------------
// Persists *multiple* authoring sessions so past sessions can be browsed and
// reopened from the session selector. A session is the editable-table store's
// serialized event log (see editable-tables.ts) — the program ("code") and
// every other editable table all ride that one log — plus the list of runs
// (Apply bookmarks) the session bar scrubs, each a per-table index into that
// log. Together they are the *entire* durable state; the generated view names
// are kept alongside purely to label the session in the dropdown, and users
// can also give a session an explicit name and archive it (archived sessions
// sink below the examples in the selector, out of the everyday list).
//
// The primary backend is IndexedDB: one record per session id, so a save
// writes only that session (localStorage previously held every session in a
// single JSON blob, rewritten wholesale on each save — which both hit the
// ~5MB quota as logs grew and made every session's data hostage to one key).
// Existing localStorage data is migrated into IndexedDB once, on first open.
// A storage-backed fallback (createSessionStore) remains for tests and for
// environments without IndexedDB; both backends share the same async API.
// ----------------------------------------------------------------------------

import type { SessionRun } from './editable-tables.js'
import { defaultStorage, type MinimalStorage } from './storage.js'

const STORAGE_KEY = 'livecodata.sessions'
const STORAGE_VERSION = 1

const DB_NAME = 'livecodata'
const DB_VERSION = 1
const DB_STORE = 'sessions'

// A stored session: the whole editable-table store's serialized event log
// (`events`) plus the list of runs (`runs`) — the "latest event table data + a
// list of runs" a session is (see main.ts). `tables` are just view names for
// the dropdown label; `name` is the user's own label (empty until they set
// one) and `archived` moves it under the examples in the selector.
export interface SessionRecord {
  id: string
  createdAt: number
  updatedAt: number
  name: string
  archived: boolean
  tables: string[]
  events: string
  runs: SessionRun[]
  // The branch head (apply id) the session was on when last saved — local
  // working state like `runs`, so a reload reopens on the same branch rather
  // than snapping to the newest. Null/absent for a legacy or single-branch
  // session (the store re-derives the newest apply as head on load).
  head: string | null
  // The table tab shown when the session was last saved — like `head`, purely
  // local working state, so resuming reopens on the table the user was looking
  // at rather than the default. Null/absent for a legacy session (the panel
  // falls back to its default tab).
  table: string | null
}

export interface SessionSummary {
  id: string
  createdAt: number | null
  updatedAt: number | null
  name: string
  archived: boolean
  tables: string[]
}

export interface SessionSaveData {
  events: string
  tables?: string[]
  runs?: SessionRun[]
  head?: string | null
  table?: string | null
}

export interface SessionStore {
  newId(): string
  list(): Promise<SessionSummary[]>
  // Upsert the session's data. Preserves createdAt/name/archived across
  // updates — saving is orthogonal to naming/archiving.
  save(id: string, data: SessionSaveData): Promise<SessionRecord>
  load(id: string): Promise<string | null>
  // The saved run list (empty for a legacy session that predates runs).
  runs(id: string): Promise<SessionRun[]>
  // The saved branch head (null for a legacy/single-branch session).
  head(id: string): Promise<string | null>
  // The saved shown-table tab (null for a legacy session that predates it).
  table(id: string): Promise<string | null>
  // Set the user-facing name. A no-op for an id that was never saved.
  rename(id: string, name: string): Promise<void>
  // Archive/unarchive. A no-op for an id that was never saved.
  setArchived(id: string, archived: boolean): Promise<void>
  remove(id: string): Promise<void>
}

function newSessionId(): string {
  return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

// A record as loaded from storage may predate `name`/`archived` (or come from
// the pre-IndexedDB blob) — normalize so every consumer sees the full shape.
function normalizeRecord(s: Partial<SessionRecord> & { id: string }): SessionRecord {
  return {
    id: s.id,
    createdAt: s.createdAt ?? Date.now(),
    updatedAt: s.updatedAt ?? s.createdAt ?? Date.now(),
    name: typeof s.name === 'string' ? s.name : '',
    archived: s.archived === true,
    tables: Array.isArray(s.tables) ? s.tables : [],
    events: typeof s.events === 'string' ? s.events : '',
    runs: Array.isArray(s.runs) ? s.runs : [],
    head: typeof s.head === 'string' ? s.head : null,
    table: typeof s.table === 'string' ? s.table : null,
  }
}

// The upsert both backends share: fresh data fields, identity/label fields
// carried over from the existing record when there is one.
function upsertRecord(existing: SessionRecord | null, id: string, { events, tables = [], runs = [], head = null, table = null }: SessionSaveData): SessionRecord {
  const now = Date.now()
  return {
    id,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    name: existing?.name ?? '',
    archived: existing?.archived ?? false,
    tables,
    events,
    runs,
    head,
    table,
  }
}

function toSummary(s: SessionRecord): SessionSummary {
  return {
    id: s.id,
    createdAt: s.createdAt ?? null,
    updatedAt: s.updatedAt ?? s.createdAt ?? null,
    name: s.name,
    archived: s.archived,
    tables: s.tables,
  }
}

// Newest-updated first; a positional index breaks timestamp ties stably.
function sortedSummaries(records: SessionRecord[]): SessionSummary[] {
  return records
    .map((s, i) => ({ s: toSummary(s), i }))
    .sort((a, b) => ((b.s.updatedAt ?? 0) - (a.s.updatedAt ?? 0)) || b.i - a.i)
    .map(({ s }) => s)
}

// ── Storage-blob backend ─────────────────────────────────────────────────────
// The original single-key localStorage layout, kept as the fallback for tests
// and for environments without IndexedDB. Same async surface as the IndexedDB
// store so callers never branch.

interface StoredData {
  version: number
  sessions: SessionRecord[]
}

// Parse the single-key blob into records — shared with the one-time IndexedDB
// migration below.
function parseStoredSessions(raw: string | null): SessionRecord[] {
  try {
    if (!raw) return []
    const data = JSON.parse(raw) as StoredData
    if (!data || !Array.isArray(data.sessions)) return []
    return data.sessions
      .filter((s): s is SessionRecord => !!s && typeof (s as { id?: unknown }).id === 'string')
      .map(normalizeRecord)
  } catch {
    return []
  }
}

export function createSessionStore(storage: MinimalStorage = defaultStorage()): SessionStore {
  function readAll(): SessionRecord[] {
    try {
      return parseStoredSessions(storage?.getItem(STORAGE_KEY) ?? null)
    } catch {
      return []
    }
  }

  // Unlike the old fire-and-forget writeAll, a failed write (quota, no
  // storage) REJECTS — silent save failures are exactly how session data got
  // lost before, so the caller must get to surface them.
  function writeAll(sessions: SessionRecord[]): void {
    storage.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, sessions }))
  }

  function update(id: string, change: (s: SessionRecord) => SessionRecord): void {
    const sessions = readAll()
    const idx = sessions.findIndex((s) => s.id === id)
    if (idx < 0) return
    sessions[idx] = change(sessions[idx])
    writeAll(sessions)
  }

  return {
    newId: newSessionId,

    list: async () => sortedSummaries(readAll()),

    async save(id: string, data: SessionSaveData): Promise<SessionRecord> {
      const sessions = readAll()
      const idx = sessions.findIndex((s) => s.id === id)
      const record = upsertRecord(idx >= 0 ? sessions[idx] : null, id, data)
      if (idx >= 0) sessions[idx] = record
      else sessions.push(record)
      writeAll(sessions)
      return record
    },

    async load(id: string): Promise<string | null> {
      const s = readAll().find((s) => s.id === id)
      return s ? s.events : null
    },

    async runs(id: string): Promise<SessionRun[]> {
      const s = readAll().find((s) => s.id === id)
      return s ? s.runs : []
    },

    async head(id: string): Promise<string | null> {
      const s = readAll().find((s) => s.id === id)
      return s ? s.head : null
    },

    async table(id: string): Promise<string | null> {
      const s = readAll().find((s) => s.id === id)
      return s ? s.table : null
    },

    async rename(id: string, name: string): Promise<void> {
      update(id, (s) => ({ ...s, name }))
    },

    async setArchived(id: string, archived: boolean): Promise<void> {
      update(id, (s) => ({ ...s, archived }))
    },

    async remove(id: string): Promise<void> {
      writeAll(readAll().filter((s) => s.id !== id))
    },
  }
}

// ── IndexedDB backend ────────────────────────────────────────────────────────

function idbRequest<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error ?? new Error('indexedDB request failed'))
  })
}

// One-time import of the legacy single-key localStorage blob. Records whose id
// already exists in the db are left alone (add() fails per-record without
// aborting the transaction); the blob is removed only after the transaction
// commits, so an interrupted migration just retries next open.
function migrateFromStorage(db: IDBDatabase, storage: MinimalStorage | undefined): Promise<void> {
  let raw: string | null = null
  try {
    raw = storage?.getItem(STORAGE_KEY) ?? null
  } catch {
    return Promise.resolve()
  }
  // A corrupt blob parses to no records: nothing migrates and — importantly —
  // nothing is deleted, so possibly-recoverable data is never thrown away.
  const legacy = parseStoredSessions(raw)
  if (!legacy.length) return Promise.resolve()
  return new Promise((resolve) => {
    const tx = db.transaction(DB_STORE, 'readwrite')
    const store = tx.objectStore(DB_STORE)
    for (const record of legacy) {
      const req = store.add(record)
      req.onerror = (e) => {
        // Already migrated (or otherwise unwritable) — keep the rest going.
        e.preventDefault()
        e.stopPropagation()
      }
    }
    tx.oncomplete = () => {
      try {
        storage?.removeItem?.(STORAGE_KEY)
      } catch { /* the copy staying behind is harmless — ids dedupe next open */ }
      resolve()
    }
    // A failed migration must not block the store: the blob stays in
    // localStorage and the next open retries.
    tx.onerror = () => resolve()
    tx.onabort = () => resolve()
  })
}

export function createIdbSessionStore(storage: MinimalStorage | undefined = defaultStorage()): SessionStore {
  let dbPromise: Promise<IDBDatabase> | null = null

  function open(): Promise<IDBDatabase> {
    dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(DB_STORE)) {
          req.result.createObjectStore(DB_STORE, { keyPath: 'id' })
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'))
    }).then(async (db) => {
      await migrateFromStorage(db, storage)
      return db
    })
    return dbPromise
  }

  async function get(db: IDBDatabase, id: string): Promise<SessionRecord | null> {
    const s = await idbRequest<(Partial<SessionRecord> & { id: string }) | undefined>(
      db.transaction(DB_STORE).objectStore(DB_STORE).get(id),
    )
    return s ? normalizeRecord(s) : null
  }

  async function put(db: IDBDatabase, record: SessionRecord): Promise<void> {
    await idbRequest(db.transaction(DB_STORE, 'readwrite').objectStore(DB_STORE).put(record))
  }

  async function update(id: string, change: (s: SessionRecord) => SessionRecord): Promise<void> {
    const db = await open()
    const existing = await get(db, id)
    if (!existing) return
    await put(db, change(existing))
  }

  return {
    newId: newSessionId,

    async list(): Promise<SessionSummary[]> {
      const db = await open()
      const all = await idbRequest<(Partial<SessionRecord> & { id: string })[]>(
        db.transaction(DB_STORE).objectStore(DB_STORE).getAll(),
      )
      return sortedSummaries(all.map(normalizeRecord))
    },

    async save(id: string, data: SessionSaveData): Promise<SessionRecord> {
      const db = await open()
      const record = upsertRecord(await get(db, id), id, data)
      await put(db, record)
      return record
    },

    async load(id: string): Promise<string | null> {
      const db = await open()
      return (await get(db, id))?.events ?? null
    },

    async runs(id: string): Promise<SessionRun[]> {
      const db = await open()
      return (await get(db, id))?.runs ?? []
    },

    async head(id: string): Promise<string | null> {
      const db = await open()
      return (await get(db, id))?.head ?? null
    },

    async table(id: string): Promise<string | null> {
      const db = await open()
      return (await get(db, id))?.table ?? null
    },

    async rename(id: string, name: string): Promise<void> {
      await update(id, (s) => ({ ...s, name }))
    },

    async setArchived(id: string, archived: boolean): Promise<void> {
      await update(id, (s) => ({ ...s, archived }))
    },

    async remove(id: string): Promise<void> {
      const db = await open()
      await idbRequest(db.transaction(DB_STORE, 'readwrite').objectStore(DB_STORE).delete(id))
    },
  }
}

// The store the app uses: IndexedDB wherever it exists (all modern browsers),
// the storage-blob fallback otherwise (tests, unusual embedders).
export function defaultSessionStore(): SessionStore {
  return typeof indexedDB !== 'undefined' ? createIdbSessionStore() : createSessionStore()
}
