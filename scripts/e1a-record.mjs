#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

// E1a recorder: writes one platform's run into docs/release-proof/<version>-<platform>.json from
// the hosts' own records, so the proof is never typed by hand. Each machine keeps its own run file;
// no file is carried from one machine to the next. Three commands:
//
//   capture   after install and the behaviour checks, before uninstall. Reads the installed
//             commits (Claude Code's installed_plugins.json `gitCommitSha` per plugin, the Pi
//             package clone's HEAD) and the operator's install/behavior results, and writes a
//             capture bound to the version, candidate SHA and platform, and to where it read: the
//             Pi repository and the resolved Claude and Pi host directories. Once the
//             request is valid, the platform's earlier run file and pending capture are removed
//             before any host is probed, so no earlier pass is reused, even if this capture fails.
//   finalize  after uninstall. Takes the capture as it is (failures included), adds the
//             operator's uninstall results, and writes the platform's run file. It does not reread
//             the installed commits. It refuses a different Pi repository or host directory than
//             the capture's, and reads that the captured installs are gone: a Claude entry or Pi
//             clone still present fails uninstall. The capture is consumed.
//   combine   once every platform's run file is in docs/release-proof/ (copied from each
//             machine), writes docs/release-proof/<version>.json from them, which promote.mjs reads.
//             It refuses a missing platform, a run file for another candidate or platform, and a
//             pending capture. It reads no host. The combined proof is derived: a valid capture,
//             finalize or combine removes the earlier one first, so a refused or aborted step never
//             leaves an earlier pass in place. A combined proof for another candidate is refused,
//             not removed.
//
// `installed_commit` is derived, never attested: it passes only when every commit equals the
// candidate. check-release-proof.mjs then validates the combined file.
//
//   node scripts/e1a-record.mjs capture --version 0.1.0 --sha <candidate sha> --platform macos-arm64 \
//     --pi-repo <owner>/<repo> --claude install=pass,behavior=pass --pi install=pass,behavior=pass
//   node scripts/e1a-record.mjs finalize --version 0.1.0 --sha <candidate sha> --platform macos-arm64 \
//     --pi-repo <owner>/<repo> --claude uninstall=pass --pi uninstall=pass
//   node scripts/e1a-record.mjs combine --version 0.1.0 --sha <candidate sha>
//
// Host locations: CLAUDE_CONFIG_DIR (default ~/.claude), PI_CODING_AGENT_DIR (default ~/.pi/agent).
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PLATFORMS, piExtensionNames, proofPath, STEPS } from "./check-release-proof.mjs";
import { makeRunner, SHA40 } from "./release-lib.mjs";
import { promotedManifests } from "./sync-plugin-version.mjs";

export const CAPTURED = ["install", "behavior"];
export const FINALIZED = ["uninstall"];

export const capturePath = (version, platform) => `docs/release-proof/${version}-${platform}.capture.json`;
/** One platform's finalized run, kept on the machine that ran it until `combine`. */
export const runPath = (version, platform) => `docs/release-proof/${version}-${platform}.json`;

/** `install=pass,behavior=pass` → steps; exactly the `names` given, each pass or fail. */
export function parseSteps(text, names) {
  const steps = {};
  for (const part of String(text ?? "").split(",").filter(Boolean)) {
    const [k, v] = part.split("=");
    if (!names.includes(k) || !["pass", "fail"].includes(v)) throw new Error(`bad step ${JSON.stringify(part)}: use ${names.join("|")}=pass|fail`);
    steps[k] = v;
  }
  for (const k of names) if (!steps[k]) throw new Error(`step ${k} not given`);
  return steps;
}

/** Each promoted plugin's installed commit from the host record; missing plugins are absent. */
export function claudeInstalled(configDir, marketplace, plugins) {
  const file = join(configDir, "plugins", "installed_plugins.json");
  const all = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).plugins ?? {} : {};
  return Object.fromEntries(plugins.flatMap((p) => {
    const sha = all[`${p}@${marketplace}`]?.[0]?.gitCommitSha;
    return sha ? [[p, sha]] : [];
  }));
}

const piClone = (agentDir, repo) => join(agentDir, "git", "github.com", ...repo.split("/"));

/** The Pi package clone's HEAD for github.com/<owner>/<repo>, or undefined. */
export function piInstalled(run, agentDir, repo) {
  const clone = piClone(agentDir, repo);
  if (!existsSync(clone)) return undefined;
  const r = run("git", ["-C", clone, "rev-parse", "HEAD"]);
  return r.code === 0 ? r.stdout : undefined;
}

const result = (steps) => (STEPS.every((s) => steps[s] === "pass") ? "pass" : "fail");

/** The capture: installed commits as read, `installed_commit` derived, attested install/behavior. */
export function buildCapture({ version, sha, platform, origin, plugins, extensions, claude, pi, id = randomUUID(), date }) {
  return {
    capture_id: id, version, candidate_sha: sha, platform, origin, date,
    claude: {
      version: claude.version, plugins: claude.installed,
      steps: { ...claude.steps, installed_commit: plugins.every((p) => claude.installed[p] === sha) ? "pass" : "fail" },
    },
    pi: {
      version: pi.version, installed_commit: pi.installed ?? "", extensions,
      steps: { ...pi.steps, installed_commit: pi.installed === sha ? "pass" : "fail" },
    },
  };
}

const ORIGIN = ["pi_repo", "claude_config_dir", "pi_agent_dir"];

/** Refuses a capture for another candidate or platform, or read from other places than `origin`. */
export function checkCapture(capture, { version, sha, platform, origin }) {
  if (!capture) throw new Error(`no capture for ${version} on ${platform}: run capture before uninstall`);
  if (capture.version !== version || capture.candidate_sha !== sha || capture.platform !== platform) {
    throw new Error(`capture is for ${capture.version} at ${capture.candidate_sha} on ${capture.platform}, not ${version} at ${sha} on ${platform}`);
  }
  for (const k of ORIGIN) {
    if (typeof capture.origin?.[k] !== "string" || !capture.origin[k]) throw new Error(`capture origin ${k} is missing`);
    if (capture.origin[k] !== origin[k]) throw new Error(`capture ${k} is ${capture.origin[k]}, not ${origin[k]}: finalize where you captured`);
  }
}

/** The platform's run from a checked capture and the uninstall results. */
export function finalizeRun(capture, { claude, pi }) {
  for (const host of ["claude", "pi"]) {
    for (const s of [...CAPTURED, "installed_commit"]) {
      if (!["pass", "fail"].includes(capture[host]?.steps?.[s])) throw new Error(`capture ${host} step ${s} is missing`);
    }
  }
  const claudeSteps = { ...capture.claude.steps, ...claude };
  const piSteps = { ...capture.pi.steps, ...pi };
  return {
    platform: capture.platform, claude_code_version: capture.claude.version, date: capture.date, capture_id: capture.capture_id,
    plugins: capture.claude.plugins, steps: claudeSteps, result: result(claudeSteps),
    pi: {
      pi_version: capture.pi.version, installed_commit: capture.pi.installed_commit, extensions: capture.pi.extensions,
      steps: piSteps, result: result(piSteps),
    },
  };
}

/** A proof-shaped file holding `runs`; refuses an existing file for another candidate. */
function proofFor(existing, { version, sha }, runs, what) {
  if (existing && (existing.version !== version || existing.candidate_sha !== sha)) {
    throw new Error(`existing ${what} is for ${existing.version} at ${existing.candidate_sha}, not ${version} at ${sha}`);
  }
  return { version, tag: `v${version}`, candidate_sha: sha, runs };
}

/** Refuses any present run file for another candidate or platform; missing files are not checked here. */
export function checkRunFiles(runFiles, { version, sha }) {
  for (const platform of PLATFORMS) {
    const file = runFiles[platform];
    if (!file) continue;
    proofFor(file, { version, sha }, [], `${runPath(version, platform)}`);
    if (!Array.isArray(file.runs) || file.runs.length !== 1 || file.runs[0]?.platform !== platform) {
      throw new Error(`${runPath(version, platform)} must hold exactly one ${platform} run`);
    }
  }
}

/** The proof from each platform's run file, in PLATFORMS order; every platform is required. */
export function combineRuns(runFiles, { version, sha }) {
  checkRunFiles(runFiles, { version, sha });
  const missing = PLATFORMS.filter((p) => !runFiles[p]);
  if (missing.length) throw new Error(`no run file for ${missing.join(", ")}: copy ${missing.map((p) => runPath(version, p)).join(", ")} from that machine`);
  return proofFor(undefined, { version, sha }, PLATFORMS.map((p) => runFiles[p].runs[0]), "proof");
}

const arg = (argv, name) => {
  const k = argv.indexOf(`--${name}`);
  return k < 0 ? undefined : argv[k + 1];
};

const readJson = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined);
const writeJson = (file, value) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
};

const USAGE = `usage: capture|finalize --version X --sha <40 hex> --platform ${PLATFORMS.join("|")} --pi-repo owner/repo --claude <steps> --pi <steps>
       combine --version X --sha <40 hex>`;

/** Writes the combined proof from every platform's run file; reads no host. */
function combine(root, { version, sha }, log) {
  // 1. Identities, without mutation: the combined proof and every present run file must be for
  //    this candidate (and each run file for its own platform), or nothing is touched.
  const combinedFile = join(root, proofPath(version));
  proofFor(readJson(combinedFile), { version, sha }, [], "combined proof");
  const runFiles = Object.fromEntries(PLATFORMS.map((p) => [p, readJson(join(root, runPath(version, p)))]));
  checkRunFiles(runFiles, { version, sha });
  // 2. Invalidate the derived proof, so a refused combine leaves no earlier pass behind.
  rmSync(combinedFile, { force: true });
  // 3. Recombination checks.
  const pending = PLATFORMS.filter((p) => existsSync(join(root, capturePath(version, p))));
  if (pending.length) throw new Error(`a capture is pending for ${pending.join(", ")}: finalize it on its machine first`);
  const proof = combineRuns(runFiles, { version, sha });
  writeJson(join(root, proofPath(version)), proof);
  for (const r of proof.runs) log.log(`${r.platform}: capture ${r.capture_id} (Claude ${r.result}, Pi ${r.pi.result})`);
  log.log(`${proofPath(version)}: combined from ${PLATFORMS.map((p) => runPath(version, p)).join(", ")}. Check it with check-release-proof.mjs.`);
  return proof.runs.every((r) => r.result === "pass" && r.pi.result === "pass") ? 0 : 1;
}

export function main(argv, { env = process.env, root = process.cwd(), run = makeRunner(root), log = console } = {}) {
  try {
    const [command] = argv;
    const version = arg(argv, "version");
    const sha = arg(argv, "sha");
    if (!["capture", "finalize", "combine"].includes(command) || !version || !SHA40.test(String(sha))) throw new Error(USAGE);
    if (command === "combine") return combine(root, { version, sha }, log);

    const platform = arg(argv, "platform");
    const repo = arg(argv, "pi-repo");
    if (!PLATFORMS.includes(platform) || !/^[^/]+\/[^/]+$/.test(String(repo))) throw new Error(USAGE);
    const names = command === "capture" ? CAPTURED : FINALIZED;
    const steps = { claude: parseSteps(arg(argv, "claude"), names), pi: parseSteps(arg(argv, "pi"), names) };
    const marketplace = JSON.parse(readFileSync(join(root, ".claude-plugin/marketplace.json"), "utf8"));
    const plugins = promotedManifests(marketplace).map((p) => p.name);
    const configDir = resolve(env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude"));
    const agentDir = resolve(env.PI_CODING_AGENT_DIR || join(env.HOME || homedir(), ".pi", "agent"));
    const origin = { pi_repo: repo, claude_config_dir: configDir, pi_agent_dir: agentDir };
    const runFile = join(root, runPath(version, platform));
    const captureFile = join(root, capturePath(version, platform));
    // Checked first, so a run file for another candidate is refused before anything is written.
    proofFor(readJson(runFile), { version, sha }, [], "run file");
    // The combined proof is derived from the run files: any new capture or run makes it stale.
    const combinedFile = join(root, proofPath(version));
    proofFor(readJson(combinedFile), { version, sha }, [], "combined proof");

    if (command === "capture") {
      const pending = readJson(captureFile);
      if (pending && pending.candidate_sha !== sha) {
        throw new Error(`a pending capture is for ${pending.version} at ${pending.candidate_sha}, not ${sha}`);
      }
      // The request is valid: the combined proof, the earlier run file and the pending capture go
      // before any host is probed.
      rmSync(combinedFile, { force: true });
      rmSync(runFile, { force: true });
      rmSync(captureFile, { force: true });
      const versionOf = (cmd) => {
        const r = run(cmd, ["--version"]);
        if (r.code !== 0 || !r.stdout) throw new Error(`${cmd} --version failed`);
        return r.stdout.split("\n")[0].trim();
      };
      const capture = buildCapture({
        version, sha, platform, origin, plugins, date: new Date().toISOString().slice(0, 10),
        extensions: piExtensionNames(JSON.parse(readFileSync(join(root, "package.json"), "utf8"))),
        claude: { version: versionOf("claude"), installed: claudeInstalled(configDir, marketplace.name, plugins), steps: steps.claude },
        pi: { version: versionOf("pi"), installed: piInstalled(run, agentDir, repo), steps: steps.pi },
      });
      writeJson(captureFile, capture);
      const ok = [capture.claude, capture.pi].every((h) => Object.values(h.steps).every((v) => v === "pass"));
      log.log(`${capturePath(version, platform)}: captured ${capture.capture_id} (${ok ? "pass so far" : "fail"}); any earlier ${platform} run removed. Uninstall, then finalize.`);
      return ok ? 0 : 1;
    }

    // finalize: same candidate, platform and origin; the captured installs must be gone; the
    // capture's commits are used, not reread.
    const capture = readJson(captureFile);
    checkCapture(capture, { version, sha, platform, origin });
    // Identities checked: invalidate the derived proof before reading any host record.
    rmSync(combinedFile, { force: true });
    const left = [
      ...Object.keys(claudeInstalled(configDir, marketplace.name, plugins)).map((p) => `Claude plugin ${p}`),
      ...(existsSync(piClone(agentDir, repo)) ? [`Pi clone ${repo}`] : []),
    ];
    const claudeLeft = left.some((l) => l.startsWith("Claude"));
    const piLeft = left.some((l) => l.startsWith("Pi"));
    const runEntry = finalizeRun(capture, {
      claude: { uninstall: claudeLeft ? "fail" : steps.claude.uninstall },
      pi: { uninstall: piLeft ? "fail" : steps.pi.uninstall },
    });
    writeJson(runFile, proofFor(undefined, { version, sha }, [runEntry], "run file"));
    rmSync(captureFile);
    if (left.length) log.error(`still installed: ${left.join(", ")}`);
    log.log(`${runPath(version, platform)}: recorded from capture ${runEntry.capture_id} (Claude ${runEntry.result}, Pi ${runEntry.pi.result})`);
    return runEntry.result === "pass" && runEntry.pi.result === "pass" ? 0 : 1;
  } catch (e) {
    log.error(`e1a-record: ${e.message}`);
    return 2;
  }
}

if (import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = main(process.argv.slice(2));
