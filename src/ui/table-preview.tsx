// Inline table preview: a compact card — a sparkline of the numeric columns
// plus the first few rows — used by the editor's hover tooltip. The sparkline
// itself is painted by ../preview.ts; this file is only the card.

import { For, Show } from 'solid-js'
import { mountComponent } from './dom.js'
import { formatCell } from '../table-panel.js'
import { SERIES_COLORS, fmtNum, chartDataFor, computeColRanges, numericColumns, type ColRange } from '../graph-panel.js'
import { canDrawSparklines, drawSparklines } from '../preview.js'
import type { Table } from '../dsl.js'

interface PreviewOptions {
  maxRows?: number
  maxCols?: number
  playIndex?: number | null
}

function TablePreviewCard(props: { table: Table; opts: Required<PreviewOptions> }) {
  const { table } = props
  const { maxRows, maxCols, playIndex } = props.opts

  const allCols = table.columns
  const cols = allCols.slice(0, maxCols)
  const hasMoreCols = allCols.length > maxCols

  const rowsLabel = `${table.length} row${table.length === 1 ? '' : 's'}`
  const colsLabel = `${allCols.length} col${allCols.length === 1 ? '' : 's'}`

  const numCols = numericColumns(table.rows, allCols)
  const chartData = chartDataFor(table.rows, allCols, numCols, table.name ?? 'table')
  const drawable = chartData != null && canDrawSparklines(table.rows, numCols)
  const colRanges: ColRange[] = drawable ? computeColRanges(table.rows, numCols, 0) : []

  return (
    <div class="cm-preview">
      <div class="cm-preview-head">{`${table.name ?? 'table'} · ${rowsLabel} · ${colsLabel}`}</div>
      <Show when={drawable}>
        <canvas
          class="cm-preview-spark"
          ref={(el) => drawSparklines(el, chartData!, colRanges, playIndex)}
        />
        <div class="cm-preview-spark-label">
          <For each={numCols}>
            {(c, ci) => (
              <span class="cm-preview-series">
                <span class="cm-preview-dot" style={{ background: SERIES_COLORS[ci() % SERIES_COLORS.length] }} />
                {c}
                <Show when={colRanges[ci()]}>
                  <span class="graph-range">{` ${fmtNum(colRanges[ci()].rawMin)}–${fmtNum(colRanges[ci()].rawMax)}`}</span>
                </Show>
              </span>
            )}
          </For>
        </div>
      </Show>
      <Show when={cols.length}>
        <table class="cm-preview-table">
          <thead>
            <tr>
              <For each={cols}>{(c) => <th>{c}</th>}</For>
              <Show when={hasMoreCols}><th>…</th></Show>
            </tr>
          </thead>
          <tbody>
            <For each={table.rows.slice(0, maxRows)}>
              {(row) => (
                <tr>
                  <For each={cols}>{(c) => <td>{formatCell(c, row[c])}</td>}</For>
                  <Show when={hasMoreCols}><td>…</td></Show>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </Show>
      <Show when={table.length > maxRows}>
        <div class="cm-preview-more">{`+${table.length - maxRows} more rows`}</div>
      </Show>
    </div>
  )
}

// Render the card detached, for hosts (CodeMirror tooltips) that want a plain
// DOM node.
export function buildTablePreview(
  table: Table,
  { maxRows = 6, maxCols = 6, playIndex = null }: PreviewOptions = {},
): { dom: HTMLElement; destroy: () => void } {
  const { el, dispose } = mountComponent(
    () => <TablePreviewCard table={table} opts={{ maxRows, maxCols, playIndex }} />,
  )
  return { dom: el, destroy: dispose }
}
