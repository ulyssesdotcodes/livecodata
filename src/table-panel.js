// Combined table + graph panel. Each tab shows one view; if the view has a
// graph spec (.graph() was called on it), a mini chart appears at the top.
// The table autoscrolls to the active row during playback unless the user
// has manually scrolled since the last time Play was pressed.

import { SERIES_COLORS, resolveSpec, drawChartToCanvas } from './graph-panel.js'

const MAX_ROWS = 1000

export function formatCell(col, value) {
  if (value == null) return ''
  if (typeof value === 'function') return value.name ? `ƒ ${value.name}` : 'ƒ'
  if (col === 'color' && typeof value === 'number') {
    return '0x' + value.toString(16).padStart(6, '0')
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : value.toFixed(3)
  }
  // Nested objects (e.g. an effect event's `params`) — show as compact JSON.
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

export function initTablePanel(container) {
  container.innerHTML = ''

  let store = new Map()
  let graphByName = new Map() // tableName → { table, columns } spec
  let current = null
  let currentRows = []
  let indexCol = null
  let rowEls = []
  let playIndex = 0
  let playActive = null

  // Auto-scroll: user scroll suppresses autoscroll until resetAutoscroll() is called.
  let userScrolled = false
  let suppressScrollEvent = false

  // Chart for the currently-visible tab (null when tab has no graph spec).
  let currentChart = null
  const ro = new ResizeObserver(() => { if (currentChart) drawCurrentChart() })

  // ── Header ──
  const header = document.createElement('div')
  header.className = 'table-pane-header'

  const tabs = document.createElement('div')
  tabs.className = 'table-tabs'
  header.appendChild(tabs)

  const countEl = document.createElement('span')
  countEl.className = 'table-count'
  header.appendChild(countEl)

  container.appendChild(header)

  // ── Content area (graph section + table scroll, stacked vertically) ──
  const content = document.createElement('div')
  content.className = 'tab-content'
  container.appendChild(content)

  // Graph section (inserted into content when the current tab is graphable).
  const graphSection = document.createElement('div')
  graphSection.className = 'tab-graph'

  const graphLegend = document.createElement('div')
  graphLegend.className = 'graph-legend'
  graphSection.appendChild(graphLegend)

  const graphCanvas = document.createElement('canvas')
  graphCanvas.className = 'tab-graph-canvas'
  graphSection.appendChild(graphCanvas)

  // Table scroll section (always present in content).
  const scroll = document.createElement('div')
  scroll.className = 'tab-scroll'
  content.appendChild(scroll)

  scroll.addEventListener('scroll', () => {
    if (!suppressScrollEvent) userScrolled = true
  })

  const table = document.createElement('table')
  table.className = 'events-table'
  scroll.appendChild(table)

  const thead = document.createElement('thead')
  table.appendChild(thead)
  const tbody = document.createElement('tbody')
  table.appendChild(tbody)

  // ── Tab tracking ──
  let tabEls = new Map()

  function highlightTab(name) {
    tabEls.forEach((el, n) => el.classList.toggle('tab-active', n === name))
  }

  function drawCurrentChart() {
    if (!currentChart) return
    drawChartToCanvas(graphCanvas, currentChart, playIndex, playActive)
  }

  function render(name) {
    current = name
    highlightTab(name)
    userScrolled = false // switching tabs resumes autoscroll for the new tab

    // ── Graph section ──
    ro.disconnect()
    const spec = graphByName.get(name)
    if (spec) {
      const { rows, cols, xOf } = resolveSpec(spec)
      if (cols.length && rows.length) {
        let xMin = Infinity, xMax = -Infinity
        rows.forEach((row, i) => {
          const x = xOf(row, i)
          if (x < xMin) xMin = x
          if (x > xMax) xMax = x
        })
        currentChart = { rows, cols, xOf, xMin, xMax, name }

        graphLegend.innerHTML = ''
        cols.forEach((c, ci) => {
          const item = document.createElement('span')
          item.className = 'graph-series'
          const dot = document.createElement('span')
          dot.className = 'graph-dot'
          dot.style.background = SERIES_COLORS[ci % SERIES_COLORS.length]
          item.appendChild(dot)
          item.appendChild(document.createTextNode(c))
          graphLegend.appendChild(item)
        })

        if (!content.contains(graphSection)) content.insertBefore(graphSection, scroll)
        ro.observe(graphCanvas)
        drawCurrentChart()
      } else {
        currentChart = null
        graphSection.remove()
      }
    } else {
      currentChart = null
      graphSection.remove()
    }

    // ── Table rows ──
    thead.innerHTML = ''
    tbody.innerHTML = ''
    rowEls = []
    currentRows = []
    indexCol = null

    const t = store.get(name)
    if (!t || !t.length) {
      countEl.textContent = t ? '0 rows' : ''
      return
    }

    const cols = t.columns
    indexCol = cols.includes('index') ? 'index' : null

    const headRow = document.createElement('tr')
    cols.forEach(col => {
      const th = document.createElement('th')
      th.textContent = col
      headRow.appendChild(th)
    })
    thead.appendChild(headRow)

    const shown = t.rows.slice(0, MAX_ROWS)
    currentRows = shown
    shown.forEach(row => {
      const tr = document.createElement('tr')
      cols.forEach(col => {
        const td = document.createElement('td')
        td.textContent = formatCell(col, row[col])
        tr.appendChild(td)
      })
      tbody.appendChild(tr)
      rowEls.push(tr)
    })

    countEl.textContent = t.length > MAX_ROWS
      ? `${t.length} rows (showing ${MAX_ROWS})`
      : `${t.length} row${t.length === 1 ? '' : 's'}`
  }

  return {
    selectTable(name) {
      if (name != null && store.has(name) && name !== current) render(name)
    },

    setTables(newStore) {
      store = newStore
      const names = [...store.keys()]
      tabs.innerHTML = ''
      tabEls = new Map()
      names.forEach(n => {
        const tab = document.createElement('button')
        tab.className = 'table-tab'
        tab.textContent = n
        tab.onclick = () => render(n)
        tabs.appendChild(tab)
        tabEls.set(n, tab)
      })
      if (!names.length) { render(null); return }
      let next = names.includes(current) ? current : null
      if (!next) next = names.includes('events') ? 'events' : names[names.length - 1]
      render(next)
    },

    setGraphs(newSpecs) {
      graphByName = new Map()
      for (const spec of (newSpecs ?? [])) {
        if (spec.table?.name) graphByName.set(spec.table.name, spec)
      }
      if (current) render(current)
    },

    highlightIndex(idx) {
      playIndex = idx
      drawCurrentChart()
      if (!indexCol) return
      let activeIdx = -1
      for (let i = 0; i < currentRows.length; i++) {
        if (currentRows[i][indexCol] <= idx) activeIdx = i
        else break
      }
      rowEls.forEach((tr, i) => tr.classList.toggle('row-active', i === activeIdx))
      if (!userScrolled && activeIdx >= 0) {
        suppressScrollEvent = true
        rowEls[activeIdx].scrollIntoView({ block: 'nearest' })
        requestAnimationFrame(() => { suppressScrollEvent = false })
      }
    },

    highlightLineage(active) {
      playActive = active
      drawCurrentChart()
      const set = active?.get(current)
      rowEls.forEach((tr, i) => tr.classList.toggle('row-source', !!set?.has(i)))
    },

    // Call when Play is pressed to re-enable autoscroll.
    resetAutoscroll() {
      userScrolled = false
    },
  }
}
