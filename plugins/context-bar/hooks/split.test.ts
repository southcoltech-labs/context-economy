// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'claude-code/testing'
import { applySplit, classify, splitMessages } from './split'

const user = (chars: number) => ({ kind: 'text' as const, role: 'user' as const, chars })
const reply = (chars: number) => ({ kind: 'text' as const, role: 'assistant' as const, chars })
const run = (command: string) => classify({ kind: 'result', chars: 10, command })
const zero = { prompt: 0, reply: 0, toolIn: 0, toolOut: 0, writes: 0, reads: 0 }

describe('classify v0.4', () => {
  test('text by role, calls are tool input, results are reads or tool output', () => {
    expect(classify(user(10))).toBe('prompt')
    expect(classify(reply(10))).toBe('reply')
    expect(classify({ kind: 'call', chars: 10, tool: 'Bash' })).toBe('toolIn')
    expect(classify({ kind: 'call', chars: 10 })).toBe('toolIn')
    for (const tool of ['Read', 'NotebookRead', 'read']) expect(classify({ kind: 'result', chars: 10, tool })).toBe('reads')
    expect(classify({ kind: 'result', chars: 10 })).toBe('toolOut')
  })
  test('v0.7 file-writing calls are writes (Claude Code, Pi and Codex tool names); their results stay tool output', () => {
    for (const tool of ['Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'edit', 'write', 'apply_patch']) expect(classify({ kind: 'call', chars: 10, tool })).toBe('writes')
    for (const tool of ['Read', 'Bash', 'Grep', 'Task', 'editor']) expect(classify({ kind: 'call', chars: 10, tool })).toBe('toolIn')
    expect(classify({ kind: 'result', chars: 10, tool: 'Edit' })).toBe('toolOut')
  })
  test('text without a valid role is rejected', () => {
    expect(() => classify({ kind: 'text', chars: 10 })).toThrow(/invalid message item/)
    expect(() => classify({ kind: 'text', chars: 10, role: 'system' } as never)).toThrow(/invalid message item/)
  })
  test('shell reads: cd prefix, read chains, read pipes into filters', () => {
    for (const command of [
      'sed -n 1,5p file', 'cat f', 'cd /a && sed -n 1,9p f', 'cd /a; cat f', 'cd /a && cd b && head -20 f',
      'cat f | head -5', 'sed -n 1,80p f | grep -n x | wc -l', 'cd /a && cat f && sed -n 1p g', 'tail -f log | rg err',
    ]) expect([command, run(command)]).toEqual([command, 'reads'])
  })
  test('shell non-reads', () => {
    for (const command of [
      'cat f && echo x', 'cat f; echo x', 'cat f || true', 'cd /a', 'cd /a && rg x', 'rg x', 'sed f', 'sed -i s/a/b/ f',
      'cat f > g', 'cat $(ls)', 'cat `ls`', 'diff <(cat a) b', 'cat f | xargs rm', 'cd a b && cat f', 'grep x f',
    ]) expect([command, run(command)]).toEqual([command, 'toolOut'])
  })
})

describe('splitMessages v0.4', () => {
  test('six keys, scaled to the total', () => {
    expect(splitMessages([user(25), reply(25), { kind: 'call', chars: 25 }, { kind: 'result', chars: 20, tool: 'Bash' }, { kind: 'call', chars: 25, tool: 'Edit' }, { kind: 'result', chars: 20, tool: 'Read' }], 60))
      .toEqual({ prompt: 10, reply: 10, toolIn: 10, toolOut: 10, writes: 10, reads: 10 })
  })
  test('floors and gives the remainder to the largest fractions', () => {
    // estimates prompt 2, toolIn 4, toolOut 6, reads 1 (sum 13) scaled to 10: 1.54, 3.08, 4.62, 0.77 -> 1,3,4,0 + reads, toolOut
    expect(splitMessages([user(5), { kind: 'call', chars: 10 }, { kind: 'result', chars: 12, command: 'rg x' }, { kind: 'result', chars: 2, command: 'cat a.ts' }], 10))
      .toEqual({ prompt: 1, reply: 0, toolIn: 3, toolOut: 5, writes: 0, reads: 1 })
  })
  test('ties follow prompt, reply, toolIn, toolOut, writes, reads', () => {
    const all = [user(5), reply(5), { kind: 'call' as const, chars: 5 }, { kind: 'result' as const, chars: 4 }, { kind: 'result' as const, chars: 4, tool: 'Read' }]
    expect(splitMessages(all, 1)).toEqual({ ...zero, prompt: 1 })
    expect(splitMessages(all.slice(1), 1)).toEqual({ ...zero, reply: 1 })
    expect(splitMessages(all.slice(3), 1)).toEqual({ ...zero, toolOut: 1 })
  })
  test('zero total, no items, bad input', () => {
    expect(splitMessages([user(8)], 0)).toEqual(zero)
    expect(splitMessages([], 9)).toEqual({ ...zero, prompt: 9 })
    for (const n of [-1, 1.5]) expect(() => splitMessages([], n)).toThrow()
    expect(() => splitMessages([user(-1)], 1)).toThrow()
  })
})

describe('applySplit v0.4', () => {
  const rows = [{ key: 'system', label: 'System', tokens: 10, percent: 1 }, { key: 'messages', label: 'Messages', tokens: 60, percent: 6 }, { key: 'free', label: 'Free', tokens: 30, percent: 3 }]
  test('replaces messages by six rows in order with labels', () => {
    const result = applySplit(rows, { prompt: 20, reply: 10, toolIn: 10, toolOut: 10, writes: 5, reads: 5 }, 100)
    expect(result.map(r => r.key)).toEqual(['system', 'prompt', 'reply', 'toolIn', 'toolOut', 'writes', 'reads', 'free'])
    expect(result.slice(1, 7).map(r => [r.label, r.tokens, r.percent])).toEqual([
      ['User prompt', 20, 20], ['Replies', 10, 10], ['Tool in', 10, 10], ['Tool out', 10, 10], ['Writes', 5, 5], ['Reads', 5, 5],
    ])
  })
  test('one-decimal percent; rejects missing row or wrong total', () => {
    const r = applySplit([{ key: 'messages', label: 'Messages', tokens: 6, percent: 0 }], { prompt: 1, reply: 1, toolIn: 1, toolOut: 1, writes: 1, reads: 1 }, 7)
    expect(r.map(x => x.percent)).toEqual([14.3, 14.3, 14.3, 14.3, 14.3, 14.3])
    expect(() => applySplit(rows.filter(r => r.key !== 'messages'), { ...zero, prompt: 60 }, 100)).toThrow()
    expect(() => applySplit(rows, { ...zero, prompt: 59 }, 100)).toThrow()
  })
})
