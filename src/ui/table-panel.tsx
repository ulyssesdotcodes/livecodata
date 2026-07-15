// Combined table + graph panel — the humble SolidJS view over the model in
// ../table-panel.ts. Each tab shows one view; if the view has numeric columns
// a chart appears at the top (auto-detected or from .graph()). Editable
// tables additionally show two sub-tabs below the main tab strip — "Table"
// (the interactive fold, shown by default) and "Events" (its read-only
// `name·events` edit history) — so switching between them doesn't require
// hunting for a separate top-level tab. The table autoscrolls to the active
// row during playback unless the user has manually scrolled since the last
// time Play was pressed.
//
// All decisions (which tabs exist, which chart to draw, display order, which
// row is active) come from the model's pure functions; every interaction is
// forwarded straight to the EditableTableStore. The `tick` signal is bumped
// after each store write so reads re-fold — the reactive equivalent of the
// old imperative re-render after every edit.

import {
  createSignal, createMemo, createEffect, on, onCleanup, untrack,
  For, Index, Show, type Accessor, type Setter,
} from 'solid-js'
import { SERIES_COLORS, computeColRanges, drawSeriesChart, fmtNum, PANEL_CHART_STYLE, type GraphSpec, type ColRange } from '../graph-panel.js'
import {
  MAX_ROWS, COLUMN_TYPES, EVENTS_SUFFIX, formatCell, formatEditableCell,
  allNames, nextTableName, fallbackTab, chartFor, displayOrder, activeRowIndex,
  tabRingStyle, viewersOf, lastEditors,
  type TablePanel, type TablePanelOptions, type PeerPresence,
} from '../table-panel.js'
import { listenGlobal, focusInput } from './dom.js'
import { Icon } from './icon.js'
import type { Table } from '../dsl.js'
import { DISABLED_COL, cellValid, invalidColumns, type EditableTableStore, type ColumnType, type EditableColumn } from '../editable-tables.js'

export { EVENTS_SUFFIX }
export type { TablePanel, TablePanelOptions, PeerPresence }

// A comma-separated, per-user-colored name list — the visible half of a
// presence indicator (the tab ring / cell outline is the color-only half).
// Shared between the tab strip (who has this table open) and a cell's
// last-editor marker (who last touched it).
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
  playIndex: Accessor<number>
  playActive: Accessor<Map<string, Set<number>> | null>
  userScrolled: Accessor<boolean>
  setUserScrolled: Setter<boolean>
  presence: Accessor<PeerPresence[]>
}

function TablePanelView(props: PanelProps) {
  const { store, views, graphs, current, setCurrent, presence } = props

  // Multiplayer presence: announce every tab switch, including the initial
  // one (not deferred) — main.ts uses this to publish which table this
  // replica has open.
  createEffect(() => props.onSelectTable?.(current()))

  // Bumped after every store write so memos re-read the (external,
  // non-reactive) EditableTableStore fold.
  const [tick, setTick] = createSignal(0)
  const bump = () => setTick((t) => t + 1)

  // A Run refreshes `views` from outside the panel and can change the store
  // underneath it — turning an editable table into a computed view of the same
  // name, or dropping one the program stopped declaring (see retainDeclared).
  // Only local edits bump `tick`, so pair every external `views` refresh with a
  // bump, or the tick-gated store reads (isEditableTable, a tab's editable/×)
  // would keep showing the pre-Run shape.
  createEffect(on(views, () => bump(), { defer: true }))

  const [filter, setFilter] = createSignal('')
  // Only one cell can be in edit mode at a time (key: `${row}:${col}` of the
  // current table); an outside mousedown cancels it, mirroring the old
  // closeActiveEdit behavior.
  const [editingCell, setEditingCell] = createSignal<string | null>(null)
  // Same one-at-a-time pattern for a column header's settings popover.
  const [openColMenu, setOpenColMenu] = createSignal<string | null>(null)
  // Editable tables show two sub-tabs below the main tab strip: the
  // interactive fold ("table") and the read-only `name·events` history
  // ("events"). Resets to "table" whenever the selected tab changes.
  const [subView, setSubView] = createSignal<'table' | 'events'>('table')
  const [graphCollapsed, setGraphCollapsed] = createSignal(window.matchMedia('(max-width: 767px)').matches)
  const [colRanges, setColRanges] = createSignal<ColRange[] | null>(null)

  // Outside mousedowns cancel the open cell editor / column-settings popover.
  listenGlobal(document, 'mousedown', (e) => {
    const target = e.target as HTMLElement | null
    if (editingCell() != null && !target?.closest?.('.editable-cell.editing')) setEditingCell(null)
    if (openColMenu() != null && !target?.closest?.('.col-settings-wrap')) setOpenColMenu(null)
  })

  const names = createMemo(() => {
    tick()
    return allNames(views(), store)
  })

  // Keep the selected tab valid as the tab set changes (same policy the old
  // rebuildTabs applied): hold the current one, else prefer "events", else last.
  createEffect(() => {
    const ns = names()
    setCurrent((cur) => fallbackTab(ns, cur))
  })

  // Editing another table resets transient edit state, like the old rebuild did,
  // and drops back to the "table" sub-tab (never leaves a freshly-selected
  // table showing its events history by default).
  createEffect(on(current, () => {
    setEditingCell(null)
    setOpenColMenu(null)
    setSubView('table')
  }, { defer: true }))

  // Whether the current tab is a genuine editable table (has a fold worth
  // showing) as opposed to a cooked view or a log table.
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

  const roTable = createMemo(() => {
    const name = current()
    if (!name || editableData()) return null
    // An editable table's "events" sub-tab reads its history from the
    // `name·events` view main injects; everything else (cooked views, log
    // tables) is keyed by its own name.
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

    // Measured after opening (not guessed) so a menu near the right edge of
    // the viewport clamps against its real width instead of overflowing it.
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
                  {/* Enum columns are code-only, not in COLUMN_TYPES — surface
                      the current type so the menu isn't mislabeled. */}
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

  // A single editable cell: click to open an editor in place (number box for
  // numbers, checkbox for booleans, text box otherwise); collapses back to a
  // plain display on commit or on an outside click. Enum cells skip that
  // dance — they show an always-live dropdown, so a value is one pick away
  // mid-performance. Committing appends a set-cell event to the store — the
  // edit *is* the event; the re-fold that follows shows the new state.
  // Code-typed cells instead hand their text to the main editor (onEditCell).
  // A value that doesn't fit the column's type (a misspelled enum, a number
  // typed as text) gets a `cell-invalid` marker (see cellValid).
  function EditableCell(cellProps: { table: string; rowIndex: number; col: EditableColumn }) {
    const { table, rowIndex, col } = cellProps
    const key = `${rowIndex}::${col.name}`
    const editing = () => editingCell() === key
    const raw = () => editableData()?.data.rows[rowIndex]?.[col.name]
    const invalid = () => !cellValid(raw(), col)

    const commit = (value: unknown): void => {
      // Guard the Enter-then-blur double fire: only the open editor commits.
      if (editingCell() !== key) return
      store.setCell(table, rowIndex, col.name, value)
      setEditingCell(null)
      bump()
    }

    const keyHandler = (e: KeyboardEvent, commitNow: () => void): void => {
      if (e.key === 'Enter') commitNow()
      if (e.key === 'Enter' && e.ctrlKey && props.onCtrlEnter) props.onCtrlEnter()
    }

    // Collaborators whose last edit landed on this cell: outlined in their
    // color(s), with their name(s) visible in a corner badge (not just a
    // hover title) — usually one peer, occasionally two sharing a cell.
    const editors = () => lastEditors(presence(), table, rowIndex, col.name)

    return (
      <td
        class="editable-cell"
        classList={{ editing: editing(), 'cell-invalid': invalid() }}
        style={editors().length ? { outline: `2px solid ${editors()[0].color}`, 'outline-offset': '-2px' } : undefined}
        onClick={() => {
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
            {/* A stray value not in the options still shows (and stays flagged)
                until the user picks a valid one. */}
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
            />
          </Show>
          <Show when={col.type === 'number'}>
            {(() => {
              const cur = Number(raw()) || 0
              let num: HTMLInputElement | undefined
              const commitNum = (): void => {
                if (!num) return
                const v = Number(num.value)
                commit(Number.isFinite(v) && num.value.trim() !== '' ? v : cur)
              }
              return (
                <input
                  type="number"
                  class="cell-number"
                  value={String(cur)}
                  step="any"
                  ref={(el) => { num = el; focusInput(el) }}
                  onKeyDown={(e) => keyHandler(e, commitNum)}
                  onBlur={commitNum}
                />
              )
            })()}
          </Show>
          <Show when={col.type === 'string' || col.type === 'code'}>
            <input
              type="text"
              class="cell-text"
              value={raw() == null ? '' : String(raw())}
              ref={(el) => focusInput(el)}
              onKeyDown={(e) => keyHandler(e, () => (e.currentTarget as HTMLInputElement).blur())}
              onBlur={(e) => commit(e.currentTarget.value)}
            />
          </Show>
        </Show>
      </td>
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
    // Multiplayer presence: ring this tab, and name-tag it, for any peer(s)
    // currently viewing it.
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

  return (
    <>
      <div class="table-pane-header">
        <div class="table-pane-header-row table-pane-header-titles">
          <div class="table-tabs">
            <For each={names()}>{(n) => <Tab name={n} />}</For>
          </div>
          {/* Mobile substitute for the tab strip — a native <select> is far
              easier to use with a thumb than a wrapping row of small buttons. */}
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
                            // A boolean column literally named "disabled" is the
                            // row's own mute switch (see DISABLED_COL) — dim it
                            // straight from its own data, no separate state.
                            'row-disabled': ed().data.rows[i]?.[DISABLED_COL] === true,
                            'row-invalid': invalidColumns(ed().data.rows[i], ed().data.columns).length > 0,
                          }}
                        >
                          <td class="row-actions">
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

// The pure-logic side handed to app.tsx: the TablePanel API main.ts drives,
// plus the signal accessors <TablePane> renders from. No DOM here — the view
// above is the only thing that touches elements.
export interface TablePanelController extends TablePanel, PanelProps {}

export function createTablePanel(
  editableStore: EditableTableStore,
  { onEditCell, onCtrlEnter, onSelectTable }: TablePanelOptions = {},
): TablePanelController {
  const [views, setViews] = createSignal<Map<string, Table>>(new Map())
  const [graphs, setGraphs] = createSignal<Map<string, GraphSpec>>(new Map())
  const [current, setCurrent] = createSignal<string | null>(null)
  const [playIndex, setPlayIndex] = createSignal(0)
  const [playActive, setPlayActive] = createSignal<Map<string, Set<number>> | null>(null)
  const [userScrolled, setUserScrolled] = createSignal(false)
  const [presence, setPresence] = createSignal<PeerPresence[]>([])

  return {
    store: editableStore,
    views,
    graphs,
    current,
    setCurrent,
    playIndex,
    playActive,
    userScrolled,
    setUserScrolled,
    presence,
    onEditCell,
    onCtrlEnter,
    onSelectTable,

    selectTable(name: string | null): void {
      if (name != null && (views().has(name) || editableStore.has(name)) && name !== current()) {
        setCurrent(name)
      }
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
