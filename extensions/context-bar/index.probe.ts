// SPDX-License-Identifier: Apache-2.0

// Run by index.test.ts in a fresh process: Pi's SDK is an optional peer dependency that is not installed for the tests,
// and a bun:test module mock would leak into the other extensions' tests (they share one process).
import { plugin } from 'bun'

plugin({
  name: 'pi-sdk-stub',
  setup: build => {
    build.module('@earendil-works/pi-coding-agent', () => ({
      exports: { SettingsManager: { create: () => ({ getCompactionSettings: () => ({ enabled: true, reserveTokens: 16384 }) }) } },
      loader: 'object',
    }))
  },
})

const { default: contextBar } = await import('./index')
const calls: string[] = []
contextBar({
  on: (event: string) => { calls.push(`on:${event}`) },
  registerCommand: (name: string) => { calls.push(`command:${name}`) },
  getAllTools: () => [],
  getActiveTools: () => [],
} as never)
console.log(JSON.stringify(calls))
