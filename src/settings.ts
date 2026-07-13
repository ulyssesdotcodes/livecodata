// Small user-preference store, separate from sessions.ts (which is scoped to
// session event logs). Every setting is one stringSetting/boolSetting call, so
// the try/catch-around-storage discipline (private browsing, quota) is written
// once and a new preference can't hand-roll a divergent copy.

import { defaultStorage, type MinimalStorage } from './storage.js'

export type { MinimalStorage } from './storage.js'

interface Setting<T> {
  get(storage?: MinimalStorage): T
  set(value: T, storage?: MinimalStorage): void
}

function boolSetting(key: string, def: boolean): Setting<boolean> {
  return {
    get(storage = defaultStorage()): boolean {
      try {
        const stored = storage?.getItem(key)
        return stored === null || stored === undefined ? def : stored === '1'
      } catch {
        return def
      }
    },
    set(value, storage = defaultStorage()): void {
      try {
        storage?.setItem(key, value ? '1' : '0')
      } catch {
        // storage unavailable (e.g. private browsing quota) — setting just won't persist
      }
    },
  }
}

function stringSetting(key: string, def: string): Setting<string> {
  return {
    get(storage = defaultStorage()): string {
      try {
        return storage?.getItem(key) ?? def
      } catch {
        return def
      }
    },
    set(value, storage = defaultStorage()): void {
      try {
        storage?.setItem(key, value)
      } catch {
        // storage unavailable (e.g. private browsing quota) — setting just won't persist
      }
    },
  }
}

// Vim mode was previously always on (hardcoded); default to on so existing
// users see no change until they explicitly opt out via the settings toggle.
const vimMode = boolSetting('livecodata.vimMode', true)
export const getVimMode = vimMode.get
export const setVimMode = vimMode.set

// The display name announced over multiplayer presence. The URL's ?user= param
// is the source of truth for a live room (see main.ts); this is just the
// remembered default that prefills the room-join popover.
const username = stringSetting('livecodata.username', '')
export const getUsername = username.get
export const setUsername = username.set

// MIDI is opt-in: requesting Web MIDI access pops a browser permission prompt,
// so default to off until the user explicitly enables it via the settings toggle.
const midiEnabled = boolSetting('livecodata.midiEnabled', false)
export const getMidiEnabled = midiEnabled.get
export const setMidiEnabled = midiEnabled.set
