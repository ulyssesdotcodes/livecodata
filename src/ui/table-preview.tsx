// Inline table preview. A compact SolidJS card — a sparkline of every numeric
// column plus the first few rows/columns — for any Table. Used by the editor's
// hover tooltip so you can see a view's data without leaving the code
// (reusing the table panel's cell formatter for consistent display). The
// sparkline itself is painted by ../preview.ts; this file is only the card.

import { render } from 'solid-js/web'
import { For, Show } from 'solid-js'
import { formatCell } from '../table-panel.js'
import { SERIES_COLORS, fmtNum } from '../graph-panel.js'
import { canDrawSparklines, drawSparklines, sparklineRanges, type SparkRange } from '../preview.js'
import type { Table } from '../dsl.js'
import type { Row } from '../lineage.js'

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

  const hasIndex = allCols.includes('beat')
  const xOf = (row: Row, i: number): number => (hasIndex ? (row.beat as number) : i)
  const numCols = allCols.filter(
    (c) => c !== 'beat' && table.rows.some((r) => typeof r[c] === 'number'),
  )
  const drawable = numCols.length > 0 && canDrawSparklines(table.rows, numCols)
  const colRanges: SparkRange[] = drawable ? sparklineRanges(table.rows, numCols) : []

  return (
    <div class="cm-preview">
      <div class="cm-preview-head">{`${table.name ?? 'table'} · ${rowsLabel} · ${colsLabel}`}</div>
      <Show when={drawable}>
        <canvas
          class="cm-preview-spark"
          ref={(el) => drawSparklines(el, table.rows, numCols, xOf, hasIndex, playIndex)}
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

// Render the card into a detached element, for hosts (CodeMirror tooltips)
// that want a plain DOM node. `destroy` disposes the Solid root.
export function buildTablePreview(
  table: Table,
  { maxRows = 6, maxCols = 6, playIndex = null }: PreviewOptions = {},
): { dom: HTMLElement; destroy: () => void } {
  const host = document.createElement('div')
  host.style.display = 'contents'
  const dispose = render(
    () => <TablePreviewCard table={table} opts={{ maxRows, maxCols, playIndex }} />,
    host,
  )
  return { dom: host, destroy: dispose }
}
