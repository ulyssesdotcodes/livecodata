// The minimal slice of Web Storage the persistence modules depend on
// (sessions.ts, settings.ts), so tests can hand in a Map-backed fake and
// non-browser callers don't need a DOM.

export interface MinimalStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  // Optional because a Map-backed fake may not bother; callers use `?.()`.
  // Real localStorage always has it (sessions.ts's one-time IndexedDB
  // migration uses it to retire the legacy blob).
  removeItem?(key: string): void
}

export const defaultStorage = (): MinimalStorage => globalThis.localStorage as MinimalStorage
