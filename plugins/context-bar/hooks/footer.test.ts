// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'claude-code/testing'
import { FOOTER_MIN_GAP, footerCompaction } from './footer'

const NOTE = 'distribution est.'
const COMPACTION = 'compacted 2× · 48m ago · 207k→22.2k'

test('the compaction text shows when note, gap and text fit the width', () => {
  const fits = NOTE.length + FOOTER_MIN_GAP + COMPACTION.length
  expect(footerCompaction(NOTE, COMPACTION, fits)).toBe(COMPACTION)
  expect(footerCompaction(NOTE, COMPACTION, 200)).toBe(COMPACTION)
})

test('it is hidden, not shortened, one column short', () => {
  expect(footerCompaction(NOTE, COMPACTION, NOTE.length + FOOTER_MIN_GAP + COMPACTION.length - 1)).toBe('')
  expect(footerCompaction(NOTE, COMPACTION, 20)).toBe('')
})

test('no compaction text stays empty', () => {
  expect(footerCompaction(NOTE, '', 200)).toBe('')
})
