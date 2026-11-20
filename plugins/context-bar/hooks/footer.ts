// SPDX-License-Identifier: Apache-2.0

/** Columns kept clear between the two footer texts. */
export const FOOTER_MIN_GAP = 2

/** The compaction text to show beside the note: the whole of it if both fit on one line with a gap, else none (never wrapped or overlapped). */
export const footerCompaction = (note: string, compaction: string, columns: number): string =>
  compaction !== '' && note.length + FOOTER_MIN_GAP + compaction.length <= columns ? compaction : ''
