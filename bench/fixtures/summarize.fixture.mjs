// SPDX-License-Identifier: Apache-2.0
//
// Fixtures for the advisory CI summary (bench/summarize.mjs). Run: `node --test bench/fixtures/*.fixture.mjs`.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'
import { goodRecord } from './helpers.mjs'

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'summarize.mjs')
const line = (host, status, rec) => `APPEND-RUN-JSON ${JSON.stringify({ host, status, elapsedMs: 1000, cleanup: 'clean', problems: [], record: rec })}\n`
const run = (files) => {
  const dir = mkdtempSync(join(tmpdir(), 'append-sum-'))
  for (const [n, c] of Object.entries(files)) writeFileSync(join(dir, n), c)
  const r = spawnSync(process.execPath, [script, dir], { encoding: 'utf8' })
  return { code: r.status, out: r.stdout }
}
const meta = JSON.stringify({ runner: { os: 'macOS', arch: 'ARM64', name: 'GitHub Actions 1', image: 'macos15', imageVersion: '1' }, machine: { cpuCount: 3, cpuModel: 'x', loadavg: [1, 1, 1] }, tools: { node: 'v24', bun: '1.4.4', claude: '2.1.310' }, run: { sha: 'abc', runAttempt: '1' } })

test('both valid: exit 0 and a table per host', () => {
  const r = run({ 'claude.out': line('claude', 'valid', goodRecord('claude')), 'pi.out': line('pi', 'valid', goodRecord('pi')), 'meta.json': meta })
  assert.equal(r.code, 0); assert.match(r.out, /\| claude \| \*\*valid\*\*/); assert.match(r.out, /### pi: per pair/); assert.match(r.out, /macOS\/ARM64/)
})
test('one host invalid: exit 1 and the status is shown', () => {
  const r = run({ 'claude.out': line('claude', 'valid', goodRecord('claude')), 'pi.out': line('pi', 'timeout'), 'meta.json': meta })
  assert.equal(r.code, 1); assert.match(r.out, /\| pi \| \*\*timeout\*\*/); assert.match(r.out, /red on purpose/)
})
test('missing files, missing metadata, duplicate or malformed status lines are all failures', () => {
  let r = run({ 'meta.json': meta }); assert.equal(r.code, 1); assert.match(r.out, /\*\*missing\*\*/)
  r = run({ 'claude.out': line('claude', 'valid', goodRecord('claude')), 'pi.out': line('pi', 'valid', goodRecord('pi')) }); assert.equal(r.code, 0); assert.match(r.out, /Runner metadata: MISSING/)
  r = run({ 'claude.out': line('claude', 'valid', goodRecord('claude')) + line('claude', 'valid', goodRecord('claude')), 'pi.out': line('pi', 'valid', goodRecord('pi')), 'meta.json': meta })
  assert.equal(r.code, 1); assert.match(r.out, /2 status lines/)
  r = run({ 'claude.out': 'APPEND-RUN-JSON {not json\n', 'pi.out': line('pi', 'valid', goodRecord('pi')), 'meta.json': meta }); assert.equal(r.code, 1); assert.match(r.out, /not JSON/)
})
