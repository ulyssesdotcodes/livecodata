// The room chip: solo it invites you to start a shared room; in a room it
// shows connection status and the live peer count, and leaves on click.
// Split humble-object style: main.ts owns the multiplayer connection and the
// peer fold and pushes RoomChipState into the controller; <RoomChip> only
// renders it.

import { createSignal, type Accessor } from 'solid-js'
import type { MultiplayerStatus } from '../multiplayer.js'

export type RoomChipState =
  | { kind: 'solo' }
  | { kind: 'room'; status: Exclude<MultiplayerStatus, 'closed'>; room: string; peers: number }

export interface RoomChipController {
  state: Accessor<RoomChipState>
  set(state: RoomChipState): void
  onClick: () => void
}

export function createRoomChip({ onClick }: { onClick: () => void }): RoomChipController {
  const [state, setState] = createSignal<RoomChipState>({ kind: 'solo' })
  return { state, set: setState, onClick }
}

export function RoomChip(props: { ctl: RoomChipController }) {
  const { ctl } = props
  const status = () => {
    const s = ctl.state()
    return s.kind === 'room' ? s.status : null
  }
  const text = () => {
    const s = ctl.state()
    if (s.kind === 'solo') return 'room'
    return s.status === 'connected' ? `${s.room} · ${s.peers}` : `${s.room} …`
  }
  const title = () => {
    const s = ctl.state()
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
      onClick={() => ctl.onClick()}
    >
      {text()}
    </button>
  )
}
