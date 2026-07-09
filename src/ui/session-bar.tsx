// Session bar. A scrubber over the *authoring* log (session time), distinct from
// the frame scrubber under the scene (playback time). Dragging it replays the
// session: the program live at that run is re-cooked and shown. The "latest"
// button jumps back to the newest run; "reset" arms a rewind that steps back
// one run per measure (see main.ts's onLoop wiring) until run 1. Humble
// SolidJS view — position/count arrive via the SessionBarAPI, every move is
// reported through onScrub/onReset.

import { render } from 'solid-js/web'
import { createSignal, createEffect } from 'solid-js'

interface SessionBarOptions {
  onScrub?: (pos: number) => void
  // The reset button was clicked — asked to arm/disarm the measure-by-measure
  // rewind (see main.ts's toggleRewind). Purely a click notification: the bar
  // itself has no notion of playback or measures, so it doesn't step anything.
  onReset?: () => void
}

interface LogLike {
  length: number
}

export interface SessionBarAPI {
  el: HTMLElement
  setLog(log: LogLike): void
  setPosition(pos: number): void
  // The run index the bar currently shows — lets a caller (main.ts's rewind
  // stepper) read "where are we" without keeping its own shadow copy.
  position(): number
  // Reflect whether a rewind is in progress (button look only; the caller
  // still owns the stepping).
  setRewinding(active: boolean): void
}

export function initSessionBar({ onScrub, onReset }: SessionBarOptions = {}): SessionBarAPI {
  const [count, setCount] = createSignal(0)
  const [pos, setPos] = createSignal(0)
  const [rewinding, setRewinding] = createSignal(false)

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
        <button
          class="session-reset"
          classList={{ active: rewinding() }}
          style={{ visibility: count() > 1 ? 'visible' : 'hidden' }}
          title="Step back one run every measure until back at the start"
          onClick={() => onReset?.()}
        >
          reset
        </button>
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
    position(): number {
      return pos()
    },
    setRewinding(active: boolean): void {
      setRewinding(active)
    },
  }
}
