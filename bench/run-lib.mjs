// SPDX-License-Identifier: Apache-2.0
//
// Bounded child runner and record validation for bench/run.mjs. Separate from the CLI so failure fixtures can drive it with stand-in children.
import { spawn } from 'node:child_process'

export const MARK = 'APPEND-MEASURE-JSON '
export const EXPECT = { schema: 1, base: 5000, appends: 40, warmWalks: 5, orders: ['append-first', 'full-first', 'full-first', 'append-first'] }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const finiteNonNeg = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0
const sorted = (xs) => [...xs].sort((a, b) => a - b)
const median = (xs) => { const s = sorted(xs); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2 }
const p95 = (xs) => sorted(xs)[Math.ceil(xs.length * 0.95) - 1]
const close = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b))

/** Strict deadline parsing: a plain decimal integer in [1000, 3600000]. Returns undefined when invalid. */
export const parseDeadline = (raw) => (raw === undefined ? 240_000 : /^\d{1,7}$/.test(raw) && Number(raw) >= 1000 && Number(raw) <= 3_600_000 ? Number(raw) : undefined)

/** Returns a list of problems; empty means the record is a well-formed, complete, valid observation for `host`. */
export function validateRecord(r, host) {
  const bad = []
  if (!r || typeof r !== 'object' || Array.isArray(r)) return ['record is not an object']
  if (r.schema !== EXPECT.schema) bad.push('schema')
  if (r.kind !== 'append-measurement') bad.push('kind')
  if (r.host !== host) bad.push('host')
  if (typeof r.valid !== 'boolean' || typeof r.complete !== 'boolean') bad.push('valid/complete flags')
  if (!Array.isArray(r.invalidReasons) || !Array.isArray(r.warnings)) bad.push('reason lists')
  else if (r.valid === true && r.invalidReasons.length) bad.push('valid with reasons')
  const c = r.config
  if (!c || c.base !== EXPECT.base || c.appends !== EXPECT.appends || c.warmWalks !== EXPECT.warmWalks || JSON.stringify(c.orders) !== JSON.stringify(EXPECT.orders)) bad.push('config')
  if (!finiteNonNeg(r.elapsedMs)) bad.push('elapsedMs')
  if (!Array.isArray(r.pairs) || r.pairs.length !== EXPECT.orders.length) { bad.push('pair count'); return bad }
  r.pairs.forEach((p, i) => {
    const w = `pair ${i}`
    if (!p || p.pair !== i || p.order !== EXPECT.orders[i]) return bad.push(`${w} identity/order`)
    if (p.equal !== true || p.appendDone !== true || p.fullDone !== true) bad.push(`${w} flags`)
    const s = p.stateSizes
    if (!s || s.appendStart !== EXPECT.base || s.appendEnd !== EXPECT.base + EXPECT.appends || s.fullWalk !== EXPECT.base + EXPECT.appends) bad.push(`${w} state sizes`)
    if (!Array.isArray(p.appendMs) || p.appendMs.length !== EXPECT.appends || !p.appendMs.every(finiteNonNeg)) return bad.push(`${w} append samples`)
    if (!Array.isArray(p.warmFullMs) || p.warmFullMs.length !== EXPECT.warmWalks || !p.warmFullMs.every(finiteNonNeg)) return bad.push(`${w} warm samples`)
    const cd = p.cold
    if (!cd || typeof cd !== 'object' || !finiteNonNeg(cd.ms) || cd.messages !== EXPECT.base + EXPECT.appends || cd.shapeMatchesWarm !== true) bad.push(`${w} cold sample`)
    const d = { appendP95: p95(p.appendMs), appendMedian: median(p.appendMs), warmFullMedian: median(p.warmFullMs) }
    d.ratioP95OverWarmMedian = d.appendP95 / d.warmFullMedian
    d.ratioMedianOverWarmMedian = d.appendMedian / d.warmFullMedian
    for (const k of Object.keys(d)) if (typeof p[k] !== 'number' || !close(p[k], d[k])) bad.push(`${w} derived ${k}`)
  })
  return bad
}

/**
 * Runs a child in its own process group with a hard deadline. Resolves once the group is confirmed gone (or confirmation failed).
 * Returns { interrupt(reason), result: Promise }.
 */
export function startBounded({ cmd, args, cwd, deadlineMs, maxKeep = 200_000, killGraceMs = 3000, confirmMs = 5000 }) {
  const out = { chunks: [], bytes: 0, truncated: false }
  const err = { chunks: [], bytes: 0, truncated: false }
  const take = (b) => (c) => {
    const room = maxKeep - b.bytes
    if (room <= 0) { b.truncated = true; return }
    const piece = c.length > room ? c.subarray(0, room) : c
    if (piece.length < c.length) b.truncated = true
    b.chunks.push(piece); b.bytes += piece.length
  }
  let child, spawnError, exited = false, exitCode = null, exitSignal = null, closed = false, finalizing
  let resolveResult
  const result = new Promise((r) => { resolveResult = r })
  try { child = spawn(cmd, args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }) } catch (e) { spawnError = e }
  const alive = () => { if (!child?.pid) return false; try { process.kill(-child.pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
  const send = (sig) => { try { process.kill(-child.pid, sig) } catch { /* already gone */ } }
  const waitGone = async (ms) => { const end = Date.now() + ms; while (alive() && Date.now() < end) await sleep(40); return !alive() }
  const decode = (b) => Buffer.concat(b.chunks).toString('utf8')
  const finalize = (reason) => {
    if (finalizing) return finalizing
    finalizing = (async () => {
      clearTimeout(timer)
      let cleanup = 'clean', descendantsKilled = false
      if (child?.pid && alive()) {
        if (reason === 'exited') descendantsKilled = true
        cleanup = 'killed'
        send('SIGTERM')
        if (!(await waitGone(killGraceMs))) { send('SIGKILL'); if (!(await waitGone(confirmMs))) cleanup = 'unconfirmed' }
      }
      child?.stdout?.destroy(); child?.stderr?.destroy()
      resolveResult({
        reason, exitCode, exitSignal, exited, cleanup, descendantsKilled,
        stdout: decode(out), stderr: decode(err), truncated: { stdout: out.truncated, stderr: err.truncated },
      })
    })()
    return finalizing
  }
  const timer = setTimeout(() => finalize('timeout'), deadlineMs)
  if (spawnError || !child.pid) {
    clearTimeout(timer)
    resolveResult({ reason: 'spawn-error', spawnError: String(spawnError?.message ?? 'no pid').slice(0, 300), cleanup: 'clean', stdout: '', stderr: '', truncated: { stdout: false, stderr: false } })
  } else {
    child.stdout.on('data', take(out)); child.stderr.on('data', take(err))
    child.on('error', (e) => { spawnError = e; finalize('spawn-error').then(() => {}) })
    child.on('close', () => { closed = true })
    child.on('exit', async (code, signal) => {
      exited = true; exitCode = code; exitSignal = signal
      // Give the pipes a moment to drain; a descendant holding them open must not hang the runner.
      const end = Date.now() + 500
      while (!closed && Date.now() < end) await sleep(20)
      finalize(finalizing ? 'x' : 'exited')
    })
  }
  return { interrupt: (reason) => finalize(reason), result }
}

/** Writes one line to stdout, waits for the write to complete, then sets the exit code. Never truncates the line. */
export function emitAndExit(line, code) {
  const finish = (c) => process.exit(c)
  const ok = process.stdout.write(line + '\n', (e) => finish(e ? 2 : code))
  process.stdout.on('error', () => finish(2))
  void ok
}

/** The whole run: bounded child, interruption handling, record analysis, one report line, exit code. Used by run.mjs and by the fixtures. */
export async function execute({ host, deadlineMs, cmd, args, cwd, extra = {}, cleanup = () => {}, started = Date.now(), maxKeep }) {
  const report = (r) => emitAndExit('APPEND-RUN-JSON ' + JSON.stringify({ host, deadlineMs, elapsedMs: Date.now() - started, ...r }), r.status === 'valid' ? 0 : 1)
  const run = startBounded({ cmd, args, cwd, deadlineMs, maxKeep })
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { run.interrupt('interrupted:' + sig) })
  const r = await run.result
  cleanup()
  const lines = (r.stdout + '\n' + r.stderr).split('\n').filter((l) => l.includes(MARK))
  let record, problems = []
  if (lines.length === 1) {
    try { record = JSON.parse(lines[0].slice(lines[0].indexOf(MARK) + MARK.length)); problems = validateRecord(record, host) } catch { problems = ['record is not valid JSON'] }
  } else if (lines.length > 1) problems = ['duplicate marker lines: ' + lines.length]
  const tail = (r.stderr || r.stdout).slice(-600)
  const base = { exitCode: r.exitCode, signal: r.exitSignal, cleanup: r.cleanup, truncated: r.truncated, ...extra }
  if (r.reason === 'spawn-error') return report({ status: 'startup-failure', stage: 'spawn', reason: r.spawnError, ...extra })
  if (r.reason === 'timeout') return report({ status: 'timeout', ...base, problems, record, tail })
  if (r.reason.startsWith('interrupted')) return report({ status: 'interrupted', interruptedBy: r.reason.slice(12), ...base, problems, record, tail })
  if (!lines.length) return report({ status: 'no-record', ...base, tail })
  let status
  if (record && record.valid === false && record.complete === false) status = 'incomplete'
  else if (problems.length || r.exitCode !== 0 || r.exitSignal || r.descendantsKilled || r.cleanup === 'unconfirmed' || !record?.valid || !record?.complete) status = 'invalid'
  else status = 'valid'
  return report({ status, ...base, descendantsKilled: r.descendantsKilled, problems, record, ...(status === 'valid' ? {} : { tail }) })
}
