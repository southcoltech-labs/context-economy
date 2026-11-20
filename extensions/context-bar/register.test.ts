// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'bun:test'
import { registerContextBar } from './register'

type Handler = (event: unknown, ctx: unknown) => unknown
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '')

const setup = (o: { tokens?: number | null; prompt?: string; throws?: boolean; offload?: boolean; configError?: boolean; labels?: string; messages?: unknown[]; entries?: unknown[] } = {}) => {
  const handlers: Record<string, Handler> = {}
  const commands: Record<string, { handler: (args: string, ctx: unknown) => Promise<void> | void }> = {}
  const widgets: Record<string, unknown> = {}
  const notes: string[] = []
  let renders = 0
  let measurements = 0
  const pi = {
    on: (e: string, h: Handler) => { handlers[e] = h },
    registerCommand: (name: string, c: { handler: (args: string, ctx: unknown) => void }) => { commands[name] = c },
    getAllTools: () => [{ name: 'read', description: 'r', parameters: {} }],
    getActiveTools: () => ['read'],
  }
  const ctx = {
    hasUI: true,
    getContextUsage: () => {
      measurements += 1
      if (o.throws) throw new Error('usage broke')
      return { tokens: o.tokens === undefined ? 20000 : o.tokens, contextWindow: 100000, percent: 20 }
    },
    getSystemPrompt: () => o.prompt ?? 'base prompt',
    model: { provider: 'deepseek', id: 'deepseek-flash' },
    sessionManager: { getEntries: () => o.entries ?? [] },
    ui: {
      setWidget: (key: string, f: unknown) => { widgets[key] = f },
      notify: (m: string) => { notes.push(m) },
    },
  }
  registerContextBar(pi as never, { compaction: () => ({ enabled: true, reserveTokens: 16384 }), messages: () => o.messages ?? [], config: () => { if (o.configError) throw new Error('bad config path'); return { ...(o.labels === undefined ? {} : { labels: o.labels }), ...(o.offload ? { offloadAtTokens: 50000 } : {}) } } } as never)
  const lines = (width = 80): string[] => {
    const f = widgets['context-bar'] as ((tui: unknown, theme: unknown) => { render(w: number): string[] }) | undefined
    if (!f) return []
    return f({ requestRender: () => { renders += 1 } }, {}).render(width).map(plain)
  }
  return { handlers, commands, widgets, notes, ctx, lines, renders: () => renders, measurements: () => measurements }
}

describe('context-bar widget', () => {
  test('session_start shows the band with the real total', async () => {
    const s = setup()
    await s.handlers.session_start!({}, s.ctx)
    const l = s.lines()
    expect(l[0]).toContain('20k of 100k')
    expect(l[1].length).toBe(80)
  })
  test('refresh events update the view', async () => {
    const s = setup()
    for (const e of ['session_start', 'agent_end', 'session_compact', 'model_select']) {
      expect(s.handlers[e]).toBeDefined()
    }
  })
  test('v0.5.1 every agent_end measures; turn_end never does', async () => {
    const s = setup()
    await s.handlers.session_start!({}, s.ctx)
    expect(s.measurements()).toBe(1)
    await s.handlers.agent_end!({}, s.ctx)
    expect(s.measurements()).toBe(2)
    await s.handlers.turn_end?.({}, s.ctx)
    expect(s.measurements()).toBe(2)
    for (let i = 0; i < 3; i += 1) await s.handlers.agent_end!({}, s.ctx)
    expect(s.measurements()).toBe(5)
  })
  test('v0.5.1 a round shows the new total at once', async () => {
    const s = setup()
    await s.handlers.session_start!({}, s.ctx)
    expect(s.lines()[0]).toContain('20k of 100k')
    s.ctx.getContextUsage = () => ({ tokens: 30000, contextWindow: 100000, percent: 30 }) as never
    await s.handlers.agent_end!({}, s.ctx)
    expect(s.lines()[0]).toContain('30k of 100k')
  })
  test('manual refresh and compaction each measure once', async () => {
    const s = setup()
    await s.handlers.session_start!({}, s.ctx)
    await s.commands['context-bar']!.handler('r', s.ctx)
    expect(s.measurements()).toBe(2)
    await s.handlers.session_compact!({}, s.ctx)
    expect(s.measurements()).toBe(3)
    await s.handlers.agent_end!({}, s.ctx)
    expect(s.measurements()).toBe(4)
  })
  test('config errors render in the band and do not throw', async () => {
    const s = setup({ configError: true })
    await s.handlers.session_start!({}, s.ctx)
    expect(s.lines()[0]).toContain('n/a')
    expect(s.lines()[0]).toContain('bad config path')
  })
  test('v0.4 band shows the five split rows instead of Messages, with the split header', async () => {
    const s = setup({ messages: [
      { role: 'user', content: [{ type: 'text', text: 'x'.repeat(4000) }] },
      { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a' } }, { type: 'toolCall', id: 'c2', name: 'bash', arguments: { command: 'npm test' } }] },
      { role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: [{ type: 'text', text: 'r'.repeat(8000) }] },
      { role: 'toolResult', toolCallId: 'c2', toolName: 'bash', content: [{ type: 'text', text: 't'.repeat(6000) }] },
    ] })
    await s.handlers.session_start!({}, s.ctx)
    const text = s.lines(120).join('\n')
    for (const label of ['User prompt', 'Replies', 'Tool in', 'Tool out', 'Reads']) expect(text).toContain(label)
    expect(text).not.toContain('Chat')
    expect(text).not.toContain('Messages')
    expect(s.lines(120).join('\n')).toContain('distribution est.')
  })
  test('v0.5.1 never shows the age, however many rounds pass', async () => {
    const s = setup()
    await s.handlers.session_start!({}, s.ctx)
    for (let i = 0; i < 3; i += 1) await s.handlers.agent_end!({}, s.ctx)
    expect(s.lines(120).join('\n')).not.toMatch(/updated \d+ turns? ago/)
    expect(s.lines(120).join('\n')).toContain('distribution est.')
  })
  test('model_select refreshes immediately', async () => {
    const s = setup()
    await s.handlers.session_start!({}, s.ctx)
    await s.handlers.model_select!({}, s.ctx)
    expect(s.measurements()).toBe(2)
  })
  test('band hidden: rounds and compaction do not measure', async () => {
    const s = setup()
    await s.handlers.session_start!({}, s.ctx)
    await s.commands['context-bar']!.handler('', s.ctx)
    const before = s.measurements()
    for (let i = 0; i < 6; i += 1) await s.handlers.agent_end!({}, s.ctx)
    await s.handlers.session_compact!({}, s.ctx)
    expect(s.measurements()).toBe(before)
  })
  test('with offloadAtTokens configured the marker is that trigger', async () => {
    const s = setup({ offload: true })
    await s.handlers.session_start!({}, s.ctx)
    expect(s.lines()[0]).toContain('compacts at 50k')
  })
  test('without offloadAtTokens the marker is Pi compaction', async () => {
    const s = setup()
    await s.handlers.session_start!({}, s.ctx)
    expect(s.lines()[0]).toContain('compacts at 83.6k')
  })
  test('unknown total shows n/a', async () => {
    const s = setup({ tokens: null })
    await s.handlers.session_start!({}, s.ctx)
    expect(s.lines()[0]).toContain('n/a')
  })
  test('a failure shows the error in the band and never throws into Pi', async () => {
    const s = setup({ throws: true })
    await s.handlers.session_start!({}, s.ctx)
    expect(s.lines()[0]).toContain('n/a (usage broke)')
  })
  test('/context-bar toggles off and on; r refreshes', async () => {
    const s = setup()
    await s.handlers.session_start!({}, s.ctx)
    await s.commands['context-bar']!.handler('', s.ctx)
    expect(s.widgets['context-bar']).toBeUndefined()
    expect(s.notes.at(-1)).toBe('Context band off.')
    await s.commands['context-bar']!.handler('', s.ctx)
    expect(s.lines()[0]).toContain('20k of 100k')
    await s.commands['context-bar']!.handler('r', s.ctx)
    expect(s.notes.at(-1)).toBe('Context band refreshed.')
    await s.commands['context-bar']!.handler('x', s.ctx)
    expect(s.notes.at(-1)).toBe('Usage: /context-bar [r|top|min|norm|max]')
  })
  test('no UI (print mode): no widget', async () => {
    const s = setup()
    await s.handlers.session_start!({}, { ...s.ctx, hasUI: false })
    expect(s.widgets['context-bar']).toBeUndefined()
  })

  describe('v0.5 label levels and prefix marker', () => {
    const MSGS = [
      { role: 'user', content: [{ type: 'text', text: 'x'.repeat(4000) }] },
      { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a' } }] },
      { role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: [{ type: 'text', text: 'r'.repeat(8000) }] },
    ]
    test('default level is norm: Static prefix, not Tool defs; header has prefix, bar has the marker', async () => {
      const s = setup({ messages: MSGS })
      await s.handlers.session_start!({}, s.ctx)
      const l = s.lines(120)
      const text = l.join('\n')
      expect(text).toContain('Static prefix')
      expect(text).not.toContain('Tool defs')
      expect(l[0]).toMatch(/prefix \d/)
      expect(l[1]).toContain('┃')
    })
    test('config labels min shows Chat and Tools, not User prompt', async () => {
      const s = setup({ messages: MSGS, labels: 'min' })
      await s.handlers.session_start!({}, s.ctx)
      const text = s.lines(120).join('\n')
      expect(text).toContain('Chat')
      expect(text).toContain('Tools')
      expect(text).not.toContain('User prompt')
    })
    test('config labels max shows the Pi static rows (System, Tool defs), no Static prefix', async () => {
      const s = setup({ messages: MSGS, labels: 'max' })
      await s.handlers.session_start!({}, s.ctx)
      const text = s.lines(120).join('\n')
      expect(text).toContain('System')
      expect(text).toContain('Tool defs')
      expect(text).not.toContain('Static prefix')
    })
    test('a bad config labels value shows n/a with min, norm or max in the band, no throw', async () => {
      const s = setup({ labels: 'huge' })
      await s.handlers.session_start!({}, s.ctx)
      expect(s.lines(120)[0]).toMatch(/n\/a \(.*(min|norm|max).*\)/)
    })
    test('/context-bar max notifies and shows Tool defs; min then norm switch levels', async () => {
      const s = setup({ messages: MSGS })
      await s.handlers.session_start!({}, s.ctx)
      await s.commands['context-bar']!.handler('max', s.ctx)
      expect(s.notes.at(-1)).toBe('Context band: max labels.')
      expect(s.lines(120).join('\n')).toContain('Tool defs')
      await s.commands['context-bar']!.handler('min', s.ctx)
      expect(s.notes.at(-1)).toBe('Context band: min labels.')
      expect(s.lines(120).join('\n')).toContain('Chat')
      await s.commands['context-bar']!.handler('norm', s.ctx)
      expect(s.notes.at(-1)).toBe('Context band: norm labels.')
      const text = s.lines(120).join('\n')
      expect(text).toContain('User prompt')
      expect(text).not.toContain('Chat')
    })
  })

  describe('v0.3 top and compaction line', () => {
    const MESSAGES = [
      { role: 'user', content: [{ type: 'text', text: 'x'.repeat(400) }] },
      { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'src/a.ts' } }, { type: 'toolCall', id: 'c2', name: 'bash', arguments: { command: 'npm test' } }] },
      { role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: [{ type: 'text', text: 'r'.repeat(8000) }] },
      { role: 'toolResult', toolCallId: 'c2', toolName: 'bash', content: [{ type: 'text', text: 't'.repeat(2000) }] },
    ]
    const compaction = (ageMs: number, tokensBefore: number) => ({
      type: 'compaction', id: `k${ageMs}`, parentId: null, timestamp: new Date(Date.now() - ageMs).toISOString(),
      summary: 's', firstKeptEntryId: 'e1', tokensBefore,
    })
    const MIN = 60_000

    test('/context-bar top notifies the top items, biggest first', async () => {
      const s = setup({ messages: MESSAGES })
      await s.commands['context-bar']!.handler('top', s.ctx)
      const lines = s.notes.at(-1)!.split('\n')
      expect(lines[0]).toBe('top items (≈ tokens)')
      expect(lines[1]).toContain('src/a.ts')
      expect(lines[2]).toContain('npm')
      expect(lines[2]).not.toContain('npm test') // arguments are never shown
    })
    test('v0.4 /context-bar top shows text items as user text / reply text', async () => {
      const s = setup({ messages: [
        { role: 'user', content: [{ type: 'text', text: 'x'.repeat(400) }] },
        { role: 'assistant', content: [{ type: 'text', text: 'y'.repeat(200) }] },
      ] })
      await s.commands['context-bar']!.handler('top', s.ctx)
      const note = s.notes.at(-1)!
      expect(note).toContain('user text')
      expect(note).toContain('reply text')
    })
    test('/context-bar top with no messages says none yet', async () => {
      const s = setup()
      await s.commands['context-bar']!.handler('top', s.ctx)
      expect(s.notes.at(-1)).toBe('top items: none yet')
    })
    test('/context-bar top works while the band is off and leaves it off', async () => {
      const s = setup({ messages: MESSAGES })
      await s.handlers.session_start!({}, s.ctx)
      await s.commands['context-bar']!.handler('', s.ctx)
      expect(s.widgets['context-bar']).toBeUndefined()
      await s.commands['context-bar']!.handler('top', s.ctx)
      expect(s.notes.at(-1)).toContain('top items')
      expect(s.widgets['context-bar']).toBeUndefined()
      await s.commands['context-bar']!.handler('', s.ctx)
      expect(s.notes.at(-1)).toBe('Context band on.')
    })
    test('compaction line shows count, age and was-tokens from the last compaction entry', async () => {
      const s = setup({ entries: [
        { type: 'message', id: 'm1', parentId: null, timestamp: new Date().toISOString(), message: {} },
        compaction(60 * MIN, 50000),
        compaction(3 * MIN, 90000),
      ] })
      await s.handlers.session_start!({}, s.ctx)
      const text = s.lines(120).join('\n')
      expect(text).toContain('compacted 2×')
      expect(text).toContain('3m ago')
      expect(text).toContain('was 90k')
    })
    test('the compaction text shares the footer line with the note, and is hidden when the width is too narrow', async () => {
      const s = setup({ entries: [compaction(3 * MIN, 90000)] })
      await s.handlers.session_start!({}, s.ctx)
      const wide = s.lines(120).at(-1)!
      expect(wide).toStartWith('distribution est.')
      expect(wide).toContain('compacted 1×')
      const narrow = s.lines(30)
      expect(narrow.at(-1)).toBe('distribution est.')
      expect(narrow.join('\n')).not.toContain('compacted')
    })
    test('no compaction entries: no compaction line', async () => {
      const s = setup({ entries: [{ type: 'message', id: 'm1', parentId: null, timestamp: new Date().toISOString(), message: {} }] })
      await s.handlers.session_start!({}, s.ctx)
      expect(s.lines(120).join('\n')).not.toContain('compacted')
    })
    test('a bad compaction timestamp shows n/a with the cause in the band and never throws', async () => {
      const bad = { ...compaction(MIN, 1000), timestamp: 'not-a-date' }
      const s = setup({ entries: [bad] })
      await s.handlers.session_start!({}, s.ctx)
      expect(s.lines(120)[0]).toMatch(/n\/a \(.*(compaction|timestamp).*\)/)
    })
  })
})
