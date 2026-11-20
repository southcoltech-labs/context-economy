// SPDX-License-Identifier: Apache-2.0

import { formatTokens } from './format'
import type { TrendMetric, TrendPoint } from '../types'

/** The trend covers this much of the session, ending now. */
export const TREND_WINDOW_MS = 30 * 60_000
/** Hard cap on stored points per series, so a very busy session cannot grow the state without bound. */
export const TREND_MAX_POINTS = 120
/** Rows of the plot; the y axis is labelled on the first, middle and last. */
export const TREND_HEIGHT = 3
/** Minutes before now that carry a time label on the x axis. */
export const TREND_TICK_MINUTES = [30, 20, 10, 0] as const
export const TREND_METRICS: readonly TrendMetric[] = ['resident', 'processed']
export const DEFAULT_TREND_METRIC: TrendMetric = 'resident'
export const TREND_METRIC_LABEL: Readonly<Record<TrendMetric, string>> = {
  resident: 'resident context',
  processed: 'cumulative processed',
}

/**
 * Adds a point and drops what fell out of the window. The newest point older
 * than the window is kept: it is the value in force when the window opens.
 */
export const prunePoints = (points: readonly TrendPoint[], now: number): TrendPoint[] => {
  const start = now - TREND_WINDOW_MS
  const lastOld = points.reduce((found, p, i) => (p.at < start ? i : found), -1)
  const kept = lastOld > 0 ? points.slice(lastOld) : [...points]
  return kept.length > TREND_MAX_POINTS ? kept.slice(kept.length - TREND_MAX_POINTS) : kept
}

export const addPoint = (points: readonly TrendPoint[], point: TrendPoint, now: number): TrendPoint[] => prunePoints([...points, point], now)

/** Seconds between the open trend's own redraws, so the line slides left while the session is idle (one braille dot is about 15 s at a typical width). */
export const TREND_REFRESH_SECONDS = [15, 30, 60] as const
export const DEFAULT_TREND_REFRESH_SECONDS = 30

export const parseTrendRefreshSeconds = (value: unknown): number => {
  if (value === undefined) return DEFAULT_TREND_REFRESH_SECONDS
  if (typeof value === 'number' && (TREND_REFRESH_SECONDS as readonly number[]).includes(value)) return value
  throw new Error('context-bar: trendRefreshSeconds must be 15, 30 or 60')
}

const BRAILLE_BASE = 0x2800
/** Braille dot bit by [dot column][dot row]: each cell is 2 dots wide and 4 high. */
const DOT_BITS = [[0x01, 0x02, 0x04, 0x40], [0x08, 0x10, 0x20, 0x80]] as const
const Y_STEPS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]

/** Rounds a token count up to a round axis maximum (1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8 or 10 times a power of ten). */
export const niceCeil = (value: number): number => {
  if (!(value > 0)) return 1
  const base = 10 ** Math.floor(Math.log10(value))
  const step = Y_STEPS.find(s => s * base >= value) ?? 10
  return Math.max(1, Math.round(step * base))
}

/** Below this share of the top, the axis starts at 0 instead of floating: a series that began near nothing should show that. */
const FLOOR_SHARE = 0.2

/**
 * The y range for the values shown: the data's own range widened to round
 * numbers (a half power of ten of the span), so the line fills the plot and the
 * labels move with it. Starts at 0 when the low end is close to it or the
 * series is flat.
 */
export const yRange = (min: number, max: number): { lo: number; hi: number } => {
  const span = max - min
  if (!(span > 0)) return { lo: 0, hi: niceCeil(max) }
  const unit = 10 ** Math.floor(Math.log10(span)) / 2
  const lo = Math.floor(min / unit) * unit
  const hi = Math.ceil(max / unit) * unit
  return lo <= hi * FLOOR_SHARE ? { lo: 0, hi: niceCeil(max) } : { lo, hi }
}

type Knot = { x: number; v: number }

/** Window position (0 = 30 minutes ago, 1 = now) of each point, then a flat run to now: a value holds until the next turn. */
const knotsOf = (points: readonly TrendPoint[], now: number): Knot[] => {
  const start = now - TREND_WINDOW_MS
  const knots = points.map(p => ({ x: Math.min(1, Math.max(0, (p.at - start) / TREND_WINDOW_MS)), v: p.value }))
  const last = knots.at(-1)
  if (last !== undefined && last.x < 1) knots.push({ x: 1, v: last.v })
  return knots
}

export type ChartRow = { label: string; axis: string; plot: string }
export type LineChart = {
  rows: ChartRow[]
  /** The x axis line, aligned under the plot. */
  baseline: string
  /** The time labels, aligned under the baseline. */
  ticks: string
}

/** Time labels along the bottom: one per ten minutes when they fit, else just the two ends. */
const tickLabels = (columns: number, indent: number): { baseline: string; ticks: string } => {
  const minutes = columns >= 28 ? TREND_TICK_MINUTES : [TREND_TICK_MINUTES[0]!, 0]
  const line = new Array<string>(columns).fill('─')
  const labels = new Array<string>(columns).fill(' ')
  let end = -1
  for (const m of minutes) {
    const x = Math.round((1 - (m * 60_000) / TREND_WINDOW_MS) * (columns - 1))
    const text = m === 0 ? 'now' : `-${m}m`
    const start = Math.min(columns - text.length, Math.max(0, x - Math.floor(text.length / 2)))
    line[x] = '┴'
    if (start <= end) continue
    for (let i = 0; i < text.length; i++) labels[start + i] = text[i]!
    end = start + text.length
  }
  const pad = ' '.repeat(indent)
  return { baseline: `${pad}└${line.join('')}`, ticks: `${pad} ${labels.join('')}` }
}

/**
 * A line chart of the series over the last 30 minutes: time along x, tokens
 * up y over the range of the data (see yRange), drawn in braille dots (2 x 4 per cell) with
 * straight lines between samples. Null when there is no sample.
 */
export const lineChart = (points: readonly TrendPoint[], now: number, totalColumns: number, height = TREND_HEIGHT): LineChart | null => {
  const knots = knotsOf(prunePoints(points, now), now)
  if (knots.length === 0) return null
  const values = knots.map(k => k.v)
  const { lo, hi } = yRange(Math.min(...values), Math.max(...values))
  const labels = new Map<number, string>([
    [0, formatTokens(hi)],
    [Math.floor((height - 1) / 2), formatTokens(Math.round((lo + hi) / 2))],
    [height - 1, formatTokens(lo)],
  ])
  const labelWidth = Math.max(...[...labels.values()].map(l => l.length))
  const columns = Math.max(8, Math.floor(totalColumns) - labelWidth - 2)
  const dotsW = columns * 2
  const dotsH = height * 4
  const grid = Array.from({ length: height }, () => new Array<number>(columns).fill(0))
  const dot = (x: number, y: number): void => {
    grid[y >> 2]![x >> 1]! |= DOT_BITS[x & 1]![y & 3]!
  }
  const px = (k: Knot): number => Math.round(k.x * (dotsW - 1))
  const py = (k: Knot): number => Math.round((1 - (k.v - lo) / (hi - lo)) * (dotsH - 1))
  if (knots.length === 1) dot(px(knots[0]!), py(knots[0]!))
  for (let i = 1; i < knots.length; i++) {
    // Bresenham between two samples
    let x = px(knots[i - 1]!)
    let y = py(knots[i - 1]!)
    const x1 = px(knots[i]!)
    const y1 = py(knots[i]!)
    const dx = Math.abs(x1 - x)
    const dy = -Math.abs(y1 - y)
    const sx = x < x1 ? 1 : -1
    const sy = y < y1 ? 1 : -1
    let err = dx + dy
    for (;;) {
      dot(x, y)
      if (x === x1 && y === y1) break
      const e2 = 2 * err
      if (e2 >= dy) { err += dy; x += sx }
      if (e2 <= dx) { err += dx; y += sy }
    }
  }
  const rows = grid.map((cells, r) => ({
    label: (labels.get(r) ?? '').padStart(labelWidth),
    axis: labels.has(r) ? '┤' : '│',
    plot: cells.map(c => (c === 0 ? ' ' : String.fromCharCode(BRAILLE_BASE + c))).join(''),
  }))
  return { rows, ...tickLabels(columns, labelWidth + 1) }
}

export const nextMetric = (metric: TrendMetric): TrendMetric => (metric === 'resident' ? 'processed' : 'resident')

/** The four API token counts of one turn, summed: everything the model processed. */
export const processedTokens = (usage: {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}): number =>
  (usage.input_tokens ?? 0) +
  (usage.output_tokens ?? 0) +
  (usage.cache_read_input_tokens ?? 0) +
  (usage.cache_creation_input_tokens ?? 0)
