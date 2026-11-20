// SPDX-License-Identifier: Apache-2.0

import type { CategoryKey } from './config'

export const THEMES = ['dark', 'light'] as const
export type Theme = typeof THEMES[number]
export type Palette = Record<CategoryKey, string>
export const PALETTES: Record<Theme, Palette> = {
  dark: { static:'#b8860b', system:'#8d6e63', tools:'#e0a526', mcp:'#9c6ade', agents:'#e8833a', memory:'#26a69a', skills:'#d4c04a', messages:'#a0a0a0', other:'#6e6e6e', tool:'#d32f2f', toolIn:'#b71c1c', toolOut:'#e57373', chat:'#43a047', prompt:'#81c784', reply:'#2e7d32', writes:'#1a4fb0', reads:'#00b0ff', free:'#d0d0d0', buffer:'#e0d8f0' },
  light: { static:'#a0782c', system:'#6f5a4e', tools:'#b8860b', mcp:'#9a5fc9', agents:'#e65100', memory:'#00897b', skills:'#9e8a00', messages:'#8a8a8a', other:'#616161', tool:'#c62828', toolIn:'#7f1515', toolOut:'#e05252', chat:'#2e7d32', prompt:'#5aa85f', reply:'#1b5e20', writes:'#0d3c8c', reads:'#3d8fe0', free:'#d4d4d4', buffer:'#dccfee' },
}
export const THEME_SETTINGS = ['auto', 'dark', 'light'] as const
export const DEFAULT_THEME_SETTING = 'auto'
export const UNKNOWN_HOST_THEME: Theme = 'dark'
export const resolveTheme = (setting: unknown, host: string | undefined): Theme => {
  if (!THEME_SETTINGS.includes(setting as typeof THEME_SETTINGS[number])) throw new Error('context-bar: theme must be auto, dark or light')
  if (setting !== 'auto') return setting as Theme
  if (host?.startsWith('light')) return 'light'
  if (host?.startsWith('dark')) return 'dark'
  return UNKNOWN_HOST_THEME
}
type Colors = Partial<Record<Theme, Partial<Palette>>>
export const themeFromColorFgBg = (v: string | undefined): Theme | undefined => {
  const field = v?.split(';').at(-1)
  if (field === undefined || !/^\d+$/.test(field)) return undefined
  const n = Number(field)
  if ((n >= 0 && n <= 6) || n === 8) return 'dark'
  if (n === 7 || (n >= 9 && n <= 15)) return 'light'
  return undefined
}
export const parseColors = (raw: unknown): Colors => {
  if (raw === undefined || raw === '') return {}
  let value: unknown = raw
  if (typeof raw === 'string') { try { value = JSON.parse(raw) } catch { throw new Error('context-bar: colors must be valid JSON') } }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('context-bar: colors must be an object')
  const out: Colors = {}
  for (const [theme, entries] of Object.entries(value)) {
    if (theme !== 'dark' && theme !== 'light') throw new Error(`context-bar: colors theme ${theme} must be dark or light`)
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error(`context-bar: colors.${theme} must be an object`)
    const selected: Partial<Palette> = {}
    for (const [key, color] of Object.entries(entries)) {
      if (!Object.hasOwn(PALETTES.dark, key)) throw new Error(`context-bar: colors.${theme}.${key} is unknown`)
      if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) throw new Error(`context-bar: colors.${theme}.${key} must be #rrggbb`)
      selected[key as CategoryKey] = color
    }
    out[theme] = selected
  }
  return out
}
export const paletteFor = (theme: Theme, colors: Colors): Palette => ({ ...PALETTES[theme], ...colors[theme] })
export const paletteFromConfig = (cfg: { theme?: unknown; colors?: unknown }, colorFgBg: string | undefined): Palette => paletteFor(resolveTheme(cfg.theme ?? DEFAULT_THEME_SETTING, themeFromColorFgBg(colorFgBg)), parseColors(cfg.colors))
