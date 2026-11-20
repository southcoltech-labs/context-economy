// SPDX-License-Identifier: Apache-2.0

import type { ContextBreakdownDetail } from 'claude-code'

export const COMMAND = 'context-bar'
/** `CE_CONTEXT_BAR=off` turns the whole plugin off: nothing is registered, no command, no band, no event. Only the exact value `off` counts. */
export const isContextBarOff = (env: Record<string, string | undefined>): boolean => env.CE_CONTEXT_BAR === 'off'
export const COMMAND_DESCRIPTION = 'Toggle the context band; r = refresh it now'
export const REFRESH_ARG = 'r'
export const TOP_ARG = 'top'
export const TOP_DEFAULT_COUNT = 5
export const TOP_LABEL_MAX = 48
export const TEXT_ON = 'Context band on.'
export const TEXT_OFF = 'Context band off.'
export const TEXT_SWITCHED_OFF = 'context-bar is switched off (CE_CONTEXT_BAR=off).'
export const TEXT_REFRESHED = 'Context band refreshed.'
export const TEXT_USAGE = 'Usage: /context-bar [r|top|min|norm|max]'
export const TEXT_LABEL_CHANGED = (level: string): string => `Context band: ${level} labels.`
export const STATIC_KEYS = ['system', 'tools', 'mcp', 'agents', 'memory', 'skills'] as const

/** `summary` estimates locally and sends no token-count requests (no plugin-initiated network calls). */
export const BREAKDOWN_DETAIL: ContextBreakdownDetail = 'summary'

export const HEADER = '◆ context'
export const NOT_AVAILABLE = 'n/a'
export const COMPACT_LABEL = 'compacts at'
export const COMPACT_OFF_LABEL = 'autocompact off'
export const WINDOW_JOINER = 'of'
export const SEPARATOR = ' · '
/** Footer under the legend: the row sizes inside Messages are estimates; the total and the fixed rows are the engine's. */
export const DISTRIBUTION_NOTE = 'distribution est.'
export const NOTE_SEPARATOR = ' - '

export const STATIC_BAR_CHAR = '█'
export const BAR_CHAR = '▓'
export const EMPTY_BAR_CHAR = '░'
export const MARKER_CHAR = '│'
export const SQUARE_CHAR = '■'
export const MARKER_COLOR = 'white'
export const PREFIX_MARKER_CHAR = '┃'
export const PREFIX_MARKER_COLOR = 'cyan'
export const PREFIX_TEXT = 'prefix'
export const HEADER_COLOR = 'cyan'
export const ERROR_COLOR = 'red'

export const TOKENS_PER_K = 1000
export const TOKENS_PER_M = 1000000
export const PERCENT_DECIMALS = 1
export const TINY_PERCENT_LABEL = '<0.1%'
export const K_DECIMALS_BELOW = 100 // under 100k show one decimal (8.2k)
export const FULL_PERCENT = 100

export const BADGE_WARN_PERCENT = 70
export const BADGE_CRITICAL_PERCENT = 90
export const BADGE_OK_COLOR = 'green'
export const BADGE_WARN_COLOR = 'yellow'
export const BADGE_CRITICAL_COLOR = 'red'

export type CategoryKey =
  | 'static'
  | 'chat'
  | 'tool'
  | 'system'
  | 'tools'
  | 'mcp'
  | 'agents'
  | 'memory'
  | 'skills'
  | 'messages'
  | 'prompt'
  | 'reply'
  | 'toolIn'
  | 'toolOut'
  | 'writes'
  | 'reads'
  | 'free'
  | 'other'
  | 'buffer'

export type CategoryStyle = { label: string }

/** Order = stack order in the bar and legend. */
export const CATEGORY_ORDER: readonly CategoryKey[] = [
  'static', 'system', 'tools', 'mcp', 'agents', 'memory', 'skills', 'messages', 'chat', 'prompt', 'reply', 'tool', 'toolIn', 'toolOut', 'writes', 'reads', 'other', 'free', 'buffer',
]

export const CATEGORY_STYLES: Readonly<Record<CategoryKey, CategoryStyle>> = {
  static: { label: 'Static prefix' },
  chat: { label: 'Chat' },
  tool: { label: 'Tools' },
  system: { label: 'System' },
  tools: { label: 'Tool defs' },
  mcp: { label: 'MCP' },
  agents: { label: 'Agent defs' },
  memory: { label: 'AGENTS.md' },
  skills: { label: 'Skills' },
  messages: { label: 'Messages' },
  prompt: { label: 'User prompt' },
  reply: { label: 'Replies' },
  toolIn: { label: 'Tool in' },
  toolOut: { label: 'Tool out' },
  writes: { label: 'Writes' },
  reads: { label: 'Reads' },
  other: { label: 'Other' },
  free: { label: 'Free' },
  buffer: { label: 'Buffer' },
}

/** /context row names (lowercase) -> category. */
export const NAME_TO_KEY: Readonly<Record<string, CategoryKey>> = {
  'system prompt': 'system',
  'system tools': 'tools',
  'mcp tools': 'mcp',
  'custom agents': 'agents',
  'memory files': 'memory',
  skills: 'skills',
  messages: 'messages',
  'free space': 'free',
  'autocompact buffer': 'buffer',
}

export const LEGEND_COLUMN_GAP = 3
export const LEGEND_FIELD_GAP = 2
export const LEGEND_SQUARE_WIDTH = 2 // square + one space

export const FILE_READ_TOOLS = ['Read', 'NotebookRead', 'read'] as const
export const WRITE_TOOLS = ['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'edit', 'write', 'apply_patch'] as const
export const FILE_READ_COMMANDS = ['cat', 'head', 'tail', 'sed', 'nl', 'bat', 'less'] as const
export const READ_FILTERS = ['head', 'tail', 'grep', 'rg', 'cut', 'wc', 'sort', 'uniq', 'nl'] as const
export const CHARS_PER_TOKEN_RESULT = 2.0
export const CHARS_PER_TOKEN_OTHER = 2.5
export const DEFAULT_REFRESH_GROWTH_PERCENT = 5
/** @deprecated Compatibility for the v0.5.0 shared config test surface. */
export const DEFAULT_REFRESH_EVERY_ROUNDS = DEFAULT_REFRESH_GROWTH_PERCENT

export const AGO_MINUTE_MS = 60_000
export const AGO_HOUR_MS = 60 * AGO_MINUTE_MS
export const AGO_DAY_MS = 24 * AGO_HOUR_MS

export const ANSI_RESET = '\x1b[0m'
export const ANSI_BOLD = '\x1b[1m'
export const ANSI_DIM = '\x1b[2m'
export const ANSI_ITALIC = '\x1b[3m'
export const ANSI_INVERSE = '\x1b[7m'
export const NAMED_COLORS: Readonly<Record<string, string>> = { cyan: '#00d7ff', red: '#ff5f5f', green: '#5fd75f', yellow: '#ffd75f', white: '#ffffff' }
export const HEX_COLOR = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i

export const GAP_KEY = 'gap'
export const GAP_CHAR = ' '
