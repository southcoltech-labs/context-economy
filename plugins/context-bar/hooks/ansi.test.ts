// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'claude-code/testing'
import { renderLines } from './ansi'
import { PALETTES } from './palettes'
import type { CategoryKey } from './config'

const rgbOf = (key: CategoryKey): string => [1, 3, 5].map(i => parseInt(PALETTES.dark[key].slice(i, i + 2), 16)).join(';')
import type { ContextView } from '../types'

const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '')
const view: ContextView = {
  compactionText: '',
  usedTokens: 20000, windowTokens: 100000, percent: 20, thresholdTokens: 80000, isAutoCompactEnabled: true,
  rows: [
    { key: 'system', label: 'System', tokens: 5000, percent: 5 },
    { key: 'messages', label: 'Messages', tokens: 15000, percent: 15 },
    { key: 'free', label: 'Free', tokens: 60000, percent: 60 },
    { key: 'buffer', label: 'Buffer', tokens: 20000, percent: 20 },
  ],
}

describe('renderLines', () => {
  test('header, exact-width bar with marker, and legend', () => {
    const lines = renderLines(view, null, 100, 'distribution est.', 'max', PALETTES.dark).map(plain)
    expect(lines[0]).toStartWith('◆ context')
    expect(lines[0]).toContain('20k of 100k · compacts at 80k')
    expect(lines[0]).toContain('20.0%')
    expect(lines.at(-1)).toBe('distribution est.')
    expect(lines[1]!.length).toBe(100)
    expect(lines[1]![80]).toBe('│')
    expect(lines.slice(2).join('\n')).toContain('Messages')
  })
  test('the compaction text shares the footer line, note on the left and compaction on the right, filling the width', () => {
    const lines = renderLines(view, null, 100, 'distribution est.', 'max', PALETTES.dark, 'compacted 2× · 48m ago · 207k→22.2k').map(plain)
    const footer = lines.at(-1)!
    expect(footer).toStartWith('distribution est.')
    expect(footer).toEndWith('compacted 2× · 48m ago · 207k→22.2k')
    expect(footer.length).toBe(100)
    expect(lines.filter(l => l.includes('compacted'))).toHaveLength(1)
  })
  test('the compaction text is hidden when it would not fit beside the note', () => {
    const lines = renderLines(view, null, 50, 'distribution est.', 'max', PALETTES.dark, 'compacted 2× · 48m ago · 207k→22.2k').map(plain)
    expect(lines.at(-1)).toBe('distribution est.')
    expect(lines.join('\n')).not.toContain('compacted')
  })
  test('empty note adds no footer line and no leading separator', () => {
    expect(plain(renderLines({ ...view, rows: view.rows.slice(1) }, null, 100, '', 'max', PALETTES.dark)[0]!)).not.toContain(' · ')
  })
  test('no line exceeds width at narrow, medium, or wide sizes', () => {
    for (const width of [20, 60, 120]) {
      for (const line of renderLines(view, null, width, 'distribution est.', 'max', PALETTES.dark)) expect(plain(line).length).toBeLessThanOrEqual(width)
    }
  })
  test('no view includes n/a and optional error', () => {
    expect(plain(renderLines(null, null, 40, '', 'max', PALETTES.dark)[0]!)).toContain('n/a')
    expect(plain(renderLines(null, 'boom', 40, '', 'max', PALETTES.dark)[0]!)).toContain('n/a (boom)')
  })
  test('colours use 24-bit ANSI', () => {
    expect(renderLines(view, null, 100, '', 'max', PALETTES.dark)[1]).toContain('\x1b[38;2;')
  })
  test('overflow fills bar without throwing', () => {
    const over: ContextView = { ...view, usedTokens: 190500, percent: 190.5, rows: [{ key: 'system', label: 'System', tokens: 50000, percent: 50 }, { key: 'messages', label: 'Messages', tokens: 140500, percent: 140.5 }] }
    const lines = renderLines(over, null, 80, '', 'max', PALETTES.dark).map(plain)
    expect(lines[1]!.length).toBe(80)
    expect(lines[1]).not.toContain(' ')
  })
  const split: ContextView = { ...view, rows: [...view.rows.slice(0, 1),
    { key: 'prompt', label: 'User prompt', tokens: 3000, percent: 3 }, { key: 'reply', label: 'Replies', tokens: 3000, percent: 3 },
    { key: 'toolIn', label: 'Tool in', tokens: 3000, percent: 3 }, { key: 'toolOut', label: 'Tool out', tokens: 4000, percent: 4 },
    { key: 'reads', label: 'Reads', tokens: 2000, percent: 2 }, ...view.rows.slice(2)] }
  test('v0.4: renders split row labels; no Chat', () => {
    const text = renderLines(split, null, 120, 'distribution est.', 'max', PALETTES.dark).map(plain).join('\n')
    for (const label of ['User prompt', 'Replies', 'Tool in', 'Tool out', 'Reads']) expect(text).toContain(label)
    expect(text).not.toContain('Chat')
  })
  test('v0.4: wide band fits the legend in at most 2 lines, Buffer included', () => {
    const lines = renderLines(split, null, 240, '', 'max', PALETTES.dark).map(plain)
    expect(lines.length).toBeLessThanOrEqual(4)
    expect(lines.slice(2).join('\n')).toContain('Buffer')
    expect(renderLines(split, null, 240, '', 'max', PALETTES.dark)[1]).toContain(`\x1b[38;2;${rgbOf('buffer')}m`)
  })
  const full: ContextView = { ...view, rows: [{ key: 'system', label: 'System', tokens: 3000, percent: 3 }, { key: 'tools', label: 'Tool defs', tokens: 2000, percent: 2 }, ...split.rows.slice(1)] }
  test('v0.5 levels: norm shows Static prefix, max shows the parts, min shows Chat and Tools', () => {
    const text = (level: 'min' | 'norm' | 'max') => renderLines(full, null, 200, '', level, PALETTES.dark).map(plain).slice(2).join('\n')
    expect(text('norm')).toContain('Static prefix')
    expect(text('norm')).not.toContain('Tool defs')
    expect(text('max')).toContain('Tool defs')
    expect(text('max')).not.toContain('Static prefix')
    for (const l of ['Static prefix', 'Chat', 'Tools', 'Reads', 'Free', 'Buffer']) expect(text('min')).toContain(l)
    for (const l of ['User prompt', 'Tool in', 'Tool out']) expect(text('min')).not.toContain(l)
  })
  test('v0.5 prefix marker ┃ in the bar and "prefix 5k" in the header, at every level', () => {
    for (const level of ['min', 'norm', 'max'] as const) {
      const lines = renderLines(full, null, 100, '', level, PALETTES.dark).map(plain)
      expect(lines[1]).toContain('┃')
      expect(lines[1]![5]).toBe('┃')
      expect(lines[1]![80]).toBe('│')
      expect(lines[0]).toContain('prefix 5k · ')
    }
  })
  test('v0.5 no static rows: no prefix marker, no prefix text', () => {
    const lines = renderLines({ ...view, rows: view.rows.slice(1) }, null, 100, '', 'norm', PALETTES.dark).map(plain)
    expect(lines[1]).not.toContain('┃')
    expect(lines[0]).not.toContain('prefix ')
  })

  // v0.5.1: legend and bar follow size order inside three zones
  const scrambled: ContextView = { ...view, windowTokens: 100000, rows: [
    { key: 'reads', label: 'Reads', tokens: 2000, percent: 2 },
    { key: 'buffer', label: 'Buffer', tokens: 20000, percent: 20 },
    { key: 'tools', label: 'Tool defs', tokens: 2000, percent: 2 },
    { key: 'reply', label: 'Replies', tokens: 3000, percent: 3 },
    { key: 'free', label: 'Free', tokens: 10000, percent: 10 },
    { key: 'system', label: 'System', tokens: 3000, percent: 3 },
    { key: 'toolOut', label: 'Tool out', tokens: 4000, percent: 4 },
    { key: 'prompt', label: 'User prompt', tokens: 3000, percent: 3 },
  ] }
  const order = (text: string, labels: string[]): string[] =>
    labels.map(l => ({ l, at: text.indexOf(l) })).sort((a, b) => a.at - b.at).map(x => x.l)
  test('v0.5.1 legend order = size order inside the zones; Free then Buffer last', () => {
    const legend = renderLines(scrambled, null, 300, '', 'max', PALETTES.dark).map(plain).slice(2).join('\n')
    const labels = ['System', 'Tool defs', 'Tool out', 'User prompt', 'Replies', 'Reads', 'Free', 'Buffer']
    for (const l of labels) expect(legend).toContain(l)
    expect(order(legend, labels)).toEqual(labels)
  })
  test('v0.5.1 legend order also holds in a narrow, wrapped legend', () => {
    const legend = renderLines(scrambled, null, 40, '', 'max', PALETTES.dark).map(plain).slice(2).join('\n')
    const labels = ['System', 'Tool defs', 'Tool out', 'User prompt', 'Replies', 'Reads', 'Free', 'Buffer']
    expect(order(legend, labels)).toEqual(labels)
  })
  test('v0.5.1 Buffer last even when it is bigger than Free (norm level)', () => {
    const legend = renderLines(scrambled, null, 300, '', 'norm', PALETTES.dark).map(plain).slice(2).join('\n')
    expect(order(legend, ['Static prefix', 'Tool out', 'Reads', 'Free', 'Buffer'])).toEqual(['Static prefix', 'Tool out', 'Reads', 'Free', 'Buffer'])
  })
  test('v0.5.1 the bar stacks segments in the same size order', () => {
    const bar = renderLines(scrambled, null, 100, '', 'max', PALETTES.dark)[1]!
    const colours = (['system', 'tools', 'toolOut', 'prompt', 'reply', 'reads'] as const).map(k => PALETTES.dark[k])
      .map(hex => `\x1b[38;2;${parseInt(hex.slice(1, 3), 16)};${parseInt(hex.slice(3, 5), 16)};${parseInt(hex.slice(5, 7), 16)}m`)
    const at = colours.map(c => bar.indexOf(c))
    for (const i of at) expect(i).toBeGreaterThanOrEqual(0)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
  })
  test('v0.5.1 the ┃ marker still sits right after the static zone, whatever the input order', () => {
    for (const level of ['min', 'norm', 'max'] as const) {
      const lines = renderLines(scrambled, null, 100, '', level, PALETTES.dark).map(plain)
      expect(lines[1]![5]).toBe('┃') // 3k + 2k static tokens of 100k over 100 columns
      expect(lines[0]).toContain('prefix 5k · ')
    }
  })
  /** One entry per bar cell: its glyph and its 24-bit colour ('' when none). */
  const cells = (line: string): { ch: string; rgb: string }[] => {
    const out: { ch: string; rgb: string }[] = []
    let rgb = ''
    for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
      const m = /^\x1b\[([0-9;]*)m$/.exec(part)
      if (m) { const c = /38;2;(\d+;\d+;\d+)/.exec(m[1] ?? ''); if (c) rgb = c[1]!; else if (m[1] === '0' || m[1] === '') rgb = ''; continue }
      for (const ch of part) out.push({ ch, rgb })
    }
    return out
  }
  // v0.5.2 S5 pattern convention: solid = static, dotted = changing, light = not occupied
  const EMPTY_RGB = new Set([rgbOf('free'), rgbOf('buffer')])
  test('v0.5.2 S5 static zone is solid █ in each row colour (max), conversation is dotted ▓', () => {
    const bar = cells(renderLines(full, null, 100, '', 'max', PALETTES.dark)[1]!)
    expect(bar.slice(0, 3).map(c => c.ch).join('')).toBe('███')
    expect(new Set(bar.slice(0, 3).map(c => c.rgb))).toEqual(new Set([rgbOf('system')]))
    expect(bar.slice(3, 5).map(c => c.ch).join('')).toBe('██')
    expect(new Set(bar.slice(3, 5).map(c => c.rgb))).toEqual(new Set([rgbOf('tools')]))
    expect(bar[5]!.ch).toBe('┃')
    expect(bar.slice(6, 20).every(c => c.ch === '▓')).toBe(true)
    expect(bar.slice(6).filter(c => c.ch === '█')).toEqual([])
  })
  test('v0.5.2 S5 Free and Buffer are light ░ in their own colours, never solid or dotted', () => {
    const bar = cells(renderLines(full, null, 100, '', 'max', PALETTES.dark)[1]!)
    const empty = bar.filter(c => EMPTY_RGB.has(c.rgb))
    expect(empty.length).toBeGreaterThanOrEqual(70)
    expect(empty.every(c => c.ch === '░')).toBe(true)
    expect(new Set(empty.map(c => c.rgb))).toEqual(EMPTY_RGB)
    expect(bar.filter(c => c.ch === '░').every(c => EMPTY_RGB.has(c.rgb))).toBe(true)
  })
  test('v0.5.2 S5 norm and min: Static prefix row solid █ in its colour, nothing else solid', () => {
    for (const level of ['norm', 'min'] as const) {
      const bar = cells(renderLines(full, null, 100, '', level, PALETTES.dark)[1]!)
      expect(bar.slice(0, 5).map(c => c.ch).join('')).toBe('█████')
      expect(new Set(bar.slice(0, 5).map(c => c.rgb))).toEqual(new Set([rgbOf('static')]))
      expect(bar.slice(6).filter(c => c.ch === '█')).toEqual([])
      expect(bar.slice(6).some(c => c.ch === '▓')).toBe(true)
      expect(bar.slice(6).some(c => c.ch === '░')).toBe(true)
    }
  })
  test('v0.5.2 S5 no static rows: no solid █ anywhere', () => {
    const noStatic = { ...view, rows: view.rows.slice(1) }
    expect(plain(renderLines(noStatic, null, 100, '', 'max', PALETTES.dark)[1]!)).not.toContain('█')
  })
})

describe('v0.7 renderLines takes the palette', () => {
  const sgr = (hex: string) => `\x1b[38;2;${[1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(';')}m`
  test('light palette colours the bar and legend; dark colours are absent', () => {
    const out = renderLines(view, null, 100, '', 'max', PALETTES.light).join('\n')
    for (const k of ['system', 'free', 'buffer'] as const) expect(out).toContain(sgr(PALETTES.light[k]))
    expect(out).not.toContain(sgr(PALETTES.dark.free))
  })
  test('an override reaches the bar', () => {
    const out = renderLines(view, null, 100, '', 'max', { ...PALETTES.dark, free: '#123456' }).join('\n')
    expect(out).toContain(sgr('#123456'))
  })
})
