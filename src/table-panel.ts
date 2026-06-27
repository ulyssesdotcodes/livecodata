// Combined table + graph panel. Each tab shows one view; if the view has
// numeric columns a chart appears at the top (auto-detected or from .graph()).
// The table autoscrolls to the active row during playback unless the user
// has manually scrolled since the last time Play was pressed.

import { SERIES_COLORS, resolveSpec, drawChartToCanvas, fmtNum, type GraphSpec, type ChartData } from './graph-panel.js'
import type { Table } from './dsl.js'
import type { Row } from './lineage.js'

const MAX_ROWS = 1000

export function formatCell(col: string, value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'function') return value.name ? `ƒ ${value.name}` : 'ƒ'
  if (col === 'color' && typeof value === 'number') {
    return '0x' + value.toString(16).padStart(6, '0')
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : value.toFixed(3)
  }
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

export interface TablePanel {
  selectTable(name: string | null): void
  setTables(newStore: Map<string, Table>): void
  setGraphs(newSpecs: GraphSpec[] | null): void
  highlightIndex(idx: number): void
  highlightLineage(active: Map<string, Set<number>> | null): void
  resetAutoscroll(): void
}

export function initTablePanel(container: HTMLElement): TablePanel {
  container.innerHTML = ''

  let store = new Map<string, Table>()
  let graphByName = new Map<string, GraphSpec>()
  let current: string | null = null
  let currentRows: Row[] = []
  let indexCol: string | null = null
  let rowEls: HTMLTableRowElement[] = []
  let playIndex = 0
  let playActive: Map<string, Set<number>> | null = null

  let userScrolled = false
  let suppressScrollEvent = false

  let currentChart: ChartData | null = null
  const ro = new ResizeObserver(() => { if (currentChart) drawCurrentChart() })

  const header = document.createElement('div')
  header.className = 'table-pane-header'

  const tabs = document.createElement('div')
  tabs.className = 'table-tabs'
  header.appendChild(tabs)

  const countEl = document.createElement('span')
  countEl.className = 'table-count'
  header.appendChild(countEl)

  container.appendChild(header)

  const content = document.createElement('div')
  content.className = 'tab-content'
  container.appendChild(content)

  const graphSection = document.createElement('div')
  graphSection.className = 'tab-graph'

  const graphLegend = document.createElement('div')
  graphLegend.className = 'graph-legend'
  graphSection.appendChild(graphLegend)

  const graphCanvas = document.createElement('canvas')
  graphCanvas.className = 'tab-graph-canvas'
  graphSection.appendChild(graphCanvas)

  const scroll = document.createElement('div')
  scroll.className = 'tab-scroll'
  content.appendChild(scroll)

  scroll.addEventListener('scroll', () => {
    if (!suppressScrollEvent) userScrolled = true
  })

  const tableEl = document.createElement('table')
  tableEl.className = 'events-table'
  scroll.appendChild(tableEl)

  const thead = document.createElement('thead')
  tableEl.appendChild(thead)
  const tbody = document.createElement('tbody')
  tableEl.appendChild(tbody)

  let tabEls = new Map<string, HTMLButtonElement>()

  function highlightTab(name: string | null): void {
    tabEls.forEach((el, n) => el.classList.toggle('tab-active', n === name))
  }

  function drawCurrentChart(): void {
    if (!currentChart) return
    const colRanges = drawChartToCanvas(graphCanvas, currentChart, playIndex, playActive)
    if (colRanges) {
      const seriesEls = graphLegend.querySelectorAll('.graph-series')
      seriesEls.forEach((el, ci) => {
        if (ci >= colRanges.length) return
        const { rawMin, rawMax } = colRanges[ci]
        let rangeEl = el.querySelector('.graph-range')
        if (!rangeEl) {
          rangeEl = document.createElement('span')
          rangeEl.className = 'graph-range'
          el.appendChild(rangeEl)
        }
        rangeEl.textContent = `${fmtNum(rawMin)}–${fmtNum(rawMax)}`
      })
    }
  }

  function render(name: string | null): void {
    current = name
    highlightTab(name)
    userScrolled = false

    ro.disconnect()

    let spec = name ? graphByName.get(name) : undefined
    if (!spec && name) {
      const t = store.get(name)
      if (t && t.rows.length) {
        const numericCols = t.columns.filter(
          (c) => c !== 'index' && t.rows.some((r) => typeof r[c] === 'number'),
        )
        if (numericCols.length) spec = { table: t, columns: numericCols, viewName: name }
      }
    }

    if (spec) {
      const { rows, cols, xOf, hasIndex } = resolveSpec(spec)
      if (cols.length && rows.length) {
        let xMin = Infinity, xMax = -Infinity
        rows.forEach((row, i) => {
          const x = xOf(row, i)
          if (x < xMin) xMin = x
          if (x > xMax) xMax = x
        })
        currentChart = { rows, cols, xOf, hasIndex, xMin, xMax, name: name ?? '' }

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

    thead.innerHTML = ''
    tbody.innerHTML = ''
    rowEls = []
    currentRows = []
    indexCol = null

    if (!name) return
    const t = store.get(name)
    if (!t || !t.length) {
      countEl.textContent = t ? '0 rows' : ''
      return
    }

    const cols = t.columns
    indexCol = cols.includes('index') ? 'index' : null

    const headRow = document.createElement('tr')
    cols.forEach((col) => {
      const th = document.createElement('th')
      th.textContent = col
      headRow.appendChild(th)
    })
    thead.appendChild(headRow)

    const shown = t.rows.slice(0, MAX_ROWS)
    currentRows = shown
    shown.forEach((row) => {
      const tr = document.createElement('tr')
      cols.forEach((col) => {
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
    selectTable(name: string | null): void {
      if (name != null && store.has(name) && name !== current) render(name)
    },

    setTables(newStore: Map<string, Table>): void {
      store = newStore
      const names = [...store.keys()]
      tabs.innerHTML = ''
      tabEls = new Map()
      names.forEach((n) => {
        const tab = document.createElement('button')
        tab.className = 'table-tab'
        tab.textContent = n
        tab.onclick = () => render(n)
        tabs.appendChild(tab)
        tabEls.set(n, tab)
      })
      if (!names.length) { render(null); return }
      let next = names.includes(current ?? '') ? current : null
      if (!next) next = names.includes('events') ? 'events' : names[names.length - 1]
      render(next ?? null)
    },

    setGraphs(newSpecs: GraphSpec[] | null): void {
      graphByName = new Map()
      for (const spec of (newSpecs ?? [])) {
        const name = spec.viewName ?? spec.table?.name
        if (name) graphByName.set(name, spec)
      }
      if (current) render(current)
    },

    highlightIndex(idx: number): void {
      playIndex = idx
      drawCurrentChart()
      if (!indexCol) return
      let activeIdx = -1
      for (let i = 0; i < currentRows.length; i++) {
        if ((currentRows[i][indexCol] as number) <= idx) activeIdx = i
        else break
      }
      rowEls.forEach((tr, i) => tr.classList.toggle('row-active', i === activeIdx))
      if (!userScrolled && activeIdx >= 0) {
        suppressScrollEvent = true
        rowEls[activeIdx].scrollIntoView({ block: 'nearest' })
        requestAnimationFrame(() => { suppressScrollEvent = false })
      }
    },

    highlightLineage(active: Map<string, Set<number>> | null): void {
      playActive = active
      drawCurrentChart()
      const set = active?.get(current ?? '')
      rowEls.forEach((tr, i) => tr.classList.toggle('row-source', !!set?.has(i)))
    },

    resetAutoscroll(): void {
      userScrolled = false
    },
  }
}
