#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Read-only harvest of append-measurement evidence from GitHub Actions logs into a durable, append-only dataset.
//
//   node bench/harvest.mjs --repo OWNER/REPO --out-dir DIR [--tsv data.tsv] [--since 2026-11-24T00:00:00Z] [--limit 50] [--workflow ci.yml]
//
// Workflow logs expire (GitHub's default is 90 days; this repository's setting is not verified), so harvest promptly. Nothing here writes to
// GitHub: it only calls `gh api` for GET endpoints (list runs, list jobs for each attempt, download job logs).
// For every completed run attempt it records:
//   - each `append measurement (<os>)` job: the metadata and both host status lines kept verbatim as raw text, re-validated with the same
//     validateRecord() the runner uses, plus the report verdict; a job with no usable report is recorded too (with its conclusion), because
//     a missing or cancelled observation is part of the cohort;
//   - each `plugins (<os>)` and `pi (<os>)` job: the three round p95s printed by the official benchmark test, if the log has them.
// The dataset is a directory of monthly JSONL files `append-YYYY-MM.jsonl`, one object per job per attempt, keyed by run id + attempt + job id.
// A row goes to the file of the (UTC) month its run was created in, so a rerun lands beside the original. A key already present anywhere in the
// directory is never replaced: identical content is skipped, different content is a conflict and the run fails without writing. A file for a
// month that has ended is gzipped to `append-YYYY-MM.jsonl.gz` (checked by decompressing before the plain file is removed); a late row for an
// archived month is added as one more gzip member, which gunzip reads as part of the same file. `--tsv` derives one row per pair (and one per
// official benchmark job) from the whole directory; the JSONL files stay the source of truth.
import { execFile } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { validateRecord } from './run-lib.mjs'

const run = promisify(execFile)
const GH = process.env.BENCH_GH || 'gh' // overridable so fixtures can use a stand-in
const MAX_LOG = 20_000_000 // a log larger than this is not parsed; the job is recorded as such

// ---- parsing (pure) ----
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g
const STAMP = /^﻿?\d{4}-\d{2}-\d{2}T[\d:.]+Z /
export const cleanLines = (log) => log.replace(ANSI, '').split(/\r?\n/).map((l) => l.replace(STAMP, ''))

/** The lines of the ```json block that follows the first line starting with `summaryStart`, joined. undefined when absent or unterminated. */
function fenced(lines, summaryStart) {
  const i = lines.findIndex((l) => l.startsWith(summaryStart))
  if (i < 0) return undefined
  const open = lines.indexOf('```json', i)
  if (open < 0) return undefined
  const close = lines.indexOf('```', open + 1)
  if (close < 0) return undefined
  return lines.slice(open + 1, close).join('\n').trim()
}

const lengthNote = (lines, start) => lines.find((l) => l.startsWith(start))?.match(/\((\d+) characters, (complete|SHORTENED DIAGNOSTIC[^)]*)\)/)

function hostFrom(lines, name) {
  const note = lengthNote(lines, `<details><summary>${name} status line`)
  const raw = fenced(lines, `<details><summary>${name} status line`)
  if (raw === undefined || !note) return { raw: null, rawComplete: false, valid: false, problems: ['no status line in the report'] }
  if (note[2] !== 'complete') return { raw, rawComplete: false, valid: false, problems: ['the report shows only a shortened diagnostic'] }
  let w
  try { w = JSON.parse(raw) } catch { return { raw, rawComplete: true, valid: false, problems: ['status line is not JSON'] } }
  const problems = []
  if (!w || typeof w !== 'object' || Array.isArray(w)) problems.push('status line is not an object')
  else {
    if (w.host !== name) problems.push(`wrapper host ${JSON.stringify(w.host)}`)
    if (w.status !== 'valid') problems.push(`wrapper status ${JSON.stringify(w.status)}`)
    if (!w.record || typeof w.record !== 'object') problems.push('no record')
    else {
      for (const p of validateRecord(w.record, name)) problems.push('record: ' + p)
      if (w.record.valid !== true || w.record.complete !== true) problems.push('record not valid and complete')
    }
  }
  return { raw, rawComplete: true, valid: problems.length === 0, problems }
}

/** Parse an advisory job's log. Always returns an object; `report` is false when there is no END sentinel. */
export function parseAdvisory(log) {
  const lines = cleanLines(log)
  const end = lines.map((l) => /^END-OF-APPEND-REPORT verdict=(admissible|not-admissible)$/.exec(l)).find(Boolean)
  const metaRaw = fenced(lines, '<details><summary>metadata')
  let meta = null
  if (metaRaw) { try { meta = JSON.parse(metaRaw) } catch { meta = null } }
  return { report: Boolean(end), verdict: end ? end[1] : null, metaRaw: metaRaw ?? null, meta, claude: hostFrom(lines, 'claude'), pi: hostFrom(lines, 'pi') }
}

/** The official benchmark prints `append benchmark: round p95s a, b, c ms; collection requested|unavailable`. */
export function parseOfficial(log) {
  const m = cleanLines(log).map((l) => /^append benchmark: round p95s ([\d.]+), ([\d.]+), ([\d.]+) ms; collection (requested|unavailable)$/.exec(l)).filter(Boolean)
  if (m.length !== 1) return { found: m.length, rounds: null, collection: null } // 0 = not printed (for example the test never ran), >1 = ambiguous
  return { found: 1, rounds: [Number(m[0][1]), Number(m[0][2]), Number(m[0][3])], collection: m[0][4] }
}

// ---- GitHub access (read-only) ----
const gh = async (args) => (await run(GH, ['api', '--allow-escape-sequences', ...args], { maxBuffer: MAX_LOG + 1_000_000 })).stdout
const ghJson = async (path) => JSON.parse(await gh([path]))

async function listRuns({ repo, workflow, since, limit }) {
  const runs = []
  for (let page = 1; runs.length < limit; page++) {
    const q = `per_page=100&page=${page}&status=completed${since ? `&created=%3E%3D${encodeURIComponent(since)}` : ''}`
    const r = await ghJson(`repos/${repo}/actions/workflows/${workflow}/runs?${q}`)
    runs.push(...r.workflow_runs)
    if (r.workflow_runs.length < 100) break
  }
  return runs.slice(0, limit)
}

const osOf = (name) => /\((.+)\)$/.exec(name)?.[1] ?? null
const sourceOf = (name) => (name.startsWith('append measurement (') ? 'advisory' : /^(plugins|pi) \(/.test(name) ? 'official' : null)

export async function harvest({ repo, workflow = 'ci.yml', since, limit = 50, log = () => {} }) {
  const rows = []
  const runs = await listRuns({ repo, workflow, since, limit })
  for (const r of runs) {
    for (let attempt = 1; attempt <= r.run_attempt; attempt++) {
      const jobs = (await ghJson(`repos/${repo}/actions/runs/${r.id}/attempts/${attempt}/jobs?per_page=100`)).jobs
      for (const j of jobs) {
        const source = sourceOf(j.name)
        if (!source || j.status !== 'completed') continue
        const base = {
          key: `${r.id}/${attempt}/${j.id}`, source, repo, runId: r.id, attempt, jobId: j.id, job: j.name, os: osOf(j.name), event: r.event,
          headSha: r.head_sha, runCreatedAt: r.created_at, jobStartedAt: j.started_at, jobCompletedAt: j.completed_at, conclusion: j.conclusion,
          logUrl: `https://github.com/${repo}/actions/runs/${r.id}/job/${j.id}`,
        }
        let text
        try { text = await gh([`repos/${repo}/actions/jobs/${j.id}/logs`]) } catch (e) { rows.push({ ...base, logError: String(e.stderr || e.message).slice(0, 300) }); continue }
        if (text.length > MAX_LOG) { rows.push({ ...base, logError: `log is ${text.length} characters, over the ${MAX_LOG} parse bound` }); continue }
        rows.push({ ...base, ...(source === 'advisory' ? { advisory: parseAdvisory(text) } : { official: parseOfficial(text) }) })
        log(`${base.key} ${j.name} ${j.conclusion}`)
      }
    }
  }
  return rows
}

// ---- the dataset ----
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/** Merges new rows into the existing JSONL text. Returns { text, added, skipped, conflicts }; never replaces an existing key. */
export function merge(existingText, rows, harvestedAt) {
  const have = new Map()
  for (const line of existingText.split('\n').filter(Boolean)) {
    const o = JSON.parse(line)
    const prev = have.get(o.key)
    if (prev) { const { harvestedAt: _a, ...x } = prev, { harvestedAt: _b, ...y } = o; if (!same(x, y)) throw new Error(`the dataset holds two different records for ${o.key}`) }
    have.set(o.key, o)
  }
  const add = [], conflicts = []
  let skipped = 0
  for (const row of rows) {
    const prev = have.get(row.key)
    if (!prev) { add.push({ ...row, harvestedAt }); continue }
    const { harvestedAt: _drop, ...rest } = prev
    if (same(rest, row)) skipped++; else conflicts.push(row.key)
  }
  return { added: add.length, skipped, conflicts, newRows: conflicts.length ? [] : add, text: conflicts.length ? existingText : existingText + add.map((o) => JSON.stringify(o) + '\n').join('') }
}

// ---- the monthly files ----
const FILE = /^append-(\d{4}-\d{2})\.jsonl(\.gz)?$/
export const monthOf = (row) => {
  const m = /^(\d{4}-\d{2})-\d{2}T/.exec(String(row.runCreatedAt))
  if (!m) throw new Error(`run ${row.runId} has no usable creation date`)
  return m[1]
}

/** The whole dataset as one text, in file-name order. Each file must be empty or end with a newline. */
export function readDataset(dir) {
  if (!existsSync(dir)) return ''
  let text = ''
  for (const name of readdirSync(dir).filter((n) => FILE.test(n)).sort()) {
    const buf = readFileSync(join(dir, name))
    const t = (name.endsWith('.gz') ? gunzipSync(buf) : buf).toString('utf8')
    if (t && !t.endsWith('\n')) throw new Error(`${name} does not end with a newline`)
    text += t
  }
  return text
}

/** Adds rows to the file of their month: appended to the plain file, or as one more gzip member when that month is already archived. */
export function writeRows(dir, rows) {
  mkdirSync(dir, { recursive: true })
  const by = new Map()
  for (const r of rows) { const m = monthOf(r); by.set(m, (by.get(m) ?? '') + JSON.stringify(r) + '\n') }
  for (const [m, text] of by) {
    const gz = join(dir, `append-${m}.jsonl.gz`)
    if (existsSync(gz)) appendFileSync(gz, gzipSync(text)); else appendFileSync(join(dir, `append-${m}.jsonl`), text)
  }
}

/** Gzips every plain monthly file older than the month of `nowIso`. The archive is read back before the plain file is removed. */
export function compact(dir, nowIso) {
  if (!existsSync(dir)) return 0
  const current = nowIso.slice(0, 7)
  let n = 0
  for (const name of readdirSync(dir).sort()) {
    const m = /^append-(\d{4}-\d{2})\.jsonl$/.exec(name)
    if (!m || m[1] >= current) continue
    const plain = join(dir, name), gz = join(dir, name + '.gz'), tmp = gz + '.tmp'
    const text = readFileSync(plain)
    const prior = existsSync(gz) ? readFileSync(gz) : Buffer.alloc(0)
    writeFileSync(tmp, Buffer.concat([prior, gzipSync(text)]))
    const want = Buffer.concat([prior.length ? gunzipSync(prior) : Buffer.alloc(0), text])
    if (!gunzipSync(readFileSync(tmp)).equals(want)) { unlinkSync(tmp); throw new Error(`archive check failed for ${name}; the plain file is kept`) }
    renameSync(tmp, gz)
    unlinkSync(plain)
    n++
  }
  return n
}

const TSV_COLS = ['source', 'runId', 'attempt', 'jobId', 'job', 'os', 'event', 'headSha', 'conclusion', 'verdict', 'host', 'hostValid', 'pair', 'order', 'appendP95', 'appendMedian', 'warmFullMedian', 'ratioP95OverWarmMedian', 'ratioMedianOverWarmMedian', 'coldMs', 'round1', 'round2', 'round3', 'collection', 'note']
export function toTsv(jsonl) {
  const out = [TSV_COLS.join('\t')]
  const row = (o) => out.push(TSV_COLS.map((c) => String(o[c] ?? '').replace(/[\t\n]/g, ' ')).join('\t'))
  for (const line of jsonl.split('\n').filter(Boolean)) {
    const o = JSON.parse(line)
    const b = { source: o.source, runId: o.runId, attempt: o.attempt, jobId: o.jobId, job: o.job, os: o.os, event: o.event, headSha: o.headSha, conclusion: o.conclusion }
    if (o.logError) { row({ ...b, note: 'log unavailable: ' + o.logError }); continue }
    if (o.source === 'official') {
      const f = o.official
      row({ ...b, host: o.job.startsWith('pi') ? 'pi' : 'claude', round1: f.rounds?.[0], round2: f.rounds?.[1], round3: f.rounds?.[2], collection: f.collection, note: f.rounds ? '' : `benchmark line found ${f.found} times` })
      continue
    }
    const a = o.advisory
    if (!a.report) { row({ ...b, note: 'no report in the log' }); continue }
    for (const host of ['claude', 'pi']) {
      const h = a[host]
      let rec
      try { rec = h.raw ? JSON.parse(h.raw).record : undefined } catch { rec = undefined }
      const pairs = Array.isArray(rec?.pairs) ? rec.pairs.filter((p) => p && typeof p === 'object') : []
      if (!pairs.length) { row({ ...b, verdict: a.verdict, host, hostValid: h.valid, note: h.problems.join('; ') }); continue }
      for (const p of pairs) row({ ...b, verdict: a.verdict, host, hostValid: h.valid, pair: p.pair, order: p.order, appendP95: p.appendP95, appendMedian: p.appendMedian, warmFullMedian: p.warmFullMedian, ratioP95OverWarmMedian: p.ratioP95OverWarmMedian, ratioMedianOverWarmMedian: p.ratioMedianOverWarmMedian, coldMs: p.cold?.ms, note: h.valid ? '' : h.problems.join('; ') })
    }
  }
  return out.join('\n') + '\n'
}

// ---- CLI ----
function parseArgs(argv) {
  const o = {}, known = new Set(['repo', 'out-dir', 'tsv', 'since', 'limit', 'workflow'])
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]?.replace(/^--/, '')
    if (!argv[i]?.startsWith('--') || !known.has(k) || argv[i + 1] === undefined || argv[i + 1].startsWith('--')) return { error: `bad or incomplete option ${argv[i]}` }
    o[k] = argv[i + 1]
  }
  if (!o.repo || !/^[\w.-]+\/[\w.-]+$/.test(o.repo)) return { error: '--repo OWNER/REPO is required' }
  if (!o['out-dir']) return { error: '--out-dir DIR is required' }
  if (o.limit !== undefined && !/^\d{1,4}$/.test(o.limit)) return { error: '--limit must be a positive integer' }
  if (o.since !== undefined && Number.isNaN(Date.parse(o.since))) return { error: '--since must be a date' }
  return { ...o, limit: o.limit ? Number(o.limit) : 50 }
}

async function main() {
  const a = parseArgs(process.argv.slice(2))
  if (a.error) { console.error(a.error); return 2 }
  const dir = a['out-dir']
  const now = process.env.BENCH_NOW || new Date().toISOString() // the variable exists for the fixtures
  let existing
  try { existing = readDataset(dir) } catch (e) { console.error(`cannot read the dataset: ${e.message}`); return 1 }
  let rows
  try { rows = await harvest({ ...a, log: (l) => console.error(l) }) } catch (e) { console.error('harvest failed: ' + String(e.stderr || e.message).slice(0, 500)); return 1 }
  let m
  try { m = merge(existing, rows, now) } catch (e) { console.error(`cannot merge: ${e.message}`); return 1 }
  if (m.conflicts.length) { console.error(`conflict: already recorded with different content, nothing written: ${m.conflicts.join(', ')}`); return 1 }
  let archived = 0
  try { writeRows(dir, m.newRows); archived = compact(dir, now); if (a.tsv) writeFileSync(a.tsv, toTsv(readDataset(dir))) } catch (e) { console.error(`cannot write: ${e.message}`); return 1 }
  console.log(`harvested ${rows.length} job records: ${m.added} added, ${m.skipped} already present, ${archived} month file(s) archived`)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().then((c) => { process.exitCode = c })
