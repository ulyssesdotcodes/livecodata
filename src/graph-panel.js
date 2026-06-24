// Chart drawing utilities shared by the combined table+graph panel and preview.js.

export const SERIES_COLORS = [
  '#4a9eff', '#ff6b6b', '#51cf66', '#ffd43b', '#cc5de8', '#ff922b', '#22d3ee',
]

function isNumericColumn(rows, col) {
  return rows.some(r => typeof r[col] === 'number')
}

// Resolve which columns to plot and the x-accessor for a spec.
export function resolveSpec(spec) {
  const rows = spec.table.rows
  const allCols = spec.table.columns
  let cols = spec.columns.length ? spec.columns : allCols.filter(c => c !== 'index')
  cols = cols.filter(c => isNumericColumn(rows, c))
  const hasIndex = allCols.includes('index')
  const xOf = (row, i) => (hasIndex ? row.index : i)
  return { rows, cols, xOf }
}

// Draw a chart to a canvas element. chartData: { rows, cols, xOf, xMin, xMax, name }.
export function drawChartToCanvas(canvas, chartData, playIndex, playActive) {
  const { rows, cols, xOf, xMin, xMax, name } = chartData
  const g = canvas.getContext('2d')
  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  if (w === 0 || h === 0) return
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  g.clearRect(0, 0, w, h)

  const pad = { l: 6, r: 6, t: 8, b: 8 }
  const plotW = w - pad.l - pad.r
  const plotH = h - pad.t - pad.b

  let yMin = Infinity, yMax = -Infinity
  for (const row of rows) {
    for (const c of cols) {
      const v = row[c]
      if (typeof v === 'number') {
        if (v < yMin) yMin = v
        if (v > yMax) yMax = v
      }
    }
  }
  if (!isFinite(yMin)) { yMin = -1; yMax = 1 }
  if (yMin === yMax) { yMin -= 1; yMax += 1 }
  const yPad = (yMax - yMin) * 0.08
  yMin -= yPad; yMax += yPad

  const xSpan = xMax - xMin || 1
  const px = (x) => pad.l + ((x - xMin) / xSpan) * plotW
  const py = (y) => pad.t + (1 - (y - yMin) / (yMax - yMin)) * plotH

  if (yMin < 0 && yMax > 0) {
    g.strokeStyle = 'rgba(140,160,184,0.25)'
    g.lineWidth = 1
    g.beginPath()
    g.moveTo(pad.l, py(0))
    g.lineTo(w - pad.r, py(0))
    g.stroke()
  }

  cols.forEach((c, ci) => {
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
      cols.forEach((c) => {
        const v = row[c]
        if (typeof v !== 'number') return
        g.beginPath()
        g.arc(px(xOf(row, ordinal)), py(v), 3.5, 0, Math.PI * 2)
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
}
