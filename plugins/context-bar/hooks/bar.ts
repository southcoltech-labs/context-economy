// SPDX-License-Identifier: Apache-2.0

import { GAP_KEY } from './config'

export type BarPart = { key: string; tokens: number }
export type BarRun = { key: string; length: number; isMarker: boolean }

/** Cells per part: largest-remainder so the parts fill the width exactly. */
const allocate = (parts: readonly BarPart[], windowTokens: number, width: number): number[] => {
  const exact = parts.map(p => (p.tokens / windowTokens) * width)
  const cells = exact.map(Math.floor)
  const total = parts.reduce((n, p) => n + p.tokens, 0)
  let missing = Math.round((total / windowTokens) * width) - cells.reduce((a, b) => a + b, 0)
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .filter(({ i }) => (parts[i]?.tokens ?? 0) > 0)
    .sort((a, b) => b.frac - a.frac)
  for (const { i } of order) {
    if (missing <= 0) break
    cells[i] = (cells[i] ?? 0) + 1
    missing -= 1
  }
  return cells
}

export const layoutBar = (
  parts: readonly BarPart[],
  windowTokens: number,
  thresholdTokens: number | null,
  width: number,
  prefixTokens?: number,
): BarRun[] => {
  if (!(windowTokens > 0)) throw new Error('layoutBar: window must be positive')
  if (!Number.isInteger(width) || width < 1) throw new Error('layoutBar: width must be >= 1')
  const total = parts.reduce((n, p) => n + p.tokens, 0)
  // Over-window parts scale to the total; the percent badge already shows the overflow.
  const span = Math.max(windowTokens, total)

  const keys: string[] = []
  const allocations = allocate(parts, span, width)
  allocations.forEach((n, i) => {
    for (let c = 0; c < n; c += 1) keys.push(parts[i]?.key ?? '')
  })
  // Parts may sum to a little under the window (estimates); leave that visibly empty.
  while (keys.length < width) keys.push(GAP_KEY)

  const markerAt =
    thresholdTokens === null
      ? -1
      : Math.min(width - 1, Math.floor((thresholdTokens / span) * width))
  let prefixAt = -1
  if (prefixTokens !== undefined && prefixTokens > 0) {
    let summedTokens = 0
    let summedCells = 0
    for (let i = 0; i < parts.length; i += 1) {
      summedTokens += parts[i]?.tokens ?? 0
      summedCells += allocations[i] ?? 0
      if (summedTokens >= prefixTokens) {
        prefixAt = Math.min(width - 1, summedCells)
        break
      }
    }
  }
  const runs: BarRun[] = []
  keys.forEach((key, cell) => {
    const isMarker = cell === markerAt
    const isPrefix = !isMarker && cell === prefixAt
    const last = runs[runs.length - 1]
    if (last && !isMarker && !isPrefix && !last.isMarker && last.key === key) last.length += 1
    else runs.push({ key: isMarker ? 'marker' : isPrefix ? 'prefixMarker' : key, length: 1, isMarker: isMarker || isPrefix })
  })
  return runs
}
