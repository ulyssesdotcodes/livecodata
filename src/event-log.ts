// livecodata event log — the shared append-only primitive
// ----------------------------------------------------------------------------
// Everything authored live in livecodata is an *event*: a code run, an edit to
// an editable table's cell, a MIDI note. This module is the one primitive under
// all of them — an append-only list of stamped events. Whatever is currently
// "visible" (the program in the editor, an editable table's rows, the active
// MIDI values) is never stored; it is a *fold* of the events up to a point,
// usually the latest. That's the live-performance-as-event-driven-programming
// lens: the log is the performance, every view of "now" is derived.
//
// Each appended event gets two stamps:
//   seq — monotonic logical clock (0, 1, 2, …), the replay/scrub coordinate
//   t   — wall-clock ms since the log's first event
// plus whatever payload the caller supplies ({ kind, ... }).
// ----------------------------------------------------------------------------

export interface StampedEvent {
  seq: number
  t: number
  kind: string
  [key: string]: unknown
}

export interface EventPayload {
  kind: string
  [key: string]: unknown
}

interface SerializedEvents {
  version: number
  start: number | null
  events: StampedEvent[]
}

const SERIAL_VERSION = 1

export interface EventLog {
  append(payload: EventPayload): StampedEvent
  all(): StampedEvent[]
  // Events with seq <= pos — the inputs to "the visible state at that point".
  upTo(pos: number): StampedEvent[]
  last(): StampedEvent | null
  readonly length: number
  // Fired after every append/load/clear, so folds can invalidate their caches.
  onChange(cb: () => void): void
  serialize(): string
  load(json: string | unknown): boolean
  clear(): void
}

export function createEventLog(): EventLog {
  let events: StampedEvent[] = []
  let seq = 0
  let start: number | null = null
  const listeners: (() => void)[] = []

  const notify = (): void => listeners.forEach((cb) => cb())

  return {
    append(payload: EventPayload): StampedEvent {
      if (start == null) start = Date.now()
      const event: StampedEvent = { ...payload, seq: seq++, t: Date.now() - start }
      events.push(event)
      notify()
      return event
    },

    all: () => events.slice(),

    upTo: (pos: number) => events.filter((e) => e.seq <= pos),

    last: () => (events.length ? events[events.length - 1] : null),

    get length() { return events.length },

    onChange(cb: () => void): void {
      listeners.push(cb)
    },

    serialize(): string {
      return JSON.stringify({ version: SERIAL_VERSION, start, events } satisfies SerializedEvents)
    },

    load(json: string | unknown): boolean {
      try {
        const data = typeof json === 'string' ? JSON.parse(json) as SerializedEvents : json as SerializedEvents
        if (!data || !Array.isArray(data.events)) return false
        events = data.events.map((e) => ({ ...e }))
        start = data.start ?? null
        seq = events.reduce((m, e) => Math.max(m, (e.seq ?? -1) + 1), 0)
        notify()
        return true
      } catch {
        return false
      }
    },

    clear(): void {
      events = []
      seq = 0
      start = null
      notify()
    },
  }
}

// Fold events into a state — the one way any "current" view is derived from a
// log. Pure; callers cache and re-fold (or apply the reducer incrementally to
// new events) as they see fit.
export function foldEvents<S>(events: StampedEvent[], reducer: (state: S, event: StampedEvent) => S, initial: S): S {
  let state = initial
  for (const e of events) state = reducer(state, e)
  return state
}
