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

const USERNAME_STORAGE_KEY = 'livecodata.username'

// The display name announced over multiplayer presence. The URL's ?user= param
// is the source of truth for a live room (see main.ts); this is just the
// remembered default that prefills the room-join popover.
export function getUsername(storage: MinimalStorage = globalThis.localStorage as MinimalStorage): string {
  try {
    return storage?.getItem(USERNAME_STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

export function setUsername(name: string, storage: MinimalStorage = globalThis.localStorage as MinimalStorage): void {
  try {
    storage?.setItem(USERNAME_STORAGE_KEY, name)
  } catch {
    // storage unavailable (e.g. private browsing quota) — setting just won't persist
  }
}

const MIDI_STORAGE_KEY = 'livecodata.midiEnabled'

// MIDI is opt-in: requesting Web MIDI access pops a browser permission prompt,
// so default to off until the user explicitly enables it via the settings toggle.
export function getMidiEnabled(storage: MinimalStorage = globalThis.localStorage as MinimalStorage): boolean {
  try {
    const stored = storage?.getItem(MIDI_STORAGE_KEY)
    return stored === '1'
  } catch {
    return false
  }
}

export function setMidiEnabled(enabled: boolean, storage: MinimalStorage = globalThis.localStorage as MinimalStorage): void {
  try {
    storage?.setItem(MIDI_STORAGE_KEY, enabled ? '1' : '0')
  } catch {
    // storage unavailable (e.g. private browsing quota) — setting just won't persist
  }
}
