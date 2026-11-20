// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'bun:test'
import { buildPiView, splitSystemPrompt, toolChars } from './estimate'
import { splitMessages, applySplit } from '../../plugins/context-bar/hooks/split'

const prompt = [
  'You are pi.', '<tools>', '- read', '</tools>',
  '<addendum>', 'prefs', '</addendum>',
  '<project_context>', 'agents md', '</project_context>',
  '<skills>', '<available_skills>', '<skill>x</skill>', '</available_skills>', '</skills>',
  '<cwd>', '/x', '</cwd>',
].join('\n')

const at = (v: ReturnType<typeof buildPiView>, key: string) => v!.rows.find(r => r.key === key)?.tokens

describe('splitSystemPrompt', () => {
  test('counts memory and skills blocks; the rest is system', () => {
    const s = splitSystemPrompt(prompt)
    const memory = '<addendum>\nprefs\n</addendum>'.length + '<project_context>\nagents md\n</project_context>'.length
    const skills = '<skills>\n<available_skills>\n<skill>x</skill>\n</available_skills>\n</skills>'.length
    expect(s.memory).toBe(memory)
    expect(s.skills).toBe(skills)
    expect(s.system).toBe(prompt.length - memory - skills)
  })
  test('a tag inside text is not a section', () => {
    const s = splitSystemPrompt('use <skills> wisely\nmore')
    expect(s.skills).toBe(0)
  })
  test('unclosed section fails fast', () => {
    expect(() => splitSystemPrompt('<skills>\nno end')).toThrow('unclosed <skills>')
  })
})

describe('toolChars', () => {
  test('counts only active tools', () => {
    const all = [{ name: 'a', description: 'd', parameters: { x: 1 } }, { name: 'b', description: 'long'.repeat(50) }]
    expect(toolChars(all, ['a'])).toBe(JSON.stringify({ name: 'a', description: 'd', parameters: { x: 1 } }).length)
  })
})

describe('Pi message split rows', () => {
  test('replaces Messages with six split rows and preserves its token total', () => {
    const rows = [{ key: 'system', label: 'System', tokens: 10, percent: 1 }, { key: 'messages', label: 'Messages', tokens: 11, percent: 1 }, { key: 'free', label: 'Free', tokens: 20, percent: 2 }]
    const split = splitMessages([
      { kind: 'text', role: 'user', chars: 8 },
      { kind: 'text', role: 'assistant', chars: 8 },
      { kind: 'call', chars: 8, tool: 'bash' },
      { kind: 'result', chars: 8, tool: 'bash', command: 'rg x' },
      { kind: 'call', chars: 8, tool: 'edit' },
      { kind: 'result', chars: 8, tool: 'read' },
    ], 11)
    const out = applySplit(rows, split, 41)
    expect(out.map(r => r.key)).toEqual(['system', 'prompt', 'reply', 'toolIn', 'toolOut', 'writes', 'reads', 'free'])
    expect(out.slice(1, 7).reduce((n, r) => n + r.tokens, 0)).toBe(11)
    expect(out.slice(1, 7).map(r => r.label)).toEqual(['User prompt', 'Replies', 'Tool in', 'Tool out', 'Writes', 'Reads'])
    expect(split.writes).toBeGreaterThan(0)
  })
})

describe('buildPiView', () => {
  const fixed = { system: 4000, memory: 2000, skills: 1000, tools: 8000 } // chars -> 1000/500/250/2000 tokens
  const on = { enabled: true, reserveTokens: 16384 }

  test('fixed parts from chars, messages are the rest, free and buffer fill the window', () => {
    const v = buildPiView({ tokens: 10000, contextWindow: 100000 }, fixed, on)!
    expect([at(v, 'system'), at(v, 'tools'), at(v, 'memory'), at(v, 'skills')]).toEqual([1000, 2000, 500, 250])
    expect(at(v, 'messages')).toBe(10000 - 3750)
    expect(at(v, 'buffer')).toBe(16384)
    expect(at(v, 'free')).toBe(100000 - 10000 - 16384)
    expect(v.thresholdTokens).toBe(100000 - 16384)
    expect(v.percent).toBe(10)
    expect(v.rows.map(r => r.key)).toEqual(['system', 'tools', 'memory', 'skills', 'messages', 'free', 'buffer'])
  })
  test('estimate above the real total is scaled down; parts still sum to the total', () => {
    const v = buildPiView({ tokens: 1875, contextWindow: 100000 }, fixed, on)!
    const used = ['system', 'tools', 'memory', 'skills', 'messages'].reduce((n, k) => n + (at(v, k) ?? 0), 0)
    expect(used).toBe(1875)
    expect(at(v, 'tools')).toBe(1000)
  })
  test('compaction off: no buffer, no threshold', () => {
    const v = buildPiView({ tokens: 10000, contextWindow: 100000 }, fixed, { enabled: false, reserveTokens: 16384 })!
    expect(v.thresholdTokens).toBeNull()
    expect(at(v, 'buffer')).toBeUndefined()
    expect(at(v, 'free')).toBe(90000)
  })
  test('above the threshold the buffer shrinks to what is left', () => {
    const v = buildPiView({ tokens: 95000, contextWindow: 100000 }, fixed, on)!
    expect(at(v, 'buffer')).toBe(5000)
    expect(at(v, 'free')).toBe(0)
  })
  test('0 before the first reply: no rounding leftover in messages', () => {
    const v = buildPiView({ tokens: 0, contextWindow: 100000 }, { system: 4003, memory: 2003, skills: 1003, tools: 8003 }, on)!
    expect(at(v, 'messages')).toBe(0)
  })
  test('0 before the first reply: the fixed estimate is the total', () => {
    const v = buildPiView({ tokens: 0, contextWindow: 100000 }, fixed, on)!
    expect(v.usedTokens).toBe(3750)
    expect(at(v, 'tools')).toBe(2000)
    expect(at(v, 'messages')).toBe(0)
  })
  test('offload loaded: marker at its trigger, no Pi buffer', () => {
    const v = buildPiView({ tokens: 10000, contextWindow: 1000000 }, fixed, { ...on, offloadAtTokens: 240000 })!
    expect(v.thresholdTokens).toBe(240000)
    expect(at(v, 'buffer')).toBeUndefined()
    expect(at(v, 'free')).toBe(990000)
  })
  test('offload above Pi compaction: Pi compaction comes first', () => {
    const v = buildPiView({ tokens: 10000, contextWindow: 100000 }, fixed, { ...on, offloadAtTokens: 240000 })!
    expect(v.thresholdTokens).toBe(100000 - 16384)
    expect(at(v, 'buffer')).toBe(16384)
  })
  test('unknown total (after compaction) gives no view', () => {
    expect(buildPiView({ tokens: null, contextWindow: 100000 }, fixed, on)).toBeNull()
  })
  test('bad window fails fast', () => {
    expect(() => buildPiView({ tokens: 1, contextWindow: 0 }, fixed, on)).toThrow('window')
  })
})
