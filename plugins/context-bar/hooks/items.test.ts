// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'claude-code/testing'
import { classify } from './split'
import { toItems } from './items'

// Real engine shape: SessionMessage = { role, text, toolUses[], toolResults? }.
const READ_INPUT = { file_path: 'x' }
const CAT_INPUT = { command: 'cat x' }
const RG_INPUT = { command: 'rg x' }
const GREP_INPUT = { pattern: 'x' }
const len = (input: unknown): number => JSON.stringify(input).length

const assistantWithCalls = {
  role: 'assistant',
  text: 'answer',
  toolUses: [
    { tool_use_id: 'read-1', tool: 'Read', input: READ_INPUT },
    { tool_use_id: 'bash-cat', tool: 'Bash', input: CAT_INPUT },
    { tool_use_id: 'bash-rg', tool: 'Bash', input: RG_INPUT },
    { tool_use_id: 'grep-1', tool: 'Grep', input: GREP_INPUT },
  ],
}

const userWithResults = {
  role: 'user',
  text: 'question',
  toolUses: [],
  toolResults: [
    { tool_use_id: 'read-1', text: 'file contents', isError: false },
    { tool_use_id: 'bash-cat', text: 'cat output', isError: false },
    { tool_use_id: 'bash-rg', text: 'rg output', isError: false },
    { tool_use_id: 'grep-1', text: 'grep output', isError: false },
  ],
}

test('toItems: text, then calls in order, then results in order', () => {
  const items = toItems([assistantWithCalls, userWithResults] as never)
  expect(items).toEqual([
    { kind: 'text', role: 'assistant', chars: 6 },
    { kind: 'call', chars: len(READ_INPUT), tool: 'Read' },
    { kind: 'call', chars: len(CAT_INPUT), tool: 'Bash' },
    { kind: 'call', chars: len(RG_INPUT), tool: 'Bash' },
    { kind: 'call', chars: len(GREP_INPUT), tool: 'Grep' },
    { kind: 'text', role: 'user', chars: 8 },
    { kind: 'result', chars: 13, tool: 'Read', target: 'x' },
    { kind: 'result', chars: 10, tool: 'Bash', command: 'cat x' },
    { kind: 'result', chars: 9, tool: 'Bash', command: 'rg x' },
    { kind: 'result', chars: 11, tool: 'Grep', target: 'x' },
  ])
})

test('toItems: Read and cat results classify as reads, rg and Grep as toolOut, text by role, calls as toolIn', () => {
  const items = toItems([assistantWithCalls, userWithResults] as never)
  expect(items.filter(i => i.kind === 'result').map(classify)).toEqual([
    'reads', 'reads', 'toolOut', 'toolOut',
  ])
  expect(items.filter(i => i.kind === 'text').map(classify)).toEqual(['reply', 'prompt'])
  expect(items.filter(i => i.kind === 'call').map(classify)).toEqual(['toolIn', 'toolIn', 'toolIn', 'toolIn'])
})

test('toItems: Read and search calls set targets on result items', () => {
  const items = toItems([
    { role: 'assistant', text: '', toolUses: [
      { tool_use_id: 'r', tool: 'Read', input: { file_path: 'src/a.ts' } },
      { tool_use_id: 'n', tool: 'NotebookRead', input: { file_path: 'notes.ipynb' } },
      { tool_use_id: 'g', tool: 'Grep', input: { pattern: 'needle' } },
      { tool_use_id: 'b', tool: 'Glob', input: { pattern: '**/*.ts' } },
      { tool_use_id: 'x', tool: 'Bash', input: { command: 'ls' } },
    ] },
    { role: 'user', text: '', toolUses: [], toolResults: [
      ...['r', 'n', 'g', 'b', 'x'].map(tool_use_id => ({ tool_use_id, text: 'out', isError: false })),
    ] },
  ] as never)
  expect(items.filter(item => item.kind === 'result')).toEqual([
    { kind: 'result', chars: 3, tool: 'Read', target: 'src/a.ts' },
    { kind: 'result', chars: 3, tool: 'NotebookRead', target: 'notes.ipynb' },
    { kind: 'result', chars: 3, tool: 'Grep', target: 'needle' },
    { kind: 'result', chars: 3, tool: 'Glob', target: '**/*.ts' },
    { kind: 'result', chars: 3, tool: 'Bash', command: 'ls' }, // Bash keeps command (v0.2), no target
  ])
})

test('toItems: empty text adds no text item', () => {
  const items = toItems([{ role: 'user', text: '', toolUses: [] }] as never)
  expect(items).toEqual([])
})

test('toItems: command is set only for a Bash call whose input.command is a string', () => {
  const items = toItems([
    { role: 'assistant', text: '', toolUses: [
      { tool_use_id: 'a', tool: 'Bash', input: { command: 42 } },
      { tool_use_id: 'b', tool: 'Read', input: { command: 'cat x' } },
    ] },
    { role: 'user', text: '', toolUses: [], toolResults: [
      { tool_use_id: 'a', text: 'aa', isError: false },
      { tool_use_id: 'b', text: 'bb', isError: false },
    ] },
  ] as never)
  const results = items.filter(i => i.kind === 'result')
  expect(results).toEqual([
    { kind: 'result', chars: 2, tool: 'Bash' },
    { kind: 'result', chars: 2, tool: 'Read' },
  ])
})

test('toItems: a result with no matching call has no tool and classifies as toolOut', () => {
  const items = toItems([
    { role: 'user', text: '', toolUses: [], toolResults: [
      { tool_use_id: 'ghost', text: 'orphan', isError: false },
    ] },
  ] as never)
  expect(items).toEqual([{ kind: 'result', chars: 6 }])
  expect(classify(items[0]!)).toBe('toolOut')
})

test('toItems: answered toolUses give result items right after their calls when toolResults are absent', () => {
  const items = toItems([
    { role: 'assistant', text: 'hi', toolUses: [
      { tool_use_id: 'r', tool: 'Read', input: READ_INPUT, text: 'contents' },
      { tool_use_id: 'b', tool: 'Bash', input: CAT_INPUT, text: 'out' },
    ] },
  ] as never)
  expect(items).toEqual([
    { kind: 'text', role: 'assistant', chars: 2 },
    { kind: 'call', chars: len(READ_INPUT), tool: 'Read' },
    { kind: 'call', chars: len(CAT_INPUT), tool: 'Bash' },
    { kind: 'result', chars: 8, tool: 'Read', target: 'x' },
    { kind: 'result', chars: 3, tool: 'Bash', command: 'cat x' },
  ])
})

test('toItems: a later user toolResults entry with the same id is counted once, not twice', () => {
  const items = toItems([
    { role: 'assistant', text: '', toolUses: [
      { tool_use_id: 'r', tool: 'Read', input: READ_INPUT, text: 'contents' },
    ] },
    { role: 'user', text: '', toolUses: [], toolResults: [
      { tool_use_id: 'r', text: 'contents', isError: false },
    ] },
  ] as never)
  expect(items.filter(i => i.kind === 'result')).toEqual([
    { kind: 'result', chars: 8, tool: 'Read', target: 'x' },
  ])
})

test('toItems: a call without a text answer and without a result adds only the call', () => {
  const items = toItems([
    { role: 'assistant', text: '', toolUses: [
      { tool_use_id: 'r', tool: 'Read', input: READ_INPUT },
    ] },
  ] as never)
  expect(items).toEqual([{ kind: 'call', chars: len(READ_INPUT), tool: 'Read' }])
})

test('toItems v0.4: text items carry the message role (user, assistant)', () => {
  const items = toItems([
    { role: 'user', text: 'hello', toolUses: [] },
    { role: 'assistant', text: 'hi there', toolUses: [] },
  ] as never)
  expect(items).toEqual([
    { kind: 'text', role: 'user', chars: 5 },
    { kind: 'text', role: 'assistant', chars: 8 },
  ])
  expect(items.map(classify)).toEqual(['prompt', 'reply'])
})

test('a message with an unknown role adds nothing and never throws', () => {
  expect(toItems([{ role: 'system', text: 'x', toolUses: [] }] as never)).toEqual([])
  expect(toItems([{ role: 7, text: 'x' }, { role: 'user', text: 'hello' }] as never)).toEqual([{ kind: 'text', chars: 5, role: 'user' }])
})

test('malformed messages never throw: no text, no arrays, odd tool fields', () => {
  expect(() => toItems([{ role: 'user' }, { role: 'assistant', text: 5, toolUses: 'x', toolResults: null }, {}] as never)).not.toThrow()
  expect(() => toItems([{ role: 'assistant', text: '', toolUses: [{ tool: 3, input: null, tool_use_id: 9 }], toolResults: [{ text: 4 }] }] as never)).not.toThrow()
})

test('a command over 1 MiB is never inspected: it is sized by length and counts as tool output', () => {
  const huge = `cat ${'x'.repeat(1_048_577)}`
  const items = toItems([
    { role: 'assistant', text: '', toolUses: [{ tool: 'Bash', input: { command: huge }, tool_use_id: 't1' }] },
    { role: 'user', text: '', toolResults: [{ tool_use_id: 't1', text: 'out' }] },
  ] as never)
  const result = items.find(i => i.kind === 'result')!
  expect(result.command).toBeUndefined()
  expect(classify(result)).toBe('toolOut')
})

test('malformed containers and elements add only what is well formed and never throw', () => {
  const bad = [null, undefined, 5, 'x', [], {}, { role: 'user', text: 'ok' }, { role: 'assistant', toolUses: [null, 3, { tool: 'Bash', input: 'x', tool_use_id: 1 }], toolResults: [null, 'r', { text: 5 }] }, { role: 'user', toolUses: 'x', toolResults: { a: 1 } }]
  const items = toItems(bad as never)
  expect(items.filter(i => i.kind === 'text')).toEqual([{ kind: 'text', chars: 2, role: 'user' }])
  expect(() => toItems(null as never)).not.toThrow()
  expect(() => toItems({ length: 3 } as never)).not.toThrow()
})

test('a message with an unknown role adds nothing, its tool fields included', () => {
  const items = toItems([{ role: 'tool', text: 'x', toolUses: [{ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'a' }], toolResults: [{ tool_use_id: 'a', text: 'out' }] }] as never)
  expect(items).toEqual([])
})
