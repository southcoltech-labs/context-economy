// SPDX-License-Identifier: Apache-2.0

import { CATEGORY_STYLES, CHARS_PER_TOKEN_OTHER, CHARS_PER_TOKEN_RESULT, TOP_LABEL_MAX } from './config'
import type { CategoryKey } from './config'
import { formatTokens } from './format'
import { classify } from './split'
import type { MessageItem, SplitKey } from './split'

export type TopRow = { kind: SplitKey; label: string; tokens: number }

const cleanLabel = (label: string): string => {
  const collapsed = label.replace(/\s+/g, ' ').trim()
  return collapsed.length > TOP_LABEL_MAX ? `${collapsed.slice(0, TOP_LABEL_MAX - 1)}…` : collapsed
}

/** The only command names `/context-bar top` may show. Anything else is shown as the tool name, never as typed text. */
export const SHOWN_COMMANDS: ReadonlySet<string> = new Set([
  'git', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'node', 'deno', 'tsc', 'python', 'python3', 'pip', 'pip3', 'uv', 'cargo', 'rustc', 'go', 'make', 'cmake',
  'ls', 'cat', 'head', 'tail', 'sed', 'awk', 'grep', 'rg', 'fd', 'find', 'wc', 'sort', 'diff', 'tree', 'pwd', 'cd', 'echo', 'mkdir', 'cp', 'mv', 'rm', 'touch',
  'curl', 'wget', 'docker', 'kubectl', 'gh', 'jq', 'test', 'bash', 'sh',
])

const NAME_SHAPE = /^[A-Za-z0-9._+-]{1,32}$/
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/**
 * One command name, by a fixed rule: skip leading NAME=value words, take the next word's last path part. It is shown only if it has
 * the plain shape and is in SHOWN_COMMANDS. Arguments, URLs, paths and unknown words are never shown: undefined means show `Bash` alone.
 */
export const shownCommand = (command: string): string | undefined => {
  const words = command.trim().split(/\s+/)
  let at = 0
  while (at < words.length && ASSIGNMENT.test(words[at]!)) at += 1
  const word = words[at]
  if (word === undefined || word === '') return undefined
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(word)) return undefined // a URL (https://…/git) or any scheme: never a command name
  const name = word.slice(word.lastIndexOf('/') + 1)
  return NAME_SHAPE.test(name) && SHOWN_COMMANDS.has(name) ? name : undefined
}

const itemLabel = (item: MessageItem): string => {
  if (item.kind === 'text') return item.role === 'user' ? 'user text' : 'reply text'
  const tool = item.tool || 'tool'
  if (item.kind === 'call') return `${tool} call`
  const detail = item.command === undefined ? item.target : shownCommand(item.command)
  return `${tool}${detail ? ` ${detail}` : ''}`
}

export const topItems = (items: readonly MessageItem[], n: number): TopRow[] => {
  if (!Number.isInteger(n) || n < 1) throw new Error('context-bar: invalid top count')
  const rows = items.map((item, index) => ({
    row: {
      kind: classify(item),
      label: cleanLabel(itemLabel(item)),
      tokens: Math.round(item.chars / (item.kind === 'result' ? CHARS_PER_TOKEN_RESULT : CHARS_PER_TOKEN_OTHER)),
    },
    index,
  })).filter(({ row }) => row.tokens > 0)
  rows.sort((a, b) => b.row.tokens - a.row.tokens || a.index - b.index)
  return rows.slice(0, n).map(({ row }) => row) // exactly n rows; equal sizes keep the order they have in the transcript
}

/** `omitted` is how many older messages were left out (the walk limit): the list then says so. */
export const topLines = (rows: readonly TopRow[], omitted = 0): string[] => {
  if (rows.length === 0) return [omitted > 0 ? `top items: none in the latest messages (${omitted} older not read)` : 'top items: none yet']
  return [
    omitted > 0 ? `top items (≈ tokens, latest messages only: ${omitted} older not read)` : 'top items (≈ tokens)',
    ...rows.map(row => `${formatTokens(row.tokens).padStart(6)}  ${CATEGORY_STYLES[row.kind as CategoryKey].label.padEnd(11)}  ${row.label}`),
  ]
}
