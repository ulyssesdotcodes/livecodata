// The minimal slice of Web Storage the persistence modules depend on, so
// tests can hand in a Map-backed fake and non-browser callers need no DOM.

export interface MinimalStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  // Optional so a Map-backed fake needn't bother; callers use `?.()`.
  removeItem?(key: string): void
}

export const defaultStorage = (): MinimalStorage => globalThis.localStorage as MinimalStorage
