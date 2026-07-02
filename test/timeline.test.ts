import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTimeline, warpKeyframes, paceEvents } from '../src/timeline.js'
import { createRuntime } from '../src/runtime.js'
import { cookProgram, cookTimeline } from '../src/replay.js'

const f = (frames: number): number => frames / 60

test('no timeline rows → identity mapping, length 0', () => {
  const tl = buildTimeline([])
  assert.equal(tl.length, 0)
  assert.equal(tl.frameAt(0), 0)
  assert.equal(tl.frameAt(7), 7)
  assert.equal(tl.frameAt(3.9), 3, 'floors fractional ticks')
})

test('maps tick → source frame via time field (seconds), clamping the tick', () => {
  const tl = buildTimeline([{ time: f(10) }, { time: f(20) }, { time: f(30.6) }])
  assert.equal(tl.length, 3)
  assert.equal(tl.frameAt(0), 10)
  assert.equal(tl.frameAt(1), 20)
  assert.equal(tl.frameAt(2), 31, 'frame value is rounded')
  assert.equal(tl.frameAt(1.8), 20, 'fractional tick floors to its row')
  assert.equal(tl.frameAt(99), 31, 'tick past the end clamps to the last row')
  assert.equal(tl.frameAt(-5), 10, 'negative tick clamps to the first row')
})

test('loop: first second (60 frames) repeats across a 6-second timeline', () => {
  const rows = Array.from({ length: 360 }, (_, i) => ({ time: (i / 60) % 1 }))
  const tl = buildTimeline(rows)
  assert.equal(tl.length, 360)
  assert.equal(tl.frameAt(0), 0)
  assert.equal(tl.frameAt(59), 59)
  assert.equal(tl.frameAt(60), 0, 'wraps back to the start')
  assert.equal(tl.frameAt(125), 5)
})

test('reverse: time runs backwards', () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ time: (99 - i) / 60 }))
  const tl = buildTimeline(rows)
  assert.equal(tl.frameAt(0), 99)
  assert.equal(tl.frameAt(99), 0)
  assert.equal(tl.frameAt(40), 59)
})

test('falls back to identity when a row omits time', () => {
  const tl = buildTimeline([{}, {}, {}])
  assert.equal(tl.frameAt(2), 2)
})

test('cookProgram surfaces timelineRows from a defined timeline view', () => {
  const rt = createRuntime()
  const code = `
    define("base", () => rows([{ id: "s", type: "create", index: 0, shape: "sphere",
      color: 0x4a9eff, px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 }]))
    define("scene", () => table("base").rasterize(2))
    define("timeline", () => math(t => t % 0.5).range(2).map(r => ({ time: r.value })))
  `
  const cooked = cookProgram(rt, code, 1)
  assert.equal(cooked.timelineRows.length, 120)
  const tl = buildTimeline(cooked.timelineRows)
  assert.equal(tl.frameAt(31), 1, 'looped timeline drives the mapping')
})

test('cookProgram yields no timeline rows when none is defined', () => {
  const rt = createRuntime()
  const code = `
    define("events", () => rows([{ id: "s", type: "create", index: 0, shape: "box",
      color: 1, px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 }]))
  `
  const cooked = cookProgram(rt, code, 1)
  assert.deepEqual(cooked.timelineRows, [])
  assert.equal(buildTimeline(cooked.timelineRows).length, 0)
})

test('a beats() timeline reflects the tap-beat tempo', () => {
  const tapRows = [{ beat: 0, time: 0 }, { beat: 1, time: 0.5 }] // 0.5s/beat = 120 BPM
  const rt = createRuntime({ tapRows: () => tapRows })
  const code = `
    define("base", () => rows([{ id: "s", type: "create", index: 0, shape: "sphere",
      color: 0x4a9eff, px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 }]))
    define("scene", () => table("base").rasterize(2))
    define("timeline", () => beats(4))
  `
  const cooked = cookProgram(rt, code, 1)
  assert.equal(cooked.timelineRows.length, 120, '4 beats * 0.5s * 60fps')
})

test('cookTimeline recomputes only the timeline (skips the rest)', () => {
  const tapRows = [{ beat: 0, time: 0 }, { beat: 1, time: 0.5 }]
  const rt = createRuntime({ tapRows: () => tapRows })
  const code = `
    define("base", () => rows([{ id: "s", type: "create", index: 0, shape: "sphere",
      color: 0x4a9eff, px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 }]))
    define("boom", () => { throw new Error("should not cook this") })
    define("scene", () => table("base").rasterize(2))
    define("timeline", () => beats(4))
  `
  const rows = cookTimeline(rt, code, 1)
  assert.equal(rows.length, 120, '"boom" was never cooked')
})

test('cookTimeline returns [] when no timeline is defined', () => {
  const rt = createRuntime()
  const code = `define("base", () => rows([{ id: "s" }]))`
  assert.deepEqual(cookTimeline(rt, code, 1), [])
})

// ── warpKeyframes ────────────────────────────────────────────────────────────

test('warpKeyframes: identity mapping over one linear segment', () => {
  const rows = warpKeyframes([{ src: 0, dst: 0 }, { src: 2, dst: 2 }])
  assert.equal(rows.length, 121, '2s of playback at 60fps, inclusive')
  assert.equal(rows[0].time, 0)
  assert.ok(Math.abs((rows[60].time as number) - 1) < 1e-9)
  assert.equal(rows[120].time, 2)
})

test('warpKeyframes: compresses 4 source seconds into 2 playback seconds (2× speed)', () => {
  const rows = warpKeyframes([{ src: 0, dst: 0 }, { src: 4, dst: 2 }])
  assert.equal(rows.length, 121, 'playback length follows dst, not src')
  assert.ok(Math.abs((rows[60].time as number) - 2) < 1e-9)
})

test('warpKeyframes: per-keyframe ease shapes the segment to the next keyframe', () => {
  const rows = warpKeyframes([{ src: 0, dst: 0, ease: (t: number) => t * t }, { src: 1, dst: 1 }])
  assert.ok(Math.abs((rows[30].time as number) - 0.25) < 1e-9, 'half way in dst is a quarter way in src')
})

test('warpKeyframes: string eases resolve through the easings lookup, defaulting to linear', () => {
  const easings = { easeIn: (t: number) => t * t }
  const rows = warpKeyframes(
    [{ src: 0, dst: 0, ease: 'easeIn' }, { src: 1, dst: 1 }],
    { easings },
  )
  assert.ok(Math.abs((rows[30].time as number) - 0.25) < 1e-9)
  const unknown = warpKeyframes([{ src: 0, dst: 0, ease: 'nope' }, { src: 1, dst: 1 }])
  assert.ok(Math.abs((unknown[30].time as number) - 0.5) < 1e-9, 'unknown name falls back to linear')
})

test('warpKeyframes: sorts by dst, reverses when src runs backwards, holds before the first keyframe', () => {
  const rows = warpKeyframes([{ src: 0, dst: 3 }, { src: 2, dst: 1 }]) // given out of order
  assert.equal(rows.length, 181)
  assert.equal(rows[0].time, 2, 'holds the first keyframe src before its dst')
  assert.equal(rows[30].time, 2)
  assert.ok(Math.abs((rows[120].time as number) - 1) < 1e-9, 'src runs 2 → 0 across dst 1 → 3')
  assert.equal(rows[180].time, 0)
})

test('warpKeyframes: empty / non-keyframe rows yield no timeline', () => {
  assert.deepEqual(warpKeyframes([]), [])
  assert.deepEqual(warpKeyframes([{ time: 1 }]), [])
})

// ── paceEvents ───────────────────────────────────────────────────────────────

test('paceEvents: a cycling speed array alternates slow/fast between events', () => {
  const events = [{ index: 1 }, { index: 2 }]
  const rows = paceEvents(events, { until: 3, speed: [0.5, 2] })
  // segments: (0→1)@0.5 → 2s, (1→2)@2 → 0.5s, (2→3)@0.5 → 2s = 4.5s playback
  assert.equal(rows.length, 271)
  assert.ok(Math.abs((rows[120].time as number) - 1) < 1e-9, '2s of playback reaches the first event')
  assert.ok(Math.abs((rows[150].time as number) - 2) < 1e-9, '0.5s later playback reaches the second')
  assert.equal(rows[270].time, 3)
})

test('paceEvents: duplicate event times collapse to one boundary', () => {
  const events = [{ index: 1 }, { index: 1 }, { index: 1 }]
  const rows = paceEvents(events, { until: 2, speed: [2, 2] })
  assert.equal(rows.length, 61, 'two 1s segments at 2× = 1s playback')
})

test('paceEvents: speed as a function of the segment and its span', () => {
  const rows = paceEvents([{ index: 1 }], {
    until: 3,
    speed: (seg, { from, to }) => (seg === 0 ? 1 : to - from), // second segment spans 2s → 2×
  })
  assert.equal(rows.length, 121, '1s + 2s/2 = 2s playback')
  assert.ok(Math.abs((rows[60].time as number) - 1) < 1e-9)
})

test('paceEvents: custom time field, until defaults to the last event', () => {
  const rows = paceEvents([{ t: 1 }, { t: 2 }], { at: 't', speed: 1 })
  assert.equal(rows.length, 121, 'runs to the last event time')
  assert.ok(Math.abs((rows[60].time as number) - 1) < 1e-9)
})

test('paceEvents: no events → one uniform segment over [0, until]', () => {
  const rows = paceEvents([], { until: 2, speed: 2 })
  assert.equal(rows.length, 61)
  assert.ok(Math.abs((rows[30].time as number) - 1) < 1e-9)
})

test('paceEvents: events at 0, past until, or non-numeric are ignored; bad speeds fall back to 1', () => {
  const rows = paceEvents(
    [{ index: 0 }, { index: 5 }, { index: 'x' }, { index: 1 }],
    { until: 2, speed: [0, -3] },
  )
  assert.equal(rows.length, 121, 'both segments play at speed 1')
  assert.deepEqual(paceEvents([{ index: 1 }], { until: 0 }), [])
})

test('a pace() timeline view warps playback speed between collision events', () => {
  const rt = createRuntime()
  const code = `
    define("base", () => rows([{ id: "s", type: "create", index: 0, shape: "sphere",
      color: 0x4a9eff, px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 }]))
    define("scene", () => table("base").rasterize(3))
    define("hits", () => rows([
      { id: "a", type: "collision", index: 1 },
      { id: "b", type: "collision", index: 1 },
      { id: "a", type: "collision", index: 2 },
    ]))
    define("timeline", (rand, table) =>
      table("hits").filter(field("type").eq("collision")).pace({ until: 3, speed: [0.5, 2] }))
  `
  const cooked = cookProgram(rt, code, 1)
  assert.equal(cooked.timelineRows.length, 271, 'slow-fast-slow: 2s + 0.5s + 2s of playback')
  const tl = buildTimeline(cooked.timelineRows)
  assert.equal(tl.frameAt(120), 60, '2s of playback reaches source frame 60 (the first collision)')
  assert.equal(tl.frameAt(150), 120, '0.5s later playback reaches the second collision')
})

test('a retime() timeline view rasterizes keyframe rows, resolving DSL eases', () => {
  const rt = createRuntime()
  const code = `
    define("base", () => rows([{ id: "s", type: "create", index: 0, shape: "box",
      color: 1, px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 }]))
    define("scene", () => table("base").rasterize(2))
    define("timeline", () => rows([
      { src: 0, dst: 0, ease: easeIn },
      { src: 2, dst: 1 },
    ]).retime())
  `
  const cooked = cookProgram(rt, code, 1)
  assert.equal(cooked.timelineRows.length, 61, 'playback runs to the last keyframe dst')
  assert.ok(Math.abs((cooked.timelineRows[30].time as number) - 0.5) < 1e-9, 'easeIn: quarter of src at half dst')
})
