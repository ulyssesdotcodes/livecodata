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
    name: "Origami Square Base",
    code: `// livecodata — Origami Square Base: fold, squash, press — both sides
// A square of paper folds itself the way origami is actually written down:
// each instruction folds or REFLECTS the paper along a line through two
// points on KNOWN EDGES — the paper's own edges, or an edge created by a
// previous fold. Press "Run" (or Cmd/Ctrl-Enter), then hit Play.
//
// The instructions are ONE editable table ("steps" in the table panel):
//   step   a name — later rows reference the edge this fold created, and a
//          row re-using the name re-drives that fold (whole with no line,
//          or just the stretch between p1/p2 given on its own edge)
//   op     "reflect" mirrors EVERYTHING on one side of the line (a flat
//          180° fold through every layer); "fold" rotates just the flap
//          connected to \`move\` by \`deg\` degrees
//   p1,p2  the fold line, each point ON A KNOWN EDGE:
//            "bottom@t" "top@t" "left@t" "right@t"  a fraction t along that
//                      edge of the PAPER, wherever folding has carried it
//            "name@t"  a fraction t along the edge CREATED by fold \`name\`
//   move   a point (same language) on the side that moves
//   dir    +1 folds toward you, −1 away
//   at,dur,to  timing, and how far to drive (1 folded, 0 open, − beyond)
// Fold angles are the PAPER's own: a valley is a valley on its layer, so
// one fold through a stack moves the front layer toward you and the back
// layer away — which is what makes a collapse possible at all.
//
// THIS SAMPLE: fold the triangle, then squash it around its middle. Five
// edges fold at once, all meeting at the centre of the triangle's long
// edge (the paper's centre):
//   - the fold that would HALVE the triangle (right-angle corner to the
//     centre), FRONT layer: a valley                           ("s1")
//   - the same line, BACK layer: a valley on its own side      (emerges)
//   - centre → the coincident edge midpoints, FRONT: a mountain ("mtn")
//   - the same on the BACK: a mountain                         ("mtn")
//   - the right half of the triangle's long edge UNFOLDS flat  ("diag@…")
// The mtn/s1 rows are keyframes along the squash's exact rigid path (the
// five creases are one mechanism — drive three, the paper does the rest,
// and every edge stays glued). Mid-squash it stands as the pocket: <| from
// the front, <|> from the side, a T from the top. Then the PRESS: the
// pocket lies down flat to the RIGHT of the centre line — the valley OPENS
// back to flat while the spine refolds the other way — the tip lands
// exactly ON the right-angle corner and both edge midpoints stack at the
// top corner: one side of the square base. Then the SAME squash-and-press
// on the other flap — its mountains to the other pair of coincident
// midpoints, the long edge's left half as its spine, the same halving
// valleys rising and flattening again — finishes the CLASSIC SQUARE BASE:
// all four paper corners on one point, the coincident edge midpoints at
// the two side corners, the paper centre at the closed corner, flat.

define("steps", () =>
  editable("steps", {
    step: "string", op: "string", p1: "string", p2: "string",
    move: "string", dir: "number", deg: "number", at: "number", dur: "number", to: "number",
  }, [
    // 1. the triangle — and it STAYS folded
    { step: "diag", op: "reflect", p1: "bottom@0", p2: "top@1", move: "bottom@1", dir: -1, at: 1, dur: 2, to: 1 },
    // 2. the squash: mountains + centre valleys + the spine opening flat,
    //    keyframed together along the mechanism's path
    { step: "mtn", op: "fold", deg: 90, p1: "diag@0.5", p2: "right@0.5", move: "top@1", at: 4, dur: 0.5, to: -0.36 },
    { step: "s1", op: "reflect", p1: "top@0", p2: "diag@0.5", move: "top@1", dir: 1, at: 4, dur: 0.5, to: 0.124 },
    { step: "diag", p1: "diag@0.5", p2: "diag@1", at: 4, dur: 2, to: 0 },
    { step: "mtn", at: 4.5, dur: 0.5, to: -0.78 },
    { step: "s1",  at: 4.5, dur: 0.5, to: 0.249 },
    { step: "mtn", at: 5,   dur: 0.5, to: -1.318 },
    { step: "s1",  at: 5,   dur: 0.5, to: 0.372 },
    { step: "mtn", at: 5.5, dur: 0.5, to: -1.929 },
    { step: "s1",  at: 5.5, dur: 0.5, to: 0.475 },
    // 3. press the pocket flat to the RIGHT of the centre line: the valley
    //    OPENS back to flat (it folded up, now it flattens) while the spine
    //    refolds the other way — the kite lands right of the centre with
    //    both edge midpoints stacked at the top corner, the tip on the
    //    right-angle corner: one side of the square base, done.
    { step: "s1",  at: 6.5, dur: 0.5, to: 0.415 },
    { step: "diag", p1: "diag@0.5", p2: "diag@1", at: 6.5, dur: 0.5, to: -0.163 },
    { step: "mtn", at: 6.5, dur: 0.5, to: -1.989 },
    { step: "s1",  at: 7, dur: 0.5, to: 0.356 },
    { step: "diag", p1: "diag@0.5", p2: "diag@1", at: 7, dur: 0.5, to: -0.284 },
    { step: "mtn", at: 7, dur: 0.5, to: -1.994 },
    { step: "s1",  at: 7.5, dur: 0.5, to: 0.237 },
    { step: "diag", p1: "diag@0.5", p2: "diag@1", at: 7.5, dur: 0.5, to: -0.526 },
    { step: "mtn", at: 7.5, dur: 0.5, to: -1.996 },
    { step: "s1",  at: 8, dur: 0.5, to: 0.119 },
    { step: "diag", p1: "diag@0.5", p2: "diag@1", at: 8, dur: 0.5, to: -0.763 },
    { step: "mtn", at: 8, dur: 0.5, to: -1.997 },
    { step: "s1",  at: 8.5, dur: 0.5, to: 0 },
    { step: "diag", p1: "diag@0.5", p2: "diag@1", at: 8.5, dur: 0.5, to: -1 },
    { step: "mtn", at: 8.5, dur: 0.5, to: -2 },
    // 4. THE SAME ON THE OTHER SIDE: squash the remaining flap — mountains
    //    to the other pair of coincident midpoints, the long edge's LEFT
    //    half as its spine, the same halving valleys rising again (they
    //    carry the first flap up with them and set it back down)…
    { step: "mtn2", op: "fold", deg: 90, p1: "diag@0.5", p2: "left@0.5", move: "bottom@0", at: 9.5, dur: 0.25, to: -0.25 },
    { step: "diag", p1: "diag@0", p2: "diag@0.5", at: 9.5, dur: 0.25, to: 0.825 },
    { step: "s1", at: 9.5, dur: 0.25, to: 0.088 },
    { step: "mtn2", at: 9.75, dur: 0.5, to: -0.75 },
    { step: "diag", p1: "diag@0", p2: "diag@0.5", at: 9.75, dur: 0.5, to: 0.518 },
    { step: "s1", at: 9.75, dur: 0.5, to: 0.242 },
    { step: "mtn2", at: 10.25, dur: 0.25, to: -1 },
    { step: "diag", p1: "diag@0", p2: "diag@0.5", at: 10.25, dur: 0.25, to: 0.392 },
    { step: "s1", at: 10.25, dur: 0.25, to: 0.305 },
    { step: "mtn2", at: 10.5, dur: 0.75, to: -1.75 },
    { step: "diag", p1: "diag@0", p2: "diag@0.5", at: 10.5, dur: 0.75, to: 0.089 },
    { step: "s1", at: 10.5, dur: 0.75, to: 0.457 },
    { step: "mtn2", at: 11.25, dur: 0.25, to: -2 },
    { step: "diag", p1: "diag@0", p2: "diag@0.5", at: 11.25, dur: 0.25, to: -0.044 },
    { step: "s1", at: 11.25, dur: 0.25, to: 0.479 },
    // 5. …and press it flat to the LEFT: the SQUARE BASE — all four paper
    //    corners on one point, the coincident midpoints at the two side
    //    corners, the paper centre at the closed corner.
    { step: "s1", at: 12.5, dur: 0.5, to: 0.359 },
    { step: "diag", p1: "diag@0", p2: "diag@0.5", at: 12.5, dur: 0.5, to: -0.283 },
    { step: "s1", at: 13, dur: 0.5, to: 0.24 },
    { step: "diag", p1: "diag@0", p2: "diag@0.5", at: 13, dur: 0.5, to: -0.523 },
    { step: "s1", at: 13.5, dur: 0.5, to: 0.12 },
    { step: "diag", p1: "diag@0", p2: "diag@0.5", at: 13.5, dur: 0.5, to: -0.762 },
    { step: "s1", at: 14, dur: 0.5, to: 0 },
    { step: "diag", p1: "diag@0", p2: "diag@0.5", at: 14, dur: 0.5, to: -1 },
  ]))

// Feed the instructions to a sheet of paper. The camera goes face-on as
// the first press starts (watch the <| close), pulls back to three-quarter
// for the second squash, then overhead for the finished square base.
define("events", (rand, table) => {
  const paper = origami().steps(table("steps"))
  return paper.spawn({ id: "base", color: 0xd94f2a, py: -0.2, pz: 1.2, rx: -0.9, ry: 0.2 })
    .concat(paper.sequence())
    .concat(rows([
      { id: "base", type: "update", beat: 4,    py: -0.2, rx: -0.75, ry: 0.2, rz: 0 },
      { id: "base", type: "update", beat: 6.4,  py: -0.4, rx: -1.57, ry: 0,   rz: -0.79 },
      { id: "base", type: "update", beat: 8.7,  py: -0.4, rx: -1.57, ry: 0,   rz: -0.79 },
      { id: "base", type: "update", beat: 10.5, py: -0.2, rx: -0.75, ry: 0.2, rz: 0 },
      { id: "base", type: "update", beat: 14.7, py: 0.1,  rx: -0.05, ry: 0,   rz: -0.79 },
    ]))
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
//   - Delete the four mtn/s1 keyframe pairs after the first: the squash
//     stops a quarter of the way in and holds — scrub to study it.
//   - Drive "mtn" to 0 at beat 8 and the T folds back into the triangle.
//   - Move the mountain: p2 "top@0.6" pulls the ridge toward the centre
//     line — the mechanism changes and the paper visibly strains (the
//     keyframes below belong to the "top@0.75" mechanism).
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
    name: "ABC Blocks",
    code: `// livecodata — ABC Blocks
// Wooden alphabet blocks rain onto a bouncy foam playmat and clatter to rest.
// Press "Run" (or Cmd/Ctrl-Enter), then hit Play under the scene.
//
// Three things this sample shows:
//   - a \`letter\` field on a box row stamps that letter on every face of the
//     block (a canvas texture: cream face, the row's color as the frame and
//     the letter itself) — any extra field like this rides through physics
//     and the frame cache untouched, straight to the renderer.
//   - bounciness is \`restitution\`. Jolt combines the two touching bodies'
//     values by MAX, so a springy mat (0.65) makes everything that lands on
//     it bounce, whatever the block's own restitution says.
//   - a \`map\` field naming a hydra output ("o0".."o3") plays that output
//     LIVE on the object's faces; \`map0\`..\`map5\` override single box faces
//     (+x, −x, top, bottom, +z, −z). Here the blocks' sides and bottom show
//     o1 (the top keeps its letter) while the playmat plays o2 — two
//     different sketches, both driven by the "hydra" view below, ticking on
//     the same playback clock as the physics.

// 1. The scene: a 4×4 grid of foam tiles (static, springy) and eight blocks
//    dropped from a staggered stack of heights with random tumbles. rand is
//    the view's seeded PRNG — press Run again for a fresh Run's new seed, or
//    scrub the session bar back to replay an old drop exactly.
define("base", (rand) => {
  const tileColors = [0x51cf66, 0xffd43b, 0x4a9eff, 0xff6b6b]
  const mat = []
  for (let ix = 0; ix < 4; ix++) {
    for (let iz = 0; iz < 4; iz++) {
      mat.push({
        id: "mat" + ix + iz, type: "create", shape: "box", map: "o2",
        color: tileColors[(ix + iz * 3) % 4],
        motion: "static", restitution: 0.65, friction: 0.7,
        px: (ix - 1.5) * 1.12, py: -1.35, pz: (iz - 1.5) * 1.12,
        hx: 0.55, hy: 0.08, hz: 0.55,
      })
    }
  }

  const letterColors = [0xe74c3c, 0x2f7fe0, 0x2eaf5b, 0xd97f00, 0xa54ee0, 0xc0392b, 0x1f8f8f, 0xd4437f]
  const blocks = "ABCDEFGH".split("").map((letter, i) => ({
    id: "block" + letter, type: "create", shape: "box", letter,
    // hydra output o1 on the sides and bottom; map2 (the top) is left unset,
    // so that face falls back to the letter texture.
    map0: "o1", map1: "o1", map3: "o1", map4: "o1", map5: "o1",
    color: letterColors[i],
    motion: "dynamic", friction: 0.5, restitution: 0.25,
    hx: 0.2, hy: 0.2, hz: 0.2,
    px: ((i % 4) - 1.5) * 0.5 + (rand() - 0.5) * 0.25,
    py: 0.6 + i * 0.25 + rand() * 0.25,
    pz: (rand() - 0.5) * 0.8,
    rx: rand() * 0.8, ry: rand() * 6.28, rz: rand() * 0.8,
  }))

  return rows([...mat, ...blocks])
})

// 2. Bake the tumble: 360 physics frames = 12 beats on the fixed
//    30-frames-per-beat grid. The "events" group view (3rd arg) collects the
//    per-frame update rows and every block↔mat / block↔block collision.
define("sim", "events", (rand, table) =>
  physics(table("base")).simulate({ steps: 360, gravity: -9.81 })
)

// 3. Dense per-frame cache for playback — the full 12-beat drop, looped.
define("scene", (rand, table) => table("events").rasterize(12))

// 4. Every first touch is a row — count each block's landings on the mat.
define("landings", (rand, table) =>
  table("events")
    .filter(r => r.type === "collision" && String(r.other).startsWith("mat"))
    .groupBy("id")
    .count()
)

// 5. The sketches behind the faces. One hydra program renders three outputs:
//    o1 (the blocks' sides) a slow kaleidoscope, o2 (the playmat) drifting
//    colored noise, and o0 — what you SEE — the rendered 3D scene (s0)
//    passed straight through. The face textures cross over from hydra to
//    the 3D scene each tick, so o1/o2 animate on the blocks in the render
//    that then flows back INTO hydra as s0.
define("hydra", () => rows([
  { beat: 1, event: "setCode",
    code: "osc(6, 0.08, 1.4).kaleid(4).out(o1); noise(2.5, 0.12).colorama(0.4).out(o2); src(s0).out(o0)" },
]))
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
