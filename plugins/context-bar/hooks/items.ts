// SPDX-License-Identifier: Apache-2.0

import { commandIsRead } from './split'
import type { MessageItem } from './split'
import { argumentSignature, boundedJsonLength, hashText, inspectable, mix } from './walk'
import type { Adapter } from './walk'

type Rec = Record<string, unknown>
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/** A call waiting for its result. A walk keeps only the tool name, whether the command was a read, and the size of an inline result: no command, path or pattern. */
type Call = { tool: string; read: boolean; command?: string; target?: string; resultChars?: number }
/** Pairing memory that lives across refreshes: a result added later still finds its call. `keepText` is for `/context-bar top`, which needs labels and lives for one call only. */
export type ItemState = { calls: Map<string, Call>; emitted: Set<string>; keepText: boolean }
export const newItemState = (keepText = true): ItemState => ({ calls: new Map(), emitted: new Set(), keepText })

/**
 * Convert Claude's message transcript into the shared split contract. It never throws: a message that is not an object, or whose
 * role is not `user` or `assistant`, adds nothing (its tool fields too), and a malformed tool call or result adds nothing.
 */
export const toItems = (messages: unknown, state: ItemState = newItemState()): MessageItem[] => {
  const items: MessageItem[] = []
  const { calls, emitted, keepText } = state
  const resultItem = (chars: number, call: Call | undefined): MessageItem => ({
    kind: 'result',
    chars,
    ...(call?.tool ? { tool: call.tool } : {}),
    ...(keepText ? { ...(call?.command ? { command: call.command } : {}), ...(call?.target ? { target: call.target } : {}) } : call?.read ? { read: true } : {}),
  })
  for (const message of list(messages)) {
    if (!isRec(message) || (message.role !== 'user' && message.role !== 'assistant')) continue
    const text = str(message.text)
    if (text !== undefined && text.length > 0) items.push({ kind: 'text', chars: text.length, role: message.role })
    for (const use of list(message.toolUses)) {
      if (!isRec(use)) continue
      const tool = str(use.tool)
      const input = isRec(use.input) ? use.input : undefined
      const command = tool === 'Bash' && inspectable(input?.command) ? input!.command as string : undefined
      const file = str(input?.file_path)
      const pattern = str(input?.pattern)
      const target = (tool === 'Read' || tool === 'NotebookRead') && file !== undefined ? file : (tool === 'Grep' || tool === 'Glob') && pattern !== undefined ? pattern : undefined
      const id = str(use.tool_use_id)
      const inline = str(use.text)
      if (id) {
        calls.set(id, {
          tool: tool ?? '',
          read: command !== undefined && commandIsRead(command),
          ...(keepText ? { ...(command !== undefined ? { command } : {}), ...(target !== undefined ? { target } : {}) } : {}),
          ...(inline !== undefined ? { resultChars: inline.length } : {}),
        })
      }
      items.push({ kind: 'call', chars: boundedJsonLength(use.input ?? ''), ...(tool ? { tool } : {}) })
    }
    for (const result of list(message.toolResults)) {
      if (!isRec(result)) continue
      const id = str(result.tool_use_id)
      if (id && emitted.has(id)) continue
      items.push(resultItem((str(result.text) ?? '').length, id ? calls.get(id) : undefined))
      if (id) { emitted.add(id); calls.delete(id) }
    }
  }
  for (const [id, call] of calls) {
    if (!emitted.has(id) && call.resultChars !== undefined) {
      items.push(resultItem(call.resultChars, call))
      emitted.add(id)
      calls.delete(id)
    }
  }
  return items
}

/** Changes when what moves a message between rows changes: role, text length, each call's tool name, id, argument size and command, each result's id and size. */
export const signature = (message: unknown): number => {
  if (!isRec(message)) return 0
  let h = mix(mix(17, hashText(message.role)), (str(message.text) ?? '').length)
  const uses = list(message.toolUses)
  h = mix(h, uses.length)
  for (const use of uses) {
    if (!isRec(use)) { h = mix(h, -1); continue }
    const input = isRec(use.input) ? use.input : undefined
    h = mix(mix(mix(h, hashText(use.tool)), hashText(use.tool_use_id)), mix((str(use.text) ?? '').length, argumentSignature(use.input, input?.command)))
  }
  const results = list(message.toolResults)
  h = mix(h, results.length)
  for (const r of results) {
    if (!isRec(r)) { h = mix(h, -1); continue }
    h = mix(mix(h, (str(r.text) ?? '').length), hashText(r.tool_use_id))
  }
  return h
}

/** The walk's text-free converter: keeps only pairing metadata. */
export const claudeAdapter: Adapter<ItemState> = {
  convert: (messages, state) => {
    const kept = state ?? newItemState(false)
    return { items: toItems(messages, kept), state: kept }
  },
  signature,
}
