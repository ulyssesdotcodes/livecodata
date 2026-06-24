// livecodata multi-session store
// ----------------------------------------------------------------------------
// Persists *multiple* authoring sessions to localStorage so past sessions can be
// browsed and reopened from the session selector. Each record wraps a serialized
// session log (see log.js — its serialize()/load() is the source of truth for a
// single session's events) alongside the metadata the selector labels it with:
// the table/view names produced by the session's latest run, plus timestamps.
//
// This is distinct from log.js's own single-session persistence (the legacy
// "livecodata.session" key): the store keys past sessions by id so the default
// session can always start fresh while older work stays reachable.
//
// Storage shape (key "livecodata.sessions"):
//   { version, sessions: [ { id, createdAt, updatedAt, tables, log } ] }
//     id     — opaque session id (also the selector's option value)
//     tables — view names from the latest run, used to label the option
//     log    — the string returned by log.serialize()
// ----------------------------------------------------------------------------

const STORAGE_KEY = 'livecodata.sessions'
const STORAGE_VERSION = 1

export function createSessionStore(storage = globalThis.localStorage) {
  // Read the whole collection. Tolerant of junk: a corrupt/absent store reads as
  // an empty list rather than throwing, so it can't brick startup.
  function readAll() {
    try {
      const raw = storage?.getItem(STORAGE_KEY)
      if (!raw) return []
      const data = JSON.parse(raw)
      return data && Array.isArray(data.sessions) ? data.sessions : []
    } catch {
      return []
    }
  }

  function writeAll(sessions) {
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, sessions }))
    } catch { /* quota / no storage */ }
  }

  return {
    // A fresh, unique session id.
    newId() {
      return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    },

    // Session summaries (without the log payload), newest activity first — what
    // the selector renders.
    list() {
      return readAll()
        .map((s, i) => ({
          id: s.id,
          createdAt: s.createdAt ?? null,
          updatedAt: s.updatedAt ?? s.createdAt ?? null,
          tables: Array.isArray(s.tables) ? s.tables : [],
          _pos: i, // storage order; later = more recently appended/updated
        }))
        // Newest activity first. Ties on updatedAt (same-ms saves) fall back to
        // storage position so ordering stays deterministic.
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || b._pos - a._pos)
        .map(({ _pos, ...s }) => s)
    },

    // Insert or replace a session record. `serialized` is log.serialize()'s
    // output; `tables` labels it. createdAt is preserved across updates.
    save(id, { serialized, tables = [] }) {
      const sessions = readAll()
      const now = Date.now()
      const idx = sessions.findIndex((s) => s.id === id)
      const createdAt = idx >= 0 ? sessions[idx].createdAt ?? now : now
      const record = { id, createdAt, updatedAt: now, tables, log: serialized }
      if (idx >= 0) sessions[idx] = record
      else sessions.push(record)
      writeAll(sessions)
      return record
    },

    // The serialized log for a session id, or null if unknown.
    load(id) {
      const s = readAll().find((s) => s.id === id)
      return s ? s.log : null
    },

    remove(id) {
      writeAll(readAll().filter((s) => s.id !== id))
    },
  }
}
