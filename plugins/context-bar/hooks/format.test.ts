// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'claude-code/testing'

import { badgeColor, formatPercent, formatTokens } from './format'

describe('formatTokens', () => {
  test('small counts are plain', () => expect(formatTokens(850)).toBe('850'))
  test('k with one decimal under 100k', () => expect(formatTokens(8200)).toBe('8.2k'))
  test('whole k from 100k', () => expect(formatTokens(212000)).toBe('212k'))
  test('round k drops the decimal', () => expect(formatTokens(8000)).toBe('8k'))
  test('million', () => expect(formatTokens(1000000)).toBe('1M'))
  test('fractional million', () => expect(formatTokens(1500000)).toBe('1.5M'))
  test('rejects negatives', () => expect(() => formatTokens(-1)).toThrow())
  test('rejects NaN', () => expect(() => formatTokens(Number.NaN)).toThrow())
})

describe('formatPercent', () => {
  test('one decimal', () => expect(formatPercent(21.24)).toBe('21.2%'))
  test('zero', () => expect(formatPercent(0)).toBe('0.0%'))
})

describe('badgeColor', () => {
  test('ok below warn', () => expect(badgeColor(69.9)).toBe('green'))
  test('warn at 70', () => expect(badgeColor(70)).toBe('yellow'))
  test('critical at 90', () => expect(badgeColor(90)).toBe('red'))
})
