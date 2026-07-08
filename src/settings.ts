// Small user-preference store, separate from sessions.ts (which is scoped to
// session event logs). Currently just the editor's vim-mode toggle.

const STORAGE_KEY = 'livecodata.vimMode'

interface MinimalStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

// Vim mode was previously always on (hardcoded); default to on so existing
// users see no change until they explicitly opt out via the settings toggle.
export function getVimMode(storage: MinimalStorage = globalThis.localStorage as MinimalStorage): boolean {
  try {
    const stored = storage?.getItem(STORAGE_KEY)
    return stored === null || stored === undefined ? true : stored === '1'
  } catch {
    return true
  }
}

export function setVimMode(enabled: boolean, storage: MinimalStorage = globalThis.localStorage as MinimalStorage): void {
  try {
    storage?.setItem(STORAGE_KEY, enabled ? '1' : '0')
  } catch {
    // storage unavailable (e.g. private browsing quota) — setting just won't persist
  }
}
