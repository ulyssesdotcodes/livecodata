// livecodata session log
// ----------------------------------------------------------------------------
// The *authoring* event log — the source of truth for a session, built on the
// shared append-only event-log primitive (event-log.ts), the same one that
// backs editable-table edits. Every time the user runs code we capture a
// snapshot of the whole program as a "run" event, so the entire session can be
// replayed from the beginning; "the program currently on screen" is just the
// fold of this log (the latest run). Persisted to localStorage so it survives
// a reload, and exportable to / importable from a plain JSON document.
//
//   { seq, t, kind: "run", code, seed }
//     seq  — monotonic logical clock (0, 1, 2, …)
//     t    — wall-clock ms since the session started
//     code — the full program text of that run (a per-run snapshot)
//     seed — RNG seed captured at run time, so a run replays exactly
// ----------------------------------------------------------------------------

import { createEventLog, type StampedEvent } from './event-log.js'

const STORAGE_KEY = 'livecodata.session'

export interface LogEntry extends StampedEvent {
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
  const events = createEventLog()

  return {
    append({ kind = 'run', code, seed = 0 }: AppendParams): LogEntry {
      return events.append({ kind, code, seed }) as LogEntry
    },

    all: () => events.all() as LogEntry[],

    last: () => events.last() as LogEntry | null,

    entryAt(pos: number): LogEntry | null {
      const upTo = events.upTo(pos)
      return upTo.length ? upTo[upTo.length - 1] as LogEntry : null
    },

    serialize: () => events.serialize(),
    load: (json) => events.load(json),

    persist(storage: MinimalStorage = globalThis.localStorage as MinimalStorage): void {
      try { storage?.setItem(STORAGE_KEY, events.serialize()) } catch { /* quota / no storage */ }
    },

    rehydrate(storage: MinimalStorage = globalThis.localStorage as MinimalStorage): boolean {
      try {
        const raw = storage?.getItem(STORAGE_KEY)
        if (!raw) return false
        return events.load(raw) && events.length > 0
      } catch {
        return false
      }
    },

    clear(storage: MinimalStorage = globalThis.localStorage as MinimalStorage): void {
      events.clear()
      try { storage?.removeItem(STORAGE_KEY) } catch { /* ignore */ }
    },

    get length() { return events.length },
  }
}
