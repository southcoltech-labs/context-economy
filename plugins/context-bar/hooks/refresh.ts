// SPDX-License-Identifier: Apache-2.0

import { DEFAULT_REFRESH_GROWTH_PERCENT } from './config'

export const parseRefreshGrowthPercent = (value: unknown): number => {
  if (value === undefined) return DEFAULT_REFRESH_GROWTH_PERCENT
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 100) {
    throw new Error('context-bar: refreshGrowthPercent must be a number above 0 and at most 100')
  }
  return value
}

export const isGrown = (measured: number | null, tokens: number | undefined, window: number, percent: number): boolean => {
  if (tokens === undefined) return false
  if (measured === null) return true
  return Math.abs(tokens - measured) >= window * percent / 100
}

export const ageText = (roundsSince: number): string => {
  if (!Number.isInteger(roundsSince) || roundsSince < 0) throw new Error('context-bar: invalid round age')
  if (roundsSince === 0) return ''
  return `updated ${roundsSince} ${roundsSince === 1 ? 'turn' : 'turns'} ago`
}
