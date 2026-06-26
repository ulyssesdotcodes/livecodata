// Inline table preview. Builds a compact DOM card — a sparkline of every
// numeric column plus the first few rows/columns — for any Table. Used by the
// editor's hover tooltip so you can see a view's data without leaving the code
// (reusing the table panel's cell formatter for consistent display).

import { formatCell } from './table-panel.js'
import { SERIES_COLORS } from './graph-panel.js'

const SPARK_W = 220
const SPARK_H = 36

// A tiny multi-line chart of `cols` plotted against `xOf` (the row's `index`
// in seconds when the table has one, else its ordinal) — one colored series per
// column, sharing a single y-range like the graph panel. Returns a <canvas>,
// or null when no column has enough numeric data to draw a line.
function drawSparklines(rows, cols, xOf, playIndex = null) {
  // A line needs at least two points; bail if no series qualifies.
  const drawable = cols.some(
    (c) => rows.filter((r) => typeof r[c] === 'number').length >= 2,
  )
  if (!drawable) return null

  // Per-column y-ranges so series with very different scales each fill the height.
  const colRanges = cols.map((c) => {
    let min = Infinity, max = -Infinity
    for (const row of rows) {
      const v = row[c]
      if (typeof v === 'number') { if (v < min) min = v; if (v > max) max = v }
    }
    if (!isFinite(min)) { min = -1; max = 1 }
    if (min === max) { min -= 1; max += 1 }
    return { min, max }
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
  g.setTransform(dpr, 0, 0, dpr, 0, 0)

  const pad = 3
  const px = (x) => pad + ((x - xMin) / xSpan) * (SPARK_W - 2 * pad)

  cols.forEach((c, ci) => {
    const { min, max } = colRanges[ci]
    const yRange = max - min
    const py = (v) => pad + (1 - (v - min) / yRange) * (SPARK_H - 2 * pad)

    if (min < 0 && max > 0) {
      g.strokeStyle = `${SERIES_COLORS[ci % SERIES_COLORS.length]}44`
      g.lineWidth = 1
      g.beginPath(); g.moveTo(pad, py(0)); g.lineTo(SPARK_W - pad, py(0)); g.stroke()
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
    const cx = pad + ((playIndex - xMin) / xSpan) * (SPARK_W - 2 * pad)
    if (cx >= 0 && cx <= SPARK_W) {
      g.strokeStyle = '#e94560'
      g.lineWidth = 1
      g.beginPath()
      g.moveTo(cx, 0)
      g.lineTo(cx, SPARK_H)
      g.stroke()
    }
  }

  return canvas
}

// Build a preview card for a Table: header (name · rows · cols), a sparkline of
// every numeric column (besides index), and the first maxRows×maxCols cells.
export function buildTablePreview(table, { maxRows = 6, maxCols = 6, playIndex = null } = {}) {
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

  // Every numeric column except the index — each drawn as its own line against
  // the index (seconds) on the x-axis, like the graph panel. A table with only
  // an index has nothing to plot, so the graph is skipped entirely.
  const hasIndex = allCols.includes('index')
  const xOf = (row, i) => (hasIndex ? row.index : i)
  const numCols = allCols.filter(
    (c) => c !== 'index' && table.rows.some((r) => typeof r[c] === 'number'),
  )
  if (numCols.length) {
    const spark = drawSparklines(table.rows, numCols, xOf, playIndex)
    if (spark) {
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
