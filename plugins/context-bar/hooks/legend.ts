// SPDX-License-Identifier: Apache-2.0

import type { LegendRow } from '../types'
import {
  LEGEND_COLUMN_GAP,
  LEGEND_FIELD_GAP,
  LEGEND_SQUARE_WIDTH,
  TINY_PERCENT_LABEL,
} from './config'
import { formatPercent, formatTokens } from './format'

/** One legend cell; `label` and `value` are padded so every cell has one width. */
export type LegendCell = { key: string; label: string; value: string; text: string }

const widest = (texts: readonly string[]): number => Math.max(0, ...texts.map(t => t.length))

const columnsFor = (cellWidth: number, width: number): number => {
  const cell = cellWidth + LEGEND_SQUARE_WIDTH
  return Math.max(1, Math.floor((width + LEGEND_COLUMN_GAP) / (cell + LEGEND_COLUMN_GAP)))
}

/** Legend rows as a table: lines of equal-width cells, numbers right-aligned. */
export const legendGrid = (rows: readonly LegendRow[], width: number): LegendCell[][] => {
  const tokens = rows.map(r => formatTokens(r.tokens))
  const zeroPercent = formatPercent(0)
  const percents = rows.map(r => {
    const formatted = formatPercent(r.percent)
    return r.tokens > 0 && formatted === zeroPercent ? TINY_PERCENT_LABEL : formatted
  })
  const labelWidth = widest(rows.map(r => r.label))
  const tokenWidth = widest(tokens)
  const percentWidth = widest(percents)
  const gap = ' '.repeat(LEGEND_FIELD_GAP)
  const cells = rows.map((r, i) => {
    const label = r.label.padEnd(labelWidth)
    const value = `${tokens[i].padStart(tokenWidth)}${gap}${percents[i].padStart(percentWidth)}`
    return { key: r.key, label, value, text: `${label}${gap}${value}` }
  })
  const n = columnsFor(widest(cells.map(c => c.text)), width)
  const lines: LegendCell[][] = []
  for (let i = 0; i < cells.length; i += n) lines.push(cells.slice(i, i + n))
  return lines
}
