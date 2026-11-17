// SPDX-License-Identifier: Apache-2.0

// Engine tests: fake hosts, a temp HOME for everything, nothing real touched. The scrubber at the end
// of each run is the real gitleaks (see e1-scrub.test.mjs).
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, copyFileSync, cpSync, existsSync, realpathSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { HOSTS, HostVersions, main, newAttempt, loadProofModules, parseVersionLine, realExec, realLaunchHost, realUi } from "./e1-run.mjs";
import { ALLOWED_VARIABLES, REFUSED_VARIABLES } from "./e1-helpers.mjs";
import { appendFileSync } from "node:fs";
import proofToolGateway from "./proof/tool-gateway.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const mode = (p) => statSync(p).mode & 0o777;
const tmp = (p) => mkdtempSync(join(tmpdir(), p));
const alnum = (n) => [...Array(n)].map(() => "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"[Math.floor(Math.random() * 62)]).join("");
const OK = () => ({ ok: true });
const EVID = { kind: "behaviour", command: "git status", result: 1, ledgerDir: ".claude/context-economy/gateway-ledger-pi", ledger: { rows: 0 } };
const DEFAULT_ANSWERS = (q) => (/result/i.test(q) ? "1" : /permission prompt/i.test(q) ? "no prompt" : "git status");
const MARKETPLACE = { name: "m", plugins: [{ name: "tool-gateway", source: "./plugins/tool-gateway" }] };

/** A world: temp HOME, runs folder, a clone with marketplace and the project's gitleaks config, and fake dependencies. */
function world(over = {}) {
  const home = tmp("e1-home-");
  const clone = tmp("e1-clone-");
  mkdirSync(join(clone, ".claude-plugin"));
  writeFileSync(join(clone, ".claude-plugin", "marketplace.json"), JSON.stringify(over.marketplace ?? MARKETPLACE));
  copyFileSync(join(ROOT, ".gitleaks.toml"), join(clone, ".gitleaks.toml"));
  const w = {
    home, clone, runsDir: join(home, "e1-runs"), events: [], asked: [], execs: [], out: [], err: [],
    versions: { claude: "2.1.300", pi: "1.5.0" },
    signals: new EventEmitter(),
    tty: { stdin: true, stdout: true },
    parts: { e1a: undefined, e1b: {} },
    ...over,
  };
  w.log = { log: (m) => w.out.push(m), error: (m) => w.err.push(m) };
  w.exec = over.exec ?? (async (cmd, args, o) => {
    w.execs.push({ cmd, args, env: o.env, cwd: o.cwd });
    if (args[0] === "--version" && w.versions[cmd] !== undefined) return { code: 0, out: `${w.versions[cmd]}\n` };
    return w.onExec ? w.onExec(cmd, args, o) : { code: 0, out: "" };
  });
  w.deps = {
    env: { HOME: home, PATH: "/usr/bin:/bin", TERM: "xterm", LANG: "C", USER: "u", SHELL: "/bin/zsh", TMPDIR: "/leak", ...over.env },
    log: w.log, exec: w.exec, runsDir: w.runsDir, parts: w.parts, now: () => new Date("2026-11-14T10:00:00Z"),
    signals: w.signals, hostname: "testbox", realHome: "/Users/nobody-real", proofDir: undefined, managedSettings: [],
    ui: {
      tty: () => w.tty, say: () => {}, ask: async (q) => { w.asked.push(q); return (w.answer ?? DEFAULT_ANSWERS)(q); }, waitEnter: async () => { w.events.push("enter"); }, close: () => { w.events.push("ui-close"); }, restore: () => w.events.push("restore"),
    },
    launchHost: async (host) => { w.events.push(`host:${host}`); return { code: 0, signal: null }; },
    ...over.deps,
  };
  w.run = (argv) => main(argv, w.deps);
  return w;
}
const e1a = (w, argv = []) => w.run(["e1a", "--version", "0.1.3", "--platform", "macos-arm64", "--clone", w.clone, ...argv]);
const baseline = (w) => w.run(["e1b", "--part", "baseline", "--clone", w.clone]);
const attempt = (w, n = 1, folder = "0.1.3-macos-arm64") => join(w.runsDir, folder, `attempt-${n}`);
const files = (dir) => readdirSync(dir);
const raw = (w, n = 1) => readFileSync(join(attempt(w, n), "0.1.3-macos-arm64.raw.txt"), "utf8");

test("a part that passes exits 0 and writes a raw and a scrubbed transcript", async () => {
  const w = world();
  w.parts.e1a = () => [{ id: "A.1", title: "one", run: [["echo", "hi"]], expect: [] }];
  w.onExec = (cmd) => ({ code: 0, out: "hello\n" });
  assert.equal(await e1a(w), 0);
  assert.deepEqual(files(attempt(w)).sort(), ["0.1.3-macos-arm64.raw.txt", "0.1.3-macos-arm64.txt", "host-versions.json", "scrub-context.json"]);
  assert.match(raw(w), /=== A\.1 one ===/);
  assert.match(readFileSync(join(attempt(w), "0.1.3-macos-arm64.txt"), "utf8"), /--- scrub report ---/);
});

test("the first failed assertion stops the part; no later step runs", async () => {
  const w = world();
  const ran = [];
  w.onExec = (cmd, args) => { ran.push(args[0]); return { code: 0, out: args[0] === "two" ? "wrong\n" : "fine\n" }; };
  w.parts.e1a = () => ["one", "two", "three"].map((id) => ({ id, run: [["step", id]], expect: [{ cmd: 0, match: /right/ }] }));
  const code = await e1a(w);
  assert.equal(code, 1);
  assert.deepEqual(ran.filter((a) => ["one", "two", "three"].includes(a)), ["one"]);
  const t = raw(w);
  assert.match(t, /STOP at one/);
  assert.match(t, /expected: output matching \/right\//);
  assert.match(t, /got: fine/);
  assert.match(t, /Send the transcript to the engineer\./);
  assert.match(w.err.join("\n"), /Send the transcript to the engineer\./);
});

test("a later step after a passing step does run; an `after` assertion that fails stops", async () => {
  const w = world();
  const ran = [];
  w.onExec = (cmd, args) => { ran.push(args[0]); return { code: 0, out: "" }; };
  w.parts.e1a = () => [
    { id: "s1", run: [["a", "s1"]], after: [() => ({ ok: false, expected: "the file to exist", got: "missing" })] },
    { id: "s2", run: [["a", "s2"]] },
  ];
  assert.equal(await e1a(w), 1);
  assert.deepEqual(ran.filter((x) => x.startsWith("s")), ["s1"]);
  assert.match(raw(w), /expected: the file to exist/);
});

test("a non-zero exit stops unless the step expects that code; there is no retry", async () => {
  const w = world();
  let calls = 0;
  w.onExec = (cmd, args) => (args[0] === "bad" ? (calls++, { code: 3, out: "boom\n" }) : { code: 0, out: "" });
  w.parts.e1a = () => [{ id: "s1", run: [["x", "bad"]] }];
  assert.equal(await e1a(w), 1);
  assert.equal(calls, 1);
  w.parts.e1a = () => [{ id: "s1", run: [["x", "bad"]], expect: [{ cmd: 0, code: 3 }] }];
  assert.equal(await e1a(w), 0);
});

test("every command gets exactly the allow-listed environment (fake host prints its own)", async () => {
  const bin = tmp("e1-bin-");
  const fake = join(bin, "claude");
  writeFileSync(fake, `#!/usr/bin/env node\nif (process.argv[2] === "--version") console.log("2.1.300"); else console.log(JSON.stringify(process.env));\n`);
  chmodSync(fake, 0o755);
  const pi = join(bin, "pi");
  writeFileSync(pi, `#!/usr/bin/env node\nconsole.log("1.5.0");\n`);
  chmodSync(pi, 0o755);
  const w = world({ env: { PATH: `${bin}:${process.env.PATH}`, GITHUB_TOKEN: "leak", AWS_PROFILE: "leak", LC_ALL: "C" } });
  w.deps.exec = (c, a, o) => realExec(c, a, o);
  let seen;
  w.parts.e1a = () => [{ id: "env", run: [["claude", "env"]], expect: [{ cmd: 0, match: (out) => { seen = JSON.parse(out); return true; } }] }];
  assert.equal(await e1a(w), 0);
  delete seen.__CF_USER_TEXT_ENCODING; // macOS adds this to every process it launches, whatever env is passed
  assert.deepEqual(Object.keys(seen).sort(), ALLOWED_VARIABLES.filter((k) => w.deps.env[k] !== undefined).sort());
  assert.equal(seen.HOME, w.home);
  assert.equal(seen.TMPDIR, undefined);
});

for (const name of REFUSED_VARIABLES) {
  test(`the driver refuses to start when ${name} is set (also set empty), and touches nothing`, async () => {
    for (const value of ["/x", ""]) {
      const w = world({ env: { [name]: value } });
      w.parts.e1a = () => [];
      assert.equal(await e1a(w), 2);
      assert.match(w.err.join("\n"), new RegExp(name));
      assert.equal(existsSync(w.runsDir), false);
    }
  });
}

test("folder and file modes: 0700 folders, 0600 files, whatever the umask", async () => {
  const old = process.umask(0o000);
  try {
    const w = world();
    w.parts.e1a = () => [{ id: "s1", run: [["echo"]] }];
    assert.equal(await e1a(w), 0);
    for (const dir of [w.runsDir, join(w.runsDir, "0.1.3-macos-arm64"), attempt(w)]) assert.equal(mode(dir), 0o700, dir);
    for (const f of files(attempt(w))) assert.equal(mode(join(attempt(w), f)), 0o600, f);
  } finally { process.umask(old); }
});

test("a runs folder that already exists with looser modes is tightened to 0700", async () => {
  const w = world();
  mkdirSync(join(w.runsDir, "0.1.3-macos-arm64"), { recursive: true, mode: 0o755 });
  chmodSync(w.runsDir, 0o755);
  chmodSync(join(w.runsDir, "0.1.3-macos-arm64"), 0o755);
  w.parts.e1a = () => [{ id: "s1", run: [["echo"]] }];
  assert.equal(await e1a(w), 0);
  assert.equal(mode(w.runsDir), 0o700);
  assert.equal(mode(join(w.runsDir, "0.1.3-macos-arm64")), 0o700);
});

test("each run is a new attempt; an earlier attempt is never overwritten or appended to", async () => {
  const w = world();
  w.parts.e1a = () => [{ id: "s1", run: [["echo"]] }];
  await e1a(w);
  const first = raw(w, 1);
  w.onExec = () => ({ code: 0, out: "second run\n" });
  await e1a(w);
  assert.deepEqual(files(join(w.runsDir, "0.1.3-macos-arm64")).sort(), ["attempt-1", "attempt-2"]);
  assert.equal(raw(w, 1), first);
  assert.match(raw(w, 2), /second run/);
  assert.equal(newAttempt(join(w.runsDir, "0.1.3-macos-arm64")).n, 3);
});

test("E1b: the drill folder is e1b-<date> and the state file sits at its top level", async () => {
  const w = world();
  w.parts.e1b.baseline = () => [];
  assert.equal(await baseline(w), 0);
  const folder = join(w.runsDir, "e1b-2026-11-14");
  assert.ok(existsSync(join(folder, "host-versions.json")));
  assert.equal(mode(join(folder, "host-versions.json")), 0o600);
  assert.ok(existsSync(join(folder, "attempt-1", "e1b-2026-11-14.raw.txt")));
});

// --- host versions ---------------------------------------------------------------------------------

async function drill(w, partName, fn) {
  w.parts.e1b[partName] = () => [{ id: "p", run: [["echo"]], ...fn?.() }];
}
const stateOf = (w) => JSON.parse(readFileSync(join(w.runsDir, "e1b-2026-11-14", "host-versions.json"), "utf8"));
const later = (w, argv = ["--drill", "e1b-2026-11-14"]) => w.run(["e1b", "--part", "later", ...argv, "--clone", w.clone]);

test("host versions: same keeps going", async () => {
  const w = world();
  w.parts.e1b.baseline = () => [];
  await baseline(w);
  await drill(w, "later");
  assert.equal(await later(w), 0);
});
test("host versions: a later version is recorded and the part goes on", async () => {
  const w = world();
  w.parts.e1b.baseline = () => [];
  await baseline(w);
  w.versions.claude = "2.1.310";
  await drill(w, "later");
  assert.equal(await later(w), 0);
  assert.equal(stateOf(w).claude.version, "2.1.310");
  assert.equal(stateOf(w).pi.version, "1.5.0");
  assert.match(readFileSync(join(w.runsDir, "e1b-2026-11-14", "attempt-2", "e1b-2026-11-14.raw.txt"), "utf8"), /later than 2\.1\.300: recorded/);
});
for (const host of HOSTS) {
  test(`host versions: an earlier ${host} stops`, async () => {
    const w = world();
    w.parts.e1b.baseline = () => [];
    await baseline(w);
    w.versions[host] = host === "claude" ? "2.1.274" : "1.4.0";
    await drill(w, "later");
    assert.equal(await later(w), 1);
    assert.match(w.err.join("\n"), new RegExp(`${host} \\S+ or later`));
  });
}
test("host versions: one later and one earlier stops", async () => {
  const w = world();
  w.parts.e1b.baseline = () => [];
  await baseline(w);
  w.versions.claude = "2.2.0";
  w.versions.pi = "1.4.0";
  await drill(w, "later");
  assert.equal(await later(w), 1);
});
test("host versions: an unparseable version stops", async () => {
  const w = world();
  w.versions.claude = "banana";
  w.parts.e1b.baseline = () => [];
  assert.equal(await baseline(w), 1);
  assert.match(w.err.join("\n"), /one version line from `claude --version`/);
});
test("host versions: a state file missing after the baseline stops; nothing is recorded fresh", async () => {
  const w = world();
  mkdirSync(join(w.runsDir, "e1b-2026-11-14"), { recursive: true });
  await drill(w, "later");
  assert.equal(await later(w), 1);
  assert.match(w.err.join("\n"), /the drill state file .* from the baseline/);
  assert.equal(existsSync(join(w.runsDir, "e1b-2026-11-14", "host-versions.json")), false);
});
test("host versions: an unreadable state file after the baseline stops", async () => {
  const w = world();
  w.parts.e1b.baseline = () => [];
  await baseline(w);
  writeFileSync(join(w.runsDir, "e1b-2026-11-14", "host-versions.json"), "{ not json");
  await drill(w, "later");
  assert.equal(await later(w), 1);
});
test("host versions: a state file with no record of a host stops (a later part makes no first recording)", () => {
  const dir = tmp("e1-state-");
  const file = join(dir, "host-versions.json");
  writeFileSync(file, JSON.stringify({ claude: { version: "2.1.300" }, history: [] }));
  const v = new HostVersions({ file, requireState: true });
  assert.throws(() => v.record("pi", "1.5.0", "part start", new Date()), /recorded in the state file/);
});
test("host versions: read around a host step, before and after", async () => {
  const w = world();
  w.parts.e1a = () => [{ id: "H", human: { host: "pi", say: ["do it"], evidence: EVID }, after: [OK] }];
  assert.equal(await e1a(w), 0);
  const reads = w.execs.filter((e) => e.args[0] === "--version").length;
  assert.equal(reads, 6); // part start, before, after: both hosts each
  assert.match(raw(w), /host versions, before H/);
  assert.match(raw(w), /host versions, after H/);
});
test("host versions: a host that updates itself to an earlier version during a host step stops after it", async () => {
  const w = world();
  w.deps.launchHost = async () => { w.versions.pi = "1.4.0"; return { code: 0, signal: null }; };
  w.parts.e1a = () => [{ id: "H", human: { host: "pi", say: ["do it"], evidence: EVID }, after: [OK] }, { id: "N", run: [["never"]] }];
  assert.equal(await e1a(w), 1);
  assert.ok(!w.execs.some((e) => e.cmd === "never"));
});

// --- update guard ------------------------------------------------------------------------------------

test("update guard: `claude update` and `pi update` are refused and never reach exec", async () => {
  for (const host of HOSTS) {
    const w = world();
    w.parts.e1a = () => [{ id: "U", run: [[host, "update"]] }];
    assert.equal(await e1a(w), 1);
    assert.ok(!w.execs.some((e) => e.args[0] === "update"));
    assert.match(raw(w), new RegExp(`${host} update is not run`));
  }
});
test("update guard: `claude plugin update` and `pi update --extensions` run", async () => {
  const w = world();
  w.parts.e1a = () => [{ id: "U1", run: [["claude", "plugin", "update", "tool-gateway@context-economy"], ["pi", "update", "--extensions"]] }];
  assert.equal(await e1a(w), 0);
  assert.ok(w.execs.some((e) => e.cmd === "claude" && e.args[1] === "update"));
  assert.ok(w.execs.some((e) => e.cmd === "pi" && e.args[1] === "--extensions"));
});

// --- human steps and signals ----------------------------------------------------------------------------

test("a human step refuses to start without a terminal on stdin and on stdout", async () => {
  for (const tty of [{ stdin: false, stdout: true }, { stdin: true, stdout: false }, { stdin: false, stdout: false }]) {
    const w = world({ tty });
    w.parts.e1a = () => [{ id: "H", human: { host: "pi", say: ["x"], evidence: EVID }, after: [OK] }];
    assert.equal(await e1a(w), 1);
    assert.ok(!w.events.includes("host:pi"));
    assert.match(w.err.join("\n"), /terminal on stdin and stdout/);
  }
});
test("a human step: Enter, then the driver's readline is closed, then the host starts, then the terminal is restored", async () => {
  const w = world();
  w.parts.e1a = () => [{ id: "H", human: { host: "pi", say: ["type this"], evidence: EVID }, after: [OK] }];
  assert.equal(await e1a(w), 0);
  assert.deepEqual(w.events.slice(0, 4), ["enter", "ui-close", "host:pi", "restore"]);
});
test("a human step for claude refuses a non-default permission mode", async () => {
  const w = world();
  mkdirSync(join(w.home, ".claude"));
  writeFileSync(join(w.home, ".claude", "settings.json"), JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } }));
  w.parts.e1a = () => [{ id: "H", human: { host: "claude", say: ["x"], evidence: EVID }, after: [OK] }];
  assert.equal(await e1a(w), 1);
  assert.ok(!w.events.includes("host:claude"));
});
test("SIGINT while a host runs does not end the driver: it waits for the host", async () => {
  const w = world();
  let release;
  w.deps.launchHost = (host) => new Promise((done) => { w.events.push("host-start"); release = () => done({ code: 0, signal: null }); });
  w.parts.e1a = () => [{ id: "H", human: { host: "pi", say: ["x"], evidence: EVID }, after: [OK] }, { id: "After", run: [["after"]] }];
  const result = e1a(w);
  await waitFor(() => w.events.includes("host-start"));
  w.signals.emit("SIGINT");
  w.signals.emit("SIGINT");
  await new Promise((r) => setTimeout(r, 30));
  release();
  assert.equal(await result, 0);
  assert.ok(w.execs.some((e) => e.cmd === "after"));
  assert.match(raw(w), /SIGINT while the host runs/);
  assert.equal(w.signals.listenerCount("SIGINT"), 0);
});
test("SIGINT outside a host step: `aborted at step <id>`, non-zero, an aborted part is a failure", async () => {
  const w = world();
  w.deps.exec = async (cmd, args, o) => (args[0] === "--version" ? { code: 0, out: cmd === "pi" ? "1.5.0\n" : "2.1.300\n" } : new Promise(() => {}));
  w.parts.e1a = () => [{ id: "S7", run: [["sleep"]] }, { id: "S8", run: [["after"]] }];
  const result = e1a(w);
  await waitFor(() => w.signals.listenerCount("SIGINT") > 0);
  await new Promise((r) => setTimeout(r, 30));
  w.signals.emit("SIGINT");
  const code = await result;
  assert.notEqual(code, 0);
  assert.match(raw(w), /aborted at step S7/);
  assert.match(w.err.join("\n"), /aborted at step S7/);
  assert.equal(w.signals.listenerCount("SIGINT"), 0);
});
test("realLaunchHost saves the terminal state before and restores it after, also after an error", async () => {
  for (const fail of [false, true]) {
    const calls = [];
    const child = new EventEmitter();
    const stty = (args) => { calls.push(args); return { status: 0, stdout: "saved-mode\n" }; };
    const spawn = (cmd, args, o) => { calls.push(["spawn", cmd, o.stdio]); setImmediate(() => (fail ? child.emit("error", new Error("nope")) : child.emit("close", 0, null))); return child; };
    const r = await realLaunchHost("pi", { cwd: "/", env: {}, spawn, stty });
    assert.deepEqual(calls[0], ["-g"]);
    assert.deepEqual(calls[1], ["spawn", "pi", "inherit"]);
    assert.deepEqual(calls.at(-1), ["saved-mode"]);
    assert.equal(r.code, fail ? 127 : 0);
  }
});
test("realUi: the readline is closed after Enter, so the host gets every keystroke", async () => {
  const input = new PassThrough();
  input.isTTY = true;
  const output = new PassThrough();
  const ui = realUi({ input, output });
  const waiting = ui.waitEnter("go");
  input.write("\n");
  await waiting;
  assert.equal(input.isPaused(), true);
  assert.deepEqual(ui.tty(), { stdin: true, stdout: false });
});

// --- scrubbed copy and proof modules ---------------------------------------------------------------------

test("the scrubbed copy is made from the whole raw file; the raw keeps the token, the scrubbed copy does not", async () => {
  const w = world();
  const t = `ghp_${alnum(36)}`;
  w.onExec = () => ({ code: 0, out: `token ${t}\n` });
  w.parts.e1a = () => [{ id: "T", run: [["print"]] }];
  assert.equal(await e1a(w), 0);
  assert.ok(raw(w).includes(t));
  const scrubbed = readFileSync(join(attempt(w), "0.1.3-macos-arm64.txt"), "utf8");
  assert.ok(!scrubbed.includes(t));
  assert.match(scrubbed, /gitleaks:/);
});
test("gitleaks missing: the part's own result stands, no scrubbed copy is written, and the run says so", async () => {
  const w = world({ deps: { gitleaksBin: join(tmpdir(), "no-gitleaks-here") } });
  w.parts.e1a = () => [{ id: "T", run: [["print"]] }];
  const code = await e1a(w);
  assert.equal(code, 3);
  assert.deepEqual(files(attempt(w)).sort(), ["0.1.3-macos-arm64.raw.txt", "host-versions.json", "scrub-context.json"]);
  assert.match(w.err.join("\n"), /NO scrubbed copy/);
});
test("assertions run on raw output: one matching inside a scrubbed span is reported", async () => {
  const w = world();
  const t = `ghp_${alnum(36)}`;
  w.onExec = () => ({ code: 0, out: `token ${t}\n` });
  w.parts.e1a = () => [{ id: "T", run: [["print"]], expect: [{ cmd: 0, match: /ghp_[A-Za-z0-9]{36}/ }] }];
  assert.equal(await e1a(w), 0);
  assert.match(w.err.join("\n"), /assertion of step T matched inside a scrubbed span/);
  assert.match(readFileSync(join(attempt(w), "0.1.3-macos-arm64.txt"), "utf8"), /matched inside a scrubbed span/);
});
test("a plugin listed in marketplace.json with no proof module is a stop, not a skip", async () => {
  const w = world({ marketplace: { plugins: [{ name: "tool-gateway" }, { name: "second-plugin" }] } });
  w.parts.e1a = () => [{ id: "s", run: [["never"]] }];
  assert.equal(await e1a(w), 1);
  assert.match(raw(w), /scripts\/proof\/second-plugin\.mjs for plugin second-plugin listed in marketplace\.json\n.*no such module/);
  assert.ok(!w.execs.some((e) => e.cmd === "never"));
});
test("every plugin in marketplace.json is looked up; tool-gateway's module is the real one", async () => {
  const mods = await loadProofModules(MARKETPLACE);
  assert.deepEqual(mods.map((m) => m.name), ["tool-gateway"]);
  assert.ok(!existsSync(join(ROOT, "plugins", "tool-gateway", "proof")));
});
test("no step data yet: the driver says so and exits 2", async () => {
  const w = world();
  assert.equal(await e1a(w), 2);
});
test("bad arguments exit 2", async () => {
  const w = world();
  assert.equal(await w.run(["e1a", "--version", "0.1.3", "--platform", "windows"]), 2);
  assert.equal(await w.run(["e1b"]), 2);
  assert.equal(await w.run(["e1b", "--part", "later"]), 2);
  assert.equal(await w.run(["nonsense"]), 2);
});

// --- review 114: E1 step data is validated before the first step runs ---------------------------------------

async function badData(steps, pattern) {
  const w = world();
  w.parts.e1a = () => steps;
  assert.equal(await e1a(w), 1);
  assert.match(raw(w), pattern);
  assert.ok(!w.execs.some((e) => e.cmd === "never"), "no command ran");
  assert.ok(!/=== (s1|s2) /.test(raw(w)), "no step started");
}
const NEVER = [["never"]];
test("E1: an expect whose cmd names no command is a stop", () => badData([{ id: "s1", run: NEVER, expect: [{ cmd: 5, match: /NEVER/ }] }], /cmd 5 names no command/));
test("E1: an expect with no cmd is a stop", () => badData([{ id: "s1", run: NEVER, expect: [{ match: /NEVER/ }] }], /no `cmd`/));
test("E1: a match that is a string, not a RegExp, is a stop", () => badData([{ id: "s1", run: NEVER, expect: [{ cmd: 0, match: "NEVER" }] }], /neither a RegExp nor a function/));
test("E1: a notMatch of the wrong type is a stop", () => badData([{ id: "s1", run: NEVER, expect: [{ cmd: 0, notMatch: "x" }] }], /notMatch is not a RegExp/));
test("E1: an expect with none of code, match, notMatch is a stop", () => badData([{ id: "s1", run: NEVER, expect: [{ cmd: 0 }] }], /none of code, match, notMatch/));
test("E1: an unknown key in an expect or in a step is a stop", async () => {
  await badData([{ id: "s1", run: NEVER, expect: [{ cmd: 0, matches: /x/ }] }], /unknown key matches/);
  await badData([{ id: "s1", run: NEVER, expects: [] }], /unknown key expects/);
});
test("E1: a duplicate step id is a stop", () => badData([{ id: "s1", run: NEVER }, { id: "s1", run: NEVER }], /duplicate step id/));
test("E1: a step with no id is a stop", () => badData([{ run: NEVER }], /no id/));
test("E1: a human step without host or say is a stop", async () => {
  await badData([{ id: "s1", human: { say: ["x"] }, after: [OK] }], /human\.host/);
  await badData([{ id: "s1", human: { host: "pi" }, after: [OK] }], /human\.say/);
});
test("E1: a run() whose commands do not fit the expects is checked once the commands are known", async () => {
  const w = world();
  w.parts.e1a = () => [{ id: "s1", run: () => [["never"]], expect: [{ cmd: 3, code: 0 }] }];
  assert.equal(await e1a(w), 1);
  assert.match(raw(w), /cmd 3 names no command/);
  assert.ok(!w.execs.some((e) => e.cmd === "never"));
});
test("E1: valid data still runs", async () => {
  const w = world();
  w.onExec = () => ({ code: 0, out: "NEVER\n" });
  w.parts.e1a = () => [{ id: "s1", run: [["x"]], expect: [{ cmd: 0, match: /NEVER/, notMatch: /nope/, code: 0 }] }];
  assert.equal(await e1a(w), 0);
});

// --- E2: a host that never started, or a human step with no evidence check ---------------------------------------

for (const launched of [{ code: 127, signal: null, error: "spawn claude ENOENT" }, { code: null, signal: null, error: "spawn pi EACCES" }]) {
  test(`E2: a launch error stops the step (${launched.error})`, async () => {
    const w = world();
    w.deps.launchHost = async () => launched;
    w.parts.e1a = () => [{ id: "H", human: { host: "pi", say: ["x"], evidence: EVID }, after: [OK] }, { id: "N", run: [["never"]] }];
    assert.equal(await e1a(w), 1);
    assert.match(raw(w), /expected: pi to start/);
    assert.ok(!w.execs.some((e) => e.cmd === "never"));
  });
}
test("E2: a human step with no evidence is a stop, never a pass (the evaluator cannot be left out)", async () => {
  for (const human of [{ host: "pi", say: ["x"] }, { host: "pi", say: ["x"], evidence: { ...EVID, ledgerDir: "../x" } }, { host: "pi", say: ["x"], evidence: { ...EVID, result: 9 } }]) {
    const w = world();
    w.parts.e1a = () => [{ id: "H", human, after: [OK] }];
    assert.equal(await e1a(w), 1);
    assert.match(raw(w), /human\.evidence/);
    assert.ok(!w.events.includes("host:pi"));
  }
});
test("E2: a host's exit code or signal is recorded; whether it fails the step is the evaluator's decision (piece 2)", async () => {
  const w = world();
  w.deps.launchHost = async () => ({ code: null, signal: "SIGKILL" });
  w.parts.e1a = () => [{ id: "H", human: { host: "pi", say: ["x"], evidence: EVID }, after: [OK] }];
  assert.equal(await e1a(w), 0);
  assert.match(raw(w), /\[pi exited SIGKILL\]/);
});

// --- E3: an abort at "Press Enter" closes the UI -----------------------------------------------------------------------

function realTerminal() {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => input;
  const output = new PassThrough();
  output.isTTY = true;
  let shown = "";
  output.on("data", (c) => { shown += c; });
  return { input, output, shown: () => shown };
}
/** Polls until `f()` is true; rejects after `ms` so a missing prompt fails the test and the run still exits (W1). */
async function waitFor(f, ms = 5000) {
  const until = Date.now() + ms;
  while (!f()) {
    if (Date.now() > until) throw new Error(`waitFor: condition not met within ${ms} ms`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("E3: Ctrl-C at the Enter prompt aborts the step, exits non-zero and leaves stdin closed", async () => {
  const w = world();
  const t = realTerminal();
  w.deps.ui = realUi({ input: t.input, output: t.output });
  w.parts.e1a = () => [{ id: "H", human: { host: "pi", say: ["x"], evidence: EVID }, after: [OK] }];
  const result = e1a(w);
  await waitFor(() => t.shown().includes("Press Enter"));
  t.input.write("\x03");
  assert.equal(await result, 130);
  assert.match(raw(w), /aborted at step H/);
  assert.equal(t.input.isPaused(), true);
  assert.equal(t.input.listenerCount("keypress"), 0);
  assert.ok(!w.events.includes("host:pi"));
});
test("E3: a SIGINT to the process while waiting at the prompt closes the readline too", async () => {
  const w = world();
  const t = realTerminal();
  w.deps.ui = realUi({ input: t.input, output: t.output });
  w.parts.e1a = () => [{ id: "H", human: { host: "pi", say: ["x"], evidence: EVID }, after: [OK] }];
  const result = e1a(w);
  await waitFor(() => t.shown().includes("Press Enter"));
  w.signals.emit("SIGINT");
  assert.equal(await result, 130);
  assert.equal(t.input.isPaused(), true);
  assert.equal(t.input.listenerCount("keypress"), 0);
});
test("E3: the UI is closed on a stop as well", async () => {
  const w = world();
  w.parts.e1a = () => [{ id: "s1", run: [["x"]], expect: [{ cmd: 0, match: /never/ }] }];
  await e1a(w);
  assert.ok(w.events.includes("ui-close"));
});

// --- E4: the version guard reads one anchored version line from stdout ------------------------------------------------

test("E4: parseVersionLine accepts a version line and nothing else", () => {
  assert.equal(parseVersionLine("1.5.0\n"), "1.5.0");
  assert.equal(parseVersionLine("2.1.119 (Claude Code)\n"), "2.1.119");
  assert.equal(parseVersionLine("pi 1.5.0\n"), "1.5.0");
  assert.equal(parseVersionLine("v1.5.0"), "1.5.0");
  assert.equal(parseVersionLine("Update available: 1.5.2 (run pi update)\n"), undefined);
  assert.equal(parseVersionLine("1.5.0 and more\n"), undefined);
  assert.equal(parseVersionLine("1.5.0\n1.5.1\n"), undefined);
  assert.equal(parseVersionLine(""), undefined);
});
const execWith = (w, byHost) => async (cmd, args) => {
  w.execs.push({ cmd, args });
  return args[0] === "--version" && byHost[cmd] ? byHost[cmd] : { code: 0, out: "" };
};
test("E4: an update notice above the version is not recorded as the version; the real line is", async () => {
  const w = world();
  const pi = "Update available: 1.5.2 (run pi update)\n1.5.0\n";
  w.deps.exec = execWith(w, { claude: { code: 0, stdout: "2.1.300\n", out: "2.1.300\n" }, pi: { code: 0, stdout: pi, out: pi } });
  w.parts.e1b.baseline = () => [];
  assert.equal(await baseline(w), 0);
  assert.equal(stateOf(w).pi.version, "1.5.0");
});
test("E4: a notice on stderr is ignored; a notice alone on stdout is a stop", async () => {
  const w = world();
  w.deps.exec = execWith(w, { claude: { code: 0, stdout: "2.1.300\n", out: "2.1.300\n" }, pi: { code: 0, stdout: "1.5.0\n", out: "Update available: 1.5.2\n1.5.0\n" } });
  w.parts.e1b.baseline = () => [];
  assert.equal(await baseline(w), 0);
  const w2 = world();
  w2.deps.exec = execWith(w2, { claude: { code: 0, stdout: "2.1.300\n", out: "2.1.300\n" }, pi: { code: 0, stdout: "Update available: 1.5.2 (run pi update)\n", out: "x" } });
  w2.parts.e1b.baseline = () => [];
  assert.equal(await baseline(w2), 1);
  assert.match(w2.err.join("\n"), /exactly one version line from `pi --version`/);
});
test("E4: a real downgrade below the recorded 1.5.0 is an earlier version, not 'same'", async () => {
  const w = world();
  w.versions.pi = "1.5.0";
  w.parts.e1b.baseline = () => [];
  await baseline(w);
  w.parts.e1b.later = () => [{ id: "p", run: [["echo"]] }];
  w.deps.exec = execWith(w, { claude: { code: 0, stdout: "2.1.300\n", out: "2.1.300\n" }, pi: { code: 0, stdout: "1.4.9\n", out: "1.4.9\n" } });
  assert.equal(await later(w), 1);
});
test("E4: realExec keeps stdout apart from stderr", async () => {
  const r = await realExec(process.execPath, ["-e", 'console.error("notice 9.9.9"); console.log("1.5.0")'], { cwd: ROOT, env: { PATH: process.env.PATH } });
  assert.equal(r.stdout, "1.5.0\n");
  assert.match(r.out, /notice 9\.9\.9/);
});

// --- E5: the account the run was made in is named on purpose -------------------------------------------------------------

test("E5: real home equal to HOME is shown, and the scrub report says so", async () => {
  const w = world();
  w.deps.realHome = w.home;
  w.onExec = () => ({ code: 0, out: `rtk.path: ${w.home}/.local/opt/rtk-0.47.0/rtk\n` });
  w.parts.e1a = () => [{ id: "F", run: [["x"]], expect: [{ cmd: 0, match: /rtk-0\.47\.0\/rtk/ }] }];
  assert.equal(await e1a(w), 0);
  const scrubbed = readFileSync(join(attempt(w), "0.1.3-macos-arm64.txt"), "utf8");
  assert.ok(scrubbed.includes(`${w.home}/.local/opt/rtk-0.47.0/rtk`));
  assert.ok(scrubbed.includes(`home shown: ${w.home}, the account the run was made in`));
  assert.ok(!w.err.join("\n").includes("scrubbed span"));
});
test("E5: a real home that differs from HOME is scrubbed; HOME is shown", async () => {
  const w = world();
  w.deps.realHome = "/Users/personal-account";
  w.onExec = () => ({ code: 0, out: `${w.home}/a and /Users/personal-account/b\n` });
  w.parts.e1a = () => [{ id: "F", run: [["x"]] }];
  assert.equal(await e1a(w), 0);
  const scrubbed = readFileSync(join(attempt(w), "0.1.3-macos-arm64.txt"), "utf8");
  assert.ok(scrubbed.includes(`${w.home}/a`));
  assert.ok(!scrubbed.includes("/Users/personal-account"));
  assert.ok(!scrubbed.includes("home shown:"));
});

// --- piece 2: evidence for host steps, in the engine --------------------------------------------------------------------

const BEHAVIOUR_EVID = { kind: "behaviour", command: "git status", result: 1, ledgerDir: ".claude/context-economy/gateway-ledger-pi", ledger: { rows: 1, rewrite: "applied", is_error: false } };
const UNINSTALL_EVID = { kind: "uninstall", command: "git status", result: 2, ledgerDir: ".claude/context-economy/gateway-ledger-pi", ledger: { rows: 0 } };
const SHORT = "* main...origin/main\n";
const hostStep = (evidence = BEHAVIOUR_EVID, extra = {}) => [{ id: "H", human: { host: "pi", say: ["type git status"], evidence }, ...extra }];
const ledgerFile = (w) => join(w.home, ".claude", "context-economy", "gateway-ledger-pi", "s-1-0.jsonl");
const addRow = (w, over = {}) => {
  mkdirSync(dirname(ledgerFile(w)), { recursive: true });
  appendFileSync(ledgerFile(w), JSON.stringify({ ts: "2026-11-14T10:00:01Z", rewrite: "applied", is_error: false, ...over }) + "\n");
};
/** SYNTHETIC session reader: returns whatever model the test hands it. */
/** The host takes five seconds: the clock reads 10:00:00 at launch and 10:00:05 at exit. */
const slowHost = (w, after = () => {}) => {
  let ms = Date.parse("2026-11-14T10:00:00Z");
  w.deps.now = () => new Date(ms);
  w.deps.launchHost = async () => { addRow(w); after(); ms += 5000; return { code: 0, signal: null }; };
};
const reader = (model) => ({ read: async () => (typeof model === "function" ? model() : model) });
const modelOf = (output = SHORT, over = {}) => ({ sessions: [{ id: "s", startedAt: Date.parse("2026-11-14T10:00:00Z"), calls: [{ command: "git status", startedAt: Date.parse("2026-11-14T10:00:01Z"), endedAt: Date.parse("2026-11-14T10:00:02Z"), isError: false, refused: false, output, ...over }] }] });

test("piece 2: with no session reader the step is attested: four questions, answers verbatim, one attested line", async () => {
  const w = world();
  w.deps.launchHost = async () => { addRow(w); return { code: 0, signal: null }; };
  w.answer = (q) => (/result/i.test(q) ? "1" : /permission/i.test(q) ? "no prompt, I chose nothing" : /typed/i.test(q) || /type/i.test(q) ? "git status" : "Bash(git status) shown as typed");
  w.parts.e1a = () => hostStep();
  assert.equal(await e1a(w), 0);
  assert.equal(w.asked.length, 4);
  const t = raw(w);
  assert.match(t, /ATTESTED H A: no prompt, I chose nothing/);
  assert.match(t, /ATTESTED H A: Bash\(git status\) shown as typed/);
  assert.match(t, /\[evidence H \(pi, behaviour\): attested pass\]/);
  assert.match(t, /\[ledger window \.claude\/context-economy\/gateway-ledger-pi: 1 new row; 2026-11-14T10:00:01Z rewrite=applied is_error=false\]/);
});
test("piece 2: attestation says pass but the ledger has no new row: the step fails", async () => {
  const w = world();
  w.parts.e1a = () => [...hostStep(), { id: "N", run: [["never"]] }];
  assert.equal(await e1a(w), 1);
  assert.match(raw(w), /attested fail: expected 1 new ledger row, found 0/);
  assert.ok(!w.execs.some((e) => e.cmd === "never"));
});
test("piece 2: attestation says pass but the ledger has two new rows: the step fails", async () => {
  const w = world();
  w.deps.launchHost = async () => { addRow(w); addRow(w); return { code: 0, signal: null }; };
  w.parts.e1a = () => hostStep();
  assert.equal(await e1a(w), 1);
  assert.match(raw(w), /found 2/);
});
test("piece 2: a stale applied row from before the host started does not count", async () => {
  const w = world();
  addRow(w, { ts: "2026-11-14T08:00:00Z" });
  w.parts.e1a = () => hostStep();
  assert.equal(await e1a(w), 1);
  assert.match(raw(w), /found 0/);
});
test("piece 2: the operator reports a result other than the one the step requires: fail", async () => {
  const w = world();
  w.deps.launchHost = async () => { addRow(w); return { code: 0, signal: null }; };
  w.answer = (q) => (/result/i.test(q) ? "2" : "x");
  w.parts.e1a = () => hostStep();
  assert.equal(await e1a(w), 1);
  assert.match(raw(w), /reported result 2/);
});
test("piece 2: an uninstall step passes on plain output and no new row, and fails on a new row", async () => {
  const w = world();
  w.answer = (q) => (/result/i.test(q) ? "2" : "x");
  w.parts.e1a = () => hostStep(UNINSTALL_EVID);
  assert.equal(await e1a(w), 0);
  const w2 = world();
  w2.answer = w.answer;
  w2.deps.launchHost = async () => { addRow(w2); return { code: 0, signal: null }; };
  w2.parts.e1a = () => hostStep(UNINSTALL_EVID);
  assert.equal(await e1a(w2), 1);
});
test("piece 2: a recognised session record is evaluated by the machine; no questions are asked", async () => {
  const w = world();
  w.deps.sessionReader = reader(modelOf());
  slowHost(w);
  w.parts.e1a = () => hostStep();
  assert.equal(await e1a(w), 0);
  assert.equal(w.asked.length, 0);
  assert.match(raw(w), /\[evidence H \(pi, behaviour\): machine pass\]/);
});
test("V2: the engine passes the real launch and exit times: a call hours before launch fails the machine check", async () => {
  const w = world();
  const old = modelOf();
  old.sessions[0].startedAt -= 7200_000;
  old.sessions[0].calls[0].startedAt -= 7200_000;
  old.sessions[0].calls[0].endedAt -= 7200_000;
  w.deps.sessionReader = reader(old);
  slowHost(w);
  w.parts.e1a = () => hostStep();
  assert.equal(await e1a(w), 1);
  assert.match(raw(w), /machine fail: .*before the host was launched/);
  assert.equal(w.asked.length, 0);
});
test("piece 2: a recognised session record that shows a failed call fails the step, whatever the operator would say", async () => {
  const w = world();
  w.deps.sessionReader = reader(modelOf(SHORT, { isError: true }));
  slowHost(w);
  w.parts.e1a = () => hostStep();
  assert.equal(await e1a(w), 1);
  assert.match(raw(w), /machine fail: .*3 \(error\)/);
  assert.equal(w.asked.length, 0);
});
test("piece 2: an unrecognised record, or a reader that throws, falls back to attestation", async () => {
  for (const r of [reader({ sessions: [{ id: 1 }] }), reader(() => "garbage"), { read: async () => { throw new Error("cannot read it"); } }]) {
    const w = world();
    w.deps.sessionReader = r;
    w.deps.launchHost = async () => { addRow(w); return { code: 0, signal: null }; };
    w.parts.e1a = () => hostStep();
    assert.equal(await e1a(w), 0);
    assert.equal(w.asked.length, 4);
    assert.match(raw(w), /attested pass/);
  }
});
test("piece 2: a reader that finds no session record (undefined) means attestation", async () => {
  const w = world();
  w.deps.sessionReader = reader(undefined);
  w.deps.launchHost = async () => { addRow(w); return { code: 0, signal: null }; };
  w.parts.e1a = () => hostStep();
  assert.equal(await e1a(w), 0);
  assert.equal(w.asked.length, 4);
});
test("piece 2: the host's non-zero exit is recorded and shown, and does not by itself fail a step with the evidence", async () => {
  const w = world();
  w.deps.launchHost = async () => { addRow(w); return { code: 1, signal: null }; };
  w.parts.e1a = () => hostStep();
  assert.equal(await e1a(w), 0);
  assert.match(raw(w), /\[pi exited 1\]/);
});
test("piece 2: Ctrl-C at an attestation question aborts the step; the real UI is closed", async () => {
  const w = world();
  const t = realTerminal();
  const ui = realUi({ input: t.input, output: t.output });
  w.deps.ui = { ...ui, tty: () => ({ stdin: true, stdout: true }) };
  w.deps.launchHost = async () => { addRow(w); return { code: 0, signal: null }; };
  w.parts.e1a = () => hostStep();
  const result = e1a(w);
  await waitFor(() => t.shown().includes("Press Enter"));
  t.input.write("\n");
  await waitFor(() => t.shown().includes("answer four questions"));
  t.input.write("\n");
  await waitFor(() => t.shown().includes("What did you type?"));
  t.input.write("\x03");
  assert.equal(await result, 130);
  assert.match(raw(w), /aborted at step H/);
  assert.equal(t.input.isPaused(), true);
});
test("V1: a stray Enter typed while the host runs is taken by the gate, not by a question; an empty answer is asked again", async () => {
  const w = world();
  const t = realTerminal();
  const ui = realUi({ input: t.input, output: t.output });
  w.deps.ui = { ...ui, tty: () => ({ stdin: true, stdout: true }) };
  w.deps.launchHost = async () => { addRow(w); t.input.write("\n"); return { code: 0, signal: null }; }; // the stray keystroke
  w.parts.e1a = () => hostStep();
  const result = e1a(w);
  await waitFor(() => t.shown().includes("Press Enter"));
  t.input.write("\n"); // the real Enter that starts the host
  await waitFor(() => t.shown().includes("What did you type?")); // reached with no further key: the stray Enter went to the gate
  t.input.write("\n"); // an empty line at the first question: asked again
  await waitFor(() => (t.shown().match(/What did you type\?/g) ?? []).length === 2);
  for (const a of ["git status", "Bash(git status)", "1", "no prompt"]) { t.input.write(`${a}\n`); await new Promise((r) => setTimeout(r, 40)); }
  assert.equal(await result, 0);
  const text = raw(w);
  assert.match(text, /ATTESTED H A: \n/); // the empty try stays in the transcript
  assert.match(text, /attested pass/);
  assert.equal(t.input.isPaused(), true);
});
test("piece 2: realUi.ask returns the line typed", async () => {
  const t = realTerminal();
  const ui = realUi({ input: t.input, output: t.output });
  const asking = ui.ask("Q? ");
  t.input.write("hello there\n");
  assert.equal(await asking, "hello there");
  assert.equal(t.input.isPaused(), true);
});

// --- E7: the proof module ------------------------------------------------------------------------------------------------

test("E7: dataLeft is the files uninstall leaves; the ledger folders and expectations have their own keys", () => {
  assert.deepEqual(proofToolGateway.dataLeft, ["config.json", "gateway-ledger", "gateway-ledger-pi"]);
  assert.deepEqual(proofToolGateway.ledgerDirs, { claude: ".claude/context-economy/gateway-ledger", pi: ".claude/context-economy/gateway-ledger-pi" });
  for (const e of proofToolGateway.behaviour) assert.deepEqual([e.command, e.result, e.ledger.rows, e.ledger.rewrite, e.ledger.is_error], ["git status", 1, 1, "applied", false]);
  for (const e of proofToolGateway.uninstall) assert.deepEqual([e.command, e.result, e.ledger.rows], ["git status", 2, 0]);
});
test("E7: every module entry makes valid step evidence, and the driver holds no plugin-specific folder name", async () => {
  const { evidenceFor } = await import("./e1-run.mjs");
  const { validateEvidence } = await import("./e1-evidence.mjs");
  for (const e of proofToolGateway.behaviour) assert.equal(validateEvidence(evidenceFor(proofToolGateway, e, "behaviour")), undefined);
  for (const e of proofToolGateway.uninstall) assert.equal(validateEvidence(evidenceFor(proofToolGateway, e, "uninstall")), undefined);
  assert.ok(!/gateway-ledger/.test(readFileSync(join(ROOT, "scripts", "e1-run.mjs"), "utf8")));
  assert.ok(!/tool-gateway/.test(readFileSync(join(ROOT, "scripts", "e1-run.mjs"), "utf8").replace(/\/\/.*|\/\*[\s\S]*?\*\//g, "")));
});
test("E7: a module with the old shape, or a bad ledger folder, is a stop", async () => {
  const dir = tmp("e1-proof-");
  const write = (body) => writeFileSync(join(dir, "tool-gateway.mjs"), `export default ${body};`);
  for (const body of [
    `{ name: "tool-gateway", hosts: ["claude"], behaviour: [], dataLeft: [{}] }`,
    `{ name: "tool-gateway", hosts: ["claude"], ledgerDirs: { claude: "../x" }, behaviour: [{ host: "claude", command: "git status", result: 1, ledger: { rows: 1 } }], uninstall: [], dataLeft: [] }`,
    `{ name: "tool-gateway", hosts: ["claude"], ledgerDirs: {}, behaviour: [], uninstall: [], dataLeft: [] }`,
  ]) {
    write(body);
    await assert.rejects(loadProofModules(MARKETPLACE, dir), /exporting/);
  }
});

// --- piece 2 P3 items: R1-R4, E9, E11, E12, E14 -------------------------------------------------------------------------

test("R1: stderr holding a version line does not win; stdout's 1.5.0 is recorded", async () => {
  const w = world();
  w.deps.exec = execWith(w, { claude: { code: 0, stdout: "2.1.300\n", out: "2.1.300\n" }, pi: { code: 0, stdout: "1.5.0\n", out: "9.9.9\n1.5.0\n" } });
  w.parts.e1b.baseline = () => [];
  assert.equal(await baseline(w), 0);
  assert.equal(stateOf(w).pi.version, "1.5.0");
});

test("R2: a step with no command, no human part and no `after` is refused before any step runs", async () => {
  for (const bad of [{ id: "N" }, { id: "N", run: [], expect: [] }]) {
    const w = world();
    w.parts.e1a = () => [{ id: "first", run: [["ran"]] }, bad];
    assert.equal(await e1a(w), 1);
    assert.ok(!w.execs.some((e) => e.cmd === "ran"));
    assert.match(w.err.join("\n"), /checks nothing/);
  }
});

test("R3: a human function with no `say`, an `after` that returns nothing, and a match function that returns null each stop with a reason", async () => {
  const cases = [
    [() => [{ id: "H", human: () => ({ host: "pi", evidence: EVID }), after: [OK] }], /say/],
    [() => [{ id: "A", run: [["x"]], after: [() => undefined] }], /returned no result/],
    [() => [{ id: "M", run: [["x"]], expect: [{ cmd: 0, match: () => null }] }], /`match` function returned nothing/],
  ];
  for (const [steps, re] of cases) {
    const w = world();
    w.parts.e1a = steps;
    assert.equal(await e1a(w), 1);
    const text = w.err.join("\n");
    assert.match(text, re);
    assert.ok(!/Cannot read properties/.test(text));
  }
});

test("R4: the real home and HOME are compared by resolved path (trailing slash, symlink)", async () => {
  const w = world();
  w.deps.realHome = `${w.home}/`;
  w.onExec = () => ({ code: 0, out: `${w.home}/x\n` });
  w.parts.e1a = () => [{ id: "F", run: [["x"]] }];
  assert.equal(await e1a(w), 0);
  let scrubbed = readFileSync(join(attempt(w), "0.1.3-macos-arm64.txt"), "utf8");
  assert.ok(scrubbed.includes(`home shown: ${w.home}`));
  assert.ok(scrubbed.includes(`${w.home}/x`));
  const w2 = world();
  const link = join(tmp("e1-link-"), "home-link");
  symlinkSync(w2.home, link);
  w2.deps.realHome = link;
  w2.onExec = () => ({ code: 0, out: `${w2.home}/x\n` });
  w2.parts.e1a = () => [{ id: "F", run: [["x"]] }];
  assert.equal(await e1a(w2), 0);
  scrubbed = readFileSync(join(attempt(w2), "0.1.3-macos-arm64.txt"), "utf8");
  assert.ok(scrubbed.includes("home shown:"));
});

test("E9: --version must be a dotted number", async () => {
  for (const v of ["../x", "1.2.3/..", "abc", "1..2", ""]) {
    const w = world();
    w.parts.e1a = () => [{ id: "A", run: [["x"]] }];
    assert.equal(await w.run(["e1a", "--version", v, "--platform", "macos-arm64", "--clone", w.clone]), 2);
    assert.equal(w.execs.length, 0);
  }
});

test("E11: a function match records the span of the command output, so the scrubbed-span notice can fire", async () => {
  const w = world();
  w.deps.realHome = "/Users/personal-account";
  w.onExec = () => ({ code: 0, out: "at /Users/personal-account/b\n" });
  w.parts.e1a = () => [{ id: "F", run: [["x"]], expect: [{ cmd: 0, match: (out) => out.includes("personal") }] }];
  assert.equal(await e1a(w), 0);
  assert.match(w.err.join("\n"), /an assertion of step F matched inside a scrubbed span/);
});

test("E12: SIGTERM and SIGHUP write an `aborted` line and exit 130, with no listener left behind", async () => {
  for (const sig of ["SIGTERM", "SIGHUP"]) {
    const w = world();
    w.onExec = () => new Promise(() => {});
    w.parts.e1a = () => [{ id: "S", run: [["hang"]] }];
    const result = e1a(w);
    await waitFor(() => w.signals.listenerCount(sig) > 0);
    w.signals.emit(sig);
    assert.equal(await result, 130);
    assert.match(raw(w), new RegExp(`aborted at step S \\(${sig}\\)`));
    assert.equal(w.signals.listenerCount(sig), 0);
  }
});

test("E12: realExec decodes a multi-byte character split across chunks", async () => {
  const bytes = Buffer.from("a✓b", "utf8");
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => { child.stdout.emit("data", bytes.subarray(0, 2)); child.stdout.emit("data", bytes.subarray(2)); child.emit("close", 0, null); });
    return child;
  };
  const r = await realExec("x", [], { cwd: ROOT, env: {}, spawn });
  assert.equal(r.stdout, "a✓b");
  assert.equal(r.out, "a✓b");
});

test("E12: an unparseable Claude settings file stops a Claude step before the host starts", async () => {
  const w = world();
  mkdirSync(join(w.home, ".claude"), { recursive: true });
  writeFileSync(join(w.home, ".claude", "settings.json"), "{ not json");
  w.parts.e1a = () => [{ id: "H", human: { host: "claude", say: ["x"], evidence: EVID }, after: [OK] }];
  assert.equal(await e1a(w), 1);
  assert.ok(!w.events.includes("host:claude"));
});

test("E14: the run saves a scrub context; `scrub --attempt` rebuilds a missing copy and never overwrites one", async () => {
  const w = world();
  w.onExec = () => ({ code: 0, out: "hello\n" });
  w.parts.e1a = () => [{ id: "A", run: [["x"]], expect: [{ cmd: 0, match: /hello/ }] }];
  assert.equal(await e1a(w), 0);
  const dir = attempt(w);
  const ctxFile = join(dir, "scrub-context.json");
  assert.equal(mode(ctxFile), 0o600);
  const saved = JSON.parse(readFileSync(ctxFile, "utf8"));
  assert.deepEqual(Object.keys(saved).sort(), ["assertSpans", "clone", "config", "home", "hostname", "label", "name", "realHome"]);
  assert.equal(saved.assertSpans.length, 1);
  // refuses to overwrite
  assert.equal(await w.run(["scrub", "--attempt", dir]), 2);
  assert.match(w.err.join("\n"), /does not overwrite/);
  // rebuilds when the copy is gone
  rmSync(join(dir, "0.1.3-macos-arm64.txt"));
  assert.equal(await w.run(["scrub", "--attempt", dir]), 0);
  assert.match(readFileSync(join(dir, "0.1.3-macos-arm64.txt"), "utf8"), /--- scrub report ---/);
  assert.equal(mode(join(dir, "0.1.3-macos-arm64.txt")), 0o600);
  // no context, no scrub
  assert.equal(await w.run(["scrub", "--attempt", tmp("e1-empty-")]), 2);
});

test("E10: the scan copy goes to the attempt folder, not the system temp folder", async () => {
  const w = world();
  const seen = [];
  w.deps.gitleaksRun = (bin, args, o) => { if (args[0] === "dir") seen.push(args.at(-1)); return spawnSync(bin, args, o); };
  w.parts.e1a = () => [{ id: "A", run: [["x"]] }];
  assert.equal(await e1a(w), 0);
  assert.ok(seen.length >= 3);
  assert.ok(seen.every((p) => p.startsWith(attempt(w))));
});

test("E12: managed settings given to the engine are read for a Claude step", async () => {
  const w = world();
  const managed = join(tmp("e1-managed-"), "managed-settings.json");
  writeFileSync(managed, JSON.stringify({ permissions: { defaultMode: "bypassPermissions" } }));
  w.deps.managedSettings = [managed];
  w.parts.e1a = () => [{ id: "H", human: { host: "claude", say: ["x"], evidence: EVID }, after: [OK] }];
  assert.equal(await e1a(w), 1);
  assert.match(w.err.join("\n"), /bypassPermissions/);
  assert.ok(!w.events.includes("host:claude"));
});

test("host floor: a version below the minimum is a stop, even as the first recording, and nothing runs", async () => {
  for (const [host, v] of [["claude", "2.1.272"], ["pi", "0.73.1"], ["pi", "0.99.9"]]) {
    const w = world();
    w.versions[host] = v;
    w.parts.e1b.baseline = () => [{ id: "N", run: [["never"]] }];
    assert.equal(await baseline(w), 1);
    assert.match(w.err.join("\n"), new RegExp(`${host} ${host === "claude" ? "2\\.1\\.273" : "1\\.0\\.0"} or later`));
    assert.ok(!w.execs.some((e) => e.cmd === "never"));
  }
});
test("host floor: the minimum versions themselves are accepted", async () => {
  const w = world();
  w.versions = { claude: "2.1.273", pi: "1.0.0" };
  w.parts.e1b.baseline = () => [];
  assert.equal(await baseline(w), 0);
});
test("host floor: a host that updates itself below the floor during a host step stops after it", async () => {
  const w = world();
  w.deps.launchHost = async () => { w.versions.pi = "0.73.1"; return { code: 0, signal: null }; };
  w.parts.e1a = () => [{ id: "H", human: { host: "pi", say: ["x"], evidence: EVID }, after: [OK] }];
  assert.equal(await e1a(w), 1);
  assert.match(w.err.join("\n"), /pi 1\.0\.0 or later/); // the floor message, not the earlier-than-recorded one (F2)
});

// --- V4-V9, W1 in the engine ---------------------------------------------------------------------------------------------

test("V4: an uninstall step stops when the old ledger file is replaced during the window, though no row was added", async () => {
  const w = world();
  addRow(w, { ts: "2026-11-14T09:00:00Z" });
  addRow(w, { ts: "2026-11-14T09:01:00Z" });
  w.deps.launchHost = async () => { writeFileSync(ledgerFile(w), JSON.stringify({ ts: "2026-11-14T09:02:00Z", rewrite: "applied", is_error: false }) + "\n"); return { code: 0, signal: null }; };
  w.parts.e1a = () => hostStep(UNINSTALL_EVID);
  assert.equal(await e1a(w), 1);
  assert.match(w.err.join("\n"), /changed or replaced/);
  assert.match(w.err.join("\n"), /a readable ledger that only grew during/);
  assert.ok(!/unexpected error/i.test(w.err.join("\n")));
});
test("V5: an attested behaviour step fails when the only new row is a day old", async () => {
  const w = world();
  w.deps.launchHost = async () => { addRow(w, { ts: "2026-11-13T10:00:01Z" }); return { code: 0, signal: null }; };
  w.parts.e1a = () => hostStep();
  assert.equal(await e1a(w), 1);
  assert.match(raw(w), /outside the host's launch-to-exit window/);
});
test("V6: the last transcript line and the final message say how many host steps were attested", async () => {
  const w = world();
  w.deps.launchHost = async () => { addRow(w); return { code: 0, signal: null }; };
  w.parts.e1a = () => hostStep();
  assert.equal(await e1a(w), 0);
  assert.equal(raw(w).trimEnd().split("\n").at(-1), "1 host step, 1 attested");
  assert.match(w.out.join("\n"), /passed \(1 host step, 1 attested\)/);
  const w2 = world();
  w2.parts.e1a = () => [{ id: "A", run: [["x"]] }];
  assert.equal(await e1a(w2), 0);
  assert.ok(!/attested/.test(raw(w2)));
  // G2: one machine step and one attested step must read `2 host steps, 1 attested`.
  const w3 = world();
  let n = 0;
  w3.deps.sessionReader = { read: async () => (++n === 1 ? modelOf() : undefined) };
  let ms = Date.parse("2026-11-14T10:00:00Z");
  w3.deps.now = () => new Date(ms);
  w3.deps.launchHost = async () => { addRow(w3, { ts: new Date(ms + 1000).toISOString() }); ms += 5000; return { code: 0, signal: null }; };
  w3.parts.e1a = () => [{ ...hostStep()[0], id: "H1" }, { ...hostStep()[0], id: "H2" }];
  await e1a(w3);
  assert.equal(raw(w3).trimEnd().split("\n").at(-1), "2 host steps, 1 attested");
});
test("V8: the final message names the one file to send; a scrub context of `null` is refused with a message", async () => {
  const w = world();
  w.parts.e1a = () => [{ id: "A", run: [["x"]] }];
  assert.equal(await e1a(w), 0);
  assert.match(w.out.join("\n"), new RegExp(`send ${attempt(w).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/0\\.1\\.3-macos-arm64\\.txt`));
  assert.match(w.out.join("\n"), /raw transcript and scrub-context\.json stay private/);
  const dir = attempt(w);
  for (const bad of ["null", "[]", "42", "{}", JSON.stringify({ name: "x" })]) {
    writeFileSync(join(dir, "scrub-context.json"), bad);
    w.err.length = 0;
    assert.equal(await w.run(["scrub", "--attempt", dir]), 2);
    assert.match(w.err.join("\n"), /not a scrub context/);
  }
});
test("W1: waitFor gives up after its deadline instead of polling forever", async () => {
  await assert.rejects(waitFor(() => false, 60), /not met within 60 ms/);
});

// The unit tests above hand `main` its parts; none of them start the driver as a command. When e1-run.mjs
// (an entry module with a top-level await) imported e1-parts.mjs, which imported e1-run.mjs back, Node found
// the circle unsettled and exited with no output. These two tests keep that from coming back.
test("nothing the engine loads imports the engine or the parts (no import circle)", () => {
  // Any quoted path that ends in e1-run.mjs or e1-parts.mjs, as a static or dynamic import, or a bare import.
  const toEngineOrParts = /["'][^"'\n]*\be1-(?:run|parts)\.mjs["']/;
  const scripts = join(ROOT, "scripts");
  const proofs = readdirSync(join(scripts, "proof")).filter((f) => f.endsWith(".mjs")).map((f) => join("proof", f));
  assert.ok(proofs.length > 0, "there is at least one proof module to check");
  for (const f of ["e1-core.mjs", "e1-helpers.mjs", "e1-evidence.mjs", "e1-scrub.mjs", ...proofs]) {
    assert.doesNotMatch(readFileSync(join(scripts, f), "utf8"), toEngineOrParts, `${f} must not import e1-run.mjs or e1-parts.mjs`);
  }
  assert.doesNotMatch(readFileSync(join(scripts, "e1-parts.mjs"), "utf8"), /["'][^"'\n]*\be1-run\.mjs["']/, "e1-parts.mjs imports from e1-core.mjs, not e1-run.mjs");
});
const REAL_PLATFORM = { "darwin-arm64": "macos-arm64", "linux-x64": "linux-x86_64" }[`${process.platform}-${process.arch}`];
/** Runs `prepare` as a command from the scripts folder under `root`, in a temp HOME with stub hosts; stdin is not a terminal. */
function runPrepareCommand(root) {
  const home = tmp("e1-entry-home-"), bin = tmp("e1-entry-bin-");
  for (const [n, v] of [["claude", "2.1.310"], ["pi", "1.0.0"]]) {
    writeFileSync(join(bin, n), `#!/bin/sh\necho ${v}\n`);
    chmodSync(join(bin, n), 0o755);
  }
  try {
    return spawnSync(process.execPath, [join(root, "scripts", "e1-run.mjs"), "prepare", "--platform", REAL_PLATFORM, "--drill", "t"], {
      env: { HOME: home, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` }, input: "", encoding: "utf8", timeout: 60000,
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
}
// stdin is not a terminal here, so the part stops at its first pause (P.3): that proves P.1 and P.2 ran.
const assertStarted = (r) => {
  assert.equal(r.status, 1, `exit ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /STOP at P\.3/);
  assert.doesNotMatch(r.stderr, /unsettled top-level await/);
};
const SKIP_PLATFORM = REAL_PLATFORM ? false : "no E1 platform name for this machine";
test("the driver starts as a command and runs a part (it does not exit silently)", { skip: SKIP_PLATFORM }, () => {
  assertStarted(runPrepareCommand(ROOT));
});
test("the driver still starts when a module it loads imports the engine back (no top-level await on the entry line)", { skip: SKIP_PLATFORM }, () => {
  // A copy of scripts/ (and the gitleaks config the scrub reads) with an import circle added: the entry line must not wait on it.
  const copy = realpathSync(tmp("e1-circle-copy-")); // the entry check compares real paths; macOS temp folders sit behind a symlink
  try {
    cpSync(join(ROOT, "scripts"), join(copy, "scripts"), { recursive: true });
    copyFileSync(join(ROOT, ".gitleaks.toml"), join(copy, ".gitleaks.toml"));
    appendFileSync(join(copy, "scripts", "e1-parts.mjs"), `\nimport "./e1-run.mjs";\n`);
    assertStarted(runPrepareCommand(copy));
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});
