// Inline table preview. Builds a compact DOM card — a sparkline of every
// numeric column plus the first few rows/columns — for any Table. Used by the
// editor's hover tooltip so you can see a view's data without leaving the code
// (reusing the table panel's cell formatter for consistent display).

import { formatCell } from './table-panel.js'
import { SERIES_COLORS, xTicks, tickDecimals, fmtNum } from './graph-panel.js'
import type { Table } from './dsl.js'
import type { Row } from './lineage.js'

const SPARK_W = 220
const SPARK_H = 50  // 36px chart area + 14px x-axis label area

// A tiny multi-line chart of `cols` plotted against `xOf`. Each series uses its
// own y-scale so columns with very different ranges all show their shape clearly.
// Returns { canvas, colRanges } or null when no series has enough numeric data.
function drawSparklines(
  rows: Row[],
  cols: string[],
  xOf: (row: Row, i: number) => number,
  hasIndex: boolean,
  playIndex: number | null = null,
): { canvas: HTMLCanvasElement; colRanges: { rawMin: number; rawMax: number }[] } | null {
  const drawable = cols.some(
    (c) => rows.filter((r) => typeof r[c] === 'number').length >= 2,
  )
  if (!drawable) return null

  const colRanges = cols.map((c) => {
    let rawMin = Infinity, rawMax = -Infinity
    for (const row of rows) {
      const v = row[c]
      if (typeof v === 'number') { if (v < rawMin) rawMin = v; if (v > rawMax) rawMax = v }
    }
    if (!isFinite(rawMin)) { rawMin = -1; rawMax = 1 }
    if (rawMin === rawMax) { rawMin -= 1; rawMax += 1 }
    return { rawMin, rawMax }
  })

  let xMin = Infinity, xMax = -Infinity
  rows.forEach((row, i) => {
    const x = xOf(row, i)
    if (x < xMin) xMin = x
    if (x > xMax) xMax = x
  })
  const xSpan = xMax - xMin || 1

  const canvas = document.createElement('canvas')
  canvas.className = 'cm-preview-spark'
  const dpr = window.devicePixelRatio || 1
  canvas.width = SPARK_W * dpr
  canvas.height = SPARK_H * dpr
  canvas.style.width = SPARK_W + 'px'
  canvas.style.height = SPARK_H + 'px'
  const g = canvas.getContext('2d')
  if (!g) return { canvas, colRanges }
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
  const suffix = hasIndex ? 's' : ''
  g.fillStyle = '#607a96'
  g.font = '8px system-ui'
  g.textBaseline = 'top'
  ticks.forEach((t, i) => {
    const x = px(t)
    if (x < pad.l - 2 || x > SPARK_W - pad.r + 2) return
    g.textAlign = i === 0 ? 'left' : i === ticks.length - 1 ? 'right' : 'center'
    g.fillText(t.toFixed(dec) + suffix, x, SPARK_H - pad.b + 2)
  })

  return { canvas, colRanges }
}

export function buildTablePreview(
  table: Table,
  { maxRows = 6, maxCols = 6, playIndex = null }: { maxRows?: number; maxCols?: number; playIndex?: number | null } = {},
): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'cm-preview'

  const allCols = table.columns
  const cols = allCols.slice(0, maxCols)
  const hasMoreCols = allCols.length > maxCols

  const head = document.createElement('div')
  head.className = 'cm-preview-head'
  const rowsLabel = `${table.length} row${table.length === 1 ? '' : 's'}`
  const colsLabel = `${allCols.length} col${allCols.length === 1 ? '' : 's'}`
  head.textContent = `${table.name ?? 'table'} · ${rowsLabel} · ${colsLabel}`
  wrap.appendChild(head)

  const hasIndex = allCols.includes('index')
  const xOf = (row: Row, i: number): number => (hasIndex ? (row.index as number) : i)
  const numCols = allCols.filter(
    (c) => c !== 'index' && table.rows.some((r) => typeof r[c] === 'number'),
  )
  if (numCols.length) {
    const result = drawSparklines(table.rows, numCols, xOf, hasIndex, playIndex)
    if (result) {
      const { canvas: spark, colRanges } = result
      wrap.appendChild(spark)
      const legend = document.createElement('div')
      legend.className = 'cm-preview-spark-label'
      numCols.forEach((c, ci) => {
        const item = document.createElement('span')
        item.className = 'cm-preview-series'
        const dot = document.createElement('span')
        dot.className = 'cm-preview-dot'
        dot.style.background = SERIES_COLORS[ci % SERIES_COLORS.length]
        item.appendChild(dot)
        item.appendChild(document.createTextNode(c))
        if (colRanges?.[ci]) {
          const { rawMin, rawMax } = colRanges[ci]
          const range = document.createElement('span')
          range.className = 'graph-range'
          range.textContent = ` ${fmtNum(rawMin)}–${fmtNum(rawMax)}`
          item.appendChild(range)
        }
        legend.appendChild(item)
      })
      wrap.appendChild(legend)
    }
  }

  if (cols.length) {
    const t = document.createElement('table')
    t.className = 'cm-preview-table'

    const thead = document.createElement('thead')
    const hr = document.createElement('tr')
    cols.forEach((c) => {
      const th = document.createElement('th')
      th.textContent = c
      hr.appendChild(th)
    })
    if (hasMoreCols) {
      const th = document.createElement('th')
      th.textContent = '…'
      hr.appendChild(th)
    }
    thead.appendChild(hr)
    t.appendChild(thead)

    const tbody = document.createElement('tbody')
    table.rows.slice(0, maxRows).forEach((row) => {
      const tr = document.createElement('tr')
      cols.forEach((c) => {
        const td = document.createElement('td')
        td.textContent = formatCell(c, row[c])
        tr.appendChild(td)
      })
      if (hasMoreCols) {
        const td = document.createElement('td')
        td.textContent = '…'
        tr.appendChild(td)
      }
      tbody.appendChild(tr)
    })
    t.appendChild(tbody)
    wrap.appendChild(t)
  }

  if (table.length > maxRows) {
    const more = document.createElement('div')
    more.className = 'cm-preview-more'
    more.textContent = `+${table.length - maxRows} more rows`
    wrap.appendChild(more)
  }

  return wrap
}
