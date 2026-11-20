// SPDX-License-Identifier: Apache-2.0

import type { SessionMessage } from 'claude-code'
import type { MessageItem } from './split'
import { inspectable } from './walk'
import type { Convert } from './walk'

type Call = { tool: string; command?: string; target?: string; result?: string }
/** Pairing memory that lives across refreshes: a result added later still finds its call. */
export type ItemState = { calls: Map<string, Call>; emitted: Set<string> }
export const newItemState = (): ItemState => ({ calls: new Map(), emitted: new Set() })

/** Convert Claude's message transcript into the shared split contract. A message with an unknown role adds nothing; it never throws. */
export const toItems = (messages: SessionMessage[], state: ItemState = newItemState()): MessageItem[] => {
  const items: MessageItem[] = []
  const { calls, emitted } = state
  for (const message of messages) {
    if (typeof message.text === 'string' && message.text.length > 0) {
      if (message.role === 'user' || message.role === 'assistant') items.push({ kind: 'text', chars: message.text.length, role: message.role })
    }
    for (const use of message.toolUses ?? []) {
      const tool = typeof use.tool === 'string' ? use.tool : undefined
      const input = use.input
      const chars = JSON.stringify(input ?? '').length
      const command = tool === 'Bash' && inspectable(input?.command) ? input.command : undefined
      const target = (tool === 'Read' || tool === 'NotebookRead') && typeof input?.file_path === 'string' ? input.file_path
        : (tool === 'Grep' || tool === 'Glob') && typeof input?.pattern === 'string' ? input.pattern : undefined
      const id = typeof use.tool_use_id === 'string' ? use.tool_use_id : undefined
      if (id) calls.set(id, { tool: tool ?? '', command, target, ...(typeof use.text === 'string' ? { result: use.text } : {}) })
      items.push({ kind: 'call', chars, ...(tool ? { tool } : {}) })
    }
    for (const result of message.toolResults ?? []) {
      const id = typeof result.tool_use_id === 'string' ? result.tool_use_id : undefined
      const found = id ? calls.get(id) : undefined
      if (id && emitted.has(id)) continue
      const text = typeof result.text === 'string' ? result.text : ''
      items.push({ kind: 'result', chars: text.length, ...(found?.tool ? { tool: found.tool } : {}), ...(found?.command ? { command: found.command } : {}), ...(found?.target ? { target: found.target } : {}) })
      if (id) emitted.add(id)
    }
  }
  for (const [id, call] of calls) {
    if (!emitted.has(id) && call.result !== undefined) {
      items.push({ kind: 'result', chars: call.result.length, ...(call.tool ? { tool: call.tool } : {}), ...(call.command ? { command: call.command } : {}), ...(call.target ? { target: call.target } : {}) })
      emitted.add(id)
      call.result = undefined
    }
  }
  return items
}

export const convertClaude: Convert<ItemState> = (messages, state) => {
  const kept = state ?? newItemState()
  return { items: toItems(messages as SessionMessage[], kept), state: kept }
}
