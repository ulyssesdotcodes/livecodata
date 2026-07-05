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
// Each appended event gets three stamps:
//   seq — monotonic logical clock (0, 1, 2, …), the replay/scrub coordinate
//   t   — wall-clock ms since the log's first event
//   src — which replica authored it (stable per browser)
// plus whatever payload the caller supplies ({ kind, ... }).
//
// The log is also the multiplayer unit: replicas exchange stamped events and
// merge() them in. seq doubles as a Lamport clock — merging bumps the local
// counter past every seen seq — and (seq, src) is a deterministic total order,
// so any two replicas that have seen the same events hold the same log and
// fold to the same state.
// ----------------------------------------------------------------------------

export interface StampedEvent {
  seq: number
  t: number
  kind: string
  src?: string
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

// ---------------------------------------------------------------------------
// Replica identity + merge — the pure pieces multiplayer is built from.
// ---------------------------------------------------------------------------

// This replica's id, minted once per page load / process. Deliberately NOT
// persisted: two tabs of one browser must be distinct replicas, or their
// independently-minted (src, seq) keys would collide and merge() would drop
// real events as duplicates. Events keep the src they were stamped with, so
// a reload continuing an old log is still consistent.
let cachedSource: string | null = null

export function localSource(): string {
  cachedSource ??= 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  return cachedSource
}

// Deterministic total order over events from any set of replicas: logical time
// first, authoring replica as the tiebreak. Every replica sorting the same set
// of events gets the same list — and therefore the same fold.
export function compareEvents(a: StampedEvent, b: StampedEvent): number {
  if (a.seq !== b.seq) return a.seq - b.seq
  const as = a.src ?? '', bs = b.src ?? ''
  return as < bs ? -1 : as > bs ? 1 : 0
}

const eventKey = (e: StampedEvent): string => `${e.src ?? ''}#${e.seq}`

// Union `incoming` into `existing` (both sorted by compareEvents), deduping by
// (src, seq). Pure: returns the merged list plus which events were new. Shared
// by EventLog.merge and the multiplayer server's room state.
export function mergeEvents(
  existing: StampedEvent[],
  incoming: StampedEvent[],
): { events: StampedEvent[]; added: StampedEvent[] } {
  const seen = new Set(existing.map(eventKey))
  const added: StampedEvent[] = []
  for (const e of incoming) {
    if (!e || typeof e.seq !== 'number' || typeof e.kind !== 'string') continue
    const key = eventKey(e)
    if (seen.has(key)) continue
    seen.add(key)
    added.push({ ...e })
  }
  if (!added.length) return { events: existing, added }
  return { events: [...existing, ...added].sort(compareEvents), added }
}

export interface EventLog {
  append(payload: EventPayload): StampedEvent
  all(): StampedEvent[]
  // Events with seq <= pos — the inputs to "the visible state at that point".
  upTo(pos: number): StampedEvent[]
  last(): StampedEvent | null
  readonly length: number
  // Fired after every append/load/clear/merge, so folds can invalidate their caches.
  onChange(cb: () => void): void
  // Fired only for locally-authored appends — the multiplayer publish hook.
  onAppend(cb: (e: StampedEvent) => void): void
  // Integrate events stamped by other replicas: dedup by (src, seq), keep the
  // deterministic (seq, src) order, and bump the local clock past everything
  // seen. Returns the events that were actually new.
  merge(incoming: StampedEvent[]): StampedEvent[]
  // Fired after a merge that added events. Merged events can land *between*
  // existing ones, so consumers should refold rather than apply incrementally.
  onMerge(cb: (added: StampedEvent[]) => void): void
  serialize(): string
  load(json: string | unknown): boolean
  clear(): void
}

export function createEventLog({ src = localSource() }: { src?: string } = {}): EventLog {
  let events: StampedEvent[] = []
  let seq = 0
  let start: number | null = null
  const listeners: (() => void)[] = []
  const appendListeners: ((e: StampedEvent) => void)[] = []
  const mergeListeners: ((added: StampedEvent[]) => void)[] = []

  const notify = (): void => listeners.forEach((cb) => cb())

  return {
    append(payload: EventPayload): StampedEvent {
      if (start == null) start = Date.now()
      const event: StampedEvent = { ...payload, seq: seq++, t: Date.now() - start, src }
      events.push(event)
      appendListeners.forEach((cb) => cb(event))
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

    onAppend(cb: (e: StampedEvent) => void): void {
      appendListeners.push(cb)
    },

    merge(incoming: StampedEvent[]): StampedEvent[] {
      const { events: merged, added } = mergeEvents(events, incoming)
      if (!added.length) return added
      events = merged
      seq = events.reduce((m, e) => Math.max(m, e.seq + 1), seq)
      if (start == null) start = Date.now()
      mergeListeners.forEach((cb) => cb(added))
      notify()
      return added
    },

    onMerge(cb: (added: StampedEvent[]) => void): void {
      mergeListeners.push(cb)
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

// A run seed: unsigned 32-bit, deterministic once picked (feeds the DSL's
// per-view PRNGs — see runtime.ts), fresh and unpredictable when generated.
export function randomSeed(): number {
  return (Math.random() * 0x100000000) >>> 0
}
