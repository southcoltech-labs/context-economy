// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'claude-code/testing'
import { convertClaude, toItems } from './items'
import { rawSplit, splitFromRaw } from './split'
import { MAX_MESSAGES_WALKED, walkMessages } from './walk'
import type { Walk } from './walk'
import type { ItemState } from './items'

type Msg = Record<string, unknown>
const turn = (i: number): Msg[] => [
  { role: 'user', text: `question ${i} ${'q'.repeat(i % 50)}` },
  { role: 'assistant', text: `answer ${i}`, toolUses: [{ tool: 'Bash', input: { command: 'cat a.txt' }, tool_use_id: `t${i}` }] },
  { role: 'user', text: '', toolResults: [{ tool_use_id: `t${i}`, text: 'r'.repeat(10 + (i % 90)) }] },
]
const session = (turns: number): Msg[] => Array.from({ length: turns }, (_, i) => turn(i)).flat()

test('an incremental walk equals a full walk of the same transcript', () => {
  const all = session(300)
  let walk: Walk<ItemState> | undefined
  for (let end = 3; end <= all.length; end += 7) walk = walkMessages(walk, all.slice(0, end), convertClaude)
  walk = walkMessages(walk, all, convertClaude)
  const full = rawSplit(toItems(all as never))
  for (const key of Object.keys(full) as (keyof typeof full)[]) expect(Math.abs(walk.raw[key] - full[key]) < 1e-6).toBe(true)
  expect(walk.omitted).toBe(0)
})

test('a result that arrives in a later refresh still finds its call', () => {
  const calls = turn(1).slice(0, 2)
  const results = turn(1).slice(2)
  let walk = walkMessages(undefined, calls, convertClaude)
  walk = walkMessages(walk, [...calls, ...results], convertClaude)
  const full = rawSplit(toItems([...calls, ...results] as never))
  expect(Math.abs(walk.raw.reads - full.reads) < 1e-6).toBe(true)
  expect(walk.raw.reads).toBeGreaterThan(0)
})

test('a shorter transcript (a compaction) is split afresh', () => {
  const all = session(50)
  let walk = walkMessages(undefined, all, convertClaude)
  const after = all.slice(-6)
  walk = walkMessages(walk, after, convertClaude)
  const full = rawSplit(toItems(after as never))
  expect(walk.seen).toBe(6)
  expect(Math.abs(walk.raw.prompt - full.prompt) < 1e-6).toBe(true)
})

test('over the cap only the latest messages are walked, and the rest is counted as omitted', () => {
  const all = Array.from({ length: MAX_MESSAGES_WALKED + 500 }, (_, i) => ({ role: 'user', text: `m${i}` }))
  const walk = walkMessages(undefined, all, convertClaude)
  expect(walk.omitted).toBe(500)
  const kept = rawSplit(toItems(all.slice(500) as never))
  expect(Math.abs(walk.raw.prompt - kept.prompt) < 1e-6).toBe(true)
  expect(walk.seen).toBe(all.length)
})

test('the sums scale to the messages total without a remainder', () => {
  const walk = walkMessages(undefined, session(20), convertClaude)
  const split = splitFromRaw(walk.raw, 12345)
  expect(Object.values(split).reduce((n, v) => n + v, 0)).toBe(12345)
})

test('a refresh of a 5,000-message session adding a turn takes at most 25 ms at the 95th percentile', () => {
  const base = session(1667) // 5,001 messages
  let walk = walkMessages(undefined, base, convertClaude)
  const times: number[] = []
  let all = base
  for (let i = 0; i < 100; i++) {
    all = [...all, ...turn(2000 + i)]
    const t0 = performance.now()
    walk = walkMessages(walk, all, convertClaude)
    splitFromRaw(walk.raw, 400_000)
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  expect(times[Math.floor(times.length * 0.95)]!).toBeLessThanOrEqual(25)
})
