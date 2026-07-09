import { buildFrameIndex, sampleFrame, type FrameIndex } from './rasterize.js'
import { buildHydraIndex, hydraFrameAt } from './hydra.js'
import { buildTimeline, type Timeline } from './timeline.js'
import { activeLineage } from './lineage.js'
import { resolveBindings, type EvalCtx } from './dsl.js'
import { FPS, FRAMES_PER_BEAT, DEFAULT_BEAT_SECONDS, DEFAULT_LOOP_BEATS, framesToBeats } from './constants.js'
import type { Row } from './lineage.js'
import type { SceneAPI } from './three-scene.js'
import type { HydraAPI } from './hydra-scene.js'

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
}

export interface PlaybackAPI {
  load(sceneRows: Row[], timelineRows: Row[], hydraRows: Row[]): void
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
}

export function initPlayback(
  controlsEl: HTMLElement,
  sceneAPI: SceneAPI,
  hydraAPI: HydraAPI,
  { onTick, onPlay, onLoop, tapControl, midiCtxAt }: PlaybackOptions = {},
): PlaybackAPI {
  type PlayState = 'idle' | 'playing' | 'paused'
  let state: PlayState = 'idle'
  // The playhead is measured in BEATS. `startTime` is the wall epoch (ms) the
  // beat clock is anchored to, and `anchorBeatSec` the tempo it was anchored at,
  // so the live position is ((now - startTime)/1000)/anchorBeatSec beats.
  // Re-anchoring (play, tempo change, loop wrap, scrub) is the only place the
  // tapped tempo enters — between anchors a loop runs at one steady tempo.
  let startTime: number | null = null
  let anchorBeatSec = DEFAULT_BEAT_SECONDS
  let pausedBeat = 0
  let frameIndex: FrameIndex = buildFrameIndex([])
  let hydraIndex: Row[] = buildHydraIndex([])
  let timeline: Timeline = buildTimeline([])
  let aliveObjects = new Set<unknown>()
  let maxBeats = 0 // loop length in beats — the one unit the playhead counts in
  let isScrubbing = false
  let loop = true // when playback reaches the end, wrap back to the start
  // How many beats one loop lasts when nothing else sizes it (no timeline, no
  // 3D scene) — a pure hydra sketch. User-settable via the loop-length control,
  // so the last sketch keyframe no longer has to sit exactly at the loop boundary
  // (where it was invisible).
  let loopBeats = DEFAULT_LOOP_BEATS

  // Seconds per beat, live from the tapped tempo (average interval between taps)
  // or the shared default until two taps set one. This is the whole of how tempo
  // enters playback: it scales how fast the beat clock advances, never where
  // content sits on the (fixed) beat grid.
  function beatSeconds(): number {
    const rows = tapControl?.rows()
    if (rows && rows.length > 1) {
      const first = rows[0].time as number
      const last = rows[rows.length - 1].time as number
      return (last - first) / (rows.length - 1) / 1000
    }
    return DEFAULT_BEAT_SECONDS
  }

  const topRow = document.createElement('div')
  topRow.className = 'playback-row'

  const btn = document.createElement('button')
  btn.id = 'play-pause-btn'
  btn.textContent = '▶'
  btn.title = 'Play'
  btn.setAttribute('aria-label', 'Play')

  const loopBtn = document.createElement('button')
  loopBtn.id = 'loop-btn'
  loopBtn.textContent = '↻'
  loopBtn.title = 'Loop playback'
  loopBtn.setAttribute('aria-label', 'Loop playback')
  loopBtn.classList.toggle('active', loop)
  loopBtn.onclick = () => {
    loop = !loop
    loopBtn.classList.toggle('active', loop)
  }

  // Loop length in beats — how long one loop lasts (at the current tempo) for a
  // program with no timeline/scene to size it. Changing it re-lengths the loop
  // live so the last sketch keyframe is no longer stuck on the loop boundary.
  const loopLenWrap = document.createElement('label')
  loopLenWrap.className = 'loop-len'
  loopLenWrap.title = 'Loop length in beats'
  const loopLenInput = document.createElement('input')
  loopLenInput.id = 'loop-beats'
  loopLenInput.type = 'number'
  loopLenInput.min = '1'
  loopLenInput.step = '1'
  loopLenInput.value = String(loopBeats)
  const loopLenLabel = document.createElement('span')
  loopLenLabel.textContent = 'beats'
  loopLenWrap.appendChild(loopLenInput)
  loopLenWrap.appendChild(loopLenLabel)
  loopLenInput.onchange = () => {
    const n = Math.max(1, Math.round(parseFloat(loopLenInput.value) || DEFAULT_LOOP_BEATS))
    loopLenInput.value = String(n)
    if (n === loopBeats) return
    loopBeats = n
    recomputeMax()
    retimeTo(currentTime())
  }

  const timeEl = document.createElement('span')
  timeEl.id = 'playback-time'
  timeEl.textContent = 'beat 1.00'

  topRow.appendChild(btn)
  topRow.appendChild(loopBtn)
  topRow.appendChild(loopLenWrap)
  topRow.appendChild(timeEl)

  // Tap-beat row: record wall-time presses and show the tempo derived from them
  // (the same table the DSL's beats()/tempo() read). Only when a controller is given.
  let tapRow: HTMLDivElement | null = null
  if (tapControl) {
    tapRow = document.createElement('div')
    tapRow.className = 'playback-row tap-row'

    const tapBtn = document.createElement('button')
    tapBtn.id = 'tap-beat-btn'
    tapBtn.textContent = 'Tap'
    tapBtn.title = 'Tap a beat to set the tempo — the whole loop plays at it'

    const bpmEl = document.createElement('span')
    bpmEl.id = 'tap-bpm'

    const clearBtn = document.createElement('button')
    clearBtn.id = 'tap-clear-btn'
    clearBtn.textContent = 'Clear'
    clearBtn.title = 'Clear taps'

    const showTempo = (): void => {
      const rows = tapControl.rows()
      const n = rows.length
      const beat = n > 1 ? ((rows[n - 1].time as number) - (rows[0].time as number)) / (n - 1) / 1000 : null
      bpmEl.textContent = `${ beat ? (60 / beat).toFixed(1) : 120} BPM`;
    }

    tapBtn.onclick = () => { tapControl.tap(); showTempo() }
    clearBtn.onclick = () => { tapControl.clear(); showTempo() }
    showTempo()

    tapRow.appendChild(tapBtn)
    tapRow.appendChild(bpmEl)
    tapRow.appendChild(clearBtn)
  }

  const scrubber = document.createElement('input')
  scrubber.type = 'range'
  scrubber.id = 'scrub-bar'
  scrubber.min = '0'
  scrubber.max = '100'
  scrubber.step = String(1 / FRAMES_PER_BEAT) // ~one cache frame, in beats
  scrubber.value = '0'

  controlsEl.appendChild(topRow)
  if (tapRow) controlsEl.appendChild(tapRow)
  controlsEl.appendChild(scrubber)

  function setFill(pos: number): void {
    const pct = maxBeats > 0 ? Math.min(100, (pos / maxBeats) * 100) : 0
    scrubber.style.background =
      `linear-gradient(to right, #e94560 ${pct}%, #1a3a5e ${pct}%)`
  }

  // The content/source beat shown at playhead beat `pos` (0-based elapsed beats):
  // the timeline remaps the 1-indexed playback beat to a 1-indexed source beat
  // (identity when there is no timeline).
  function sourceBeatAt(pos: number): number {
    return timeline.sourceBeatAt(pos + 1)
  }

  function showIndex(pos: number): void {
    const srcBeat = sourceBeatAt(pos)
    if (timeline.active) {
      timeEl.textContent = `${(pos + 1).toFixed(2)}→${srcBeat.toFixed(2)} beat`
    } else {
      timeEl.textContent = `beat ${srcBeat.toFixed(2)}`
    }
  }

  function applyAt(pos: number): void {
    // Source position as a fractional cache frame: the timeline maps this
    // playhead beat to a source beat, which sits at (beat - 1) * FRAMES_PER_BEAT
    // on the fixed grid. Fractional because the playhead sweeps continuously —
    // sampleFrame eases the scene between cache frames, and hydra gets the same
    // continuous position so its clock tracks the (tempo-scaled) source rate.
    const srcBeat = sourceBeatAt(pos)
    const srcFrameF = (srcBeat - 1) * FRAMES_PER_BEAT
    const srcFrame = Math.round(srcFrameF)
    // Streaming context: midi() bindings resolve against the live MIDI table at
    // the source frame — the same content coordinate events are recorded in, so
    // a recorded sweep tracks the timeline (and the tempo) rather than wall time.
    const ctx = midiCtxAt ? midiCtxAt(srcFrame) : null
    const baked = sampleFrame(frameIndex, srcFrameF)
    const states = ctx ? baked.map((s) => resolveBindings(s, ctx)) : baked
    const present = new Set<unknown>()
    for (const s of states) {
      present.add(s.id)
      if (!aliveObjects.has(s.id)) {
        sceneAPI.createObject(s as Record<string, unknown>)
        aliveObjects.add(s.id)
      } else {
        sceneAPI.updateObject(s as Record<string, unknown>)
      }
    }
    for (const id of aliveObjects) {
      if (!present.has(id)) {
        sceneAPI.destroyObject(id)
        aliveObjects.delete(id)
      }
    }
    const sketch = hydraFrameAt(hydraIndex, Math.floor(srcFrameF))
    hydraAPI.setSketch(sketch && ctx ? { ...sketch, vars: resolveBindings(sketch.vars, ctx) } : sketch)
    hydraAPI.tick(srcFrameF / FPS)
    // Graphed/table views key their rows by `beat`, so report the source beat.
    onTick?.(pos, activeLineage(states), srcBeat)
  }

  // Is there anything to play? A program can define a hydra sketch with no 3D
  // scene at all (see the "Hydra Sketch" sample), so playback isn't gated on
  // frameIndex alone.
  function hasContent(): boolean {
    return frameIndex.map.size > 0 || hydraIndex.length > 0
  }

  function reset(pos: number = 0): void {
    sceneAPI.reset()
    aliveObjects = new Set()
    scrubber.value = String(pos)
    setFill(pos)
    showIndex(pos)
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
    return wallAlignedTick(Date.now(), anchorMs, maxBeats * bs) / bs
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

  // Loop length in beats. A timeline sizes it by its playback-beat span; else a
  // 3D scene by its cache length; else — a pure hydra sketch — the loop-length
  // control (loopBeats). Sizing a hydra-only loop from the control rather than
  // the sketch's last keyframe is what keeps that keyframe visible instead of
  // landing exactly on the loop boundary.
  function recomputeMax(): void {
    if (timeline.active) {
      maxBeats = timeline.beats
    } else if (frameIndex.maxFrame > 0) {
      maxBeats = framesToBeats(frameIndex.maxFrame)
    } else if (hydraIndex.length) {
      maxBeats = loopBeats
    } else {
      maxBeats = 0
    }
    scrubber.max = String(maxBeats || 100)
  }

  // Anchor the beat clock so the live position reads `pos` beats right now, at
  // the current tempo. The one place the tapped tempo is folded into the clock.
  function anchor(pos: number): void {
    anchorBeatSec = beatSeconds()
    startTime = performance.now() - pos * anchorBeatSec * 1000
  }

  // Re-anchor the clock + scrubber to beat `pos` (clamped) and reconcile the
  // scene there, keeping the current play state. Shared by load()/retempo() so a
  // re-cook or a tempo change resumes from where we were rather than rewinding.
  // applyAt diffs the scene, so swapping caches updates objects in place.
  function retimeTo(pos: number): void {
    const top = maxBeats || 0
    pos = Math.min(Math.max(0, pos), top)
    pausedBeat = Math.min(pausedBeat, top)
    if (state === 'playing') anchor(pos)
    scrubber.value = String(pos)
    setFill(pos)
    showIndex(pos)
    if (hasContent()) {
      applyAt(pos)
    } else {
      sceneAPI.reset()
      hydraAPI.reset()
      aliveObjects = new Set()
    }
  }

  // Swap in a freshly cooked frame cache (+ optional timeline). A re-evaluate
  // does NOT move the playhead: keep the current position and play state, only
  // replacing the baked data. (First load is at 0 because that's where we are.)
  function load(sceneRows: Row[], timelineRows: Row[], hydraRows: Row[]): void {
    frameIndex = buildFrameIndex(sceneRows ?? [])
    hydraIndex = buildHydraIndex(hydraRows ?? [])
    timeline = buildTimeline(timelineRows ?? [])
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

  scrubber.addEventListener('input', () => {
    isScrubbing = true
    const pos = parseFloat(scrubber.value)
    showIndex(pos)
    setFill(pos)
    if (hasContent()) applyAt(pos)
  })

  window.addEventListener('pointerup', () => {
    if (!isScrubbing) return
    isScrubbing = false
    const pos = parseFloat(scrubber.value)
    pausedBeat = pos
    if (state === 'playing') anchor(pos)
  })

  btn.onclick = toggle

  function toggle(): void {
    if (!hasContent()) return
    if (state === 'playing') {
      state = 'paused'
      pausedBeat = position()
      btn.textContent = '▶'
      btn.title = 'Play'
    } else if (state === 'paused') {
      state = 'playing'
      anchor(pausedBeat)
      btn.textContent = '⏸'
      btn.title = 'Pause'
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
    const aligned = wallAlignedPhase() ?? 0
    reset(aligned)
    pausedBeat = aligned
    anchor(aligned)
    state = 'playing'
    btn.textContent = '⏸'
    btn.title = 'Pause'
    onPlay?.()
    tick()
  }

  // The live playhead, in beats, at the anchored tempo.
  function position(): number {
    return (performance.now() - (startTime ?? 0)) / 1000 / anchorBeatSec
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

    showIndex(pos)

    if (!isScrubbing) {
      scrubber.value = String(Math.min(pos, maxBeats))
      setFill(Math.min(pos, maxBeats))
    }

    applyAt(pos)

    if (!loop && pos >= maxBeats) {
      scrubber.value = String(maxBeats)
      setFill(maxBeats)
      showIndex(maxBeats)
      state = 'idle'
      pausedBeat = maxBeats // so a re-cook keeps the playhead at the end
      btn.textContent = '▶'
      btn.title = 'Play'
      return
    }

    requestAnimationFrame(tick)
  }

  return { load, retempo, currentSourceBeats }
}
