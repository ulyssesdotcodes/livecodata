// Chart logic + the shared 2D series renderer.
// ----------------------------------------------------------------------------
// Everything chart-shaped goes through this module so the rules can't drift
// between surfaces: the table panel's big graph and the editor hover preview's
// sparklines are the *same* renderer (drawSeriesChart) with a different
// SeriesChartStyle, and "which columns are plottable", "what is the x axis",
// and "what y range does a series get" are each defined exactly once
// (numericColumns / beatXOf / computeColRanges — all pure and unit-testable).
//
// Range computation is deliberately a pure pre-step (computeColRanges) rather
// than a by-product of drawing: callers pass the ranges in, so legends can use
// the same numbers without a second scan and without caring whether the canvas
// has laid out yet.
//
// drawSeriesChart is the single renderer seam: it consumes only (ChartData,
// ColRange[], style), so a GPU-backed renderer (e.g. ulyssesdotcodes/
// webgpu-plot-lib, once it grows a gutterless per-series-scale mode and a
// published build) can replace it behind the same contract without touching
// any of the pure logic above it.

import type { Table } from './dsl.js'
import type { Row } from './lineage.js'

export const SERIES_COLORS = [
  '#4a9eff', '#ff6b6b', '#51cf66', '#ffd43b', '#cc5de8', '#ff922b', '#22d3ee',
]

const PLAYHEAD_COLOR = '#e94560'
const ACTIVE_ROW_COLOR = '#e9a23b'
const TICK_LABEL_COLOR = '#607a96'

export interface GraphSpec {
  table: Table
  columns: string[]
  viewName?: string | null
  name?: string
}

export interface ResolvedSpec {
  rows: Row[]
  cols: string[]
  xOf: (row: Row, i: number) => number
  hasIndex: boolean
}

export interface ChartData {
  rows: Row[]
  cols: string[]
  xOf: (row: Row, i: number) => number
  hasIndex: boolean
  xMin: number
  xMax: number
  name: string
}

export interface ColRange {
  rawMin: number
  rawMax: number
  min: number
  max: number
}

function isNumericColumn(rows: Row[], col: string): boolean {
  return rows.some((r) => typeof r[col] === 'number')
}

// The one "what counts as plottable" rule: a column charts when it holds a
// number somewhere and isn't the `beat` x-axis column. The panel's auto-chart,
// the hover preview, and resolveSpec's default all ask this same question.
export function numericColumns(rows: Row[], cols: string[]): string[] {
  return cols.filter((c) => c !== 'beat' && isNumericColumn(rows, c))
}

// The shared x mapping: plot against `beat` when the table has one (the beat
// grid is the x unit everywhere in livecodata), else against row ordinal.
export function beatXOf(columns: string[]): { hasIndex: boolean; xOf: (row: Row, i: number) => number } {
  const hasIndex = columns.includes('beat')
  return { hasIndex, xOf: (row, i) => (hasIndex ? (row.beat as number) : i) }
}

export function xExtent(rows: Row[], xOf: (row: Row, i: number) => number): { xMin: number; xMax: number } {
  let xMin = Infinity, xMax = -Infinity
  rows.forEach((row, i) => {
    const x = xOf(row, i)
    if (x < xMin) xMin = x
    if (x > xMax) xMax = x
  })
  return { xMin, xMax }
}

export function resolveSpec(spec: GraphSpec): ResolvedSpec {
  const rows = spec.table.rows
  const allCols = spec.table.columns
  // Explicit .graph() columns are honored (minus non-numeric ones, which have
  // nothing to plot); the default is every plottable column.
  const cols = spec.columns.length
    ? spec.columns.filter((c) => isNumericColumn(rows, c))
    : numericColumns(rows, allCols)
  const { hasIndex, xOf } = beatXOf(allCols)
  return { rows, cols, xOf, hasIndex }
}

// Assemble the ChartData a renderer consumes, or null when there is nothing
// to draw.
export function chartDataFor(rows: Row[], columns: string[], cols: string[], name: string): ChartData | null {
  if (!rows.length || !cols.length) return null
  const { hasIndex, xOf } = beatXOf(columns)
  const { xMin, xMax } = xExtent(rows, xOf)
  return { rows, cols, xOf, hasIndex, xMin, xMax, name }
}

export function xTicks(xMin: number, xMax: number, targetCount: number = 4): number[] {
  const span = xMax - xMin
  if (span === 0) return [xMin]
  const rough = span / targetCount
  const mag = Math.pow(10, Math.floor(Math.log10(rough)))
  const norm = rough / mag
  const step = (norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10) * mag
  const start = Math.ceil(xMin / step) * step
  const ticks: number[] = []
  for (let t = start; t <= xMax + step * 0.01; t = parseFloat((t + step).toFixed(10)))
    ticks.push(t)
  return ticks
}

export function tickDecimals(ticks: number[]): number {
  if (ticks.length < 2) return 0
  const step = Math.abs(ticks[1] - ticks[0])
  return step >= 1 ? 0 : step >= 0.1 ? 1 : 2
}

export function fmtNum(v: number): string {
  if (Math.abs(v - Math.round(v)) < 1e-9) return String(Math.round(v))
  const abs = Math.abs(v)
  return v.toFixed(abs >= 10 ? 1 : abs >= 1 ? 2 : 3)
}

// Per-series y ranges: each series is scaled independently (columns with very
// different magnitudes all show their shape). `yPadFrac` adds breathing room
// above/below (the big panel chart); sparklines pass 0 and use the raw range.
// Degenerate ranges (no numbers, or a constant column) widen to something
// drawable.
export function computeColRanges(rows: Row[], cols: string[], yPadFrac: number): ColRange[] {
  return cols.map((c) => {
    let rawMin = Infinity, rawMax = -Infinity
    for (const row of rows) {
      const v = row[c]
      if (typeof v === 'number') {
        if (v < rawMin) rawMin = v
        if (v > rawMax) rawMax = v
      }
    }
    if (!isFinite(rawMin)) { rawMin = -1; rawMax = 1 }
    if (rawMin === rawMax) { rawMin -= 1; rawMax += 1 }
    const yPad = (rawMax - rawMin) * yPadFrac
    return { rawMin, rawMax, min: rawMin - yPad, max: rawMax + yPad }
  })
}

export interface SeriesChartStyle {
  pad: { l: number; r: number; t: number; b: number }
  lineWidth: number
  tickFont: string
  tickTarget: number
  yPadFrac: number
}

// The table panel's big graph.
export const PANEL_CHART_STYLE: SeriesChartStyle = {
  pad: { l: 6, r: 6, t: 8, b: 18 },
  lineWidth: 1.5,
  tickFont: '9px system-ui',
  tickTarget: 4,
  yPadFrac: 0.08,
}

// The hover preview's sparklines.
export const SPARKLINE_STYLE: SeriesChartStyle = {
  pad: { l: 3, r: 3, t: 3, b: 14 },
  lineWidth: 1.25,
  tickFont: '8px system-ui',
  tickTarget: 3,
  yPadFrac: 0,
}

export interface DrawSeriesChartOptions {
  style?: SeriesChartStyle
  // Fixed CSS size (sparklines paint before layout); default is the canvas's
  // laid-out size.
  size?: { w: number; h: number }
  // Playhead beat — a vertical line when it falls inside the plot.
  playIndex?: number | null
  // Storage ordinals of the rows feeding the playhead's active lineage —
  // marked with a dot per series (the big panel chart).
  activeRows?: Set<number> | null
}

// The one multi-series line renderer. Every series gets its own y scale (from
// the caller-computed `ranges`, which must be per-column parallel to
// data.cols), a translucent zero line when its range straddles zero, and the
// x axis gets nice-number tick labels ('… b' when x is the beat grid).
// Returns false when the canvas has no drawable area yet.
export function drawSeriesChart(
  canvas: HTMLCanvasElement,
  data: ChartData,
  ranges: ColRange[],
  { style = PANEL_CHART_STYLE, size, playIndex = null, activeRows = null }: DrawSeriesChartOptions = {},
): boolean {
  const { rows, cols, xOf, hasIndex, xMin, xMax } = data
  const g = canvas.getContext('2d')
  if (!g) return false
  const dpr = window.devicePixelRatio || 1
  const w = size ? size.w : canvas.clientWidth
  const h = size ? size.h : canvas.clientHeight
  if (w === 0 || h === 0) return false
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  if (size) {
    canvas.style.width = w + 'px'
    canvas.style.height = h + 'px'
  }
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  g.clearRect(0, 0, w, h)

  const { pad, lineWidth, tickFont, tickTarget } = style
  const plotW = w - pad.l - pad.r
  const plotH = h - pad.t - pad.b

  const xSpan = xMax - xMin || 1
  const px = (x: number): number => pad.l + ((x - xMin) / xSpan) * plotW

  const seriesPy = ranges.map(({ min, max }) => {
    const yRange = max - min
    return (v: number): number => pad.t + (1 - (v - min) / yRange) * plotH
  })

  cols.forEach((c, ci) => {
    const py = seriesPy[ci]
    const { min, max } = ranges[ci]

    if (min < 0 && max > 0) {
      g.strokeStyle = SERIES_COLORS[ci % SERIES_COLORS.length] + '44'
      g.lineWidth = 1
      g.beginPath()
      g.moveTo(pad.l, py(0))
      g.lineTo(w - pad.r, py(0))
      g.stroke()
    }

    g.strokeStyle = SERIES_COLORS[ci % SERIES_COLORS.length]
    g.lineWidth = lineWidth
    g.beginPath()
    let started = false
    rows.forEach((row, i) => {
      const v = row[c]
      if (typeof v !== 'number') return
      const X = px(xOf(row, i))
      const Y = py(v)
      if (!started) { g.moveTo(X, Y); started = true }
      else g.lineTo(X, Y)
    })
    g.stroke()
  })

  if (activeRows) {
    g.fillStyle = ACTIVE_ROW_COLOR
    for (const ordinal of activeRows) {
      const row = rows[ordinal]
      if (!row) continue
      cols.forEach((c, ci) => {
        const v = row[c]
        if (typeof v !== 'number') return
        g.beginPath()
        g.arc(px(xOf(row, ordinal)), seriesPy[ci](v), 3.5, 0, Math.PI * 2)
        g.fill()
      })
    }
  }

  if (playIndex != null) {
    const cx = px(playIndex)
    if (cx >= pad.l - 0.5 && cx <= w - pad.r + 0.5) {
      g.strokeStyle = PLAYHEAD_COLOR
      g.lineWidth = 1
      g.beginPath()
      g.moveTo(cx, pad.t)
      g.lineTo(cx, h - pad.b)
      g.stroke()
    }
  }

  const ticks = xTicks(xMin, xMax, tickTarget)
  const dec = tickDecimals(ticks)
  const suffix = hasIndex ? ' b' : '' // beats (the x-axis unit when a `beat` column is present)
  g.fillStyle = TICK_LABEL_COLOR
  g.font = tickFont
  g.textBaseline = 'top'
  ticks.forEach((t, i) => {
    const x = px(t)
    if (x < pad.l - 2 || x > w - pad.r + 2) return
    g.textAlign = i === 0 ? 'left' : i === ticks.length - 1 ? 'right' : 'center'
    g.fillText(t.toFixed(dec) + suffix, x, h - pad.b + 3)
  })

  return true
}
