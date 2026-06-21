// livecodata session log
// ----------------------------------------------------------------------------
// An append-only log of *authoring* events — the source of truth for a session.
// Every time the user runs code we capture a snapshot of the whole program, so
// the entire session can later be replayed from the beginning. The log is
// persisted to localStorage, so it survives a page reload, and can be exported
// to / imported from a plain JSON document (a portable session artifact).
//
// For now there is one event kind, "run":
//   { seq, t, kind: "run", code, seed }
//     seq  — monotonic logical clock (0, 1, 2, …)
//     t    — wall-clock ms since the session started
//     code — the full program text of that run (a per-run snapshot)
//     seed — RNG seed captured at run time, so a run can be reproduced exactly
//            (deterministic replay is wired up once the engine seeds Math.random)
// ----------------------------------------------------------------------------

const STORAGE_KEY = 'livecodata.session'
const STORAGE_VERSION = 1

// A fresh, unsigned 32-bit seed. Captured per run and stored on the event so
// the run is reproducible regardless of the live Math.random() state.
export function randomSeed() {
  return (Math.random() * 0x100000000) >>> 0
}

export function createLog() {
  let entries = []
  let seq = 0
  let sessionStart = null

  // Append a new authoring event and return it. The first append anchors the
  // session's wall clock, so every event's `t` is relative to that moment.
  function append({ kind = 'run', code, seed }) {
    if (sessionStart == null) sessionStart = Date.now()
    const event = { seq: seq++, t: Date.now() - sessionStart, kind, code, seed }
    entries.push(event)
    return event
  }

  function all() { return entries.slice() }

  function last() { return entries.length ? entries[entries.length - 1] : null }

  // The latest event whose seq is <= position. This is the basis of session
  // scrubbing: "what program was live at logical time `pos`?"
  function entryAt(pos) {
    let found = null
    for (const e of entries) {
      if (e.seq <= pos) found = e
      else break
    }
    return found
  }

  // ── Serialization / persistence ──

  function serialize() {
    return JSON.stringify({ version: STORAGE_VERSION, sessionStart, entries })
  }

  // Load a serialized session, replacing the current one. Tolerant of junk:
  // returns false rather than throwing so a corrupt store can't brick startup.
  function load(json) {
    try {
      const data = typeof json === 'string' ? JSON.parse(json) : json
      if (!data || !Array.isArray(data.entries)) return false
      entries = data.entries.map((e) => ({ ...e }))
      sessionStart = data.sessionStart ?? null
      seq = entries.reduce((m, e) => Math.max(m, (e.seq ?? -1) + 1), 0)
      return true
    } catch {
      return false
    }
  }

  function persist(storage = globalThis.localStorage) {
    try { storage?.setItem(STORAGE_KEY, serialize()) } catch { /* quota / no storage */ }
  }

  // Pull a previously-persisted session back into memory. Returns true only if
  // a non-empty session was restored.
  function rehydrate(storage = globalThis.localStorage) {
    try {
      const raw = storage?.getItem(STORAGE_KEY)
      if (!raw) return false
      return load(raw) && entries.length > 0
    } catch {
      return false
    }
  }

  function clear(storage = globalThis.localStorage) {
    entries = []
    seq = 0
    sessionStart = null
    try { storage?.removeItem(STORAGE_KEY) } catch { /* ignore */ }
  }

  return {
    append, all, last, entryAt,
    serialize, load, persist, rehydrate, clear,
    get length() { return entries.length },
  }
}
