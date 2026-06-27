// Sample programs for the livecodata editor. CSV datasets are served from
// /data/ and loaded at run time via data(url) — no inline embedding needed.
export const SAMPLES = [
  {
    name: "Physics demo",
    code: `// livecodata — define tables as views; the engine cooks them each run.
// Press "Run ▶" (or Cmd/Ctrl-Enter), then hit Play under the scene.
// Tips: Ctrl-Space completes views & Table verbs; hover a "view" name to preview
// its table; your caret selects that view's tab on the right.

define("base", () =>
  rows([
    { id: "floor", type: "create", shape: "box", color: 0x222244,
      motion: "static", px: 0, py: -1.2, pz: 0, hx: 3, hy: 0.2, hz: 3 },
    { id: "ball",  type: "create", shape: "sphere",   color: 0x4a9eff,
      motion: "dynamic", px: -0.5, py: 3.0, pz: 0.0 },
    { id: "box1",  type: "create", shape: "box",      color: 0xff6b6b,
      motion: "dynamic", px: 0.4,  py: 4.5, pz: 0.2, rx: 0.4, ry: 0.3 },
    { id: "cyl",   type: "create", shape: "cylinder", color: 0x51cf66,
      motion: "dynamic", px: 0.0,  py: 6.0, pz: -0.3 },
  ])
)

define("events", (rand, table) =>
  physics(table("base")).simulate({ steps: 240, gravity: -9.81 })
)

define("scene", (rand, table) => table("events").rasterize(4))

define("collisions", (rand, table) =>
  table("events").filter(r => r.type === "collision")
)

define("ball_height", (rand, table) =>
  table("events")
    .filter(r => r.id === "ball" && r.type === "update")
    .map(r => ({ index: r.index, height: r.py }))
    .graph("height")
)`,
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
    name: "HadUK-Grid (UK temp)",
    code: `// HadUK-Grid UK mean surface temperature — Met Office gridded obs, monthly 1884–present.
// Values are °C. The dataset covers the UK land area at 1 km resolution; this
// series is the area-average for the whole UK.
// Run \`npm run fetch-data\` once to download src/data/haduk-meantemp-monthly.csv.
// Source: Met Office HadOBS (HadUK-Grid)

define("haduk", () => data("/data/haduk-meantemp-monthly.csv"))

// Monthly temperatures — the seasonal cycle dominates
define("uk_monthly", (rand, table) =>
  table("haduk")
    .map(r => ({ ...r, temp_c: +r.temp_c }))
    .graph("temp_c")
)

// Annual mean — strips the seasonal cycle, reveals the warming trend
define("uk_annual", (rand, table) =>
  table("haduk")
    .derive({ year: r => r.year_month.slice(0, 4), temp_c: r => +r.temp_c })
    .groupBy("year")
    .agg({ year: rs => rs[0].year, temp_c: rs => +(rs.reduce((s, r) => s + r.temp_c, 0) / rs.length).toFixed(3) })
    .graph("temp_c")
)`,
  },
]
