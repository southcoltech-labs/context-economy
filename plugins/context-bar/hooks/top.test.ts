// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'claude-code/testing'
import { shownCommand, topItems, topLines } from './top'
import { latest, MAX_MESSAGES_WALKED } from './walk'
import type { MessageItem } from './split'

const read = (chars: number, target: string): MessageItem => ({ kind: 'result', chars, tool: 'Read', target })
const bash = (chars: number, command: string): MessageItem => ({ kind: 'result', chars, tool: 'Bash', command })

describe('topItems', () => {
  test('ranks by estimated tokens, biggest first, and keeps n', () => {
    const items: MessageItem[] = [
      { kind: 'text', role: 'user', chars: 250 }, // 100 tokens
      read(2000, 'src/a.ts'), // 1000
      bash(600, 'bun test --secret-flag'), // 300
      { kind: 'call', chars: 50, tool: 'Grep' }, // 20
    ]
    expect(topItems(items, 2)).toEqual([
      { kind: 'reads', label: 'Read src/a.ts', tokens: 1000 },
      { kind: 'toolOut', label: 'Bash bun', tokens: 300 },
    ])
  })

  test('labels text, calls, results with and without tool', () => {
    const rows = topItems([
      { kind: 'text', role: 'user', chars: 25 },
      { kind: 'text', role: 'assistant', chars: 25 },
      { kind: 'call', chars: 25, tool: 'Grep' },
      { kind: 'call', chars: 25 },
      { kind: 'result', chars: 20, tool: 'Grep', target: 'TODO' },
      { kind: 'result', chars: 20 },
    ], 6)
    expect(rows.map(r => r.label)).toEqual(['user text', 'reply text', 'Grep call', 'tool call', 'Grep TODO', 'tool'])
  })

  test('a Bash row shows the command name only, never its arguments; the command wins over target', () => {
    const [row] = topItems([{ kind: 'result', chars: 10, tool: 'Bash', command: 'rg  -n\n foo', target: 'x' }], 1)
    expect(row!.label).toBe('Bash rg')
  })

  test('cuts labels longer than 48 chars to 47 + ellipsis', () => {
    const [row] = topItems([read(10, 'a'.repeat(80))], 1)
    expect(row!.label.length).toBe(48)
    expect(row!.label.endsWith('…')).toBe(true)
    expect(row!.label.startsWith('Read aaa')).toBe(true)
    const [exact] = topItems([read(10, 'b'.repeat(43))], 1) // 'Read ' + 43 = 48
    expect(exact!.label).toBe(`Read ${'b'.repeat(43)}`)
  })

  test('ties keep input order; zero-token items are dropped', () => {
    const rows = topItems([bash(10, 'first'), { kind: 'result', chars: 0, tool: 'Read' }, bash(10, 'second')], 5)
    expect(rows.map(r => r.label)).toEqual(['Bash', 'Bash'])
  })

  test('does not mutate input', () => {
    const items = [bash(10, 'b'), read(100, 'a')]
    const copy = JSON.parse(JSON.stringify(items))
    topItems(items, 1)
    expect(items).toEqual(copy)
  })

  test('v0.4 text items are labelled by role', () => {
    const rows = topItems([{ kind: 'text', role: 'user', chars: 50 }, { kind: 'text', role: 'assistant', chars: 25 }], 2)
    expect(rows).toEqual([{ kind: 'prompt', label: 'user text', tokens: 20 }, { kind: 'reply', label: 'reply text', tokens: 10 }])
  })

  test('rejects a bad count and bad items', () => {
    for (const n of [0, -1, 1.5, Number.NaN]) expect(() => topItems([], n)).toThrow(/top count/)
    expect(() => topItems([{ kind: 'result', chars: -1 }], 1)).toThrow(/invalid message item/)
  })
})

describe('topLines', () => {
  test('empty list says so', () => {
    expect(topLines([])).toEqual(['top items: none yet'])
  })

  test('header then aligned rows with category labels', () => {
    expect(topLines([
      { kind: 'reads', label: 'Read src/a.ts', tokens: 12300 },
      { kind: 'toolOut', label: 'Bash bun test', tokens: 950 },
      { kind: 'prompt', label: 'user text', tokens: 1500000 },
      { kind: 'reply', label: 'reply text', tokens: 20 },
      { kind: 'toolIn', label: 'Bash call', tokens: 7 },
    ])).toEqual([
      'top items (≈ tokens)',
      ' 12.3k  Reads        Read src/a.ts',
      '   950  Tool out     Bash bun test',
      '  1.5M  User prompt  user text',
      '    20  Replies      reply text',
      '     7  Tool in      Bash call',
    ])
  })
})

describe('shownCommand (what /context-bar top may show of a Bash command)', () => {
  test('a leading NAME=value assignment is skipped and its value is never shown', () => {
    expect(shownCommand('TOKEN=hunter2 git status')).toBe('git')
    expect(shownCommand('A=1 B=2 npm test')).toBe('npm')
    expect(shownCommand('TOKEN=hunter2')).toBeUndefined()
  })
  test('a path keeps only its last part, and only if that is on the list', () => {
    expect(shownCommand('/usr/bin/git log')).toBe('git')
    expect(shownCommand('./scripts/deploy-prod.sh --key abc')).toBeUndefined()
    expect(shownCommand('/home/someone/private-tool')).toBeUndefined()
  })
  test('a URL, an unknown word, an empty or blank command shows nothing', () => {
    expect(shownCommand('https://example.com/a?token=abc')).toBeUndefined()
    expect(shownCommand('internal-tool --x')).toBeUndefined()
    expect(shownCommand('')).toBeUndefined()
    expect(shownCommand('   ')).toBeUndefined()
  })
  test('quoted and escaped input does not leak: the first word is judged as it stands', () => {
    expect(shownCommand('"my secret thing" arg')).toBeUndefined()
    expect(shownCommand("'git' status")).toBeUndefined()
    expect(shownCommand('git\\ status')).toBeUndefined()
    expect(shownCommand('echo "token=abc" | curl -d @- https://x')).toBe('echo')
  })
  test('a word of the wrong shape is refused even if it ends in a listed name', () => {
    expect(shownCommand('a'.repeat(40) + '/git')).toBe('git')
    expect(shownCommand('git;rm -rf x')).toBeUndefined()
    expect(shownCommand('$(git) x')).toBeUndefined()
  })
  test('a top row for such commands says only Bash', () => {
    const rows = topItems([bash(100, 'TOKEN=abc ./run.sh https://x/y'), bash(90, 'git push origin main')], 2)
    expect(rows.map(r => r.label)).toEqual(['Bash', 'Bash git'])
  })
})

describe('top is bounded', () => {
  test('a large set of equal sizes still returns exactly n rows, in transcript order', () => {
    const items: MessageItem[] = Array.from({ length: 20_001 }, () => ({ kind: 'text', role: 'user', chars: 40 }))
    expect(topItems(items, 5)).toHaveLength(5)
  })
  test('only the latest messages are read, and the list says how many older ones were not', () => {
    const { recent, omitted } = latest(Array.from({ length: MAX_MESSAGES_WALKED + 3 }, () => 0))
    expect(recent).toHaveLength(MAX_MESSAGES_WALKED)
    expect(omitted).toBe(3)
    expect(topLines([{ kind: 'prompt', label: 'user text', tokens: 5 }], 3)[0]).toContain('3 older not read')
    expect(topLines([], 3)[0]).toContain('3 older not read')
    expect(topLines([], 0)).toEqual(['top items: none yet'])
  })
  test('a URL is never a command name, even when it ends in a listed name', () => {
    expect(shownCommand('https://example.test/git TOKEN')).toBeUndefined()
    expect(shownCommand('ssh://host/npm')).toBeUndefined()
    expect(shownCommand('file:///usr/bin/git')).toBeUndefined()
  })
})
