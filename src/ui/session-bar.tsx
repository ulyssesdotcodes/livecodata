// Session bar. A scrubber over the *authoring* log (session time), distinct from
// the frame scrubber under the scene (playback time). Dragging it replays the
// session: the program live at that apply is re-cooked and shown. The "latest"
// button jumps back to the newest apply; "reset" arms a rewind that steps back
// one apply every couple of beats (see main.ts's onTick wiring) until the start.
//
// History is a *tree*, not a line: scrub back, edit, and apply, and you land on
// a new branch while the old one stays reachable. When more than one branch
// exists the bar shows a branch chip whose popover lists the branch heads —
// clicking one checks it out (main.ts's checkout). And when the thumb rests on
// an apply that already has children, the bar warns that editing here will fork.
//
// Split humble-object style: the controller (createSessionBar) is pure signal
// state main.ts drives, and <SessionBar> renders it — app.tsx composes the two.

import { createSignal, For, Show, type Accessor } from 'solid-js'

// One branch head, as the switcher popover lists it. `current` marks the branch
// the live fold is on; `label` is main.ts's human hint (time / apply count).
export interface BranchChoice {
  id: string
  label: string
  current: boolean
}

interface SessionBarOptions {
  onScrub?: (pos: number) => void
  // The reset button was clicked — asked to arm/disarm the beat-paced rewind
  // (see main.ts's toggleRewind). Purely a click notification: the bar itself
  // has no notion of playback or beats, so it doesn't step anything.
  onReset?: () => void
  // A branch was picked from the switcher — check it out (main.ts's checkout).
  onCheckout?: (headId: string) => void
}

interface LogLike {
  length: number
}

export interface SessionBarController {
  count: Accessor<number>
  pos: Accessor<number>
  rewinding: Accessor<boolean>
  branches: Accessor<BranchChoice[]>
  // True when the thumb sits on an apply with children — an edit/apply here
  // forks a new branch. Drives the bar's fork-warning tint.
  forking: Accessor<boolean>
  // A user move: update the thumb and report it upstream.
  scrubTo(pos: number): void
  reset(): void
  checkout(headId: string): void
  setLog(log: LogLike): void
  setPosition(pos: number): void
  // The apply index the bar currently shows — lets a caller (main.ts's rewind
  // stepper) read "where are we" without keeping its own shadow copy.
  position(): number
  // Reflect whether a rewind is in progress (button look only; the caller
  // still owns the stepping).
  setRewinding(active: boolean): void
  // The branch heads (empty or one → the chip stays hidden).
  setBranches(branches: BranchChoice[]): void
  // Whether the current scrub position is a fork point.
  setForking(forking: boolean): void
}

export function createSessionBar({ onScrub, onReset, onCheckout }: SessionBarOptions = {}): SessionBarController {
  const [count, setCount] = createSignal(0)
  const [pos, setPos] = createSignal(0)
  const [rewinding, setRewinding] = createSignal(false)
  const [branches, setBranchList] = createSignal<BranchChoice[]>([])
  const [forking, setForkingState] = createSignal(false)

  return {
    count,
    pos,
    rewinding,
    branches,
    forking,
    scrubTo(p: number): void {
      setPos(p)
      onScrub?.(p)
    },
    reset(): void {
      onReset?.()
    },
    checkout(headId: string): void {
      onCheckout?.(headId)
    },
    setLog(log: LogLike): void {
      setCount(log.length)
      setPos(Math.max(0, log.length - 1))
    },
    setPosition(p: number): void {
      setPos(p)
    },
    position(): number {
      return pos()
    },
    setRewinding(active: boolean): void {
      setRewinding(active)
    },
    setBranches(list: BranchChoice[]): void {
      setBranchList(list)
    },
    setForking(f: boolean): void {
      setForkingState(f)
    },
  }
}

export function SessionBar(props: { ctl: SessionBarController }) {
  const { ctl } = props
  const [open, setOpen] = createSignal(false)
  const atLatest = () => ctl.pos() >= ctl.count() - 1
  const currentBranch = () => ctl.branches().findIndex((b) => b.current) + 1
  return (
    // The bar tints itself while replaying a historical apply, and differently
    // when an edit here would fork a new branch.
    <div class="session-bar" classList={{ replaying: !atLatest() && ctl.count() > 0, forking: ctl.forking() }}>
      <span class="session-label">{ctl.count() ? `run ${ctl.pos() + 1}/${ctl.count()}` : 'session'}</span>
      <Show when={ctl.branches().length > 1}>
        <div class="session-branch">
          <button class="session-branch-chip" title="Switch branch" onClick={() => setOpen((o) => !o)}>
            {`branch ${currentBranch()}/${ctl.branches().length}`}
          </button>
          <Show when={open()}>
            <div class="session-branch-popover">
              <For each={ctl.branches()}>
                {(b) => (
                  <button
                    class="session-branch-item"
                    classList={{ current: b.current }}
                    onClick={() => { setOpen(false); if (!b.current) ctl.checkout(b.id) }}
                  >
                    {b.label}
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>
      <button
        class="session-reset"
        classList={{ active: ctl.rewinding() }}
        style={{ visibility: ctl.count() > 1 ? 'visible' : 'hidden' }}
        title="Step back one run every 2 beats until back at the start"
        onClick={() => ctl.reset()}
      >
        reset
      </button>
      <input
        type="range"
        class="session-range"
        min="0"
        max={String(Math.max(0, ctl.count() - 1))}
        step="1"
        value={String(ctl.pos())}
        onInput={(e) => ctl.scrubTo(parseInt(e.currentTarget.value, 10))}
      />
      <button
        class="session-live"
        style={{ visibility: atLatest() || ctl.count() === 0 ? 'hidden' : 'visible' }}
        onClick={() => ctl.scrubTo(Math.max(0, ctl.count() - 1))}
      >
        latest
      </button>
    </div>
  )
}
