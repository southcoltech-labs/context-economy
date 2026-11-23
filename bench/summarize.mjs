#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Advisory CI reporting: `node bench/summarize.mjs <dir>` reads <dir>/claude.out, <dir>/pi.out and <dir>/meta.json (written by the job's steps),
// prints a Markdown report (for $GITHUB_STEP_SUMMARY) and exits 1 unless BOTH hosts produced a valid record. A missing file, a missing status
// line or any status other than `valid` is reported as such, never as a pass. Bounded: each raw record is cut at 100,000 characters.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2]
if (!dir) { console.log('usage: node bench/summarize.mjs <dir>'); process.exit(2) }
const read = (f) => { try { return readFileSync(join(dir, f), 'utf8') } catch { return undefined } }
const MARK = 'APPEND-RUN-JSON '
const parse = (text) => {
  if (text === undefined) return { status: 'missing', note: 'the step produced no output file' }
  const lines = text.split('\n').filter((l) => l.startsWith(MARK))
  if (lines.length !== 1) return { status: 'missing', note: `${lines.length} status lines in the output`, raw: text.slice(-2000) }
  try { return { ...JSON.parse(lines[0].slice(MARK.length)), raw: lines[0].slice(MARK.length) } } catch { return { status: 'missing', note: 'status line is not JSON', raw: lines[0].slice(0, 2000) } }
}
const f = (x) => (typeof x === 'number' ? x.toFixed(3) : 'n/a')
const out = []
let metaText = read('meta.json'), meta
try { meta = metaText ? JSON.parse(metaText) : undefined } catch { meta = undefined }
out.push('## Append measurement (advisory, not a gate, not the official benchmark)', '')
out.push(meta ? `Runner: ${meta.runner?.os}/${meta.runner?.arch} \`${meta.runner?.name}\` image ${meta.runner?.image} ${meta.runner?.imageVersion}; ${meta.machine?.cpuCount} CPUs (${meta.machine?.cpuModel}), load ${meta.machine?.loadavg?.join(' ')}; node ${meta.tools?.node}, bun ${meta.tools?.bun}, claude ${meta.tools?.claude}; sha \`${meta.run?.sha}\` attempt ${meta.run?.runAttempt}.` : 'Runner metadata: MISSING.', '')
let allValid = true
out.push('| host | status | elapsed ms | cleanup | problems |', '|---|---|---|---|---|')
const results = {}
for (const host of ['claude', 'pi']) {
  const r = (results[host] = parse(read(`${host}.out`)))
  if (r.status !== 'valid') allValid = false
  out.push(`| ${host} | **${r.status}** | ${r.elapsedMs ?? 'n/a'} | ${r.cleanup ?? 'n/a'} | ${[r.note, ...(r.problems ?? []), r.reason].filter(Boolean).join('; ') || ''} |`)
}
for (const host of ['claude', 'pi']) {
  const rec = results[host].record
  if (!rec?.pairs?.length) continue
  out.push('', `### ${host}: per pair (append p95 / median ms, warm full median ms, ratios p95/median and median/median, cold ms)`, '', '| pair | order | append p95 | append median | warm full median | ratio p95/med | ratio med/med | cold | state |', '|---|---|---|---|---|---|---|---|---|')
  for (const p of rec.pairs) out.push(`| ${p.pair} | ${p.order} | ${f(p.appendP95)} | ${f(p.appendMedian)} | ${f(p.warmFullMedian)} | ${f(p.ratioP95OverWarmMedian)} | ${f(p.ratioMedianOverWarmMedian)} | ${f(p.cold?.ms)} | ${p.appendDone && p.fullDone ? 'complete' : 'partial'} |`)
}
for (const host of ['claude', 'pi']) {
  const r = results[host]
  out.push('', `<details><summary>${host} raw status line</summary>`, '', '```json', (r.raw ?? r.note ?? '').slice(0, 100_000), '```', '', '</details>')
}
out.push('', allValid ? 'Both hosts produced a valid record.' : '**At least one host did not produce a valid record; this job is red on purpose. It does not affect the official suites.**')
console.log(out.join('\n'))
process.exit(allValid ? 0 : 1)
