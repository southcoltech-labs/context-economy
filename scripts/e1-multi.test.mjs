// SPDX-License-Identifier: Apache-2.0

// The driver with several plugins (design: "E1 driver: several plugins, and checks the operator confirms by sight").
// Fixture proof modules only: a `call` plugin (the real tool-gateway module) and a `visual` plugin with an off switch.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { StopError, loadProofModules, main, resolveSteps } from "./e1-run.mjs";
import { e1aSteps } from "./e1-parts.mjs";
import toolGateway from "./proof/tool-gateway.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STAGING = "southcoltech-labs/context-economy";
const V = "0.2.0";
const SHA = "a".repeat(40);
const CAPTURE_ID = "11111111-2222-3333-4444-555555555555";

const visual = (host, say, expect) => ({ host, kind: "visual", say, expect });
/** A plugin that draws a band: visual evidence only, no ledger, with an off switch. */
const BAR = {
  name: "bar-plugin", hosts: ["claude", "pi"],
  behaviour: ["claude", "pi"].map((h) => visual(h, ["Type: /bar min"], ["a coloured bar above the prompt", "the bar shrank to one line"])),
  offSwitch: { env: { CE_BAR: "off" }, checks: ["claude", "pi"].map((h) => visual(h, [], ["the bar stays hidden the whole time"])) },
  uninstall: ["claude", "pi"].map((h) => visual(h, [], ["the bar stays hidden the whole time"])),
  dataLeft: [],
};
const MODULES = { "tool-gateway": toolGateway, "bar-plugin": BAR };

function proofDirOf(mods) {
  const dir = mkdtempSync(join(tmpdir(), "e1m-proof-"));
  for (const name of Object.keys(mods)) writeFileSync(join(dir, `${name}.mjs`), `export default ${JSON.stringify(mods[name])};\n`);
  return dir;
}

/** A temp HOME and clone, a marketplace of `plugins`, and fake commands and hosts for the E1a steps. */
function flow(over = {}) {
  const plugins = over.plugins ?? ["tool-gateway", "bar-plugin"];
  const home = mkdtempSync(join(tmpdir(), "e1m-home-"));
  const clone = mkdtempSync(join(tmpdir(), "e1m-clone-"));
  mkdirSync(join(clone, ".claude-plugin"));
  mkdirSync(join(clone, "docs", "release-proof"), { recursive: true });
  writeFileSync(join(clone, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "context-economy", plugins: plugins.map((name) => ({ name, source: `./plugins/${name}` })) }));
  writeFileSync(join(clone, "README.md"), "x\n\n**RTK 0.47.0.**\n\n```bash\necho install rtk\n```\n");
  copyFileSync(join(ROOT, ".gitleaks.toml"), join(clone, ".gitleaks.toml"));
  const f = { home, clone, execs: [], launches: [], said: [], asked: [], out: [], err: [], clock: Date.parse("2026-11-19T10:00:00Z"), ...over };
  const proof = (n) => join(clone, "docs", "release-proof", n);
  const installedFile = join(home, ".claude", "plugins", "installed_plugins.json");
  const piDir = join(home, ".pi", "agent", "git", "github.com", STAGING);
  const installed = () => (existsSync(installedFile) ? JSON.parse(readFileSync(installedFile, "utf8")).plugins : {});
  const setInstalled = (plugins2) => { mkdirSync(dirname(installedFile), { recursive: true }); writeFileSync(installedFile, JSON.stringify({ plugins: plugins2 })); };
  const row = (d) => { const file = join(home, ".claude", "context-economy", d, "s-1-0.jsonl"); mkdirSync(dirname(file), { recursive: true }); appendFileSync(file, `${JSON.stringify({ ts: new Date(f.clock + 1000).toISOString(), tool: "Bash", rewrite: "applied", is_error: false })}\n`); };
  f.row = row;
  f.exec = async (cmd, args, o) => {
    f.execs.push({ cmd, args, env: o.env, cwd: o.cwd });
    const ok = (out = "") => ({ code: 0, out });
    if (args[0] === "--version") return ok(cmd === "claude" ? "2.1.300 (Claude Code)\n" : "1.5.0\n");
    if (cmd === "git" && args[0] === "rev-parse") return ok(`${SHA}\n`);
    if (cmd === "git") return ok();
    if (cmd === "ls") return ok(`${readdirSync(proof("")).join("\n")}\n`);
    if (cmd === "bash") return ok(`rtk-aarch64-apple-darwin.tar.gz: OK\nrtk 0.47.0\nrtk.path: ${home}/.local/opt/rtk-0.47.0/rtk\n`);
    if (cmd === "claude" && args[1] === "marketplace") return ok("✔ Successfully added marketplace: context-economy (declared in user settings)\n");
    if (cmd === "claude" && args[1] === "install") { const n = args[2].split("@")[0]; setInstalled({ ...installed(), [`${n}@context-economy`]: [{ gitCommitSha: SHA }] }); return ok(`✔ Successfully installed plugin: ${args[2]} (scope: user)\n`); }
    if (cmd === "claude" && args[1] === "uninstall") { const next = installed(); delete next[args[2]]; setInstalled(next); return ok(`✔ Successfully uninstalled plugin: ${args[2].split("@")[0]} (scope: user)\n`); }
    if (cmd === "pi" && args[0] === "install") { mkdirSync(piDir, { recursive: true }); return ok(`Installed git:github.com/${STAGING}@v${V}\n`); }
    if (cmd === "pi" && args[0] === "remove") { rmSync(piDir, { recursive: true, force: true }); return ok(`Removed git:github.com/${STAGING}\n`); }
    if (cmd === "node" && args[1] === "capture") { f.capture = args; f.captureEnv = o.env; writeFileSync(proof(`${V}-macos-arm64.capture.json`), "{}"); return ok(`docs/release-proof/${V}-macos-arm64.capture.json: captured ${CAPTURE_ID} (pass so far); any earlier run removed. Uninstall, then finalize.\n`); }
    if (cmd === "node" && args[1] === "finalize") { f.finalize = args; rmSync(proof(`${V}-macos-arm64.capture.json`), { force: true }); writeFileSync(proof(`${V}-macos-arm64.json`), JSON.stringify({ runs: [{ platform: "macos-arm64", capture_id: CAPTURE_ID }] })); return ok(`docs/release-proof/${V}-macos-arm64.json: macos-arm64 recorded from capture ${CAPTURE_ID} (Claude pass, Pi pass)\n`); }
    return { code: 127, out: `fake: no such command ${cmd} ${args.join(" ")}\n` };
  };
  f.deps = {
    env: { HOME: home, PATH: "/usr/bin:/bin", TERM: "xterm", LANG: "C", USER: "u", SHELL: "/bin/zsh" },
    log: { log: (m) => f.out.push(m), error: (m) => f.err.push(m) }, exec: f.exec, runsDir: join(home, "e1-runs"),
    now: () => new Date(f.clock), signals: new EventEmitter(), hostname: "testbox", realHome: "/Users/nobody-real", managedSettings: [],
    proofDir: over.proofDir ?? proofDirOf(Object.fromEntries(plugins.map((n) => [n, MODULES[n]]))),
    runSync: () => ({ code: 0, stdout: `${SHA}\n`, stderr: "" }),
    ui: { tty: () => ({ stdin: true, stdout: true }), say: (l) => f.said.push(l), waitEnter: async () => {}, close: () => {},
      ask: async (q) => { f.asked.push(q); return (f.answer ?? ((x) => (/^Did you see/.test(x) ? "yes" : /^Describe/.test(x) ? "a coloured bar" : /result/i.test(x) ? (installed()["tool-gateway@context-economy"] ? "1" : "2") : /permission prompt/i.test(x) ? "no prompt" : "git status")))(q); } },
    launchHost: async (host, o) => {
      const n = f.launches.length;
      f.launches.push({ host, env: o.env });
      if (f.onLaunch) f.onLaunch(host, n);
      else if (installed()["tool-gateway@context-economy"]) f.row(host === "claude" ? "gateway-ledger" : "gateway-ledger-pi");
      f.clock += 5000;
      return { code: 0, signal: null };
    },
    ...over.deps,
  };
  f.run = () => main(["e1a", "--version", V, "--platform", "macos-arm64", "--clone", clone], f.deps);
  f.transcript = () => readFileSync(join(f.deps.runsDir, `${V}-macos-arm64`, "attempt-1", `${V}-macos-arm64.raw.txt`), "utf8");
  return f;
}
const arg = (args, name) => args[args.indexOf(name) + 1];

test("two plugins: one session per host per phase, an off-switch session per host, and the aggregate reaches the recorder", async () => {
  const f = flow();
  assert.equal(await f.run(), 0, `${f.err.join("\n")}\n${f.transcript().slice(-1500)}`);
  assert.deepEqual(f.launches.map((l) => l.host), ["claude", "pi", "claude", "pi", "claude", "pi"]);
  // both plugins installed and uninstalled, one argv line each; the installed check expects both
  const claude = f.execs.filter((e) => e.cmd === "claude" && e.args[0] === "plugin").map((e) => e.args.slice(1).join(" "));
  assert.deepEqual(claude.filter((a) => a.startsWith("install")), ["install tool-gateway@context-economy", "install bar-plugin@context-economy"]);
  assert.deepEqual(claude.filter((a) => a.startsWith("uninstall")), ["uninstall tool-gateway@context-economy", "uninstall bar-plugin@context-economy"]);
  const t = f.transcript();
  assert.match(t, new RegExp(`^claude tool-gateway: ${SHA}\\nclaude bar-plugin: ${SHA}\\npi: ${SHA}$`, "m"));
  assert.match(t, /^claude tool-gateway: not installed\nclaude bar-plugin: not installed$/m);
  assert.equal(arg(f.capture, "--claude"), "install=pass,behavior=pass");
  assert.equal(arg(f.capture, "--pi"), "install=pass,behavior=pass");
  assert.equal(arg(f.finalize, "--claude"), "uninstall=pass");
  assert.equal(arg(f.finalize, "--pi"), "uninstall=pass");
  // 6 host steps, each judged entry by entry: 2 + 2 + 2 + 2 + 2 + 2 per host = 12 checks
  assert.equal(t.trimEnd().split("\n").at(-1), "6 host steps (12 checks), 6 attested");
  assert.match(t, /\[planned E1a\.4a: claude tool-gateway call; claude bar-plugin visual\]/);
  assert.match(t, /\[planned E1a\.4s\.bar-plugin\.claude: claude tool-gateway call; claude bar-plugin visual\]/);
  assert.match(t, /\[evidence E1a\.4a \(claude, tool-gateway call\): attested pass\]/);
  assert.match(t, /\[evidence E1a\.4a \(claude, bar-plugin visual\): attested pass\]/);
  assert.match(t, /\[evidence E1a\.6c \(pi, bar-plugin visual\): attested pass\]/);
});
test("two plugins: the instructions are prefixed with the plugin name, in marketplace order, the closing line last", async () => {
  const f = flow();
  await f.run();
  const at = (id) => { const i = f.said.findIndex((l) => l.includes(`>>> ${id}:`)); return f.said.slice(i + 1, f.said.indexOf("", i + 1)).map((l) => l.trim()); };
  assert.deepEqual(at("E1a.4a"), ["Check the footer shows no 'auto mode' (Shift+Tab until it does not).", "tool-gateway: Type: Run git status", "Approve the permission prompt for the RTK path and `git status` (it shows the rewrite reached Claude Code).", "bar-plugin: Type: /bar min", "Then quit with /exit."]);
  assert.deepEqual(at("E1a.4s.bar-plugin.pi"), ["bar-plugin: ", "tool-gateway: Type: Run git status", "Then quit Pi."].filter((l) => l !== "bar-plugin: "));
});
test("the off-switch environment is in the off-switch launches only; the recorder and the next launches do not get it", async () => {
  const f = flow();
  await f.run();
  assert.deepEqual(f.launches.map((l) => l.env.CE_BAR), [undefined, undefined, "off", "off", undefined, undefined]);
  assert.equal(f.deps.env.CE_BAR, undefined);
  assert.equal(f.captureEnv.CE_BAR, undefined);
  assert.match(f.transcript(), /\[host env: CE_BAR=off\]/);
});
test("the other plugin's behaviour is judged in the off-switch session: no ledger row there fails the part", async () => {
  const f = flow();
  f.onLaunch = (host, n) => { if (n !== 2) f.row(host === "claude" ? "gateway-ledger" : "gateway-ledger-pi"); };
  assert.equal(await f.run(), 1);
  assert.match(f.err.join("\n"), /STOP at E1a\.4s\.bar-plugin\.claude/);
  assert.match(f.err.join("\n"), /tool-gateway call: .*expected 1 new ledger row, found 0/);
  assert.equal(f.capture, undefined);
});
test("a visual `no` fails the host step, names the plugin, and capture never runs", async () => {
  const f = flow();
  f.answer = (q) => (/^Did you see: a coloured/.test(q) ? "no" : /^Your answer to/.test(q) ? "confirm" : /^Did you see/.test(q) ? "yes" : /^Describe/.test(q) ? "x" : /result/i.test(q) ? "1" : /permission prompt/i.test(q) ? "no prompt" : "git status");
  assert.equal(await f.run(), 1);
  assert.match(f.err.join("\n"), /STOP at E1a\.4a/);
  assert.match(f.err.join("\n"), /bar-plugin visual: the operator did not see: a coloured bar above the prompt/);
  assert.equal(f.capture, undefined);
});
test("a call ledger miss with every visual `yes` still fails (the attestation never overrides the ledger); each failure is named", async () => {
  const f = flow();
  f.onLaunch = () => {};
  assert.equal(await f.run(), 1);
  assert.match(f.err.join("\n"), /STOP at E1a\.4a/);
  assert.match(f.err.join("\n"), /tool-gateway call: .*found 0/);
  assert.ok(!/bar-plugin visual:/.test(f.err.join("\n")));
});
test("a row in another plugin's ledger folder does not satisfy this plugin's call entry, and is itself a failure", async () => {
  const f = flow();
  f.onLaunch = (host, n) => { if (n === 0) f.row("gateway-ledger-pi"); else f.row(host === "claude" ? "gateway-ledger" : "gateway-ledger-pi"); };
  assert.equal(await f.run(), 1);
  assert.match(f.err.join("\n"), /tool-gateway call: .*expected 1 new ledger row, found 0/);
  assert.match(f.err.join("\n"), /unexpected ledger rows in \.claude\/context-economy\/gateway-ledger-pi: 1 new/);
});
test("a stray row in a folder nobody owns after the uninstall fails the uninstall session", async () => {
  const f = flow();
  f.onLaunch = (host, n) => { if (n < 4) f.row(host === "claude" ? "gateway-ledger" : "gateway-ledger-pi"); else if (n === 4) f.row("gateway-ledger-pi"); };
  assert.equal(await f.run(), 1);
  assert.match(f.err.join("\n"), /STOP at E1a\.6b/);
  assert.match(f.err.join("\n"), /unexpected ledger rows in \.claude\/context-economy\/gateway-ledger-pi/);
  assert.equal(f.finalize, undefined);
});
test("a visual-only marketplace: a row in a retained folder of a plugin no longer installed fails", async () => {
  const quiet = { name: "quiet", hosts: ["claude", "pi"], ledgerDirs: { claude: ".claude/context-economy/quiet-ledger", pi: ".claude/context-economy/quiet-ledger-pi" },
    behaviour: ["claude", "pi"].map((h) => visual(h, [], ["a quiet band"])), uninstall: ["claude", "pi"].map((h) => visual(h, [], ["the area above the prompt is empty"])), dataLeft: ["quiet-ledger", "quiet-ledger-pi"] };
  const f = flow({ plugins: ["quiet"], proofDir: proofDirOf({ quiet }) });
  f.onLaunch = (host, n) => { if (n === 1) f.row("quiet-ledger-pi"); };
  assert.equal(await f.run(), 1);
  assert.match(f.err.join("\n"), /unexpected ledger rows in \.claude\/context-economy\/quiet-ledger-pi/);
});

// --- the aggregate: capture's `behavior=` is formed from the assembled step list ---------------------------------------

test("the capture's behavior= is fail when a planned behaviour or off-switch step has no recorded pass; pass only when every one has", () => {
  const vars = { V, platform: "macos-arm64", staging: STAGING };
  const ctx = { proofs: [toolGateway, BAR], env: { HOME: "/h" }, vars, sha: SHA, hostResults: {}, step: { id: "E1a.5" } };
  ctx.steps = resolveSteps(ctx, e1aSteps(vars));
  const capture = ctx.steps.find((s) => s.id === "E1a.5");
  const behaviour = () => { const a = capture.run(ctx)[0]; return [arg(a, "--claude"), arg(a, "--pi")]; };
  const ids = ctx.steps.filter((s) => s.tag?.phase === "behaviour" || s.tag?.phase === "off-switch").map((s) => s.id);
  assert.deepEqual(ids, ["E1a.4a", "E1a.4b", "E1a.4s.bar-plugin.claude", "E1a.4s.bar-plugin.pi"]);
  for (const id of ids) ctx.hostResults[id] = { result: "pass" };
  assert.deepEqual(behaviour(), ["install=pass,behavior=pass", "install=pass,behavior=pass"]);
  delete ctx.hostResults["E1a.4s.bar-plugin.claude"];
  assert.deepEqual(behaviour(), ["install=pass,behavior=fail", "install=pass,behavior=pass"]);
  ctx.hostResults["E1a.4s.bar-plugin.claude"] = { result: "pass" };
  ctx.hostResults["E1a.4b"] = { result: "fail" };
  assert.deepEqual(behaviour(), ["install=pass,behavior=pass", "install=pass,behavior=fail"]);
});
test("a marketplace of tool-gateway alone has today's step list; with an off-switch plugin the off-switch steps sit before the capture", () => {
  const vars = { V, platform: "macos-arm64", staging: STAGING };
  const ids = (proofs) => { const ctx = { proofs }; return resolveSteps(ctx, e1aSteps(vars)).map((s) => s.id); };
  assert.deepEqual(ids([toolGateway]), ["E1a.0", "E1a.1", "E1a.2", "E1a.3", "E1a.4a", "E1a.4b", "E1a.4c", "E1a.5", "E1a.6a", "E1a.6b", "E1a.6c", "E1a.6d", "E1a.7"]);
  assert.deepEqual(ids([toolGateway, BAR]).slice(4, 10), ["E1a.4a", "E1a.4b", "E1a.4c", "E1a.4s.bar-plugin.claude", "E1a.4s.bar-plugin.pi", "E1a.5"]);
});

// --- the loader ---------------------------------------------------------------------------------------------------------

/** Loads modules by name from an injected import, so each malformed shape can be tried without a file for it. */
async function load(mods) {
  const dir = mkdtempSync(join(tmpdir(), "e1m-load-"));
  for (const name of Object.keys(mods)) writeFileSync(join(dir, `${name}.mjs`), "");
  return loadProofModules({ plugins: Object.keys(mods).map((name) => ({ name })) }, dir, async (file) => ({ default: mods[basename(file, ".mjs")] }));
}
const stops = (mods, re) => assert.rejects(load(mods), (e) => e instanceof StopError && re.test(`${e.expected} ${e.got}`));
const withBar = (edit) => { const m = structuredClone(BAR); edit(m); return { "bar-plugin": m }; };

test("loader: the version 1 tool-gateway module loads unchanged, and a listed plugin without a module still stops", async () => {
  const [m] = await load({ "tool-gateway": toolGateway });
  assert.equal(m.name, "tool-gateway");
  await assert.rejects(loadProofModules({ plugins: [{ name: "nothing-here" }] }, mkdtempSync(join(tmpdir(), "e1m-empty-"))), (e) => e instanceof StopError && /never skipped/.test(e.got));
  assert.equal((await load(MODULES)).length, 2);
});
test("loader: every new rule stops with the module named", async () => {
  await stops(withBar((m) => { m.behaviour[0].kind = "audio"; }), /bar-plugin.*unknown kind/);
  await stops(withBar((m) => { m.behaviour[0].colour = "red"; }), /bar-plugin.*unknown field colour/);
  await stops(withBar((m) => { m.behaviour[0].command = "x"; }), /bar-plugin.*visual entry and has `command`/);
  await stops(withBar((m) => { m.behaviour[0].ledger = { rows: 1 }; }), /bar-plugin.*has `ledger`/);
  await stops(withBar((m) => { m.behaviour[0] = { host: "claude", command: "x", result: 1, ledger: { rows: 1 } }; }), /bar-plugin.*no ledgerDirs entry/);
  await stops(withBar((m) => { m.behaviour[0].expect = []; }), /bar-plugin.*1 to 4 statements/);
  await stops(withBar((m) => { m.behaviour[0].expect = ["a bar?"]; }), /bar-plugin.*holds a `\?`/);
  await stops(withBar((m) => { m.behaviour[0].expect = ["x".repeat(101)]; }), /bar-plugin.*longer than 100/);
  await stops(withBar((m) => { m.behaviour[0].say = ["a", "b", "c", "d"]; }), /bar-plugin.*at most 3 lines/);
  await stops(withBar((m) => { m.offSwitch.env = { bar_off: "off" }; }), /bar-plugin.*env name/);
  await stops(withBar((m) => { m.offSwitch.env = { CE_BAR: "a-value-too-long-x" }; }), /bar-plugin.*at most 16 characters/);
  await stops(withBar((m) => { m.offSwitch.checks[0].host = "other"; }), /bar-plugin.*not one of the module's hosts/);
  await stops(withBar((m) => { m.behaviour = m.behaviour.filter((e) => e.host === "claude"); }), /bar-plugin.*behaviour has no entry for pi/);
  await stops(withBar((m) => { m.uninstall = m.uninstall.filter((e) => e.host === "claude"); }), /bar-plugin.*uninstall has no entry for pi/);
});
test("loader: an off switch that is declared but incomplete stops: empty checks, empty env, a host missing", async () => {
  await stops(withBar((m) => { m.offSwitch.checks = []; }), /bar-plugin.*no checks/);
  await stops(withBar((m) => { m.offSwitch.env = {}; }), /bar-plugin.*env has no variable/);
  await stops(withBar((m) => { m.offSwitch.checks = m.offSwitch.checks.filter((e) => e.host === "claude"); }), /bar-plugin.*offSwitch.checks has no entry for pi/);
  await stops(withBar((m) => { m.offSwitch.extra = 1; }), /bar-plugin.*unknown field extra/);
});
test("loader: ambiguous ledger ownership stops: a folder claimed by two modules, or two call entries for one host in one phase", async () => {
  const other = { ...structuredClone(toolGateway), name: "other-plugin" };
  await stops({ "tool-gateway": toolGateway, "other-plugin": other }, /other-plugin.*claimed by tool-gateway and other-plugin/);
  const twice = structuredClone(toolGateway);
  twice.behaviour.push({ ...twice.behaviour[0], command: "git log" });
  await stops({ "tool-gateway": twice }, /tool-gateway.*more than one call entry for claude/);
});
test("loader: a session that would carry more than 8 lines of instructions stops", async () => {
  const wordy = (name) => { const m = { ...structuredClone(BAR), name }; delete m.offSwitch; for (const e of m.behaviour) e.say = ["a", "b", "c"]; return m; };
  await stops({ "tool-gateway": toolGateway, "bar-one": wordy("bar-one"), "bar-two": wordy("bar-two"), "bar-three": wordy("bar-three") }, /more than 8/);
});

// --- the order of the Claude lines (the permission prompt comes right after the call's line) ------------------------------

test("Claude behaviour lines: the permission prompt follows the git status line, before a later visual plugin's lines; the uninstall lines keep their own order", () => {
  const vars = { V, platform: "macos-arm64", staging: STAGING };
  const ctx = { proofs: [toolGateway, BAR], env: { HOME: "/h" }, vars, sha: SHA, hostResults: {}, step: { id: "E1a.4a" } };
  ctx.steps = resolveSteps(ctx, e1aSteps(vars));
  const say = (id) => ctx.steps.find((s) => s.id === id).human(ctx).say;
  const prompt = "Approve the permission prompt for the RTK path and `git status` (it shows the rewrite reached Claude Code).";
  assert.deepEqual(say("E1a.4a"), ["Check the footer shows no 'auto mode' (Shift+Tab until it does not).", "tool-gateway: Type: Run git status", prompt, "bar-plugin: Type: /bar min", "Then quit with /exit."]);
  const un = ctx.steps.find((s) => s.tag?.phase === "uninstall" && s.tag?.host === "claude").human(ctx).say;
  assert.equal(un[0], "Check the footer shows no 'auto mode' (Shift+Tab until it does not).");
  assert.ok(un.indexOf("tool-gateway: Type: Run git status") < un.indexOf("Approve the permission prompt for `git status`."));
  assert.ok(un.indexOf("Approve the permission prompt for `git status`.") < un.indexOf("Expect Git's own `On branch main ...` output, with no RTK path."));
  assert.equal(un.at(-1), "Then quit with /exit.");
});

test("Claude behaviour lines with a visual plugin listed before the call plugin: the permission prompt still follows the git status line", () => {
  const vars = { V, platform: "macos-arm64", staging: STAGING };
  const ctx = { proofs: [BAR, toolGateway], env: { HOME: "/h" }, vars, sha: SHA, hostResults: {}, step: { id: "E1a.4a" } };
  ctx.steps = resolveSteps(ctx, e1aSteps(vars));
  const s = ctx.steps.find((x) => x.tag?.phase === "behaviour" && x.tag?.host === "claude").human(ctx).say;
  const prompt = "Approve the permission prompt for the RTK path and `git status` (it shows the rewrite reached Claude Code).";
  assert.deepEqual(s, ["Check the footer shows no 'auto mode' (Shift+Tab until it does not).", "bar-plugin: Type: /bar min", "tool-gateway: Type: Run git status", prompt, "Then quit with /exit."]);
});
