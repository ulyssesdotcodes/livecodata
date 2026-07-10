// The room chip: solo it opens a join popover (room name + username), using
// the browser's native <div popover> — light-dismiss (outside click, Escape)
// and top-layer stacking come for free, so there's no click-outside/open-state
// bookkeeping to write by hand. In a room the chip shows connection status
// and the live peer count, and leaves on click. Split humble-object style:
// main.ts owns the multiplayer connection and the peer/presence folds and
// pushes RoomChipState into the controller (and decides what a join actually
// does — seed the room, push ?room=&user= into the URL, reload); <RoomChip>
// only renders it and forwards the submitted room/user pair.

import { createSignal, type Accessor } from 'solid-js'
import type { MultiplayerStatus } from '../multiplayer.js'

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

// Unique per instance so the button's declarative `popovertarget` (below)
// resolves to *this* chip's popover even if the page ever had more than one.
let nextPopoverId = 0

export function RoomChip(props: { ctl: RoomChipController }) {
  const { ctl } = props
  const popoverId = `room-popover-${nextPopoverId++}`
  let chipBtn: HTMLButtonElement | undefined
  let popoverEl: HTMLDivElement | undefined
  let roomInput: HTMLInputElement | undefined
  let nameInput: HTMLInputElement | undefined

  const text = () => {
    const s = ctl.state()
    if (s.kind === 'solo') return 'room'
    return s.status === 'connected' ? `${s.room} · ${s.peerNames.length + 1}` : `${s.room} …`
  }
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

  // Position under the chip each time the popover opens — measured after
  // it's shown (the `toggle` event fires post-transition), not guessed, so
  // it clamps against its real width at the viewport edge instead of
  // overflowing it. Everything else (light-dismiss, top-layer stacking) is
  // the browser's native popover behavior; nothing to wire up by hand.
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
        // Declarative invoker (not a scripted showPopover()/togglePopover()
        // call) so the browser recognizes this button as *this* popover's
        // own opener — a manual call here would race the native
        // light-dismiss algorithm, which treats any other click (including
        // this button, if it weren't the registered invoker) as "outside"
        // and closes the popover before a click handler even runs. Only
        // present while solo; in a room the button has no popover to open.
        popoverTarget={ctl.state().kind === 'solo' ? popoverId : undefined}
        onClick={() => { if (ctl.state().kind === 'room') ctl.onLeave() }}
      >
        {text()}
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
