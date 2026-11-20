// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'claude-code/testing'
import { ageText, isGrown, parseRefreshGrowthPercent } from './refresh'
import { DEFAULT_REFRESH_GROWTH_PERCENT } from './config'

describe('growth refresh policy', () => {
  test('default is 5 and valid values pass through', () => {
    expect(DEFAULT_REFRESH_GROWTH_PERCENT).toBe(5)
    expect(parseRefreshGrowthPercent(undefined)).toBe(5)
    for (const v of [5, 10, 0.5, 100, 99.9]) expect(parseRefreshGrowthPercent(v)).toBe(v)
  })
  test('rejects invalid values with the field name in the error', () => {
    for (const v of [0, -1, 101, Number.NaN, Infinity, '5', null, true, {}]) {
      expect(() => parseRefreshGrowthPercent(v)).toThrow(/refreshGrowthPercent/)
    }
    expect(() => parseRefreshGrowthPercent(0)).toThrow(/above 0 and at most 100/)
  })
  test('isGrown: tokens undefined is never growth', () => {
    expect(isGrown(1000, undefined, 10000, 5)).toBe(false)
    expect(isGrown(null, undefined, 10000, 5)).toBe(false)
  })
  test('isGrown: nothing measured yet (null) and tokens known is growth, even at 0', () => {
    expect(isGrown(null, 1, 10000, 5)).toBe(true)
    expect(isGrown(null, 0, 10000, 5)).toBe(true)
  })
  test('isGrown: growth below, exactly at, and above the threshold (5% of 10000 = 500)', () => {
    expect(isGrown(2000, 2499, 10000, 5)).toBe(false)
    expect(isGrown(2000, 2500, 10000, 5)).toBe(true)
    expect(isGrown(2000, 2501, 10000, 5)).toBe(true)
  })
  test('isGrown: shrink counts the same as growth', () => {
    expect(isGrown(2000, 1501, 10000, 5)).toBe(false)
    expect(isGrown(2000, 1500, 10000, 5)).toBe(true)
    expect(isGrown(2000, 0, 10000, 5)).toBe(true)
  })
  test('isGrown: no change is not growth; the percent scales the threshold', () => {
    expect(isGrown(2000, 2000, 10000, 5)).toBe(false)
    expect(isGrown(2000, 2900, 10000, 10)).toBe(false)
    expect(isGrown(2000, 3000, 10000, 10)).toBe(true)
    expect(isGrown(0, 10000, 10000, 100)).toBe(true)
  })
  test('formats age', () => {
    expect(ageText(0)).toBe('')
    expect(ageText(1)).toBe('updated 1 turn ago')
    expect(ageText(3)).toBe('updated 3 turns ago')
    expect(() => ageText(-1)).toThrow()
  })
})
