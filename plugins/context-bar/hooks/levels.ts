// SPDX-License-Identifier: Apache-2.0

import type { LegendRow } from '../types'
import { BAR_CHAR, CATEGORY_ORDER, EMPTY_BAR_CHAR, STATIC_BAR_CHAR, STATIC_KEYS } from './config'

export const LABEL_LEVELS = ['min', 'norm', 'max'] as const
export type LabelLevel = typeof LABEL_LEVELS[number]
export const DEFAULT_LABEL_LEVEL: LabelLevel = 'norm'

export const parseLabelLevel = (value: unknown): LabelLevel => {
  if (value === undefined) return DEFAULT_LABEL_LEVEL
  if (LABEL_LEVELS.includes(value as LabelLevel)) return value as LabelLevel
  throw new Error('context-bar: labels must be min, norm or max')
}

const STATIC = new Set<string>(STATIC_KEYS)

export const isStaticKey = (key: string): boolean => STATIC.has(key) || key === 'static'

export const glyphOf = (key: string): string =>
  isStaticKey(key) ? STATIC_BAR_CHAR : key === 'free' || key === 'buffer' ? EMPTY_BAR_CHAR : BAR_CHAR

/** Tokens before the first message: the cached static prefix. */
export const prefixTokensOf = (rows: readonly LegendRow[]): number =>
  rows.filter(r => STATIC.has(r.key)).reduce((sum, r) => sum + r.tokens, 0)
const GROUPS: Readonly<Record<string, { label: string; members: ReadonlySet<string> }>> = {
  static: { label: 'Static prefix', members: STATIC },
  chat: { label: 'Chat', members: new Set(['prompt', 'reply']) },
  tool: { label: 'Tools', members: new Set(['toolIn', 'toolOut']) },
}

export const orderRows = (rows: readonly LegendRow[]): LegendRow[] => {
  const rank = new Map(CATEGORY_ORDER.map((key, index) => [key, index]))
  const zone = (key: string): number => isStaticKey(key) ? 0 : key === 'free' || key === 'buffer' ? 2 : 1
  return [...rows].sort((a, b) => {
    const za = zone(a.key)
    const zb = zone(b.key)
    if (za !== zb) return za - zb
    if (za === 2) return a.key === b.key ? 0 : a.key === 'free' ? -1 : 1
    return b.tokens - a.tokens || (rank.get(a.key as typeof CATEGORY_ORDER[number]) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.key as typeof CATEGORY_ORDER[number]) ?? Number.MAX_SAFE_INTEGER)
  })
}

export const groupRows = (rows: readonly LegendRow[], level: LabelLevel, windowTokens: number): LegendRow[] => {
  if (level === 'max') return [...rows]
  const merged = new Set<string>()
  const result: LegendRow[] = []
  for (const row of rows) {
    let group: string | undefined
    if (STATIC.has(row.key)) group = 'static'
    else if (level === 'min' && (row.key === 'prompt' || row.key === 'reply')) group = 'chat'
    else if (level === 'min' && (row.key === 'toolIn' || row.key === 'toolOut')) group = 'tool'
    if (group === undefined) { result.push(row); continue }
    if (merged.has(group)) continue
    merged.add(group)
    const members = GROUPS[group]!.members
    const tokens = rows.filter(item => members.has(item.key)).reduce((sum, item) => sum + item.tokens, 0)
    result.push({ key: group, label: GROUPS[group]!.label, tokens, percent: Math.round(tokens / windowTokens * 1000) / 10 })
  }
  return result
}
