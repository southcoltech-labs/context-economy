// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'claude-code/testing'
import { DEFAULT_LABEL_LEVEL, LABEL_LEVELS, groupRows, orderRows, parseLabelLevel } from './levels'
import { STATIC_KEYS } from './config'

const W = 1000
const r = (key: string, label: string, tokens: number) => ({ key, label, tokens, percent: Math.round(tokens / W * 1000) / 10 })
const ROWS = [
  r('system', 'System', 40), r('tools', 'Tool defs', 100), r('mcp', 'MCP', 11), r('agents', 'Agent defs', 1), r('memory', 'AGENTS.md', 50), r('skills', 'Skills', 30),
  r('prompt', 'User prompt', 20), r('reply', 'Replies', 33), r('toolIn', 'Tool in', 70), r('toolOut', 'Tool out', 90), r('reads', 'Reads', 80),
  r('other', 'Other', 5), r('free', 'Free', 300), r('buffer', 'Buffer', 170),
]
const keys = (rows: readonly { key: string }[]) => rows.map(x => x.key)
const total = (rows: readonly { tokens: number }[]) => rows.reduce((n, x) => n + x.tokens, 0)

describe('label levels', () => {
  test('levels, default and parsing', () => {
    expect(LABEL_LEVELS).toEqual(['min', 'norm', 'max'])
    expect(DEFAULT_LABEL_LEVEL).toBe('norm')
    expect(STATIC_KEYS).toEqual(['system', 'tools', 'mcp', 'agents', 'memory', 'skills'])
    expect(parseLabelLevel(undefined)).toBe('norm')
    for (const l of ['min', 'norm', 'max'] as const) expect(parseLabelLevel(l)).toBe(l)
    for (const bad of ['', 'MAX', 'full', 3, null]) expect(() => parseLabelLevel(bad)).toThrow(/min, norm or max/)
  })
  test('max keeps every row unchanged', () => {
    expect(groupRows(ROWS, 'max', W)).toEqual(ROWS)
  })
  test('norm merges the static prefix into one first row', () => {
    const g = groupRows(ROWS, 'norm', W)
    expect(keys(g)).toEqual(['static', 'prompt', 'reply', 'toolIn', 'toolOut', 'reads', 'other', 'free', 'buffer'])
    expect(g[0]).toEqual({ key: 'static', label: 'Static prefix', tokens: 232, percent: 23.2 })
    expect(total(g)).toBe(total(ROWS))
  })
  test('min merges static, chat and tools', () => {
    const g = groupRows(ROWS, 'min', W)
    expect(keys(g)).toEqual(['static', 'chat', 'tool', 'reads', 'other', 'free', 'buffer'])
    expect(g.find(x => x.key === 'chat')).toEqual({ key: 'chat', label: 'Chat', tokens: 53, percent: 5.3 })
    expect(g.find(x => x.key === 'tool')).toEqual({ key: 'tool', label: 'Tools', tokens: 160, percent: 16 })
    expect(total(g)).toBe(total(ROWS))
  })
  test('a merged row appears only when a member exists; messages row passes through', () => {
    const codex = [r('system', 'System', 50), r('messages', 'Messages', 400), r('free', 'Free', 550)]
    expect(keys(groupRows(codex, 'min', W))).toEqual(['static', 'messages', 'free'])
    const noStatic = [r('prompt', 'User prompt', 10), r('free', 'Free', 990)]
    expect(keys(groupRows(noStatic, 'norm', W))).toEqual(['prompt', 'free'])
    expect(keys(groupRows(noStatic, 'min', W))).toEqual(['chat', 'free'])
  })
  test('does not mutate input', () => {
    const copy = JSON.parse(JSON.stringify(ROWS))
    groupRows(ROWS, 'min', W)
    expect(ROWS).toEqual(copy)
  })
})

describe('v0.5.1 orderRows: static, conversation, tail', () => {
  test('three zones, each sorted by tokens, biggest first; free then buffer last', () => {
    expect(keys(orderRows(ROWS))).toEqual([
      'tools', 'memory', 'system', 'skills', 'mcp', 'agents',
      'toolOut', 'reads', 'toolIn', 'reply', 'prompt', 'other',
      'free', 'buffer',
    ])
  })
  test('the tail stays free then buffer even when Buffer is the bigger of the two', () => {
    const rows = [r('buffer', 'Buffer', 900), r('free', 'Free', 10), r('prompt', 'User prompt', 1), r('system', 'System', 2)]
    expect(keys(orderRows(rows))).toEqual(['system', 'prompt', 'free', 'buffer'])
  })
  test('zone beats size: a small static row precedes a large conversation row', () => {
    const rows = [r('reads', 'Reads', 900), r('system', 'System', 1), r('free', 'Free', 5000)]
    expect(keys(orderRows(rows))).toEqual(['system', 'reads', 'free'])
  })
  test('the merged static row belongs to the static zone', () => {
    const rows = [r('reads', 'Reads', 900), r('static', 'Static prefix', 3), r('free', 'Free', 5)]
    expect(keys(orderRows(rows))).toEqual(['static', 'reads', 'free'])
  })
  test('ties fall back to CATEGORY_ORDER, whatever the input order', () => {
    const conv = [r('toolOut', 'Tool out', 10), r('reply', 'Replies', 10), r('reads', 'Reads', 10), r('toolIn', 'Tool in', 10), r('prompt', 'User prompt', 10)]
    expect(keys(orderRows(conv))).toEqual(['prompt', 'reply', 'toolIn', 'toolOut', 'reads'])
    expect(keys(orderRows([...conv].reverse()))).toEqual(['prompt', 'reply', 'toolIn', 'toolOut', 'reads'])
    const stat = [r('skills', 'Skills', 7), r('tools', 'Tool defs', 7), r('system', 'System', 7)]
    expect(keys(orderRows(stat))).toEqual(['system', 'tools', 'skills'])
  })
  test('unknown-to-the-zones keys (messages, other) sit in the conversation zone', () => {
    const rows = [r('other', 'Other', 1), r('messages', 'Messages', 50), r('system', 'System', 5), r('free', 'Free', 9)]
    expect(keys(orderRows(rows))).toEqual(['system', 'messages', 'other', 'free'])
  })
  test('does not mutate the input and keeps the same rows', () => {
    const copy = JSON.parse(JSON.stringify(ROWS))
    const out = orderRows(ROWS)
    expect(ROWS).toEqual(copy)
    expect(out).not.toBe(ROWS)
    expect(out.length).toBe(ROWS.length)
    expect([...out].sort((a, b) => a.key.localeCompare(b.key))).toEqual([...ROWS].sort((a, b) => a.key.localeCompare(b.key)))
    expect(total(out)).toBe(total(ROWS))
  })
  test('empty input gives empty output', () => {
    expect(orderRows([])).toEqual([])
  })
  test('works after groupRows at norm', () => {
    expect(keys(orderRows(groupRows(ROWS, 'norm', W)))).toEqual(['static', 'toolOut', 'reads', 'toolIn', 'reply', 'prompt', 'other', 'free', 'buffer'])
  })
  test('works after groupRows at min', () => {
    expect(keys(orderRows(groupRows(ROWS, 'min', W)))).toEqual(['static', 'tool', 'reads', 'chat', 'other', 'free', 'buffer'])
  })
  test('works after groupRows at max', () => {
    expect(keys(orderRows(groupRows(ROWS, 'max', W)))).toEqual(keys(orderRows(ROWS)))
  })
})
