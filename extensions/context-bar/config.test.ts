// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BAR_CONFIG_PATH, isContextBarOff, loadBarConfig } from './config'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const configFile = (contents: string): string => {
  const dir = mkdtempSync(join(import.meta.dir, '.config-test-'))
  dirs.push(dir)
  const path = join(dir, 'config.json')
  writeFileSync(path, contents)
  return path
}

describe('loadBarConfig', () => {
  test('exposes the default path; a missing file gives the default labels and no refresh key', () => {
    expect(BAR_CONFIG_PATH).toContain('.config/context-bar/config.json')
    const config = loadBarConfig(join(import.meta.dir, 'missing-config.json'))
    expect(config.labels).toBe('norm')
    expect(config).not.toHaveProperty('refreshEveryRounds')
  })
  test('reports the path for invalid JSON', () => {
    const badJson = configFile('{')
    expect(() => loadBarConfig(badJson)).toThrow(badJson)
  })
  test('refreshEveryRounds is no longer supported: any value throws with the path', () => {
    for (const value of ['3', '0', '"x"', 'null']) {
      const path = configFile(`{"refreshEveryRounds":${value}}`)
      expect(() => loadBarConfig(path)).toThrow(path)
      expect(() => loadBarConfig(path)).toThrow(/refreshEveryRounds.*no longer supported/)
    }
  })
  test('the unsupported key is refused even next to a valid labels value', () => {
    const path = configFile('{"labels":"max","refreshEveryRounds":5}')
    expect(() => loadBarConfig(path)).toThrow(/no longer supported/)
  })
  test('v0.5 labels: absent means norm; min, norm and max load', () => {
    expect(loadBarConfig(configFile('{}')).labels).toBe('norm')
    for (const level of ['min', 'norm', 'max']) expect(loadBarConfig(configFile(`{"labels":"${level}"}`)).labels).toBe(level)
  })
  test('v0.5 labels: a bad value throws with the path and the allowed values', () => {
    const bad = configFile('{"labels":"huge"}')
    expect(() => loadBarConfig(bad)).toThrow(bad)
    expect(() => loadBarConfig(bad)).toThrow(/min.*norm.*max/)
  })
})

describe('Claude manifest (v0.5.1)', () => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dir, '../../plugins/context-bar/.claude-plugin/plugin.json'), 'utf8')) as {
    version: string
    userConfig: Record<string, unknown>
  }
  test('refreshGrowthPercent replaces refreshEveryRounds', () => {
    expect(manifest.userConfig.refreshEveryRounds).toBeUndefined()
    expect(manifest.userConfig.refreshGrowthPercent).toMatchObject({ type: 'number', title: 'Refresh after growth (%)', default: 5 })
  })
})

describe('offloadAtTokens (optional, off by default)', () => {
  test('absent: the marker is the host compaction point', () => {
    expect(loadBarConfig(configFile('{}')).offloadAtTokens).toBeUndefined()
  })
  test('a positive integer is kept', () => {
    expect(loadBarConfig(configFile('{"offloadAtTokens":240000}')).offloadAtTokens).toBe(240000)
  })
  test('zero, negative, fractional, a string or null throws with the path', () => {
    for (const value of ['0', '-5', '1.5', '"9"', 'null']) {
      const path = configFile(`{"offloadAtTokens":${value}}`)
      expect(() => loadBarConfig(path)).toThrow(path)
    }
  })
})

describe('isContextBarOff (CE_CONTEXT_BAR)', () => {
  test('only the exact value off turns it off', () => {
    expect(isContextBarOff({ CE_CONTEXT_BAR: 'off' })).toBe(true)
    for (const value of [undefined, '', 'on', 'OFF', 'false', '0', ' off']) expect(isContextBarOff({ CE_CONTEXT_BAR: value })).toBe(false)
    expect(isContextBarOff({})).toBe(false)
  })
})
