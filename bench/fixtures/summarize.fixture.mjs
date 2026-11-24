// SPDX-License-Identifier: Apache-2.0
//
// Fixtures for the advisory CI summary (bench/summarize.mjs). Run: `node --test bench/fixtures/*.fixture.mjs`.
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'
import { goodRecord } from './helpers.mjs'

const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'summarize.mjs')
const wrapper = (host, over = {}) => ({ host, deadlineMs: 240000, elapsedMs: 1000, status: 'valid', exitCode: 0, signal: null, cleanup: 'clean', truncated: { stdout: false, stderr: false }, descendantsKilled: false, problems: [], record: goodRecord(host), ...over })
const line = (w) => `APPEND-RUN-JSON ${JSON.stringify(w)}\n`
const goodMeta = () => ({
  startedAt: '2026-11-23T18:00:00.000Z',
  runner: { name: 'GitHub Actions 1', os: 'macOS', arch: 'ARM64', image: 'macos15', imageVersion: '1', environment: 'github-hosted' },
  machine: { platform: 'darwin', arch: 'arm64', cpuCount: 3, cpuModel: 'x', totalMemMiB: 7000, freeMemMiB: 3000, loadavg: [1, 1, 1], uptimeSec: 50, diskFreeKiB: 123456 },
  tools: { node: 'v24.1.0', bun: '1.4.4', claude: '2.1.310 (Claude Code)' },
  run: { repository: 'o/r', sha: 'a'.repeat(40), ref: 'refs/pull/1/merge', runId: '9', runAttempt: '1', event: 'pull_request', job: 'append-measurement' },
})
const GOOD = () => ({ 'claude.out': line(wrapper('claude')), 'pi.out': line(wrapper('pi')), 'meta.json': JSON.stringify(goodMeta()) })

// Runs through a real pipe, as CI does (`| tee`), and captures everything that arrives.
const run = (files, env = {}) => new Promise((resolve) => {
  const dir = mkdtempSync(join(tmpdir(), 'append-sum-'))
  for (const [n, c] of Object.entries(files)) writeFileSync(join(dir, n), c)
  const p = spawn(process.execPath, [script, dir], { env: { ...process.env, GITHUB_STEP_SUMMARY: '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  p.stdout.on('data', (c) => { out += c })
  p.on('close', (code) => resolve({ code, out, ended: /END-OF-APPEND-REPORT verdict=(admissible|not-admissible)\n?$/.exec(out)?.[1] }))
})

test('both hosts valid with full metadata: admissible, exit 0, sentinel', async () => {
  const r = await run(GOOD())
  assert.equal(r.code, 0); assert.equal(r.ended, 'admissible'); assert.match(r.out, /\| claude \| \*\*valid\*\*/); assert.match(r.out, /### pi: per pair/)
  assert.ok(r.out.includes(JSON.stringify(goodMeta())), 'full metadata retained verbatim')
})

test('missing, unparseable or incomplete metadata makes two valid hosts NOT admissible', async () => {
  const base = GOOD()
  for (const [name, meta] of [['missing', undefined], ['not json', '{nope'], ['empty object', '{}'], ['array', '[]'],
    ['no sha', JSON.stringify({ ...goodMeta(), run: { ...goodMeta().run, sha: 'unavailable' } })],
    ['bad sha', JSON.stringify({ ...goodMeta(), run: { ...goodMeta().run, sha: 'abc' } })],
    ['no run id', JSON.stringify({ ...goodMeta(), run: { ...goodMeta().run, runId: undefined } })],
    ['no arch', JSON.stringify({ ...goodMeta(), runner: { ...goodMeta().runner, arch: 'unavailable' } })],
    ['no claude version', JSON.stringify({ ...goodMeta(), tools: { ...goodMeta().tools, claude: 'unavailable' } })]]) {
    const files = { ...base }; if (meta === undefined) delete files['meta.json']; else files['meta.json'] = meta
    const r = await run(files)
    assert.equal(r.code, 1, name); assert.equal(r.ended, 'not-admissible', name); assert.match(r.out, /\| metadata \| \*\*invalid\*\*/, name)
  }
  const r = await run({ ...base, 'meta.json': JSON.stringify({ ...goodMeta(), machine: { ...goodMeta().machine, diskFreeKiB: 'unavailable', cpuModel: 'unavailable' } }) })
  assert.equal(r.code, 0, 'an unavailable machine detail that is not identity is allowed')
})

test('status-only, wrong-host, swapped, inconsistent and unclean host results are rejected', async () => {
  const cases = {
    'status only': { 'claude.out': 'APPEND-RUN-JSON {"status":"valid"}\n', 'pi.out': 'APPEND-RUN-JSON {"status":"valid"}\n' },
    'swapped hosts': { 'claude.out': line(wrapper('pi')), 'pi.out': line(wrapper('claude')) },
    'record host differs': { 'claude.out': line(wrapper('claude', { record: goodRecord('pi') })) },
    'no record': { 'pi.out': line(wrapper('pi', { record: undefined })) },
    'invalid enclosed record': { 'pi.out': line(wrapper('pi', { record: { ...goodRecord('pi'), pairs: goodRecord('pi').pairs.slice(0, 2) } })) },
    'derived value inconsistent': { 'pi.out': line(wrapper('pi', { record: (() => { const r = goodRecord('pi'); r.pairs[0].appendP95 = 99; return r })() })) },
    'nonzero exit': { 'claude.out': line(wrapper('claude', { exitCode: 3 })) },
    'killed by signal': { 'claude.out': line(wrapper('claude', { signal: 'SIGTERM' })) },
    'cleanup not clean': { 'pi.out': line(wrapper('pi', { cleanup: 'killed' })) },
    'truncated': { 'pi.out': line(wrapper('pi', { truncated: { stdout: true, stderr: false } })) },
    'wrapper problems': { 'pi.out': line(wrapper('pi', { problems: ['x'] })) },
    'descendants killed': { 'pi.out': line(wrapper('pi', { descendantsKilled: true })) },
    'record valid false': { 'pi.out': line(wrapper('pi', { record: { ...goodRecord('pi'), valid: false } })) },
    'record complete false': { 'pi.out': line(wrapper('pi', { record: { ...goodRecord('pi'), complete: false } })) },
    'record flags missing': { 'pi.out': line(wrapper('pi', { record: (() => { const r = goodRecord('pi'); delete r.valid; delete r.complete; return r })() })) },
    'wrapper status timeout': { 'pi.out': line(wrapper('pi', { status: 'timeout' })) },
    'duplicate lines': { 'claude.out': line(wrapper('claude')) + line(wrapper('claude')) },
    'malformed json': { 'claude.out': 'APPEND-RUN-JSON {not json\n' },
    'not an object': { 'claude.out': 'APPEND-RUN-JSON [1]\n' },
    'missing file': { 'claude.out': undefined },
  }
  for (const [name, over] of Object.entries(cases)) {
    const files = { ...GOOD(), ...over }; for (const k of Object.keys(files)) if (files[k] === undefined) delete files[k]
    const r = await run(files)
    assert.equal(r.code, 1, name); assert.equal(r.ended, 'not-admissible', name)
  }
})

test('a large report goes through a pipe complete, with the sentinel and without silent cuts', async () => {
  const big = 'x'.repeat(150_000)
  const files = { ...GOOD(), 'claude.out': line(wrapper('claude', { filler: big })), 'pi.out': line(wrapper('pi', { filler: big })) }
  const r = await run(files)
  assert.ok(r.out.length > 300_000, 'captured ' + r.out.length)
  assert.equal(r.code, 0); assert.equal(r.ended, 'admissible')
  assert.ok(r.out.includes(big), 'the raw line is retained whole'); assert.ok(!/SHORTENED/.test(r.out.replace(/metadata \(.*complete/, '')))
})

test('an oversized record is flagged not admissible and shown as a shortened diagnostic, never as the complete record', async () => {
  const r = await run({ ...GOOD(), 'pi.out': line(wrapper('pi', { filler: 'y'.repeat(250_000) })) })
  assert.equal(r.code, 1); assert.equal(r.ended, 'not-admissible'); assert.match(r.out, /retention bound/); assert.match(r.out, /SHORTENED DIAGNOSTIC, not the complete record/)
  assert.ok(!r.out.includes('y'.repeat(250_000)))
})

test('a failed setup (nothing produced) is a complete not-admissible report', async () => {
  const r = await run({})
  assert.equal(r.code, 1); assert.equal(r.ended, 'not-admissible'); assert.match(r.out, /\| claude \| \*\*missing\*\*/); assert.match(r.out, /metadata missing/)
})

test('the report is appended to the job summary file by the script itself, complete, and an unwritable summary fails the run', async () => {
  const sum = join(mkdtempSync(join(tmpdir(), 'append-sumfile-')), 'summary.md')
  const r = await run(GOOD(), { GITHUB_STEP_SUMMARY: sum })
  assert.equal(r.code, 0); assert.equal(readFileSync(sum, 'utf8'), r.out)
  const bad = await run(GOOD(), { GITHUB_STEP_SUMMARY: join(tmpdir(), 'no-such-dir-xyz', 'summary.md') })
  assert.equal(bad.code, 1)
})

test('malformed pairs never crash the report: it still ends with the sentinel', async () => {
  for (const pairs of [[null], [1, 'x', null, []], 'nope', [], undefined]) {
    const r = await run({ ...GOOD(), 'pi.out': line(wrapper('pi', { record: { ...goodRecord('pi'), pairs } })) })
    assert.equal(r.code, 1, JSON.stringify(pairs)); assert.equal(r.ended, 'not-admissible', JSON.stringify(pairs))
  }
  const r = await run({ ...GOOD(), 'pi.out': line(wrapper('pi', { record: { ...goodRecord('pi'), pairs: [null, ...goodRecord('pi').pairs.slice(1)] } })) })
  assert.equal(r.ended, 'not-admissible')
})
