// Graph panel. Renders the tables queued via Table.graph(...columns) as line
// charts: each selected column is a y-series plotted against the row index
// (x). A vertical playhead tracks the current playback index.

export const SERIES_COLORS = [
  '#4a9eff', '#ff6b6b', '#51cf66', '#ffd43b', '#cc5de8', '#ff922b', '#22d3ee',
]

function isNumericColumn(rows, col) {
  return rows.some(r => typeof r[col] === 'number')
}

// Resolve which columns to plot and the x-accessor for a spec.
function resolveSpec(spec) {
  const rows = spec.table.rows
  const allCols = spec.table.columns
  let cols = spec.columns.length ? spec.columns : allCols.filter(c => c !== 'index')
  cols = cols.filter(c => isNumericColumn(rows, c))
  const hasIndex = allCols.includes('index')
  const xOf = (row, i) => (hasIndex ? row.index : i)
  return { rows, cols, xOf }
}

export function initGraphPanel(container) {
  container.innerHTML = ''

  let specs = []
  let charts = [] // { canvas, ctx2d, rows, cols, xOf, xMin, xMax, name }
  let playIndex = 0
  let playActive = null // Map<table, Set<ordinal>> — provenance for this frame

  const header = document.createElement('div')
  header.className = 'graph-pane-header'
  const title = document.createElement('span')
  title.className = 'graph-pane-title'
  title.textContent = 'Graph'
  header.appendChild(title)
  container.appendChild(header)

  const scroll = document.createElement('div')
  scroll.className = 'graph-scroll'
  container.appendChild(scroll)

  const empty = document.createElement('div')
  empty.className = 'graph-empty'
  empty.textContent = 'No graphs — call .graph("column") on a table.'
  scroll.appendChild(empty)

  function drawChart(chart) {
    const { canvas, ctx2d: g, rows, cols, xOf, xMin, xMax, name } = chart
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

    // y-range across all plotted columns.
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

    // zero line
    if (yMin < 0 && yMax > 0) {
      g.strokeStyle = 'rgba(140,160,184,0.25)'
      g.lineWidth = 1
      g.beginPath()
      g.moveTo(pad.l, py(0))
      g.lineTo(w - pad.r, py(0))
      g.stroke()
    }

    // series
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

    // provenance markers: the points of this table feeding the current frame.
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

    // playhead
    if (playIndex >= xMin && playIndex <= xMax) {
      g.strokeStyle = '#e94560'
      g.lineWidth = 1
      g.beginPath()
      g.moveTo(px(playIndex), pad.t)
      g.lineTo(px(playIndex), h - pad.b)
      g.stroke()
    }
  }

  function drawAll() {
    for (const chart of charts) drawChart(chart)
  }

  const ro = new ResizeObserver(drawAll)

  function build() {
    ro.disconnect()
    scroll.innerHTML = ''
    charts = []

    if (!specs.length) {
      scroll.appendChild(empty)
      return
    }

    for (const spec of specs) {
      const { rows, cols, xOf } = resolveSpec(spec)
      if (!cols.length || !rows.length) continue

      const card = document.createElement('div')
      card.className = 'graph-card'

      const legend = document.createElement('div')
      legend.className = 'graph-legend'
      const label = document.createElement('span')
      label.className = 'graph-name'
      label.textContent = spec.table.name || 'table'
      legend.appendChild(label)
      cols.forEach((c, ci) => {
        const item = document.createElement('span')
        item.className = 'graph-series'
        const dot = document.createElement('span')
        dot.className = 'graph-dot'
        dot.style.background = SERIES_COLORS[ci % SERIES_COLORS.length]
        item.appendChild(dot)
        item.appendChild(document.createTextNode(c))
        legend.appendChild(item)
      })
      card.appendChild(legend)

      const canvas = document.createElement('canvas')
      canvas.className = 'graph-canvas'
      card.appendChild(canvas)
      scroll.appendChild(card)

      let xMin = Infinity, xMax = -Infinity
      rows.forEach((row, i) => {
        const x = xOf(row, i)
        if (x < xMin) xMin = x
        if (x > xMax) xMax = x
      })

      const chart = { canvas, ctx2d: canvas.getContext('2d'), rows, cols, xOf, xMin, xMax, name: spec.table.name }
      charts.push(chart)
      ro.observe(canvas)
    }
    drawAll()
  }

  return {
    setGraphs(newSpecs) {
      specs = newSpecs ?? []
      build()
    },
    highlightIndex(index) {
      playIndex = index
      drawAll()
    },
    highlightLineage(active) {
      playActive = active
      drawAll()
    },
  }
}
