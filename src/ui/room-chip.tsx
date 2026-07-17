// Room chip: solo, it opens a join popover using the browser's native
// <div popover>, so light-dismiss and top-layer stacking come for free; in a
// room it shows connection status and peer count, and leaves on click.
// main.ts owns the multiplayer connection and pushes RoomChipState in;
// <RoomChip> renders it and forwards the submitted room/user pair.

import { createSignal, type Accessor } from 'solid-js'
import type { MultiplayerStatus } from '../multiplayer.js'
import { Icon } from './icon.js'

export type RoomChipState =
  | { kind: 'solo' }
  | { kind: 'room'; status: Exclude<MultiplayerStatus, 'closed'>; room: string; user: string; peerNames: string[] }

export interface RoomChipController {
  state: Accessor<RoomChipState>
  set(state: RoomChipState): void
  initialUser: string
  onJoin: (room: string, user: string) => void
  onLeave: () => void
}

export function createRoomChip(
  { initialUser = '', onJoin, onLeave }: { initialUser?: string; onJoin: (room: string, user: string) => void; onLeave: () => void },
): RoomChipController {
  const [state, setState] = createSignal<RoomChipState>({ kind: 'solo' })
  return { state, set: setState, initialUser, onJoin, onLeave }
}

// Unique per instance so `popovertarget` resolves to *this* chip's popover.
let nextPopoverId = 0

export function RoomChip(props: { ctl: RoomChipController }) {
  const { ctl } = props
  const popoverId = `room-popover-${nextPopoverId++}`
  let chipBtn: HTMLButtonElement | undefined
  let popoverEl: HTMLDivElement | undefined
  let roomInput: HTMLInputElement | undefined
  let nameInput: HTMLInputElement | undefined

  const title = () => {
    const s = ctl.state()
    if (s.kind === 'solo') return 'start or join a shared room'
    const as = s.user ? ` as "${s.user}"` : ''
    const who = s.peerNames.length ? ` with ${s.peerNames.join(', ')}` : ''
    return s.status === 'connected'
      ? `in room "${s.room}"${as} (${s.peerNames.length + 1} connected${who}) — click to leave`
      : `connecting to room "${s.room}"${as} — click to leave`
  }

  const submit = (): void => {
    const room = roomInput?.value.trim()
    if (!room) { roomInput?.focus(); return }
    popoverEl?.hidePopover()
    ctl.onJoin(room, nameInput?.value.trim() ?? '')
  }

  // Position under the chip on each open — measured after it's shown so it
  // clamps against its real width at the viewport edge.
  const onToggle = (e: ToggleEvent): void => {
    if (e.newState !== 'open' || !chipBtn || !popoverEl) return
    const r = chipBtn.getBoundingClientRect()
    const left = Math.max(4, Math.min(r.left, window.innerWidth - popoverEl.offsetWidth - 4))
    popoverEl.style.top = `${r.bottom + 4}px`
    popoverEl.style.left = `${left}px`
    roomInput?.focus()
  }

  return (
    <>
      <button
        class="multiplayer-chip"
        classList={{
          connected: ctl.state().kind === 'room' && (ctl.state() as { status?: string }).status === 'connected',
          connecting: ctl.state().kind === 'room' && (ctl.state() as { status?: string }).status === 'connecting',
        }}
        title={title()}
        ref={chipBtn}
        // Declarative invoker, not a scripted showPopover(): a manual call
        // races native light-dismiss, which would treat the click as
        // "outside" and close the popover first. Only present while solo.
        popoverTarget={ctl.state().kind === 'solo' ? popoverId : undefined}
        aria-label={title()}
        onClick={() => { if (ctl.state().kind === 'room') ctl.onLeave() }}
      >
        <Icon name="users" />
      </button>
      <div
        id={popoverId}
        class="room-popover"
        popover="auto"
        ref={(el) => { popoverEl = el; el.addEventListener('toggle', onToggle) }}
      >
        <label class="settings-row">
          Room
          <input
            type="text"
            class="room-popover-input"
            placeholder="room name"
            ref={roomInput}
            onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
          />
        </label>
        <label class="settings-row">
          Name
          <input
            type="text"
            class="room-popover-input"
            placeholder="your name"
            value={ctl.initialUser}
            ref={nameInput}
            onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
          />
        </label>
        <button class="room-join-btn" onClick={submit}>Join</button>
      </div>
    </>
  )
}
