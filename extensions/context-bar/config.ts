// SPDX-License-Identifier: Apache-2.0

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_LABEL_LEVEL, parseLabelLevel } from '../../plugins/context-bar/hooks/levels'
import { paletteFromConfig } from '../../plugins/context-bar/hooks/palettes'
import type { Palette } from '../../plugins/context-bar/hooks/palettes'
import type { LabelLevel } from '../../plugins/context-bar/hooks/levels'
export const WIDGET_KEY = 'context-bar'
export const COMMAND = 'context-bar'
export const COMMAND_DESCRIPTION = 'Toggle the context band; r = refresh it now'
export const REFRESH_ARG = 'r'
export const TEXT_ON = 'Context band on.'
export const TEXT_OFF = 'Context band off.'
export const TEXT_REFRESHED = 'Context band refreshed.'
export const TEXT_USAGE = 'Usage: /context-bar [r|top|min|norm|max]'
export const TEXT_LABEL_CHANGED = (level: string): string => `Context band: ${level} labels.`
export const CHARS_PER_TOKEN = 4
export const ESTIMATE_NOTE = 'distribution est.'
/** Shown instead when the transcript is over the walk limit and only the latest messages were split. */
export const ESTIMATE_NOTE_PARTIAL = '≈ distribution est., latest messages'
export const MEMORY_TAGS: readonly string[] = ['addendum', 'project_context']
export const SKILLS_TAGS: readonly string[] = ['skills']
export const REFRESH_EVENTS: Readonly<Record<string, 'start' | 'round' | 'compact' | 'manual' | 'model'>> = {
  session_start: 'start', agent_end: 'round', session_compact: 'compact', model_select: 'model',
}
export const BAR_CONFIG_PATH = join(homedir(), '.config', 'context-bar', 'config.json')
/** `offloadAtTokens` is optional and off by default: when set, the marker shows that token count instead of Pi's compaction point. */
export type BarConfig = { labels: LabelLevel; theme?: unknown; colors?: unknown; offloadAtTokens?: number }
export { isContextBarOff } from '../../plugins/context-bar/hooks/config'
const parseOffloadAtTokens = (value: unknown): number | undefined => {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) throw new Error('offloadAtTokens must be a positive integer')
  return value
}
export const loadBarConfig = (path: string): BarConfig => {
  if (!existsSync(path)) return { labels: DEFAULT_LABEL_LEVEL }
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('config must be a JSON object')
    const config = raw as Record<string, unknown>
    if ('refreshEveryRounds' in config) throw new Error('refreshEveryRounds is no longer supported; Pi refreshes every round')
    return { labels: parseLabelLevel(config.labels), theme: config.theme, colors: config.colors, offloadAtTokens: parseOffloadAtTokens(config.offloadAtTokens) }
  } catch (err) { throw new Error(`${path}: ${err instanceof Error ? err.message : String(err)}`) }
}
/** Palette from `theme` and `colors` of config.json plus COLORFGBG; a bad value throws. */
export const barPalette = (config: BarConfig, colorFgBg: string | undefined = process.env.COLORFGBG): Palette => paletteFromConfig(config, colorFgBg)
