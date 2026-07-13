// Sparkline painting for the inline table preview card (see
// ui/table-preview.tsx, which owns the DOM around it). The actual chart is
// graph-panel.ts's shared drawSeriesChart — same renderer as the table
// panel's big graph, at sparkline size and style — so the two surfaces can't
// drift apart.

import { drawSeriesChart, SPARKLINE_STYLE, type ChartData, type ColRange } from './graph-panel.js'
import type { Row } from './lineage.js'

export const SPARK_W = 220
export const SPARK_H = 50  // 36px chart area + 14px x-axis label area

// Whether any series has enough numeric data to plot.
export function canDrawSparklines(rows: Row[], cols: string[]): boolean {
  return cols.some((c) => rows.filter((r) => typeof r[c] === 'number').length >= 2)
}

// A tiny multi-line chart painted into the given canvas. `ranges` are the
// caller's computeColRanges(rows, cols, 0) — shared with the legend.
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
