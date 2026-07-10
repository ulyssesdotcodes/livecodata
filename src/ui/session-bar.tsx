// Session bar. A scrubber over the *authoring* log (session time), distinct from
// the frame scrubber under the scene (playback time). Dragging it replays the
// session: the program live at that run is re-cooked and shown. The "latest"
// button jumps back to the newest run. Humble SolidJS view — position/count
// arrive via the SessionBarAPI, every move is reported through onScrub.

import { render } from 'solid-js/web'
import { createSignal, createEffect } from 'solid-js'

interface SessionBarOptions {
  onScrub?: (pos: number) => void
}

interface LogLike {
  length: number
}

export interface SessionBarAPI {
  el: HTMLElement
  setLog(log: LogLike): void
  setPosition(pos: number): void
}

export function initSessionBar({ onScrub }: SessionBarOptions = {}): SessionBarAPI {
  const [count, setCount] = createSignal(0)
  const [pos, setPos] = createSignal(0)

  const el = document.createElement('div')
  el.className = 'session-bar'

  const scrubTo = (p: number): void => {
    setPos(p)
    onScrub?.(p)
  }

  render(() => {
    const atLatest = () => pos() >= count() - 1
    // The bar tints itself while replaying a historical run.
    createEffect(() => el.classList.toggle('replaying', !atLatest() && count() > 0))
    return (
      <>
        <span class="session-label">{count() ? `run ${pos() + 1}/${count()}` : 'session'}</span>
        <input
          type="range"
          class="session-range"
          min="0"
          max={String(Math.max(0, count() - 1))}
          step="1"
          value={String(pos())}
          onInput={(e) => scrubTo(parseInt(e.currentTarget.value, 10))}
        />
        <button
          class="session-live"
          style={{ visibility: atLatest() || count() === 0 ? 'hidden' : 'visible' }}
          onClick={() => scrubTo(Math.max(0, count() - 1))}
        >
          latest
        </button>
      </>
    )
  }, el)

  return {
    el,
    setLog(log: LogLike): void {
      setCount(log.length)
      setPos(Math.max(0, log.length - 1))
    },
    setPosition(pos: number): void {
      setPos(pos)
    },
  }
}
