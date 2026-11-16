// SPDX-License-Identifier: Apache-2.0

// E1b step data tests (piece 3): each part is validated, then run whole against a fake world (temp
// HOME and clone, fake git/claude/pi, the real `e1b-data.mjs`). E1b is not replay-checked: the
// published proof is an E1a transcript, and no E1b output is published.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { StopError, main, validateSteps } from "./e1-run.mjs";
import { baselineSteps, parts } from "./e1-parts.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STAGING = "southcoltech-labs/context-economy-preview";
const A = "0.1.2", B = "0.1.3";
const SHA_A = "a".repeat(40), SHA_B = "b".repeat(40);
const DRILL = "drill-1";
const R = { release: "release" };

function world(over = {}) {
  const home = mkdtempSync(join(tmpdir(), "e1b-home-"));
  const clone = mkdtempSync(join(tmpdir(), "e1b-clone-"));
  mkdirSync(join(clone, ".claude-plugin"));
  writeFileSync(join(clone, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "context-economy", plugins: [{ name: "tool-gateway", source: "./plugins/tool-gateway" }] }));
  writeFileSync(join(clone, "README.md"), "x\n\n**RTK 0.47.0.**\n\n```bash\necho install rtk\n```\n");
  copyFileSync(join(ROOT, ".gitleaks.toml"), join(clone, ".gitleaks.toml"));
  const w = { home, clone, hosts: [], out: [], err: [], execs: [], clock: Date.parse("2026-11-14T10:00:00Z"),
    release: SHA_A, mainVersion: B, releaseVersion: A, bTagged: false, promotedB: SHA_B, updateOffersB: false, installedSha: undefined, ...over };
  const installedFile = join(home, ".claude", "plugins", "installed_plugins.json");
  const piDir = join(home, ".pi", "agent", "git", "github.com", STAGING);
  const setInstalled = (sha) => {
    mkdirSync(dirname(installedFile), { recursive: true });
    writeFileSync(installedFile, JSON.stringify({ plugins: sha ? { "tool-gateway@context-economy": [{ gitCommitSha: sha }] } : {} }));
    w.installedSha = sha;
    if (sha) mkdirSync(piDir, { recursive: true });
  };
  const shaOf = (ref) => (ref === "release" ? w.release : ref === `promoted-v${A}` ? SHA_A : SHA_B);
  const rev = (name) => ({
    [`promoted-v${A}^{commit}`]: SHA_A, "origin/release": w.release, [`v${B}^{commit}`]: w.tagB ?? SHA_B, "origin/main": w.mainSha ?? SHA_B, [`promoted-v${B}^{commit}`]: w.promotedB,
  })[name];
  w.exec = async (cmd, args, o) => {
    w.execs.push({ cmd, args, cwd: o.cwd });
    const ok = (out = "") => ({ code: 0, out });
    if (args[0] === "--version") return ok(cmd === "claude" ? "2.1.300 (Claude Code)\n" : "1.5.0\n");
    if (cmd === "git" && args[0] === "rev-parse") return ok(`${args.slice(1).map(rev).join("\n")}\n`);
    if (cmd === "git" && args[0] === "ls-remote") return ok(w.bTagged ? `${SHA_B}\trefs/tags/v${B}\n` : "");
    if (cmd === "git" && args[0] === "show") {
      const [ref, file] = args[1].split(":");
      const version = w.fileVersion?.[args[1]] ?? (ref === "origin/main" ? w.mainVersion : w.releaseVersion);
      return ok(`{\n  "name": "x",\n  "version": "${version}"\n}\n`);
    }
    if (cmd === "git") return ok();
    if (cmd === "bash") { w.onBash?.(); }
    if (cmd === "bash") return ok(`rtk-aarch64-apple-darwin.tar.gz: OK\nrtk 0.47.0\nrtk.path: ${home}/.local/opt/rtk-0.47.0/rtk\n`);
    if (cmd === "claude" && args[1] === "marketplace" && args[2] === "add") { w.ref = args[3].split("#")[1]; return ok("✔ Successfully added marketplace: context-economy (declared in user settings)\n"); }
    if (cmd === "claude" && args[1] === "marketplace") return ok(args[2] === "remove" ? "✔ Removed\n" : "✔ Updated 1 marketplace\n");
    if (cmd === "claude" && args[1] === "install") { setInstalled(shaOf(w.ref)); return ok("✔ Successfully installed plugin: tool-gateway@context-economy (scope: user)\n"); }
    if (cmd === "claude" && args[1] === "update") { if (w.ref === "release") setInstalled(w.release); return ok(w.updateOffersB ? `Update available: ${B}\n` : "✔ tool-gateway is already up to date\n"); }
    if (cmd === "claude" && args[1] === "uninstall") { setInstalled(undefined); rmSync(piDir, { recursive: true, force: true }); return ok("✔ Successfully uninstalled plugin: tool-gateway (scope: user)\n"); }
    if (cmd === "pi" && args[0] === "install") { mkdirSync(piDir, { recursive: true }); return ok(`Installed git:github.com/${STAGING}@${args[1].split("@")[1]}\n`); }
    if (cmd === "pi" && args[0] === "update") return ok("Updated extensions\n");
    if (cmd === "pi" && args[0] === "remove") { rmSync(piDir, { recursive: true, force: true }); return ok(`Removed git:github.com/${STAGING}\n`); }
    if (cmd === "node" && /e1b-data\.mjs$/.test(args[0])) {
      const r = spawnSync(cmd, args, { encoding: "utf8", env: { ...process.env, HOME: home } });
      return { code: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
    }
    return { code: 127, out: `fake: no such command ${cmd} ${args.join(" ")}\n` };
  };
  w.deps = {
    env: { HOME: home, PATH: "/usr/bin:/bin", TERM: "xterm", LANG: "C", USER: "u", SHELL: "/bin/zsh" },
    log: { log: (m) => w.out.push(m), error: (m) => w.err.push(m) }, exec: w.exec, runsDir: join(home, "e1-runs"),
    now: () => new Date(w.clock), signals: new EventEmitter(), hostname: "testbox", realHome: "/Users/nobody-real", managedSettings: [],
    runSync: () => ({ code: 0, stdout: `${w.installedSha ?? ""}\n`, stderr: "" }),
    ui: { tty: () => ({ stdin: true, stdout: true }), say: () => {}, waitEnter: async () => {}, close: () => {},
      ask: async (q) => (/result/i.test(q) ? (w.installedSha ? "1" : "2") : /permission prompt/i.test(q) ? "no prompt" : "git status") },
    launchHost: async (host) => {
      w.hosts.push(host);
      if ((w.installedSha || w.rowAlways) && !w.noRow) {
        const file = join(home, ".claude", "context-economy", host === "claude" ? "gateway-ledger" : "gateway-ledger-pi", `s-${w.hosts.length}-0.jsonl`);
        mkdirSync(dirname(file), { recursive: true });
        appendFileSync(file, JSON.stringify({ ts: new Date(w.clock + 1000).toISOString(), tool: "Bash", rewrite: "applied", is_error: false }) + "\n");
      }
      w.clock += 5000;
      return { code: 0, signal: null };
    },
    ...over.deps,
  };
  w.part = (name, extra = []) => main(["e1b", "--part", name, "--drill", DRILL, "--a", A, ...extra, "--clone", clone], w.deps);
  w.transcript = (n = 1) => readFileSync(join(w.deps.runsDir, DRILL, `attempt-${n}`, `e1b-2026-11-14.raw.txt`), "utf8");
  w.state = () => JSON.parse(readFileSync(join(w.deps.runsDir, DRILL, "drill-state.json"), "utf8"));
  return w;
}

const dieWith = (w) => `${w.err.join("\n")}`;

test("each E1b part builds valid step data with unique ids", () => {
  const vars = { part: "x", a: A, b: B, V: undefined, platform: undefined, staging: STAGING };
  for (const [name, build] of Object.entries(parts.e1b)) {
    const steps = build({ ...vars, part: name });
    assert.ok(steps.length > 0, name);
    assert.doesNotThrow(() => validateSteps(steps), name);
  }
});

test("a part with a missing or malformed version is refused before anything runs", async () => {
  const w = world();
  assert.equal(await main(["e1b", "--part", "baseline", "--clone", w.clone], w.deps), 2);
  assert.match(dieWith(w), /needs --a <version>/);
  w.err.length = 0;
  assert.equal(await main(["e1b", "--part", "undelivered", "--drill", DRILL, "--a", A, "--b", "latest", "--clone", w.clone], w.deps), 2);
  assert.match(dieWith(w), /needs --b <version>/);
  assert.equal(w.hosts.length, 0);
});

async function baseline(w) {
  const code = await w.part("baseline");
  assert.equal(code, 0, `${dieWith(w)}\n${w.transcript().slice(-1500)}`);
}

test("baseline: A installed from release, both hosts rewrite, the snapshot and the state are recorded", async () => {
  const w = world();
  await baseline(w);
  assert.deepEqual(w.hosts, ["claude", "pi"]);
  assert.equal(w.state().shaA, SHA_A);
  assert.ok(w.state().ledgerFiles >= 2);
  assert.ok(existsSync(w.state().snapshot));
  assert.ok(w.execs.some((e) => e.cmd === "claude" && e.args.includes(`${STAGING}#release`)));
  assert.match(w.transcript(), /2 host steps, 2 attested/);
});

test("baseline: promoted-v<A> that is not origin/release stops at A.1", async () => {
  const w = world({ release: "c".repeat(40) });
  assert.equal(await w.part("baseline"), 1);
  assert.match(dieWith(w), /STOP at A\.1/);
  assert.equal(w.hosts.length, 0);
});

test("baseline: a tag for B that already exists stops at A.1 (B must not be tagged yet)", async () => {
  const w = world({ bTagged: true });
  assert.equal(await w.part("baseline", ["--b", B]), 1);
  assert.match(dieWith(w), /STOP at A\.1/);
});

test("baseline: an installed commit that is not A's stops at A.3; no host runs", async () => {
  const w = world();
  const real = w.deps.runSync;
  w.deps.runSync = () => ({ code: 0, stdout: `${"d".repeat(40)}\n`, stderr: "" });
  assert.equal(await w.part("baseline"), 1);
  assert.match(dieWith(w), /STOP at A\.3/);
  assert.equal(w.hosts.length, 0);
  void real;
});

test("baseline: no ledger row after the behaviour step stops at A.4a", async () => {
  const w = world({ noRow: true });
  assert.equal(await w.part("baseline"), 1);
  assert.match(dieWith(w), /STOP at A\.4/);
});

test("a part after the baseline without its recorded values stops with a message naming the missing key", async () => {
  const w = world();
  await baseline(w);
  rmSync(join(w.deps.runsDir, DRILL, "drill-state.json"));
  assert.equal(await w.part("cycle", ["--b", B]), 1);
  assert.match(dieWith(w), /recorded by an earlier part/);
});

test("undelivered: B on main, A on release, and the update leaves A installed", async () => {
  const w = world();
  await baseline(w);
  assert.equal(await w.part("undelivered", ["--b", B]), 0, `${dieWith(w)}\n${w.transcript(2).slice(-1500)}`);
  assert.equal(w.state().shaB, SHA_B);
  assert.equal(w.hosts.length, 2, "no host step in this part");
});

test("undelivered: an update that offers B stops at B.2", async () => {
  const w = world();
  await baseline(w);
  w.updateOffersB = true;
  assert.equal(await w.part("undelivered", ["--b", B]), 1);
  assert.match(dieWith(w), /STOP at B\.2/);
});

test("undelivered: release already at B's version stops at B.1", async () => {
  const w = world();
  await baseline(w);
  w.releaseVersion = B;
  assert.equal(await w.part("undelivered", ["--b", B]), 1);
  assert.match(dieWith(w), /STOP at B\.1/);
});

test("promoted: promoted-v<B>, origin/release and v<B> must be one commit", async () => {
  const w = world();
  await baseline(w);
  w.release = SHA_B;
  assert.equal(await w.part("promoted", ["--b", B]), 0, `${dieWith(w)}`);
  const bad = world({ release: SHA_A });
  await baseline(bad);
  assert.equal(await bad.part("promoted", ["--b", B]), 1);
  assert.match(dieWith(bad), /STOP at E\.6/);
});

async function toPromoted(w) {
  await baseline(w);
  assert.equal(await w.part("undelivered", ["--b", B]), 0, dieWith(w));
  w.release = SHA_B; w.releaseVersion = B;
  assert.equal(await w.part("promoted", ["--b", B]), 0, dieWith(w));
}

test("cycle: update to B, roll back to A, the pinned tag stays, return to release, uninstall; data survives each step", async () => {
  const w = world();
  await toPromoted(w);
  const before = w.hosts.length;
  const code = await w.part("cycle", ["--b", B]);
  assert.equal(code, 0, `${dieWith(w)}\n${w.transcript(4).slice(-2000)}`);
  assert.equal(w.hosts.length - before, 8, "two hosts for each of the three still-rewriting steps, and two for the plain runs after uninstall");
  const t = w.transcript(4);
  for (const id of ["F.1", "F.2", "F.2r", "F.2d", "F.3", "F.3r", "F.3d", "F.4", "F.5", "F.5r", "F.5d", "F.6a", "F.6d", "F.6e"]) assert.match(t, new RegExp(`=== ${id.replace(".", "\\.")}[a-z]? `), id);
  assert.equal(w.installedSha, undefined, "uninstalled at the end");
});

test("cycle: a deleted ledger file after the update stops at the data check", async () => {
  const w = world();
  await toPromoted(w);
  const real = w.exec;
  w.exec = async (cmd, args, o) => {
    if (cmd === "claude" && args[1] === "update") rmSync(join(w.home, ".claude", "context-economy", "gateway-ledger"), { recursive: true, force: true });
    return real(cmd, args, o);
  };
  w.deps.exec = w.exec;
  assert.equal(await w.part("cycle", ["--b", B]), 1);
  assert.match(dieWith(w), /STOP at F\.2/);
});

test("cycle: a rollback that installs B's commit stops at F.3", async () => {
  const w = world();
  await toPromoted(w);
  const real = w.exec;
  w.exec = async (cmd, args, o) => {
    const r = await real(cmd, args, o);
    if (cmd === "claude" && args[1] === "install" && w.ref === `promoted-v${A}`) { const f = join(w.home, ".claude", "plugins", "installed_plugins.json"); writeFileSync(f, JSON.stringify({ plugins: { "tool-gateway@context-economy": [{ gitCommitSha: SHA_B }] } })); w.installedSha = SHA_B; }
    return r;
  };
  w.deps.exec = w.exec;
  assert.equal(await w.part("cycle", ["--b", B]), 1);
  assert.match(dieWith(w), /STOP at F\.3/);
});

test("cycle: a pinned tag that moves on update stops at F.4", async () => {
  const w = world();
  await toPromoted(w);
  const real = w.exec;
  w.exec = async (cmd, args, o) => {
    const r = await real(cmd, args, o);
    if (cmd === "claude" && args[1] === "update" && w.ref === `promoted-v${A}`) { const f = join(w.home, ".claude", "plugins", "installed_plugins.json"); writeFileSync(f, JSON.stringify({ plugins: { "tool-gateway@context-economy": [{ gitCommitSha: SHA_B }] } })); w.installedSha = SHA_B; }
    return r;
  };
  w.deps.exec = w.exec;
  assert.equal(await w.part("cycle", ["--b", B]), 1);
  assert.match(dieWith(w), /STOP at F\.4/);
});

test("cycle: the shape of E1b parts needs the baseline's drill folder", async () => {
  const w = world();
  assert.equal(await main(["e1b", "--part", "cycle", "--a", A, "--b", B, "--clone", w.clone], w.deps), 2);
  assert.match(dieWith(w), /needs --drill/);
});

test("cycle: a ledger row that appears between the uninstall check and the host runs stops at F.6d (row counts must not change)", async () => {
  const w = world();
  await toPromoted(w);
  let wrote = false;
  const say = w.deps.ui.say;
  // A stray writer: its row lands before the host run's own window opens, so only the part's own count check can see it.
  w.deps.ui.say = (...a) => {
    if (!w.installedSha && !wrote) {
      wrote = true;
      const dir = join(w.home, ".claude", "context-economy", "gateway-ledger");
      appendFileSync(join(dir, "stray-0.jsonl"), JSON.stringify({ ts: new Date(w.clock).toISOString(), tool: "Bash" }) + "\n");
    }
    return say(...a);
  };
  assert.equal(await w.part("cycle", ["--b", B]), 1);
  assert.match(dieWith(w), /STOP at F\.6d/);
  assert.match(dieWith(w), /ledger row counts to stay/);
});

test("cycle: an extra file left in the data folder after the uninstall stops at F.6d", async () => {
  const w = world();
  await toPromoted(w);
  const real = w.exec;
  w.exec = async (cmd, args, o) => {
    if (cmd === "claude" && args[1] === "uninstall" && w.ref === "release") writeFileSync(join(w.home, ".claude", "context-economy", "junk.txt"), "x");
    return real(cmd, args, o);
  };
  w.deps.exec = w.exec;
  assert.equal(await w.part("cycle", ["--b", B]), 1);
  assert.match(dieWith(w), /STOP at F\.6d/);
});

test("cycle: promoted-v<B> at another commit stops at F.1", async () => {
  const w = world();
  await toPromoted(w);
  w.promotedB = "c".repeat(40);
  assert.equal(await w.part("cycle", ["--b", B]), 1);
  assert.match(dieWith(w), /STOP at F\.1/);
});

test("cycle: a data check that reports another number of ledger files than the snapshot's stops at F.2d", async () => {
  const w = world();
  await toPromoted(w);
  const file = join(w.deps.runsDir, DRILL, "drill-state.json");
  writeFileSync(file, JSON.stringify({ ...w.state(), ledgerFiles: 99 }));
  assert.equal(await w.part("cycle", ["--b", B]), 1);
  assert.match(dieWith(w), /STOP at F\.2d/);
});

test("the uninstall step tells the operator to approve Claude Code's prompt, in E1a and in the cycle (S1)", async () => {
  const { default: proof } = await import("./proof/tool-gateway.mjs");
  const { e1aSteps, cycleSteps } = await import("./e1-parts.mjs");
  const vars = { V: "0.1.3", platform: "macos-arm64", a: A, b: B, staging: STAGING };
  for (const [steps, id] of [[e1aSteps(vars), "E1a.6b"], [cycleSteps(vars), "F.6b"]]) {
    const h = steps.find((s) => s.id === id).human({ proofs: [proof], step: { id } });
    assert.match(h.say.join("\n"), /Approve the permission prompt/, id);
  }
});

test("each baseline step title names its run sheet step (S2)", async () => {
  const { baselineSteps } = await import("./e1-parts.mjs");
  const titles = Object.fromEntries(baselineSteps({ part: "baseline", a: A }).map((s) => [s.id, s.title]));
  assert.match(titles["A.0"], /Part 0\.4/); assert.match(titles["A.1"], /sheet A\.1/); assert.match(titles["A.2"], /sheet A\.2, A\.3/);
  assert.match(titles["A.3"], /sheet A\.4/); assert.match(titles["A.4a"], /sheet A\.5/); assert.match(titles["A.5"], /sheet A\.6/);
});

// --- review 120 S3 to S7 -------------------------------------------------------------------------------

const SETTINGS_WITH_OVERRIDE = JSON.stringify({ env: { CE_RTK_BIN: "/somewhere/else" } });
const plantOverride = (w) => { mkdirSync(join(w.home, ".claude"), { recursive: true }); writeFileSync(join(w.home, ".claude", "settings.json"), SETTINGS_WITH_OVERRIDE); };

test("S3: a settings file that sets CE_RTK_BIN stops the baseline at A.2, before any plugin is installed", async () => {
  const w = world();
  w.onBash = () => plantOverride(w);
  assert.equal(await w.part("baseline"), 1);
  assert.match(dieWith(w), /STOP at A\.2/);
  assert.match(w.transcript(), /CE_RTK_BIN is set in/);
  assert.equal(w.hosts.length, 0);
});

test("S3: a settings file that sets CE_RTK_BIN after the update stops the cycle at its override check (F.2ro), before the host step", async () => {
  const w = world();
  await toPromoted(w);
  const real = w.exec, before = w.hosts.length;
  w.exec = async (cmd, args, o) => {
    if (cmd === "claude" && args[1] === "update") plantOverride(w);
    return real(cmd, args, o);
  };
  w.deps.exec = w.exec;
  assert.equal(await w.part("cycle", ["--b", B]), 1);
  assert.match(dieWith(w), /STOP at F\.2ro/);
  assert.equal(w.hosts.length, before);
});

async function atBaseline(w) { await baseline(w); }

test("S4 B.1: a tag that is not origin/main, a release that is not A, or a wrong version in any of the four files stops at B.1", async () => {
  const bad = [
    ["the tag is not origin/main", (w) => { w.mainSha = "c".repeat(40); }],
    ["origin/release is not A", (w) => { w.release = "c".repeat(40); }],
    ["main's package.json has another version", (w) => { w.fileVersion = { "origin/main:package.json": "9.9.9" }; }],
    ["main's plugin.json has another version", (w) => { w.fileVersion = { "origin/main:plugins/tool-gateway/.claude-plugin/plugin.json": "9.9.9" }; }],
    ["release's package.json has another version", (w) => { w.fileVersion = { "origin/release:package.json": "9.9.9" }; }],
    ["release's plugin.json has another version", (w) => { w.fileVersion = { "origin/release:plugins/tool-gateway/.claude-plugin/plugin.json": "9.9.9" }; }],
  ];
  for (const [what, change] of bad) {
    const w = world();
    await atBaseline(w);
    change(w);
    w.err.length = 0;
    assert.equal(await w.part("undelivered", ["--b", B]), 1, what);
    assert.match(dieWith(w), /STOP at B\.1/, what);
  }
});

test("S4 F.4: an update of the pinned tag whose output names B stops at F.4", async () => {
  const w = world();
  await toPromoted(w);
  w.updateOffersB = true;
  assert.equal(await w.part("cycle", ["--b", B]), 1);
  assert.match(dieWith(w), /STOP at F\.4/);
  assert.match(dieWith(w), /no output naming the other version/
  );
});

test("S4 F.3, F.5: the rollback and the return each remove the marketplace before adding it again", async () => {
  const w = world();
  await toPromoted(w);
  const from = w.execs.length;
  assert.equal(await w.part("cycle", ["--b", B]), 0, dieWith(w));
  const ops = w.execs.slice(from).filter((e) => e.cmd === "claude" && e.args[1] === "marketplace").map((e) => e.args[2]);
  assert.deepEqual(ops, ["update", "remove", "add", "update", "remove", "add"]);
});

const proofDirWith = (files) => {
  const dir = mkdtempSync(join(tmpdir(), "e1b-proof-"));
  const base = readFileSync(join(ROOT, "scripts", "proof", "tool-gateway.mjs"), "utf8");
  for (const [name, edit] of Object.entries(files)) writeFileSync(join(dir, `${name}.mjs`), edit(base));
  return dir;
};
const twoPlugins = (w) => writeFileSync(join(w.clone, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "context-economy", plugins: [{ name: "tool-gateway", source: "./a" }, { name: "second-plugin", source: "./b" }] }));

test("S4: two plugins shipping to Claude Code is a stop, not a guess", async () => {
  const w = world({ deps: { proofDir: proofDirWith({
    "tool-gateway": (t) => t,
    "second-plugin": (t) => t.replace('name: "tool-gateway"', 'name: "second-plugin"').replaceAll("gateway-ledger", "second-ledger").replace(/dataLeft: .*/, 'dataLeft: ["config.json", "second-ledger", "second-ledger-pi"],'),
  }) } });
  twoPlugins(w);
  assert.equal(await w.part("baseline"), 1);
  assert.match(dieWith(w), /exactly one plugin shipping to Claude Code/);
  assert.equal(w.hosts.length, 0);
});

test("S4: two behaviour entries for one host is a stop at the host step", async () => {
  const w = world({ deps: { proofDir: proofDirWith({
    "tool-gateway": (t) => t.replace('    { host: "pi", command: "git status", result: 1,', '    { host: "claude", command: "git status", result: 1, ledger: { rows: 1, rewrite: "applied", is_error: false } },\n    { host: "pi", command: "git status", result: 1,'),
  }) } });
  assert.equal(await w.part("baseline"), 1);
  assert.match(dieWith(w), /STOP at A\.4a/);
  assert.match(dieWith(w), /exactly one behaviour entry for claude/);
  assert.equal(w.hosts.length, 0);
});

test("S5: B's commit read by `undelivered` or `promoted` must equal the one an earlier part recorded", async () => {
  const w = world();
  await baseline(w);
  assert.equal(await w.part("undelivered", ["--b", B]), 0, dieWith(w));
  const other = "c".repeat(40);
  Object.assign(w, { tagB: other, mainSha: other, promotedB: other, release: other, releaseVersion: B });
  assert.equal(await w.part("promoted", ["--b", B]), 1);
  assert.match(dieWith(w), /STOP at E\.6/);
  assert.match(dieWith(w), /earlier part recorded/);
  assert.equal(w.state().shaB, SHA_B, "the recorded B commit is not overwritten");
  const v = world();
  await baseline(v);
  assert.equal(await v.part("undelivered", ["--b", B]), 0, dieWith(v));
  Object.assign(v, { tagB: other, mainSha: other });
  v.err.length = 0;
  assert.equal(await v.part("undelivered", ["--b", B]), 1);
  assert.match(dieWith(v), /STOP at B\.1/);
});

test("S6: a baseline without --b says in the transcript that B was not checked; with --b it makes the check", async () => {
  const w = world();
  await baseline(w);
  assert.match(w.transcript(), /not checked: no --b given/);
  const v = world();
  assert.equal(await v.part("baseline", ["--b", B]), 0, dieWith(v));
  assert.doesNotMatch(v.transcript(), /not checked: no --b given/);
  assert.match(v.transcript(), /ls-remote --tags origin 'refs\/tags\/v0\.1\.3\*'/);
});

test("S7: a ledger folder that is not directly under ~/.claude/context-economy/ is a stop, not a read in the wrong place", () => {
  const steps = baselineSteps({ part: "baseline", a: A });
  const check = steps.find((s) => s.id === "A.4c").expect[0].match;
  const proof = (dirs) => ({ name: "x", hosts: ["claude"], ledgerDirs: dirs, behaviour: [], uninstall: [], dataLeft: [] });
  const out = "gateway-ledger: 1 rows\nledger check: OK\n";
  for (const d of [".claude/elsewhere/gateway-ledger", ".claude/context-economy/sub/gateway-ledger", "gateway-ledger"]) {
    assert.throws(() => check(out, { proofs: [proof({ claude: d })], step: { id: "A.4c" }, env: { HOME: "/h" } }), (e) => e instanceof StopError && /directly under ~\/\.claude\/context-economy\//.test(e.message), d);
  }
  assert.doesNotThrow(() => check(out, { proofs: [proof({ claude: ".claude/context-economy/gateway-ledger" })], step: { id: "A.4c" }, env: { HOME: "/h" } }));
});
