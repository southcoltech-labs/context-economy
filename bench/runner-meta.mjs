#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Prints one JSON object describing the machine and toolchain a measurement ran on, for the advisory CI job (the Claude test realm cannot
// report any of this). Every field is best effort: a failed probe is recorded as the string "unavailable", never an exception.
import { execFileSync } from 'node:child_process'
import os from 'node:os'

const probe = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', timeout: 10_000 }).trim().split('\n')[0].slice(0, 200) } catch { return 'unavailable' } }
// `df -k <path>`: the header is line 1, the data line 2; the available column is the fourth one.
const diskFreeKiB = () => {
  try {
    const line = execFileSync('df', ['-k', process.env.RUNNER_TEMP ?? os.tmpdir()], { encoding: 'utf8', timeout: 10_000 }).trim().split('\n')[1] ?? ''
    const n = Number(line.trim().split(/\s+/)[3])
    return Number.isFinite(n) ? n : 'unavailable'
  } catch { return 'unavailable' }
}
const e = (k) => process.env[k] ?? 'unavailable'
const cpus = os.cpus()
console.log(JSON.stringify({
  startedAt: new Date().toISOString(),
  runner: { name: e('RUNNER_NAME'), os: e('RUNNER_OS'), arch: e('RUNNER_ARCH'), image: e('ImageOS'), imageVersion: e('ImageVersion'), environment: e('RUNNER_ENVIRONMENT') },
  machine: {
    platform: os.platform(), arch: os.arch(), release: os.release(), cpuCount: cpus.length, cpuModel: cpus[0]?.model ?? 'unavailable',
    totalMemMiB: Math.round(os.totalmem() / 1048576), freeMemMiB: Math.round(os.freemem() / 1048576), loadavg: os.loadavg().map((x) => Math.round(x * 100) / 100),
    uptimeSec: Math.round(os.uptime()), diskFreeKiB: diskFreeKiB(),
  },
  tools: { node: process.version, bun: probe('bun', ['--version']), claude: probe('claude', ['--version']) },
  run: { repository: e('GITHUB_REPOSITORY'), sha: e('GITHUB_SHA'), ref: e('GITHUB_REF'), runId: e('GITHUB_RUN_ID'), runAttempt: e('GITHUB_RUN_ATTEMPT'), event: e('GITHUB_EVENT_NAME'), job: e('GITHUB_JOB') },
}))
