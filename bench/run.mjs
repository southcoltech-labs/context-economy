#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Bounded runner for the explicit append measurements (not a gate): `node bench/run.mjs claude|pi [--deadline-ms N]`.
// It runs the host command in its own process group with a hard deadline, validates the record the host prints, and always prints one
// `APPEND-RUN-JSON {...}` line. status: valid | invalid | incomplete | timeout | interrupted | no-record | startup-failure.
// Exit code 0 only for a valid, validated record. Catchable interruption (SIGINT, SIGTERM, SIGHUP) is finalized the same way: the host's
// process group is terminated and confirmed gone (or reported unconfirmed) and the scratch copy is removed. SIGKILL of this runner cannot be
// handled; it can leave the host running and prints nothing.
import { createHash } from 'node:crypto'
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { emitAndExit, execute, parseDeadline } from './run-lib.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const host = process.argv[2]
const di = process.argv.indexOf('--deadline-ms')
const deadlineMs = parseDeadline(di > 0 ? process.argv[di + 1] : undefined)
const started = Date.now()
const report = (r) => emitAndExit('APPEND-RUN-JSON ' + JSON.stringify({ host, deadlineMs, elapsedMs: Date.now() - started, ...r }), r.status === 'valid' ? 0 : 1)
if (host !== 'claude' && host !== 'pi') report({ status: 'startup-failure', reason: 'usage: node bench/run.mjs claude|pi [--deadline-ms N]' })
if (deadlineMs === undefined) report({ status: 'startup-failure', reason: '--deadline-ms must be an integer from 1000 to 3600000' })

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))
const hashes = (dir, files) => Object.fromEntries(files.map((f) => [relative(dir, f), createHash('sha256').update(readFileSync(f)).digest('hex')]).sort())
const isTest = (f) => /\.test\.tsx?$/.test(f)

let cmd, args, scratch
const extra = {}
try {
  if (host === 'pi') { cmd = 'bun'; args = ['run', 'bench/append-pi/measure.ts'] } else {
    // `claude plugin test` refuses imports from outside a plugin folder and runs every *.test.ts under it, so measure a byte-for-byte copy of
    // the production plugin without its tests, plus the measurement file and its core.
    scratch = mkdtempSync(join(tmpdir(), 'append-measure-'))
    const src = join(root, 'plugins/context-bar')
    cpSync(src, scratch, { recursive: true, filter: (s) => !isTest(s) })
    const a = hashes(src, walk(src).filter((f) => !isTest(f))), b = hashes(scratch, walk(scratch))
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

await execute({ host, deadlineMs, cmd, args, cwd: root, extra, started, cleanup: () => { if (scratch) rmSync(scratch, { recursive: true, force: true }) } })
