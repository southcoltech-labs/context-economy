// SPDX-License-Identifier: Apache-2.0

import type { SessionContextBreakdown } from 'claude-code'

import type { ContextView, LegendRow } from '../types'
import {
  CATEGORY_ORDER,
  CATEGORY_STYLES,
  COMPACT_LABEL,
  COMPACT_OFF_LABEL,
  FULL_PERCENT,
  NAME_TO_KEY,
  SEPARATOR,
  WINDOW_JOINER,
} from './config'
import type { CategoryKey } from './config'
import { formatTokens } from './format'
import { splitMessages, splitFromRaw, applySplit } from './split'
import type { MessageItem, RawSplit } from './split'

const PERCENT_SCALE = 10 // one decimal

const keyOf = (name: string, kind: string): CategoryKey => {
  if (kind === 'free') return 'free'
  if (kind === 'buffer') return 'buffer'
  return NAME_TO_KEY[name.trim().toLowerCase()] ?? 'other'
}

const share = (tokens: number, windowTokens: number): number =>
  Math.round((tokens / windowTokens) * FULL_PERCENT * PERCENT_SCALE) / PERCENT_SCALE

const threshold = (b: SessionContextBreakdown): number | null => {
  if (!b.isAutoCompactEnabled) return null
  if (b.autoCompactThreshold === undefined) {
    throw new Error('breakdown: autocompact is on but reports no threshold')
  }
  return b.autoCompactThreshold
}

/** Turn the engine's breakdown into plain numbers for the band. */
/** `items` are split here; `walked` brings sums already made by a walk (`approximate` when older messages were left out). */
export const buildView = (b: SessionContextBreakdown, items: readonly MessageItem[] | { raw: RawSplit; approximate: boolean } = []): ContextView => {
  if (!(b.rawMaxTokens > 0)) throw new Error('breakdown: window is not positive')
  const sums = new Map<CategoryKey, number>()
  for (const c of b.categories) {
    if (c.kind === 'deferred') continue
    const key = keyOf(c.name, c.kind)
    sums.set(key, (sums.get(key) ?? 0) + c.tokens)
  }
  const rows: LegendRow[] = CATEGORY_ORDER.flatMap(key => {
    const tokens = sums.get(key)
    if (tokens === undefined) return []
    return [{
      key,
      label: CATEGORY_STYLES[key].label,
      tokens,
      percent: share(tokens, b.rawMaxTokens),
    }]
  })
  const messageRow = rows.find(row => row.key === 'messages')
  const splitRows = messageRow
    ? applySplit(rows, 'raw' in items ? splitFromRaw(items.raw, messageRow.tokens) : splitMessages(items, messageRow.tokens), b.rawMaxTokens)
    : rows
  return {
    usedTokens: b.totalTokens,
    windowTokens: b.rawMaxTokens,
    percent: b.percentage,
    thresholdTokens: threshold(b),
    isAutoCompactEnabled: b.isAutoCompactEnabled,
    rows: splitRows,
    ...('raw' in items && items.approximate ? { approximate: true as const } : {}),
  }
}

/** Right side of the header: `212k of 1M · compacts at 950k`. */
export const summaryText = (v: ContextView): string => {
  const used = `${v.approximate ? '≈' : ''}${formatTokens(v.usedTokens)} ${WINDOW_JOINER} ${formatTokens(v.windowTokens)}`
  const compact =
    v.thresholdTokens === null
      ? COMPACT_OFF_LABEL
      : `${COMPACT_LABEL} ${formatTokens(v.thresholdTokens)}`
  return `${used}${SEPARATOR}${compact}`
}
