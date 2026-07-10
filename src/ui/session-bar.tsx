// Session bar. A scrubber over the *authoring* log (session time), distinct from
// the frame scrubber under the scene (playback time). Dragging it replays the
// session: the program live at that run is re-cooked and shown. The "latest"
// button jumps back to the newest run; "reset" arms a rewind that steps back
// one run every couple of beats (see main.ts's onTick wiring) until run 1.
// Split humble-object style: the controller (createSessionBar) is pure
// signal state main.ts drives, and <SessionBar> renders it — app.tsx
// composes the two.

import { createSignal, type Accessor } from 'solid-js'

interface SessionBarOptions {
  onScrub?: (pos: number) => void
  // The reset button was clicked — asked to arm/disarm the beat-paced rewind
  // (see main.ts's toggleRewind). Purely a click notification: the bar itself
  // has no notion of playback or beats, so it doesn't step anything.
  onReset?: () => void
}

interface LogLike {
  length: number
}

export interface SessionBarController {
  count: Accessor<number>
  pos: Accessor<number>
  rewinding: Accessor<boolean>
  // A user move: update the thumb and report it upstream.
  scrubTo(pos: number): void
  reset(): void
  setLog(log: LogLike): void
  setPosition(pos: number): void
  // The run index the bar currently shows — lets a caller (main.ts's rewind
  // stepper) read "where are we" without keeping its own shadow copy.
  position(): number
  // Reflect whether a rewind is in progress (button look only; the caller
  // still owns the stepping).
  setRewinding(active: boolean): void
}

export function createSessionBar({ onScrub, onReset }: SessionBarOptions = {}): SessionBarController {
  const [count, setCount] = createSignal(0)
  const [pos, setPos] = createSignal(0)
  const [rewinding, setRewinding] = createSignal(false)

  return {
    count,
    pos,
    rewinding,
    scrubTo(p: number): void {
      setPos(p)
      onScrub?.(p)
    },
    reset(): void {
      onReset?.()
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
  }
}

export function SessionBar(props: { ctl: SessionBarController }) {
  const { ctl } = props
  const atLatest = () => ctl.pos() >= ctl.count() - 1
  return (
    // The bar tints itself while replaying a historical run.
    <div class="session-bar" classList={{ replaying: !atLatest() && ctl.count() > 0 }}>
      <span class="session-label">{ctl.count() ? `run ${ctl.pos() + 1}/${ctl.count()}` : 'session'}</span>
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
