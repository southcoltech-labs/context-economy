// SPDX-License-Identifier: Apache-2.0

import type { ContextView } from '../../plugins/context-bar/types'
import {
  COMMAND, COMMAND_DESCRIPTION, REFRESH_ARG, REFRESH_EVENTS, TEXT_OFF, TEXT_ON, TEXT_REFRESHED, TEXT_USAGE, TEXT_LABEL_CHANGED, WIDGET_KEY,
} from './config'
import { buildPiView, splitSystemPrompt, toolChars } from './estimate'
import type { Compaction, PiUsage, ToolLike } from './estimate'
import { ESTIMATE_NOTE, ESTIMATE_NOTE_PARTIAL } from './config'
import { DEFAULT_LABEL_LEVEL, LABEL_LEVELS, parseLabelLevel } from '../../plugins/context-bar/hooks/levels'
import type { LabelLevel } from '../../plugins/context-bar/hooks/levels'
import { renderLines } from '../../plugins/context-bar/hooks/ansi'
import type { RefreshState } from '../../plugins/context-bar/hooks/refresh'
import { applySplit } from '../../plugins/context-bar/hooks/split'
import { barPalette } from './config'
import type { BarConfig } from './config'
import { PALETTES, UNKNOWN_HOST_THEME } from '../../plugins/context-bar/hooks/palettes'
import type { Palette } from '../../plugins/context-bar/hooks/palettes'
import { convertPi, piItems } from './items'
import type { PiItemState } from './items'
import { walkMessages } from '../../plugins/context-bar/hooks/walk'
import type { Walk } from '../../plugins/context-bar/hooks/walk'
import { splitFromRaw } from '../../plugins/context-bar/hooks/split'
import { topItems, topLines } from '../../plugins/context-bar/hooks/top'
import { compactionText } from '../../plugins/context-bar/hooks/compaction'
import { TOP_ARG, TOP_DEFAULT_COUNT } from '../../plugins/context-bar/hooks/config'

type Tui = { requestRender(): void }
type Widget = { render(width: number): string[]; invalidate(): void; dispose?(): void }
type WidgetFactory = (tui: Tui, theme: unknown) => Widget
type Model = { provider: string; id: string }

export type BarCtx = {
  hasUI: boolean
  sessionManager: { getEntries(): Array<Record<string, unknown>> }
  getContextUsage(): PiUsage | undefined
  getSystemPrompt(): string
  model?: Model
  ui: { setWidget(key: string, content: WidgetFactory | undefined): void; notify(message: string, level?: string): void }
}
type Pi = {
  on(event: string, handler: (event: unknown, ctx: BarCtx) => unknown): void
  registerCommand(name: string, options: { description: string; handler: (args: string, ctx: BarCtx) => Promise<void> | void }): void
  getAllTools(): ToolLike[]
  getActiveTools(): string[]
}
export type BarDeps = {
  compaction: (model: Model | undefined) => Compaction
  /** The message list the model sees (Pi session context). */
  messages: (ctx: BarCtx) => unknown[]
  config: () => BarConfig
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export const registerContextBar = (pi: Pi, deps: BarDeps): void => {
  let isEnabled = true
  let view: ContextView | null = null
  let error: string | null = null
  let tui: Tui | undefined
  let rounds: RefreshState = { roundsSince: 0 }
  let configLevel: LabelLevel = DEFAULT_LABEL_LEVEL
  // A bad theme or colors value fails update() before any colour is drawn, so this start value is never shown.
  let palette: Palette = PALETTES[UNKNOWN_HOST_THEME]
  /** /context-bar min|norm|max for this session; null = the config level. */
  let override: LabelLevel | null = null
  /** `offloadAtTokens` of the config at the last update; undefined = the marker is Pi's compaction point. */
  let offloadAt: number | undefined
  /** The walk of the transcript so far: a refresh splits only what was added. Dropped on start, compaction and `/context-bar r`. */
  let walk: Walk<PiItemState> | undefined

  const measure = (ctx: BarCtx): void => {
    const usage = ctx.getContextUsage()
    if (usage === undefined) throw new Error('no context usage')
    const fixed = { ...splitSystemPrompt(ctx.getSystemPrompt()), tools: toolChars(pi.getAllTools(), pi.getActiveTools()) }
    const compaction = { ...deps.compaction(ctx.model), ...(offloadAt === undefined ? {} : { offloadAtTokens: offloadAt }) }
    const base = buildPiView(usage, fixed, compaction)
    if (base === null) return void (view = null)
    walk = walkMessages(walk, deps.messages(ctx), convertPi)
    const split = splitFromRaw(walk.raw, base.rows.find(r => r.key === 'messages')?.tokens ?? 0)
    view = { ...base, rows: applySplit(base.rows, split, base.windowTokens) }
  }

  /** Apply the refresh policy; measure when it says so. A failure is shown in the band, never thrown. */
  const update = (_event: string, ctx: BarCtx): void => {
    try {
      const config = deps.config()
      configLevel = parseLabelLevel(config.labels)
      palette = barPalette(config)
      offloadAt = config.offloadAtTokens
      rounds = { roundsSince: 0 }
      error = null
      measure(ctx)
    } catch (err) {
      view = null
      error = messageOf(err)
    }
  }

  const show = (event: RefreshEvent, ctx: BarCtx): void => {
    if (!ctx.hasUI) return
    if (!isEnabled) return ctx.ui.setWidget(WIDGET_KEY, undefined)
    if (event === 'start' || event === 'compact') walk = undefined // the transcript is new or was rewritten
    update(event, ctx)
    if (tui) return tui.requestRender()
    ctx.ui.setWidget(WIDGET_KEY, t => {
      tui = t
      const prefix = (): string => (walk !== undefined && walk.omitted > 0 ? ESTIMATE_NOTE_PARTIAL : ESTIMATE_NOTE)
      return {
        render: (width: number) => {
          let compaction = ''
          let failure: string | undefined
          if (view) {
            try {
              const entries = ctx.sessionManager.getEntries()
              const compacted = entries.filter(entry => entry.type === 'compaction')
              const last = compacted.at(-1)
              if (last) {
                const at = Date.parse(String(last.timestamp))
                if (!Number.isFinite(at)) throw new Error('invalid compaction timestamp')
                compaction = compactionText({ count: compacted.length, last: { at, ...(typeof last.tokensBefore === 'number' ? { tokensBefore: last.tokensBefore } : {}) } }, Date.now())
              }
            } catch (cause) { failure = messageOf(cause) }
          }
          const lines = renderLines(view, error, width, prefix(), override ?? configLevel, palette, compaction)
          if (failure !== undefined) lines.unshift(`n/a (${failure})`)
          return lines
        },
        invalidate: () => {},
        dispose: () => { tui = undefined },
      }
    })
  }

  for (const [e, event] of Object.entries(REFRESH_EVENTS)) pi.on(e, (_event, ctx) => show(event, ctx))

  pi.registerCommand(COMMAND, {
    description: COMMAND_DESCRIPTION,
    handler: (args, ctx) => {
      const arg = args.trim()
      if (arg === TOP_ARG) {
        try { return ctx.ui.notify(topLines(topItems(piItems(deps.messages(ctx)), TOP_DEFAULT_COUNT)).join('\n'), 'info') }
        catch (cause) { return ctx.ui.notify(messageOf(cause), 'warning') }
      }
      if ((LABEL_LEVELS as readonly string[]).includes(arg)) {
        try {
          override = parseLabelLevel(arg)
          isEnabled = true
          show('manual', ctx)
          ctx.ui.notify(TEXT_LABEL_CHANGED(override), 'info')
        } catch (cause) { ctx.ui.notify(messageOf(cause), 'warning') }
        return
      }
      if (arg === REFRESH_ARG) {
        walk = undefined
        show('manual', ctx)
        return ctx.ui.notify(TEXT_REFRESHED, 'info')
      }
      if (arg !== '') return ctx.ui.notify(TEXT_USAGE, 'warning')
      isEnabled = !isEnabled
      if (!isEnabled) tui = undefined
      show('toggle', ctx)
      ctx.ui.notify(isEnabled ? TEXT_ON : TEXT_OFF, 'info')
    },
  })
}
