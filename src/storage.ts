// The minimal slice of Web Storage the persistence modules depend on
// (sessions.ts, settings.ts), so tests can hand in a Map-backed fake and
// non-browser callers don't need a DOM.

export interface MinimalStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const defaultStorage = (): MinimalStorage => globalThis.localStorage as MinimalStorage
