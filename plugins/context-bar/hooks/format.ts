// SPDX-License-Identifier: Apache-2.0

import {
  BADGE_CRITICAL_COLOR,
  BADGE_CRITICAL_PERCENT,
  BADGE_OK_COLOR,
  BADGE_WARN_COLOR,
  BADGE_WARN_PERCENT,
  K_DECIMALS_BELOW,
  PERCENT_DECIMALS,
  TOKENS_PER_K,
  TOKENS_PER_M,
} from './config'

/** One decimal, trailing ".0" dropped. */
const trimmed = (n: number): string => n.toFixed(1).replace(/\.0$/, '')

export const formatTokens = (tokens: number): string => {
  if (!Number.isFinite(tokens) || tokens < 0) {
    throw new Error(`formatTokens: invalid token count ${tokens}`)
  }
  if (tokens >= TOKENS_PER_M) return `${trimmed(tokens / TOKENS_PER_M)}M`
  if (tokens < TOKENS_PER_K) return String(tokens)
  const k = tokens / TOKENS_PER_K
  return `${k < K_DECIMALS_BELOW ? trimmed(k) : String(Math.round(k))}k`
}

export const formatPercent = (percent: number): string => {
  if (!Number.isFinite(percent)) throw new Error(`formatPercent: invalid ${percent}`)
  return `${percent.toFixed(PERCENT_DECIMALS)}%`
}

export const badgeColor = (percent: number): string => {
  if (percent >= BADGE_CRITICAL_PERCENT) return BADGE_CRITICAL_COLOR
  if (percent >= BADGE_WARN_PERCENT) return BADGE_WARN_COLOR
  return BADGE_OK_COLOR
}
