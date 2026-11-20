// SPDX-License-Identifier: Apache-2.0

import { CATEGORY_ORDER, CATEGORY_STYLES, FULL_PERCENT } from '../../plugins/context-bar/hooks/config'
import type { CategoryKey } from '../../plugins/context-bar/hooks/config'
import type { ContextView } from '../../plugins/context-bar/types'
import { CHARS_PER_TOKEN, MEMORY_TAGS, SKILLS_TAGS } from './config'

export type PromptSplit = { system: number; memory: number; skills: number }
export type FixedChars = PromptSplit & { tools: number }
export type PiUsage = { tokens: number | null; contextWindow: number }
/** `offloadAtTokens`: checkpoint trigger of the Pi context-offload extension, when loaded. */
export type Compaction = { enabled: boolean; reserveTokens: number; offloadAtTokens?: number }
export type ToolLike = { name: string; description?: string; parameters?: unknown }

const PERCENT_SCALE = 10 // one decimal

/** Characters of every top-level `<tag>` ... `</tag>` section (tags alone on their line). */
const sectionChars = (text: string, tag: string): number => {
  let total = 0
  const open = new RegExp(`^<${tag}>$`, 'gm')
  for (let m = open.exec(text); m !== null; m = open.exec(text)) {
    const close = text.indexOf(`\n</${tag}>`, m.index)
    if (close < 0) throw new Error(`system prompt: unclosed <${tag}>`)
    const end = close + `\n</${tag}>`.length
    total += end - m.index
    open.lastIndex = end
  }
  return total
}

export const splitSystemPrompt = (text: string): PromptSplit => {
  const sum = (tags: readonly string[]) => tags.reduce((n, t) => n + sectionChars(text, t), 0)
  const memory = sum(MEMORY_TAGS)
  const skills = sum(SKILLS_TAGS)
  return { system: text.length - memory - skills, memory, skills }
}

/** Characters the active tool declarations send: name, description, schema. */
export const toolChars = (all: readonly ToolLike[], active: readonly string[]): number => {
  const on = new Set(active)
  return all
    .filter(t => on.has(t.name))
    .reduce((n, t) => n + JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters }).length, 0)
}

const share = (tokens: number, windowTokens: number): number =>
  Math.round((tokens / windowTokens) * FULL_PERCENT * PERCENT_SCALE) / PERCENT_SCALE

/**
 * Pi reports only the context total. Fixed parts are estimated from characters;
 * if the estimate passes the total, they are scaled down to it. Messages are the rest.
 * Before the first reply (total 0) the estimate is the total.
 */
export const buildPiView = (usage: PiUsage, fixed: FixedChars, compaction: Compaction): ContextView | null => {
  const windowTokens = usage.contextWindow
  if (!(windowTokens > 0)) throw new Error('context usage: window is not positive')
  if (usage.tokens === null) return null
  const est = {
    system: Math.floor(fixed.system / CHARS_PER_TOKEN),
    tools: Math.floor(fixed.tools / CHARS_PER_TOKEN),
    memory: Math.floor(fixed.memory / CHARS_PER_TOKEN),
    skills: Math.floor(fixed.skills / CHARS_PER_TOKEN),
  }
  const estTotal = est.system + est.tools + est.memory + est.skills
  // Pi reports 0 until the first reply; show the fixed parts that request will carry.
  const used = usage.tokens === 0 ? estTotal : usage.tokens
  const scale = estTotal > used ? used / estTotal : 1
  const parts = new Map<CategoryKey, number>()
  for (const [k, v] of Object.entries(est)) parts.set(k as CategoryKey, Math.floor(v * scale))
  const fixedTotal = [...parts.values()].reduce((a, b) => a + b, 0)
  parts.set('messages', used - fixedTotal)
  const left = Math.max(0, windowTokens - used)
  const piAt = compaction.enabled ? windowTokens - compaction.reserveTokens : null
  const off = compaction.offloadAtTokens
  // Offload fires first when its trigger is below Pi compaction; then Pi's reserve is not shown.
  const isOffload = off !== undefined && (piAt === null || off < piAt)
  const hasBuffer = compaction.enabled && !isOffload
  const buffer = hasBuffer ? Math.min(compaction.reserveTokens, left) : 0
  parts.set('free', left - buffer)
  if (hasBuffer) parts.set('buffer', buffer)
  return {
    usedTokens: used,
    windowTokens,
    percent: share(used, windowTokens),
    thresholdTokens: isOffload ? off : piAt,
    isAutoCompactEnabled: isOffload || compaction.enabled,
    rows: CATEGORY_ORDER.flatMap(key => {
      const tokens = parts.get(key)
      return tokens === undefined ? [] : [{ key, label: CATEGORY_STYLES[key].label, tokens, percent: share(tokens, windowTokens) }]
    }),
  }
}
