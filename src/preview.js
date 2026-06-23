// Inline table preview. Builds a compact DOM card — a sparkline of the first
// numeric column plus the first few rows/columns — for any Table. Used by the
// editor's hover tooltip so you can see a view's data without leaving the code
// (reusing the table panel's cell formatter for consistent display).

import { formatCell } from './table-panel.js'

const SPARK_W = 220
const SPARK_H = 36

// A tiny line chart of `col` across the rows. Returns a <canvas>, or null when
// there isn't enough numeric data to be worth drawing.
function drawSparkline(rows, col) {
  const vals = rows.map((r) => r[col]).filter((v) => typeof v === 'number')
  if (vals.length < 2) return null

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
  let min = Math.min(...vals)
  let max = Math.max(...vals)
  if (min === max) { min -= 1; max += 1 }
  const x = (i) => pad + (i / (vals.length - 1)) * (SPARK_W - 2 * pad)
  const y = (v) => pad + (1 - (v - min) / (max - min)) * (SPARK_H - 2 * pad)

  if (min < 0 && max > 0) {
    g.strokeStyle = 'rgba(140,160,184,0.25)'
    g.lineWidth = 1
    g.beginPath(); g.moveTo(0, y(0)); g.lineTo(SPARK_W, y(0)); g.stroke()
  }
  g.strokeStyle = '#4a9eff'
  g.lineWidth = 1.25
  g.beginPath()
  vals.forEach((v, i) => (i ? g.lineTo(x(i), y(v)) : g.moveTo(x(i), y(v))))
  g.stroke()
  return canvas
}

// Build a preview card for a Table: header (name · rows · cols), a sparkline of
// the first numeric column (besides index), and the first maxRows×maxCols cells.
export function buildTablePreview(table, { maxRows = 6, maxCols = 6 } = {}) {
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

  const numCol = allCols.find(
    (c) => c !== 'index' && table.rows.some((r) => typeof r[c] === 'number'),
  )
  if (numCol) {
    const spark = drawSparkline(table.rows, numCol)
    if (spark) {
      wrap.appendChild(spark)
      const label = document.createElement('div')
      label.className = 'cm-preview-spark-label'
      label.textContent = numCol
      wrap.appendChild(label)
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
