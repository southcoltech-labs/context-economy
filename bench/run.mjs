#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Bounded runner for the explicit append measurements (not a gate): `node bench/run.mjs claude|pi [--deadline-ms N]`.
// It runs the host command in its own process group with a hard deadline, kills the whole group on timeout, and always prints one
// `APPEND-RUN-JSON {...}` line saying what happened: valid | invalid | incomplete | timeout | no-record | startup-failure.
// Exit code 0 only for a valid record. A failed run is never a sample. Output kept from the child is bounded.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const host = process.argv[2]
const di = process.argv.indexOf('--deadline-ms')
const deadlineMs = di > 0 ? Number(process.argv[di + 1]) : 240_000
const MAX_KEEP = 200_000
const started = Date.now()
const report = (r) => { console.log('APPEND-RUN-JSON ' + JSON.stringify({ host, deadlineMs, elapsedMs: Date.now() - started, ...r })); process.exit(r.status === 'valid' ? 0 : 1) }
if (host !== 'claude' && host !== 'pi') report({ status: 'startup-failure', reason: 'usage: node bench/run.mjs claude|pi [--deadline-ms N]' })

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))
const hashes = (dir, files) => Object.fromEntries(files.map((f) => [relative(dir, f), createHash('sha256').update(readFileSync(f)).digest('hex')]).sort())
const isTest = (f) => /\.test\.tsx?$/.test(f)

let cmd, args, cwd = root, scratch
const extra = {}
try {
  if (host === 'pi') { cmd = 'bun'; args = ['run', 'bench/append-pi/measure.ts'] } else {
    // `claude plugin test` refuses imports from outside a plugin folder and runs every *.test.ts under it, so measure a byte-for-byte copy of
    // the production plugin without its tests, plus the measurement file and its core.
    scratch = mkdtempSync(join(tmpdir(), 'append-measure-'))
    const src = join(root, 'plugins/context-bar')
    cpSync(src, scratch, { recursive: true, filter: (s) => !isTest(s) })
    const srcFiles = walk(src).filter((f) => !isTest(f))
    const a = hashes(src, srcFiles), b = hashes(scratch, walk(scratch))
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error('copied files differ from the production files')
    cpSync(join(root, 'bench/append-claude/append-measure.test.ts'), join(scratch, 'append-measure.test.ts'))
    cpSync(join(root, 'bench/append-measure-core.ts'), join(scratch, 'append-measure-core.ts'))
    const tests = walk(scratch).filter(isTest).map((f) => relative(scratch, f))
    if (tests.length !== 1 || tests[0] !== 'append-measure.test.ts') throw new Error('unexpected test files in the copy: ' + tests.join(','))
    extra.copy = { files: Object.keys(a).length, manifestSha256: createHash('sha256').update(JSON.stringify(a)).digest('hex'), tests }
    cmd = 'claude'; args = ['plugin', 'test', scratch]
  }
} catch (e) {
  if (scratch) rmSync(scratch, { recursive: true, force: true })
  report({ status: 'startup-failure', stage: 'prepare', reason: String(e?.message ?? e).slice(0, 300) })
}

let out = '', err = '', done = false, timedOut = false
const child = spawn(cmd, args, { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
const keep = (s, c) => (s.length < MAX_KEEP ? s + c : s)
child.stdout.on('data', (c) => { out = keep(out, c.toString()) })
child.stderr.on('data', (c) => { err = keep(err, c.toString()) })
const killGroup = (sig) => { try { process.kill(-child.pid, sig) } catch { /* already gone */ } }
const timer = setTimeout(() => { timedOut = true; killGroup('SIGTERM'); setTimeout(() => killGroup('SIGKILL'), 3000).unref() }, deadlineMs)
const finish = (code, signal, spawnError) => {
  if (done) return
  done = true
  clearTimeout(timer)
  killGroup('SIGKILL') // no leftover workload, whatever happened
  if (scratch) rmSync(scratch, { recursive: true, force: true })
  const tail = (err || out).slice(-600)
  if (spawnError) return report({ status: 'startup-failure', stage: 'spawn', reason: String(spawnError.message).slice(0, 300), ...extra })
  // The Claude host may prefix console output, so match the marker anywhere in a line.
  const MARK = 'APPEND-MEASURE-JSON '
  const line = (out + '\n' + err).split('\n').find((l) => l.includes(MARK))
  let record
  try { record = line ? JSON.parse(line.slice(line.indexOf(MARK) + MARK.length)) : undefined } catch { /* handled below */ }
  const base = { exitCode: code, signal, ...extra }
  if (timedOut) return report({ status: 'timeout', ...base, record, partialRecordPrinted: !!record, tail })
  if (!record) return report({ status: 'no-record', ...base, tail })
  const status = record.valid && record.complete && code === 0 ? 'valid' : record.complete ? 'invalid' : 'incomplete'
  report({ status, ...base, record, ...(status === 'valid' ? {} : { tail }) })
}
child.on('error', (e) => finish(null, null, e))
child.on('close', (code, signal) => finish(code, signal))
