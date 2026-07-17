// Session bar: a scrubber over the *authoring* log (session time), distinct
// from the frame scrubber under the scene (playback time). History is a tree,
// not a line — scrub back, edit, and apply, and you fork a new branch while
// the old one stays reachable; the branch chip switches heads. The controller
// is pure signal state main.ts drives; <SessionBar> renders it.

import { createSignal, For, Show, type Accessor } from 'solid-js'

export interface BranchChoice {
  id: string
  label: string
  current: boolean
}

interface SessionBarOptions {
  onScrub?: (pos: number) => void
  // Click notification only — the caller owns arming and stepping the
  // beat-paced rewind (see main.ts's toggleRewind).
  onReset?: () => void
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
  // True when the thumb sits on an apply with children — an edit here forks a
  // new branch. Drives the fork-warning tint.
  forking: Accessor<boolean>
  scrubTo(pos: number): void
  reset(): void
  checkout(headId: string): void
  setLog(log: LogLike): void
  setPosition(pos: number): void
  position(): number
  // Button look only — the caller owns the stepping.
  setRewinding(active: boolean): void
  setBranches(branches: BranchChoice[]): void
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
