// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'claude-code/testing'
import { EMPTY_COMPACTIONS, agoText, compactionText, recordCompaction } from './compaction'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const T0 = Date.UTC(2026, 9, 28, 12, 0, 0)

describe('recordCompaction', () => {
  test('counts up and keeps the latest event', () => {
    const one = recordCompaction(EMPTY_COMPACTIONS, { at: T0, tokensBefore: 412000, tokensAfter: 38000 })
    expect(one).toEqual({ count: 1, last: { at: T0, tokensBefore: 412000, tokensAfter: 38000 } })
    const two = recordCompaction(one, { at: T0 + MIN })
    expect(two).toEqual({ count: 2, last: { at: T0 + MIN } })
  })

  test('does not mutate the input stats', () => {
    const before = { count: 0, last: null }
    recordCompaction(before, { at: T0 })
    expect(before).toEqual({ count: 0, last: null })
    expect(EMPTY_COMPACTIONS).toEqual({ count: 0, last: null })
  })

  test('rejects bad events', () => {
    for (const at of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => recordCompaction(EMPTY_COMPACTIONS, { at })).toThrow(/compaction/)
    }
    expect(() => recordCompaction(EMPTY_COMPACTIONS, { at: T0, tokensBefore: -5 })).toThrow(/compaction/)
    expect(() => recordCompaction(EMPTY_COMPACTIONS, { at: T0, tokensAfter: 1.5 })).toThrow(/compaction/)
  })

  test('rejects bad stats', () => {
    expect(() => recordCompaction({ count: -1, last: null }, { at: T0 })).toThrow(/compaction/)
    expect(() => recordCompaction({ count: 0, last: { at: T0 } }, { at: T0 })).toThrow(/compaction/)
    expect(() => recordCompaction({ count: 1.5, last: { at: T0 } }, { at: T0 })).toThrow(/compaction/)
  })
})

describe('agoText', () => {
  test('buckets', () => {
    expect(agoText(0)).toBe('just now')
    expect(agoText(MIN - 1)).toBe('just now')
    expect(agoText(MIN)).toBe('1m ago')
    expect(agoText(59 * MIN + 59_999)).toBe('59m ago')
    expect(agoText(HOUR)).toBe('1h ago')
    expect(agoText(DAY - 1)).toBe('23h ago')
    expect(agoText(3 * DAY + HOUR)).toBe('3d ago')
  })
  test('negative age throws', () => {
    expect(() => agoText(-1)).toThrow(/compaction/)
  })
})

describe('compactionText', () => {
  test('nothing to show before the first compaction', () => {
    expect(compactionText(EMPTY_COMPACTIONS, T0)).toBe('')
  })
  test('count, age, before→after', () => {
    const stats = { count: 3, last: { at: T0, tokensBefore: 412000, tokensAfter: 38000 } }
    expect(compactionText(stats, T0 + 12 * MIN)).toBe('compacted 3× · 12m ago · 412k→38k')
  })
  test('only before (Pi, Codex before the next token count)', () => {
    expect(compactionText({ count: 1, last: { at: T0, tokensBefore: 950 } }, T0)).toBe('compacted 1× · just now · was 950')
  })
  test('no token sizes', () => {
    expect(compactionText({ count: 2, last: { at: T0 } }, T0 + 2 * HOUR)).toBe('compacted 2× · 2h ago')
  })
  test('clock before the event or missing last throws', () => {
    expect(() => compactionText({ count: 1, last: { at: T0 } }, T0 - 1)).toThrow(/compaction/)
    expect(() => compactionText({ count: 1, last: null }, T0)).toThrow(/compaction/)
  })
})
