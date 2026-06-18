const DEFAULT_EVENTS = [
  { id: 'cube1',   type: 'create',  time: 0.0, shape: 'box',    px:  0.0, py:  0.0, pz: 0.0, rx: 0.0, ry: 0.0, rz: 0.0 },
  { id: 'sphere1', type: 'create',  time: 0.5, shape: 'sphere', px:  1.5, py:  0.0, pz: 0.0, rx: 0.0, ry: 0.0, rz: 0.0 },
  { id: 'cone1',   type: 'create',  time: 1.0, shape: 'cone',   px: -1.5, py:  0.0, pz: 0.0, rx: 0.0, ry: 0.0, rz: 0.0 },
  { id: 'cube1',   type: 'update',  time: 2.0, shape: '',       px:  0.0, py:  1.0, pz: 0.0, rx: 0.8, ry: 0.8, rz: 0.0 },
  { id: 'sphere1', type: 'update',  time: 2.5, shape: '',       px: -1.5, py:  0.5, pz: 0.0, rx: 0.0, ry: 1.0, rz: 0.5 },
  { id: 'cone1',   type: 'destroy', time: 3.0, shape: '',       px:  0.0, py:  0.0, pz: 0.0, rx: 0.0, ry: 0.0, rz: 0.0 },
  { id: 'cube1',   type: 'destroy', time: 4.0, shape: '',       px:  0.0, py:  0.0, pz: 0.0, rx: 0.0, ry: 0.0, rz: 0.0 },
  { id: 'sphere1', type: 'destroy', time: 5.0, shape: '',       px:  0.0, py:  0.0, pz: 0.0, rx: 0.0, ry: 0.0, rz: 0.0 },
]

const COLS = [
  { key: 'id',    label: 'ID',     type: 'text',   w: '66px' },
  { key: 'type',  label: 'Type',   type: 'select', w: '70px', options: ['create', 'update', 'destroy'] },
  { key: 'time',  label: 't(s)',   type: 'number', w: '46px', min: 0,   step: 0.5 },
  { key: 'shape', label: 'Shape',  type: 'select', w: '66px', options: ['', 'box', 'sphere', 'cylinder', 'cone', 'torus'] },
  { key: 'px',    label: 'px',     type: 'number', w: '46px', step: 0.1 },
  { key: 'py',    label: 'py',     type: 'number', w: '46px', step: 0.1 },
  { key: 'pz',    label: 'pz',     type: 'number', w: '46px', step: 0.1 },
  { key: 'rx',    label: 'rx',     type: 'number', w: '46px', step: 0.1 },
  { key: 'ry',    label: 'ry',     type: 'number', w: '46px', step: 0.1 },
  { key: 'rz',    label: 'rz',     type: 'number', w: '46px', step: 0.1 },
]

export function initTablePanel(container) {
  const events = DEFAULT_EVENTS.map(e => ({ ...e }))
  let rowEls = []

  // Header
  const header = document.createElement('div')
  header.className = 'table-pane-header'

  const title = document.createElement('span')
  title.className = 'table-pane-title'
  title.textContent = 'Events'
  header.appendChild(title)

  const addBtn = document.createElement('button')
  addBtn.className = 'table-add-btn'
  addBtn.textContent = '+ Add'
  addBtn.onclick = () => {
    events.push({ id: 'obj' + events.length, type: 'create', time: 0, shape: 'box', px: 0, py: 0, pz: 0, rx: 0, ry: 0, rz: 0 })
    renderTable()
  }
  header.appendChild(addBtn)
  container.appendChild(header)

  // Scroll wrapper
  const scroll = document.createElement('div')
  scroll.className = 'table-scroll'
  container.appendChild(scroll)

  // Table
  const table = document.createElement('table')
  table.className = 'events-table'
  scroll.appendChild(table)

  // Thead
  const thead = document.createElement('thead')
  const headRow = document.createElement('tr')
  COLS.forEach(col => {
    const th = document.createElement('th')
    th.textContent = col.label
    th.style.minWidth = col.w
    headRow.appendChild(th)
  })
  headRow.appendChild(document.createElement('th'))
  thead.appendChild(headRow)
  table.appendChild(thead)

  // Tbody
  const tbody = document.createElement('tbody')
  table.appendChild(tbody)

  function buildRow(idx) {
    const event = events[idx]
    const tr = document.createElement('tr')

    COLS.forEach(col => {
      const td = document.createElement('td')

      if (col.type === 'select') {
        const sel = document.createElement('select')
        sel.className = 'cell-select'
        col.options.forEach(opt => {
          const o = document.createElement('option')
          o.value = opt
          o.textContent = opt || '—'
          if (opt === event[col.key]) o.selected = true
          sel.appendChild(o)
        })
        sel.onchange = e => { events[idx][col.key] = e.target.value }
        td.appendChild(sel)
      } else if (col.type === 'number') {
        const inp = document.createElement('input')
        inp.type = 'number'
        inp.className = 'cell-input'
        inp.value = event[col.key]
        inp.step = col.step ?? 0.1
        if (col.min !== undefined) inp.min = col.min
        inp.oninput = e => { events[idx][col.key] = parseFloat(e.target.value) || 0 }
        td.appendChild(inp)
      } else {
        const inp = document.createElement('input')
        inp.type = 'text'
        inp.className = 'cell-input'
        inp.value = event[col.key]
        inp.oninput = e => { events[idx][col.key] = e.target.value }
        td.appendChild(inp)
      }

      tr.appendChild(td)
    })

    const delTd = document.createElement('td')
    const delBtn = document.createElement('button')
    delBtn.className = 'delete-btn'
    delBtn.textContent = '×'
    delBtn.onclick = () => {
      events.splice(idx, 1)
      renderTable()
    }
    delTd.appendChild(delBtn)
    tr.appendChild(delTd)

    return tr
  }

  function renderTable() {
    tbody.innerHTML = ''
    rowEls = events.map((_, i) => {
      const tr = buildRow(i)
      tbody.appendChild(tr)
      return tr
    })
  }

  renderTable()

  return {
    getEvents: () => events.map(e => ({ ...e })),
    highlightRow(originalIdx) {
      rowEls.forEach((tr, i) => tr.classList.toggle('row-active', i === originalIdx))
    },
    clearHighlights() {
      rowEls.forEach(tr => tr.classList.remove('row-active'))
    },
  }
}
