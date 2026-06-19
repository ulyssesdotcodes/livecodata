// Generic table viewer. Renders whichever stored table is selected, with
// dynamic columns, a table-picker dropdown, and time-based row highlighting
// driven by the playback clock.

const MAX_ROWS = 1000 // cap DOM rows so large frame tables stay responsive

function formatCell(col, value) {
  if (value == null) return ''
  if (col === 'color' && typeof value === 'number') {
    return '0x' + value.toString(16).padStart(6, '0')
  }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? String(value) : value.toFixed(3)
  }
  return String(value)
}

export function initTablePanel(container) {
  container.innerHTML = ''

  let store = new Map()
  let current = null
  let currentRows = []
  let timeCol = null
  let rowEls = []

  const header = document.createElement('div')
  header.className = 'table-pane-header'

  const tabs = document.createElement('div')
  tabs.className = 'table-tabs'
  header.appendChild(tabs)

  const countEl = document.createElement('span')
  countEl.className = 'table-count'
  header.appendChild(countEl)

  container.appendChild(header)

  let tabEls = new Map()

  function highlightTab(name) {
    tabEls.forEach((el, n) => el.classList.toggle('tab-active', n === name))
  }

  const scroll = document.createElement('div')
  scroll.className = 'table-scroll'
  container.appendChild(scroll)

  const table = document.createElement('table')
  table.className = 'events-table'
  scroll.appendChild(table)

  const thead = document.createElement('thead')
  table.appendChild(thead)
  const tbody = document.createElement('tbody')
  table.appendChild(tbody)

  function render(name) {
    current = name
    highlightTab(name)
    const t = store.get(name)
    thead.innerHTML = ''
    tbody.innerHTML = ''
    rowEls = []
    currentRows = []
    timeCol = null

    if (!t || !t.length) {
      countEl.textContent = t ? '0 rows' : ''
      return
    }

    const cols = t.columns
    timeCol = cols.includes('time') ? 'time' : null

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
    // Rebuild the dropdown from the store and render a sensible default.
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
      if (!names.length) {
        render(null)
        return
      }
      // Keep current selection if it still exists; else prefer "events".
      let next = names.includes(current) ? current : null
      if (!next) next = names.includes('events') ? 'events' : names[names.length - 1]
      render(next)
    },

    // Highlight the last row whose `time` <= t (called by playback each frame).
    highlightTime(t) {
      if (!timeCol) return
      let activeIdx = -1
      for (let i = 0; i < currentRows.length; i++) {
        if (currentRows[i][timeCol] <= t) activeIdx = i
        else break
      }
      rowEls.forEach((tr, i) => tr.classList.toggle('row-active', i === activeIdx))
    },
  }
}
