// Combined table + graph panel. Each tab shows one view; if the view has
// numeric columns a chart appears at the top (auto-detected or from .graph()).
// The table autoscrolls to the active row during playback unless the user
// has manually scrolled since the last time Play was pressed.
//
// Two kinds of tables share the tab strip: code-generated *views* (from the
// current run's cook, read-only) and user *editable tables* (from the
// EditableTableStore — created with the "+ table" button, or declared in the
// DSL via editable(name, schema)). Editable tables render with inline
// controls (add/rename/retype column, add/remove row, click-to-edit cells;
// number columns get a slider) and survive re-runs since they don't come from
// the cook.

import { SERIES_COLORS, resolveSpec, drawChartToCanvas, fmtNum, type GraphSpec, type ChartData } from './graph-panel.js'
import type { Table } from './dsl.js'
import type { Row } from './lineage.js'
import type { EditableTableStore, ColumnType, EditableColumn } from './editable-tables.js'

const MAX_ROWS = 1000
const COLUMN_TYPES: ColumnType[] = ['number', 'string', 'boolean']

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

function formatEditableCell(type: ColumnType, value: unknown): string {
  if (value == null) return ''
  if (type === 'boolean') return value ? 'true' : 'false'
  if (type === 'number') {
    const n = Number(value)
    if (!Number.isFinite(n)) return ''
    return Number.isInteger(n) ? String(n) : n.toFixed(3)
  }
  return String(value)
}

// A slider range/step for a number cell: spans at least the current column's
// values (and 0..10), padded so the slider always has room to move.
function numericRange(values: number[], cur: number): { lo: number; hi: number; step: number } {
  const finite = values.filter((v) => Number.isFinite(v))
  let lo = Math.min(0, cur, ...finite)
  let hi = Math.max(10, cur, ...finite)
  if (!Number.isFinite(lo)) lo = 0
  if (!Number.isFinite(hi)) hi = 10
  if (lo === hi) hi = lo + 10
  const span = hi - lo
  const allInts = Number.isInteger(cur) && finite.every((v) => Number.isInteger(v))
  const step = allInts && span <= 1000 ? 1 : span / 100
  return { lo, hi, step: step || 1 }
}

export interface TablePanel {
  selectTable(name: string | null): void
  setTables(newStore: Map<string, Table>): void
  setGraphs(newSpecs: GraphSpec[] | null): void
  highlightIndex(idx: number): void
  highlightLineage(active: Map<string, Set<number>> | null): void
  resetAutoscroll(): void
}

export function initTablePanel(container: HTMLElement, editableStore: EditableTableStore): TablePanel {
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

  // Only one cell can be in edit mode at a time; clicking outside it collapses it.
  let closeActiveEdit: (() => void) | null = null
  document.addEventListener('mousedown', (e) => {
    if (!closeActiveEdit) return
    const target = e.target as HTMLElement | null
    if (target?.closest?.('.editable-cell.editing')) return
    closeActiveEdit()
  })

  const header = document.createElement('div')
  header.className = 'table-pane-header'

  const tabs = document.createElement('div')
  tabs.className = 'table-tabs'
  header.appendChild(tabs)

  const addTableBtn = document.createElement('button')
  addTableBtn.className = 'table-tab-add'
  addTableBtn.textContent = '+ table'
  addTableBtn.title = 'Add a new editable table'
  addTableBtn.onclick = () => {
    const name = nextTableName()
    editableStore.createTable(name)
    current = name
    rebuildTabs()
  }

  const filterInput = document.createElement('input')
  filterInput.className = 'table-filter'
  filterInput.type = 'text'
  filterInput.placeholder = 'filter…'
  header.appendChild(filterInput)

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

  const editToolbar = document.createElement('div')
  editToolbar.className = 'edit-toolbar'
  editToolbar.style.display = 'none'
  const addRowBtn = document.createElement('button')
  addRowBtn.className = 'add-row-btn'
  addRowBtn.textContent = '+ row'
  editToolbar.appendChild(addRowBtn)
  content.appendChild(editToolbar)

  let tabEls = new Map<string, HTMLButtonElement>()
  let filterText = ''

  function nextTableName(): string {
    let i = 1
    while (store.has(`table${i}`) || editableStore.has(`table${i}`)) i++
    return `table${i}`
  }

  function allNames(): string[] {
    const names = [...store.keys()]
    for (const n of editableStore.listNames()) if (!names.includes(n)) names.push(n)
    return names
  }

  function applyFilter(): void {
    const q = filterText
    let visible = 0
    rowEls.forEach((tr) => {
      const show = !q || tr.textContent!.toLowerCase().includes(q)
      tr.hidden = !show
      if (show) visible++
    })
    if (q && rowEls.length) {
      const total = currentRows.length
      countEl.textContent = `${visible} / ${total} row${total === 1 ? '' : 's'}`
    }
  }

  filterInput.addEventListener('input', () => {
    filterText = filterInput.value.toLowerCase()
    applyFilter()
  })

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

  function makeTab(name: string): HTMLButtonElement {
    const tab = document.createElement('button')
    const editable = editableStore.has(name)
    tab.className = 'table-tab' + (editable ? ' table-tab-editable' : '')
    tab.onclick = () => render(name)

    const label = document.createElement('span')
    label.className = 'tab-label'
    label.textContent = name
    tab.appendChild(label)

    if (editable) {
      tab.title = 'Double-click to rename'
      tab.ondblclick = (e) => {
        e.stopPropagation()
        tab.innerHTML = ''
        const input = document.createElement('input')
        input.className = 'tab-rename-input'
        input.value = name
        const commit = (): void => {
          const v = input.value.trim()
          if (v && v !== name && editableStore.renameTable(name, v) && current === name) current = v
          rebuildTabs()
        }
        input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') input.blur() })
        input.addEventListener('blur', commit)
        input.addEventListener('click', (ev) => ev.stopPropagation())
        tab.appendChild(input)
        input.focus()
        input.select()
      }

      const del = document.createElement('span')
      del.className = 'tab-del'
      del.textContent = '×'
      del.title = 'Delete table'
      del.onclick = (e) => {
        e.stopPropagation()
        editableStore.removeTable(name)
        if (current === name) current = null
        rebuildTabs()
      }
      tab.appendChild(del)
    }

    return tab
  }

  function rebuildTabs(): void {
    const names = allNames()
    tabs.innerHTML = ''
    tabEls = new Map()
    names.forEach((n) => {
      const tab = makeTab(n)
      tabs.appendChild(tab)
      tabEls.set(n, tab)
    })
    tabs.appendChild(addTableBtn)

    if (!names.length) { render(null); return }
    let next = names.includes(current ?? '') ? current : null
    if (!next) next = names.includes('events') ? 'events' : names[names.length - 1]
    render(next ?? null)
  }

  function buildAddColHeader(name: string): HTMLTableCellElement {
    const th = document.createElement('th')
    th.className = 'add-col-head'
    const btn = document.createElement('button')
    btn.className = 'add-col-btn'
    btn.textContent = '+ column'
    btn.onclick = () => {
      th.innerHTML = ''
      const nameInput = document.createElement('input')
      nameInput.className = 'col-name-input new-col-name'
      nameInput.placeholder = 'name'
      const typeSel = document.createElement('select')
      typeSel.className = 'col-type-select'
      COLUMN_TYPES.forEach((t) => {
        const opt = document.createElement('option')
        opt.value = t
        opt.textContent = t
        typeSel.appendChild(opt)
      })
      const confirmBtn = document.createElement('button')
      confirmBtn.className = 'col-confirm-btn'
      confirmBtn.textContent = '✓'
      const commit = (): void => {
        const colName = nameInput.value.trim()
        if (colName) editableStore.addColumn(name, colName, typeSel.value as ColumnType)
        render(name)
      }
      confirmBtn.onclick = commit
      nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit() })
      th.append(nameInput, typeSel, confirmBtn)
      nameInput.focus()
    }
    th.appendChild(btn)
    return th
  }

  function buildColHeader(name: string, col: EditableColumn): HTMLTableCellElement {
    const th = document.createElement('th')
    th.className = 'editable-col-head'

    const nameInput = document.createElement('input')
    nameInput.className = 'col-name-input'
    nameInput.value = col.name
    nameInput.addEventListener('change', () => {
      const v = nameInput.value.trim()
      if (v && v !== col.name) editableStore.renameColumn(name, col.name, v)
      render(name)
    })
    th.appendChild(nameInput)

    const typeSel = document.createElement('select')
    typeSel.className = 'col-type-select'
    COLUMN_TYPES.forEach((t) => {
      const opt = document.createElement('option')
      opt.value = t
      opt.textContent = t
      if (t === col.type) opt.selected = true
      typeSel.appendChild(opt)
    })
    typeSel.addEventListener('change', () => {
      editableStore.setColumnType(name, col.name, typeSel.value as ColumnType)
      render(name)
    })
    th.appendChild(typeSel)

    const delBtn = document.createElement('button')
    delBtn.className = 'col-del-btn'
    delBtn.textContent = '×'
    delBtn.title = 'Remove column'
    delBtn.onclick = () => { editableStore.removeColumn(name, col.name); render(name) }
    th.appendChild(delBtn)

    return th
  }

  // A single editable cell: click to open an editor in place (slider + number
  // box for numbers, checkbox for booleans, text box otherwise); collapses
  // back to a plain display on commit or on an outside click.
  function makeEditableCell(td: HTMLTableCellElement, name: string, rowIndex: number, col: EditableColumn): void {
    const showDisplay = (): void => {
      if (closeActiveEdit === showDisplay) closeActiveEdit = null
      td.classList.remove('editing')
      td.innerHTML = ''
      const span = document.createElement('span')
      span.className = 'cell-value'
      const raw = editableStore.get(name)?.rows[rowIndex]?.[col.name]
      span.textContent = formatEditableCell(col.type, raw)
      td.appendChild(span)
      td.onclick = showEdit
    }

    const showEdit = (): void => {
      closeActiveEdit?.()
      closeActiveEdit = showDisplay
      td.classList.add('editing')
      td.innerHTML = ''
      td.onclick = null
      const data = editableStore.get(name)
      const raw = data?.rows[rowIndex]?.[col.name]

      if (col.type === 'boolean') {
        const cb = document.createElement('input')
        cb.type = 'checkbox'
        cb.checked = !!raw
        cb.addEventListener('change', () => {
          editableStore.setCell(name, rowIndex, col.name, cb.checked)
          showDisplay()
        })
        td.appendChild(cb)
        cb.focus()
      } else if (col.type === 'number') {
        const cur = Number(raw) || 0
        const values = (data?.rows ?? []).map((r) => Number(r[col.name]))
        const { lo, hi, step } = numericRange(values, cur)

        const wrap = document.createElement('div')
        wrap.className = 'cell-slider-wrap'

        const slider = document.createElement('input')
        slider.type = 'range'
        slider.className = 'cell-slider'
        slider.min = String(lo)
        slider.max = String(hi)
        slider.step = String(step)
        slider.value = String(cur)

        const num = document.createElement('input')
        num.type = 'number'
        num.className = 'cell-number'
        num.value = String(cur)
        num.step = String(step)

        slider.addEventListener('input', () => {
          num.value = slider.value
          editableStore.setCell(name, rowIndex, col.name, Number(slider.value))
        })
        num.addEventListener('input', () => {
          const v = Number(num.value)
          if (Number.isFinite(v)) {
            slider.value = String(v)
            editableStore.setCell(name, rowIndex, col.name, v)
          }
        })
        num.addEventListener('keydown', (e) => { if (e.key === 'Enter') showDisplay() })
        num.addEventListener('blur', () => showDisplay())

        wrap.append(slider, num)
        td.appendChild(wrap)
        slider.focus()
      } else {
        const inp = document.createElement('input')
        inp.type = 'text'
        inp.className = 'cell-text'
        inp.value = raw == null ? '' : String(raw)
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur() })
        inp.addEventListener('blur', () => {
          editableStore.setCell(name, rowIndex, col.name, inp.value)
          showDisplay()
        })
        td.appendChild(inp)
        inp.focus()
        inp.select()
      }
    }

    showDisplay()
  }

  function renderEditableTable(name: string): void {
    editToolbar.style.display = 'flex'
    addRowBtn.onclick = () => { editableStore.addRow(name); render(name) }

    thead.innerHTML = ''
    tbody.innerHTML = ''
    rowEls = []
    currentRows = []
    indexCol = null

    const data = editableStore.get(name)
    if (!data) { countEl.textContent = ''; return }

    const headRow = document.createElement('tr')
    const cornerTh = document.createElement('th')
    cornerTh.className = 'row-del-head'
    headRow.appendChild(cornerTh)
    data.columns.forEach((col) => headRow.appendChild(buildColHeader(name, col)))
    headRow.appendChild(buildAddColHeader(name))
    thead.appendChild(headRow)

    data.rows.forEach((_row, i) => {
      const tr = document.createElement('tr')
      const delTd = document.createElement('td')
      const delBtn = document.createElement('button')
      delBtn.className = 'row-del-btn'
      delBtn.textContent = '×'
      delBtn.title = 'Delete row'
      delBtn.onclick = () => { editableStore.removeRow(name, i); render(name) }
      delTd.appendChild(delBtn)
      tr.appendChild(delTd)

      data.columns.forEach((col) => {
        const td = document.createElement('td')
        td.className = 'editable-cell'
        makeEditableCell(td, name, i, col)
        tr.appendChild(td)
      })
      tr.appendChild(document.createElement('td'))

      tbody.appendChild(tr)
      rowEls.push(tr)
    })

    currentRows = data.rows
    countEl.textContent = `${data.rows.length} row${data.rows.length === 1 ? '' : 's'}`
    applyFilter()
  }

  function render(name: string | null): void {
    current = name
    highlightTab(name)
    userScrolled = false

    ro.disconnect()
    currentChart = null
    graphSection.remove()

    if (name && editableStore.has(name)) {
      renderEditableTable(name)
      return
    }

    editToolbar.style.display = 'none'

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
      : `${shown.length} row${shown.length === 1 ? '' : 's'}`

    applyFilter()
  }

  return {
    selectTable(name: string | null): void {
      if (name != null && (store.has(name) || editableStore.has(name)) && name !== current) render(name)
    },

    setTables(newStore: Map<string, Table>): void {
      store = newStore
      rebuildTabs()
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
