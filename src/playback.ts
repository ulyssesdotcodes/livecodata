// Playback engine — all timing/loop/scrub state, with zero DOM and zero
// knowledge of what gets drawn. What renders is the list of Visualizers the
// engine is constructed with (see visualizer.ts); the engine only tells each
// one which source frame to reconcile to. The transport controls are a humble
// SolidJS view (ui/playback-controls.tsx) that renders the PlaybackViewState
// this engine emits and calls straight back into the methods below.

import { buildTimeline, type Timeline } from './timeline.js'
import { activeLineage } from './lineage.js'
import type { EvalCtx } from './dsl.js'
import { FRAMES_PER_BEAT, DEFAULT_BEAT_SECONDS, DEFAULT_LOOP_BEATS, framesToBeats } from './constants.js'
import type { Row } from './lineage.js'
import type { CookedVisualRows, LoopEpochs, Visualizer } from './visualizer.js'
import { beatSecondsFromTaps } from './tap-log.js'

export interface TapControl {
  tap(): void
  clear(): void
  rows(): Row[]
  // Wall-clock epoch (ms) of the first tap in the current sequence, once at
  // least two taps have established a tempo — the instant "beat 0" is
  // anchored to (a person tapping a tempo starts on beat 1, so that first tap
  // is the one that actually landed on the grid). Null before that (no tempo
  // yet), in which case phase anchors to the Unix epoch instead (see
  // wallAlignedPhase) — still a shared absolute reference, just an arbitrary one.
  anchor?(): number | null
}

// The tick value "now" should show, if a tap-established tempo is locked to
// the real-world clock: elapsed time since the anchor instant, wrapped into
// one loop. Anchoring phase to an absolute instant (rather than to whenever
// Play was pressed) means "beat 0" always falls at the same absolute moment —
// which is what keeps independently-started clients (or repeated Play
// presses, or a client joining a room mid-loop) in phase with each other,
// purely from each machine's own system clock.
export function wallAlignedTick(nowMs: number, anchorMs: number, loopSeconds: number): number {
  if (loopSeconds <= 0) return 0
  let phase = ((nowMs - anchorMs) / 1000) % loopSeconds
  if (phase < 0) phase += loopSeconds
  return phase
}

// Which pass of the loop "now" falls in on the same wall-aligned grid — the
// quotient of the division wallAlignedTick keeps the remainder of. Multi-loop
// sequences place content by the DIFFERENCE between this value now and at the
// instant the content last changed (its loop epoch), so a re-cook restarts a
// sequence at loop 0 while the phase within the loop stays exactly where it
// was — and, like the phase, any two clients agree on the pass purely from
// their own system clocks.
export function wallAlignedLoop(nowMs: number, anchorMs: number, loopSeconds: number): number {
  if (loopSeconds <= 0) return 0
  return Math.floor((nowMs - anchorMs) / 1000 / loopSeconds)
}

export type PlayState = 'idle' | 'playing' | 'paused'

// Everything the transport view needs to draw itself — pushed on every state
// change and every animation frame. The view renders this verbatim (humble
// object): no playback decisions live on the DOM side.
export interface PlaybackViewState {
  state: PlayState
  // The playhead position the time display shows, in elapsed beats.
  pos: number
  // What the scrubber thumb should sit at — frozen at the drag position while
  // the user is scrubbing so the ticking engine doesn't fight the drag.
  scrubPos: number
  maxBeats: number
  // Source beat at `pos` (timeline-mapped; equals pos+1 with no timeline).
  srcBeat: number
  timelineActive: boolean
  loop: boolean
  loopBeats: number
  // Tapped tempo in BPM, or null until two taps establish one.
  bpm: number | null
}

export interface PlaybackOptions {
  // srcBeats: the source/content position shown, as a 1-indexed beat (converted
  // from the internal frame count) — the unit every table's `beat` column uses.
  onTick?: (tick: number, active: Map<string, Set<number>>, srcBeats: number) => void
  onPlay?: () => void
  // Called each time the loop wraps (the playhead passes the end and jumps back).
  onLoop?: () => void
  tapControl?: TapControl
  // Streaming context for the frame being shown: resolves midi() bindings against
  // the live MIDI table, sampled at the playhead's *source* frame — the same
  // content-space coordinate events are recorded in (see currentSourceBeats).
  midiCtxAt?: (srcFrame: number) => EvalCtx | null
  // The same, for slider() bindings against the live slider table. Its ctx also
  // carries sliders() — every defined slider's value — which each hydra sketch
  // reads as `props.sliders` (see visualizer.ts).
  sliderCtxAt?: (srcFrame: number) => EvalCtx | null
}

// The engine's clocks and frame scheduler, injectable so tests can drive the
// whole timing state machine deterministically. Production omits this and
// gets the real ones.
export interface PlaybackClock {
  // Monotonic ms — the beat clock (performance.now).
  now?: () => number
  // Wall-clock epoch ms — the cross-client phase anchor (Date.now).
  epochNow?: () => number
  // Schedule the next animation frame (requestAnimationFrame).
  raf?: (cb: () => void) => void
}

export interface PlaybackEngineOptions extends PlaybackOptions {
  onViewChange?: (vs: PlaybackViewState) => void
  clock?: PlaybackClock
}

// Fold an activity event stream (main.ts's ACTIVITY_TABLE) into per-kind loop
// epochs: the newest 'apply' event naming each kind in `changed`, by its
// absolute `at` stamp. The stamp is the AUTHOR's clock at the instant they
// applied, and every replica folds the same merged events — so all clients in
// a room (including one that joins later and replays the history) derive
// identical epochs, and therefore the same pass of a multi-loop sequence,
// with no extra sync message. This is the same trick the tap log uses for
// tempo: record the absolute instant once, let every clock-synced client
// derive the rest. An apply without a `changed` list counts for every kind;
// events without a stamp are ignored (legacy pulses).
export function loopEpochsFromApplies(events: Row[]): LoopEpochs {
  const out: LoopEpochs = {}
  for (const e of events ?? []) {
    if (e.kind !== 'apply' || typeof e.at !== 'number') continue
    const kinds: unknown[] = Array.isArray(e.changed) ? e.changed : ['scene', 'timeline', 'hydra']
    for (const k of kinds) {
      if (k === 'scene' || k === 'timeline' || k === 'hydra') out[k] = e.at
    }
  }
  return out
}

// What load() consumes: every visualizer's row sets plus the timeline's (the
// timeline is the engine's own — it remaps time, it doesn't render). replay's
// CookedResult is structurally assignable.
export type LoadedRows = CookedVisualRows & { timelineRows: Row[] }

export interface PlaybackAPI {
  load(cooked: LoadedRows): void
  // The tap tempo changed: re-anchor the beat clock so the playhead keeps its
  // beat position (and the loop's wall-clock length follows the new tempo)
  // without re-cooking anything — content sits on a fixed beat grid, so only the
  // *rate* the playhead sweeps it changes.
  retempo(): void
  // The content/source position (as a 1-indexed beat) currently on screen —
  // the playhead beat mapped through the (loop-wrapped) timeline. Live MIDI
  // events are stamped here, so a recorded sweep's speed follows the timeline
  // mapping: if it changes later (e.g. a slower fit), the sweep speeds up or
  // slows down right along with everything else on screen.
  currentSourceBeats(): number
  // Start playing if not already (same as pressing the play button once) — for
  // a caller that needs the loop actually running, e.g. the reset button's
  // measure-by-measure rewind. No-op if already playing.
  play(): void
}

export interface PlaybackEngine extends PlaybackAPI {
  toggle(): void
  setLoop(on: boolean): void
  setLoopBeats(n: number): void
  // Scrubber drag in progress: preview the dragged position without committing
  // the playhead. endScrub (pointerup, wherever it lands) commits it.
  scrub(pos: number): void
  endScrub(): void
  viewState(): PlaybackViewState
}

export function createPlaybackEngine(
  visualizers: Visualizer[],
  { onTick, onPlay, onLoop, tapControl, midiCtxAt, sliderCtxAt, onViewChange, clock }: PlaybackEngineOptions = {},
): PlaybackEngine {
  const now = clock?.now ?? ((): number => performance.now())
  const epochNow = clock?.epochNow ?? ((): number => Date.now())
  const raf = clock?.raf ?? ((cb: () => void): void => { requestAnimationFrame(cb) })

  let state: PlayState = 'idle'
  // The playhead is measured in BEATS. `startTime` is the wall epoch (ms) the
  // beat clock is anchored to, and `anchorBeatSec` the tempo it was anchored at,
  // so the live position is ((now - startTime)/1000)/anchorBeatSec beats.
  // Re-anchoring (play, tempo change, loop wrap, scrub) is the only place the
  // tapped tempo enters — between anchors a loop runs at one steady tempo.
  let startTime: number | null = null
  let anchorBeatSec = DEFAULT_BEAT_SECONDS
  let pausedBeat = 0
  let timeline: Timeline = buildTimeline([])
  // Absolute instant the timeline's multi-loop pass counting is based on — its
  // shared apply stamp (see loopEpochsFromApplies; each visualizer keeps its
  // own kind's stamp the same way). 0 (the Unix epoch) until stamped — the
  // same arbitrary-but-shared reference the no-tap phase anchor uses.
  let timelineEpoch = 0
  let maxBeats = 0 // loop length in beats — the one unit the playhead counts in
  let isScrubbing = false
  let scrubPos = 0
  let loop = true // when playback reaches the end, wrap back to the start
  // How many beats one loop lasts when nothing else sizes it (no timeline, no
  // 3D scene) — a pure hydra sketch. User-settable via the loop-length control,
  // so the last sketch keyframe no longer has to sit exactly at the loop boundary
  // (where it was invisible).
  let loopBeats = DEFAULT_LOOP_BEATS
  // The position most recently shown to the view (what emit() reports as pos).
  let shownPos = 0

  // Seconds per beat, live from the tapped tempo (see tap-log.ts's
  // beatSecondsFromTaps) or the shared default until two taps set one. This is
  // the whole of how tempo enters playback: it scales how fast the beat clock
  // advances, never where content sits on the (fixed) beat grid.
  function beatSeconds(): number {
    return beatSecondsFromTaps(tapControl?.rows()) ?? DEFAULT_BEAT_SECONDS
  }

  function tappedBpm(): number | null {
    const bs = beatSecondsFromTaps(tapControl?.rows())
    return bs == null ? null : 60 / bs
  }

  function viewState(): PlaybackViewState {
    return {
      state,
      pos: shownPos,
      scrubPos: isScrubbing ? scrubPos : Math.min(shownPos, maxBeats),
      maxBeats,
      srcBeat: sourceBeatAt(shownPos),
      timelineActive: timeline.active,
      loop,
      loopBeats,
      bpm: tappedBpm(),
    }
  }

  function emit(pos: number = shownPos): void {
    shownPos = pos
    onViewChange?.(viewState())
  }

  // The content/source beat shown at playhead beat `pos` (0-based elapsed beats):
  // the timeline remaps the 1-indexed playback beat to a 1-indexed source beat
  // (identity when there is no timeline). A multi-loop timeline also remaps by
  // which pass of the loop we're in.
  function sourceBeatAt(pos: number): number {
    return timeline.sourceBeatAt(pos + 1, timeline.loops > 1 ? passesSince(timelineEpoch) : 0)
  }

  function applyAt(pos: number): void {
    // Source position as a fractional cache frame: the timeline maps this
    // playhead beat to a source beat, which sits at (beat - 1) * FRAMES_PER_BEAT
    // on the fixed grid. Fractional because the playhead sweeps continuously —
    // each visualizer interpolates between cache frames however it needs to.
    const srcBeat = sourceBeatAt(pos)
    const srcFrameF = (srcBeat - 1) * FRAMES_PER_BEAT
    // Streaming context: midi()/slider() bindings resolve against the live MIDI
    // and slider tables at the source frame — the same content coordinate events
    // are recorded in, so a recorded sweep tracks the timeline (and the tempo)
    // rather than wall time. Both sources merge into one ctx handed to every
    // visualizer (midi supplies midi(), the slider source slider()/sliders()).
    const srcFrame = Math.round(srcFrameF)
    const midiCtx = midiCtxAt ? midiCtxAt(srcFrame) : null
    const sliderCtx = sliderCtxAt ? sliderCtxAt(srcFrame) : null
    const ctx: EvalCtx | null = midiCtx || sliderCtx ? { ...midiCtx, ...sliderCtx } : null
    const states: Row[] = []
    for (const v of visualizers) states.push(...v.applyFrame({ srcFrameF, ctx, passAt: passesSince }))
    // Graphed/table views key their rows by `beat`, so report the source beat.
    onTick?.(pos, activeLineage(states), srcBeat)
  }

  // Is there anything to play? A program can define a hydra sketch with no 3D
  // scene at all (see the "Hydra Sketch" sample), so any one visualizer with
  // content is enough.
  function hasContent(): boolean {
    return visualizers.some((v) => v.hasContent())
  }

  function reset(pos: number = 0): void {
    for (const v of visualizers) v.clear()
    emit(pos)
    if (hasContent()) applyAt(pos)
  }

  // Where the playhead currently sits, in beats, whatever the play state.
  function currentTime(): number {
    return state === 'playing' ? position() : pausedBeat
  }

  // The wall-clock-aligned beat phase for right now, or null when there's
  // nothing to loop over. Always anchored to an absolute instant — the first
  // tap of the established tempo if there is one, else the Unix epoch — so
  // any two clients (or a client joining a room mid-loop, with or without a
  // tap tempo set yet) land on the same phase purely from their own system
  // clock, with no extra sync message needed (see wallAlignedTick).
  function wallAlignedPhase(): number | null {
    const anchorMs = tapControl?.anchor?.() ?? 0
    const bs = beatSeconds()
    if (maxBeats <= 0) return null
    return wallAlignedTick(epochNow(), anchorMs, maxBeats * bs) / bs
  }

  // How many wall-aligned loops have completed since the absolute instant
  // `epochMs` — which pass of a multi-loop sequence to show right now (before
  // wrapping by the sequence's own pass count): 0 within the loop the epoch
  // falls in, incrementing once per loop-complete, on the same absolute grid
  // as wallAlignedPhase — no per-wrap counter, and every clock-synced client
  // agrees. This is the time half of multi-loop playback; the content half
  // (how many passes, where each pass's rows sit) lives in each visualizer,
  // which receives this function per frame (VisualizerFrame.passAt) and calls
  // it with its own shared apply stamp.
  function passesSince(epochMs: number): number {
    const anchorMs = tapControl?.anchor?.() ?? 0
    const loopSec = maxBeats * beatSeconds()
    return Math.max(0, wallAlignedLoop(epochNow(), anchorMs, loopSec) - wallAlignedLoop(epochMs, anchorMs, loopSec))
  }

  // The content/source position (a 1-indexed beat) currently on screen — the
  // playhead beat wrapped by the loop exactly as rendering wraps it, then mapped
  // through the timeline, exactly as applyAt computes it. This is where a live
  // MIDI event gets stamped: recording this shared content coordinate (rather
  // than raw wall-clock time) is what makes a recorded sweep follow the timeline
  // and the tempo along with everything else on screen.
  function currentSourceBeats(): number {
    let pos = currentTime()
    if (loop && maxBeats > 0 && pos >= maxBeats) pos %= maxBeats
    return sourceBeatAt(pos)
  }

  // Loop length in beats. A timeline sizes it by its playback-beat span; else
  // the longest visualizer content (a 3D scene's cache length); else — content
  // that declines to size the loop, like a pure hydra sketch — the loop-length
  // control (loopBeats). Sizing a hydra-only loop from the control rather than
  // the sketch's last keyframe is what keeps that keyframe visible instead of
  // landing exactly on the loop boundary.
  function recomputeMax(): void {
    if (timeline.active) {
      maxBeats = timeline.beats
      return
    }
    const frames = visualizers.reduce((m, v) => Math.max(m, v.contentFrames()), 0)
    if (frames > 0) maxBeats = framesToBeats(frames)
    else if (hasContent()) maxBeats = loopBeats
    else maxBeats = 0
  }

  // Anchor the beat clock so the live position reads `pos` beats right now, at
  // the current tempo. The one place the tapped tempo is folded into the clock.
  function anchor(pos: number): void {
    anchorBeatSec = beatSeconds()
    startTime = now() - pos * anchorBeatSec * 1000
  }

  // Re-anchor the clock + view to beat `pos` (clamped) and reconcile the
  // scene there, keeping the current play state. Shared by load()/retempo() so a
  // re-cook or a tempo change resumes from where we were rather than rewinding.
  // applyAt diffs the scene, so swapping caches updates objects in place.
  function retimeTo(pos: number): void {
    const top = maxBeats || 0
    pos = Math.min(Math.max(0, pos), top)
    pausedBeat = Math.min(pausedBeat, top)
    if (state === 'playing') anchor(pos)
    emit(pos)
    if (hasContent()) {
      applyAt(pos)
    } else {
      for (const v of visualizers) v.blank()
    }
  }

  // Swap in a freshly cooked frame cache (+ optional timeline). A re-evaluate
  // does NOT move the playhead: keep the current position and play state, only
  // replacing the baked data. (First load is at 0 because that's where we are.)
  // `cooked.loopEpochs` rides along with the rows: the shared apply stamps
  // each multi-loop sequence counts passes from. Each visualizer picks its own
  // kind's stamp in its load(); the engine keeps the timeline's. A kind
  // present re-bases its pass counting to that absolute instant (the phase
  // within the loop stays put, only the pass count rewinds); a kind absent
  // keeps its current epoch.
  function load(cooked: LoadedRows): void {
    for (const v of visualizers) v.load(cooked)
    timeline = buildTimeline(cooked.timelineRows ?? [])
    if (typeof cooked.loopEpochs?.timeline === 'number') timelineEpoch = cooked.loopEpochs.timeline
    recomputeMax()
    retimeTo(currentTime())
  }

  // The tap tempo changed. Content placement is tempo-independent, so nothing
  // re-cooks — we only re-anchor the beat clock (keeping the playhead's beat, or
  // snapping to the wall-aligned phase while playing so a new tap lines the grid
  // up with itself immediately) and refresh the loop length, which now spans a
  // different wall-clock duration.
  function retempo(): void {
    recomputeMax()
    const aligned = state === 'playing' ? wallAlignedPhase() : null
    retimeTo(aligned ?? currentTime())
  }

  function scrub(pos: number): void {
    isScrubbing = true
    scrubPos = pos
    if (hasContent()) applyAt(pos)
    emit(pos)
  }

  function endScrub(): void {
    if (!isScrubbing) return
    isScrubbing = false
    pausedBeat = scrubPos
    if (state === 'playing') anchor(scrubPos)
    emit()
  }

  function setLoop(on: boolean): void {
    loop = on
    emit()
  }

  function setLoopBeats(n: number): void {
    n = Math.max(1, Math.round(n || DEFAULT_LOOP_BEATS))
    if (n === loopBeats) {
      emit() // still refresh the view so a rejected/clamped input snaps back
      return
    }
    loopBeats = n
    recomputeMax()
    retimeTo(currentTime())
  }

  function toggle(): void {
    if (!hasContent()) return
    if (state === 'playing') {
      state = 'paused'
      pausedBeat = position()
      emit()
    } else if (state === 'paused') {
      state = 'playing'
      anchor(pausedBeat)
      emit()
      onPlay?.()
      tick()
    } else {
      startFresh()
    }
  }

  function startFresh(): void {
    // Start already in phase with the wall-clock-anchored grid (tap-established
    // tempo if any, else the epoch-anchored default tempo), instead of always
    // at beat 0 — so pressing Play doesn't reset "beat 0" to this moment, it
    // joins the beat grid wherever it currently is. `?? 0` only matters when
    // there's nothing to loop over yet (maxBeats <= 0).
    // Loop epochs are deliberately NOT touched here: like the phase, the pass
    // of a multi-loop sequence is anchored to the shared apply stamps, so
    // pressing Play joins the sequence wherever it currently is — a client
    // hitting Play mid-jam lands on the same pass as everyone else.
    const aligned = wallAlignedPhase() ?? 0
    reset(aligned)
    pausedBeat = aligned
    anchor(aligned)
    state = 'playing'
    emit()
    onPlay?.()
    tick()
  }

  // The live playhead, in beats, at the anchored tempo.
  function position(): number {
    return (now() - (startTime ?? 0)) / 1000 / anchorBeatSec
  }

  function tick(): void {
    if (state !== 'playing') return

    let pos = position()

    // Loop: once past the end, wrap back to the start and re-anchor so the beat
    // clock stays bounded. Re-derives the wall-aligned phase (rather than just
    // `pos %= maxBeats`) so a tap tempo stays locked to the real-world clock on
    // every wrap — self-correcting drift and keeping independently-started
    // clients in phase, not just internally consistent.
    if (loop && maxBeats > 0 && pos >= maxBeats) {
      pos = wallAlignedPhase() ?? (pos % maxBeats)
      anchor(pos)
      onLoop?.()
    }

    emit(pos)
    applyAt(pos)

    if (!loop && pos >= maxBeats) {
      state = 'idle'
      pausedBeat = maxBeats // so a re-cook keeps the playhead at the end
      emit(maxBeats)
      return
    }

    raf(tick)
  }

  function play(): void {
    if (state !== 'playing') toggle()
  }

  return {
    load,
    retempo,
    currentSourceBeats,
    play,
    toggle,
    setLoop,
    setLoopBeats,
    scrub,
    endScrub,
    viewState,
  }
}
