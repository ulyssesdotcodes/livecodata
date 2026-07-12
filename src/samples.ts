// Sample programs for the livecodata editor. CSV datasets are served from
// /data/ and loaded at run time via data(url) — no inline embedding needed.
export const SAMPLES = [
  {
    name: "Editable Table",
    code: `// livecodata — a sphere moved by an editable table
// Unlike every other example here, the path below isn't computed by code —
// it's data you edit directly, live, in the table panel on the right.
// Press "Run" (or Cmd/Ctrl-Enter), then hit Play under the scene.

// 1. editable(name, schema, seedRows?) declares a user-editable table: rows
//    are entered/edited in the table panel (its own "path" tab), not
//    computed — edits persist across runs, unlike a normal view. Each keyframe
//    sits on a beat (1-indexed: beat 1 is the top of the loop). Try it: open
//    the "path" tab, click a cell to change a coordinate, or hit "+ row" to
//    add a keyframe, then press Run again to see the sphere follow the new
//    path. (Every edit is recorded as an event too — see the "path·events" tab.)
define("path", () =>
  editable("path", { beat: "number", px: "number", py: "number", pz: "number" }, [
    { beat: 1, px: -1, py: 0,   pz: 0 },
    { beat: 3, px: 1,  py: 1,   pz: 0 },
    { beat: 5, px: 0,  py: 0.3, pz: -1 },
  ])
)

// 2. Turn the path's keyframes into a moving sphere: the first row (sorted by
//    beat, in case rows were added out of order) creates it; every later row
//    is an update, and playback interpolates position between consecutive
//    rows by their \`beat\`.
define("events", (rand, table) =>
  table("path").orderBy("beat").map((r, i) => ({
    id: "ball", type: i === 0 ? "create" : "update", beat: r.beat,
    shape: "sphere", color: 0x4a9eff, px: r.px, py: r.py, pz: r.pz, rx: 0, ry: 0, rz: 0,
  }))
)

// 3. Bake the sparse keyframes into a dense per-frame cache for playback —
//    8 beats long, so the sphere holds its last pose before the loop wraps.
define("scene", (rand, table) => table("events").rasterize(8))
`,
  },
  {
    name: "Origami Crane",
    code: `// livecodata — Origami Crane, part 1: square base, then the petal fold
// A square of paper folds itself from a STATIC TABLE OF CREASES: every row
// is one crease, given outright — no folded-model bookkeeping, nothing
// inferred. Press "Run" (or Cmd/Ctrl-Enter), then hit Play.
//
// The table ("steps" in the table panel):
//   step    the fold's name. Rows sharing a name are one fold whose crease
//           runs through several layers; rows with no p1/p2 re-drive it
//           (keyframes along a collapse's path)
//   p1,p2   the crease, a literal segment in sheet coordinates "x,y"
//           (the sheet spans [-1,1]²)
//   move    sample points ("x,y", ";"-separated) inside the pieces this
//           crease rotates — only pieces TOUCHING it; everything attached
//           rides along through the hinge tree
//   sign    which way this crease turns for positive fractions (flipping
//           it = swapping p1/p2). Layers of a stack often need opposite
//           senses — that is what makes a collapse work at all; if a flap
//           tears away mid-fold, flip its crease's sign
//   deg     the fold's full signed angle (±180 = flat)
//   at,dur,to  timing, and how far to drive (1 folded, 0 open, −1 folded
//           the other way; a row with dur 0 is geometry only)
// Fractions are per STEP, so driving "s1" moves its crease on every layer
// at once; the player hinges faces about the material crease lines and
// WELDS shared points, so an impossible pose reads as paper strain, never
// a tear. (Nothing checks fold-through-ability yet — that's planned.)
//
// THE SQUARE BASE (beats 1–14.5): fold the triangle (the diagonal written
// as two steps, "spine" and "still", so the collapse can drive its halves
// apart), then squash around the middle — "s1" and the halving valley
// "hv" rise as the pocket while the spine opens — press flat right, the
// same on the other side ("s2"), press left: the classic base, POINT DOWN.
//
// THE PETAL FOLD (beats 14.6–16, instructables crane steps 7 and 8): a
// valley across the front face between (−0.586,0) and (0,0.586) — √2−1
// along each top edge, exactly where the bottom edges land if folded to
// the centre line — and mountains from those points to the bottom corner
// ("kite"/"kite2"). The flap lifts, the wings wrap the side corners onto
// the centre line, and the wings peel off the middle layers — the "peel"
// steps open just the front layer's ridge creases (they lie on the valley,
// so the lift unfolds them exactly; the back's stay pressed). These are
// SINGLE folds: the back face doesn't move until its own petal, from the
// back corner, repeats the same lines ("kite3"/"kite4"/"petal2"). The
// paper lands in the exact BIRD BASE — the petalled corners at the tip,
// the middle flaps' corners still at the base's point, everything flat to
// ~1e-5 — bending a little mid-lift, as real paper must (the petal fold is
// famously not rigid-foldable).

define("steps", () => {
  // 0.5857864376 = 2−√2: where the petal's valley meets the medians.
  // keyframes shared by every layer of a crease: [at, dur, to]
  const kf = (steps, tl) => steps.flatMap((step) =>
    tl.map(([at, dur, to]) => ({ step, at, dur, to })))
  return editable("steps", {
    step: "string", p1: "string", p2: "string", move: "string",
    sign: "number", deg: "number", at: "number", dur: "number", to: "number",
  }, [
    // ── the creases ──
    // the triangle fold: the diagonal, in two drivable halves
    { step: "spine", p1: "0,0", p2: "1,1", move: "0.5286,0.3333", sign: 1, deg: 180, at: 1, dur: 2, to: 1 },
    { step: "still", p1: "-1,-1", p2: "0,0", move: "-0.3333,-0.5286", sign: 1, deg: 180, at: 1, dur: 2, to: 1 },
    // the squash folds, one crease per layer
    { step: "s1", p1: "0,0.5857864376", p2: "0,0", move: "0.3333,0.5286", sign: 1, deg: 180, at: 4, dur: 0.5, to: -0.18 },
    { step: "s1", p1: "0.5857864376,0", p2: "0,0", move: "0.5286,0.3333", sign: -1 },
    { step: "hv", p1: "1,-1", p2: "0,0", move: "0.2929,-0.0976", sign: -1, deg: 90, at: 4, dur: 0.5, to: 0.248 },
    { step: "s2", p1: "-0.5857864376,0", p2: "0,0", move: "-0.5286,-0.3333", sign: 1, deg: -180, at: 9.5, dur: 0.25, to: -0.125 },
    { step: "s2", p1: "0,-0.5857864376", p2: "0,0", move: "-0.3333,-0.5286", sign: -1 },
    // the petal fold, front: mountains, valley, and the ridge peels
    { step: "kite", p1: "-1,1", p2: "-0.5857864376,0", move: "-0.8619,0.3333", sign: 1, deg: -180, at: 14.6, dur: 0.65, to: 1 },
    { step: "kite", p1: "-1,-1", p2: "-0.5857864376,0", move: "-0.8619,-0.3333", sign: -1 },
    { step: "kite2", p1: "1,1", p2: "0,0.5857864376", move: "0.3333,0.8619", sign: -1, deg: 180, at: 14.6, dur: 0.65, to: 1 },
    { step: "kite2", p1: "-1,1", p2: "0,0.5857864376", move: "-0.3333,0.8619", sign: 1 },
    { step: "petal", p1: "-0.5857864376,0", p2: "0,0.5857864376", move: "-0.5286,0.5286", sign: 1, deg: 180, at: 14.6, dur: 0.65, to: 1 },
    { step: "peelfr", p1: "0,1", p2: "0,0.5857864376", move: "0.3333,0.8619", sign: 1, deg: 180, at: 4, dur: 0.5, to: -0.18 },
    { step: "peelfl", p1: "-1,0", p2: "-0.5857864376,0", move: "-0.8619,-0.3333", sign: 1, deg: -180, at: 9.5, dur: 0.25, to: -0.125 },
    // the petal fold, back: the same lines from the back corner
    { step: "kite3", p1: "-1,-1", p2: "0,-0.5857864376", move: "-0.3333,-0.8619", sign: 1, deg: -180, at: 15.35, dur: 0.65, to: 1 },
    { step: "kite3", p1: "1,-1", p2: "0,-0.5857864376", move: "0.3333,-0.8619", sign: -1 },
    { step: "kite4", p1: "1,-1", p2: "0.5857864376,0", move: "0.8619,-0.3333", sign: -1, deg: 180, at: 15.35, dur: 0.65, to: 1 },
    { step: "kite4", p1: "1,1", p2: "0.5857864376,0", move: "0.8619,0.3333", sign: 1 },
    { step: "petal2", p1: "0,-0.5857864376", p2: "0.5857864376,0", move: "0.4310,-0.6262;0.6262,-0.4310", sign: -1, deg: 180, at: 15.35, dur: 0.65, to: 1 },
    { step: "peelbr", p1: "1,0", p2: "0.5857864376,0", move: "0.8619,0.3333", sign: -1, deg: 180, at: 4, dur: 0.5, to: -0.18 },
    { step: "peelbl", p1: "0,-1", p2: "0,-0.5857864376", move: "-0.3333,-0.8619", sign: -1, deg: -180, at: 9.5, dur: 0.25, to: -0.125 },

    // ── the collapse, keyframed along the squash's solved path ──
    // squash 1 + press right (the peels are the same physical creases as
    // s1/s2, so they carry the same keyframes until their petal opens them)
    ...kf(["s1", "peelfr", "peelbr"], [
      [4.5, 0.5, -0.39], [5, 0.5, -0.659], [5.5, 0.5, -0.9645],
      [6.5, 0.5, -0.9945], [7, 0.5, -0.997], [7.5, 0.5, -0.998],
      [8, 0.5, -0.9985], [8.5, 0.5, -1],
    ]),
    ...kf(["hv"], [
      [4.5, 0.5, 0.498], [5, 0.5, 0.744], [5.5, 0.5, 0.95],
      [6.5, 0.5, 0.83], [7, 0.5, 0.712], [7.5, 0.5, 0.474],
      [8, 0.5, 0.238], [8.5, 0.5, 0],
      [9.5, 0.25, 0.176], [9.75, 0.5, 0.484], [10.25, 0.25, 0.61],
      [10.5, 0.75, 0.914], [11.25, 0.25, 0.958],
      [12.5, 0.5, 0.718], [13, 0.5, 0.48], [13.5, 0.5, 0.24], [14, 0.5, 0],
    ]),
    ...kf(["spine"], [
      [4, 2, 0], [6.5, 0.5, -0.163], [7, 0.5, -0.284],
      [7.5, 0.5, -0.526], [8, 0.5, -0.763], [8.5, 0.5, -1],
    ]),
    // squash 2 + press left
    ...kf(["s2", "peelfl", "peelbl"], [
      [9.75, 0.5, -0.375], [10.25, 0.25, -0.5], [10.5, 0.75, -0.875], [11.25, 0.25, -1],
    ]),
    ...kf(["still"], [
      [9.5, 0.25, 0.825], [9.75, 0.5, 0.518], [10.25, 0.25, 0.392],
      [10.5, 0.75, 0.089], [11.25, 0.25, -0.044],
      [12.5, 0.5, -0.283], [13, 0.5, -0.523], [13.5, 0.5, -0.762], [14, 0.5, -1],
    ]),
    // the peels: each petal's lift unfolds its own side's ridges
    ...kf(["peelfr", "peelfl"], [[15.05, 0.2, 0]]),
    ...kf(["peelbr", "peelbl"], [[15.8, 0.2, 0]]),
  ])
})

// Feed the creases to a sheet of paper. One steady three-quarter view for
// the whole sequence, rotated so the finished base sits POINT DOWN — the
// paper starts as a diamond, the way the diagrams hold it. (Add "update"
// rows with rx/ry/rz to re-pose the paper mid-sequence.)
define("events", (rand, table) => {
  const paper = origami().steps(table("steps"))
  return paper.spawn({ id: "base", color: 0xd94f2a, py: 0.15, pz: 1.2, rx: -0.9, ry: 0, rz: 2.356 })
    .concat(paper.sequence())
})

// Bake to a 16-beat loop cache — when the loop wraps, the paper opens flat
// and folds itself all over again.
define("scene", (rand, table) => table("events").rasterize(16))

// A whisper of video feedback (the rendered scene is hydra's s0) so the
// paper leaves faint trails as it moves. Delete this view for a clean look.
define("hydra", () => rows([
  { beat: 1, event: "setCode",
    code: "src(s0).blend(src(o0).scale(1.003), 0.18).out(o0)" },
]))

// Things to try, live in the "steps" tab:
//   - Delete the s1/hv keyframes after the first of each: the squash stops
//     a quarter of the way in and holds — scrub to study the mechanism.
//   - Drive "hv" to 0.95 again at beat 17 and the bird base opens its beak.
//   - Slide a crease: nudge the petal's p1/p2 endpoints and the wings no
//     longer land on the centre line — the paper visibly strains around
//     the misplaced mechanism, because every other crease is exactly where
//     the real fold needs it.
`,
  },
  {
    name: "Hydra Sketch",
    code: `// livecodata — a video-synth sketch with hydra (hydra-ts, a port of ojack's hydra)
// A generative hydra sketch — no 3D scene involved (see "House of Cards" for
// hydra post-processing a rendered scene via src(s0)). Press "Run" (or
// Cmd/Ctrl-Enter), then hit Play.

// A hydra table is a stream of EVENTS, each placed on the loop by its \`beat\`
// (1-indexed: beat 1 is the top of the loop). Two kinds:
//   - setCode:     \`code\` becomes the sketch — a string ending in .out(o0).
//   - setVariable: \`name\`/\`value\` sets one variable in scope while the sketch
//                  runs (e.g. freq below) — the most-recent value at each
//                  beat wins, same as setCode's code.
// Reference a variable as a FUNCTION — (props) => props.freq — rather than
// the bare name: hydra calls it fresh every frame, so the value tracks the
// table live, during playback, with no recompile/rerun. A bare \`freq\` would
// only ever see the value from when the sketch was compiled.
// Pick variable names that aren't hydra's OWN per-frame fields (time, bpm,
// fps, resolution, speed, stats) — those always win over an injected value
// of the same name, so e.g. naming this variable \`speed\` would silently be
// overridden by hydra's own playback-speed multiplier instead of your data.
//
// The loop is as many beats long as the "beats" control under the scene (16
// by default). So the freq change at beat 9 comes in halfway through the loop
// (the start of the 3rd measure) and stays until the loop wraps. Tap to
// change the tempo (how long a beat lasts); change "beats" to make the loop
// longer/shorter.
//
// editable(name, schema, seedRows?) makes this table live-editable in the
// table panel — it's the ONLY table this sketch needs (named "hydra" so
// playback reads it directly, with no code-generated view in between): click
// the code cell to open the sketch in this editor; edit a value cell, or "+
// row" a new setVariable event at a later beat (like the row below, at beat
// 9) right in the table — no code change needed, and any column you add via
// "+ column" survives the next Run too. (Every edit is an event too — see the
// "hydra·events" tab.) A second, code-generated table only becomes useful
// once you need to LAYER computed events on top of these — see "House of
// Cards" for that.
editable("hydra", { beat: "number", event: "string", code: "code", name: "string", value: "number" }, [
  { beat: 1, event: "setCode",
    code: "osc((props) => props.freq, 0.1, 1.5).kaleid(5).out(o0)" },
  { beat: 1, event: "setVariable", name: "freq", value: 3 },
  { beat: 9, event: "setVariable", name: "freq", value: 12 },
])
`,
  },
  {
    name: "House of Cards",
    code: `// livecodata — House of Cards
// A triangular pyramid of playing cards collapses when a ball drops on it.
// Press "Run" (or Cmd/Ctrl-Enter), then hit Play under the scene.
// Tips: Ctrl-Space completes views, Table verbs, and Expr methods (the methods
// after field()/lit()/idx() — e.g. field("v").add(1).gt(2)); hover a "view" name
// to preview its table; your caret selects that view's tab on the right.

// 1. Build a 3-story pyramid of cards plus a falling ball.
//    Story k has (n − k) leaning-card tent pairs and (n − k − 1) horizontal
//    bridge cards between them. Card positions are derived analytically from the
//    lean angle so each card's lowest rotated corner rests on its support surface.
define("base", () => {
  const lean = 0.25                    // radians from vertical (~14°)
  const H = 0.35, W = 0.22, T = 0.04  // card half-height, half-width, half-thickness
  const sl = Math.sin(lean), cl = Math.cos(lean)
  const dx    = H * sl                 // card-center x offset from tent apex
  const cyOff = W * sl + H * cl       // support-surface to card-center (no corner overlap)
  const S     = 0.50                   // spacing between adjacent tent apices
  const n     = 3                      // tents on the ground floor (try 4 for ~27 cards)

  const cards = []
  let supportY = -1.0                  // current support surface y (floor to start)

  for (let k = 0; k < n; k++) {
    const numTents = n - k
    const cardCY   = supportY + cyOff
    const topY     = supportY + W * sl + 2 * H * cl  // tent apex y
    const bHx      = S / 2 + 0.03                    // bridge half-span

    // Leaning card pairs — two cards per tent, tops meeting at the apex
    for (let i = 0; i < numTents; i++) {
      const tx = -(numTents - 1) * S / 2 + i * S     // apex x
      cards.push(
        { id: "s" + k + "t" + i + "a", type: "create", shape: "box", color: 0xfdf6e3,
          motion: "dynamic", friction: 0.8, restitution: 0,
          px: tx - dx, py: cardCY, pz: 0, hx: T, hy: H, hz: W, rz: -lean },
        { id: "s" + k + "t" + i + "b", type: "create", shape: "box", color: 0xfdf6e3,
          motion: "dynamic", friction: 0.8, restitution: 0,
          px: tx + dx, py: cardCY, pz: 0, hx: T, hy: H, hz: W, rz:  lean },
      )
    }

    // Horizontal bridge cards spanning adjacent tent apices
    for (let i = 0; i < numTents - 1; i++) {
      const bx = -(numTents - 1) * S / 2 + (i + 0.5) * S
      cards.push(
        { id: "s" + k + "b" + i, type: "create", shape: "box", color: 0xe74c3c,
          motion: "dynamic", friction: 0.8, restitution: 0,
          px: bx, py: topY + T, pz: 0, hx: bHx, hy: T, hz: W },
      )
    }

    // Crown on the top-story apex (replaces bridges on the final story)
    if (k === n - 1) {
      cards.push(
        { id: "crown", type: "create", shape: "box", color: 0xe74c3c,
          motion: "dynamic", friction: 0.8, restitution: 0,
          px: 0, py: topY + T, pz: 0, hx: bHx, hy: T, hz: W },
      )
    }

    supportY = topY + 2 * T  // bridge top surface becomes next story's floor
  }

  return rows([
    { id: "floor", type: "create", shape: "box", color: 0x1a2e1a,
      motion: "static", px: 0, py: -1.2, pz: 0, hx: 4, hy: 0.2, hz: 4 },
    { id: "ball",  type: "create", shape: "sphere", color: 0xf39c12,
      motion: "dynamic", restitution: 0.2, r: 0.12,
      px: 0.05, py: 2.0, pz: 0 },
    ...cards,
  ])
})

// 2. Bake a JoltPhysics simulation in the background: step the world for 360
//    frames (12 beats at the fixed 30-frames-per-beat grid). simulate() ADDS to
//    the table — a per-frame "update" row for each moving body (\`beat\`, in
//    beats; the cache interpolates between them) plus a "collision" row whenever
//    two bodies first touch. Physics runs in real seconds internally and lands
//    its output on the beat grid, so a collision at beat 4 always sits at beat 4.
//    The 3rd arg tags this view into the "events" group: the engine auto-builds
//    a view named "events" that concats every group member (beat-sorted), so
//    multiple simulation views would merge into one "events" table — no manual
//    .concat. "events" is the single sparse stream of object motion + collisions.
define("sim", "events", (rand, table) =>
  physics(table("base")).simulate({ steps: 360, gravity: -9.81 })
)

// 3. Bake the sparse "events" stream into a dense per-frame cache for playback
//    (12 beats — the full simulation).
define("scene", (rand, table) => table("events").rasterize(12))

// 4. Collisions are just rows — pull them into their own view to inspect, and
//    graph the ball's height over time as it bounces and settles.
define("collisions", (rand, table) =>
  table("events").filter(r => r.type === "collision")
)

define("ball_height", (rand, table) =>
  table("events")
    .filter(r => r.id === "ball" && r.type === "update")
    .map(r => ({ beat: r.beat, height: r.py }))
    .graph("height")
)

// 5. Post-processing is a hydra sketch (hydra-ts). A hydra table is a stream
//    of setCode/setVariable EVENTS (see "Hydra Sketch" for the plain case):
//    s0 is the rendered 3D scene; o0 is the output, so src(s0)...out()
//    post-processes the scene. The most-recent setCode wins, and each
//    variable holds its most-recent setVariable value until a later one
//    changes it — referenced as (props) => props.amount rather than the bare
//    name, so every collision's new value takes effect immediately, without
//    recompiling the sketch (a recompile would restart its oscillator phase,
//    visible as a stutter on every landing).
//    Every row sits on a \`beat\` — the base sketch at beat 1, and each
//    collision-driven \`amount\` bump at the beat its landing baked to (physics
//    and hydra share the one beat grid, so the bumps line up with the crash).
//    This is the two-TABLE case: the base sketch lives in the EDITABLE
//    "hydra sketch" table (seeded below, its own tab — click its code cell to
//    open the sketch in this editor, tweak, Ctrl-Enter to apply, and the edit
//    lands in the table's event log at "hydra sketch·events") while "hydra"
//    is a code-GENERATED view layering the collision-driven \`amount\` events
//    on top — data-driven from "sim" (filter the sibling, not "events", or
//    we'd cycle). Reach for two tables like this only when you need computed
//    events layered on the user-authored ones; otherwise a single editable
//    table named "hydra" (see "Hydra Sketch") is all you need.
define("hydra", (rand, table) =>
  editable("hydra sketch", { beat: "number", event: "string", code: "code", name: "string", value: "number" }, [
    { beat: 1, event: "setCode",
      code: "src(s0).modulate(osc(2.5, 0.1), (props) => props.amount).out(o0)" },
    { beat: 1, event: "setVariable", name: "amount", value: 0.12 },
  ]).concat(
    // Declarative, diffable form: filter(Expr) + emit(template). Values are Expr
    // nodes (field("beat").add(0.5)) so the engine can hash this view and reuse
    // it — editing here never re-bakes the physics in "sim". Each landing kicks
    // \`amount\` up, then half a beat later a row settles it back down.
    table("sim")
      .filter(field("type").eq("collision").and(field("other").eq("floor")))
      .emit([
        { beat: field("beat"), event: "setVariable", name: "amount", value: 0.6 },
        { beat: field("beat").add(0.5), event: "setVariable", name: "amount", value: 0.12 },
      ])
  )
)

// 6. Beat-synced looping (optional). Tap the Tap button under the scene a few
//    times to set the tempo; the timeline's wall-clock length then follows it —
//    tap faster and the whole loop plays faster. "Loop" (next to Play) is on by
//    default. beats(16) loops every 16 beats; { fit: 12 } stretches this 12-beat
//    sim across the window so it plays once per loop:
//
// define("timeline", () => beats(16, { fit: 12 }))
`,
  },
  {
    name: "CO2 (Mauna Loa)",
    code: `// Mauna Loa CO2 — monthly atmospheric measurements by NOAA/Scripps, 1958–2026.
// The seasonal swing (~6 ppm) reflects northern-hemisphere plant growth;
// the long-run rise tracks fossil-fuel emissions.
// Source: github.com/datasets/co2-ppm (NOAA GML)

define("co2", () => data("/data/co2.csv"))

// Monthly readings — the seasonal sawtooth is clearly visible
define("co2_monthly", (rand, table) => table("co2").graph("co2_ppm"))

// Annual mean: group monthly rows by year, average the ppm readings
define("co2_annual", (rand, table) =>
  table("co2")
    .derive({ year: r => +r.date.slice(0, 4) })
    .groupBy("year")
    .agg({ year: rs => rs[0].year, co2_ppm: rs => +(rs.reduce((s, r) => s + r.co2_ppm, 0) / rs.length).toFixed(2) })
    .graph("co2_ppm")
)`,
  },
  {
    name: "Global temperature",
    code: `// Global surface temperature anomaly — GCAG dataset, 1850–2026.
// Values are mean °C deviation from the 1901–2000 baseline.
// The sharp uptick from ~1980 is the clearest signal of anthropogenic warming.
// Source: github.com/datasets/global-temp (GCAG / NOAA)

define("temp", () => data("/data/global-temp.csv"))

// Temperature anomaly over time — negative = cooler than baseline, positive = warmer
define("temp_chart", (rand, table) => table("temp").graph("mean"))

// Running 10-year mean to smooth inter-annual variability
define("temp_smooth", (rand, table) =>
  table("temp")
    .scan([], (window, r) => {
      window = [...window.slice(-9), r.mean]
      return { year: r.year, mean: r.mean, avg10: +(window.reduce((s, v) => s + v, 0) / window.length).toFixed(4) }
    })
    .graph("mean", "avg10")
)`,
  },
  {
    name: "HadCRUT5 (global)",
    code: `// HadCRUT5 global surface temperature anomaly — Met Office / CRU, monthly 1850–present.
// Values are °C deviation from the 1961–1990 baseline with 95 % confidence bounds.
// Run \`npm run fetch-data\` once to download src/data/hadcrut5-monthly.csv.
// Source: Met Office HadOBS (HadCRUT.5.1.0.0)

define("hadcrut5", () => data("/data/hadcrut5-monthly.csv"))

// Monthly anomaly with confidence ribbon
define("anomaly_monthly", (rand, table) =>
  table("hadcrut5")
    .map(r => ({ ...r, anomaly_c: +r.anomaly_c, lower_ci: +r.lower_ci, upper_ci: +r.upper_ci }))
    .graph("anomaly_c", "lower_ci", "upper_ci")
)

// Annual mean anomaly
define("anomaly_annual", (rand, table) =>
  table("hadcrut5")
    .derive({ year: r => r.year_month.slice(0, 4), anomaly_c: r => +r.anomaly_c })
    .groupBy("year")
    .agg({ year: rs => rs[0].year, anomaly_c: rs => +(rs.reduce((s, r) => s + r.anomaly_c, 0) / rs.length).toFixed(4) })
    .graph("anomaly_c")
)`,
  },
]
