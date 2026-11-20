// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'claude-code/testing'

import type { LegendRow } from '../types'
import { legendGrid } from './legend'
import { LEGEND_COLUMN_GAP as COL_GAP, LEGEND_SQUARE_WIDTH as SQUARE } from './config'

const row = (key: string, label: string, tokens: number, percent: number): LegendRow => ({
  key,
  label,
  tokens,
  percent,
})

const NINE: LegendRow[] = [
  row('system', 'System', 4200, 0.4),
  row('tools', 'Tool defs', 12000, 1.2),
  row('mcp', 'MCP', 900, 0.1),
  row('agents', 'Agents', 300, 0),
  row('memory', 'Memory', 2100, 0.2),
  row('skills', 'Skills', 1800, 0.2),
  row('messages', 'Messages', 80000, 8),
  row('free', 'Free', 700000, 70),
  row('buffer', 'Buffer', 30000, 3),
]

describe('legendGrid', () => {
  test('v0.4: cells flow to fill the width, no fixed column cap, in order', () => {
    const shown = NINE.map(r => r.key)
    expect(legendGrid(NINE, 400).map(line => line.map(c => c.key))).toEqual([shown])
    const used = (n: number, cell: number) => n * (cell + SQUARE) + (n - 1) * COL_GAP
    for (const width of [60, 80, 104, 120, 158, 200, 240]) {
      const grid = legendGrid(NINE, width)
      const cell = grid[0][0].text.length
      expect(grid.flat().map(c => c.key)).toEqual(shown)
      for (const line of grid) expect(used(line.length, cell)).toBeLessThanOrEqual(width)
      for (const line of grid.slice(0, -1)) expect(line.length).toBe(grid[0].length)
      if (grid.length > 1) expect(used(grid[0].length + 1, cell)).toBeGreaterThan(width)
    }
    expect(legendGrid(NINE, 200)[0].length).toBeGreaterThan(3)
  })
  test('v0.4: legend keeps the buffer row (user 2026-10-29), so the legend sums to 100%', () => {
    expect(legendGrid(NINE, 240).flat().map(c => c.key)).toContain('buffer')
    expect(legendGrid(NINE, 240).flat().reduce((n, c) => n + Number(NINE.find(r => r.key === c.key)!.tokens), 0)).toBe(NINE.reduce((n, r) => n + r.tokens, 0))
  })

  test('cells in one column have one width, numbers right-aligned', () => {
    const grid = legendGrid(NINE, 200)
    expect(new Set(grid.flat().map(c => c.text.length)).size).toBe(1)
    expect(grid[0][0].text.startsWith('System')).toBe(true)
    expect(grid[0][0].text.endsWith('0.4%')).toBe(true)
    expect(grid.flat().find(c => c.key === 'free')!.text.endsWith('70.0%')).toBe(true)
    const all = grid.flat().map(c => c.value.length)
    expect(new Set(all).size).toBe(1)
  })

  test('narrow width uses fewer columns, never wider than the width', () => {
    const grid = legendGrid(NINE, 60)
    expect(grid[0].length).toBeLessThan(3)
    for (const line of grid) {
      const used = line.reduce((a, c) => a + c.text.length + 2, 0) + (line.length - 1) * 3
      expect(used).toBeLessThanOrEqual(60)
    }
  })

  test('too narrow for one cell still gives one column', () => {
    expect(legendGrid(NINE, 5).every(line => line.length === 1)).toBe(true)
  })
  test('v0.4 CX: a non-zero row that rounds to 0.0% shows <0.1%; a zero row shows 0.0%', () => {
    const cells = legendGrid([row('agents', 'Agent defs', 83, 0), row('other', 'Other', 0, 0), row('free', 'Free', 900, 90)], 200).flat()
    expect(cells[0].text.trimEnd().endsWith('<0.1%')).toBe(true)
    expect(cells[1].text.trimEnd().endsWith('0.0%')).toBe(true)
    expect(cells[1].text).not.toContain('<')
    expect(new Set(cells.map(c => c.value.length)).size).toBe(1)
  })
})
