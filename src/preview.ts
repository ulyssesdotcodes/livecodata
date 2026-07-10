// Sparkline painting for the inline table preview card (see
// ui/table-preview.tsx, which owns the DOM around it). Pure canvas drawing —
// the view hands in the <canvas> and this paints it.

import { SERIES_COLORS, xTicks, tickDecimals } from './graph-panel.js'
import type { Row } from './lineage.js'

export const SPARK_W = 220
export const SPARK_H = 50  // 36px chart area + 14px x-axis label area

// Whether any series has enough numeric data to plot.
export function canDrawSparklines(rows: Row[], cols: string[]): boolean {
  return cols.some((c) => rows.filter((r) => typeof r[c] === 'number').length >= 2)
}

export interface SparkRange {
  rawMin: number
  rawMax: number
}

export function sparklineRanges(rows: Row[], cols: string[]): SparkRange[] {
  return cols.map((c) => {
    let rawMin = Infinity, rawMax = -Infinity
    for (const row of rows) {
      const v = row[c]
      if (typeof v === 'number') { if (v < rawMin) rawMin = v; if (v > rawMax) rawMax = v }
    }
    if (!isFinite(rawMin)) { rawMin = -1; rawMax = 1 }
    if (rawMin === rawMax) { rawMin -= 1; rawMax += 1 }
    return { rawMin, rawMax }
  })
}

// A tiny multi-line chart of `cols` plotted against `xOf`, painted into the
// given canvas. Each series uses its own y-scale so columns with very
// different ranges all show their shape clearly. Returns the per-series raw
// ranges (for the legend).
export function drawSparklines(
  canvas: HTMLCanvasElement,
  rows: Row[],
  cols: string[],
  xOf: (row: Row, i: number) => number,
  hasIndex: boolean,
  playIndex: number | null = null,
): SparkRange[] {
  const colRanges = sparklineRanges(rows, cols)

  let xMin = Infinity, xMax = -Infinity
  rows.forEach((row, i) => {
    const x = xOf(row, i)
    if (x < xMin) xMin = x
    if (x > xMax) xMax = x
  })
  const xSpan = xMax - xMin || 1

  const dpr = window.devicePixelRatio || 1
  canvas.width = SPARK_W * dpr
  canvas.height = SPARK_H * dpr
  canvas.style.width = SPARK_W + 'px'
  canvas.style.height = SPARK_H + 'px'
  const g = canvas.getContext('2d')
  if (!g) return colRanges
  g.setTransform(dpr, 0, 0, dpr, 0, 0)

  const pad = { t: 3, b: 14, l: 3, r: 3 }
  const plotH = SPARK_H - pad.t - pad.b
  const plotW = SPARK_W - pad.l - pad.r

  const px = (x: number): number => pad.l + ((x - xMin) / xSpan) * plotW

  cols.forEach((c, ci) => {
    const { rawMin, rawMax } = colRanges[ci]
    const yRange = rawMax - rawMin
    const py = (v: number): number => pad.t + (1 - (v - rawMin) / yRange) * plotH

    if (rawMin < 0 && rawMax > 0) {
      g.strokeStyle = `${SERIES_COLORS[ci % SERIES_COLORS.length]}44`
      g.lineWidth = 1
      g.beginPath(); g.moveTo(pad.l, py(0)); g.lineTo(SPARK_W - pad.r, py(0)); g.stroke()
    }

    g.strokeStyle = SERIES_COLORS[ci % SERIES_COLORS.length]
    g.lineWidth = 1.25
    g.beginPath()
    let started = false
    rows.forEach((row, i) => {
      const v = row[c]
      if (typeof v !== 'number') return
      if (!started) { g.moveTo(px(xOf(row, i)), py(v)); started = true }
      else g.lineTo(px(xOf(row, i)), py(v))
    })
    g.stroke()
  })

  if (playIndex != null && xSpan > 0) {
    const cx = px(playIndex)
    if (cx >= pad.l && cx <= SPARK_W - pad.r) {
      g.strokeStyle = '#e94560'
      g.lineWidth = 1
      g.beginPath()
      g.moveTo(cx, pad.t)
      g.lineTo(cx, SPARK_H - pad.b)
      g.stroke()
    }
  }

  // X-axis tick labels.
  const ticks = xTicks(xMin, xMax, 3)
  const dec = tickDecimals(ticks)
  const suffix = hasIndex ? ' b' : '' // beats (the x-axis unit when a `beat` column is present)
  g.fillStyle = '#607a96'
  g.font = '8px system-ui'
  g.textBaseline = 'top'
  ticks.forEach((t, i) => {
    const x = px(t)
    if (x < pad.l - 2 || x > SPARK_W - pad.r + 2) return
    g.textAlign = i === 0 ? 'left' : i === ticks.length - 1 ? 'right' : 'center'
    g.fillText(t.toFixed(dec) + suffix, x, SPARK_H - pad.b + 2)
  })

  return colRanges
}
