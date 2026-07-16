// Sparkline painting for the inline table preview card (DOM in
// ui/table-preview.tsx). Uses graph-panel's shared drawSeriesChart — the same
// renderer as the table panel's big graph — so the two surfaces can't drift.

import { drawSeriesChart, SPARKLINE_STYLE, type ChartData, type ColRange } from './graph-panel.js'
import type { Row } from './lineage.js'

export const SPARK_W = 220
export const SPARK_H = 50  // 36px chart area + 14px x-axis label area

export function canDrawSparklines(rows: Row[], cols: string[]): boolean {
  return cols.some((c) => rows.filter((r) => typeof r[c] === 'number').length >= 2)
}

// `ranges` are the caller's computeColRanges(rows, cols, 0) — shared with the
// legend.
export function drawSparklines(
  canvas: HTMLCanvasElement,
  data: ChartData,
  ranges: ColRange[],
  playIndex: number | null = null,
): void {
  drawSeriesChart(canvas, data, ranges, {
    style: SPARKLINE_STYLE,
    size: { w: SPARK_W, h: SPARK_H },
    playIndex,
  })
}
