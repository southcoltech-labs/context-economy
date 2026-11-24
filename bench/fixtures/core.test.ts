// SPDX-License-Identifier: Apache-2.0
//
// Failure fixtures for the measurement core. Run explicitly: `bun test bench/fixtures`. Not part of any enforced test run.
import { expect, test } from 'bun:test'
import { measure } from '../append-measure-core'
import { piAdapter } from '../../extensions/context-bar/items'
import { walkMessages } from '../../plugins/context-bar/hooks/walk'

type Rec = { valid: boolean; complete: boolean; invalidReasons: string[]; stage: string; pairs: { order: string; appendMs: number[]; warmFullMs: number[]; appendDone: boolean; fullDone: boolean; cold: { error?: string; ms?: number } | string }[] }

// Counts walkMessages calls and throws on the Nth. Per pair the calls are: append block 1 untimed + 40 timed; full block 1 untimed + 5 timed;
// cold 1 warm-up + 1 timed. 41 + 6 + 2 = 49 per pair, in block order that depends on the pair's order.
const run = (throwAt?: number, call?: (id: string, a: unknown) => unknown): Rec => {
  let n = 0
  let out = ''
  const log = console.log
  console.log = (s: string) => { out += s + '\n' }
  try {
    measure({
      host: 'pi',
      walkMessages: (p, m, a) => { n++; if (n === throwAt) throw new Error('injected'); return walkMessages(p, m, a) },
      adapter: piAdapter,
      call: call ?? ((id, args) => ({ role: 'assistant', content: [{ type: 'toolCall', id, name: 'bash', arguments: args }] })),
      next: () => ({ role: 'user', content: 'next' }),
    })
  } catch { /* measure throws on an invalid record after printing it */ } finally { console.log = log }
  const line = out.split('\n').find(l => l.startsWith('APPEND-MEASURE-JSON '))!
  return JSON.parse(line.slice('APPEND-MEASURE-JSON '.length)) as Rec
}

test('a clean run is valid and complete', () => {
  const r = run()
  expect(r.valid).toBe(true); expect(r.complete).toBe(true); expect(r.pairs.length).toBe(4)
}, 120_000)

test('a throw in the second (full) block of an append-first pair keeps the first block and the partial block', () => {
  // pair 0 is append-first: calls 1..41 append block, 42 = full warm-up, 43.. = timed full walks. Throw at the 3rd timed full walk (call 45).
  const r = run(45)
  expect(r.valid).toBe(false); expect(r.complete).toBe(false); expect(r.stage).toBe('pair 0 full block')
  const p = r.pairs[0]!
  expect(p.appendDone).toBe(true); expect(p.appendMs.length).toBe(40)
  expect(p.fullDone).toBe(false); expect(p.warmFullMs.length).toBe(2)
}, 120_000)

test('a throw in the second (append) block of a full-first pair keeps the full block and the partial appends', () => {
  // pair 0 consumes 49 calls (append first); pair 1 is full-first: its full block is calls 50..55, append untimed start 56, timed from 57. The 12th timed append throws, so 11 complete.
  const r = run(49 + 6 + 1 + 12)
  expect(r.valid).toBe(false); expect(r.stage).toBe('pair 1 append block')
  const p = r.pairs[1]!
  expect(p.order).toBe('full-first'); expect(p.fullDone).toBe(true); expect(p.warmFullMs.length).toBe(5)
  expect(p.appendDone).toBe(false); expect(p.appendMs.length).toBe(11)
  expect(r.pairs.length).toBe(2)
}, 120_000)

test('a throw during the cold pass invalidates the whole record and keeps the samples', () => {
  const r = run(48) // pair 0 cold warm-up call
  expect(r.valid).toBe(false); expect(r.complete).toBe(false)
  expect(r.invalidReasons.join(' ')).toContain('cold sample failed')
  const p = r.pairs[0]!
  expect(p.appendMs.length).toBe(40); expect(p.warmFullMs.length).toBe(5); expect((p.cold as { error?: string }).error).toContain('injected')
  expect(r.pairs.length).toBe(4) // later pairs still ran, so the available data is retained
}, 120_000)

test('a throw during fixture initialization still reports a record', () => {
  const r = run(undefined, () => { throw new Error('init boom') })
  expect(r.valid).toBe(false); expect(r.stage).toBe('init'); expect(r.pairs.length).toBe(0)
  expect(r.invalidReasons[0]).toContain('init boom')
}, 120_000)
