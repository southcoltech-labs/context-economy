// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'

/** What the entrypoint registers with Pi, in a fresh process with the given CE_CONTEXT_BAR (undefined = unset). */
const registered = (value: string | undefined): string[] => {
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => k !== 'CE_CONTEXT_BAR' && v !== undefined)) as Record<string, string>
  if (value !== undefined) env.CE_CONTEXT_BAR = value
  const run = Bun.spawnSync([process.execPath, 'run', join(import.meta.dir, 'index.probe.ts')], { env, stderr: 'pipe' })
  if (run.exitCode !== 0) throw new Error(`probe failed: ${run.stderr.toString()}`)
  return JSON.parse(run.stdout.toString().trim().split('\n').at(-1) ?? '[]')
}

describe('the Pi entrypoint and the off switch', () => {
  test('CE_CONTEXT_BAR=off registers nothing: no event, no command', () => {
    expect(registered('off')).toEqual([])
  })
  test('without the switch it registers the command and its events', () => {
    const calls = registered(undefined)
    expect(calls).toContain('command:context-bar')
    expect(calls.some(c => c.startsWith('on:'))).toBe(true)
  })
  test('any other value does not turn it off', () => {
    for (const value of ['', 'no', 'OFF']) expect(registered(value)).toContain('command:context-bar')
  })
})
