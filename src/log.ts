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

export interface LogEntry {
  seq: number
  t: number
  kind: string
  code: string
  seed: number
}

interface AppendParams {
  kind?: string
  code: string
  seed?: number
}

interface MinimalStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

interface SerializedLog {
  version: number
  sessionStart: number | null
  entries: LogEntry[]
}

export interface Log {
  append(params: AppendParams): LogEntry
  all(): LogEntry[]
  last(): LogEntry | null
  entryAt(pos: number): LogEntry | null
  serialize(): string
  load(json: string | unknown): boolean
  persist(storage?: MinimalStorage): void
  rehydrate(storage?: MinimalStorage): boolean
  clear(storage?: MinimalStorage): void
  readonly length: number
}

export function randomSeed(): number {
  return (Math.random() * 0x100000000) >>> 0
}

export function createLog(): Log {
  let entries: LogEntry[] = []
  let seq = 0
  let sessionStart: number | null = null

  function append({ kind = 'run', code, seed = 0 }: AppendParams): LogEntry {
    if (sessionStart == null) sessionStart = Date.now()
    const event: LogEntry = { seq: seq++, t: Date.now() - sessionStart, kind, code, seed }
    entries.push(event)
    return event
  }

  function all(): LogEntry[] { return entries.slice() }

  function last(): LogEntry | null { return entries.length ? entries[entries.length - 1] : null }

  function entryAt(pos: number): LogEntry | null {
    let found: LogEntry | null = null
    for (const e of entries) {
      if (e.seq <= pos) found = e
      else break
    }
    return found
  }

  function serialize(): string {
    return JSON.stringify({ version: STORAGE_VERSION, sessionStart, entries })
  }

  function load(json: string | unknown): boolean {
    try {
      const data = typeof json === 'string' ? JSON.parse(json) as SerializedLog : json as SerializedLog
      if (!data || !Array.isArray(data.entries)) return false
      entries = data.entries.map((e) => ({ ...e }))
      sessionStart = data.sessionStart ?? null
      seq = entries.reduce((m, e) => Math.max(m, (e.seq ?? -1) + 1), 0)
      return true
    } catch {
      return false
    }
  }

  function persist(storage: MinimalStorage = globalThis.localStorage as MinimalStorage): void {
    try { storage?.setItem(STORAGE_KEY, serialize()) } catch { /* quota / no storage */ }
  }

  function rehydrate(storage: MinimalStorage = globalThis.localStorage as MinimalStorage): boolean {
    try {
      const raw = storage?.getItem(STORAGE_KEY)
      if (!raw) return false
      return load(raw) && entries.length > 0
    } catch {
      return false
    }
  }

  function clear(storage: MinimalStorage = globalThis.localStorage as MinimalStorage): void {
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
