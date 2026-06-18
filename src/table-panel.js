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
  { key: 'id',    label: 'ID'    },
  { key: 'type',  label: 'Type'  },
  { key: 'time',  label: 't(s)'  },
  { key: 'shape', label: 'Shape' },
  { key: 'px',    label: 'px'    },
  { key: 'py',    label: 'py'    },
  { key: 'pz',    label: 'pz'    },
  { key: 'rx',    label: 'rx'    },
  { key: 'ry',    label: 'ry'    },
  { key: 'rz',    label: 'rz'    },
]

export function initTablePanel(container) {
  const events = DEFAULT_EVENTS.map(e => ({ ...e }))
  let rowEls = []

  const header = document.createElement('div')
  header.className = 'table-pane-header'
  const title = document.createElement('span')
  title.className = 'table-pane-title'
  title.textContent = 'Events'
  header.appendChild(title)
  container.appendChild(header)

  const scroll = document.createElement('div')
  scroll.className = 'table-scroll'
  container.appendChild(scroll)

  const table = document.createElement('table')
  table.className = 'events-table'
  scroll.appendChild(table)

  const thead = document.createElement('thead')
  const headRow = document.createElement('tr')
  COLS.forEach(col => {
    const th = document.createElement('th')
    th.textContent = col.label
    headRow.appendChild(th)
  })
  thead.appendChild(headRow)
  table.appendChild(thead)

  const tbody = document.createElement('tbody')
  table.appendChild(tbody)

  rowEls = events.map(event => {
    const tr = document.createElement('tr')
    COLS.forEach(col => {
      const td = document.createElement('td')
      td.textContent = event[col.key]
      tr.appendChild(td)
    })
    tbody.appendChild(tr)
    return tr
  })

  return {
    getEvents: () => events.map(e => ({ ...e })),
    highlightRow(idx) {
      rowEls.forEach((tr, i) => tr.classList.toggle('row-active', i === idx))
    },
    clearHighlights() {
      rowEls.forEach(tr => tr.classList.remove('row-active'))
    },
  }
}
