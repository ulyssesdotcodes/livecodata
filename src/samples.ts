// Sample programs for the livecodata editor. CSV datasets are served from
// /data/ and loaded at run time via data(url) — no inline embedding needed.
export const SAMPLES = [
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
//    hz ≥ 0.05 is required because Jolt's BoxShape always applies a 0.05 convex
//    (corner-rounding) radius that must not exceed any half-extent.
define("base", () => {
  const lean = 0.25                    // radians from vertical (~14°)
  const H = 0.35, W = 0.22, T = 0.06  // card half-height, half-width, half-thickness
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
          px: tx - dx, py: cardCY, pz: 0, hx: W, hy: H, hz: T, rz: -lean },
        { id: "s" + k + "t" + i + "b", type: "create", shape: "box", color: 0xfdf6e3,
          motion: "dynamic", friction: 0.8, restitution: 0,
          px: tx + dx, py: cardCY, pz: 0, hx: W, hy: H, hz: T, rz:  lean },
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

// 2. Bake a JoltPhysics simulation: 360 frames = 6 s at 60 fps. simulate()
//    appends a per-frame "update" row for every moving body and a "collision"
//    row whenever two bodies first touch. The ball hits the crown at ~0.5 s;
//    the full cascade settles over the next few seconds.
//    Tagged "events" so these rows auto-merge with the effects view below.
define("sim", "events", (rand, table) =>
  physics(table("base")).simulate({ steps: 360, gravity: -9.81 })
)

// 3. Bake the sparse "events" stream into a dense per-frame cache for playback.
define("scene", (rand, table) => table("events").rasterize(6))

// 4. Post-processing: bloom flares on each floor collision, afterimage trails
//    on tumbling cards. Reads "sim" directly (not "events") to avoid a cycle —
//    sim is a sibling group member, not the already-merged events table.
define("effects", "events", (rand, table) =>
  rows([
    { id: "bloom",  type: "addEffect", effect: "bloom", index: 0,
      params: { strength: 0.7, radius: 0.4, threshold: 0.5 } },
    { id: "trails", type: "addEffect", effect: "afterimage", input: "bloom",
      index: 0, params: { damp: 0.88 } },
  ]).concat(
    // Declarative, diffable form: filter(Expr) + emit(template). Values are Expr
    // nodes (field("index").add(0.05)) so the engine can hash this view and reuse
    // it — editing here never re-bakes the physics in "sim".
    table("sim")
      .filter(field("type").eq("collision").and(field("other").eq("floor")))
      .emit([
        { id: "bloom", type: "updateEffect", index: field("index"), dur: 0.05,
          params: { strength: 2.6 } },
        { id: "bloom", type: "updateEffect", index: field("index").add(0.05), dur: 0.5,
          ease: easeOut, params: { strength: 0.8 } },
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
  {
    name: "UFO sightings (globe)",
    code: `// Global UFO sightings on a textured globe — NUFORC reports, 1950–2014.
// Geocoded to city lat/lon. A lighthearted stand-in for "earthquakes but not
// macabre": a worldwide point cloud with a date and a location, nothing more.
// Source: github.com/planetsig/ufo-reports (NUFORC data, scrubbed + geocoded)
// Earth texture: mrdoob/three.js example assets

define("sightings", () => data("/data/ufo-sightings.csv"))

// Reports per year — volume climbs sharply after ~1995 (more reporting, not
// more sightings)
define("sightings_per_year", (rand, table) =>
  table("sightings")
    .groupBy("year")
    .agg({ year: rs => rs[0].year, count: rs => rs.length })
    .graph("count")
)

const EARTH_R = 2

// Convert lat/lon (degrees) to a point on a sphere of radius r. Matches the
// standard equirectangular texture orientation (prime meridian centered).
function latLonToXYZ(lat, lon, r) {
  const phi = (90 - lat) * Math.PI / 180
  const theta = (lon + 180) * Math.PI / 180
  return {
    x: -r * Math.sin(phi) * Math.cos(theta),
    y:  r * Math.cos(phi),
    z:  r * Math.sin(phi) * Math.sin(theta),
  }
}

const SHAPE_COLORS = {
  light: 0xffe066, circle: 0x4a9eff, triangle: 0xe9ecef, fireball: 0xff922b,
  sphere: 0x51cf66, disk: 0xcc5de8, oval: 0x22d3ee, unknown: 0x8ca0b8,
}

// The globe: a single static sphere, textured with an Earth image. Tagged into
// "events" so it merges with the sighting markers below into one scene.
define("globe", "events", () =>
  rows([
    { id: "globe", type: "create", index: 0, shape: "sphere",
      px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0, r: EARTH_R, color: 0xffffff,
      texture: "https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/textures/planets/earth_atmos_2048.jpg" },
  ])
)

// Sighting markers: one small sphere per report, placed on the globe surface
// from its lat/lon, appearing in chronological order over a 20s playback
// window. Stride through the rows to keep the mesh count light (~500 markers).
define("markers", "events", (rand, table) => {
  const sample = table("sightings").rows.filter((_, i) => i % 8 === 0)
  const duration = 20
  return rows(
    sample.map((r, i) => {
      const p = latLonToXYZ(r.lat, r.lon, EARTH_R * 1.01)
      return {
        id: "sighting" + i, type: "create", shape: "sphere",
        index: (i / sample.length) * duration,
        px: p.x, py: p.y, pz: p.z, rx: 0, ry: 0, rz: 0, r: 0.025,
        color: SHAPE_COLORS[r.shape] ?? SHAPE_COLORS.unknown,
      }
    })
  )
})

define("scene", (rand, table) => table("events").rasterize(20))`,
  },
]
