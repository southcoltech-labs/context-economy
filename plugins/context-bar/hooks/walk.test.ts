// SPDX-License-Identifier: Apache-2.0

import { expect, test } from 'claude-code/testing'
import { claudeAdapter, newItemState, toItems } from './items'
import { rawSplit, splitFromRaw } from './split'
import { MAX_MESSAGES_WALKED, MAX_PARSED_CHARS, boundedJsonLength, walkMessages } from './walk'
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
  for (let end = 3; end <= all.length; end += 7) walk = walkMessages(walk, all.slice(0, end), claudeAdapter)
  walk = walkMessages(walk, all, claudeAdapter)
  const full = rawSplit(toItems(all as never))
  for (const key of Object.keys(full) as (keyof typeof full)[]) expect(Math.abs(walk.raw[key] - full[key]) < 1e-6).toBe(true)
  expect(walk.omitted).toBe(0)
})

test('a result that arrives in a later refresh still finds its call', () => {
  const calls = turn(1).slice(0, 2)
  const results = turn(1).slice(2)
  let walk = walkMessages(undefined, calls, claudeAdapter)
  walk = walkMessages(walk, [...calls, ...results], claudeAdapter)
  const full = rawSplit(toItems([...calls, ...results] as never))
  expect(Math.abs(walk.raw.reads - full.reads) < 1e-6).toBe(true)
  expect(walk.raw.reads).toBeGreaterThan(0)
})

test('a shorter transcript (a compaction) is split afresh', () => {
  const all = session(50)
  let walk = walkMessages(undefined, all, claudeAdapter)
  const after = all.slice(-6)
  walk = walkMessages(walk, after, claudeAdapter)
  const full = rawSplit(toItems(after as never))
  expect(walk.seen).toBe(6)
  expect(Math.abs(walk.raw.prompt - full.prompt) < 1e-6).toBe(true)
})

test('over the cap only the latest messages are walked, and the rest is counted as omitted', () => {
  const all = Array.from({ length: MAX_MESSAGES_WALKED + 500 }, (_, i) => ({ role: 'user', text: `m${i}` }))
  const walk = walkMessages(undefined, all, claudeAdapter)
  expect(walk.omitted).toBe(500)
  const kept = rawSplit(toItems(all.slice(500) as never))
  expect(Math.abs(walk.raw.prompt - kept.prompt) < 1e-6).toBe(true)
  expect(walk.seen).toBe(all.length)
})

test('the sums scale to the messages total without a remainder', () => {
  const walk = walkMessages(undefined, session(20), claudeAdapter)
  const split = splitFromRaw(walk.raw, 12345)
  expect(Object.values(split).reduce((n, v) => n + v, 0)).toBe(12345)
})

test('a refresh of a 5,000-message session adding a turn takes at most 25 ms at the 95th percentile', () => {
  const base = session(1667) // 5,001 messages
  let walk = walkMessages(undefined, base, claudeAdapter)
  const times: number[] = []
  let all = base
  for (let i = 0; i < 100; i++) {
    all = [...all, ...turn(2000 + i)]
    const t0 = performance.now()
    walk = walkMessages(walk, all, claudeAdapter)
    splitFromRaw(walk.raw, 400_000)
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  expect(times[Math.floor(times.length * 0.95)]!).toBeLessThanOrEqual(25)
})

const sameAsFull = (walk: Walk<ItemState>, all: Msg[]): void => {
  const full = rawSplit(toItems(all as never))
  for (const key of Object.keys(full) as (keyof typeof full)[]) expect(Math.abs(walk.raw[key] - full[key]) < 1e-6).toBe(true)
}

test('an edited message is seen: the same count with a longer last message equals a full split', () => {
  const all = session(10)
  let walk = walkMessages(undefined, all, claudeAdapter)
  const edited = [...all.slice(0, -1), { role: 'user', text: 'z'.repeat(1000) }]
  walk = walkMessages(walk, edited, claudeAdapter)
  sameAsFull(walk, edited)
  const grown = [...edited, ...turn(99)]
  walk = walkMessages(walk, grown, claudeAdapter)
  sameAsFull(walk, grown)
})

test('a late result attached to an existing message is seen', () => {
  const first: Msg[] = [{ role: 'user', text: 'go' }, { role: 'assistant', text: '', toolUses: [{ tool: 'Bash', input: { command: 'cat a' }, tool_use_id: 'x' }] }, { role: 'user', text: '', toolResults: [] }]
  let walk = walkMessages(undefined, first, claudeAdapter)
  const later: Msg[] = [first[0]!, first[1]!, { role: 'user', text: '', toolResults: [{ tool_use_id: 'x', text: 'r'.repeat(500) }] }]
  walk = walkMessages(walk, later, claudeAdapter)
  sameAsFull(walk, later)
})

test('a same-length replacement (another branch) is seen, and a later append does not keep the old prefix', () => {
  const a = session(20)
  const b = Array.from({ length: 20 }, (_, i) => turn(500 + i)).flat()
  let walk = walkMessages(undefined, a, claudeAdapter)
  walk = walkMessages(walk, b, claudeAdapter)
  sameAsFull(walk, b)
  const more = [...b, ...turn(7)]
  walk = walkMessages(walk, more, claudeAdapter)
  sameAsFull(walk, more)
})

test('over the cap every refresh splits the whole retained window again (the documented exception), never only the added messages', () => {
  const all = Array.from({ length: MAX_MESSAGES_WALKED + 10 }, (_, i) => ({ role: 'user', text: 'a'.repeat(1 + (i % 7)) }))
  let walk = walkMessages(undefined, all, claudeAdapter)
  const edited = [...all.slice(0, -1), { role: 'user', text: 'b'.repeat(900) }]
  walk = walkMessages(walk, edited, claudeAdapter)
  expect(walk.omitted).toBe(10)
  sameAsFull(walk, edited.slice(10))
})

test('the walk keeps no command, path, pattern or message text', () => {
  const secret = 'TOPSECRET-value'
  const all: Msg[] = [
    { role: 'user', text: `read ${secret}` },
    { role: 'assistant', text: '', toolUses: [{ tool: 'Bash', input: { command: `cat ${secret}` }, tool_use_id: 'b' }, { tool: 'Read', input: { file_path: `/x/${secret}` }, tool_use_id: 'r' }, { tool: 'Grep', input: { pattern: secret }, tool_use_id: 'g' }, { tool: 'Bash', input: { command: `ls ${secret}` }, tool_use_id: 'late', }], },
  ]
  const walk = walkMessages(undefined, all, claudeAdapter)
  const held = JSON.stringify([...walk.state.calls.entries()]) + JSON.stringify([...walk.state.emitted])
  expect(held.includes(secret)).toBe(false)
  const done = walkMessages(walk, [...all, { role: 'user', text: '', toolResults: [{ tool_use_id: 'b', text: 'o' }, { tool_use_id: 'r', text: 'o' }] }], claudeAdapter)
  expect(JSON.stringify([...done.state.calls.entries()]).includes(secret)).toBe(false)
  expect(done.state.calls.has('b')).toBe(false) // a consumed call is dropped
  expect(done.raw.reads).toBeGreaterThan(0) // and the read still counts as a read
})

test('top-style conversion keeps its labels', () => {
  const items = toItems([{ role: 'assistant', text: '', toolUses: [{ tool: 'Bash', input: { command: 'git status' }, tool_use_id: 'a' }] }, { role: 'user', toolResults: [{ tool_use_id: 'a', text: 'ok' }] }] as never, newItemState())
  expect(items.find(i => i.kind === 'result')?.command).toBe('git status')
})

test('argument sizing is exact for ordinary values and stops early for huge or deeply nested ones', () => {
  const ordinary = { a: 'x', b: [1, 2.5, null, true, undefined, 'q"r'], c: { d: 'e\nf' }, g: undefined }
  expect(boundedJsonLength(ordinary)).toBe(JSON.stringify(ordinary).length)
  expect(boundedJsonLength(undefined)).toBe(0)
  expect(boundedJsonLength('')).toBe(2)
  const huge = { command: 'x'.repeat(MAX_PARSED_CHARS * 3) }
  expect(boundedJsonLength(huge)).toBeGreaterThan(MAX_PARSED_CHARS)
  let deep: unknown = 'leaf'
  for (let i = 0; i < 300_000; i++) deep = [deep]
  const t0 = performance.now()
  expect(boundedJsonLength(deep)).toBeGreaterThan(0)
  expect(performance.now() - t0).toBeLessThan(500)
  const wide = Array.from({ length: 2_000_000 }, () => 'abcdefghij')
  expect(boundedJsonLength(wide)).toBeGreaterThan(MAX_PARSED_CHARS)
})
