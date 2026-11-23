// SPDX-License-Identifier: Apache-2.0
//
// Failure fixtures for the bounded runner, with real stand-in child processes. Run explicitly: `node --test bench/fixtures/run.test.mjs`.
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseDeadline, validateRecord } from '../run-lib.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const driver = join(here, 'driver.mjs')
const dir = mkdtempSync(join(tmpdir(), 'append-fixture-'))
const child = (name, src) => { const p = join(dir, name); writeFileSync(p, src); return p }
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const groupAlive = (pid) => { try { process.kill(-pid, 0); return true } catch { return false } }

const sorted = (xs) => [...xs].sort((a, b) => a - b)
const median = (xs) => { const s = sorted(xs); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const p95 = (xs) => sorted(xs)[Math.ceil(xs.length * 0.95) - 1]
export const goodRecord = (host = 'pi') => ({
  schema: 1, host, kind: 'append-measurement', valid: true, complete: true, stage: 'done', invalidReasons: [], warnings: [],
  config: { base: 5000, appends: 40, warmWalks: 5, orders: ['append-first', 'full-first', 'full-first', 'append-first'] },
  pairs: ['append-first', 'full-first', 'full-first', 'append-first'].map((order, pair) => {
    const appendMs = Array.from({ length: 40 }, (_, i) => 1 + i / 100), warmFullMs = [300, 301, 302, 303, 304]
    return {
      pair, order, equal: true, appendDone: true, fullDone: true, stateSizes: { appendStart: 5000, appendEnd: 5040, fullWalk: 5040 }, appendMs, warmFullMs,
      appendP95: p95(appendMs), appendMedian: median(appendMs), warmFullMedian: median(warmFullMs),
      ratioP95OverWarmMedian: p95(appendMs) / median(warmFullMs), ratioMedianOverWarmMedian: median(appendMs) / median(warmFullMs),
      cold: { ms: 400, messages: 5040, shapeMatchesWarm: true },
    }
  }),
  elapsedMs: 1000,
})
const printRecord = (r) => `console.log('APPEND-MEASURE-JSON ' + JSON.stringify(${JSON.stringify(r)}))`

// Runs the driver with stdout captured through a pipe (not a terminal). Optionally signals it after `signalAfterMs`.
const drive = (env, { signal, signalAfterMs = 600 } = {}) => new Promise((resolve) => {
  const d = spawn(process.execPath, [driver], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  d.stdout.on('data', (c) => { out += c })
  if (signal) setTimeout(() => d.kill(signal), signalAfterMs)
  d.on('close', (code, sig) => {
    const line = out.split('\n').find((l) => l.startsWith('APPEND-RUN-JSON '))
    resolve({ code, sig, out, report: line ? JSON.parse(line.slice('APPEND-RUN-JSON '.length)) : undefined })
  })
})

test('a valid synthetic record is accepted and the validator is strict', () => {
  assert.deepEqual(validateRecord(goodRecord(), 'pi'), [])
  assert.ok(validateRecord(goodRecord('claude'), 'pi').includes('host'))
  const r = goodRecord(); r.pairs[2].appendMs.pop(); assert.ok(validateRecord(r, 'pi').includes('pair 2 append samples'))
  const n = goodRecord(); n.pairs[0].warmFullMs[1] = -1; assert.ok(validateRecord(n, 'pi').includes('pair 0 warm samples'))
  const x = goodRecord(); x.pairs[1].appendP95 = 99; assert.ok(validateRecord(x, 'pi').includes('pair 1 derived appendP95'))
  const c = goodRecord(); c.pairs[3].cold = { error: 'boom' }; assert.ok(validateRecord(c, 'pi').includes('pair 3 cold sample'))
  const s = goodRecord(); s.schema = 2; assert.ok(validateRecord(s, 'pi').includes('schema'))
  assert.deepEqual([parseDeadline(undefined), parseDeadline('1000'), parseDeadline('999'), parseDeadline('1e4'), parseDeadline('-5'), parseDeadline('abc'), parseDeadline('3600001'), parseDeadline('')], [240000, 1000, undefined, undefined, undefined, undefined, undefined, undefined])
})

test('a valid record through the real wiring exits 0 with a complete report', async () => {
  const r = await drive({ DRV_CHILD: child('ok.mjs', printRecord(goodRecord())) })
  assert.equal(r.code, 0); assert.equal(r.report.status, 'valid'); assert.equal(r.report.cleanup, 'clean')
})

test('a 100 KB report is flushed completely through a pipe', async () => {
  const big = { schema: 1, filler: 'x'.repeat(100_000) }
  const r = await drive({ DRV_CHILD: child('big.mjs', printRecord(big)) })
  assert.ok(r.out.length > 100_000, 'output length ' + r.out.length)
  assert.ok(r.report, 'report line parses as JSON'); assert.equal(r.report.status, 'invalid'); assert.equal(r.code, 1)
  assert.equal(r.report.record.filler.length, 100_000)
})

test('SIGTERM to the runner reports interrupted and leaves no child', async () => {
  const pidFile = join(dir, 'pid-term')
  const src = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`
  const r = await drive({ DRV_CHILD: child('hang.cjs', src), DRV_DEADLINE: '60000' }, { signal: 'SIGTERM' })
  assert.equal(r.report?.status, 'interrupted'); assert.equal(r.report.interruptedBy, 'SIGTERM'); assert.equal(r.code, 1)
  const pid = Number(readFileSync(pidFile, 'utf8')); assert.equal(alive(pid), false); assert.equal(groupAlive(pid), false)
})

test('SIGINT and SIGHUP are handled the same way', async () => {
  for (const sig of ['SIGINT', 'SIGHUP']) {
    const r = await drive({ DRV_CHILD: child('hang2.cjs', 'setInterval(() => {}, 1000)'), DRV_DEADLINE: '60000' }, { signal: sig })
    assert.equal(r.report?.status, 'interrupted', sig); assert.equal(r.report.interruptedBy, sig)
  }
})

test('a child that ignores SIGTERM is killed with SIGKILL and cleanup is confirmed', async () => {
  const pidFile = join(dir, 'pid-stubborn')
  const src = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)`
  const r = await drive({ DRV_CHILD: child('stubborn.cjs', src), DRV_DEADLINE: '1000' })
  assert.equal(r.report.status, 'timeout'); assert.equal(r.report.cleanup, 'killed')
  assert.equal(groupAlive(Number(readFileSync(pidFile, 'utf8'))), false)
})

test('a descendant holding the pipes after the host exits is killed and the run is not valid', async () => {
  const pidFile = join(dir, 'pid-desc')
  const src = `const { spawn } = require('child_process')
const d = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit'] })
d.unref()
require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(d.pid))
${printRecord(goodRecord())}`
  const r = await drive({ DRV_CHILD: child('desc.cjs', src) })
  assert.equal(r.report.status, 'invalid'); assert.equal(r.report.descendantsKilled, true); assert.equal(r.code, 1)
  const pid = Number(readFileSync(pidFile, 'utf8')); assert.equal(alive(pid), false)
})

test('timeout with a partial record is never valid and keeps the partial record out of the pass path', async () => {
  const partial = goodRecord(); partial.valid = false; partial.complete = false; partial.pairs.length = 1
  const r = await drive({ DRV_CHILD: child('partial.cjs', printRecord(partial) + '; setInterval(() => {}, 1000)'), DRV_DEADLINE: '1000' })
  assert.equal(r.report.status, 'timeout'); assert.equal(r.code, 1); assert.ok(r.report.problems.length > 0)
})

test('startup failure, no record, duplicate records and a wrong host are all invalid', async () => {
  let r = await drive({ DRV_CMD: join(dir, 'no-such-binary'), DRV_CHILD: '' })
  assert.equal(r.report.status, 'startup-failure'); assert.equal(r.code, 1)
  r = await drive({ DRV_CHILD: child('none.cjs', 'console.log("hello")') })
  assert.equal(r.report.status, 'no-record')
  r = await drive({ DRV_CHILD: child('dup.cjs', printRecord(goodRecord()) + ';' + printRecord(goodRecord())) })
  assert.equal(r.report.status, 'invalid'); assert.ok(r.report.problems[0].includes('duplicate'))
  r = await drive({ DRV_CHILD: child('host.cjs', printRecord(goodRecord('claude'))) })
  assert.equal(r.report.status, 'invalid'); assert.ok(r.report.problems.includes('host'))
  r = await drive({ DRV_CHILD: child('exit.cjs', printRecord(goodRecord()) + '; process.exitCode = 3') })
  assert.equal(r.report.status, 'invalid'); assert.equal(r.report.exitCode, 3)
})

test('retained output is capped exactly, flagged, and UTF-8 is not split', async () => {
  const src = `const s = 'é'.repeat(60000); process.stdout.write(s + '\\n')`
  const r = await drive({ DRV_CHILD: child('utf.cjs', src), DRV_MAXKEEP: '50001' })
  assert.equal(r.report.truncated.stdout, true); assert.equal(r.report.status, 'no-record')
  assert.ok(!r.report.tail.includes('�') || r.report.tail.endsWith('�'), 'only the cap boundary may hold a replacement character')
  const r2 = await drive({ DRV_CHILD: child('utf2.cjs', `process.stdout.write('é'.repeat(30000))`), DRV_MAXKEEP: '200000' })
  assert.equal(r2.report.truncated.stdout, false); assert.ok(!r2.report.tail.includes('�'))
})
