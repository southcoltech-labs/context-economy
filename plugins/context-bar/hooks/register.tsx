// SPDX-License-Identifier: Apache-2.0

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ContextView, TrendMetric, TrendPoint } from '../types'
import { renderBand } from './band'
import type { TrendInput } from './band'
import {
  BREAKDOWN_DETAIL,
  COMMAND,
  COMMAND_DESCRIPTION,
  isContextBarOff,
  TEXT_LABEL_CHANGED,
  REFRESH_ARG,
  TEXT_OFF,
  TEXT_ON,
  TEXT_REFRESHED,
  TEXT_SWITCHED_OFF,
  TEXT_USAGE,
  TOP_ARG,
  TOP_DEFAULT_COUNT,
} from './config'
import { buildView } from './view'
import { convertClaude, toItems } from './items'
import type { ItemState } from './items'
import { walkMessages } from './walk'
import type { Walk } from './walk'
import { topItems, topLines } from './top'
import { EMPTY_COMPACTIONS, compactionText, recordCompaction } from './compaction'
import type { CompactionStats } from './compaction'
import { isGrown, parseRefreshGrowthPercent } from './refresh'
import { LABEL_LEVELS, parseLabelLevel } from './levels'
import { DEFAULT_THEME_SETTING, PALETTES, UNKNOWN_HOST_THEME, paletteFor, parseColors, resolveTheme } from './palettes'
import type { Palette } from './palettes'
import type { LabelLevel } from './levels'
import { DEFAULT_TREND_METRIC, DEFAULT_TREND_REFRESH_SECONDS, addPoint, nextMetric, parseTrendRefreshSeconds, processedTokens } from './trend'

const view = atom({ plugin: 'context-bar', key: 'view' } as const, null)
const isEnabled = atom({ plugin: 'context-bar', key: 'isEnabled' } as const, false)
const error = atom({ plugin: 'context-bar', key: 'error' } as const, null)
const roundsSince = atom({ plugin: 'context-bar', key: 'roundsSince' } as const, 0)
const measuredTokens = atom({ plugin: 'context-bar', key: 'measuredTokens' } as const, null as number | null)
/** Session override from /context-bar min|norm|max; null = use the labels option. */
const labels = atom({ plugin: 'context-bar', key: 'labels' } as const, null as LabelLevel | null)
const compactions = atom({ plugin: 'context-bar', key: 'compactions' } as const, EMPTY_COMPACTIONS)

/** Expanded band (▼ / ▲): session-scoped, so a reload keeps it open and the samples already taken. */
const isExpanded = atom({ plugin: 'context-bar', key: 'isExpanded' } as const, false)
const trendMetric = atom({ plugin: 'context-bar', key: 'metric' } as const, DEFAULT_TREND_METRIC as TrendMetric)
const residentPoints = atom({ plugin: 'context-bar', key: 'residentPoints' } as const, [] as TrendPoint[])
const processedPoints = atom({ plugin: 'context-bar', key: 'processedPoints' } as const, [] as TrendPoint[])
const processedTotal = atom({ plugin: 'context-bar', key: 'processedTotal' } as const, 0)
const redraw = atom({ plugin: 'context-bar', key: 'redraw' } as const, 0)

const HOST_THEME_KEY = 'theme'
type Options = Record<string, unknown> | undefined

/** Theme option, else the host theme (config row `theme`; unreadable = unknown host theme, resolves to the documented default). The colors option overrides. Bad options throw. */
const paletteOf = async ($: EngineInterface, options: Options): Promise<Palette> => {
  const setting = options?.theme ?? DEFAULT_THEME_SETTING
  const colors = parseColors(options?.colors)
  const host = setting === 'auto' ? (await $.config.list().catch(() => [])).find(row => row.key === HOST_THEME_KEY)?.value : undefined
  return paletteFor(resolveTheme(setting, typeof host === 'string' ? host : undefined), colors)
}

/** The walk of the transcript so far: a refresh splits only what was added. Dropped on `/context-bar r`, a compaction and a new session. */
let walk: Walk<ItemState> | undefined
const resetWalk = (): void => { walk = undefined }

/** Read the live breakdown from the engine; a failure is shown, never hidden. */
const refresh = async ($: EngineInterface, growthPercent: () => number, level: () => LabelLevel, settings: Options): Promise<void> => {
  let next: ContextView | null = null
  let failure: string | null = null
  let measured: number | undefined
  try {
    growthPercent() // a bad refreshGrowthPercent is shown in the band, not thrown
    level() // so is a bad labels value
    await paletteOf($, settings) // and a bad theme or colors value
    parseTrendRefreshSeconds(settings?.trendRefreshSeconds) // and a bad trendRefreshSeconds
    const [usage, messages] = await Promise.all([
      $.session.usage({ breakdown: BREAKDOWN_DETAIL }),
      $.session.messages(),
    ])
    measured = usage.context.tokens
    await update($, measuredTokens, () => usage.context.tokens ?? null)
    const breakdown = usage.context.breakdown
    if (breakdown === undefined) throw new Error('no breakdown from session.usage')
    const stats = await read($, compactions)
    const recorded = stats as CompactionStats
    const text = recorded.count > 0 ? compactionText(recorded, await $.clock.now()) : ''
    walk = walkMessages(walk, messages, convertClaude)
    next = { ...buildView(breakdown, { raw: walk.raw, approximate: walk.omitted > 0 }), compactionText: text }
  } catch (cause) {
    failure = cause instanceof Error ? cause.message : String(cause)
  }
  await update($, view, () => next)
  await update($, error, () => failure)
  // The bar just changed, so the trend takes the size it measured: bar and graph agree, and an unchanged size adds nothing. Apart from the bar's own try: a trend failure never blanks the bar.
  if (next !== null && measured !== undefined) {
    try {
      const now = await $.clock.now()
      await update($, residentPoints, points => points.at(-1)?.value === measured ? points : addPoint(points, { at: now, value: measured }, now))
    } catch { /* the trend is secondary */ }
  }
}

/** Adds a turn's four token counts to the running total. Reads the event's own usage: no engine call, so it costs nothing while the band is hidden. */
const recordProcessed = async ($: EngineInterface, usage: Parameters<typeof processedTokens>[0] | undefined): Promise<void> => {
  if (usage === undefined) return
  const now = await $.clock.now()
  const total = (await read($, processedTotal)) + processedTokens(usage)
  await update($, processedTotal, () => total)
  await update($, processedPoints, points => addPoint(points, { at: now, value: total }, now))
}

/** Hidden band = no work: no breakdown counting while the band is off. */
const refreshIfShown = async ($: EngineInterface, growthPercent: () => number, level: () => LabelLevel, settings: Options): Promise<void> => {
  if (await read($, isEnabled)) await refresh($, growthPercent, level, settings)
}

/** The open trend redraws on a timer so the line moves while the session is idle. The timer lives only while the band is shown and expanded: the render starts it, and it cancels itself on the first tick that finds the band hidden or collapsed. */
let redrawTimer: { cancel: () => void } | undefined
const keepRedrawing = ($: EngineInterface, seconds: number): void => {
  if (redrawTimer !== undefined) return
  redrawTimer = $.clock.every(seconds * 1000, () => {
    void (async () => {
      try {
        if ((await read($, isEnabled)) && (await read($, isExpanded))) await update($, redraw, n => n + 1)
        else { redrawTimer?.cancel(); redrawTimer = undefined }
      } catch (cause) {
        await update($, error, () => cause instanceof Error ? cause.message : String(cause))
      }
    })()
  })
}

/** The off switch, read through the host (`$.env`: the hooks module has no `process`). An unreadable value means on. */
const isOff = async ($: { env: { get(name: string): Promise<string | undefined> } }): Promise<boolean> => {
  try { return isContextBarOff({ CE_CONTEXT_BAR: await $.env.get('CE_CONTEXT_BAR') }) } catch { return false }
}

export const register: Register = (on, options) => {
  const growthPercent = (): number => parseRefreshGrowthPercent(options?.refreshGrowthPercent)
  const optionLevel = (): LabelLevel => parseLabelLevel(options?.labels)
  // A bad value is shown in the band by refresh(); the timer meanwhile keeps the default.
  const trendSeconds = (): number => { try { return parseTrendRefreshSeconds(options?.trendRefreshSeconds) } catch { return DEFAULT_TREND_REFRESH_SECONDS } }

  on('session.start', async ($, e, next) => {
    if (await isOff($)) return next(e)
    resetWalk()
    await $.command.register({ name: COMMAND, description: COMMAND_DESCRIPTION })
    return next(e)
  })

  // A shown band refreshes on growth and after compaction; `r` refreshes mid-turn.
  on('command.run', { command: COMMAND }, async ($, e) => {
    if (await isOff($)) return { text: TEXT_SWITCHED_OFF }
    const arg = e.args.trim()
    if (arg === TOP_ARG) {
      const messages = await $.session.messages()
      return { text: topLines(topItems(toItems(messages), TOP_DEFAULT_COUNT)).join('\n') }
    }
    if (arg === REFRESH_ARG) {
      await update($, isEnabled, () => true)
      await update($, roundsSince, () => 0)
      resetWalk()
      await refresh($, growthPercent, optionLevel, options)
      return { text: TEXT_REFRESHED }
    }
    if ((LABEL_LEVELS as readonly string[]).includes(arg)) {
      const level = parseLabelLevel(arg)
      await update($, labels, () => level)
      await update($, isEnabled, () => true)
      await update($, roundsSince, () => 0)
      await refresh($, growthPercent, optionLevel, options)
      return { text: TEXT_LABEL_CHANGED(level) }
    }
    if (arg !== '') return { text: TEXT_USAGE }
    const enabled = !(await read($, isEnabled))
    await update($, isEnabled, () => enabled)
    if (enabled) {
      await update($, roundsSince, () => 0)
      await refresh($, growthPercent, optionLevel, options)
    }
    return { text: enabled ? TEXT_ON : TEXT_OFF }
  })

  // The trend records while the band is hidden too (pushed figures, no usage call), so opening it shows the past 30 minutes.
  on('session.measure', async ($, e, next) => {
    if (await isOff($)) return next(e)
    const tokens = e.context.tokens
    if (e.changed.includes('context') && tokens !== undefined) {
      try {
        const now = await $.clock.now()
        await update($, residentPoints, points => addPoint(points, { at: now, value: tokens }, now))
      } catch (cause) {
        await update($, error, () => cause instanceof Error ? cause.message : String(cause))
      }
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (await isOff($)) return next(e)
    const result = await next(e)
    if (e.agentId) return result
    try {
      await recordProcessed($, 'usage' in e ? e.usage : undefined)
      await update($, roundsSince, n => n + 1)
      if (await read($, isEnabled)) {
        const percent = growthPercent()
        const usage = await $.session.usage()
        if (isGrown(await read($, measuredTokens), usage.context.tokens, usage.context.window, percent)) {
          await update($, roundsSince, () => 0)
          await refresh($, growthPercent, optionLevel, options)
        }
      }
    } catch (cause) {
      await update($, error, () => cause instanceof Error ? cause.message : String(cause))
    }
    return result
  })

  on('session.compact', async ($, e, next) => {
    if (await isOff($)) return next(e)
    const result = await next(e)
    resetWalk() // the transcript was rewritten: split it afresh
    if (!e.agentId) {
      if (!('skip' in (result as object))) {
        const current = await read($, compactions)
        const updated = recordCompaction(current as CompactionStats, {
          at: await $.clock.now(),
          ...(('tokensBefore' in (result as object)) ? { tokensBefore: (result as { tokensBefore?: number }).tokensBefore } : {}),
          ...(('tokensAfter' in (result as object)) ? { tokensAfter: (result as { tokensAfter?: number }).tokensAfter } : {}),
        })
        await update($, compactions, () => updated)
        // The host reports no new fill until the next response, so mark the drop on the trend now.
        const after = (result as { tokensAfter?: number }).tokensAfter
        if (after !== undefined) {
          const now = await $.clock.now()
          await update($, residentPoints, points => addPoint(points, { at: now, value: after }, now))
        }
      }
      await update($, roundsSince, () => 0)
      await refreshIfShown($, growthPercent, optionLevel, options)
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (await isOff($)) return next(e)
    const isHidden = e.props.hasSurvey || !(await read($, isEnabled))
    if (isHidden) return next(e)
    const ui = $.ui.resolve(e)
    const override = await read($, labels)
    const current = await read($, view)
    // No view means the band shows only n/a (refresh already surfaced a bad theme or colors option); no colour is drawn.
    const palette = current === null ? PALETTES[UNKNOWN_HOST_THEME] : await paletteOf($, options)
    const metric = await read($, trendMetric)
    const isOpen = await read($, isExpanded)
    if (isOpen) {
      await read($, redraw) // a tick writes this, which redraws the band
      keepRedrawing($, trendSeconds())
    }
    const trend: TrendInput = {
      isExpanded: isOpen,
      metric,
      points: metric === 'resident' ? await read($, residentPoints) : await read($, processedPoints),
      now: isOpen ? await $.clock.now() : 0, // only the open section needs the time
      onExpand: () => { void update($, isExpanded, open => !open) },
      onMetric: () => { void update($, trendMetric, nextMetric) },
    }
    const band = renderBand(ui, e, current, await read($, error), await read($, roundsSince), () => override ?? optionLevel(), palette, trend)
    // Other bands (wait-timer) hook the same slot: stack theirs under ours.
    const below = await next(e)
    return <ui.Box flexDirection="column">{band}{below}</ui.Box>
  })
}
