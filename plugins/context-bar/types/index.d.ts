// SPDX-License-Identifier: Apache-2.0

export type LegendRow = {
  key: string
  label: string
  tokens: number
  percent: number
}

/** Same shape as hooks/compaction.ts (the contract must be self-contained). */
export type CompactionStats = {
  count: number
  last: { at: number; tokensBefore?: number; tokensAfter?: number } | null
}

export type ContextView = {
  compactionText: string
  usedTokens: number
  windowTokens: number
  percent: number
  /** null when auto-compaction is off or reports no threshold. */
  thresholdTokens: number | null
  isAutoCompactEnabled: boolean
  rows: LegendRow[]
  /** True when the message split was made from the latest messages only (the transcript is over the walk limit). */
  approximate?: true
}

/** One sample of a trend series: when (`$.clock.now()` ms) and the value then. */
export type TrendPoint = { at: number; value: number }

/** The two expanded-band metrics: the context's size now, or the running total of tokens the model has processed. */
export type TrendMetric = 'resident' | 'processed'

declare module 'claude-code' {
  interface PluginState {
    'context-bar': {
      /** The expanded trend section is open (the ▼ / ▲ button). */
      isExpanded: boolean
      /** Which series the expanded band draws. */
      metric: TrendMetric
      /** Context size after each main-thread turn, last 30 minutes (plus the point in force at the window start). */
      residentPoints: TrendPoint[]
      /** Running total of tokens processed per main-thread turn, last 30 minutes. */
      processedPoints: TrendPoint[]
      /** The running total itself; kept apart so pruning old points never resets it. */
      processedTotal: number
      /** Counts the redraw ticks of the open trend; its only job is to make the band redraw while idle. */
      redraw: number
      view: ContextView | null
      isEnabled: boolean
      error: string | null
      roundsSince: number
      measuredTokens: number | null
      compactions: CompactionStats
      /** /context-bar min|norm|max for this session; null = the labels option. */
      labels: 'min' | 'norm' | 'max' | null
    }
  }
}
