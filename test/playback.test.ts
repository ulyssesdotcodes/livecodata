import { test } from 'node:test'
import assert from 'node:assert/strict'
import { wallAlignedTick } from '../src/playback.js'

test('wallAlignedTick is 0 exactly at the anchor instant', () => {
  assert.equal(wallAlignedTick(1000, 1000, 4), 0)
})

test('wallAlignedTick advances linearly with elapsed wall time', () => {
  assert.equal(wallAlignedTick(1000 + 1500, 1000, 4), 1.5)
})

test('wallAlignedTick wraps into [0, loopSeconds) past one loop', () => {
  assert.equal(wallAlignedTick(1000 + 4500, 1000, 4), 0.5)
  assert.equal(wallAlignedTick(1000 + 4000 * 3 + 500, 1000, 4), 0.5, 'wraps across multiple loops the same way')
})

test('wallAlignedTick handles "now" before the anchor (still non-negative)', () => {
  assert.equal(wallAlignedTick(1000 - 500, 1000, 4), 3.5)
})

test('wallAlignedTick returns 0 for a non-positive loop length', () => {
  assert.equal(wallAlignedTick(5000, 1000, 0), 0)
  assert.equal(wallAlignedTick(5000, 1000, -4), 0)
})

test('two independent "clients" sharing an anchor land on the same phase at the same wall time', () => {
  const anchorMs = 123456
  const loopSeconds = 2
  const nowMs = anchorMs + 7777
  // Client A "started" a while ago, client B just started — irrelevant to the
  // wall-aligned phase, which only depends on the shared anchor + now.
  const phaseA = wallAlignedTick(nowMs, anchorMs, loopSeconds)
  const phaseB = wallAlignedTick(nowMs, anchorMs, loopSeconds)
  assert.equal(phaseA, phaseB)
})

// ---------------------------------------------------------------------------
// Engine tests — the timing/loop/scrub state machine, driven deterministically
// through the injectable clock (see PlaybackClock in playback.ts).
// ---------------------------------------------------------------------------

import { createPlaybackEngine, type PlaybackEngine, type TapControl } from '../src/playback.js'
import { createSceneVisualizer, createHydraVisualizer } from '../src/visualizer.js'
import { DEFAULT_BEAT_SECONDS, DEFAULT_LOOP_BEATS } from '../src/constants.js'
import type { Row } from '../src/lineage.js'

function fakeScene() {
  return {
    calls: [] as string[],
    createObject(): void { this.calls.push('create') },
    updateObject(): void { this.calls.push('update') },
    destroyObject(): void { this.calls.push('destroy') },
    reset(): void { this.calls.push('reset') },
  }
}

function fakeHydra() {
  return {
    ticks: [] as number[],
    setSketch(): void { /* recorded implicitly via ticks */ },
    tick(t: number): void { this.ticks.push(t) },
    reset(): void { /* noop */ },
  }
}

// One shared fake time source: monotonic and epoch clocks advance together,
// and raf callbacks queue until frame() runs them.
function fakeTime(startMs: number) {
  let t = startMs
  const queue: Array<() => void> = []
  return {
    clock: {
      now: () => t,
      epochNow: () => t,
      raf: (cb: () => void) => { queue.push(cb) },
    },
    advance(ms: number): void { t += ms },
    frame(): void { for (const cb of queue.splice(0)) cb() },
  }
}

// A hydra-only program: content exists (so playback runs) and the loop length
// comes from loopBeats (DEFAULT_LOOP_BEATS unless set), with no scene rows to
// stage.
const HYDRA_ROWS: Row[] = [{ event: 'setCode', code: 'osc().out()', beat: 1 }]

function makeEngine(time: ReturnType<typeof fakeTime>, extra: { tapControl?: TapControl; onLoop?: () => void } = {}): PlaybackEngine {
  const engine = createPlaybackEngine(
    [createSceneVisualizer(fakeScene()), createHydraVisualizer(fakeHydra())],
    { clock: time.clock, ...extra },
  )
  engine.load({ sceneRows: [], timelineRows: [], hydraRows: HYDRA_ROWS })
  return engine
}

test('pressing play joins the wall-aligned beat grid instead of starting at 0', () => {
  // Epoch 1000ms into an 8s loop (16 beats × 0.5 s/beat) → phase 2 beats.
  const time = fakeTime(1000)
  const engine = makeEngine(time)
  engine.toggle()
  const vs = engine.viewState()
  assert.equal(vs.state, 'playing')
  assert.equal(vs.pos, (1 / (DEFAULT_LOOP_BEATS * DEFAULT_BEAT_SECONDS) % 1) * DEFAULT_LOOP_BEATS)
  assert.equal(vs.pos, 2)
})

test('the playhead advances at the anchored tempo, one frame at a time', () => {
  const time = fakeTime(1000)
  const engine = makeEngine(time)
  engine.toggle() // playing at pos 2
  time.advance(1000) // +2 beats at 0.5 s/beat
  time.frame()
  assert.equal(engine.viewState().pos, 4)
})

test('pause freezes the position; resume continues from it', () => {
  const time = fakeTime(1000)
  const engine = makeEngine(time)
  engine.toggle()
  time.advance(1000)
  time.frame()
  engine.toggle() // pause at 4
  assert.equal(engine.viewState().state, 'paused')
  time.advance(5000)
  assert.equal(engine.viewState().pos, 4, 'paused position ignores wall time')
  engine.toggle() // resume
  assert.equal(engine.viewState().pos, 4)
  time.advance(500)
  time.frame()
  assert.equal(engine.viewState().pos, 5)
})

test('a loop wrap re-derives the wall-aligned phase and fires onLoop', () => {
  const time = fakeTime(1000)
  let loops = 0
  const engine = makeEngine(time, { onLoop: () => loops++ })
  engine.toggle() // pos 2, startTime anchored so position() = 2
  // Push position past the 16-beat end: 15 more beats of wall time.
  time.advance(7500) // position() = 17; epoch = 8500 → phase (8.5 % 8)/0.5 = 1
  time.frame()
  assert.equal(loops, 1)
  assert.equal(engine.viewState().pos, 1, 'wrap lands on the wall-aligned phase, not just pos % maxBeats')
})

test('with loop off, reaching the end parks the playhead at maxBeats and goes idle', () => {
  const time = fakeTime(0)
  const engine = makeEngine(time)
  engine.setLoop(false)
  engine.toggle() // phase 0 at epoch 0
  time.advance(DEFAULT_LOOP_BEATS * DEFAULT_BEAT_SECONDS * 1000 + 100)
  time.frame()
  const vs = engine.viewState()
  assert.equal(vs.state, 'idle')
  assert.equal(vs.pos, DEFAULT_LOOP_BEATS)
})

test('scrub previews the dragged position (thumb frozen at the drag)', () => {
  const time = fakeTime(0)
  const engine = makeEngine(time)
  engine.scrub(3)
  const vs = engine.viewState()
  assert.equal(vs.scrubPos, 3)
  assert.equal(vs.pos, 3)
})

test('scrubbing while paused commits the playhead for the next resume', () => {
  const time = fakeTime(1000)
  const engine = makeEngine(time)
  engine.toggle() // playing at 2
  engine.toggle() // paused at 2
  engine.scrub(6)
  engine.endScrub()
  assert.equal(engine.viewState().pos, 6)
  engine.toggle() // resume from the scrubbed beat
  time.advance(500)
  time.frame()
  assert.equal(engine.viewState().pos, 7)
})

test('setLoopBeats clamps to a whole beat >= 1 and resizes a hydra-only loop', () => {
  const time = fakeTime(0)
  const engine = makeEngine(time)
  engine.setLoopBeats(2.4)
  assert.equal(engine.viewState().loopBeats, 2)
  assert.equal(engine.viewState().maxBeats, 2)
  engine.setLoopBeats(0)
  assert.equal(engine.viewState().loopBeats, DEFAULT_LOOP_BEATS)
})

test('retempo re-anchors to the new tapped tempo without moving a paused playhead', () => {
  const time = fakeTime(1000)
  let taps: Row[] = []
  const tapControl: TapControl = {
    tap: () => {},
    clear: () => {},
    rows: () => taps,
    anchor: () => (taps.length >= 2 ? (taps[0].time as number) : null),
  }
  const engine = makeEngine(time, { tapControl })
  engine.toggle() // playing at 2 (default tempo)
  engine.toggle() // paused at 2
  taps = [{ beat: 0, time: 1000 }, { beat: 1, time: 1250 }] // 0.25 s/beat → 240 bpm
  engine.retempo()
  const vs = engine.viewState()
  assert.equal(vs.pos, 2, 'paused playhead keeps its beat position across a tempo change')
  assert.equal(vs.bpm, 240)
  // Resume: the clock now advances at the new tempo.
  engine.toggle()
  time.advance(250)
  time.frame()
  assert.equal(engine.viewState().pos, 3)
})
