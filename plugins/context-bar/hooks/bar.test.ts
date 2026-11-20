// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'claude-code/testing'

import { layoutBar } from './bar'

const sum = (runs: { length: number }[]) => runs.reduce((n, r) => n + r.length, 0)

describe('layoutBar', () => {
  test('fills exactly the width', () => {
    const runs = layoutBar(
      [
        { key: 'system', tokens: 100 },
        { key: 'messages', tokens: 300 },
        { key: 'free', tokens: 600 },
      ],
      1000, null, 20,
    )
    expect(sum(runs)).toBe(20)
    expect(runs.map(r => r.key)).toEqual(['system', 'messages', 'free'])
    expect(runs.map(r => r.length)).toEqual([2, 6, 12])
  })

  test('marker replaces one cell at the threshold position', () => {
    const runs = layoutBar(
      [{ key: 'messages', tokens: 100 }, { key: 'free', tokens: 900 }],
      1000, 950, 20,
    )
    expect(sum(runs)).toBe(20)
    const marker = runs.filter(r => r.isMarker)
    expect(marker.length).toBe(1)
    expect(marker[0]?.length).toBe(1)
    // 950/1000*20 = 19 -> last cell
    expect(runs[runs.length - 1]?.isMarker).toBe(true)
  })

  test('threshold at the window end stays inside the bar', () => {
    const runs = layoutBar([{ key: 'free', tokens: 1000 }], 1000, 1000, 10)
    expect(sum(runs)).toBe(10)
    expect(runs[runs.length - 1]?.isMarker).toBe(true)
  })

  test('largest remainder keeps total at width', () => {
    const runs = layoutBar(
      [{ key: 'a', tokens: 1 }, { key: 'b', tokens: 1 }, { key: 'c', tokens: 1 }],
      3, null, 10,
    )
    expect(sum(runs)).toBe(10)
  })

  test('rejects bad inputs', () => {
    expect(() => layoutBar([], 0, null, 10)).toThrow()
    expect(() => layoutBar([], 100, null, 0)).toThrow()
  })

  test('overflow: parts above the window are scaled to the parts total', () => {
    const parts = [{ key: 'system', tokens: 300 }, { key: 'messages', tokens: 300 }]
    let runs: ReturnType<typeof layoutBar> = []
    expect(() => { runs = layoutBar(parts, 400, null, 20) }).not.toThrow()
    expect(sum(runs)).toBe(20)
    expect(runs.map(r => r.key)).toEqual(['system', 'messages'])
    expect(runs.map(r => r.length)).toEqual([10, 10])
  })

  test('overflow: threshold marker uses the parts total as denominator', () => {
    const parts = [{ key: 'system', tokens: 300 }, { key: 'messages', tokens: 300 }]
    let runs: ReturnType<typeof layoutBar> = []
    expect(() => { runs = layoutBar(parts, 400, 150, 20) }).not.toThrow()
    expect(sum(runs)).toBe(20)
    // floor(150/600*20) = 5
    const cells = runs.flatMap(r => Array.from({ length: r.length }, () => r.isMarker))
    expect(cells.indexOf(true)).toBe(5)
    expect(runs.filter(r => r.isMarker).length).toBe(1)
    expect(runs.some(r => r.key === 'gap')).toBe(false)
  })

  test('total equal to the window still works', () => {
    const runs = layoutBar(
      [{ key: 'system', tokens: 200 }, { key: 'messages', tokens: 200 }],
      400, null, 20,
    )
    expect(sum(runs)).toBe(20)
    expect(runs.map(r => r.length)).toEqual([10, 10])
  })

  test('overflow does not relax the other throws', () => {
    const parts = [{ key: 'system', tokens: 300 }, { key: 'messages', tokens: 300 }]
    expect(() => layoutBar(parts, 0, null, 20)).toThrow()
    expect(() => layoutBar(parts, 400, null, 0)).toThrow()
    expect(() => layoutBar(parts, 400, null, 2.5)).toThrow()
  })
  test('v0.5 prefix marker at the static-prefix boundary; compaction marker wins a shared cell', () => {
    const parts = [{ key: 'system', tokens: 25 }, { key: 'reads', tokens: 25 }, { key: 'free', tokens: 50 }]
    const runs = layoutBar(parts, 100, 80, 20, 25)
    const cells = runs.flatMap(x => Array(x.length).fill(x.key))
    expect(cells.length).toBe(20)
    expect(cells[5]).toBe('prefixMarker')
    expect(cells[16]).toBe('marker')
    expect(cells.filter(k => k === 'prefixMarker').length).toBe(1)
    const same = layoutBar(parts, 100, 25, 20, 25).flatMap(x => Array(x.length).fill(x.key))
    expect(same[5]).toBe('marker')
    expect(same).not.toContain('prefixMarker')
  })
  test('v0.5 no prefix marker without prefixTokens or with 0', () => {
    const parts = [{ key: 'system', tokens: 25 }, { key: 'free', tokens: 75 }]
    expect(layoutBar(parts, 100, null, 20)).toEqual(layoutBar(parts, 100, null, 20, 0))
    expect(layoutBar(parts, 100, null, 20).map(x => x.key)).not.toContain('prefixMarker')
  })
  test('v0.5.1 prefix marker sits right after the last static cell, even when rounding moves cells', () => {
    const statics = [['tools', 18200], ['memory', 9800], ['system', 4300], ['skills', 3100], ['mcp', 2100], ['agents', 83]] as const
    const parts = [...statics.map(([key, tokens]) => ({ key, tokens })), { key: 'toolOut', tokens: 190000 }, { key: 'reads', tokens: 96000 }, { key: 'free', tokens: 397417 }, { key: 'buffer', tokens: 138000 }]
    const prefix = statics.reduce((n, [, t]) => n + t, 0)
    for (const width of [80, 120, 240]) {
      const cells = layoutBar(parts, 1_000_000, 862_000, width, prefix).flatMap(x => Array(x.length).fill(x.key))
      const at = cells.indexOf('prefixMarker')
      const staticKeys = new Set(statics.map(([k]) => k))
      expect(at).toBeGreaterThan(0)
      expect(cells.slice(0, at).every(k => staticKeys.has(k))).toBe(true)
      expect(cells.slice(at + 1).some(k => staticKeys.has(k))).toBe(false)
    }
  })
})
