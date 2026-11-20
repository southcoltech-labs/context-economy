// SPDX-License-Identifier: Apache-2.0

import { CATEGORY_STYLES, FULL_PERCENT, CHARS_PER_TOKEN_OTHER, CHARS_PER_TOKEN_RESULT, FILE_READ_COMMANDS, FILE_READ_TOOLS, READ_FILTERS, WRITE_TOOLS } from './config'
import type { CategoryKey } from './config'
import type { LegendRow } from '../types'

const PERCENT_SCALE = 10

/** `read` is set by a walk instead of the command text: whether the command was only read commands. The walk keeps no command text. */
export type MessageItem = { kind: 'text' | 'call' | 'result'; chars: number; role?: 'user' | 'assistant'; tool?: string; command?: string; target?: string; read?: boolean }
export type SplitKey = 'prompt' | 'reply' | 'toolIn' | 'toolOut' | 'writes' | 'reads'
export type MessageSplit = Record<SplitKey, number>
/** Split rows in display order; also the remainder tie order. */
export const SPLIT_KEYS: readonly SplitKey[] = ['prompt', 'reply', 'toolIn', 'toolOut', 'writes', 'reads']

export const commandIsRead = (command: string): boolean => {
  if (/[`$]|>|<\(/.test(command) || /\|\|/.test(command)) return false
  const steps = command.split(/&&|;/).map(s => s.trim()).filter(Boolean)
  while (steps.length && /^cd\s+\S+$/.test(steps[0]!)) steps.shift()
  if (!steps.length) return false
  const readStage = (stage: string): boolean => {
    const words = stage.trim().split(/\s+/)
    const name = words[0]
    if (!FILE_READ_COMMANDS.some(cmd => name === cmd) || (name === 'sed' && words[1] !== '-n')) return false
    return true
  }
  return steps.every(step => {
    const stages = step.split('|')
    return readStage(stages[0]!) && stages.slice(1).every(stage => READ_FILTERS.includes(stage.trim().split(/\s+/)[0] as typeof READ_FILTERS[number]))
  })
}

export const classify = (item: MessageItem): SplitKey => {
  if (!item || !['text', 'call', 'result'].includes(item.kind) || !Number.isFinite(item.chars) || item.chars < 0) throw new Error('context-bar: invalid message item')
  if (item.kind === 'text') {
    if (item.role !== 'user' && item.role !== 'assistant') throw new Error('context-bar: invalid message item')
    return item.role === 'user' ? 'prompt' : 'reply'
  }
  if (item.kind === 'call') return item.tool && WRITE_TOOLS.includes(item.tool as typeof WRITE_TOOLS[number]) ? 'writes' : 'toolIn'
  if ((item.tool && FILE_READ_TOOLS.includes(item.tool as typeof FILE_READ_TOOLS[number])) || item.read === true || (item.command && commandIsRead(item.command))) return 'reads'
  return 'toolOut'
}

/** Estimated tokens per split row before they are scaled to the messages total. Sums add, so a refresh can add only new messages. */
export type RawSplit = Record<SplitKey, number>
export const emptyRaw = (): RawSplit => Object.fromEntries(SPLIT_KEYS.map(k => [k, 0])) as RawSplit
export const rawSplit = (items: readonly MessageItem[]): RawSplit => {
  const raw = emptyRaw()
  for (const item of items) raw[classify(item)] += item.chars / (item.kind === 'result' ? CHARS_PER_TOKEN_RESULT : CHARS_PER_TOKEN_OTHER)
  return raw
}
export const addRaw = (a: RawSplit, b: RawSplit): RawSplit => Object.fromEntries(SPLIT_KEYS.map(k => [k, a[k] + b[k]])) as RawSplit

export const splitFromRaw = (raw: RawSplit, total: number): MessageSplit => {
  if (!Number.isInteger(total) || total < 0) throw new Error('context-bar: message total must be a non-negative integer')
  const keys = SPLIT_KEYS
  const sum = keys.reduce((n, k) => n + raw[k], 0)
  if (sum === 0) return { prompt: total, reply: 0, toolIn: 0, toolOut: 0, writes: 0, reads: 0 }
  const exact = Object.fromEntries(keys.map(k => [k, raw[k] * total / sum])) as MessageSplit
  const out = Object.fromEntries(keys.map(k => [k, Math.floor(exact[k])])) as MessageSplit
  const ranked = [...keys].sort((a, b) => (exact[b] - Math.floor(exact[b])) - (exact[a] - Math.floor(exact[a])) || keys.indexOf(a) - keys.indexOf(b))
  const remainder = total - keys.reduce((n, k) => n + out[k], 0)
  for (let i = 0; i < remainder; i++) out[ranked[i]!] += 1
  return out
}

export const splitMessages = (items: readonly MessageItem[], total: number): MessageSplit => {
  if (!Number.isInteger(total) || total < 0) throw new Error('context-bar: message total must be a non-negative integer')
  return splitFromRaw(rawSplit(items), total)
}

export const applySplit = <T extends LegendRow>(rows: readonly T[], split: MessageSplit, total: number): (T | LegendRow)[] => {
  const index = rows.findIndex(r => r.key === 'messages')
  if (index < 0) throw new Error('context-bar: messages row is missing')
  const messageTotal = rows[index]!.tokens
  const keys = SPLIT_KEYS
  if (Object.values(split).some(n => !Number.isInteger(n) || n < 0) || keys.reduce((n, k) => n + split[k], 0) !== messageTotal) throw new Error('context-bar: split total does not match messages row')
  // Writes is the one split row hidden at zero: most sessions never write through a file tool (view.test.ts pins five rows then).
  const replacements = keys.filter(key => key !== 'writes' || split.writes > 0).map(key => ({ key, label: CATEGORY_STYLES[key as CategoryKey].label, tokens: split[key], percent: total === 0 ? 0 : Math.round(split[key] / total * FULL_PERCENT * PERCENT_SCALE) / PERCENT_SCALE }))
  return [...rows.slice(0, index), ...replacements, ...rows.slice(index + 1)]
}
