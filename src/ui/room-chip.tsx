// The room chip: solo it invites you to start a shared room; in a room it
// shows connection status and the live peer count, and leaves on click.
// Humble SolidJS view — main.ts decides what state to show (it owns the
// multiplayer connection and the peer fold); this only renders it.

import { createSignal } from 'solid-js'
import { mountComponent } from './dom.js'
import type { MultiplayerStatus } from '../multiplayer.js'

export type RoomChipState =
  | { kind: 'solo' }
  | { kind: 'room'; status: Exclude<MultiplayerStatus, 'closed'>; room: string; peers: number }

export interface RoomChipAPI {
  el: HTMLElement
  set(state: RoomChipState): void
}

export function initRoomChip({ onClick }: { onClick: () => void }): RoomChipAPI {
  const [state, setState] = createSignal<RoomChipState>({ kind: 'solo' })

  const { el } = mountComponent(() => {
    const status = () => {
      const s = state()
      return s.kind === 'room' ? s.status : null
    }
    const text = () => {
      const s = state()
      if (s.kind === 'solo') return 'room'
      return s.status === 'connected' ? `${s.room} · ${s.peers}` : `${s.room} …`
    }
    const title = () => {
      const s = state()
      if (s.kind === 'solo') return 'start or join a shared room'
      return s.status === 'connected'
        ? `in room "${s.room}" (${s.peers} connected) — click to leave`
        : `connecting to room "${s.room}" — click to leave`
    }
    return (
      <button
        class="multiplayer-chip"
        classList={{ connected: status() === 'connected', connecting: status() === 'connecting' }}
        title={title()}
        onClick={onClick}
      >
        {text()}
      </button>
    )
  })

  return {
    el,
    set(next: RoomChipState): void {
      setState(next)
    },
  }
}
