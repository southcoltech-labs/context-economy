// SPDX-License-Identifier: Apache-2.0

import { AGO_DAY_MS, AGO_HOUR_MS, AGO_MINUTE_MS } from './config'
import { formatTokens } from './format'

export type CompactionEvent = { at: number; tokensBefore?: number; tokensAfter?: number }
export type CompactionStats = { count: number; last: CompactionEvent | null }
export const EMPTY_COMPACTIONS: CompactionStats = { count: 0, last: null }

const validTokens = (value: number | undefined): boolean => value === undefined || (Number.isInteger(value) && value >= 0)

const validateStats = (stats: CompactionStats): void => {
  if (!stats || !Number.isInteger(stats.count) || stats.count < 0 || (stats.count === 0 && stats.last !== null)) {
    throw new Error('context-bar: invalid compaction stats')
  }
}

const validateEvent = (event: CompactionEvent): void => {
  if (!event || !Number.isFinite(event.at) || event.at < 0 || !validTokens(event.tokensBefore) || !validTokens(event.tokensAfter)) {
    throw new Error('context-bar: invalid compaction event')
  }
}

export const recordCompaction = (stats: CompactionStats, event: CompactionEvent): CompactionStats => {
  validateStats(stats)
  validateEvent(event)
  return { count: stats.count + 1, last: event }
}

export const agoText = (ms: number): string => {
  if (!Number.isFinite(ms) || ms < 0) throw new Error('context-bar: invalid compaction age')
  if (ms < AGO_MINUTE_MS) return 'just now'
  if (ms < AGO_HOUR_MS) return `${Math.floor(ms / AGO_MINUTE_MS)}m ago`
  if (ms < AGO_DAY_MS) return `${Math.floor(ms / AGO_HOUR_MS)}h ago`
  return `${Math.floor(ms / AGO_DAY_MS)}d ago`
}

export const compactionText = (stats: CompactionStats, now: number): string => {
  validateStats(stats)
  if (stats.count === 0) return ''
  if (!stats.last) throw new Error('context-bar: missing compaction event')
  validateEvent(stats.last)
  const parts = [`compacted ${stats.count}×`, agoText(now - stats.last.at)]
  const { tokensBefore, tokensAfter } = stats.last
  if (tokensBefore !== undefined && tokensAfter !== undefined) parts.push(`${formatTokens(tokensBefore)}→${formatTokens(tokensAfter)}`)
  else if (tokensBefore !== undefined) parts.push(`was ${formatTokens(tokensBefore)}`)
  return parts.join(' · ')
}
