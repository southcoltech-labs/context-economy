// SPDX-License-Identifier: Apache-2.0

import { layoutBar } from './bar'
import { glyphOf, groupRows, orderRows, prefixTokensOf } from './levels'
import type { LabelLevel } from './levels'
import { PREFIX_MARKER_CHAR, PREFIX_MARKER_COLOR, PREFIX_TEXT } from './config'
import { ANSI_BOLD, ANSI_DIM, ANSI_INVERSE, ANSI_ITALIC, ANSI_RESET, ERROR_COLOR, GAP_CHAR, GAP_KEY, HEADER, HEADER_COLOR, LEGEND_COLUMN_GAP, LEGEND_FIELD_GAP, MARKER_CHAR, MARKER_COLOR, NOT_AVAILABLE, USAGE_RECALC_NOTES, SQUARE_CHAR, HEX_COLOR, NAMED_COLORS } from './config'
import type { CategoryKey } from './config'
import type { Palette } from './palettes'
import { badgeColor, formatPercent, formatTokens } from './format'
import { footerCompaction } from './footer'
import { legendGrid } from './legend'
import { summaryText } from './view'
import type { ContextView } from '../types'

type Span = { text: string; style: string }
const fg = (color: string | undefined): string => {
  if (color === undefined) return ''
  const m = HEX_COLOR.exec(NAMED_COLORS[color] ?? color)
  if (!m) throw new Error(`context-bar: unknown colour ${color}`)
  return `\x1b[38;2;${parseInt(m[1]!, 16)};${parseInt(m[2]!, 16)};${parseInt(m[3]!, 16)}m`
}
const colorOf = (palette: Palette, key: string): string | undefined => key === GAP_KEY ? undefined : palette[key as CategoryKey]
const widthOf = (spans: readonly Span[]): number => spans.reduce((n, s) => n + s.text.length, 0)
const line = (spans: readonly Span[], max: number): string => {
  let room = max
  let out = ''
  for (const s of spans) {
    if (room <= 0) break
    const text = s.text.slice(0, room)
    room -= text.length
    out += s.style === '' ? text : `${s.style}${text}${ANSI_RESET}`
  }
  return out
}
const header = (right: readonly Span[], max: number): string => {
  const left: Span[] = [{ text: HEADER, style: ANSI_BOLD + fg(HEADER_COLOR) }]
  const gap = max - widthOf(left) - widthOf(right)
  return gap < 1 ? line(left, max) : line([...left, { text: ' '.repeat(gap), style: '' }, ...right], max)
}

export const renderLines = (view: ContextView | null, error: string | null, max: number, note: string, level: LabelLevel, palette: Palette, compaction = ''): string[] => {
  const cols = Math.max(1, max)
  if (view === null) {
    const text = error === null ? NOT_AVAILABLE : `${NOT_AVAILABLE} (${error})`
    const head = header([{ text, style: error === null ? ANSI_DIM : fg(ERROR_COLOR) }], cols)
    // Unknown usage with a compaction on record: say why there is no distribution and keep the known history. The history is never a current count.
    if (error !== null || compaction === '') return [head]
    const history = line([{ text: compaction, style: ANSI_DIM }], cols)
    const fits = USAGE_RECALC_NOTES.find(n => HEADER.length + 1 + n.length <= cols) // else the title alone, as any header does when its right side cannot fit
    return [header(fits === undefined ? [] : [{ text: fits, style: ANSI_DIM + ANSI_ITALIC }], cols), history]
  }
  const prefixTokens = prefixTokensOf(view.rows)
  const prefixText = `${prefixTokens > 0 ? `${PREFIX_TEXT} ${formatTokens(prefixTokens)} · ` : ''}`
  const summary = note === '' ? summaryText(view).replace(' · ', ' / ') : summaryText(view)
  const top = header([
    { text: `${prefixText}${summary} `, style: ANSI_DIM },
    { text: ` ${formatPercent(view.percent)} `, style: ANSI_INVERSE + fg(badgeColor(view.percent)) },
  ], cols)
  const grouped = orderRows(groupRows(view.rows, level, view.windowTokens))
  const runs = layoutBar(grouped.filter(r => r.key !== 'other' || r.tokens > 0).map(r => ({ key: r.key, tokens: r.tokens })), view.windowTokens, view.thresholdTokens, cols, prefixTokens)
  const bar = line(runs.map(r => ({ text: (r.key === 'prefixMarker' ? PREFIX_MARKER_CHAR : r.key === 'marker' ? MARKER_CHAR : r.key === GAP_KEY ? GAP_CHAR : glyphOf(r.key)).repeat(r.length), style: fg(r.key === 'prefixMarker' ? PREFIX_MARKER_COLOR : r.key === 'marker' ? MARKER_COLOR : colorOf(palette, r.key)) })), cols)
  const gap = ' '.repeat(LEGEND_COLUMN_GAP)
  const legend = legendGrid(grouped, cols).map(cells => line(cells.flatMap((c, i) => [
    { text: i === 0 ? '' : gap, style: '' }, { text: SQUARE_CHAR, style: fg(colorOf(palette, c.key)) },
    { text: ` ${c.label}${' '.repeat(LEGEND_FIELD_GAP)}`, style: '' }, { text: c.value, style: ANSI_DIM },
  ]), cols))
  // One footer line: the note on the left, the compaction text on the right when both fit.
  const right = footerCompaction(note, compaction, cols)
  const footerSpans: Span[] = [
    ...(note === '' ? [] : [{ text: note, style: ANSI_DIM + ANSI_ITALIC }]),
    ...(right === '' ? [] : [{ text: ' '.repeat(Math.max(0, cols - note.length - right.length)), style: '' }, { text: right, style: ANSI_DIM }]),
  ]
  return [top, bar, ...legend, ...(footerSpans.length === 0 ? [] : [line(footerSpans, cols)])]
}
