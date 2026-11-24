// SPDX-License-Identifier: Apache-2.0
//
// Fixtures for the actual CLI (bench/run.mjs): startup refusal, preparation failure, interruption during preparation, missing executables.
// A copy of the bench folder runs in a temporary repo layout with stand-in `claude` and `bun` executables that record any launch.
// Run explicitly: `node --test bench/fixtures/cli.fixture.mjs`.
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

const benchDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// A throwaway repo layout: <root>/bench (copied), optionally <root>/plugins/context-bar, <root>/fakebin with launch-recording executables.
const layout = ({ plugin = 'small', fakeHosts = true } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'append-cli-'))
  cpSync(benchDir, join(root, 'bench'), { recursive: true, filter: (s) => !s.includes('fixtures') })
  const tmp = join(root, 'tmp'); mkdirSync(tmp)
  const fakebin = join(root, 'fakebin'); mkdirSync(fakebin)
  const marker = join(root, 'LAUNCHED')
  if (fakeHosts) for (const n of ['claude', 'bun']) { const p = join(fakebin, n); writeFileSync(p, `#!/bin/sh\necho ${n} >> ${marker}\nexec sleep 30\n`); chmodSync(p, 0o755) }
  if (plugin) {
    const dir = join(root, 'plugins/context-bar/hooks'); mkdirSync(dir, { recursive: true })
    const count = plugin === 'big' ? 20000 : 3
    for (let i = 0; i < count; i++) writeFileSync(join(dir, `f${i}.ts`), `export const x${i} = ${i}\n`)
  }
  const nodeDir = dirname(process.execPath)
  const env = { ...process.env, PATH: `${fakeHosts ? fakebin + ':' : ''}${nodeDir}:/usr/bin:/bin`, TMPDIR: tmp }
  return { root, tmp, marker, env, baseline: scratchNames() }
}
const runCli = (l, args, { signal, signalAfterMs = 250, whenScratch = false } = {}) => new Promise((resolve) => {
  const p = spawn(process.execPath, [join(l.root, 'bench/run.mjs'), ...args], { env: l.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = '', err = ''
  p.stdout.on('data', (c) => { out += c }); p.stderr.on('data', (c) => { err += c })
  if (signal && whenScratch) {
    // Signal as soon as the scratch folder exists, i.e. while synchronous preparation is running (handlers are installed before it starts).
    const poll = setInterval(() => { if (!noScratch(l)) { clearInterval(poll); p.kill(signal) } }, 2)
    p.on('close', () => clearInterval(poll))
  } else if (signal) setTimeout(() => p.kill(signal), signalAfterMs)
  p.on('close', (code) => {
    const lines = out.split('\n').filter((x) => x.startsWith('APPEND-RUN-JSON '))
    resolve({ code, out, err, lines: lines.length, report: lines[0] ? JSON.parse(lines[0].slice('APPEND-RUN-JSON '.length)) : undefined })
  })
})
// Scratch folders go to os.tmpdir(), which some environments pin regardless of TMPDIR, so compare against a per-layout baseline instead.
const scratchNames = () => new Set(readdirSync(tmpdir()).filter((n) => n.startsWith('append-measure-')))
const noScratch = (l) => [...scratchNames()].every((n) => l.baseline.has(n))

test('an invalid host is refused before anything is launched', async () => {
  const l = layout(); const r = await runCli(l, ['bogus']); await sleep(700)
  assert.equal(r.code, 1); assert.equal(r.lines, 1); assert.equal(r.report.status, 'startup-failure'); assert.match(r.report.reason, /usage/)
  assert.equal(existsSync(l.marker), false, 'no host was launched'); assert.ok(noScratch(l))
})

test('invalid deadlines are refused before anything is launched', async () => {
  for (const bad of ['5', '1e4', '-1', 'abc', '3600001']) {
    const l = layout(); const r = await runCli(l, ['pi', '--deadline-ms', bad]); await sleep(300)
    assert.equal(r.code, 1, bad); assert.equal(r.lines, 1, bad); assert.equal(r.report.status, 'startup-failure', bad)
    assert.equal(existsSync(l.marker), false, 'no host launched for ' + bad)
  }
  const l = layout(); const r = await runCli(l, ['pi', '--deadline-ms']); assert.equal(r.report.status, 'startup-failure')
})

test('a preparation failure reports once, launches nothing and leaves no scratch folder', async () => {
  const l = layout({ plugin: null }); const r = await runCli(l, ['claude']); await sleep(700)
  assert.equal(r.code, 1); assert.equal(r.lines, 1); assert.equal(r.report.status, 'startup-failure'); assert.equal(r.report.stage, 'prepare')
  assert.equal(existsSync(l.marker), false); assert.ok(noScratch(l), 'scratch removed')
})

test('SIGTERM during synchronous preparation launches nothing, reports interrupted and removes the scratch copy', async () => {
  const l = layout({ plugin: 'big' }); const r = await runCli(l, ['claude'], { signal: 'SIGTERM', whenScratch: true }); await sleep(700)
  assert.equal(r.report?.status, 'interrupted', r.out.slice(0, 300) + r.err.slice(0, 300)); assert.equal(r.report.launched, false); assert.equal(r.code, 1)
  assert.equal(r.lines, 1); assert.equal(existsSync(l.marker), false, 'no host launched'); assert.ok(noScratch(l), 'scratch removed')
})

test('a missing host executable is a complete startup failure with no unhandled error', async () => {
  for (const host of ['claude', 'pi']) {
    const l = layout({ fakeHosts: false }); const r = await runCli(l, [host])
    assert.equal(r.code, 1, host); assert.equal(r.lines, 1, host); assert.equal(r.report.status, 'startup-failure', host)
    assert.match(r.report.reason, /ENOENT/, host); assert.equal(r.report.stage, 'spawn')
    assert.ok(!/Unhandled|node:events|ERR_UNHANDLED/.test(r.err), 'no unhandled stack: ' + r.err.slice(0, 200)); assert.ok(noScratch(l), 'scratch removed')
  }
})
