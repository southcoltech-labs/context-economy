// SPDX-License-Identifier: Apache-2.0

// Step data tests (piece 3). The replay test feeds the published E1a `0.1.2` transcript to the E1a
// steps' assertions: only the public file is used, never a private raw transcript.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { validateSteps } from "./e1-run.mjs";
import { e1aSteps } from "./e1-parts.mjs";
import toolGateway from "./proof/tool-gateway.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STAGING = "southcoltech-labs/context-economy";
// The published 0.1.2 output was recorded under the repository's old name; the replays use it.
const REPLAY_STAGING = "southcoltech-labs/context-economy-preview";
const PUBLISHED = readFileSync(join(ROOT, "docs", "release-proof", "0.1.2.md"), "utf8");
const SHA = "b72867fd12ae562577f9bf96bcc0ee85362c1a33";

/** The first fenced block under `### heading` inside `## platform` of the published transcript. */
function section(platformHeading, heading) {
  const from = PUBLISHED.indexOf(`## ${platformHeading}\n`);
  assert.ok(from >= 0, `no section ${platformHeading}`);
  const next = PUBLISHED.indexOf("\n## ", from + 1);
  const body = PUBLISHED.slice(from, next < 0 ? undefined : next);
  const at = body.indexOf(`\n### ${heading}\n`);
  if (at < 0) return undefined;
  const open = body.indexOf("```\n", at) + 4;
  return body.slice(open, body.indexOf("\n```", open));
}

// Step id → the published section that holds its output. Every other step is "not replay-checked".
const REPLAY = {
  "E1a.0": "Helper files and clean check (b)",
  "E1a.1": "Inputs and the clone",
  "E1a.2": "1. Install RTK and write `config.json`",
  "E1a.3": "2. Install the candidate",
  "E1a.4c": "3. Behaviour",
  "E1a.5": "4. Capture",
  "E1a.6a": "5. Uninstall and check",
  "E1a.6d": "5. Uninstall and check",
  "E1a.7": "6. Finalize",
};
const PLATFORMS = [
  { platform: "macos-arm64", heading: "macOS arm64", home: "/Users/e1b2" },
  { platform: "linux-x86_64", heading: "Linux x86_64", home: "/home/e1b2" },
];
const ctxFor = (p) => ({ env: { HOME: p.home }, sha: SHA, vars: { V: "0.1.2", platform: p.platform, staging: REPLAY_STAGING }, proofs: [toolGateway], step: { id: "replay" } });

/** Applies a step's `match` and `notMatch` assertions to recorded text. Returns the list of failures. */
function replay(step, text, ctx) {
  const failures = [];
  for (const a of step.expect ?? []) {
    if (a.match instanceof RegExp && !a.match.test(text)) failures.push(`${step.id}: ${a.match} not found`);
    if (typeof a.match === "function") {
      const r = a.match(text, ctx);
      if (!(typeof r === "object" ? r.ok : r)) failures.push(`${step.id} (${a.describe ?? "match"}): ${typeof r === "object" ? r.got : "false"}`);
    }
    if (a.notMatch instanceof RegExp && a.notMatch.test(text)) failures.push(`${step.id}: ${a.notMatch} found`);
  }
  return failures;
}

test("the E1a step data passes up-front validation, with unique ids", () => {
  validateSteps(e1aSteps({ V: "0.1.3", platform: "macos-arm64", staging: STAGING }));
});

for (const p of PLATFORMS) {
  test(`replay: the published ${p.heading} output passes the steps' assertions`, () => {
    const steps = e1aSteps({ V: "0.1.2", platform: p.platform, staging: REPLAY_STAGING });
    const ctx = ctxFor(p);
    const replayed = [];
    for (const [id, heading] of Object.entries(REPLAY)) {
      const step = steps.find((s) => s.id === id);
      assert.ok(step, `no step ${id}`);
      const text = section(p.heading, heading);
      assert.ok(text, `the published file has no "${heading}" under ${p.heading}`);
      const failures = replay(step, text, ctx);
      assert.deepEqual(failures, [], `${id} on ${p.heading}`);
      replayed.push(id);
    }
    assert.equal(replayed.length, Object.keys(REPLAY).length);
  });
}

test("replay: a changed published output fails the assertion (the replay is not vacuous)", () => {
  const steps = e1aSteps({ V: "0.1.2", platform: "macos-arm64", staging: REPLAY_STAGING });
  const ctx = ctxFor(PLATFORMS[0]);
  const text = (id) => section("macOS arm64", REPLAY[id]);
  const step = (id) => steps.find((s) => s.id === id);
  assert.notDeepEqual(replay(step("E1a.3"), text("E1a.3").replace(SHA, "0".repeat(40)), ctx), []);
  assert.notDeepEqual(replay(step("E1a.3"), text("E1a.3").replace("installed check: OK", ""), ctx), []);
  assert.notDeepEqual(replay(step("E1a.2"), text("E1a.2").replace("rtk 0.47.0", "rtk 0.46.0"), ctx), []);
  assert.notDeepEqual(replay(step("E1a.2"), text("E1a.2").replaceAll("/Users/e1b2", "/Users/other"), ctx), []);
  assert.notDeepEqual(replay(step("E1a.1"), `${text("E1a.1")}\n0.1.2.json`, ctx), []);
  assert.notDeepEqual(replay(step("E1a.4c"), text("E1a.4c").replace("gateway-ledger-pi: 1 rows", "gateway-ledger-pi: 0 rows"), ctx), []);
  assert.notDeepEqual(replay(step("E1a.6a"), text("E1a.6a").replace("pi: not installed", "pi: 1234"), ctx), []);
  assert.notDeepEqual(replay(step("E1a.6d"), "config.json\n", ctx), []);
  assert.notDeepEqual(replay(step("E1a.5"), text("E1a.5").replace("captured", "refused"), ctx), []);
  assert.notDeepEqual(replay(step("E1a.7"), text("E1a.7").replace("recorded from capture", "x"), ctx), []);
  assert.notDeepEqual(replay(step("E1a.0"), "clean check (b): ERROR", ctx), []);
});

test("every human step has the evidence of its proof module entry; the steps not replay-checked are the human steps", () => {
  const steps = e1aSteps({ V: "0.1.3", platform: "macos-arm64", staging: STAGING });
  const ctx = { proofs: [toolGateway], step: { id: "x" } };
  const human = steps.filter((s) => s.human);
  assert.deepEqual(human.map((s) => s.id), ["E1a.4a", "E1a.4b", "E1a.6b", "E1a.6c"]);
  for (const s of human) {
    const h = s.human(ctx);
    assert.equal(h.evidence.command, "git status");
    assert.match(h.evidence.ledgerDir, /^\.claude\/context-economy\/gateway-ledger/);
  }
  assert.deepEqual(steps.filter((s) => !s.human && !REPLAY[s.id]).map((s) => s.id), []);
});

// --- the whole E1a part against fake commands and fake hosts ---------------------------------------

import { EventEmitter } from "node:events";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { main } from "./e1-run.mjs";

const V = "0.1.3";
const FAKE_SHA = "a".repeat(40);
const CAPTURE_ID = "11111111-2222-3333-4444-555555555555";

/** A temp HOME and clone, and fake commands that behave like the real ones for the E1a steps. */
function flow(over = {}) {
  const home = mkdtempSync(join(tmpdir(), "e1p-home-"));
  const clone = mkdtempSync(join(tmpdir(), "e1p-clone-"));
  mkdirSync(join(clone, ".claude-plugin"));
  mkdirSync(join(clone, "docs", "release-proof"), { recursive: true });
  writeFileSync(join(clone, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "context-economy", plugins: [{ name: "tool-gateway", source: "./plugins/tool-gateway" }] }));
  writeFileSync(join(clone, "README.md"), "x\n\n**RTK 0.47.0.**\n\n```bash\necho install rtk\n```\n");
  copyFileSync(join(ROOT, ".gitleaks.toml"), join(clone, ".gitleaks.toml"));
  const f = { home, clone, execs: [], hosts: [], out: [], err: [], clock: Date.parse("2026-11-14T10:00:00Z"), tagSha: FAKE_SHA, headSha: FAKE_SHA, piSha: FAKE_SHA, writeRow: true, ...over };
  const proof = (n) => join(clone, "docs", "release-proof", n);
  const installedFile = join(home, ".claude", "plugins", "installed_plugins.json");
  const piDir = join(home, ".pi", "agent", "git", "github.com", STAGING);
  const ledgerFile = (d) => join(home, ".claude", "context-economy", d, "s-1-0.jsonl");
  f.exec = async (cmd, args, o) => {
    f.execs.push({ cmd, args, cwd: o.cwd });
    const ok = (out = "") => ({ code: 0, out });
    if (args[0] === "--version") return ok(cmd === "claude" ? "2.1.300 (Claude Code)\n" : "1.5.0\n");
    if (cmd === "git" && args[0] === "rev-parse") return ok(`${args[1] === "HEAD" ? f.headSha : f.tagSha}\n`);
    if (cmd === "git") return ok();
    if (cmd === "ls") return ok(`${readdirSync(proof("")).join("\n")}\n`);
    if (cmd === "bash") return ok(`rtk-aarch64-apple-darwin.tar.gz: OK\nrtk 0.47.0\nrtk.path: ${home}/.local/opt/rtk-0.47.0/rtk\n`);
    if (cmd === "claude" && args[1] === "marketplace") return ok("✔ Successfully added marketplace: context-economy (declared in user settings)\n");
    if (cmd === "claude" && args[1] === "install") {
      mkdirSync(dirname(installedFile), { recursive: true });
      writeFileSync(installedFile, JSON.stringify({ plugins: { "tool-gateway@context-economy": [{ gitCommitSha: FAKE_SHA }] } }));
      return ok("✔ Successfully installed plugin: tool-gateway@context-economy (scope: user)\n");
    }
    if (cmd === "claude" && args[1] === "uninstall") { writeFileSync(installedFile, JSON.stringify({ plugins: {} })); return ok("✔ Successfully uninstalled plugin: tool-gateway (scope: user)\n"); }
    if (cmd === "pi" && args[0] === "install") { mkdirSync(piDir, { recursive: true }); return ok(`Installed git:github.com/${STAGING}@v${V}\n`); }
    if (cmd === "pi" && args[0] === "remove") { rmSync(piDir, { recursive: true, force: true }); return ok(`Removed git:github.com/${STAGING}\n`); }
    if (cmd === "node" && args[1] === "capture") {
      f.capture = args;
      writeFileSync(proof(`${V}-macos-arm64.capture.json`), "{}");
      return ok(`docs/release-proof/${V}-macos-arm64.capture.json: captured ${CAPTURE_ID} (pass so far); any earlier macos-arm64 run removed. Uninstall, then finalize.\n`);
    }
    if (cmd === "node" && args[1] === "finalize") {
      f.finalize = args;
      rmSync(proof(`${V}-macos-arm64.capture.json`), { force: true });
      writeFileSync(proof(`${V}-macos-arm64.json`), JSON.stringify({ runs: [{ platform: "macos-arm64", capture_id: CAPTURE_ID }] }));
      return ok(`docs/release-proof/${V}-macos-arm64.json: macos-arm64 recorded from capture ${CAPTURE_ID} (Claude pass, Pi pass)\n`);
    }
    return { code: 127, out: `fake: no such command ${cmd} ${args.join(" ")}\n` };
  };
  f.deps = {
    env: { HOME: home, PATH: "/usr/bin:/bin", TERM: "xterm", LANG: "C", USER: "u", SHELL: "/bin/zsh" },
    log: { log: (m) => f.out.push(m), error: (m) => f.err.push(m) }, exec: f.exec, runsDir: join(home, "e1-runs"),
    now: () => new Date(f.clock), signals: new EventEmitter(), hostname: "testbox", realHome: "/Users/nobody-real", managedSettings: [],
    runSync: () => ({ code: 0, stdout: `${f.piSha}\n`, stderr: "" }),
    ui: { tty: () => ({ stdin: true, stdout: true }), say: () => {}, waitEnter: async () => {}, close: () => {},
      ask: async (q) => (/result/i.test(q) ? (existsSync(installedFile) && JSON.parse(readFileSync(installedFile, "utf8")).plugins["tool-gateway@context-economy"] ? "1" : "2") : /permission prompt/i.test(q) ? "no prompt" : "git status") },
    launchHost: async (host) => {
      f.hosts.push(host);
      const installedNow = existsSync(installedFile) && JSON.parse(readFileSync(installedFile, "utf8")).plugins["tool-gateway@context-economy"];
      if (installedNow && f.writeRow) {
        const dir = ledgerFile(host === "claude" ? "gateway-ledger" : "gateway-ledger-pi");
        mkdirSync(dirname(dir), { recursive: true });
        appendFileSync(dir, JSON.stringify({ ts: new Date(f.clock + 1000).toISOString(), tool: "Bash", rewrite: "applied", is_error: false }) + "\n");
      }
      f.clock += 5000;
      return { code: 0, signal: null };
    },
    ...over.deps,
  };
  f.run = () => main(["e1a", "--version", V, "--platform", "macos-arm64", "--clone", clone], f.deps);
  f.transcript = () => readFileSync(join(f.deps.runsDir, `${V}-macos-arm64`, "attempt-1", `${V}-macos-arm64.raw.txt`), "utf8");
  return f;
}

test("the whole E1a part passes against fake commands: capture and finalize carry the derived results", async () => {
  const f = flow();
  const code = await f.run();
  assert.equal(code, 0, `${f.err.join("\n")}\n${f.transcript?.().slice(-1500)}`);
  assert.deepEqual(f.hosts, ["claude", "pi", "claude", "pi"]);
  const arg = (args, name) => args[args.indexOf(name) + 1];
  assert.equal(arg(f.capture, "--sha"), FAKE_SHA);
  assert.equal(arg(f.capture, "--claude"), "install=pass,behavior=pass");
  assert.equal(arg(f.capture, "--pi"), "install=pass,behavior=pass");
  assert.equal(arg(f.finalize, "--claude"), "uninstall=pass");
  assert.equal(arg(f.finalize, "--pi-repo"), STAGING);
  assert.equal(f.capture[0], join(ROOT, "scripts", "e1a-record.mjs"));
  assert.ok(f.execs.filter((e) => e.cmd === "node").every((e) => e.cwd === f.clone));
  const t = f.transcript();
  assert.match(t, /4 host steps, 4 attested/);
  for (const id of ["E1a.0", "E1a.1", "E1a.2", "E1a.3", "E1a.4a", "E1a.4b", "E1a.4c", "E1a.5", "E1a.6a", "E1a.6b", "E1a.6c", "E1a.6d", "E1a.7"]) assert.match(t, new RegExp(`=== ${id.replace(".", "\\.")} `));
  assert.ok(existsSync(join(f.deps.runsDir, `${V}-macos-arm64`, "attempt-1", `${V}-macos-arm64.json`)), "the run file is copied into the attempt folder");
});

test("a tag that is not HEAD of main stops at E1a.1; nothing is installed and no host runs", async () => {
  const f = flow({ headSha: "b".repeat(40) });
  assert.equal(await f.run(), 1);
  assert.match(f.err.join("\n"), /STOP at E1a\.1/);
  assert.deepEqual(f.hosts, []);
  assert.ok(!f.execs.some((e) => e.cmd === "claude" && e.args[0] === "plugin"));
});

test("a Pi clone at another commit stops at E1a.3; no host runs", async () => {
  const f = flow({ piSha: "c".repeat(40) });
  assert.equal(await f.run(), 1);
  assert.match(f.err.join("\n"), /STOP at E1a\.3/);
  assert.deepEqual(f.hosts, []);
});

test("a behaviour step that left no ledger row stops at E1a.4a, and capture never runs", async () => {
  const f = flow({ writeRow: false });
  assert.equal(await f.run(), 1);
  assert.match(f.err.join("\n"), /STOP at E1a\.4a/);
  assert.deepEqual(f.hosts, ["claude"]);
  assert.equal(f.capture, undefined);
});

test("a proof file for this version already in the clone stops at E1a.1", async () => {
  const f = flow();
  writeFileSync(join(f.clone, "docs", "release-proof", `${V}.json`), "{}");
  assert.equal(await f.run(), 1);
  assert.match(f.err.join("\n"), /STOP at E1a\.1/);
});

test("S4 E1a.7: a capture file left after finalize stops at E1a.7", async () => {
  const f = flow();
  const real = f.exec;
  f.deps.exec = async (cmd, args, o) => {
    const r = await real(cmd, args, o);
    if (cmd === "node" && args[1] === "finalize") writeFileSync(join(f.clone, "docs", "release-proof", `${V}-macos-arm64.capture.json`), "{}");
    return r;
  };
  assert.equal(await f.run(), 1);
  assert.match(f.err.join("\n"), /STOP at E1a\.7/);
});
