// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'claude-code/testing'
import {
  TREND_MAX_POINTS,
  TREND_WINDOW_MS,
  addPoint,
  lineChart,
  niceCeil,
  yRange,
  nextMetric,
  parseTrendRefreshSeconds,
  processedTokens,
} from './trend'

const NOW = 10 * TREND_WINDOW_MS
const MIN = 60_000

test('addPoint keeps points inside the window and the newest one before it', () => {
  let points = addPoint([], { at: NOW - 50 * MIN, value: 1 }, NOW - 50 * MIN)
  points = addPoint(points, { at: NOW - 40 * MIN, value: 2 }, NOW - 40 * MIN)
  points = addPoint(points, { at: NOW - 10 * MIN, value: 3 }, NOW)
  expect(points.map(p => p.value)).toEqual([2, 3])
})

test('addPoint caps the series length', () => {
  let points: { at: number; value: number }[] = []
  for (let i = 0; i < TREND_MAX_POINTS + 25; i++) points = addPoint(points, { at: NOW - 1000 + i, value: i }, NOW)
  expect(TREND_MAX_POINTS).toBe(120) // memory only, never written
  expect(points).toHaveLength(TREND_MAX_POINTS)
  expect(points.at(-1)!.value).toBe(TREND_MAX_POINTS + 24)
})

test('niceCeil rounds up to a round axis maximum', () => {
  expect([0, 1, 950, 3000, 9000, 118_000, 1_040_000].map(niceCeil)).toEqual([1, 1, 1000, 3000, 10_000, 120_000, 1_200_000])
})

test('lineChart is null with no points', () => {
  expect(lineChart([], NOW, 60)).toBeNull()
})

test('y axis follows the data: labels are the rounded top, middle and bottom of the range', () => {
  const chart = lineChart([{ at: NOW - 20 * MIN, value: 5000 }, { at: NOW - 5 * MIN, value: 9000 }], NOW, 60)!
  expect(chart.rows).toHaveLength(3)
  expect(chart.rows.map(r => r.label.trim())).toEqual(['9k', '7k', '5k'])
  expect(chart.rows.map(r => r.axis)).toEqual(['┤', '┤', '┤'])
})

test('the y axis moves with the data: the same shape at a larger scale gets larger labels', () => {
  const chart = lineChart([{ at: NOW - 20 * MIN, value: 95_000 }, { at: NOW - 5 * MIN, value: 118_000 }], NOW, 60)!
  expect(chart.rows.map(r => r.label.trim())).toEqual(['120k', '108k', '95k'])
})

test('the y axis starts at 0 when the low end is near it, or the series is flat', () => {
  const rising = lineChart([{ at: NOW - 20 * MIN, value: 1000 }, { at: NOW - 5 * MIN, value: 10_000 }], NOW, 60)!
  expect(rising.rows.map(r => r.label.trim())).toEqual(['10k', '5k', '0'])
  const flat = lineChart([{ at: NOW - 20 * MIN, value: 8000 }], NOW, 60)!
  expect(flat.rows.map(r => r.label.trim())).toEqual(['8k', '4k', '0'])
})

test('yRange widens to round numbers and never leaves the data outside', () => {
  expect(yRange(38_000, 118_000)).toEqual({ lo: 35_000, hi: 120_000 })
  expect(yRange(95_000, 118_000)).toEqual({ lo: 95_000, hi: 120_000 })
  expect(yRange(0, 0)).toEqual({ lo: 0, hi: 1 })
})

test('x axis carries the time labels under the baseline, the last one at the right edge', () => {
  const chart = lineChart([{ at: NOW - 5 * MIN, value: 100 }], NOW, 60)!
  const plotColumns = chart.rows[0]!.plot.length
  expect(chart.ticks).toMatch(/-30m.*-20m.*-10m.*now$/)
  expect(chart.ticks.trimEnd()).toHaveLength(chart.baseline.length)
  expect(chart.baseline.startsWith(' '.repeat(chart.rows[0]!.label.length + 1) + '└')).toBe(true)
  expect(chart.baseline).toHaveLength(chart.rows[0]!.label.length + 1 + 1 + plotColumns)
  expect(chart.baseline.at(-1)).toBe('┴')
})

test('a narrow chart keeps only the two end labels', () => {
  const chart = lineChart([{ at: NOW - 5 * MIN, value: 100 }], NOW, 20)!
  expect(chart.ticks).toMatch(/-30m\s+now$/)
  expect(chart.ticks).not.toMatch(/-20m/)
})

test('the plot fills the width given', () => {
  const chart = lineChart([{ at: NOW - 5 * MIN, value: 100 }], NOW, 80)!
  const row = chart.rows[0]!
  expect(row.label.length + 1 + 1 + row.plot.length).toBe(80)
})

const dotsIn = (plot: string): number => [...plot].filter(c => c >= '\u2801').length

test('a rising line starts low on the left and ends at the top on the right', () => {
  const chart = lineChart([{ at: NOW - 30 * MIN, value: 1000 }, { at: NOW - 1 * MIN, value: 10_000 }], NOW, 60)!
  const top = chart.rows[0]!.plot
  const bottom = chart.rows.at(-1)!.plot
  expect(top.at(-1)).not.toBe(' ')
  expect(top.at(0)).toBe(' ')
  expect(bottom.at(0)).not.toBe(' ')
  expect(bottom.at(-1)).toBe(' ')
})

test('the line stays flat from the last sample to now, and is empty before the first sample', () => {
  const chart = lineChart([{ at: NOW - 15 * MIN, value: 8000 }], NOW, 60)!
  const flat = chart.rows.find(r => dotsIn(r.plot) > 0)!
  expect(flat.plot.at(-1)).not.toBe(' ')
  expect(flat.plot.slice(0, 5).trim()).toBe('')
  expect(chart.rows.filter(r => dotsIn(r.plot) > 0)).toHaveLength(1)
})

test('a point before the window opens the line at the left edge', () => {
  const chart = lineChart([{ at: NOW - 45 * MIN, value: 4000 }, { at: NOW - 5 * MIN, value: 4000 }], NOW, 60)!
  const flat = chart.rows.find(r => dotsIn(r.plot) > 0)!
  expect(flat.plot.at(0)).not.toBe(' ')
  expect(flat.plot.at(-1)).not.toBe(' ')
})

test('a single sample at now draws one dot', () => {
  const chart = lineChart([{ at: NOW, value: 500 }], NOW, 60)!
  expect(chart.rows.reduce((n, r) => n + dotsIn(r.plot), 0)).toBe(1)
})

test('processedTokens sums the four counts and treats absent ones as zero', () => {
  expect(processedTokens({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 1 })).toBe(116)
  expect(processedTokens({ output_tokens: 3 })).toBe(3)
})

test('nextMetric toggles', () => {
  expect(nextMetric('resident')).toBe('processed')
  expect(nextMetric('processed')).toBe('resident')
})

test('trendRefreshSeconds accepts 15, 30 and 60, defaults to 30, rejects anything else', () => {
  expect(parseTrendRefreshSeconds(undefined)).toBe(30)
  for (const v of [15, 30, 60]) expect(parseTrendRefreshSeconds(v)).toBe(v)
  for (const v of [0, 10, 45, '30', null, Number.NaN]) expect(() => parseTrendRefreshSeconds(v)).toThrow(/trendRefreshSeconds/)
})
