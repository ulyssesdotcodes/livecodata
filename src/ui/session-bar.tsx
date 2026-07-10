// Session bar. A scrubber over the *authoring* log (session time), distinct from
// the frame scrubber under the scene (playback time). Dragging it replays the
// session: the program live at that run is re-cooked and shown. The "latest"
// button jumps back to the newest run. Split humble-object style: the
// controller (createSessionBar) is pure signal state main.ts drives, and
// <SessionBar> renders it — app.tsx composes the two.

import { createSignal, type Accessor } from 'solid-js'

interface SessionBarOptions {
  onScrub?: (pos: number) => void
}

interface LogLike {
  length: number
}

export interface SessionBarController {
  count: Accessor<number>
  pos: Accessor<number>
  // A user move: update the thumb and report it upstream.
  scrubTo(pos: number): void
  setLog(log: LogLike): void
  setPosition(pos: number): void
}

export function createSessionBar({ onScrub }: SessionBarOptions = {}): SessionBarController {
  const [count, setCount] = createSignal(0)
  const [pos, setPos] = createSignal(0)

  return {
    count,
    pos,
    scrubTo(p: number): void {
      setPos(p)
      onScrub?.(p)
    },
    setLog(log: LogLike): void {
      setCount(log.length)
      setPos(Math.max(0, log.length - 1))
    },
    setPosition(p: number): void {
      setPos(p)
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
