// Sample programs for the livecodata editor. CSV datasets are served from
// /data/ and loaded at run time via data(url) — no inline embedding needed.
export const SAMPLES = [
  {
    name: "Editable Table",
    code: `// livecodata — a sphere moved by an editable table
// Unlike every other example here, the path below isn't computed by code —
// it's data you edit directly, live, in the table panel on the right.
// Press "Run ▶" (or Cmd/Ctrl-Enter), then hit Play under the scene.

// 1. editable(name, schema, seedRows?) declares a user-editable table: rows
//    are entered/edited in the table panel (its own "path" tab), not
//    computed — edits persist across runs, unlike a normal view. Try it: open
//    the "path" tab, click a cell to change a coordinate, or hit "+ row" to
//    add a keyframe, then press Run again to see the sphere follow the new
//    path. (Every edit is recorded as an event too — see the "path·events" tab.)
define("path", () =>
  editable("path", { index: "number", px: "number", py: "number", pz: "number" }, [
    { index: 0, px: -1, py: 0,   pz: 0 },
    { index: 1, px: 1,  py: 1,   pz: 0 },
    { index: 2, px: 0,  py: 0.3, pz: -1 },
  ])
)

// 2. Turn the path's keyframes into a moving sphere: the first row (sorted by
//    index, in case rows were added out of order) creates it; every later row
//    is an update, and playback interpolates position between consecutive
//    rows by their \`index\` (seconds).
define("events", (rand, table) =>
  table("path").orderBy("index").map((r, i) => ({
    id: "ball", type: i === 0 ? "create" : "update", index: r.index,
    shape: "sphere", color: 0x4a9eff, px: r.px, py: r.py, pz: r.pz, rx: 0, ry: 0, rz: 0,
  }))
)

// 3. Bake the sparse keyframes into a dense per-frame cache for playback.
define("scene", (rand, table) => table("events").rasterize(3))
`,
  },
  {
    name: "Hydra Sketch",
    code: `// livecodata — post-processing with hydra (ojack's hydra-synth)
// The rendered 3D scene becomes just another texture hydra can feed through a
// video-synth sketch. Press "Run ▶" (or Cmd/Ctrl-Enter), then hit Play.

// 1. A single sphere — just something on screen for the sketch to process.
//    (A sparse "create" event, baked to a dense per-frame cache by rasterize —
//    same pipeline every scene in these samples uses; see "Editable Table".)
define("events", () => rows([
  { id: "ball", type: "create", index: 0, shape: "sphere", color: 0x4a9eff,
    px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 },
]))

define("scene", (rand, table) => table("events").rasterize(3))

// 2. define("hydra", ...) supplies the post-processing sketch. A row's \`code\`
//    column is a hydra sketch string: s0 is the rendered 3D scene, o0 is the
//    output, so src(s0)...out(o0) reads the scene and writes what's shown.
//    Any OTHER column (here \`speed\`) is a variable in scope while the sketch
//    runs — the most-recent value at each frame wins, same as \`code\`.
//    editable(name, schema, seedRows?) makes this table live-editable in the
//    table panel (its own "sketch" tab): click the code cell to open the
//    sketch in this editor; edit \`speed\` right in the table, no code change
//    needed. (Every edit is an event too — see the "sketch·events" tab.)
define("hydra", () =>
  editable("sketch", { index: "number", code: "code", speed: "number" }, [
    { index: 0, speed: 3,
      code: "src(s0).modulate(osc(speed, 0.1).rotate(0.5), 0.1).out(o0)" },
  ])
)
`,
  },
  {
    name: "House of Cards",
    code: `// livecodata — House of Cards
// A triangular pyramid of playing cards collapses when a ball drops on it.
// Press "Run ▶" (or Cmd/Ctrl-Enter), then hit Play under the scene.
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

// 2. Bake a JoltPhysics simulation in the background: step the world for 240
//    frames (~4 s at 60 fps). simulate() ADDS to the table — a per-frame "update"
//    row for each moving body (index in seconds; the cache interpolates between
//    them) plus a "collision" row whenever two bodies first touch.
//    The 3rd arg tags this view into the "events" group: the engine auto-builds
//    a view named "events" that concats every group member (index-sorted), so
//    multiple simulation views would merge into one "events" table — no manual
//    .concat. "events" is the single sparse stream of object motion + collisions.
define("sim", "events", (rand, table) =>
  physics(table("base")).simulate({ steps: 360, gravity: -9.81 })
)

// 3. Bake the sparse "events" stream into a dense per-frame cache for playback.
define("scene", (rand, table) => table("events").rasterize(6))

// 4. Collisions are just rows — pull them into their own view to inspect, and
//    graph the ball's height over time as it bounces and settles.
define("collisions", (rand, table) =>
  table("events").filter(r => r.type === "collision")
)

define("ball_height", (rand, table) =>
  table("events")
    .filter(r => r.id === "ball" && r.type === "update")
    .map(r => ({ index: r.index, height: r.py }))
    .graph("height")
)

// 5. Post-processing is a hydra sketch (ojack's hydra). The "hydra" view is a
//    table whose \`code\` column holds a hydra sketch string and whose other
//    columns are variables in scope while the sketch runs. s0 is the rendered 3D
//    scene; o0 is the output, so src(s0)...out() post-processes the scene. The
//    most-recent code row wins, and each variable holds its most-recent value
//    until a later row changes it.
//    The base sketch lives in the EDITABLE "sketch" table (seeded below): click
//    its code cell to open the sketch in this editor, tweak, Ctrl-Enter to
//    apply — the edit is appended to the table's event log (see sketch·events)
//    and the viewer re-cooks. The collision-driven \`amount\` rows then layer on
//    top — data-driven from "sim" (filter the sibling, not "events", or we'd cycle).
define("hydra", (rand, table) =>
  editable("sketch", { index: "number", code: "code", amount: "number" }, [
    { index: 0, amount: 0.12,
      code: "src(s0).modulate(osc(2.5, 0.1), amount).out(o0)" },
  ]).concat(
    // Declarative, diffable form: filter(Expr) + emit(template). Values are Expr
    // nodes (field("index").add(0.25)) so the engine can hash this view and reuse
    // it — editing here never re-bakes the physics in "sim". Each landing kicks
    // \`amount\` up, then a later row settles it back down.
    table("sim")
      .filter(field("type").eq("collision").and(field("other").eq("floor")))
      .emit([
        { index: field("index"), amount: 0.6 },
        { index: field("index").add(0.25), amount: 0.12 },
      ])
  )
)

// 6. Beat-synced looping (optional). Tap the 🥁 Tap button under the scene a few
//    times to set the tempo, then measure the timeline in beats — its length
//    follows the tapped tempo. "Loop" (next to Play) is on by default. beats(16)
//    loops every 16 beats; { fit: 4 } stretches this 4-second sim across the window:
//
// define("timeline", () => beats(16, { fit: 4 }))
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
