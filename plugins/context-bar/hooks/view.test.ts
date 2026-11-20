// SPDX-License-Identifier: Apache-2.0

import type { SessionContextBreakdown } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { buildView, summaryText } from './view'

type Row = { name: string; tokens: number; kind: 'used' | 'free' | 'buffer' | 'deferred' }

const make = (rows: Row[], extra: Partial<SessionContextBreakdown> = {}) =>
  ({
    categories: rows.map(r => ({ ...r, color: 'x', isDeferred: r.kind === 'deferred' })),
    totalTokens: 212000,
    maxTokens: 1000000,
    rawMaxTokens: 1000000,
    percentage: 21,
    isAutoCompactEnabled: true,
    autoCompactThreshold: 950000,
    ...extra,
  }) as unknown as SessionContextBreakdown

const OFF = { isAutoCompactEnabled: false, autoCompactThreshold: undefined }

const rows: Row[] = [
  { name: 'System prompt', tokens: 8000, kind: 'used' },
  { name: 'System tools', tokens: 12000, kind: 'used' },
  { name: 'MCP tools', tokens: 0, kind: 'used' },
  { name: 'Messages', tokens: 192000, kind: 'used' },
  { name: 'Free space', tokens: 738000, kind: 'free' },
  { name: 'Autocompact buffer', tokens: 50000, kind: 'buffer' },
  { name: 'MCP tools (deferred)', tokens: 9999, kind: 'deferred' },
]

describe('buildView', () => {
  test('orders rows, keeps buffer, drops deferred', () => {
    const v = buildView(make(rows))
    // v0.4: Messages is always split into five rows
    expect(v.rows.map(r => r.key)).toEqual(['system', 'tools', 'mcp', 'prompt', 'reply', 'toolIn', 'toolOut', 'reads', 'free', 'buffer'])
  })

  test('v0.4 split rows carry the new labels', () => {
    const v = buildView(make(rows), [{ kind: 'text', role: 'user', chars: 10 }] as never)
    expect(v.rows.filter(r => ['prompt', 'reply', 'toolIn', 'toolOut', 'reads'].includes(r.key)).map(r => r.label))
      .toEqual(['User prompt', 'Replies', 'Tool in', 'Tool out', 'Reads'])
  })

  test('v0.4 a Bash "cd /x && sed -n 1,5p f" result counts as reads', () => {
    const v = buildView(make(rows), [{ kind: 'result', chars: 4000, tool: 'Bash', command: 'cd /x && sed -n 1,5p f' }] as never)
    expect(v.rows.find(r => r.key === 'reads')?.tokens).toBe(192000)
    expect(v.rows.find(r => r.key === 'toolOut')?.tokens).toBe(0)
  })

  test('v0.4 memory and agents rows use the new labels', () => {
    const v = buildView(make([...rows, { name: 'Memory files', tokens: 10, kind: 'used' }, { name: 'Custom agents', tokens: 10, kind: 'used' }]))
    expect(v.rows.find(r => r.key === 'memory')?.label).toBe('AGENTS.md')
    expect(v.rows.find(r => r.key === 'agents')?.label).toBe('Agent defs')
  })

  test('percent of window per row', () => {
    const v = buildView(make(rows))
    expect(v.rows.find(r => r.key === 'tools')?.percent).toBe(1.2)
  })

  test('reads numbers straight from the breakdown', () => {
    const v = buildView(make(rows))
    expect(v.usedTokens).toBe(212000)
    expect(v.windowTokens).toBe(1000000)
    expect(v.percent).toBe(21)
    expect(v.thresholdTokens).toBe(950000)
  })

  test('unknown used rows are merged into other', () => {
    const v = buildView(make([
      ...rows,
      { name: 'Slash commands', tokens: 100, kind: 'used' },
      { name: 'Plugins', tokens: 50, kind: 'used' },
    ]))
    const other = v.rows.find(r => r.key === 'other')
    expect(other?.tokens).toBe(150)
  })

  test('autocompact off gives no threshold', () => {
    const v = buildView(make(rows, OFF))
    expect(v.thresholdTokens).toBe(null)
    expect(v.isAutoCompactEnabled).toBe(false)
  })

  test('enabled but threshold missing throws', () => {
    expect(() => buildView(make(rows, { autoCompactThreshold: undefined }))).toThrow()
  })

  test('zero window throws', () => {
    expect(() => buildView(make(rows, { rawMaxTokens: 0 }))).toThrow()
  })
})

describe('summaryText', () => {
  test('used of window, compacts at', () => {
    expect(summaryText({ ...buildView(make(rows)), compactionText: '' })).toBe('212k of 1M · compacts at 950k')
  })
  test('autocompact off', () => {
    const v = buildView(make(rows, OFF))
    expect(summaryText({ ...v, compactionText: '' })).toBe('212k of 1M · autocompact off')
  })
})
