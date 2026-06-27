// Chart drawing utilities shared by the combined table+graph panel and preview.js.

import type { Table } from './dsl.js'
import type { Row } from './lineage.js'

export const SERIES_COLORS = [
  '#4a9eff', '#ff6b6b', '#51cf66', '#ffd43b', '#cc5de8', '#ff922b', '#22d3ee',
]

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

export function resolveSpec(spec: GraphSpec): ResolvedSpec {
  const rows = spec.table.rows
  const allCols = spec.table.columns
  let cols = spec.columns.length ? spec.columns : allCols.filter((c) => c !== 'index')
  cols = cols.filter((c) => isNumericColumn(rows, c))
  const hasIndex = allCols.includes('index')
  const xOf = (row: Row, i: number): number => (hasIndex ? (row.index as number) : i)
  return { rows, cols, xOf, hasIndex }
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

export function drawChartToCanvas(
  canvas: HTMLCanvasElement,
  chartData: ChartData,
  playIndex: number,
  playActive: Map<string, Set<number>> | null,
): ColRange[] | null {
  const { rows, cols, xOf, hasIndex, xMin, xMax, name } = chartData
  const g = canvas.getContext('2d')
  if (!g) return null
  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  if (w === 0 || h === 0) return null
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  g.clearRect(0, 0, w, h)

  const pad = { l: 6, r: 6, t: 8, b: 18 }
  const plotW = w - pad.l - pad.r
  const plotH = h - pad.t - pad.b

  const xSpan = xMax - xMin || 1
  const px = (x: number): number => pad.l + ((x - xMin) / xSpan) * plotW

  const colRanges: ColRange[] = cols.map((c) => {
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
    const yPad = (rawMax - rawMin) * 0.08
    return { rawMin, rawMax, min: rawMin - yPad, max: rawMax + yPad }
  })

  const seriesPy = colRanges.map(({ min, max }) => {
    const yRange = max - min
    return (v: number): number => pad.t + (1 - (v - min) / yRange) * plotH
  })

  cols.forEach((c, ci) => {
    const py = seriesPy[ci]
    const { min, max } = colRanges[ci]

    if (min < 0 && max > 0) {
      g.strokeStyle = SERIES_COLORS[ci % SERIES_COLORS.length] + '44'
      g.lineWidth = 1
      g.beginPath()
      g.moveTo(pad.l, py(0))
      g.lineTo(w - pad.r, py(0))
      g.stroke()
    }

    g.strokeStyle = SERIES_COLORS[ci % SERIES_COLORS.length]
    g.lineWidth = 1.5
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

  const sources = playActive?.get(name)
  if (sources) {
    g.fillStyle = '#e9a23b'
    for (const ordinal of sources) {
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

  if (playIndex >= xMin && playIndex <= xMax) {
    g.strokeStyle = '#e94560'
    g.lineWidth = 1
    g.beginPath()
    g.moveTo(px(playIndex), pad.t)
    g.lineTo(px(playIndex), h - pad.b)
    g.stroke()
  }

  const ticks = xTicks(xMin, xMax)
  const dec = tickDecimals(ticks)
  const suffix = hasIndex ? 's' : ''
  g.fillStyle = '#607a96'
  g.font = '9px system-ui'
  g.textBaseline = 'top'
  ticks.forEach((t, i) => {
    const x = px(t)
    if (x < pad.l - 2 || x > w - pad.r + 2) return
    g.textAlign = i === 0 ? 'left' : i === ticks.length - 1 ? 'right' : 'center'
    g.fillText(t.toFixed(dec) + suffix, x, h - pad.b + 3)
  })

  return colRanges
}
