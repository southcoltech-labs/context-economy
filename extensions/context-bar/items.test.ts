// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'bun:test'
import { convertPi, piItems } from './items'
import type { PiItemState } from './items'
import { rawSplit, splitFromRaw } from '../../plugins/context-bar/hooks/split'
import { walkMessages } from '../../plugins/context-bar/hooks/walk'
import type { Walk } from '../../plugins/context-bar/hooks/walk'

describe('piItems', () => {
  test('maps visible user and assistant text, tool calls, and matched results', () => {
    const result = piItems([
      { role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'image', data: 'abc', mimeType: 'image/png' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'cat a.txt' } }] },
      { role: 'toolResult', toolCallId: 'c1', toolName: 'bash', content: [{ type: 'text', text: 'file' }, { type: 'image', data: 'abc', mimeType: 'image/png' }] },
    ])
    expect(result).toEqual([
      { kind: 'text', role: 'user', chars: 5 },
      { kind: 'text', role: 'assistant', chars: 2 },
      { kind: 'call', chars: JSON.stringify({ command: 'cat a.txt' }).length, tool: 'bash' },
      { kind: 'result', chars: 4, tool: 'bash', command: 'cat a.txt' },
    ])
  })

  test('sets targets for read, grep, and find results', () => {
    expect(piItems([
      { role: 'assistant', content: [
        { type: 'toolCall', id: 'r', name: 'read', arguments: { path: 'src/a.ts' } },
        { type: 'toolCall', id: 'g', name: 'grep', arguments: { pattern: 'needle' } },
        { type: 'toolCall', id: 'f', name: 'find', arguments: { pattern: '**/*.ts' } },
      ] },
      ...['r', 'g', 'f'].map((toolCallId, i) => ({ role: 'toolResult', toolCallId, toolName: ['read', 'grep', 'find'][i], content: [{ type: 'text', text: 'out' }] })),
    ])).toEqual([
      { kind: 'call', chars: JSON.stringify({ path: 'src/a.ts' }).length, tool: 'read' },
      { kind: 'call', chars: JSON.stringify({ pattern: 'needle' }).length, tool: 'grep' },
      { kind: 'call', chars: JSON.stringify({ pattern: '**/*.ts' }).length, tool: 'find' },
      { kind: 'result', chars: 3, tool: 'read', target: 'src/a.ts' },
      { kind: 'result', chars: 3, tool: 'grep', target: 'needle' },
      { kind: 'result', chars: 3, tool: 'find', target: '**/*.ts' },
    ])
  })

  test('skips empty text and treats compaction and branch summaries as user text', () => {
    expect(piItems([
      { role: 'user', content: [{ type: 'text', text: '' }] },
      { role: 'compactionSummary', summary: 'condensed' },
      { role: 'branchSummary', summary: 'branch' },
    ])).toEqual([{ kind: 'text', role: 'user', chars: 9 }, { kind: 'text', role: 'user', chars: 6 }])
  })

  test('bashExecution counts as a bash result with its command unless excluded', () => {
    expect(piItems([
      { role: 'bashExecution', command: 'rg foo', output: 'hits', exitCode: 0, cancelled: false, truncated: false, timestamp: 1 },
      { role: 'bashExecution', command: 'cat x', output: 'skip', exitCode: 0, cancelled: false, truncated: false, excludeFromContext: true, timestamp: 2 },
    ])).toEqual([{ kind: 'result', chars: 4, tool: 'bash', command: 'rg foo' }])
  })

  test('custom extension messages count their text content as user text (injected input)', () => {
    expect(piItems([
      { role: 'custom', customType: 'x', content: 'abc', display: true, timestamp: 1 },
      { role: 'custom', customType: 'y', content: [{ type: 'text', text: 'de' }], display: false, timestamp: 2 },
    ])).toEqual([{ kind: 'text', role: 'user', chars: 3 }, { kind: 'text', role: 'user', chars: 2 }])
  })

  test('v0.4 text roles: user and custom/compactionSummary/branchSummary are user, assistant is assistant', () => {
    const roles = piItems([
      { role: 'user', content: 'a' },
      { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
      { role: 'custom', customType: 'x', content: 'c', display: true, timestamp: 1 },
      { role: 'compactionSummary', summary: 'd' },
      { role: 'branchSummary', summary: 'e' },
    ]).map(i => (i as { role?: string }).role)
    expect(roles).toEqual(['user', 'assistant', 'user', 'user', 'user'])
  })

  test('v0.4 bash "cd /x && sed -n 1,5p f" result keeps its command for read detection', () => {
    expect(piItems([
      { role: 'assistant', content: [{ type: 'toolCall', id: 'c', name: 'bash', arguments: { command: 'cd /x && sed -n 1,5p f' } }] },
      { role: 'toolResult', toolCallId: 'c', toolName: 'bash', content: [{ type: 'text', text: 'out' }] },
    ])[1]).toEqual({ kind: 'result', chars: 3, tool: 'bash', command: 'cd /x && sed -n 1,5p f' })
  })

  test('Pi 1.4 system messages add no items: the fixed split already counts the prompt and tools', () => {
    expect(piItems([
      { role: 'system', content: 'You are helpful.', timestamp: 1 },
      { role: 'system', content: '', sections: { skills: '<skills>x</skills>' }, toolsAdded: [{ name: 't' }], timestamp: 2 },
      { role: 'user', content: 'hi' },
    ])).toEqual([{ kind: 'text', role: 'user', chars: 2 }])
  })

  test('an unknown role adds nothing and never throws', () => {
    expect(piItems([{ role: 'customMystery', content: 'x' }, { role: 'user', content: 'hi' }])).toEqual([{ kind: 'text', chars: 2, role: 'user' }])
  })

  test('malformed messages never throw', () => {
    expect(() => piItems([null, undefined, 5, 'x', {}, { role: 'assistant', content: 7 }, { role: 'toolResult' }, { role: 'bashExecution' }])).not.toThrow()
  })

  test('a bash command over 1 MiB is never inspected: it is sized by length and counts as tool output', () => {
    const huge = `cat ${'x'.repeat(1_048_577)}`
    const items = piItems([
      { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: huge } }] },
      { role: 'toolResult', toolCallId: 'c1', toolName: 'bash', content: [{ type: 'text', text: 'out' }] },
      { role: 'bashExecution', command: huge, output: 'out' },
    ])
    for (const item of items.filter(i => i.kind === 'result')) expect(item.command).toBeUndefined()
  })
})

describe('the walk on Pi', () => {
  const turn = (i: number): unknown[] => [
    { role: 'user', content: `question ${i}` },
    { role: 'assistant', content: [{ type: 'toolCall', id: `c${i}`, name: 'bash', arguments: { command: 'cat a.txt' } }] },
    { role: 'toolResult', toolCallId: `c${i}`, toolName: 'bash', content: [{ type: 'text', text: 'r'.repeat(10 + (i % 90)) }] },
  ]
  const session = (turns: number): unknown[] => Array.from({ length: turns }, (_, i) => turn(i)).flat()

  test('an incremental walk equals a full walk', () => {
    const all = session(200)
    let walk: Walk<PiItemState> | undefined
    for (let end = 3; end <= all.length; end += 5) walk = walkMessages(walk, all.slice(0, end), convertPi)
    walk = walkMessages(walk, all, convertPi)
    const full = rawSplit(piItems(all))
    for (const key of Object.keys(full) as (keyof typeof full)[]) expect(Math.abs(walk.raw[key] - full[key]) < 1e-6).toBe(true)
  })

  test('a refresh of a 5,000-message session adding a turn takes at most 25 ms at the 95th percentile', () => {
    let all = session(1667)
    let walk = walkMessages(undefined, all, convertPi)
    const times: number[] = []
    for (let i = 0; i < 100; i++) {
      all = [...all, ...turn(2000 + i)]
      const t0 = performance.now()
      walk = walkMessages(walk, all, convertPi)
      splitFromRaw(walk.raw, 400_000)
      times.push(performance.now() - t0)
    }
    times.sort((a, b) => a - b)
    expect(times[Math.floor(times.length * 0.95)]!).toBeLessThanOrEqual(25)
  })
})
