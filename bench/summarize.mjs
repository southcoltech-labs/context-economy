#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Advisory CI reporting: `node bench/summarize.mjs <dir>` reads <dir>/claude.out, <dir>/pi.out and <dir>/meta.json (written by the job's steps),
// prints a Markdown report (for $GITHUB_STEP_SUMMARY and the job log) and exits 1 unless the observation is admissible: BOTH hosts produced a
// record that passes the wrapper contract and validateRecord() for that host, AND the runner metadata carries the identity needed to use the
// numbers. Anything missing, malformed, wrong-host, truncated or too large to retain is reported as such, never as a pass.
// The report is written in full and flushed before exit, and always ends with a sentinel line `END-OF-APPEND-REPORT verdict=<admissible|not-admissible>`.
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateRecord } from './run-lib.mjs'

const MAX_RAW = 200_000 // a raw status line or metadata longer than this cannot be retained whole in the summary: not admissible
const dir = process.argv[2]
const finish = (text, code) => process.stdout.write(text + '\n', () => process.exit(code))
if (!dir) finish('usage: node bench/summarize.mjs <dir>\nEND-OF-APPEND-REPORT verdict=not-admissible', 2)

const read = (f) => { try { return readFileSync(join(dir, f), 'utf8') } catch { return undefined } }
const MARK = 'APPEND-RUN-JSON '
const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x)

// One host: returns { status, problems[], raw, record }. `admissible` only if every check passes.
function host(name) {
  const text = read(`${name}.out`)
  if (text === undefined) return { name, status: 'missing', problems: ['the step produced no output file'], admissible: false }
  const lines = text.split('\n').filter((l) => l.startsWith(MARK))
  if (lines.length !== 1) return { name, status: 'missing', problems: [`${lines.length} status lines in the output`], raw: text.slice(-2000), rawComplete: text.length <= 2000, admissible: false }
  const raw = lines[0].slice(MARK.length)
  let w
  try { w = JSON.parse(raw) } catch { return { name, status: 'missing', problems: ['status line is not JSON'], raw: raw.slice(0, 2000), rawComplete: raw.length <= 2000, admissible: false } }
  const problems = []
  if (!isObj(w)) return { name, status: 'missing', problems: ['status line is not an object'], raw: raw.slice(0, 2000), rawComplete: raw.length <= 2000, admissible: false }
  if (raw.length > MAX_RAW) problems.push(`raw status line is ${raw.length} characters, over the ${MAX_RAW} retention bound`)
  if (w.host !== name) problems.push(`wrapper host is ${JSON.stringify(w.host)}, expected ${name}`)
  if (w.status !== 'valid') problems.push(`wrapper status is ${JSON.stringify(w.status)}`)
  if (w.exitCode !== 0) problems.push(`exitCode ${JSON.stringify(w.exitCode)}`)
  if (w.signal !== null) problems.push(`signal ${JSON.stringify(w.signal)}`)
  if (w.cleanup !== 'clean') problems.push(`cleanup ${JSON.stringify(w.cleanup)}`)
  if (!isObj(w.truncated) || w.truncated.stdout !== false || w.truncated.stderr !== false) problems.push('output truncation not ruled out')
  if (w.descendantsKilled) problems.push('descendants outlived the host')
  if (!Array.isArray(w.problems) || w.problems.length) problems.push('wrapper reported problems')
  if (!isObj(w.record)) problems.push('no record')
  else for (const p of validateRecord(w.record, name)) problems.push(`record: ${p}`)
  return { name, status: typeof w.status === 'string' ? w.status : 'unknown', problems, raw: raw.length > MAX_RAW ? raw.slice(0, 2000) : raw, rawLength: raw.length, rawComplete: raw.length <= MAX_RAW, record: isObj(w.record) ? w.record : undefined, elapsedMs: w.elapsedMs, cleanup: w.cleanup, admissible: problems.length === 0 }
}

// Required metadata: the identity needed to use the numbers. A probe that failed on the machine details is allowed; the identity is not.
const isStr = (x) => typeof x === 'string' && x.length > 0 && x !== 'unavailable'
function metaProblems(m) {
  if (!isObj(m)) return ['metadata missing or not an object']
  const bad = []
  const need = (path, ok = isStr) => { const v = path.split('.').reduce((a, k) => (isObj(a) ? a[k] : undefined), m); if (!ok(v)) bad.push(`metadata ${path} missing or unavailable`) }
  for (const k of ['run.sha', 'run.runId', 'run.runAttempt', 'run.event', 'run.job', 'run.repository', 'runner.os', 'runner.arch', 'tools.node', 'tools.bun', 'tools.claude', 'startedAt']) need(k)
  need('machine.cpuCount', (v) => Number.isInteger(v) && v > 0)
  if (isStr(m.run?.sha) && !/^[0-9a-f]{40}$/.test(m.run.sha)) bad.push('metadata run.sha is not a 40-hex commit')
  return bad
}

let metaRaw = read('meta.json'), meta
try { meta = metaRaw === undefined ? undefined : JSON.parse(metaRaw) } catch { meta = undefined }
const mProblems = metaProblems(meta)
if (metaRaw !== undefined && metaRaw.length > MAX_RAW) mProblems.push(`metadata is ${metaRaw.length} characters, over the ${MAX_RAW} retention bound`)
const hosts = ['claude', 'pi'].map(host)
const admissible = mProblems.length === 0 && hosts.every((h) => h.admissible)
const f = (x) => (typeof x === 'number' ? x.toFixed(3) : 'n/a')

const out = ['## Append measurement (advisory, not a gate, not the official benchmark)', '']
out.push(admissible ? '**Observation admissible**: both hosts valid and runner identity present.' : '**Observation NOT admissible.** This job is red on purpose; it does not affect the official suites.', '')
out.push('| part | status | elapsed ms | cleanup | problems |', '|---|---|---|---|---|')
out.push(`| metadata | ${mProblems.length ? '**invalid**' : 'ok'} | | | ${mProblems.join('; ')} |`)
for (const h of hosts) out.push(`| ${h.name} | **${h.status}**${h.admissible ? '' : ' (not admissible)'} | ${h.elapsedMs ?? 'n/a'} | ${h.cleanup ?? 'n/a'} | ${h.problems.join('; ')} |`)
for (const h of hosts) {
  if (!h.record?.pairs?.length) continue
  out.push('', `### ${h.name}: per pair (ms; ratios are exploratory)`, '', '| pair | order | append p95 | append median | warm full median | ratio p95/med | ratio med/med | cold | state |', '|---|---|---|---|---|---|---|---|---|')
  for (const p of h.record.pairs) out.push(`| ${p.pair} | ${p.order} | ${f(p.appendP95)} | ${f(p.appendMedian)} | ${f(p.warmFullMedian)} | ${f(p.ratioP95OverWarmMedian)} | ${f(p.ratioMedianOverWarmMedian)} | ${f(p.cold?.ms)} | ${p.appendDone && p.fullDone ? 'complete' : 'partial'} |`)
}
// Raw evidence, whole. A shortened diagnostic is labelled as such and is never presented as the complete record.
out.push('', '### Retained raw evidence', '')
out.push(`<details><summary>metadata (${metaRaw === undefined ? 'missing' : metaRaw.length + (metaRaw.length > MAX_RAW ? ' characters, SHORTENED DIAGNOSTIC' : ' characters, complete')})</summary>`, '', '```json', (metaRaw ?? '').slice(0, MAX_RAW), '```', '', '</details>')
for (const h of hosts) {
  out.push('', `<details><summary>${h.name} status line (${h.raw === undefined ? 'none' : (h.rawLength ?? h.raw.length) + ' characters, ' + (h.rawComplete ? 'complete' : 'SHORTENED DIAGNOSTIC, not the complete record')})</summary>`, '', '```json', h.raw ?? '', '```', '', '</details>')
}
out.push('', `END-OF-APPEND-REPORT verdict=${admissible ? 'admissible' : 'not-admissible'}`)
const report = out.join('\n')
// Appended here, not piped through `tee`: a pipe would report tee's exit status and hide this one (GitHub's default shell has no pipefail).
let code = admissible ? 0 : 1
if (process.env.GITHUB_STEP_SUMMARY) {
  try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + '\n') } catch (e) { console.error('could not write the job summary: ' + e.message); code = 1 }
}
finish(report, code)
