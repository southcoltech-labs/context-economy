// SPDX-License-Identifier: Apache-2.0

import type { MessageItem } from '../../plugins/context-bar/hooks/split'
import { inspectable } from '../../plugins/context-bar/hooks/walk'
import type { Convert } from '../../plugins/context-bar/hooks/walk'

type Block = { type?: string; text?: string; name?: string; arguments?: unknown; id?: string }
type Msg = Record<string, unknown> & { role?: string }

const blocksOf = (content: unknown): Block[] => (Array.isArray(content) ? (content as Block[]) : [])

/** Text length of a message content: a string, or the text blocks (images and thinking are not counted). */
const textChars = (content: unknown): number => {
  if (typeof content === 'string') return content.length
  return blocksOf(content).reduce((n, b) => n + (b.type === 'text' && typeof b.text === 'string' ? b.text.length : 0), 0)
}

const text = (chars: number, role: 'user' | 'assistant'): MessageItem[] => (chars > 0 ? [{ kind: 'text', chars, role }] : [])

/** Pairing memory that lives across refreshes: a result added later still finds its call. */
export type PiItemState = { commands: Map<string, string>; targets: Map<string, string> } // toolCallId -> bash command / read target
export const newPiItemState = (): PiItemState => ({ commands: new Map(), targets: new Map() })

/** Map the message list the model sees (Pi `AgentMessage`s) to split items. A message with an unknown role adds nothing; it never throws. */
export const piItems = (messages: readonly unknown[], state: PiItemState = newPiItemState()): MessageItem[] => {
  const { commands, targets } = state
  const items: MessageItem[] = []
  for (const raw of messages) {
    const m = (raw !== null && typeof raw === 'object' ? raw : {}) as Msg
    switch (m.role) {
      case 'user':
      case 'custom':
        items.push(...text(textChars(m.content), 'user'))
        break
      case 'assistant':
        items.push(...text(textChars(m.content), 'assistant'))
        for (const b of blocksOf(m.content)) {
          if (b.type !== 'toolCall') continue
          const args = b.arguments as { command?: unknown } | undefined
          if (b.id !== undefined) {
            if (b.name === 'bash' && inspectable(args?.command)) commands.set(b.id, args.command)
            const target = b.name === 'read' ? args?.path : (b.name === 'grep' || b.name === 'find') ? args?.pattern : undefined
            if (typeof target === 'string') targets.set(b.id, target)
          }
          items.push({ kind: 'call', chars: JSON.stringify(b.arguments).length, tool: b.name })
        }
        break
      case 'toolResult': {
        const command = commands.get(m.toolCallId as string)
        items.push({ kind: 'result', chars: textChars(m.content), tool: m.toolName as string, ...(m.toolName === 'bash' && command !== undefined ? { command } : {}), ...(targets.get(m.toolCallId as string) !== undefined ? { target: targets.get(m.toolCallId as string)! } : {}) })
        break
      }
      case 'compactionSummary':
      case 'branchSummary':
        items.push(...text(textChars(m.summary), 'user'))
        break
      case 'bashExecution':
        if (m.excludeFromContext !== true) items.push({ kind: 'result', chars: String(m.output).length, tool: 'bash', ...(inspectable(m.command) ? { command: m.command } : {}) })
        break
      case 'system': // Pi 1.4: prompt and tool declarations; counted by the fixed split
        break
      default: // an unknown role adds nothing
        break
    }
  }
  return items
}

export const convertPi: Convert<PiItemState> = (messages, state) => {
  const kept = state ?? newPiItemState()
  return { items: piItems(messages, kept), state: kept }
}
