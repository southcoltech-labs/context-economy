// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'claude-code/testing'
import {
  CATEGORY_ORDER, CATEGORY_STYLES, CHARS_PER_TOKEN_OTHER, CHARS_PER_TOKEN_RESULT,
  DEFAULT_REFRESH_EVERY_ROUNDS, FILE_READ_COMMANDS, FILE_READ_TOOLS, NAME_TO_KEY, READ_FILTERS,
} from './config'
import type { CategoryKey } from './config'
import { PALETTES, THEMES } from './palettes'

/** CIE76 colour distance in Lab (sRGB, D65). */
const lab = (hex: string): [number, number, number] => {
  const lin = (c: number) => (c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92)
  const [r, g, b] = [1, 3, 5].map(i => lin(parseInt(hex.slice(i, i + 2), 16) / 255))
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883
  const f = (v: number) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116)
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))]
}
const deltaE = (a: string, b: string) => Math.hypot(...lab(a).map((v, i) => v - lab(b)[i]))
const SPLIT = ['prompt', 'reply', 'toolIn', 'toolOut', 'writes', 'reads'] as const
const MIN_SPLIT_DELTA_E = 28

describe('config v0.4', () => {
  test('order and short labels', () => {
    expect(CATEGORY_ORDER).toEqual(['static', 'system', 'tools', 'mcp', 'agents', 'memory', 'skills', 'messages', 'chat', 'prompt', 'reply', 'tool', 'toolIn', 'toolOut', 'writes', 'reads', 'other', 'free', 'buffer'])
    const labels = Object.fromEntries(CATEGORY_ORDER.filter(k => !['static', 'chat', 'tool'].includes(k)).map(k => [k, CATEGORY_STYLES[k].label]))
    expect(labels).toEqual({ system: 'System', tools: 'Tool defs', mcp: 'MCP', agents: 'Agent defs', memory: 'AGENTS.md', skills: 'Skills', messages: 'Messages', prompt: 'User prompt', reply: 'Replies', toolIn: 'Tool in', toolOut: 'Tool out', writes: 'Writes', reads: 'Reads', other: 'Other', free: 'Free', buffer: 'Buffer' })
    for (const l of Object.values(labels)) expect(l.length).toBeLessThanOrEqual(13)
    expect(Object.values(labels).some(l => /chat/i.test(l))).toBe(false)
  })
  for (const theme of THEMES) test(`v0.5 per level (${theme}): split and merged colours are distinct from every visible colour (ΔE >= 28)`, () => {
    const STATIC = ['system', 'tools', 'mcp', 'agents', 'memory', 'skills'] as const
    const TAIL = ['other', 'free', 'buffer'] as const
    const levels: Record<string, readonly CategoryKey[]> = {
      max: [...STATIC, ...SPLIT, ...TAIL],
      norm: ['static', ...SPLIT, ...TAIL],
      min: ['static', 'chat', 'tool', 'writes', 'reads', ...TAIL],
    }
    const close: string[] = []
    for (const [level, visible] of Object.entries(levels)) for (const a of visible) for (const b of visible) {
      if (a >= b || (!(SPLIT as readonly string[]).includes(a) && !['static', 'chat', 'tool'].includes(a) && !(SPLIT as readonly string[]).includes(b) && !['static', 'chat', 'tool'].includes(b))) continue
      const d = deltaE(PALETTES[theme][a], PALETTES[theme][b])
      if (d < MIN_SPLIT_DELTA_E) close.push(`${level} ${a}/${b} ${d.toFixed(0)}`)
    }
    expect(close).toEqual([])
  })
  test('v0.5 merged labels', () => {
    expect([CATEGORY_STYLES.static.label, CATEGORY_STYLES.chat.label, CATEGORY_STYLES.tool.label]).toEqual(['Static prefix', 'Chat', 'Tools'])
  })
  for (const theme of THEMES) test(`v0.4 message-split colours (${theme}) are distinct from every visible colour (ΔE >= 28)`, () => {
    const visible = CATEGORY_ORDER.filter(k => k !== 'messages' && !['static', 'chat', 'tool'].includes(k))
    const close: string[] = []
    for (const a of SPLIT) for (const b of visible) {
      if (a === b) continue
      const d = deltaE(PALETTES[theme][a], PALETTES[theme][b])
      if (d < MIN_SPLIT_DELTA_E) close.push(`${a}/${b} ${d.toFixed(0)}`)
    }
    expect(close).toEqual([])
  })
  test('v0.4 CX: User prompt is not in the red family (far from Tool out and Tool in)', () => {
    for (const theme of THEMES) for (const k of ['toolOut', 'toolIn'] as const) expect(deltaE(PALETTES[theme].prompt, PALETTES[theme][k])).toBeGreaterThanOrEqual(50)
  })
  test('/context row names still map', () => {
    expect(NAME_TO_KEY['system prompt']).toBe('system')
    expect(NAME_TO_KEY['memory files']).toBe('memory')
    expect(NAME_TO_KEY['custom agents']).toBe('agents')
    expect(NAME_TO_KEY['messages']).toBe('messages')
  })
  test('split and refresh constants', () => {
    expect(FILE_READ_TOOLS).toEqual(['Read', 'NotebookRead', 'read'])
    expect(FILE_READ_COMMANDS).toEqual(['cat', 'head', 'tail', 'sed', 'nl', 'bat', 'less'])
    expect(READ_FILTERS).toEqual(['head', 'tail', 'grep', 'rg', 'cut', 'wc', 'sort', 'uniq', 'nl'])
    expect(CHARS_PER_TOKEN_RESULT).toBe(2.0)
    expect(CHARS_PER_TOKEN_OTHER).toBe(2.5)
    expect(DEFAULT_REFRESH_EVERY_ROUNDS).toBe(5)
  })
})
