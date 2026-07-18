// Combined table + graph panel — the humble Solid view over ../table-panel.ts:
// one tab per view, a chart when numeric columns exist, and "Table"/"Events"
// sub-tabs for editable tables. All decisions come from the model's pure
// functions; every interaction forwards to the EditableTableStore, and the
// `tick` signal is bumped after each store write so reads re-fold.

import {
  createSignal, createMemo, createEffect, on, onCleanup, untrack,
  For, Index, Show, type Accessor, type Setter,
} from 'solid-js'
import { SERIES_COLORS, computeColRanges, drawSeriesChart, fmtNum, PANEL_CHART_STYLE, type GraphSpec, type ColRange } from '../graph-panel.js'
import {
  MAX_ROWS, COLUMN_TYPES, EVENTS_SUFFIX, formatCell, formatEditableCell,
  allNames, nextTableName, fallbackTab, chartFor, displayOrder, activeRowIndex,
  tabRingStyle, viewersOf, lastEditors, moveFocus,
  type TablePanel, type TablePanelOptions, type PeerPresence, type CellFocus, type FocusDir,
} from '../table-panel.js'
import { listenGlobal, focusInput } from './dom.js'
import { isHydraRow, hydraCodeUpToRow } from '../hydra.js'
import { isBaubleRow, baubleCodeUpToRow } from '../bauble.js'
import { isPostRow, postCodeUpToRow } from '../post.js'
import { Icon } from './icon.js'
import type { Table } from '../dsl.js'
import { DISABLED_COL, cellValid, invalidColumns, type EditableTableStore, type ColumnType, type EditableColumn } from '../editable-tables.js'

export { EVENTS_SUFFIX }
export type { TablePanel, TablePanelOptions, PeerPresence }

// Per-user-colored name list — the visible half of a presence indicator,
// shared by the tab strip and a cell's last-editor badge.
function PresenceNames(nameProps: { peers: PeerPresence[] }) {
  return (
    <For each={nameProps.peers}>
      {(p, i) => (
        <>
          <Show when={i() > 0}>{', '}</Show>
          <span style={{ color: p.color }}>{p.user}</span>
        </>
      )}
    </For>
  )
}

interface PanelProps extends TablePanelOptions {
  store: EditableTableStore
  views: Accessor<Map<string, Table>>
  graphs: Accessor<Map<string, GraphSpec>>
  current: Accessor<string | null>
  setCurrent: Setter<string | null>
  desiredTable: Accessor<string | null>
  setDesiredTable: Setter<string | null>
  playIndex: Accessor<number>
  playActive: Accessor<Map<string, Set<number>> | null>
  userScrolled: Accessor<boolean>
  setUserScrolled: Setter<boolean>
  presence: Accessor<PeerPresence[]>
  // The view hands back a function that returns keyboard focus to the grid, so
  // the controller (and, through it, the editor) can refocus after a code cell.
  registerGridFocus: (fn: () => void) => void
}

function TablePanelView(props: PanelProps) {
  const { store, views, graphs, current, setCurrent, presence } = props

  // Presence: announce every tab switch, including the initial one (not
  // deferred) — main.ts publishes which table this replica has open.
  createEffect(() => props.onSelectTable?.(current()))

  // Bumped after every store write so memos re-read the non-reactive
  // EditableTableStore fold.
  const [tick, setTick] = createSignal(0)
  const bump = () => setTick((t) => t + 1)

  // A Run can change the store underneath the panel (see retainDeclared), but
  // only local edits bump `tick` — so pair every external `views` refresh
  // with a bump or tick-gated store reads would show the pre-Run shape.
  createEffect(on(views, () => bump(), { defer: true }))

  const [filter, setFilter] = createSignal('')
  // At most one cell in edit mode at a time; an outside mousedown cancels it.
  const [editingCell, setEditingCell] = createSignal<string | null>(null)
  // Cell whose editor was just opened by Tab and must survive the async panel
  // refresh that follows a store write (see advanceEdit / guardFocus).
  let focusGuardKey: string | null = null
  const [openColMenu, setOpenColMenu] = createSignal<string | null>(null)
  const [openInfoRow, setOpenInfoRow] = createSignal<string | null>(null)
  const [subView, setSubView] = createSignal<'table' | 'events'>('table')
  const [graphCollapsed, setGraphCollapsed] = createSignal(window.matchMedia('(max-width: 767px)').matches)
  const [colRanges, setColRanges] = createSignal<ColRange[] | null>(null)
  // Keyboard navigation: the arrow-key cursor over editable cells (null until
  // the grid is first driven), and the "/"-opened table picker overlay.
  const [focusedCell, setFocusedCell] = createSignal<CellFocus | null>(null)
  const [pickerOpen, setPickerOpen] = createSignal(false)

  // Hand the controller a way to pull keyboard focus back onto the grid — used
  // after committing an inline edit and when a code cell's editor is escaped.
  const refocusGrid = (): void => { scrollEl?.focus() }
  props.registerGridFocus(refocusGrid)

  listenGlobal(document, 'mousedown', (e) => {
    const target = e.target as HTMLElement | null
    if (editingCell() != null && !target?.closest?.('.editable-cell.editing')) setEditingCell(null)
    if (openColMenu() != null && !target?.closest?.('.col-settings-wrap')) setOpenColMenu(null)
    if (openInfoRow() != null && !target?.closest?.('.row-info-wrap')) setOpenInfoRow(null)
    if (pickerOpen() && !target?.closest?.('.table-picker')) setPickerOpen(false)
  })

  const names = createMemo(() => {
    tick()
    return allNames(views(), store)
  })

  // A pending restore (desiredTable) wins the moment its table appears among
  // the tabs — cooked-view tabs only exist after the cook — and is cleared
  // once honored so it never fights a later manual tab switch.
  createEffect(() => {
    const ns = names()
    const want = props.desiredTable()
    if (want != null && ns.includes(want)) {
      props.setDesiredTable(null)
      setCurrent(want)
      return
    }
    setCurrent((cur) => fallbackTab(ns, cur))
  })

  // Switching tabs resets transient edit state and drops back to the "table"
  // sub-tab.
  createEffect(on(current, () => {
    setEditingCell(null)
    setOpenColMenu(null)
    setOpenInfoRow(null)
    setSubView('table')
    setFocusedCell(null)
    setPickerOpen(false)
  }, { defer: true }))

  // A genuine editable table, as opposed to a cooked view or a log table.
  const isEditableTable = createMemo(() => {
    tick()
    const name = current()
    return !!name && store.has(name) && !store.isLog(name)
  })

  const editableData = createMemo(() => {
    tick(); views()
    const name = current()
    if (!name || !isEditableTable() || subView() === 'events') return null
    const data = store.get(name)
    return data ? { name, data } : null
  })

  // Keep a just-opened editor focused across the async panel refresh a store
  // write triggers (the refresh blurs the editor, whose blur handler would
  // close it): commit's viaBlur guard ignores the spurious blur, and this
  // restores focus once the refresh settles.
  function guardFocus(key: string): void {
    focusGuardKey = key
    const restore = (): void => {
      if (editingCell() !== key) return
      const el = scrollEl?.querySelector<HTMLInputElement>('.editable-cell.editing input, .editable-cell.editing select')
      if (el && document.activeElement !== el) el.focus()
    }
    requestAnimationFrame(() => {
      restore()
      requestAnimationFrame(() => {
        restore()
        if (focusGuardKey === key) focusGuardKey = null
      })
    })
  }

  // Tab/Shift+Tab out of a cell editor (the caller commits first): move to
  // the adjacent column, wrapping to the next/previous display row. Code
  // cells open in the main editor; every other type edits inline.
  function advanceEdit(rowIndex: number, colName: string, dir: 1 | -1): void {
    const ed = editableData()
    if (!ed) return
    const { name: table, data } = ed
    const cols = data.columns
    const cIdx = cols.findIndex((c) => c.name === colName)
    if (cIdx < 0) return
    let nextRow = rowIndex
    let nextIdx = cIdx + dir
    if (nextIdx < 0 || nextIdx >= cols.length) {
      const order = displayOrder(data.rows, cols)
      const pos = order.indexOf(rowIndex)
      const nextPos = pos + dir
      if (pos < 0 || nextPos < 0 || nextPos >= order.length) return
      nextRow = order[nextPos]
      nextIdx = dir > 0 ? 0 : cols.length - 1
    }
    const target = cols[nextIdx]
    if (target.type === 'code') {
      const v = data.rows[nextRow]?.[target.name]
      props.onEditCell?.(table, nextRow, target.name, v == null ? '' : String(v))
      return
    }
    const nextKey = `${nextRow}::${target.name}`
    setEditingCell(nextKey)
    guardFocus(nextKey)
  }

  // --- keyboard navigation -----------------------------------------------------

  const cellEl = (row: number, col: string): HTMLElement | null =>
    scrollEl?.querySelector<HTMLElement>(`.editable-cell[data-row="${row}"][data-col="${CSS.escape(col)}"]`) ?? null

  const scrollCellIntoView = (fc: CellFocus): void => {
    requestAnimationFrame(() => cellEl(fc.row, fc.col)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }))
  }

  // Enter on the focused cell: code cells open in the main editor, enums focus
  // their live dropdown, everything else opens its inline editor.
  function beginEditFocused(): void {
    const fc = focusedCell()
    const ed = editableData()
    if (!fc || !ed) return
    const col = ed.data.columns.find((c) => c.name === fc.col)
    if (!col) return
    if (col.type === 'code') {
      const v = ed.data.rows[fc.row]?.[col.name]
      props.onEditCell?.(ed.name, fc.row, col.name, v == null ? '' : String(v))
      return
    }
    if (col.type === 'enum') {
      cellEl(fc.row, col.name)?.querySelector('select')?.focus()
      return
    }
    setEditingCell(`${fc.row}::${col.name}`)
  }

  function onGridKeyDown(e: KeyboardEvent): void {
    if (pickerOpen() || editingCell() != null) return
    // A cell's own editor (or the enum dropdown) owns the keys while focused.
    const t = e.target as HTMLElement | null
    if (t && t !== scrollEl && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName)) return
    // "/" opens the table switcher from any table, editable or not.
    if (e.key === '/' && current()) { e.preventDefault(); setPickerOpen(true); return }
    // Cell navigation is an editable-table feature; read-only views just scroll.
    if (!isEditableTable()) return
    const ed = editableData()
    if (!ed) return
    const cols = ed.data.columns
    const order = displayOrder(ed.data.rows, cols).filter(edRowVisible)
    if (!cols.length || !order.length) return
    const fc = focusedCell()
    // No cursor yet, or it points at a now-hidden/removed cell: land on the
    // first visible cell.
    if (!fc || order.indexOf(fc.row) < 0 || !cols.some((c) => c.name === fc.col)) {
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(e.key)) return
      e.preventDefault()
      const first = { row: order[0], col: cols[0].name }
      setFocusedCell(first)
      scrollCellIntoView(first)
      return
    }
    if (e.key === 'Enter') { e.preventDefault(); beginEditFocused(); return }
    const dir = ({ ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' } as const)[e.key] as FocusDir | undefined
    if (!dir) return
    e.preventDefault()
    const next = moveFocus(order, cols, fc, dir)
    if (next) { setFocusedCell(next); scrollCellIntoView(next) }
  }

  const roTable = createMemo(() => {
    const name = current()
    if (!name || editableData()) return null
    // The "events" sub-tab reads the injected `name·events` view; everything
    // else is keyed by its own name.
    const key = isEditableTable() ? name + EVENTS_SUFFIX : name
    return views().get(key) ?? null
  })
  const roCols = createMemo(() => roTable()?.columns ?? [])
  const shownRows = createMemo(() => {
    const t = roTable()
    return t ? t.rows.slice(0, MAX_ROWS) : []
  })
  const indexCol = createMemo(() => (roCols().includes('beat') ? 'beat' : null))
  const activeIdx = createMemo(() => {
    const col = indexCol()
    return col ? activeRowIndex(shownRows(), col, props.playIndex()) : -1
  })
  const lineageSet = () => props.playActive()?.get(current() ?? '')

  const chart = createMemo(() => (
    editableData() || (isEditableTable() && subView() === 'events') ? null : chartFor(current(), views(), graphs(), store)
  ))

  const roRowText = (i: number) =>
    roCols().map((c) => formatCell(c, shownRows()[i]?.[c])).join(' ').toLowerCase()
  const edRowText = (i: number) => {
    const d = editableData()?.data
    if (!d) return ''
    return d.columns.map((c) => formatEditableCell(c.type, d.rows[i]?.[c.name])).join(' ').toLowerCase()
  }
  const roRowVisible = (i: number) => !filter() || roRowText(i).includes(filter())
  const edRowVisible = (i: number) => !filter() || edRowText(i).includes(filter())

  const countText = createMemo(() => {
    const q = filter()
    const ed = editableData()
    if (ed) {
      const total = ed.data.rows.length
      if (q && total) {
        const visible = ed.data.rows.filter((_r, i) => edRowVisible(i)).length
        return `${visible} / ${total} row${total === 1 ? '' : 's'}`
      }
      return `${total} row${total === 1 ? '' : 's'}`
    }
    const t = roTable()
    if (!current() || !t) return ''
    if (!t.length) return '0 rows'
    const shown = shownRows()
    if (q && shown.length) {
      const visible = shown.filter((_r, i) => roRowVisible(i)).length
      return `${visible} / ${shown.length} row${shown.length === 1 ? '' : 's'}`
    }
    return t.length > MAX_ROWS
      ? `${t.length} rows (showing ${MAX_ROWS})`
      : `${shown.length} row${shown.length === 1 ? '' : 's'}`
  })

  // --- scroll/autoscroll -----------------------------------------------------
  let scrollEl: HTMLDivElement | undefined
  let suppressScrollEvent = false
  const roRowEls: HTMLTableRowElement[] = []

  createEffect(on(current, () => {
    props.setUserScrolled(false)
    if (scrollEl) {
      suppressScrollEvent = true
      scrollEl.scrollTop = 0
      requestAnimationFrame(() => { suppressScrollEvent = false })
    }
  }, { defer: true }))

  createEffect(() => {
    const ai = activeIdx()
    if (props.userScrolled() || ai < 0) return
    const el = roRowEls[ai]
    if (!el) return
    suppressScrollEvent = true
    el.scrollIntoView({ block: 'nearest' })
    requestAnimationFrame(() => { suppressScrollEvent = false })
  })

  // --- chart -------------------------------------------------------------------
  let graphCanvas: HTMLCanvasElement | undefined

  function drawCurrentChart(): void {
    const c = untrack(chart)
    if (!c || !graphCanvas) return
    const ranges = computeColRanges(c.rows, c.cols, PANEL_CHART_STYLE.yPadFrac)
    drawSeriesChart(graphCanvas, c, ranges, {
      playIndex: untrack(props.playIndex),
      activeRows: untrack(props.playActive)?.get(c.name) ?? null,
    })
    setColRanges(ranges)
  }

  const ro = new ResizeObserver(() => drawCurrentChart())
  onCleanup(() => ro.disconnect())

  // Redraw on data/playhead changes; (re)observe the canvas only when the
  // chart appears or disappears, not per frame.
  createEffect(() => {
    ro.disconnect()
    if (!chart()) {
      setColRanges(null)
      return
    }
    if (graphCanvas) ro.observe(graphCanvas)
  })
  createEffect(() => {
    props.playIndex()
    props.playActive()
    if (chart()) drawCurrentChart()
  })

  // --- editable sub-views ------------------------------------------------------

  function ColHeader(colProps: { table: string; col: EditableColumn }) {
    const { table, col } = colProps
    const [renaming, setRenaming] = createSignal(false)
    const [menuPos, setMenuPos] = createSignal<{ top: number; left: number } | null>(null)
    const menuKey = `${table}::${col.name}`
    const menuOpen = () => openColMenu() === menuKey
    let settingsBtn: HTMLButtonElement | undefined
    let menuEl: HTMLDivElement | undefined

    const commitRename = (value: string): void => {
      const v = value.trim()
      if (v && v !== col.name) store.renameColumn(table, col.name, v)
      setRenaming(false)
      bump()
    }

    // Measured after opening so a menu near the viewport's right edge clamps
    // against its real width instead of overflowing.
    createEffect(() => {
      if (!menuOpen() || !settingsBtn || !menuEl) return
      const r = settingsBtn.getBoundingClientRect()
      const left = Math.max(4, Math.min(r.left, window.innerWidth - menuEl.offsetWidth - 4))
      setMenuPos({ top: r.bottom + 4, left })
    })

    return (
      <th class="editable-col-head">
        <div class="col-head-row">
          <Show
            when={renaming()}
            fallback={
              <span class="col-name-label" title="Click to rename" onClick={() => setRenaming(true)}>
                {col.name}
              </span>
            }
          >
            <input
              class="col-name-input"
              value={col.name}
              ref={(el) => focusInput(el)}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
              onBlur={(e) => commitRename(e.currentTarget.value)}
              onClick={(e) => e.stopPropagation()}
            />
          </Show>
          <div class="settings-wrap col-settings-wrap">
            <button
              class="settings-btn col-settings-btn"
              title="Column settings"
              aria-label="Column settings"
              ref={settingsBtn}
              onClick={(e) => {
                e.stopPropagation()
                setOpenColMenu(menuOpen() ? null : menuKey)
              }}
            >
              ⋯
            </button>
            <div
              class="settings-menu"
              classList={{ open: menuOpen() }}
              ref={menuEl}
              style={menuPos() ? { top: `${menuPos()!.top}px`, left: `${menuPos()!.left}px` } : undefined}
            >
              <label class="settings-row">
                Type
                <select
                  class="col-type-select"
                  onChange={(e) => {
                    store.setColumnType(table, col.name, e.currentTarget.value as ColumnType)
                    bump()
                  }}
                >
                  <For each={COLUMN_TYPES}>
                    {(t) => <option value={t} selected={t === col.type}>{t}</option>}
                  </For>
                  {/* Enum is code-only, not in COLUMN_TYPES — surface it so
                      the menu isn't mislabeled. */}
                  <Show when={col.type === 'enum'}>
                    <option value="enum" selected disabled>enum</option>
                  </Show>
                </select>
              </label>
              <button
                class="settings-row col-del-btn"
                onClick={() => { store.removeColumn(table, col.name); bump() }}
              >
                Remove column
              </button>
            </div>
          </div>
        </div>
      </th>
    )
  }

  function AddColHeader(colProps: { table: string }) {
    const [adding, setAdding] = createSignal(false)
    let nameInput: HTMLInputElement | undefined
    let typeSel: HTMLSelectElement | undefined
    const commit = (): void => {
      const colName = nameInput?.value.trim()
      if (colName) store.addColumn(colProps.table, colName, (typeSel?.value ?? 'number') as ColumnType)
      setAdding(false)
      bump()
    }
    return (
      <th class="add-col-head">
        <Show
          when={adding()}
          fallback={<button class="add-col-btn" onClick={() => setAdding(true)}>+ column</button>}
        >
          <input
            class="col-name-input new-col-name"
            placeholder="name"
            ref={(el) => { nameInput = el; focusInput(el, false) }}
            onKeyDown={(e) => { if (e.key === 'Enter') commit() }}
          />
          <select class="col-type-select" ref={typeSel}>
            <For each={COLUMN_TYPES}>{(t) => <option value={t}>{t}</option>}</For>
          </select>
          <button class="col-confirm-btn" onClick={commit}>Add</button>
        </Show>
      </th>
    )
  }

  // One editable cell: click opens a typed editor in place; enums instead
  // show an always-live dropdown so a value is one pick away mid-performance.
  // Committing appends a set-cell event to the store — the edit *is* the
  // event. Values that don't fit the column type get a `cell-invalid` marker.
  function EditableCell(cellProps: { table: string; rowIndex: number; col: EditableColumn }) {
    const { table, rowIndex, col } = cellProps
    const key = `${rowIndex}::${col.name}`
    const editing = () => editingCell() === key
    const raw = () => editableData()?.data.rows[rowIndex]?.[col.name]
    const invalid = () => !cellValid(raw(), col)

    const commit = (value: unknown, viaBlur = false): void => {
      // Guard the Enter-then-blur double fire: only the open editor commits.
      if (editingCell() !== key) return
      // A blur while the focus guard is live is the async panel refresh, not
      // the user — leave the editor open (guardFocus restores focus).
      if (viaBlur && key === focusGuardKey) return
      store.setCell(table, rowIndex, col.name, value)
      setEditingCell(null)
      bump()
    }

    const keyHandler = (e: KeyboardEvent, commitNow: () => void): void => {
      // preventDefault so the browser doesn't also shift focus and fight our
      // editor placement.
      if (e.key === 'Tab') {
        e.preventDefault()
        commitNow()
        advanceEdit(rowIndex, col.name, e.shiftKey ? -1 : 1)
        return
      }
      // Escape cancels the edit (the pending blur-commit no-ops once the editor
      // is closed) and returns to arrow-key navigation.
      if (e.key === 'Escape') {
        e.preventDefault()
        setEditingCell(null)
        queueMicrotask(refocusGrid)
        return
      }
      if (e.key === 'Enter') { commitNow(); queueMicrotask(refocusGrid) }
      if (e.key === 'Enter' && e.ctrlKey && props.onCtrlEnter) props.onCtrlEnter()
    }

    // Collaborators whose last edit landed on this cell.
    const editors = () => lastEditors(presence(), table, rowIndex, col.name)

    const focused = () => focusedCell()?.row === rowIndex && focusedCell()?.col === col.name

    return (
      <td
        class="editable-cell"
        classList={{ editing: editing(), 'cell-invalid': invalid(), 'cell-focused': focused() }}
        data-row={rowIndex}
        data-col={col.name}
        style={editors().length ? { outline: `2px solid ${editors()[0].color}`, 'outline-offset': '-2px' } : undefined}
        onClick={() => {
          setFocusedCell({ row: rowIndex, col: col.name })
          if (editing() || col.type === 'enum') return
          if (col.type === 'code') {
            const v = raw()
            props.onEditCell?.(table, rowIndex, col.name, v == null ? '' : String(v))
          } else {
            setEditingCell(key)
          }
        }}
      >
        <Show when={editors().length}>
          <span class="cell-presence"><PresenceNames peers={editors()} /></span>
        </Show>
        <Show when={col.type === 'enum'}>
          <select
            class="cell-enum"
            value={raw() == null ? '' : String(raw())}
            onChange={(e) => { store.setCell(table, rowIndex, col.name, e.currentTarget.value); bump() }}
          >
            {/* A stray value not in the options still shows, flagged, until a
                valid pick. */}
            <Show when={invalid() && raw() != null && raw() !== ''}>
              <option value={String(raw())} selected>{String(raw())}</option>
            </Show>
            <option value="" />
            <For each={col.options ?? []}>
              {(o) => <option value={o} selected={o === raw()}>{o}</option>}
            </For>
          </select>
        </Show>
        <Show
          when={col.type !== 'enum' && editing()}
          fallback={
            <Show when={col.type !== 'enum'}>
              <span class={col.type === 'code' ? 'cell-value cell-code' : 'cell-value'}>
                {formatEditableCell(col.type, raw())}
              </span>
            </Show>
          }
        >
          <Show when={col.type === 'boolean'}>
            <input
              type="checkbox"
              checked={!!raw()}
              ref={(el) => queueMicrotask(() => el.focus())}
              onChange={(e) => commit(e.currentTarget.checked)}
              onKeyDown={(e) => {
                // A checkbox commits on toggle — Tab advances, Enter/Escape
                // just close back to arrow-key navigation.
                if (e.key === 'Tab') {
                  e.preventDefault()
                  setEditingCell(null)
                  advanceEdit(rowIndex, col.name, e.shiftKey ? -1 : 1)
                } else if (e.key === 'Enter' || e.key === 'Escape') {
                  e.preventDefault()
                  setEditingCell(null)
                  queueMicrotask(refocusGrid)
                }
              }}
            />
          </Show>
          <Show when={col.type === 'number'}>
            {(() => {
              const cur = Number(raw()) || 0
              let num: HTMLInputElement | undefined
              const commitNum = (viaBlur = false): void => {
                if (!num) return
                const v = Number(num.value)
                commit(Number.isFinite(v) && num.value.trim() !== '' ? v : cur, viaBlur)
              }
              return (
                <input
                  type="number"
                  class="cell-number"
                  value={String(cur)}
                  step="any"
                  ref={(el) => { num = el; focusInput(el) }}
                  onKeyDown={(e) => keyHandler(e, commitNum)}
                  onBlur={() => commitNum(true)}
                />
              )
            })()}
          </Show>
          <Show when={col.type === 'string' || col.type === 'code'}>
            {(() => {
              let txt: HTMLInputElement | undefined
              // Commit directly rather than via blur(): a synchronous blur()
              // unmounts this input mid-flight, stranding focus before the
              // next cell can take it.
              const commitTxt = (viaBlur = false): void => { if (txt) commit(txt.value, viaBlur) }
              return (
                <input
                  type="text"
                  class="cell-text"
                  value={raw() == null ? '' : String(raw())}
                  ref={(el) => { txt = el; focusInput(el) }}
                  onKeyDown={(e) => keyHandler(e, commitTxt)}
                  onBlur={() => commitTxt(true)}
                />
              )
            })()}
          </Show>
        </Show>
      </td>
    )
  }

  // Per-row info button (hydra/bauble rows only): a popover showing the
  // sketch compiled up to and including this event — the table's name picks
  // which fold. Mirrors ColHeader's measured fixed-position popover.
  function RowInfo(rowProps: { table: string; rowIndex: number }) {
    const { table, rowIndex } = rowProps
    const infoKey = `${table}::${rowIndex}`
    const open = () => openInfoRow() === infoKey
    const [menuPos, setMenuPos] = createSignal<{ top: number; left: number } | null>(null)
    let infoBtn: HTMLButtonElement | undefined
    let popEl: HTMLDivElement | undefined

    // Recompute only while open; tick-gated so an edit to any earlier row
    // updates the shown code live.
    const code = createMemo(() => {
      tick(); views()
      if (!open()) return null
      const data = store.get(table)
      if (!data) return null
      return table === 'bauble' ? baubleCodeUpToRow(data.rows, rowIndex)
        : table === 'post' ? postCodeUpToRow(data.rows, rowIndex)
        : hydraCodeUpToRow(data.rows, rowIndex)
    })

    createEffect(() => {
      if (!open() || !infoBtn || !popEl) return
      // Depend on the code so remeasuring happens once it has content (height).
      code()
      const r = infoBtn.getBoundingClientRect()
      const left = Math.max(4, Math.min(r.left, window.innerWidth - popEl.offsetWidth - 4))
      // Flip above the button when it would overflow the viewport bottom.
      const h = popEl.offsetHeight
      const below = r.bottom + 4
      const top = below + h > window.innerHeight - 4 && r.top - h - 4 >= 4 ? r.top - h - 4 : below
      setMenuPos({ top, left })
    })

    return (
      <div class="settings-wrap row-info-wrap">
        <button
          class="row-info-btn"
          title="Compiled code at this event"
          aria-label="Compiled code at this event"
          ref={infoBtn}
          onClick={(e) => { e.stopPropagation(); setOpenInfoRow(open() ? null : infoKey) }}
        >
          ⓘ
        </button>
        <div
          class="settings-menu row-info-popover"
          classList={{ open: open() }}
          ref={popEl}
          style={menuPos() ? { top: `${menuPos()!.top}px`, left: `${menuPos()!.left}px` } : undefined}
        >
          <div class="row-info-title">Compiled code at this event</div>
          <Show
            when={code() != null}
            fallback={<div class="row-info-empty">No compiled sketch at this event yet.</div>}
          >
            <pre class="row-info-code">{code()}</pre>
          </Show>
        </div>
      </div>
    )
  }

  function Tab(tabProps: { name: string }) {
    const { name } = tabProps
    const [renaming, setRenaming] = createSignal(false)
    const editable = () => {
      tick()
      return store.has(name) && !store.isLog(name)
    }
    const commitRename = (value: string): void => {
      const v = value.trim()
      if (v && v !== name && store.renameTable(name, v) && untrack(current) === name) setCurrent(v)
      setRenaming(false)
      bump()
    }
    const viewers = () => viewersOf(presence(), name)
    const ringStyle = () => tabRingStyle(presence(), name)

    return (
      <button
        class="table-tab"
        classList={{ 'table-tab-editable': editable(), 'tab-active': current() === name }}
        style={ringStyle() ? { 'box-shadow': ringStyle() } : undefined}
        title={editable() ? 'Double-click to rename' : undefined}
        onClick={() => setCurrent(name)}
        onDblClick={(e) => {
          if (!editable()) return
          e.stopPropagation()
          setRenaming(true)
        }}
      >
        <Show
          when={renaming()}
          fallback={
            <>
              <span class="tab-label">{name}</span>
              <Show when={viewers().length}>
                <span class="tab-presence"><PresenceNames peers={viewers()} /></span>
              </Show>
              <Show when={editable()}>
                <span
                  class="tab-del"
                  title="Delete table"
                  onClick={(e) => {
                    e.stopPropagation()
                    store.removeTable(name)
                    if (untrack(current) === name) setCurrent(null)
                    bump()
                  }}
                >
                  ×
                </span>
              </Show>
            </>
          }
        >
          <input
            class="tab-rename-input"
            value={name}
            ref={(el) => focusInput(el)}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
            onBlur={(e) => commitRename(e.currentTarget.value)}
            onClick={(e) => e.stopPropagation()}
          />
        </Show>
      </button>
    )
  }

  // The "/"-opened table switcher: a filterable list of every tab, driven by
  // the keyboard (type to filter, ↑/↓ to move, Enter to pick, Escape to close).
  function TablePicker() {
    const [query, setQuery] = createSignal('')
    const [sel, setSel] = createSignal(0)
    const matches = createMemo(() => {
      const q = query().toLowerCase()
      return names().filter((n) => !q || n.toLowerCase().includes(q))
    })
    const close = (): void => { setPickerOpen(false); queueMicrotask(refocusGrid) }
    const choose = (name: string | undefined): void => {
      if (name) setCurrent(name)
      close()
    }
    return (
      <div
        class="table-picker"
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); close() }
          else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, matches().length - 1)) }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)) }
          else if (e.key === 'Enter') { e.preventDefault(); choose(matches()[sel()]) }
        }}
      >
        <input
          class="table-picker-input"
          placeholder="Switch table…"
          ref={(el) => focusInput(el, false)}
          onInput={(e) => { setQuery(e.currentTarget.value); setSel(0) }}
        />
        <div class="table-picker-list">
          <For each={matches()}>
            {(n, i) => (
              <button
                class="table-picker-item"
                classList={{ 'picker-sel': i() === sel(), 'picker-current': n === current() }}
                onMouseEnter={() => setSel(i())}
                onClick={() => choose(n)}
              >
                {n}
              </button>
            )}
          </For>
          <Show when={!matches().length}>
            <div class="table-picker-empty">No tables</div>
          </Show>
        </div>
      </div>
    )
  }

  return (
    <>
      <div class="table-pane-header">
        <div class="table-pane-header-row table-pane-header-titles">
          <div class="table-tabs">
            <For each={names()}>{(n) => <Tab name={n} />}</For>
          </div>
          {/* Mobile substitute for the tab strip — a native <select> is far
              easier to use with a thumb. */}
          <select class="table-tab-select" onChange={(e) => setCurrent(e.currentTarget.value)}>
            <For each={names()}>
              {(n) => <option value={n} selected={n === current()}>{n}</option>}
            </For>
          </select>
        </div>
        <div class="table-pane-header-row table-pane-header-controls">
          <button
            class="table-tab-add"
            title="Add a new editable table"
            aria-label="Add a new editable table"
            onClick={() => {
              const name = nextTableName(untrack(views), store)
              store.createTable(name)
              setCurrent(name)
              bump()
            }}
          >
            <Icon name="plus" />
          </button>
          <input
            class="table-filter"
            type="text"
            placeholder="filter…"
            onInput={(e) => setFilter(e.currentTarget.value.toLowerCase())}
          />
          <span class="table-count">{countText()}</span>
        </div>
      </div>
      <div class="tab-content">
        <Show when={pickerOpen()}>
          <TablePicker />
        </Show>
        <Show when={isEditableTable()}>
          <div class="table-subtabs">
            <button
              class="table-subtab"
              classList={{ 'subtab-active': subView() === 'table' }}
              onClick={() => setSubView('table')}
            >
              Table
            </button>
            <button
              class="table-subtab"
              classList={{ 'subtab-active': subView() === 'events' }}
              onClick={() => setSubView('events')}
            >
              Events
            </button>
          </div>
        </Show>
        <Show when={chart()}>
          <div class="tab-graph" classList={{ 'graph-collapsed': graphCollapsed() }}>
            <div class="graph-header">
              <button
                class="collapse-btn"
                title={graphCollapsed() ? 'Expand graph' : 'Collapse graph'}
                aria-label={graphCollapsed() ? 'Expand graph' : 'Collapse graph'}
                onClick={() => setGraphCollapsed(!graphCollapsed())}
              >
                <Icon name={graphCollapsed() ? 'chevron-down' : 'chevron-up'} />
              </button>
              <span class="graph-title">Graph</span>
            </div>
            <div class="graph-legend">
              <For each={chart()!.cols}>
                {(c, ci) => (
                  <span class="graph-series">
                    <span class="graph-dot" style={{ background: SERIES_COLORS[ci() % SERIES_COLORS.length] }} />
                    {c}
                    <Show when={colRanges()?.[ci()]}>
                      {(range) => (
                        <span class="graph-range">{`${fmtNum(range().rawMin)}–${fmtNum(range().rawMax)}`}</span>
                      )}
                    </Show>
                  </span>
                )}
              </For>
            </div>
            <canvas class="tab-graph-canvas" ref={graphCanvas} />
          </div>
        </Show>
        <div
          class="tab-scroll"
          ref={scrollEl}
          tabindex={current() ? 0 : undefined}
          onKeyDown={onGridKeyDown}
          onScroll={() => { if (!suppressScrollEvent) props.setUserScrolled(true) }}
        >
          <table class="events-table">
            <Show
              when={editableData()}
              fallback={
                <>
                  <thead>
                    <Show when={roTable()?.length}>
                      <tr>
                        <For each={roCols()}>{(col) => <th>{col}</th>}</For>
                      </tr>
                    </Show>
                  </thead>
                  <tbody>
                    <Index each={shownRows()}>
                      {(row, i) => (
                        <tr
                          ref={(el) => { roRowEls[i] = el }}
                          hidden={!roRowVisible(i)}
                          classList={{
                            'row-active': i === activeIdx(),
                            'row-source': !!lineageSet()?.has(i),
                          }}
                        >
                          <For each={roCols()}>{(col) => <td>{formatCell(col, row()[col])}</td>}</For>
                        </tr>
                      )}
                    </Index>
                  </tbody>
                </>
              }
            >
              {(ed) => (
                <>
                  <thead>
                    <tr>
                      <th class="row-actions-head" />
                      <For each={ed().data.columns}>
                        {(col) => <ColHeader table={ed().name} col={col} />}
                      </For>
                      <AddColHeader table={ed().name} />
                    </tr>
                  </thead>
                  <tbody>
                    <For each={displayOrder(ed().data.rows, ed().data.columns)}>
                      {(i) => (
                        <tr
                          hidden={!edRowVisible(i)}
                          classList={{
                            'row-source': !!lineageSet()?.has(i),
                            // A boolean column named "disabled" is the row's
                            // own mute switch (see DISABLED_COL).
                            'row-disabled': ed().data.rows[i]?.[DISABLED_COL] === true,
                            'row-invalid': invalidColumns(ed().data.rows[i], ed().data.columns).length > 0,
                          }}
                        >
                          <td class="row-actions">
                            <Show when={ed().name === 'bauble' ? isBaubleRow(ed().data.rows[i]) : ed().name === 'post' ? isPostRow(ed().data.rows[i]) : isHydraRow(ed().data.rows[i])}>
                              <RowInfo table={ed().name} rowIndex={i} />
                            </Show>
                            <button
                              class="row-dup-btn"
                              title="Duplicate row"
                              aria-label="Duplicate row"
                              onClick={() => { store.duplicateRow(ed().name, i); bump() }}
                            >
                              ⧉
                            </button>
                            <button
                              class="row-del-btn"
                              title="Delete row"
                              aria-label="Delete row"
                              onClick={() => { store.removeRow(ed().name, i); bump() }}
                            >
                              ×
                            </button>
                          </td>
                          <For each={ed().data.columns}>
                            {(col) => <EditableCell table={ed().name} rowIndex={i} col={col} />}
                          </For>
                          <td />
                        </tr>
                      )}
                    </For>
                  </tbody>
                </>
              )}
            </Show>
          </table>
        </div>
        <Show when={editableData()}>
          <div class="edit-toolbar" style={{ display: 'flex' }}>
            <button
              class="add-row-btn"
              onClick={() => { store.addRow(editableData()!.name); bump() }}
            >
              + row
            </button>
          </div>
        </Show>
      </div>
    </>
  )
}

// The pure-logic side handed to app.tsx — no DOM here; the view above is the
// only thing that touches elements.
export interface TablePanelController extends TablePanel, PanelProps {
  // Return keyboard focus to the table grid (see registerGridFocus).
  focusGrid(): void
}

export function createTablePanel(
  editableStore: EditableTableStore,
  { onEditCell, onCtrlEnter, onSelectTable }: TablePanelOptions = {},
): TablePanelController {
  const [views, setViews] = createSignal<Map<string, Table>>(new Map())
  const [graphs, setGraphs] = createSignal<Map<string, GraphSpec>>(new Map())
  const [current, setCurrent] = createSignal<string | null>(null)
  const [desiredTable, setDesiredTable] = createSignal<string | null>(null)
  const [playIndex, setPlayIndex] = createSignal(0)
  const [playActive, setPlayActive] = createSignal<Map<string, Set<number>> | null>(null)
  const [userScrolled, setUserScrolled] = createSignal(false)
  const [presence, setPresence] = createSignal<PeerPresence[]>([])
  // Set by the view once mounted; lets focusGrid pull focus back to the grid.
  let gridFocus: (() => void) | null = null

  return {
    store: editableStore,
    views,
    graphs,
    current,
    setCurrent,
    desiredTable,
    setDesiredTable,
    playIndex,
    playActive,
    userScrolled,
    setUserScrolled,
    presence,
    onEditCell,
    onCtrlEnter,
    onSelectTable,
    registerGridFocus(fn: () => void): void {
      gridFocus = fn
    },
    focusGrid(): void {
      gridFocus?.()
    },

    selectTable(name: string | null): void {
      if (name != null && (views().has(name) || editableStore.has(name)) && name !== current()) {
        setCurrent(name)
      }
    },
    restoreTable(name: string | null): void {
      setDesiredTable(name)
    },
    setTables(newStore: Map<string, Table>): void {
      setViews(newStore)
    },
    setGraphs(newSpecs: GraphSpec[] | null): void {
      const byName = new Map<string, GraphSpec>()
      for (const spec of newSpecs ?? []) {
        const name = spec.viewName ?? spec.table?.name
        if (name) byName.set(name, spec)
      }
      setGraphs(byName)
    },
    highlightIndex(idx: number): void {
      setPlayIndex(idx)
    },
    highlightLineage(active: Map<string, Set<number>> | null): void {
      setPlayActive(active)
    },
    resetAutoscroll(): void {
      setUserScrolled(false)
    },
    setPresence(peers: PeerPresence[]): void {
      setPresence(peers)
    },
  }
}

export function TablePane(props: { ctl: TablePanelController; ref?: (el: HTMLDivElement) => void }) {
  return (
    <div id="table-pane" ref={props.ref}>
      <TablePanelView {...props.ctl} />
    </div>
  )
}
