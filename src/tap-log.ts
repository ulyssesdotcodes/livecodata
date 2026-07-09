// livecodata tap-beat log — event-sourced, shared like any other table
// ----------------------------------------------------------------------------
// Tap-beat used to be a plain in-memory array of press timestamps. It's
// authored state like any run or table edit, so it belongs on the same
// append-only event-log primitive: a "tap" event per press, a "clear" event
// for the reset button. The tap-beat table (and any tempo the DSL's
// taps()/tempo()/beats() derive from it) is a fold of this log, which makes it
// syncable over multiplayer exactly like the session log and the editable-
// table log.
//
// Taps are stamped with wall-clock Date.now() (not performance.now(), which is
// meaningless across processes) so presses from different replicas fold into
// one chronological sequence once merged.
// ----------------------------------------------------------------------------

import { createEventLog, type EventLog } from './event-log.js'
import type { Row } from './lineage.js'

const TAP_RESET_GAP_MS = 2000 // a long pause starts a fresh tempo
const TAP_MAX = 16            // keep a rolling window so BPM tracks recent tapping

export interface TapLog {
  // The underlying event log — the unit multiplayer syncs.
  readonly log: EventLog
  tap(): void
  clear(): void
  // One row per press still in the current window — { beat, time } (ordinal +
  // the press's absolute UTC epoch ms, not time-since-first-tap). Absolute so
  // a client joining a room can derive the same tempo *and* the same wall-clock
  // reference from the synced table without any extra sync message.
  rows(): Row[]
  // The epoch (ms) "beat 0" is anchored to — the *first* tap of the current
  // sequence (a person tapping a tempo starts on beat 1, so that's the tap
  // that actually landed on the grid; later taps only refine the interval) —
  // once at least two taps have established a tempo. Null otherwise.
  anchor(): number | null
}

export function createTapLog({ src }: { src?: string } = {}): TapLog {
  const log = createEventLog({ src })

  // The current tap window, folded in wall-clock order: merged taps from
  // another replica can land out of the log's (seq, src) order, but the
  // reset-gap/window logic below cares about when presses actually happened.
  function window(): number[] {
    const events = log.all()
      .filter((e) => e.kind === 'tap' || e.kind === 'clear')
      .sort((a, b) => (a.at as number ?? 0) - (b.at as number ?? 0))
    let times: number[] = []
    for (const e of events) {
      if (e.kind === 'clear') { times = []; continue }
      const at = e.at as number
      if (times.length && at - times[times.length - 1] > TAP_RESET_GAP_MS) times = []
      times.push(at)
      if (times.length > TAP_MAX) times = times.slice(-TAP_MAX)
    }
    return times
  }

  return {
    log,
    tap(): void { log.append({ kind: 'tap', at: Date.now() }) },
    clear(): void { log.append({ kind: 'clear', at: Date.now() }) },
    rows(): Row[] {
      return window().map((t, i) => ({ beat: i, time: t }))
    },
    anchor(): number | null {
      const times = window()
      return times.length >= 2 ? times[0] : null
    },
  }
}
