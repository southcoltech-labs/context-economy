// SPDX-License-Identifier: Apache-2.0

import { commandIsRead } from '../../plugins/context-bar/hooks/split'
import type { MessageItem } from '../../plugins/context-bar/hooks/split'
import { boundedJsonLength, inspectable, mix } from '../../plugins/context-bar/hooks/walk'
import type { Adapter } from '../../plugins/context-bar/hooks/walk'

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)

const blocksOf = (content: unknown): Rec[] => (Array.isArray(content) ? content.filter(isRec) : [])

/** Text length of a message content: a string, or the text blocks (images and thinking are not counted). */
const textChars = (content: unknown): number => {
  if (typeof content === 'string') return content.length
  return blocksOf(content).reduce((n, b) => n + (b.type === 'text' && typeof b.text === 'string' ? b.text.length : 0), 0)
}

const text = (chars: number, role: 'user' | 'assistant'): MessageItem[] => (chars > 0 ? [{ kind: 'text', chars, role }] : [])

/** A bash call waiting for its result. A walk keeps only whether the command was a read: no command text. */
type Pending = { read: boolean; command?: string; target?: string }
/** Pairing memory that lives across refreshes: a result added later still finds its call. `keepText` is for `/context-bar top`, which needs labels and lives for one call only. */
export type PiItemState = { pending: Map<string, Pending>; keepText: boolean } // toolCallId -> what the result needs
export const newPiItemState = (keepText = true): PiItemState => ({ pending: new Map(), keepText })

/**
 * Map the message list the model sees (Pi `AgentMessage`s) to split items. It never throws: anything that is not a message
 * object, a message with an unknown role (its tool fields too), and any malformed block or call adds nothing.
 */
export const piItems = (messages: unknown, state: PiItemState = newPiItemState()): MessageItem[] => {
  const { pending, keepText } = state
  const items: MessageItem[] = []
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!isRec(m)) continue
    switch (m.role) {
      case 'user':
      case 'custom':
        items.push(...text(textChars(m.content), 'user'))
        break
      case 'assistant':
        items.push(...text(textChars(m.content), 'assistant'))
        for (const b of blocksOf(m.content)) {
          if (b.type !== 'toolCall') continue
          const args = isRec(b.arguments) ? b.arguments : undefined
          if (typeof b.id === 'string') {
            const command = b.name === 'bash' && inspectable(args?.command) ? args!.command as string : undefined
            const target = b.name === 'read' ? args?.path : (b.name === 'grep' || b.name === 'find') ? args?.pattern : undefined
            const entry: Pending = { read: command !== undefined && commandIsRead(command) }
            if (keepText) {
              if (command !== undefined) entry.command = command
              if (typeof target === 'string') entry.target = target
            }
            if (command !== undefined || (keepText && typeof target === 'string')) pending.set(b.id, entry)
          }
          items.push({ kind: 'call', chars: boundedJsonLength(b.arguments), ...(typeof b.name === 'string' ? { tool: b.name } : {}) })
        }
        break
      case 'toolResult': {
        const id = typeof m.toolCallId === 'string' ? m.toolCallId : undefined
        const found = id === undefined ? undefined : pending.get(id)
        if (id !== undefined) pending.delete(id)
        items.push({
          kind: 'result',
          chars: textChars(m.content),
          ...(typeof m.toolName === 'string' ? { tool: m.toolName } : {}),
          ...(keepText ? { ...(m.toolName === 'bash' && found?.command !== undefined ? { command: found.command } : {}), ...(found?.target !== undefined ? { target: found.target } : {}) } : m.toolName === 'bash' && found?.read ? { read: true } : {}),
        })
        break
      }
      case 'compactionSummary':
      case 'branchSummary':
        items.push(...text(textChars(m.summary), 'user'))
        break
      case 'bashExecution':
        if (m.excludeFromContext !== true) {
          const read = inspectable(m.command) && commandIsRead(m.command)
          items.push({ kind: 'result', chars: String(m.output ?? '').length, tool: 'bash', ...(keepText ? (inspectable(m.command) ? { command: m.command } : {}) : read ? { read: true } : {}) })
        }
        break
      default: // `system` (Pi 1.4 prompt and tool declarations) is counted by the fixed split; an unknown role adds nothing
        break
    }
  }
  return items
}

/** Changes whenever a message's size-bearing parts change: role, content size and block count, ids and summary or output size. */
export const piSignature = (m: unknown): number => {
  if (!isRec(m)) return 0
  let h = mix(31, typeof m.role === 'string' ? m.role.length * 31 + m.role.charCodeAt(0) : 0)
  h = mix(h, textChars(m.content))
  h = mix(h, Array.isArray(m.content) ? m.content.length : -1)
  for (const b of blocksOf(m.content)) if (b.type === 'toolCall') h = mix(mix(h, typeof b.id === 'string' ? b.id.length : 0), boundedJsonLength(b.arguments))
  h = mix(h, typeof m.toolCallId === 'string' ? m.toolCallId.length : 0)
  h = mix(h, textChars(m.summary))
  h = mix(h, typeof m.output === 'string' ? m.output.length : 0)
  return mix(h, typeof m.command === 'string' ? m.command.length : 0)
}

/** The walk's text-free converter: keeps only pairing metadata. */
export const piAdapter: Adapter<PiItemState> = {
  convert: (messages, state) => {
    const kept = state ?? newPiItemState(false)
    return { items: piItems(messages, kept), state: kept }
  },
  signature: piSignature,
}
