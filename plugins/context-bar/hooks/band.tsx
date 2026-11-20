// SPDX-License-Identifier: Apache-2.0

import type { Elements, RenderElement, RenderInput } from 'claude-code'

import { layoutBar } from './bar'
import {
  DISTRIBUTION_NOTE,
  ERROR_COLOR,
  GAP_CHAR,
  GAP_KEY,
  HEADER,
  HEADER_COLOR,
  LEGEND_COLUMN_GAP,
  LEGEND_FIELD_GAP,
  MARKER_CHAR,
  MARKER_COLOR,
  NOT_AVAILABLE,
  NOTE_SEPARATOR,
  PREFIX_MARKER_CHAR,
  PREFIX_MARKER_COLOR,
  PREFIX_TEXT,
  SQUARE_CHAR,
} from './config'
import type { CategoryKey } from './config'
import type { Palette } from './palettes'
import { badgeColor, formatPercent, formatTokens } from './format'
import { footerCompaction } from './footer'
import { glyphOf, groupRows, orderRows, prefixTokensOf } from './levels'
import type { LabelLevel } from './levels'
import { legendGrid } from './legend'
import { summaryText } from './view'
import { ageText } from './refresh'
import { TREND_METRICS, TREND_METRIC_LABEL, TREND_WINDOW_MS, lineChart } from './trend'
import type { ContextView, TrendMetric, TrendPoint } from '../types'

type BandInput = Extract<RenderInput, { component: 'AbovePrompt' }>

export type Ui = Pick<Elements['terminal'], 'Box' | 'Button' | 'Text'>

/** What the expanded band needs: the open/closed state, the shown metric and its points, and the two button handlers. */
export type TrendInput = {
  isExpanded: boolean
  metric: TrendMetric
  points: readonly TrendPoint[]
  now: number
  onExpand: () => void
  onMetric: () => void
}

const TRIANGLE_DOWN = '▼'
const TRIANGLE_UP = '▲'
const TREND_TITLE = `trend · last ${TREND_WINDOW_MS / 60_000}m`

/** Expanded band: the metric toggle over a line chart of the last 30 minutes (tokens up, time across). */
const trendSection = (ui: Ui, e: BandInput, trend: TrendInput): RenderElement | null => {
  if (!trend.isExpanded) return null
  const { Box, Button, Text } = ui
  const chart = lineChart(trend.points, trend.now, Math.max(1, e.props.bodyColumns))
  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Box gap={1}>
          <Text bold color={HEADER_COLOR}>{TREND_TITLE}</Text>
          <Button key="metric" onPress={trend.onMetric}>
            {TREND_METRICS.map((m, i) => (
              <Text key={m} bold={m === trend.metric} dimColor={m !== trend.metric}>
                {`${i > 0 ? ' ⇄ ' : ''}${TREND_METRIC_LABEL[m]}`}
              </Text>
            ))}
          </Button>
        </Box>
        <Text dimColor>{chart === null ? 'collecting…' : 'tokens'}</Text>
      </Box>
      {chart !== null && chart.rows.map((r, i) => (
        <Box key={`trend-${i}`}>
          <Text dimColor>{`${r.label} ${r.axis}`}</Text>
          <Text color={HEADER_COLOR}>{r.plot}</Text>
        </Box>
      ))}
      {chart !== null && <Text dimColor>{chart.baseline}</Text>}
      {chart !== null && <Text dimColor>{chart.ticks}</Text>}
    </Box>
  )
}

const colorOf = (palette: Palette, key: string): string | undefined =>
  key === GAP_KEY ? undefined : palette[key as CategoryKey]

/** The band: header, stacked bar with threshold marker, legend. */
export const renderBand = (
  ui: Ui,
  e: BandInput,
  view: ContextView | null,
  error: string | null,
  roundsSince: number,
  level: () => LabelLevel,
  palette: Palette,
  trend: TrendInput,
): RenderElement => {
  const { Box, Button, Text } = ui
  const expand = (
    <Button key="expand" onPress={trend.onExpand}>{trend.isExpanded ? TRIANGLE_UP : TRIANGLE_DOWN}</Button>
  )
  const section = trendSection(ui, e, trend)
  const header = (
    <Text bold color={HEADER_COLOR}>{HEADER}</Text>
  )
  if (view === null) {
    return (
      <Box flexDirection="column">
        <Box justifyContent="space-between">
          {header}
          <Box gap={1}>
            <Text color={error === null ? undefined : ERROR_COLOR} dimColor={error === null}>
              {error === null ? NOT_AVAILABLE : `${NOT_AVAILABLE} (${error})`}
            </Text>
            {expand}
          </Box>
        </Box>
        {section}
      </Box>
    )
  }
  const rows = orderRows(groupRows(view.rows, level(), view.windowTokens))
  const note = `${DISTRIBUTION_NOTE}${ageText(roundsSince) ? `${NOTE_SEPARATOR}${ageText(roundsSince)}` : ''}`
  const compaction = footerCompaction(note, view.compactionText, Math.max(1, e.props.bodyColumns)) // hidden when it would not fit beside the note
  const prefixTokens = prefixTokensOf(view.rows)
  const runs = layoutBar(
    rows
      .filter(r => r.key !== 'other' || r.tokens > 0)
      .map(r => ({ key: r.key, tokens: r.tokens })),
    view.windowTokens,
    view.thresholdTokens,
    Math.max(1, e.props.bodyColumns),
    prefixTokens,
  )
  const markerChar = (key: string): string => key === 'prefixMarker' ? PREFIX_MARKER_CHAR : MARKER_CHAR
  const markerColor = (key: string): string => key === 'prefixMarker' ? PREFIX_MARKER_COLOR : MARKER_COLOR
  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        {header}
        <Box gap={1}>
          {prefixTokens > 0 && <Text dimColor>{`${PREFIX_TEXT} ${formatTokens(prefixTokens)} ·`}</Text>}
          <Text dimColor>{summaryText(view)}</Text>
          <Text inverse color={badgeColor(view.percent)}>{` ${formatPercent(view.percent)} `}</Text>
          {expand}
        </Box>
      </Box>
      <Box>
        {runs.map((r, i) => (
          <Text key={`run-${i}`} color={r.isMarker ? markerColor(r.key) : colorOf(palette, r.key)}>
            {(r.isMarker ? markerChar(r.key) : r.key === GAP_KEY ? GAP_CHAR : glyphOf(r.key)).repeat(r.length)}
          </Text>
        ))}
      </Box>
      <Box flexDirection="column">
        {legendGrid(rows, Math.max(1, e.props.bodyColumns)).map((line, i) => (
          <Box key={`line-${i}`} gap={LEGEND_COLUMN_GAP}>
            {line.map(c => (
              <Text key={`cell-${c.key}`}>
                <Text color={colorOf(palette, c.key)}>{SQUARE_CHAR}</Text>
                {` ${c.label}${' '.repeat(LEGEND_FIELD_GAP)}`}
                <Text dimColor>{c.value}</Text>
              </Text>
            ))}
          </Box>
        ))}
      </Box>
      <Box justifyContent="space-between">
        <Text dimColor italic>{note}</Text>
        {compaction !== '' && <Text dimColor>{compaction}</Text>}
      </Box>
      {section}
    </Box>
  )
}
