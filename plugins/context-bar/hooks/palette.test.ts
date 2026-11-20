// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'claude-code/testing'
import { CATEGORY_ORDER } from './config'
import type { CategoryKey } from './config'
import { DEFAULT_THEME_SETTING, PALETTES, THEMES, THEME_SETTINGS, UNKNOWN_HOST_THEME, paletteFor, paletteFromConfig, parseColors, resolveTheme, themeFromColorFgBg } from './palettes'
import type { Palette, Theme } from './palettes'

// v0.7 colour rules (user, 2026-10-29), one palette per terminal background:
// hue = what the conversation talks to: red = tools, green = human, blue = files (reads and writes).
// darker = output (the model writes it), lighter = input/read.
// Static prefix parts are not interactions: other hues (yellow, brown, orange, purple, teal) or muted tones.
// Free and Buffer are pale: not occupied.
const rgb = (hex: string): [number, number, number] => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number]
const hsl = (hex: string): { h: number; s: number; l: number } => {
  const [r, g, b] = rgb(hex)
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min
  if (d === 0) return { h: 0, s: 0, l }
  const s = d / (1 - Math.abs(2 * l - 1))
  const h = max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4)
  return { h: (h + 360) % 360, s, l }
}
const lin = (c: number) => (c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92)
const luminance = (hex: string) => { const [r, g, b] = rgb(hex).map(lin) as [number, number, number]; return 0.2126 * r + 0.7152 * g + 0.0722 * b }
const contrast = (a: string, b: string) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => p - q) as [number, number]; return (y + 0.05) / (x + 0.05) }
const isRed = (h: number) => h >= 345 || h <= 20
const isGreen = (h: number) => h >= 90 && h <= 150
const isBlue = (h: number) => h >= 190 && h <= 240

const RED: CategoryKey[] = ['tool', 'toolIn', 'toolOut']
const GREEN: CategoryKey[] = ['chat', 'prompt', 'reply']
const BLUE: CategoryKey[] = ['writes', 'reads']
const STATIC_PARTS: CategoryKey[] = ['static', 'system', 'tools', 'mcp', 'agents', 'memory', 'skills']
const NEUTRAL: CategoryKey[] = ['messages', 'other']
const EMPTY: CategoryKey[] = ['free', 'buffer']
const DATA = CATEGORY_ORDER.filter(k => !EMPTY.includes(k))
const MAX_LEVEL: CategoryKey[] = ['system', 'tools', 'mcp', 'agents', 'memory', 'skills', 'messages', 'prompt', 'reply', 'toolIn', 'toolOut', 'writes', 'reads', 'other', 'free', 'buffer']
const MUTED_SATURATION = 0.2
/** Per background: data lightness band, Free/Buffer lightness band, data contrast against the background. */
const RULES: Record<Theme, { background: string; data: [number, number]; empty: [number, number]; minContrast: number }> = {
  dark: { background: '#1e1e1e', data: [0.3, 0.72], empty: [0.8, 1], minContrast: 2 },
  light: { background: '#ffffff', data: [0.2, 0.6], empty: [0.8, 0.93], minContrast: 2.5 },
}

describe('v0.7 palettes', () => {
  test('two themes, dark and light, each colouring every category with #rrggbb', () => {
    expect([...THEMES]).toEqual(['dark', 'light'])
    for (const theme of THEMES) {
      expect(Object.keys(PALETTES[theme]).sort()).toEqual([...CATEGORY_ORDER].sort())
      for (const k of CATEGORY_ORDER) expect(PALETTES[theme][k]).toMatch(/^#[0-9a-f]{6}$/i)
    }
  })
  for (const theme of THEMES) {
    const P: Palette = PALETTES[theme]
    const L = (k: CategoryKey) => hsl(P[k]).l
    describe(theme, () => {
      test('red = tool calls and results; green = human; blue = file writes and reads', () => {
        for (const k of RED) expect(isRed(hsl(P[k]).h)).toBe(true)
        for (const k of GREEN) expect(isGreen(hsl(P[k]).h)).toBe(true)
        for (const k of BLUE) expect(isBlue(hsl(P[k]).h)).toBe(true)
      })
      test('output is darker than input; the group colour sits between', () => {
        expect(L('toolIn')).toBeLessThan(L('tool'))
        expect(L('tool')).toBeLessThan(L('toolOut'))
        expect(L('reply')).toBeLessThan(L('chat'))
        expect(L('chat')).toBeLessThan(L('prompt'))
        expect(L('writes')).toBeLessThan(L('reads'))
      })
      test('static prefix parts stay out of the channel hues (muted tones allowed)', () => {
        for (const k of STATIC_PARTS) {
          const { h, s } = hsl(P[k])
          if (s <= MUTED_SATURATION) continue
          expect(isRed(h) || isGreen(h) || isBlue(h)).toBe(false)
        }
      })
      test('messages and other are neutral', () => {
        for (const k of NEUTRAL) expect(hsl(P[k]).s).toBeLessThanOrEqual(MUTED_SATURATION)
      })
      test('Free and Buffer are pale; data colours sit in the readable band for this background', () => {
        const r = RULES[theme]
        for (const k of EMPTY) { expect(L(k)).toBeGreaterThanOrEqual(r.empty[0]); expect(L(k)).toBeLessThanOrEqual(r.empty[1]) }
        for (const k of DATA) {
          expect(L(k)).toBeGreaterThanOrEqual(r.data[0])
          expect(L(k)).toBeLessThanOrEqual(r.data[1])
          expect(contrast(P[k], r.background)).toBeGreaterThanOrEqual(r.minContrast)
        }
        expect(hsl(P.free).s).toBeLessThanOrEqual(0.1)
      })
      test('every row shown together at the max level has its own colour', () => {
        const colours = MAX_LEVEL.map(k => P[k].toLowerCase())
        expect(new Set(colours).size).toBe(colours.length)
      })
    })
  }
})

describe('v0.7 theme choice', () => {
  test('settings: auto, dark, light; default auto', () => {
    expect([...THEME_SETTINGS]).toEqual(['auto', 'dark', 'light'])
    expect(DEFAULT_THEME_SETTING).toBe('auto')
  })
  test('dark and light win over the host theme', () => {
    expect(resolveTheme('dark', 'light')).toBe('dark')
    expect(resolveTheme('light', 'dark')).toBe('light')
  })
  test('auto follows the host theme family (Claude Code theme names)', () => {
    for (const host of ['light', 'light-daltonized', 'light-ansi']) expect(resolveTheme('auto', host)).toBe('light')
    for (const host of ['dark', 'dark-daltonized', 'dark-ansi']) expect(resolveTheme('auto', host)).toBe('dark')
  })
  test('auto with an unknown host theme uses the documented default', () => {
    expect(UNKNOWN_HOST_THEME).toBe('dark')
    for (const host of [undefined, 'auto', 'solarized']) expect(resolveTheme('auto', host)).toBe(UNKNOWN_HOST_THEME)
  })
  test('a bad setting throws and names the choices', () => {
    for (const bad of ['Dark', 'blue', '', 3, null]) expect(() => resolveTheme(bad, 'dark')).toThrow(/theme.*auto, dark or light/)
  })
  test('COLORFGBG: background 0-6 or 8 is dark, 7 or 9-15 is light, else unknown', () => {
    for (const v of ['15;0', '7;default;0', '15;8']) expect(themeFromColorFgBg(v)).toBe('dark')
    for (const v of ['0;15', '0;7', '0;default;11']) expect(themeFromColorFgBg(v)).toBe('light')
    for (const v of [undefined, '', 'x', '15;default', '0;16']) expect(themeFromColorFgBg(v)).toBeUndefined()
  })
})

describe('v0.7 colour overrides', () => {
  test('empty input means no overrides', () => {
    for (const raw of [undefined, '', {}]) expect(parseColors(raw)).toEqual({})
  })
  test('per-theme overrides from an object or a JSON string', () => {
    const want = { dark: { reads: '#123456' }, light: { free: '#ABCDEF' } }
    expect(parseColors(want)).toEqual(want)
    expect(parseColors(JSON.stringify(want))).toEqual(want)
  })
  test('bad input throws and names the problem', () => {
    expect(() => parseColors('{nope')).toThrow(/colors.*JSON/)
    expect(() => parseColors([])).toThrow(/colors/)
    expect(() => parseColors({ blue: {} })).toThrow(/colors.*blue.*dark or light/)
    expect(() => parseColors({ dark: { nope: '#000000' } })).toThrow(/colors\.dark.*nope/)
    expect(() => parseColors({ dark: { reads: 'blue' } })).toThrow(/colors\.dark\.reads.*#rrggbb/)
    expect(() => parseColors({ dark: 'x' })).toThrow(/colors\.dark/)
  })
  test('paletteFor applies only the chosen theme\'s overrides and keeps the rest', () => {
    const colors = parseColors({ dark: { reads: '#123456' }, light: { reads: '#654321' } })
    const dark = paletteFor('dark', colors)
    expect(dark.reads).toBe('#123456')
    expect(dark.writes).toBe(PALETTES.dark.writes)
    expect(paletteFor('light', colors).reads).toBe('#654321')
    expect(paletteFor('light', {})).toEqual(PALETTES.light)
    expect(PALETTES.dark.reads).not.toBe('#123456')
  })
  test('paletteFromConfig (Pi, Codex): theme and colors fields of config.json plus COLORFGBG', () => {
    expect(paletteFromConfig({}, undefined)).toEqual(PALETTES[UNKNOWN_HOST_THEME])
    expect(paletteFromConfig({}, '0;15')).toEqual(PALETTES.light)
    expect(paletteFromConfig({ theme: 'dark' }, '0;15')).toEqual(PALETTES.dark)
    expect(paletteFromConfig({ theme: 'light', colors: { light: { reads: '#111111' } } }, undefined).reads).toBe('#111111')
    expect(() => paletteFromConfig({ theme: 'sepia' }, undefined)).toThrow(/theme/)
    expect(() => paletteFromConfig({ colors: { dark: { reads: 'x' } } }, undefined)).toThrow(/colors/)
  })
})
