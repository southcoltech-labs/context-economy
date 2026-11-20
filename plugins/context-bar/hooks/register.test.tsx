// SPDX-License-Identifier: Apache-2.0

import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { PALETTES } from './palettes'

const RUN = {
  command: 'context-bar',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 80 },
} as const

const TURN = { answer: '', durationMs: 1, isAborted: false, turnId: 't1' } as never

test('/context-bar starts hidden and toggles on, then off', async ($, on) => {
  on('session.usage', () => ({ value: { context: {} } }) as never)
  const first = await $.command.run(RUN)
  expect(first.text).toBe('Context band on.')
  const second = await $.command.run(RUN)
  expect(second.text).toBe('Context band off.')
})

test('hidden band makes no usage calls after a turn', async ($, on) => {
  let calls = 0
  on('session.usage', () => {
    calls += 1
    return { value: { context: {} } } as never
  })
  on('turn.complete', () => ({ text: '' }))
  await $.turn.complete(TURN)
  expect(calls).toBe(0)
})

const counting = (on: On) => {
  const seen = { calls: 0 }
  on('session.usage', () => {
    seen.calls += 1
    return { value: { context: {} } } as never
  })
  return seen
}

test('/context-bar r refreshes a shown band', async ($, on) => {
  const seen = counting(on)
  await $.command.run(RUN)
  const r = await $.command.run({ ...RUN, args: 'r' })
  expect(r.text).toBe('Context band refreshed.')
  expect(seen.calls).toBe(2)
})

test('/context-bar r on a hidden band shows it', async ($, on) => {
  const seen = counting(on)
  const r = await $.command.run({ ...RUN, args: 'r' })
  expect(r.text).toBe('Context band refreshed.')
  expect(seen.calls).toBe(1)
  const off = await $.command.run(RUN)
  expect(off.text).toBe('Context band off.')
})

test('unknown argument is refused with usage', async ($, on) => {
  const seen = counting(on)
  const r = await $.command.run({ ...RUN, args: 'x' })
  expect(r.text).toBe('Usage: /context-bar [r|top|min|norm|max]')
  expect(seen.calls).toBe(0)
})

test('shown band keeps the band drawn beneath it (wait-timer)', async ($, on) => {
  on('session.usage', () => ({ value: { context: {} } }) as never)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['BENEATH'] }) as never)
  await $.command.run(RUN)
  const ui = await $.ui.mount({
    plugin: 'context-bar',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 80 } as never,
  })
  expect(await ui.find({ type: 'Text', text: /BENEATH/ })).toBeDefined()
  await ui.unmount()
})

// ---- v0.2: split rows, refresh policy, config, age text ----

type StateWrite = { key: string; value: unknown }

/** Records every $.state.set the plugin makes (key, value), then lets the kit store it. */
const spyState = (on: On) => {
  const writes: StateWrite[] = []
  on('state.set', (async ($: never, e: never, next: (e: never) => Promise<never>) => {
    writes.push({ key: (e as { key: string }).key, value: (e as { value: unknown }).value })
    return next(e)
  }) as never)
  return {
    last: (key: string): unknown => writes.filter(w => w.key === key).at(-1)?.value,
  }
}
const MAIN_TURN = TURN
const SUB_TURN = { ...(TURN as object), agentId: 'sub-1' } as never

const category = (name: string, tokens: number, kind = 'fixed') =>
  ({ name, tokens, color: 'x', isDeferred: false, kind }) as never

const BREAKDOWN = {
  categories: [
    category('System prompt', 1000),
    category('Messages', 1000),
    category('Free space', 7000, 'free'),
  ],
  totalTokens: 2000,
  maxTokens: 10000,
  rawMaxTokens: 10000,
  percentage: 20,
  isAutoCompactEnabled: false,
}

const KEPT = { role: 'user', text: 'summary', toolUses: [] }
const MESSAGES = [
  { role: 'user', text: 'please read it', toolUses: [] },
  { role: 'assistant', text: 'ok', toolUses: [
    { tool_use_id: 'r1', tool: 'Read', input: { file_path: 'a.ts' } },
    { tool_use_id: 'b1', tool: 'Bash', input: { command: 'ls' } },
  ] },
  { role: 'user', text: '', toolUses: [], toolResults: [
    { tool_use_id: 'r1', text: 'x'.repeat(4000), isError: false },
    { tool_use_id: 'b1', text: 'y'.repeat(400), isError: false },
  ] },
]


/** Mock usage (counted) and messages; the turn.complete / compact bottoms answer. */
const mocked = (on: On, compacted: unknown = { messages: [KEPT] }, messages: unknown = MESSAGES) => {
  const seen = { calls: 0 }
  on('session.usage', () => {
    seen.calls += 1
    return { value: { context: { breakdown: BREAKDOWN } } } as never
  })
  on('session.messages', () => ({ value: messages }) as never)
  on('turn.complete', () => ({ text: '' }))
  on('session.compact', () => compacted as never)
  on('ui.render', () => ({ type: 'Text', props: {}, children: [] }) as never)
  return seen
}

const mountBand = ($: Engine) =>
  $.ui.mount({
    plugin: 'context-bar',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 100 } as never,
  })

const rounds = async (
  $: Engine,
  n: number,
  turn: never = MAIN_TURN,
) => {
  for (let i = 0; i < n; i += 1) await $.turn.complete(turn)
}

test('v0.4 band replaces Messages by five split rows; their sum is the messages row', async ($, on) => {
  mocked(on)
  const spy = spyState(on)
  await $.command.run(RUN)
  const rows = (spy.last('view') as { rows: { key: string; tokens: number }[] }).rows
  const keys = rows.map(r => r.key)
  expect(keys).toContain('prompt')
  expect(keys).toContain('reply')
  expect(keys).toContain('toolIn')
  expect(keys).not.toContain('chat')
  expect(keys).toContain('toolOut')
  expect(keys).toContain('reads')
  expect(keys).not.toContain('messages')
  const sum = rows.filter(r => ['prompt', 'reply', 'toolIn', 'toolOut', 'reads'].includes(r.key)).reduce((a, r) => a + r.tokens, 0)
  expect(sum).toBe(1000)
  const tokens = (k: string) => rows.find(r => r.key === k)?.tokens ?? -1
  expect(tokens('reads')).toBeGreaterThan(tokens('toolOut'))
})

test('v0.4 legend shows the User prompt, Replies, Tool in, Tool out and Reads labels', async ($, on) => {
  mocked(on)
  await $.command.run(RUN)
  const ui = await mountBand($)
  expect(await ui.find({ type: 'Text', text: /User prompt/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Replies/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Tool in/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Chat/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Tool out/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Reads/ })).toBeDefined()
  await ui.unmount()
})

test('v0.4 a "cd /x && sed -n 1,5p f" Bash result counts as reads, not tool out', async ($, on) => {
  mocked(on, undefined, [
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'b1', tool: 'Bash', input: { command: 'cd /x && sed -n 1,5p f' } }] },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'b1', text: 'z'.repeat(4000), isError: false }] },
  ])
  const spy = spyState(on)
  await $.command.run(RUN)
  const rows = (spy.last('view') as { rows: { key: string; tokens: number }[] }).rows
  const tokens = (k: string) => rows.find(r => r.key === k)?.tokens ?? -1
  expect(tokens('reads')).toBeGreaterThan(900)
  expect(tokens('toolOut')).toBe(0)
})

test('v0.4 text rows follow SessionMessage.role: user text is prompt, assistant text is reply', async ($, on) => {
  mocked(on, undefined, [
    { role: 'user', text: 'u'.repeat(400), toolUses: [] },
    { role: 'assistant', text: 'a'.repeat(100), toolUses: [] },
  ])
  const spy = spyState(on)
  await $.command.run(RUN)
  const rows = (spy.last('view') as { rows: { key: string; tokens: number }[] }).rows
  const tokens = (k: string) => rows.find(r => r.key === k)?.tokens ?? -1
  expect(tokens('prompt')).toBeGreaterThan(tokens('reply'))
  expect(tokens('reply')).toBeGreaterThan(0)
  expect(tokens('prompt') + tokens('reply')).toBe(1000)
})

// ---- v0.5.1: growth-based refresh (replaces "every N rounds") ----

const WINDOW = 10000 // BREAKDOWN.maxTokens; 5% of it = 500 tokens
type Ctl = { tokens: number | undefined }

/**
 * Usage mock that tells the two calls apart: WITH `breakdown` (full, counted)
 * and WITHOUT (free). Both report context.tokens / window from `ctl`.
 */
const growthMock = (on: On, ctl: Ctl, compacted: unknown = { messages: [KEPT] }) => {
  const seen = { full: 0, free: 0 }
  on('session.usage', (($: never, e: { breakdown?: unknown } | undefined) => {
    const context = { ...(ctl.tokens === undefined ? {} : { tokens: ctl.tokens }), window: WINDOW }
    if (e?.breakdown !== undefined) {
      seen.full += 1
      return { value: { context: { ...context, breakdown: BREAKDOWN } } }
    }
    seen.free += 1
    return { value: { context } }
  }) as never)
  on('session.messages', () => ({ value: MESSAGES }) as never)
  on('turn.complete', () => ({ text: '' }))
  on('session.compact', () => compacted as never)
  on('ui.render', () => ({ type: 'Text', props: {}, children: [] }) as never)
  return seen
}

test('v0.5.1 shown band, small growth: the free call is made, no full refresh', async ($, on) => {
  const ctl: Ctl = { tokens: 2000 }
  const seen = growthMock(on, ctl)
  await $.command.run(RUN)
  expect(seen.full).toBe(1)
  ctl.tokens = 2400 // +4% of the window, below 5%
  await rounds($, 3)
  expect(seen.full).toBe(1)
  expect(seen.free).toBeGreaterThan(0)
})

test('v0.5.1 growth of 5% of the window triggers exactly one full refresh', async ($, on) => {
  const ctl: Ctl = { tokens: 2000 }
  const seen = growthMock(on, ctl)
  await $.command.run(RUN)
  ctl.tokens = 2500
  await rounds($, 1)
  expect(seen.full).toBe(2)
  await rounds($, 2) // same tokens: the baseline moved to 2500
  expect(seen.full).toBe(2)
})

test('v0.5.1 shrinking by 5% of the window also refreshes', async ($, on) => {
  const ctl: Ctl = { tokens: 2000 }
  const seen = growthMock(on, ctl)
  await $.command.run(RUN)
  ctl.tokens = 1500
  await rounds($, 1)
  expect(seen.full).toBe(2)
})

test('v0.5.1 refreshGrowthPercent 10 changes the threshold', { options: { refreshGrowthPercent: 10 } }, async ($, on) => {
  const ctl: Ctl = { tokens: 2000 }
  const seen = growthMock(on, ctl)
  await $.command.run(RUN)
  ctl.tokens = 2900 // +9%
  await rounds($, 1)
  expect(seen.full).toBe(1)
  ctl.tokens = 3000 // +10% from the unchanged baseline 2000
  await rounds($, 1)
  expect(seen.full).toBe(2)
})

test('v0.5.1 hidden band makes no usage call at all on rounds', async ($, on) => {
  const seen = growthMock(on, { tokens: 9000 })
  await rounds($, 4)
  expect(seen.full + seen.free).toBe(0)
})

test('v0.5.1 tokens absent after a first measure: no full refresh', async ($, on) => {
  const ctl: Ctl = { tokens: 2000 }
  const seen = growthMock(on, ctl)
  await $.command.run(RUN)
  ctl.tokens = undefined
  await rounds($, 2)
  expect(seen.full).toBe(1)
})

test('v0.5.1 nothing measured yet (tokens were absent), then tokens appear: full refresh', async ($, on) => {
  const ctl: Ctl = { tokens: undefined }
  const seen = growthMock(on, ctl)
  const spy = spyState(on)
  await $.command.run(RUN)
  expect(spy.last('measuredTokens')).toBeNull()
  await rounds($, 1)
  expect(seen.full).toBe(1)
  ctl.tokens = 100
  await rounds($, 1)
  expect(seen.full).toBe(2)
})

test('v0.5.1 measured tokens are kept in $.state (context-bar/measuredTokens)', async ($, on) => {
  const ctl: Ctl = { tokens: 2000 }
  growthMock(on, ctl)
  const spy = spyState(on)
  await $.command.run(RUN)
  expect(spy.last('measuredTokens')).toBe(2000)
  ctl.tokens = 3000
  await rounds($, 1)
  expect(spy.last('measuredTokens')).toBe(3000)
})

for (const bad of [0, -1, 101]) {
  test(`v0.5.1 refreshGrowthPercent ${bad} shows n/a with the field name, no throw`, { options: { refreshGrowthPercent: bad } }, async ($, on) => {
    growthMock(on, { tokens: 2000 })
    await $.command.run(RUN)
    await rounds($, 2)
    const ui = await mountBand($)
    expect(await ui.find({ type: 'Text', text: /n\/a \(.*refreshGrowthPercent.*\)/ })).toBeDefined()
    await ui.unmount()
  })
}

test('v0.5.1 subagent turn.complete is not a round: no usage call, counter unchanged', async ($, on) => {
  const ctl: Ctl = { tokens: 2000 }
  const seen = growthMock(on, ctl)
  const spy = spyState(on)
  await $.command.run(RUN)
  await rounds($, 1)
  const free = seen.free
  ctl.tokens = 9000
  await rounds($, 3, SUB_TURN)
  expect(seen.full).toBe(1)
  expect(seen.free).toBe(free)
  expect(spy.last('roundsSince')).toBe(1)
})

for (const trigger of ['manual', 'auto', 'plugin'] as const) {
  test(`v0.5.1 main-loop compaction (${trigger}) does a full refresh and resets the growth baseline`, async ($, on) => {
    const ctl: Ctl = { tokens: 2000 }
    const seen = growthMock(on, ctl)
    mock.clock(on, { now: 1 })
    await $.command.run(RUN)
    await rounds($, 2)
    ctl.tokens = 500 // the window shrank after compaction
    await $.session.compact({ trigger, messages: [KEPT] } as never)
    expect(seen.full).toBe(2)
    await rounds($, 1) // 500 vs the new baseline 500: no growth
    expect(seen.full).toBe(2)
  })
}

test('v0.5.1 subagent compaction does not refresh', async ($, on) => {
  const seen = growthMock(on, { tokens: 2000 })
  await $.command.run(RUN)
  await $.session.compact({ trigger: 'auto', agentId: 'sub-1', messages: [KEPT] } as never)
  expect(seen.full).toBe(1)
})

test('v0.5.1 /context-bar r does a full refresh and resets the growth baseline', async ($, on) => {
  const ctl: Ctl = { tokens: 2000 }
  const seen = growthMock(on, ctl)
  await $.command.run(RUN)
  await rounds($, 2)
  ctl.tokens = 2400 // below the threshold: no growth refresh
  await rounds($, 1)
  expect(seen.full).toBe(1)
  await $.command.run({ ...RUN, args: 'r' })
  expect(seen.full).toBe(2)
  ctl.tokens = 2800 // +400 from the new baseline 2400 (+800 from the old one)
  await rounds($, 1)
  expect(seen.full).toBe(2)
})

test('v0.5.1 hidden band makes no usage call on rounds or compaction', async ($, on) => {
  const seen = growthMock(on, { tokens: 2000 })
  await rounds($, 6)
  await $.session.compact({ trigger: 'manual', messages: [KEPT] } as never)
  expect(seen.full + seen.free).toBe(0)
})

test('footer shows "distribution est." when fresh, no age text', async ($, on) => {
  mocked(on)
  await $.command.run(RUN)
  const ui = await mountBand($)
  expect(await ui.find({ type: 'Text', text: /distribution est\./ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /updated \d+ turns? ago/ })).toBeUndefined()
  await ui.unmount()
})

test('v0.5.1 header counts rounds since the last full refresh, and resets on a growth refresh', async ($, on) => {
  const ctl: Ctl = { tokens: 2000 }
  growthMock(on, ctl)
  await $.command.run(RUN)
  await rounds($, 2)
  let ui = await mountBand($)
  expect(await ui.find({ type: 'Text', text: /distribution est\. - updated 2 turns ago/ })).toBeDefined()
  await ui.unmount()
  ctl.tokens = 3000
  await rounds($, 1) // growth: full refresh, age back to 0
  ui = await mountBand($)
  expect(await ui.find({ type: 'Text', text: /updated \d+ turns? ago/ })).toBeUndefined()
  await ui.unmount()
  ctl.tokens = 3100
  await rounds($, 1)
  ui = await mountBand($)
  expect(await ui.find({ type: 'Text', text: /distribution est\. - updated 1 turn ago/ })).toBeDefined()
  await ui.unmount()
})

// Contract: the counter is the $.state value context-bar/roundsSince (number),
// so it survives a module reload. The code must use exactly this key.
test('v0.2 round counter lives in $.state (context-bar/roundsSince)', async ($, on) => {
  growthMock(on, { tokens: 2000 })
  const spy = spyState(on)
  await $.command.run(RUN)
  await rounds($, 3)
  expect(spy.last('roundsSince')).toBe(3)
  await rounds($, 3, SUB_TURN)
  expect(spy.last('roundsSince')).toBe(3)
})

// ---- v0.3: /context-bar top, compaction line ----

const TOP_ARGS = { ...RUN, args: 'top' }

test('v0.3 /context-bar top lists the biggest item first, header first', async ($, on) => {
  mocked(on)
  const r = await $.command.run(TOP_ARGS)
  const lines = (r.text as string).split('\n')
  expect(lines[0]).toBe('top items (≈ tokens)')
  expect(lines[1]).toContain('Read a.ts')
  expect(lines[2]).toContain('Bash ls')
})

test('v0.4 /context-bar top shows text items as "user text" and "reply text"', async ($, on) => {
  // Text-only session: the default top count (5) covers both items.
  const textOnly = [{ role: 'user', text: 'please read it', toolUses: [] }, { role: 'assistant', text: 'ok', toolUses: [] }]
  mocked(on, { messages: [KEPT] }, textOnly)
  const r = await $.command.run(TOP_ARGS)
  expect(r.text).toContain('user text')
  expect(r.text).toContain('reply text')
  expect(r.text).not.toMatch(/Chat/)
})

test('v0.3 /context-bar top works while the band is off and leaves it off', async ($, on) => {
  const seen = mocked(on)
  const top = await $.command.run(TOP_ARGS)
  expect(top.text).toContain('top items')
  expect(seen.calls).toBe(0)
  const toggled = await $.command.run(RUN)
  expect(toggled.text).toBe('Context band on.')
})

test('v0.3 /context-bar top does not toggle a shown band', async ($, on) => {
  mocked(on)
  await $.command.run(RUN)
  await $.command.run(TOP_ARGS)
  const off = await $.command.run(RUN)
  expect(off.text).toBe('Context band off.')
})

type Stats = { count: number; last: { at: number; tokensBefore?: number; tokensAfter?: number } | null }
const compactionsOf = (spy: ReturnType<typeof spyState>): Stats | undefined =>
  spy.last('compactions') as Stats | undefined
const countOf = (spy: ReturnType<typeof spyState>): number => compactionsOf(spy)?.count ?? 0

const SIZED = { messages: [KEPT], tokensBefore: 90000, tokensAfter: 12000 } as never

test('v0.3 main-loop compaction is counted in $.state compactions with tokens and clock time', async ($, on) => {
  mocked(on, SIZED)
  mock.clock(on, { now: 5_000_000 })
  const spy = spyState(on)
  await $.session.compact({ trigger: 'auto', messages: [KEPT] } as never)
  expect(compactionsOf(spy)).toEqual({ count: 1, last: { at: 5_000_000, tokensBefore: 90000, tokensAfter: 12000 } })
  await $.session.compact({ trigger: 'manual', messages: [KEPT] } as never)
  expect(countOf(spy)).toBe(2)
})

test('v0.3 compaction without token counts records only the time', async ($, on) => {
  mocked(on)
  mock.clock(on, { now: 7_000 })
  const spy = spyState(on)
  await $.session.compact({ trigger: 'auto', messages: [KEPT] } as never)
  expect(compactionsOf(spy)).toEqual({ count: 1, last: { at: 7_000 } })
})

test('v0.3 subagent compaction is not counted', async ($, on) => {
  mocked(on)
  mock.clock(on, { now: 1 })
  const spy = spyState(on)
  await $.session.compact({ trigger: 'auto', agentId: 'sub-1', messages: [KEPT] } as never)
  expect(countOf(spy)).toBe(0)
})

test('v0.3 skipped compaction is not counted', async ($, on) => {
  mocked(on, { skip: 'off' })
  mock.clock(on, { now: 1 })
  const spy = spyState(on)
  await $.session.compact({ trigger: 'plugin', messages: [KEPT] } as never)
  expect(countOf(spy)).toBe(0)
})

test('v0.3 compaction is recorded while the band is hidden, with no usage call', async ($, on) => {
  const seen = mocked(on, SIZED)
  mock.clock(on, { now: 1 })
  const spy = spyState(on)
  await $.session.compact({ trigger: 'auto', messages: [KEPT] } as never)
  expect(countOf(spy)).toBe(1)
  expect(seen.calls).toBe(0)
})

test('v0.3 band shows "compacted 1×" after a compaction and refresh', async ($, on) => {
  mocked(on, SIZED)
  mock.clock(on, { now: 1_000_000 })
  await $.command.run(RUN)
  await $.session.compact({ trigger: 'auto', messages: [KEPT] } as never)
  const ui = await mountBand($)
  expect(await ui.find({ type: 'Text', text: /compacted 1×/ })).toBeDefined()
  await ui.unmount()
})

test('the compaction text is hidden when the band is too narrow to show it beside the note', async ($, on) => {
  mocked(on, SIZED)
  mock.clock(on, { now: 1_000_000 })
  await $.command.run(RUN)
  await $.session.compact({ trigger: 'auto', messages: [KEPT] } as never)
  const ui = await $.ui.mount({
    plugin: 'context-bar',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 30 } as never,
  })
  expect(await ui.find({ type: 'Text', text: /distribution est\./ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /compacted/ })).toBeUndefined()
  await ui.unmount()
})

test('v0.3 band shows no compaction line before any compaction', async ($, on) => {
  mocked(on)
  await $.command.run(RUN)
  const ui = await mountBand($)
  expect(await ui.find({ type: 'Text', text: /compacted/ })).toBeUndefined()
  await ui.unmount()
})

// ---- v0.5: static-prefix marker, label levels (min / norm / max) ----

const RICH = {
  ...BREAKDOWN,
  categories: [
    category('System prompt', 1000),
    category('System tools', 500),
    category('Messages', 1000),
    category('Free space', 7500, 'free'),
  ],
  totalTokens: 2500,
}

/** Like `mocked`, with a breakdown that has two static rows (System, Tool defs). */
const mockedRich = (on: On) => {
  on('session.usage', () => ({ value: { context: { breakdown: RICH } } }) as never)
  on('session.messages', () => ({ value: MESSAGES }) as never)
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: [] }) as never)
}

const seeText = async ($: Engine, re: RegExp) => {
  const ui = await mountBand($)
  const found = (await ui.find({ type: 'Text', text: re })) !== undefined
  await ui.unmount()
  return found
}

test('v0.5 default band shows Static prefix and not Tool defs', async ($, on) => {
  mockedRich(on)
  await $.command.run(RUN)
  expect(await seeText($, /Static prefix/)).toBe(true)
  expect(await seeText($, /Tool defs/)).toBe(false)
})

test('v0.5 labels option max shows Tool defs and no Static prefix', { options: { labels: 'max' } }, async ($, on) => {
  mockedRich(on)
  await $.command.run(RUN)
  expect(await seeText($, /Tool defs/)).toBe(true)
  expect(await seeText($, /Static prefix/)).toBe(false)
})

test('v0.5 /context-bar min replies and the band shows Chat and Tools, not User prompt', async ($, on) => {
  mockedRich(on)
  await $.command.run(RUN)
  const r = await $.command.run({ ...RUN, args: 'min' })
  expect(r.text).toBe('Context band: min labels.')
  expect(await seeText($, /Chat/)).toBe(true)
  expect(await seeText($, /Tools/)).toBe(true)
  expect(await seeText($, /User prompt/)).toBe(false)
})

test('v0.5 /context-bar min on a hidden band shows it', async ($, on) => {
  mockedRich(on)
  await $.command.run({ ...RUN, args: 'min' })
  expect(await seeText($, /Chat/)).toBe(true)
})

test('v0.5 /context-bar norm after min goes back to User prompt', async ($, on) => {
  mockedRich(on)
  await $.command.run({ ...RUN, args: 'min' })
  const r = await $.command.run({ ...RUN, args: 'norm' })
  expect(r.text).toBe('Context band: norm labels.')
  expect(await seeText($, /User prompt/)).toBe(true)
  expect(await seeText($, /Chat/)).toBe(false)
})

test('v0.5 /context-bar max after the default shows Tool defs', async ($, on) => {
  mockedRich(on)
  await $.command.run(RUN)
  const r = await $.command.run({ ...RUN, args: 'max' })
  expect(r.text).toBe('Context band: max labels.')
  expect(await seeText($, /Tool defs/)).toBe(true)
})

test('v0.5 labels option "huge" shows n/a with min, norm or max in the error, no throw', { options: { labels: 'huge' } }, async ($, on) => {
  mockedRich(on)
  await $.command.run(RUN)
  expect(await seeText($, /n\/a \(.*(min|norm|max).*\)/)).toBe(true)
})

test('v0.5 usage text lists min|norm|max', async ($, on) => {
  mockedRich(on)
  const r = await $.command.run({ ...RUN, args: 'x' })
  expect(r.text).toBe('Usage: /context-bar [r|top|min|norm|max]')
})

test('v0.5 header shows "prefix <tokens>" when static rows exist', async ($, on) => {
  mockedRich(on)
  await $.command.run(RUN)
  expect(await seeText($, /prefix \d/)).toBe(true)
})

test('v0.5 bar shows the ┃ prefix marker', async ($, on) => {
  mockedRich(on)
  await $.command.run(RUN)
  expect(await seeText($, /┃/)).toBe(true)
})

test('v0.5.2 S5 band bar uses solid █ static, dotted ▓ conversation, light ░ free', async ($, on) => {
  mockedRich(on)
  await $.command.run(RUN)
  expect(await seeText($, /█/)).toBe(true)
  expect(await seeText($, /▓/)).toBe(true)
  expect(await seeText($, /░/)).toBe(true)
})

test('the breakdown is always counted with summary detail: no plugin-initiated token-count requests', async ($, on) => {
  const details: unknown[] = []
  on('session.usage', (($: never, e: { breakdown?: unknown } | undefined) => {
    if (e?.breakdown !== undefined) details.push(e.breakdown)
    return { value: { context: { tokens: 1000, window: 100000, breakdown: RICH } } }
  }) as never)
  on('session.messages', () => ({ value: MESSAGES }) as never)
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: [] }) as never)
  await $.command.run(RUN)
  await $.command.run({ ...RUN, args: 'r' })
  expect(details.length).toBeGreaterThan(0)
  expect(details.every(d => d === 'summary')).toBe(true)
})

// v0.7 themes: palette follows the theme option, else the host theme; overrides from the colors option.
const freeColour = async ($: Engine) => {
  const ui = await mountBand($)
  const found = await ui.find({ type: 'Text', text: /^░+$/ })
  await ui.unmount()
  return found?.props.color
}
const hostTheme = (on: On, value: string) =>
  on('config.list', () => ({ value: [{ key: 'theme', label: 'Theme', kind: 'choice', value, provider: { kind: 'engine' } }] }) as never)

test('v0.7 theme option light draws Free in the light palette colour', { options: { theme: 'light' } }, async ($, on) => {
  mockedRich(on)
  await $.command.run(RUN)
  expect(await freeColour($)).toBe(PALETTES.light.free)
})

test('v0.7 theme option dark wins over a light host theme', { options: { theme: 'dark' } }, async ($, on) => {
  mockedRich(on)
  hostTheme(on, 'light')
  await $.command.run(RUN)
  expect(await freeColour($)).toBe(PALETTES.dark.free)
})

test('v0.7 theme auto (default) follows a light host theme', async ($, on) => {
  mockedRich(on)
  hostTheme(on, 'light-daltonized')
  await $.command.run(RUN)
  expect(await freeColour($)).toBe(PALETTES.light.free)
})

test('v0.7 colors option overrides one colour of the chosen theme', { options: { theme: 'dark', colors: '{"dark":{"free":"#123456"}}' } }, async ($, on) => {
  mockedRich(on)
  await $.command.run(RUN)
  expect(await freeColour($)).toBe('#123456')
})

test('v0.7 theme option "sepia" shows n/a naming auto, dark or light, no throw', { options: { theme: 'sepia' } }, async ($, on) => {
  mockedRich(on)
  await $.command.run(RUN)
  expect(await seeText($, /n\/a \(.*auto, dark or light.*\)/)).toBe(true)
})

test('v0.7 bad colors option shows n/a naming colors, no throw', { options: { colors: '{"dark":{"nope":"#000000"}}' } }, async ($, on) => {
  mockedRich(on)
  await $.command.run(RUN)
  expect(await seeText($, /n\/a \(.*colors.*\)/)).toBe(true)
})

// ---- v0.8: expanded band, 30-minute trend ----

const MEASURE = (tokens: number, changed: string[] = ['context']) =>
  ({ context: { tokens, window: WINDOW }, rateLimits: [], changed }) as never
const USAGE = (input: number, output = 0, read = 0, written = 0) =>
  ({ ...(TURN as object), usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: written, model: 'm' } }) as never

/** Bottoms for the events the trend listens to; usage calls are counted. */
const trendMocks = (on: On) => {
  const seen = { calls: 0 }
  on('session.usage', () => {
    seen.calls += 1
    return { value: { context: { window: WINDOW, breakdown: BREAKDOWN } } } as never
  })
  on('session.messages', () => ({ value: MESSAGES }) as never)
  on('turn.complete', () => ({ text: '' }))
  on('session.measure', ((_$: never, e: { changed: string[] }) => ({ changed: e.changed })) as never)
  on('ui.render', () => ({ type: 'Text', props: {}, children: [] }) as never)
  const clock = mock.clock(on, { now: 10_000_000 })
  return Object.assign(seen, { clock })
}

test('v0.8 processed total sums the four token counts of every main turn, hidden band included, with no usage call', async ($, on) => {
  const seen = trendMocks(on)
  const spy = spyState(on)
  await $.turn.complete(USAGE(10, 5, 100, 1))
  await $.turn.complete(USAGE(20, 0, 200, 0))
  expect(spy.last('processedTotal')).toBe(336)
  expect((spy.last('processedPoints') as { value: number }[]).map(p => p.value)).toEqual([116, 336])
  expect(seen.calls).toBe(0)
})

test('v0.8 a subagent turn adds nothing to the processed total', async ($, on) => {
  trendMocks(on)
  const spy = spyState(on)
  await $.turn.complete({ ...(USAGE(10) as object), agentId: 'sub-1' } as never)
  expect(spy.last('processedTotal')).toBeUndefined()
})

test('v0.8 a turn with no usage records nothing', async ($, on) => {
  trendMocks(on)
  const spy = spyState(on)
  await $.turn.complete(TURN)
  expect(spy.last('processedTotal')).toBeUndefined()
})

test('v0.8 resident points come from session.measure when the context moved, hidden band included', async ($, on) => {
  const seen = trendMocks(on)
  const spy = spyState(on)
  await $.session.measure(MEASURE(5000))
  await $.session.measure(MEASURE(5000, ['cost']))
  await $.session.measure(MEASURE(7000))
  expect((spy.last('residentPoints') as { value: number }[]).map(p => p.value)).toEqual([5000, 7000])
  expect(seen.calls).toBe(0)
})

test('v0.8 a compaction adds a resident point at the size after it, since no measure follows until the next response', async ($, on) => {
  trendMocks(on)
  on('session.compact', () => ({ messages: [KEPT], tokensBefore: 90000, tokensAfter: 12000 }) as never)
  const spy = spyState(on)
  await $.session.measure(MEASURE(90000))
  await $.session.compact({ trigger: 'manual', messages: [KEPT] } as never)
  expect((spy.last('residentPoints') as { value: number }[]).map(p => p.value)).toEqual([90000, 12000])
})

test('v0.8 a bar refresh adds a resident point at the size it measured, and none when the size is unchanged', async ($, on) => {
  const ctl: Ctl = { tokens: 2000 }
  growthMock(on, ctl)
  mock.clock(on, { now: 10_000_000 })
  const spy = spyState(on)
  await $.command.run(RUN) // turns the band on: full refresh at 2000
  await $.command.run({ ...RUN, args: 'r' }) // same size: no new point
  ctl.tokens = 2400
  await $.command.run({ ...RUN, args: 'r' })
  expect((spy.last('residentPoints') as { value: number }[]).map(p => p.value)).toEqual([2000, 2400])
})

test('v0.8 the open trend moves while idle: points age out of the window on a timer, with no turn or measure', async ($, on) => {
  const { clock } = trendMocks(on)
  await $.command.run(RUN)
  await $.session.measure(MEASURE(1000))
  await clock.advance(10 * 60_000)
  await $.session.measure(MEASURE(5000))
  await clock.advance(10 * 60_000)
  await $.session.measure(MEASURE(9000))
  const ui = await mountBand($)
  await ui.press({ key: 'expand' })
  expect(await ui.find({ type: 'Text', text: /10k ┤/ })).toBeDefined() // 1k..9k from zero
  await clock.advance(25 * 60_000) // idle: the 1k point is now more than 30 minutes old
  expect(await ui.find({ type: 'Text', text: /9k ┤/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /10k ┤/ })).toBeUndefined()
  await ui.unmount()
})

test('v0.8 trendRefreshSeconds sets the redraw interval', { options: { trendRefreshSeconds: 60 } }, async ($, on) => {
  const { clock } = trendMocks(on)
  const spy = spyState(on)
  await $.command.run(RUN)
  const ui = await mountBand($)
  await ui.press({ key: 'expand' })
  await clock.advance(45_000) // under 60 s: no tick yet
  expect(spy.last('redraw') ?? 0).toBe(0)
  await clock.advance(20_000) // past 60 s
  expect(spy.last('redraw')).toBe(1)
  await ui.unmount()
})

test('v0.8 trendRefreshSeconds 45 shows n/a naming the field, no throw', { options: { trendRefreshSeconds: 45 } }, async ($, on) => {
  trendMocks(on)
  await $.command.run(RUN)
  const ui = await mountBand($)
  expect(await ui.find({ type: 'Text', text: /n\/a \(.*trendRefreshSeconds.*\)/ })).toBeDefined()
  await ui.unmount()
})

test('v0.8 collapsing the trend stops the redraw timer', async ($, on) => {
  const { clock } = trendMocks(on)
  const spy = spyState(on)
  await $.command.run(RUN)
  const ui = await mountBand($)
  await ui.press({ key: 'expand' })
  await clock.advance(60_000)
  const open = spy.last('redraw') as number
  expect(open).toBeGreaterThan(0)
  await ui.press({ key: 'expand' }) // collapse
  await clock.advance(5 * 60_000)
  const after = spy.last('redraw') as number
  await clock.advance(5 * 60_000)
  expect(spy.last('redraw')).toBe(after)
  await ui.unmount()
})

test('v0.8 collapsed band shows ▼ and no trend; pressing it opens the trend and shows ▲', async ($, on) => {
  trendMocks(on)
  await $.command.run(RUN)
  const ui = await mountBand($)
  expect(await ui.find({ type: 'Button', text: /▼/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /trend · last 30m/ })).toBeUndefined()
  await ui.press({ key: 'expand' })
  expect(await ui.find({ type: 'Button', text: /▲/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /trend · last 30m/ })).toBeDefined()
  await ui.press({ key: 'expand' })
  expect(await ui.find({ type: 'Text', text: /trend · last 30m/ })).toBeUndefined()
  await ui.unmount()
})

test('v0.8 expanded band with no samples says "collecting…" and draws no axes', async ($, on) => {
  trendMocks(on)
  await $.command.run(RUN)
  const ui = await mountBand($)
  await ui.press({ key: 'expand' })
  expect(await ui.find({ type: 'Text', text: /collecting…/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /-30m/ })).toBeUndefined()
  await ui.unmount()
})

test('v0.8 the expanded band draws a line chart: y labels in tokens, time labels on x, no min/max text', async ($, on) => {
  const { clock } = trendMocks(on)
  await $.command.run(RUN)
  await $.session.measure(MEASURE(5000))
  await clock.advance(10 * 60_000)
  await $.session.measure(MEASURE(9000))
  const ui = await mountBand($)
  await ui.press({ key: 'expand' })
  expect(await ui.find({ type: 'Text', text: /9k ┤/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /5k ┤/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /-30m.*-20m.*-10m.*now/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /[\u2801-\u28ff]/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /min |max / })).toBeUndefined()
  await ui.unmount()
})

test('v0.8 the toggle switches the chart between resident and cumulative processed, each with its own y axis', async ($, on) => {
  const { clock } = trendMocks(on)
  await $.command.run(RUN)
  await $.session.measure(MEASURE(5000))
  await $.turn.complete(USAGE(1000, 0, 0, 0))
  await clock.advance(10 * 60_000)
  await $.session.measure(MEASURE(9000))
  await $.turn.complete(USAGE(2000, 0, 0, 0))
  const ui = await mountBand($)
  await ui.press({ key: 'expand' })
  expect(await ui.find({ type: 'Text', text: /9k ┤/ })).toBeDefined()
  await ui.press({ key: 'metric' })
  expect(await ui.find({ type: 'Text', text: /3k ┤/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /9k ┤/ })).toBeUndefined()
  await ui.press({ key: 'metric' })
  expect(await ui.find({ type: 'Text', text: /9k ┤/ })).toBeDefined()
  await ui.unmount()
})

// --- CE_CONTEXT_BAR=off: the hooks module has no `process`, so the switch is read through $.env at each event ---

test('CE_CONTEXT_BAR=off: no command is registered and the plugin hides itself', async ($, on) => {
  mock.env(on, { CE_CONTEXT_BAR: 'off' })
  let registered = false
  on('session.start', () => ({ cwd: '/work' }) as never)
  on('command.register', () => { registered = true; return { value: undefined } as never })
  await $.session.start({ cwd: '/work' } as never)
  expect(registered).toBe(false)
})

test('CE_CONTEXT_BAR=off: /context-bar says it is switched off and shows nothing', async ($, on) => {
  mock.env(on, { CE_CONTEXT_BAR: 'off' })
  const result = await $.command.run(RUN)
  expect(result.text).toBe('context-bar is switched off (CE_CONTEXT_BAR=off).')
})

test('CE_CONTEXT_BAR=off: no usage call after a turn, even for a band that was on', async ($, on) => {
  let calls = 0
  on('session.usage', () => { calls += 1; return { value: { context: {} } } as never })
  on('turn.complete', () => ({ text: '' }))
  mock.env(on, { CE_CONTEXT_BAR: 'off' })
  await $.turn.complete(TURN)
  expect(calls).toBe(0)
})

test('a value other than the exact off leaves the plugin working', async ($, on) => {
  mock.env(on, { CE_CONTEXT_BAR: 'OFF' })
  const result = await $.command.run(RUN)
  expect(result.text).toBe('Context band on.')
})

// ---- malformed and over-long transcripts: commands and events complete ----

const MALFORMED = [null, 7, 'x', [], { role: 'user' }, { role: 'assistant', toolUses: [null, { tool: 5 }], toolResults: 'x' }, { role: 'tool', toolUses: [{ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'z' }] }, { role: 'user', text: 'fine' }]

test('/context-bar top completes on a malformed transcript and lists the well-formed part', async ($, on) => {
  mocked(on, undefined, MALFORMED)
  const r = await $.command.run(TOP_ARGS)
  expect(r.text).toContain('user text')
})

test('/context-bar top completes when the transcript itself is not a list', async ($, on) => {
  mocked(on, undefined, { not: 'a list' })
  const r = await $.command.run(TOP_ARGS)
  expect(r.text).toBe('top items: none yet')
})

test('/context-bar top returns a bounded message when reading the transcript fails', async ($, on) => {
  on('session.messages', () => { throw new Error('x'.repeat(500)) })
  const r = await $.command.run(TOP_ARGS)
  expect((r.text as string).startsWith('context-bar: cannot list the top items')).toBe(true)
  expect((r.text as string).length).toBeLessThan(200)
})

test('/context-bar top on a transcript over the walk limit lists five rows and says older messages were not read', async ($, on) => {
  const many = Array.from({ length: 20_003 }, () => ({ role: 'user', text: 'same size text' }))
  mocked(on, undefined, many)
  const r = await $.command.run(TOP_ARGS)
  const lines = (r.text as string).split('\n')
  expect(lines).toHaveLength(6)
  expect(lines[0]).toContain('3 older not read')
})

test('a refresh completes on a malformed transcript and shows the band', async ($, on) => {
  mocked(on, undefined, MALFORMED)
  await $.command.run(RUN) // show the band
  const r = await $.command.run({ ...RUN, args: 'r' })
  expect(r.text).toBe('Context band refreshed.')
})
