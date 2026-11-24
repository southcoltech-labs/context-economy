// SPDX-License-Identifier: Apache-2.0
//
// Fixtures for the read-only harvest (bench/harvest.mjs). Run: `node --test bench/fixtures/*.fixture.mjs`.
// The CLI tests use a stand-in `gh` (BENCH_GH) that serves canned responses and records every call, so nothing touches GitHub.
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'
import { compact, lockDataset, merge, monthOf, replaceFile, parseAdvisory, parseOfficial, readDataset, toTsv, writeRows } from '../harvest.mjs'
import { gunzipSync, gzipSync } from 'node:zlib'
import { goodRecord } from './helpers.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, '..', 'harvest.mjs')
const real = readFileSync(join(here, 'real-report.log'), 'utf8')

// A log in the shape the workflow prints, built around chosen status lines.
const wrapper = (host, over = {}) => ({ host, deadlineMs: 240000, elapsedMs: 1000, status: 'valid', exitCode: 0, signal: null, cleanup: 'clean', truncated: { stdout: false, stderr: false }, descendantsKilled: false, problems: [], record: goodRecord(host), ...over })
const stamp = (text) => text.split('\n').map((l) => `2026-11-24T06:36:52.7860870Z ${l}`).join('\n')
const report = ({ claude = wrapper('claude'), pi = wrapper('pi'), verdict = 'admissible', meta = { run: { sha: 'a'.repeat(40) } }, note = 'complete' } = {}) => stamp([
  '## Append measurement', '', '### Retained raw evidence', '',
  `<details><summary>metadata (10 characters, ${note})</summary>`, '', '```json', JSON.stringify(meta), '', '```', '', '</details>', '',
  `<details><summary>claude status line (10 characters, ${note})</summary>`, '', '```json', JSON.stringify(claude), '```', '', '</details>', '',
  `<details><summary>pi status line (10 characters, ${note})</summary>`, '', '```json', JSON.stringify(pi), '```', '', '</details>', '',
  `END-OF-APPEND-REPORT verdict=${verdict}`, ''].join('\n'))

test('a real hosted report parses: verdict, metadata and both hosts valid, raw kept verbatim', () => {
  const a = parseAdvisory(real)
  assert.equal(a.report, true); assert.equal(a.verdict, 'admissible')
  assert.equal(a.claude.valid, true, a.claude.problems.join()); assert.equal(a.pi.valid, true, a.pi.problems.join())
  assert.equal(a.meta.run.event, 'pull_request'); assert.ok(a.metaRaw.startsWith('{"startedAt"'))
  assert.equal(JSON.parse(a.claude.raw).host, 'claude'); assert.equal(JSON.parse(a.pi.raw).record.pairs.length, 4)
})

test('timestamps, a byte-order mark and terminal escapes do not change the parse', () => {
  const a = parseAdvisory('﻿' + report().replace(/^(\S+Z )/gm, '$1\u001b[36;1m').replace(/\n/g, '\u001b[0m\n'))
  assert.equal(a.verdict, 'admissible'); assert.equal(a.claude.valid, true)
})

test('a log without the end sentinel, with a shortened diagnostic, or with bad host records is not a valid observation', () => {
  assert.equal(parseAdvisory(report().replace(/END-OF-APPEND-REPORT.*/, '')).report, false)
  const short = parseAdvisory(report({ note: 'SHORTENED DIAGNOSTIC, not the complete record' }))
  assert.equal(short.claude.valid, false); assert.equal(short.claude.rawComplete, false)
  const swapped = parseAdvisory(report({ claude: wrapper('pi') }))
  assert.equal(swapped.claude.valid, false); assert.equal(swapped.pi.valid, true)
  const notValid = parseAdvisory(report({ pi: wrapper('pi', { record: { ...goodRecord('pi'), valid: false } }) }))
  assert.equal(notValid.pi.valid, false); assert.match(notValid.pi.problems.join(), /record\.valid is not true/)
  const fewPairs = parseAdvisory(report({ pi: wrapper('pi', { record: { ...goodRecord('pi'), pairs: goodRecord('pi').pairs.slice(0, 2) } }) }))
  assert.equal(fewPairs.pi.valid, false); assert.match(fewPairs.pi.problems.join(), /record: pair count/)
  const inconsistent = parseAdvisory(report({ claude: wrapper('claude', { record: (() => { const r = goodRecord('claude'); r.pairs[0].appendP95 = 99; return r })() }) }))
  assert.equal(inconsistent.claude.valid, false); assert.match(inconsistent.claude.problems.join(), /derived appendP95/)
  const statusOnly = parseAdvisory(report({ claude: { status: 'valid' } }))
  assert.equal(statusOnly.claude.valid, false)
  const none = parseAdvisory('nothing useful here\n')
  assert.equal(none.report, false); assert.equal(none.claude.raw, null); assert.equal(none.meta, null)
})

test('the official benchmark line: one is parsed, none or several are reported as such', () => {
  const line = '2026-11-24T06:35:09.7603940Z append benchmark: round p95s 11.10, 14.01, 9.29 ms; collection unavailable'
  assert.deepEqual(parseOfficial('x\n' + line + '\n'), { found: 1, rounds: [11.1, 14.01, 9.29], collection: 'unavailable' })
  assert.equal(parseOfficial('x\n').found, 0); assert.equal(parseOfficial(line + '\n' + line + '\n').found, 2)
  assert.equal(parseOfficial(line + '\n' + line + '\n').rounds, null)
})

const row = (over = {}) => ({ key: '1/1/10', source: 'official', runId: 1, attempt: 1, jobId: 10, job: 'pi (macos-latest)', os: 'macos-latest', event: 'push', headSha: 'a'.repeat(40), conclusion: 'success', official: { found: 1, rounds: [1, 2, 3], collection: 'requested' }, ...over })

test('merge appends new keys, skips identical ones, and never replaces a different record', () => {
  const first = merge('', [row(), row({ key: '1/2/10', attempt: 2 })], 't1')
  assert.equal(first.added, 2); assert.equal(first.text.split('\n').filter(Boolean).length, 2)
  const again = merge(first.text, [row()], 't2')
  assert.equal(again.added, 0); assert.equal(again.skipped, 1); assert.equal(again.text, first.text) // harvestedAt differs, content does not
  const changed = merge(first.text, [row({ conclusion: 'failure' }), row({ key: '2/1/11', runId: 2, jobId: 11 })], 't3')
  assert.deepEqual(changed.conflicts, ['1/1/10']); assert.equal(changed.text, first.text) // nothing from a conflicted merge is written
})

test('the TSV has one row per pair for advisory jobs, one per official job, and a row for every missing observation', () => {
  const adv = { source: 'advisory', key: '1/1/20', runId: 1, attempt: 1, jobId: 20, job: 'append measurement (macos-latest)', os: 'macos-latest', event: 'push', headSha: 'b'.repeat(40), conclusion: 'success', advisory: parseAdvisory(real) }
  const missing = { ...adv, key: '1/1/21', jobId: 21, conclusion: 'cancelled', advisory: parseAdvisory('nothing\n') }
  const lost = { ...adv, key: '1/1/22', jobId: 22, conclusion: 'success', advisory: undefined, logError: 'HTTP 410' }
  const text = [adv, row(), missing, lost].map((o) => JSON.stringify(o)).join('\n') + '\n'
  const rows = toTsv(text).trim().split('\n').map((l) => l.split('\t'))
  const col = (n) => rows[0].indexOf(n)
  assert.equal(rows.length, 1 + 8 + 1 + 1 + 1) // header, 2 hosts x 4 pairs, official, missing, lost
  assert.equal(rows.filter((r) => r[col('source')] === 'advisory' && r[col('pair')] !== '').length, 8)
  assert.ok(rows.some((r) => r[col('conclusion')] === 'cancelled' && /no report/.test(r[col('note')])))
  assert.ok(rows.some((r) => /log unavailable/.test(r[col('note')])))
  assert.ok(rows.every((r) => r.length === rows[0].length))
})

// ---- CLI against a stand-in gh ----
const makeEnv = (responses) => {
  const dir = mkdtempSync(join(tmpdir(), 'append-harvest-'))
  writeFileSync(join(dir, 'responses.json'), JSON.stringify(responses))
  const stub = join(dir, 'gh')
  writeFileSync(stub, `#!/usr/bin/env node
const fs = require('node:fs')
const d = ${JSON.stringify(dir)}
fs.appendFileSync(d + '/calls.log', JSON.stringify(process.argv.slice(2)) + '\\n')
const path = process.argv.slice(2).filter((a) => !a.startsWith('--') && a !== 'api')[0]
const r = JSON.parse(fs.readFileSync(d + '/responses.json', 'utf8'))
const hit = Object.keys(r).filter((k) => path.startsWith(k)).sort((a, b) => b.length - a.length)[0]
if (!hit) { console.error('HTTP 404 ' + path); process.exit(1) }
if (r[hit] === null) { console.error('HTTP 410 gone'); process.exit(1) }
process.stdout.write(typeof r[hit] === 'string' ? r[hit] : JSON.stringify(r[hit]))
`)
  chmodSync(stub, 0o755)
  return { dir, stub }
}
const runCli = (args, stub, now = '2026-11-25T00:00:00.000Z') => new Promise((resolve) => {
  const p = spawn(process.execPath, [script, ...args], { env: { ...process.env, BENCH_GH: stub, BENCH_NOW: now }, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = '', err = ''
  p.stdout.on('data', (c) => { out += c }); p.stderr.on('data', (c) => { err += c })
  p.on('close', (code) => resolve({ code, out, err }))
})
const job = (id, name, over = {}) => ({ id, name, status: 'completed', conclusion: 'success', started_at: 's', completed_at: 'c', ...over })
const R = 'o/r'
const base = () => ({
  [`repos/${R}/actions/workflows/ci.yml/runs`]: { workflow_runs: [{ id: 100, run_attempt: 2, event: 'pull_request', head_sha: 'c'.repeat(40), created_at: '2026-11-24T00:00:00Z' }] },
  [`repos/${R}/actions/runs/100/attempts/1/jobs`]: { jobs: [job(1, 'append measurement (ubuntu-latest)'), job(2, 'plugins (macos-latest)', { conclusion: 'failure' }), job(3, 'repo checks'), job(4, 'pi (ubuntu-latest)', { status: 'in_progress', conclusion: null })] },
  [`repos/${R}/actions/runs/100/attempts/2/jobs`]: { jobs: [job(5, 'append measurement (ubuntu-latest)'), job(6, 'append measurement (macos-latest)', { conclusion: 'cancelled' })] },
  [`repos/${R}/actions/jobs/1/logs`]: report(),
  [`repos/${R}/actions/jobs/2/logs`]: stamp('x\nappend benchmark: round p95s 34.76, 46.26, 32.34 ms; collection unavailable\n'),
  [`repos/${R}/actions/jobs/5/logs`]: real,
  [`repos/${R}/actions/jobs/6/logs`]: null,
})

test('the CLI harvests every attempt, skips non-measurement and unfinished jobs, records a lost log, and is idempotent', async () => {
  const { dir, stub } = makeEnv(base())
  const out = join(dir, 'ds'), tsv = join(dir, 'data.tsv')
  const a = await runCli(['--repo', R, '--out-dir', out, '--tsv', tsv], stub)
  assert.equal(a.code, 0, a.err); assert.match(a.out, /harvested 4 job records: 4 added, 0 already present/)
  const rows = readDataset(out).split('\n').filter(Boolean).map((l) => JSON.parse(l))
  assert.deepEqual(rows.map((r) => r.key).sort(), ['100/1/1', '100/1/2', '100/2/5', '100/2/6'])
  assert.equal(rows.find((r) => r.jobId === 2).official.rounds[2], 32.34)
  assert.match(rows.find((r) => r.jobId === 6).logError, /410/); assert.equal(rows.find((r) => r.jobId === 6).conclusion, 'cancelled')
  assert.equal(rows.find((r) => r.jobId === 5).advisory.verdict, 'admissible')
  assert.ok(readFileSync(tsv, 'utf8').split('\n')[0].startsWith('source\trunId'))
  assert.deepEqual(readdirSync(out), ['append-2026-11.jsonl']) // all four runs were created in November
  const before = readDataset(out)
  const b = await runCli(['--repo', R, '--out-dir', out], stub)
  assert.equal(b.code, 0); assert.match(b.out, /0 added, 4 already present/); assert.equal(readDataset(out), before)
  // read-only: every call is a plain `gh api ... GET path`, with no method, field or body options
  for (const line of readFileSync(join(dir, 'calls.log'), 'utf8').split('\n').filter(Boolean)) {
    const args = JSON.parse(line)
    assert.equal(args[0], 'api'); assert.ok(!args.some((x) => /^(-X|--method|-f|-F|--field|--raw-field|--input)$/.test(x)), line)
  }
})

test('a record already stored with different content is a conflict: exit 1 and the file is unchanged', async () => {
  const { dir, stub } = makeEnv(base())
  const out = join(dir, 'ds')
  assert.equal((await runCli(['--repo', R, '--out-dir', out], stub)).code, 0)
  const resp = base(); resp[`repos/${R}/actions/runs/100/attempts/1/jobs`].jobs[0].conclusion = 'failure'
  writeFileSync(join(dir, 'responses.json'), JSON.stringify(resp))
  const before = readDataset(out)
  const r = await runCli(['--repo', R, '--out-dir', out], stub)
  assert.equal(r.code, 1); assert.match(r.err, /conflict.*100\/1\/1/); assert.equal(readDataset(out), before)
})

test('bad arguments and a failing listing exit nonzero without writing', async () => {
  const { dir, stub } = makeEnv({})
  const out = join(dir, 'ds')
  for (const args of [[], ['--repo', 'nope', '--out-dir', out], ['--repo', R], ['--repo', R, '--out-dir', out, '--limit', 'x'], ['--repo', R, '--out-dir', out, '--since', 'never'], ['--repo', R, '--out-dir', out, '--bogus', '1'], ['--repo', R, '--out-dir']]) {
    assert.equal((await runCli(args, stub)).code, 2, JSON.stringify(args))
  }
  const failed = await runCli(['--repo', R, '--out-dir', out], stub) // the stub answers 404 for the run listing
  assert.equal(failed.code, 1); assert.match(failed.err, /harvest failed/)
  assert.deepEqual(readdirSync(out), []) // no data files, and the lock was released
  writeFileSync(join(out, 'append-2026-10.jsonl'), '{"key":"k"}') // no trailing newline: refuse to use it
  assert.equal((await runCli(['--repo', R, '--out-dir', out], stub)).code, 1)
})

const rowAt = (key, created) => ({ key, runId: Number(key.split('/')[0]), runCreatedAt: created, source: 'official' })

test('a row goes to the file of the UTC month its run was created in', () => {
  assert.equal(monthOf({ runCreatedAt: '2026-12-31T23:59:59Z' }), '2026-12')
  assert.equal(monthOf({ runCreatedAt: '2027-01-01T00:00:00Z' }), '2027-01')
  assert.throws(() => monthOf({ runId: 5 }), /no usable creation date/)
})

test('closed months are gzipped and verified, the current month stays plain, and nothing is lost', () => {
  const dir = mkdtempSync(join(tmpdir(), 'append-rotate-'))
  writeRows(dir, [rowAt('1/1/1', '2026-10-30T10:00:00Z'), rowAt('2/1/2', '2026-11-02T10:00:00Z'), rowAt('3/1/3', '2026-11-24T10:00:00Z'), rowAt('4/1/4', '2026-12-01T10:00:00Z')])
  assert.deepEqual(readdirSync(dir).sort(), ['append-2026-10.jsonl', 'append-2026-11.jsonl', 'append-2026-12.jsonl'])
  const before = readDataset(dir)
  assert.equal(compact(dir, '2026-12-05T00:00:00Z'), 2) // October and November have ended
  assert.deepEqual(readdirSync(dir).sort(), ['append-2026-10.jsonl.gz', 'append-2026-11.jsonl.gz', 'append-2026-12.jsonl'])
  assert.equal(readDataset(dir), before)
  assert.equal(compact(dir, '2026-12-05T00:00:00Z'), 0)
})

test('a late row for an archived month becomes one more gzip member and reads back with the rest', () => {
  const dir = mkdtempSync(join(tmpdir(), 'append-late-'))
  writeRows(dir, [rowAt('1/1/1', '2026-10-30T10:00:00Z')])
  compact(dir, '2026-12-01T00:00:00Z')
  writeRows(dir, [rowAt('9/1/9', '2026-10-31T10:00:00Z')])
  assert.deepEqual(readdirSync(dir), ['append-2026-10.jsonl.gz'])
  assert.deepEqual(readDataset(dir).split('\n').filter(Boolean).map((l) => JSON.parse(l).key), ['1/1/1', '9/1/9'])
  assert.equal(gunzipSync(readFileSync(join(dir, 'append-2026-10.jsonl.gz'))).toString().split('\n').filter(Boolean).length, 2)
})

test('a plain file left beside its archive (an interrupted compaction) is merged into the archive, not duplicated away', () => {
  const dir = mkdtempSync(join(tmpdir(), 'append-crash-'))
  writeFileSync(join(dir, 'append-2026-10.jsonl.gz'), gzipSync(JSON.stringify(rowAt('1/1/1', '2026-10-01T00:00:00Z')) + '\n'))
  writeFileSync(join(dir, 'append-2026-10.jsonl'), JSON.stringify(rowAt('2/1/2', '2026-10-02T00:00:00Z')) + '\n')
  assert.equal(compact(dir, '2026-11-15T00:00:00Z'), 1)
  assert.deepEqual(readdirSync(dir), ['append-2026-10.jsonl.gz'])
  assert.equal(readDataset(dir).split('\n').filter(Boolean).length, 2)
})

test('an end-to-end harvest of an earlier month is archived in the same run, and a rerun adds nothing', async () => {
  const { dir, stub } = makeEnv(base())
  const out = join(dir, 'ds')
  const a = await runCli(['--repo', R, '--out-dir', out], stub, '2026-12-03T00:00:00.000Z')
  assert.equal(a.code, 0, a.err); assert.match(a.out, /4 added, 0 already present, 1 month file\(s\) archived/)
  assert.deepEqual(readdirSync(out), ['append-2026-11.jsonl.gz'])
  const b = await runCli(['--repo', R, '--out-dir', out], stub, '2026-12-04T00:00:00.000Z')
  assert.match(b.out, /0 added, 4 already present, 0 month file/)
})

test('two different records for one key already in the dataset stop the harvest', async () => {
  const { dir, stub } = makeEnv(base())
  const out = join(dir, 'ds'); mkdirSync(out)
  const k = (c) => JSON.stringify({ ...rowAt('100/1/1', '2026-11-24T00:00:00Z'), conclusion: c }) + '\n'
  writeFileSync(join(out, 'append-2026-11.jsonl'), k('success') + k('failure'))
  const r = await runCli(['--repo', R, '--out-dir', out], stub)
  assert.equal(r.code, 1); assert.match(r.err, /two different records for 100\/1\/1/)
})

// ---- review 207 ----
test('every wrapper field the CI summary checks is checked here too', () => {
  const bad = {
    exitCode: 1, signal: 'SIGKILL', cleanup: 'unconfirmed', status: 'timeout',
    truncated: { stdout: true, stderr: false }, descendantsKilled: true, problems: ['x'],
  }
  for (const [field, value] of Object.entries(bad)) {
    const h = parseAdvisory(report({ claude: wrapper('claude', { [field]: value }) })).claude
    assert.equal(h.valid, false, field)
  }
  assert.equal(parseAdvisory(report({ claude: wrapper('claude', { truncated: undefined }) })).claude.valid, false) // truncation not ruled out
  assert.equal(parseAdvisory(report({ claude: wrapper('claude', { problems: undefined }) })).claude.valid, false)
  assert.equal(parseAdvisory(report()).claude.valid, true)
})

test('timestamp-only lines (blank report lines) are cleaned without trailing spaces', () => {
  const blank = report().split('\n').map((l) => l.replace(/Z $/, 'Z')).join('\n')
  assert.equal(parseAdvisory(blank).claude.valid, true)
  assert.equal(parseAdvisory(blank).verdict, 'admissible')
})

test('duplicate keys inside one incoming batch: identical are skipped, different are a conflict', () => {
  const a = row({ key: '5/1/5' })
  const same2 = merge('', [a, { ...a }], 't')
  assert.equal(same2.added, 1); assert.equal(same2.skipped, 1); assert.equal(same2.text.split('\n').filter(Boolean).length, 1)
  const diff = merge('', [a, { ...a, conclusion: 'failure' }], 't')
  assert.deepEqual(diff.conflicts, ['5/1/5']); assert.equal(diff.text, ''); assert.deepEqual(diff.newRows, [])
})

test('the state after installing the archive but before removing the plain file reads once and recovers without duplicates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'append-renamed-'))
  const r1 = { ...row({ key: '1/1/1', runId: 1 }), runCreatedAt: '2026-10-01T00:00:00Z', harvestedAt: 'a' }, r2 = { ...row({ key: '2/1/2', runId: 2, jobId: 2 }), runCreatedAt: '2026-10-02T00:00:00Z', harvestedAt: 'a' }
  const text = JSON.stringify(r1) + '\n' + JSON.stringify(r2) + '\n'
  writeFileSync(join(dir, 'append-2026-10.jsonl.gz'), gzipSync(text)) // the archive already holds both rows ...
  writeFileSync(join(dir, 'append-2026-10.jsonl'), text) // ... and the plain file still does
  assert.equal(readDataset(dir).split('\n').filter(Boolean).length, 2) // one logical row per key, before any recovery
  assert.equal(toTsv(readDataset(dir)).trim().split('\n').length, 3) // header + 2 rows
  assert.equal(compact(dir, '2026-11-15T00:00:00Z'), 1)
  assert.deepEqual(readdirSync(dir), ['append-2026-10.jsonl.gz'])
  assert.equal(gunzipSync(readFileSync(join(dir, 'append-2026-10.jsonl.gz'))).toString(), text) // nothing appended a second time
})

test('a plain file and its archive that disagree about a key stop compaction and keep both files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'append-disagree-'))
  const k = (c) => JSON.stringify({ ...rowAt('1/1/1', '2026-10-01T00:00:00Z'), conclusion: c }) + '\n'
  writeFileSync(join(dir, 'append-2026-10.jsonl.gz'), gzipSync(k('success')))
  writeFileSync(join(dir, 'append-2026-10.jsonl'), k('failure'))
  assert.throws(() => compact(dir, '2026-11-15T00:00:00Z'), /different records for 1\/1\/1/)
  assert.deepEqual(readdirSync(dir).sort(), ['append-2026-10.jsonl', 'append-2026-10.jsonl.gz'])
})

test('a stop while replacing an archive leaves the old one readable, and the late row can be retried', () => {
  const dir = mkdtempSync(join(tmpdir(), 'append-atomic-'))
  writeRows(dir, [rowAt('1/1/1', '2026-10-30T10:00:00Z')]); compact(dir, '2026-12-01T00:00:00Z')
  const gz = join(dir, 'append-2026-10.jsonl.gz'), old = readFileSync(gz)
  mkdirSync(gz + '.tmp') // the temporary file cannot be replaced: the write fails before the archive is touched
  assert.throws(() => writeRows(dir, [rowAt('9/1/9', '2026-10-31T10:00:00Z')]))
  assert.deepEqual(readFileSync(gz), old); assert.equal(readDataset(dir).split('\n').filter(Boolean).length, 1)
  rmSync(gz + '.tmp', { recursive: true })
  writeFileSync(gz + '.tmp', 'half a gzip member') // a leftover partial file from an earlier stop is simply replaced
  writeRows(dir, [rowAt('9/1/9', '2026-10-31T10:00:00Z')])
  assert.deepEqual(readDataset(dir).split('\n').filter(Boolean).map((l) => JSON.parse(l).key), ['1/1/1', '9/1/9'])
  assert.equal(existsSync(gz + '.tmp'), false)
})

test('an archive that does not read back as expected is not installed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'append-verify-'))
  const f = join(dir, 'x.gz'); writeFileSync(f, 'old')
  assert.throws(() => replaceFile(f, Buffer.from('new'), () => false), /did not read back/)
  assert.equal(readFileSync(f, 'utf8'), 'old'); assert.equal(existsSync(f + '.tmp'), false)
})

const manyJobs = (n, from) => Array.from({ length: n }, (_, i) => job(from + i, 'repo checks'))
test('more than 100 jobs in an attempt are all read; a count that does not add up fails closed', async () => {
  const resp = base()
  const j = `repos/${R}/actions/runs/100/attempts/1/jobs`
  resp[j] = { total_count: 150, jobs: manyJobs(100, 1000) }
  resp[j + '?per_page=100&page=2'] = { total_count: 150, jobs: [job(1, 'append measurement (ubuntu-latest)'), job(2, 'plugins (macos-latest)', { conclusion: 'failure' }), ...manyJobs(48, 2000)] }
  const { dir, stub } = makeEnv(resp)
  const out = join(dir, 'ds')
  const ok = await runCli(['--repo', R, '--out-dir', out], stub)
  assert.equal(ok.code, 0, ok.err); assert.match(ok.out, /4 added/) // jobs 1 and 2 sit on page 2
  const lying = makeEnv({ ...resp, [j]: { total_count: 151, jobs: manyJobs(100, 1000) }, [j + '?per_page=100&page=2']: { ...resp[j + '?per_page=100&page=2'], total_count: 151 } })
  const out2 = join(lying.dir, 'ds')
  const bad = await runCli(['--repo', R, '--out-dir', out2], lying.stub)
  assert.equal(bad.code, 1); assert.match(bad.err, /refusing a partial harvest/); assert.deepEqual(readdirSync(out2), [])
  const moving = makeEnv({ ...resp, [j]: { total_count: 151, jobs: manyJobs(100, 1000) } }) // page 1 says 151, page 2 says 150
  const bad2 = await runCli(['--repo', R, '--out-dir', join(moving.dir, 'ds')], moving.stub)
  assert.equal(bad2.code, 1); assert.match(bad2.err, /total changed from 151 to 150/)
})

test('more than 100 runs are read when the limit asks for them', async () => {
  const resp = base()
  const runs = `repos/${R}/actions/workflows/ci.yml/runs`
  const mk = (id) => ({ id, run_attempt: 1, event: 'push', head_sha: 'd'.repeat(40), created_at: '2026-11-24T00:00:00Z' })
  resp[runs] = { workflow_runs: Array.from({ length: 100 }, (_, i) => mk(200 + i)) }
  resp[runs + '?per_page=100&page=2'] = { workflow_runs: [mk(100)] }
  resp[`repos/${R}/actions/runs/`] = { jobs: [] } // every filler run has no jobs
  const { dir, stub } = makeEnv(resp)
  const out = join(dir, 'ds')
  const r = await runCli(['--repo', R, '--out-dir', out, '--limit', '101'], stub)
  assert.equal(r.code, 0, r.err); assert.match(r.out, /harvested 2 job records/) // run 100 attempt 1 is on page 2: its jobs 1 and 2
  assert.ok(readDataset(out).includes('"runId":100'))
})

test('a held lock stops a second harvest before it reads or writes; the lock is released after success and after failure', async () => {
  const { dir, stub } = makeEnv(base())
  const out = join(dir, 'ds')
  const release = lockDataset(out)
  assert.throws(() => lockDataset(out), /another harvest is running/)
  const blocked = await runCli(['--repo', R, '--out-dir', out], stub)
  assert.equal(blocked.code, 1); assert.match(blocked.err, /another harvest is running/)
  assert.deepEqual(readdirSync(out), ['.harvest.lock'])
  release()
  assert.equal((await runCli(['--repo', R, '--out-dir', out], stub)).code, 0); assert.ok(!readdirSync(out).includes('.harvest.lock'))
  const resp = base(); resp[`repos/${R}/actions/runs/100/attempts/1/jobs`].jobs[0].conclusion = 'failure'
  writeFileSync(join(dir, 'responses.json'), JSON.stringify(resp))
  assert.equal((await runCli(['--repo', R, '--out-dir', out], stub)).code, 1) // a conflict
  assert.ok(!readdirSync(out).includes('.harvest.lock'))
})

test('two harvests started together never store a key twice', async () => {
  const { dir, stub } = makeEnv(base())
  const out = join(dir, 'ds')
  const [a, b] = await Promise.all([runCli(['--repo', R, '--out-dir', out], stub), runCli(['--repo', R, '--out-dir', out], stub)])
  for (const x of [a, b]) assert.ok(x.code === 0 || /another harvest is running/.test(x.err), x.err)
  assert.ok(a.code === 0 || b.code === 0)
  const keys = readDataset(out).split('\n').filter(Boolean).map((l) => JSON.parse(l).key)
  assert.equal(keys.length, 4); assert.equal(new Set(keys).size, 4)
  const raw = readdirSync(out).filter((n) => n.endsWith('.jsonl')).map((n) => readFileSync(join(out, n), 'utf8').split('\n').filter(Boolean).length)
  assert.equal(raw.reduce((x, y) => x + y, 0), 4) // also on disk, not only after the reader's de-duplication
})
