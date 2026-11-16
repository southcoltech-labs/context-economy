// SPDX-License-Identifier: Apache-2.0

// The `prepare` part (run sheet Part 0 after the account exists) and the engine's `pause` step, against fake
// commands in a temp HOME. The shell half (`e1-bootstrap.sh`) is tested at the end of this file, with --check-only.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { main, validateSteps } from "./e1-run.mjs";
import { MIN_HOST_VERSION, meetsFloor } from "./e1-helpers.mjs";
import { CLAUDE_PIN, listHome, parts, prepareSteps } from "./e1-parts.mjs";

const STAGING = "southcoltech-labs/context-economy-preview";

function world(over = {}) {
  const home = mkdtempSync(join(tmpdir(), "e1prep-home-"));
  const clone = join(mkdtempSync(join(tmpdir(), "e1prep-parent-")), "context-economy-preview");
  const w = { home, clone, execs: [], out: [], err: [], says: [], paused: 0, claude: false, pi: false, node: "v24.1.0", platform: "linux-x86_64", prefix: undefined, origin: `https://github.com/${STAGING}.git`, noMarketplace: false, piLink: "lrwxr-xr-x 1 u s 40 Nov 15 09:00 /h/.nvm/bin/pi -> ../lib/node_modules/@earendil-works/pi-coding-agent/bin/pi\n", clock: Date.parse("2026-11-15T09:00:00Z"), tty: true, ...over };
  w.uname = over.uname ?? (over.platform === "macos-arm64" ? "Darwin arm64\n" : "Linux x86_64\n");
  w.exec = async (cmd, args, o) => {
    w.execs.push({ cmd, args, cwd: o.cwd, path: o.env?.PATH });
    const ok = (out = "") => ({ code: 0, out });
    const sh = cmd === "bash" ? args[1] : "";
    if (cmd === "uname") return ok(w.uname);
    if (cmd === "node") return ok(`${w.node}\n`);
    if (cmd === "git" && args[0] === "--version") return ok("git version 2.50.0\n");
    if (cmd === "git" && args[0] === "clone") { mkdirSync(join(args[2], ".git"), { recursive: true }); mkdirSync(join(args[2], ".claude-plugin")); if (!w.noMarketplace) writeFileSync(join(args[2], ".claude-plugin", "marketplace.json"), "{}"); return ok("Cloning\n"); }
    if (cmd === "git" && args[0] === "-C") return ok(`${w.origin}\n`);
    if (sh === "command -v claude") return w.claude ? ok("/h/.local/bin/claude\n") : { code: 1, out: "" };
    if (sh === "command -v pi") return w.pi ? ok("/usr/local/bin/pi\n") : { code: 1, out: "" };
    if (sh.startsWith("curl -fsSL https://claude.ai/install.sh")) { w.claude = true; w.curl = sh; return ok("installed\n"); }
    if (sh === "npm config get prefix") return ok(`${w.prefix ?? `${home}/.nvm/versions/node/v24.1.0`}\n`);
    if (sh.startsWith("npm install -g")) { w.pi = true; w.npm = sh; return ok("added 1 package\n"); }
    if (sh.startsWith("ls -l")) return ok(w.piLink);
    if (args[0] === "--version") return cmd === "claude" ? ok("2.1.310 (Claude Code)\n") : ok("1.5.0\n");
    return { code: 127, out: `fake: no such command ${cmd} ${args.join(" ")}\n` };
  };
  w.deps = {
    env: { HOME: home, PATH: "/usr/bin:/bin", TERM: "xterm", LANG: "C", USER: "u", SHELL: "/bin/zsh" },
    log: { log: (m) => w.out.push(m), error: (m) => w.err.push(m) }, exec: w.exec, runsDir: join(home, "e1-runs"),
    now: () => new Date(w.clock), signals: new EventEmitter(), hostname: "testbox", realHome: "/Users/nobody-real", managedSettings: [],
    ui: { tty: () => ({ stdin: w.tty, stdout: w.tty }), say: (l) => w.says.push(l), close: () => {},
      waitEnter: async () => { w.paused += 1; w.clock += 3_600_000; mkdirSync(join(home, ".claude"), { recursive: true }); } },
    ...over.deps,
  };
  w.run = (extra = []) => main(["prepare", "--platform", over.platform ?? "linux-x86_64", "--drill", "d1", "--clone", clone, ...extra], w.deps);
  w.transcript = () => readFileSync(join(w.deps.runsDir, "d1", "attempt-1", "prepare-2026-11-15.raw.txt"), "utf8");
  return w;
}
const why = (w) => `${w.err.join("\n")}`;

test("the prepare step data is valid, and refuses a platform it does not know", () => {
  assert.doesNotThrow(() => { for (const platform of ["macos-arm64", "linux-x86_64"]) validateSteps(prepareSteps({ platform, clone: "/c", staging: STAGING })); });
  assert.throws(() => prepareSteps({ platform: "windows", clone: "/c", staging: STAGING }), /needs --platform/);
  assert.equal(typeof parts.prepare, "function");
});

test("pause step data: needs lines, cannot also be a host step, and counts as something the step does", () => {
  assert.doesNotThrow(() => validateSteps([{ id: "x", pause: { say: ["do it"] } }]));
  assert.throws(() => validateSteps([{ id: "x", pause: { say: [] } }]), /pause\.say/);
  assert.throws(() => validateSteps([{ id: "x", pause: "do it" }]), /pause is not an object/);
  assert.throws(() => validateSteps([{ id: "x", pause: { say: ["a"] }, human: { host: "claude", say: ["a"] } }]), /pause or a host step/);
});

test("prepare runs with no clone and no plugin: installs the missing CLIs pinned, pauses for sign-in, clones, records the host versions", async () => {
  const w = world();
  assert.equal(await w.run(), 0, `${why(w)}\n${w.transcript?.().slice(-1500)}`);
  assert.match(w.curl, /^curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash -s 2\.1\.310$/);
  assert.equal(w.npm, "npm install -g --ignore-scripts @earendil-works/pi-coding-agent");
  assert.equal(w.paused, 1);
  assert.ok(existsSync(join(w.clone, ".claude-plugin", "marketplace.json")));
  const t = w.transcript();
  assert.match(t, /PAUSE \(operator\)/);
  assert.match(t, /\[operator confirmed at 2026-11-15T10:00:0\dZ\]/, "the clock ran through the pause");
  assert.match(t, /host versions, prepare: claude 2\.1\.310: first recording; pi 1\.5\.0: first recording/);
  assert.match(t, /clean check \(b\): OK/);
  const state = JSON.parse(readFileSync(join(w.deps.runsDir, "d1", "host-versions.json"), "utf8"));
  assert.equal(state.claude.version, "2.1.310");
  assert.ok(w.execs.filter((e) => e.cwd !== w.home && e.args[0] !== "clone").length === 0, "every command runs in the home folder, not in a clone that does not exist yet");
  assert.ok(w.execs.every((e) => e.path.startsWith(`${w.home}/.local/bin:`)), "~/.local/bin is on PATH for the installers' sake");
});

test("a CLI that is already installed is not installed again; an existing clone is not cloned again", async () => {
  const w = world({ claude: true, pi: true });
  mkdirSync(join(w.clone, ".git"), { recursive: true }); mkdirSync(join(w.clone, ".claude-plugin"));
  writeFileSync(join(w.clone, ".claude-plugin", "marketplace.json"), "{}");
  assert.equal(await w.run(), 0, why(w));
  assert.equal(w.curl, undefined); assert.equal(w.npm, undefined);
  assert.ok(!w.execs.some((e) => e.cmd === "git" && e.args[0] === "clone"));
});

test("a host version below the floor stops prepare at the version record", async () => {
  const w = world({ claude: true, pi: true });
  const real = w.exec;
  w.deps.exec = async (cmd, args, o) => (cmd === "claude" && args[0] === "--version" ? { code: 0, out: "2.1.100 (Claude Code)\n" } : real(cmd, args, o));
  assert.equal(await w.run(), 1);
  assert.match(why(w), /host version \(prepare\)/);
});

test("Node below 24 stops at P.1; the platform must match uname", async () => {
  const a = world({ node: "v22.5.0" });
  assert.equal(await a.run(), 1);
  assert.match(why(a), /STOP at P\.1/);
  const b = world({ uname: "Darwin arm64\n" });
  assert.equal(await b.run(), 1);
  assert.match(why(b), /STOP at P\.1/);
});

test("a pause without a terminal stops instead of waiting", async () => {
  const w = world({ tty: false });
  assert.equal(await w.run(), 1);
  assert.match(why(w), /terminal on stdin and stdout for a pause/);
  assert.equal(w.paused, 0);
});

test("a stale product folder stops clean check (b) at P.5", async () => {
  const w = world();
  const ask = w.deps.ui.waitEnter;
  w.deps.ui.waitEnter = async () => { await ask(); mkdirSync(join(w.home, ".claude", "context-economy"), { recursive: true }); };
  assert.equal(await w.run(), 1);
  assert.match(why(w), /STOP at P\.5/);
});

test("a baseline run after prepare finds the recorded host versions in the same drill folder", async () => {
  const w = world();
  assert.equal(await w.run(), 0, why(w));
  const file = join(w.deps.runsDir, "d1", "host-versions.json");
  assert.ok(existsSync(file));
  // The baseline needs no first recording of its own: its part-start read matches what prepare recorded.
  const { HostVersions } = await import("./e1-run.mjs");
  const v = new HostVersions({ file, requireState: false });
  assert.doesNotThrow(() => v.record("claude", "2.1.310", "part start", new Date()));
});

test("a prepare run with a malformed --drill is refused", async () => {
  const w = world();
  assert.equal(await main(["prepare", "--platform", "linux-x86_64", "--drill", "../x", "--clone", w.clone], w.deps), 2);
});

test("a prepare run that stops before the clone exists still gets a scrubbed copy, with the driver's own gitleaks config", async () => {
  const w = world({ node: "v22.0.0" });
  assert.equal(await w.run(), 1);
  assert.ok(!existsSync(w.clone));
  assert.ok(existsSync(join(w.deps.runsDir, "d1", "attempt-1", "prepare-2026-11-15.txt")), why(w));
  const ctx = JSON.parse(readFileSync(join(w.deps.runsDir, "d1", "attempt-1", "scrub-context.json"), "utf8"));
  assert.match(ctx.config, /\.gitleaks\.toml$/);
});

test("T6: scrub --attempt rebuilds from the saved config key, and refuses a config path that is neither the clone's nor the driver's own", async () => {
  const w = world({ node: "v22.0.0" });
  await w.run();
  const dir = join(w.deps.runsDir, "d1", "attempt-1");
  const { rmSync } = await import("node:fs");
  rmSync(join(dir, "prepare-2026-11-15.txt"));
  assert.equal(await main(["scrub", "--attempt", dir], w.deps), 0, why(w));
  assert.ok(existsSync(join(dir, "prepare-2026-11-15.txt")), "rebuilt with the saved (driver's own) config, though the clone has none");
  rmSync(join(dir, "prepare-2026-11-15.txt"));
  const file = join(dir, "scrub-context.json");
  const foreign = join(w.home, "other.toml"); writeFileSync(foreign, "title = 'x'\n");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), config: foreign }));
  w.err.length = 0;
  assert.equal(await main(["scrub", "--attempt", dir], w.deps), 2);
  assert.match(why(w), /neither the clone's nor the driver's own/);
});

test("T6: only prepare may fall back to the driver's gitleaks config; an e1a run with a clone that has none gets no scrubbed copy", async () => {
  const w = world();
  mkdirSync(join(w.clone, ".claude-plugin"), { recursive: true });
  writeFileSync(join(w.clone, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "context-economy", plugins: [{ name: "tool-gateway", source: "./plugins/tool-gateway" }] }));
  const code = await main(["e1a", "--version", "0.1.3", "--platform", "linux-x86_64", "--clone", w.clone], w.deps);
  assert.notEqual(code, 0);
  assert.match(why(w), /\.gitleaks\.toml is missing/);
  assert.ok(!existsSync(join(w.deps.runsDir, "0.1.3-linux-x86_64", "attempt-1", "0.1.3-linux-x86_64.txt")));
});

test("the bash-clean check (a) and bootstrap script: clean account passes; each dirty condition fails; --check-only installs nothing", async () => {
  const { spawnSync } = await import("node:child_process");
  const script = join(dirname(fileURLToPath(import.meta.url)), "e1-bootstrap.sh");
  const run = (home, extraEnv = {}) => {
    const env = { PATH: process.env.PATH, HOME: home, ...extraEnv };
    return spawnSync("bash", [script, "--check-only"], { env, encoding: "utf8" });
  };
  const clean = mkdtempSync(join(tmpdir(), "e1boot-"));
  const ok = run(clean);
  assert.match(ok.stdout, /clean check \(a\): OK/);
  const dirty = mkdtempSync(join(tmpdir(), "e1boot-")); mkdirSync(join(dirty, ".pi"));
  const a = run(dirty); assert.equal(a.status, 1); assert.match(a.stdout, /\.pi: PRESENT/);
  const b = run(clean, { CE_RTK_BIN: "/x" }); assert.equal(b.status, 1); assert.match(b.stdout, /CE_RTK_BIN is set/);
  const bad = spawnSync("bash", [script, "--nope"], { env: { PATH: process.env.PATH, HOME: clean }, encoding: "utf8" });
  assert.equal(bad.status, 2);
});

test("T1: on macOS a missing Pi stops and names what the admin account must run; nothing is installed", async () => {
  const w = world({ platform: "macos-arm64", claude: true });
  assert.equal(await w.run(), 1);
  assert.match(why(w), /STOP at P\.2/);
  assert.match(why(w), /ask the admin account to run `npm install -g --ignore-scripts @earendil-works\/pi-coding-agent`/);
  assert.equal(w.npm, undefined);
  const ok = world({ platform: "macos-arm64", claude: true, pi: true });
  assert.equal(await ok.run(), 0, why(ok));
  assert.equal(ok.npm, undefined);
});

test("T1: on Linux a system npm prefix stops before the install, with a message about root", async () => {
  const w = world({ prefix: "/usr" });
  assert.equal(await w.run(), 1);
  assert.match(why(w), /needs root/);
  assert.equal(w.npm, undefined);
});

test("T3: an existing folder at the clone path whose origin is another repository stops at P.4", async () => {
  const w = world({ claude: true, pi: true, origin: "https://github.com/someone/else.git" });
  mkdirSync(join(w.clone, ".git"), { recursive: true });
  assert.equal(await w.run(), 1);
  assert.match(why(w), /STOP at P\.4/);
  assert.match(why(w), /not southcoltech-labs\/context-economy-preview/);
  const ssh = world({ claude: true, pi: true, origin: `git@github.com:${STAGING}.git` });
  mkdirSync(join(ssh.clone, ".git"), { recursive: true }); mkdirSync(join(ssh.clone, ".claude-plugin"));
  writeFileSync(join(ssh.clone, ".claude-plugin", "marketplace.json"), "{}");
  assert.equal(await ssh.run(), 0, why(ssh));
});

test("T4: the 0.4 listing goes three levels below the start folder and no deeper", () => {
  const home = mkdtempSync(join(tmpdir(), "e1list-"));
  mkdirSync(join(home, ".claude", "a", "b", "c", "d"), { recursive: true });
  const out = listHome(home).out;
  assert.match(out, /^~\/\.claude\/a\/b\/c$/m, "level 3 is listed");
  assert.doesNotMatch(out, /\/c\/d$/m, "level 4 is not");
  assert.match(out, /^~\/\.pi: No such file or directory$/m);
});

test("T5: the Claude Code pin meets the version floor", () => {
  assert.ok(meetsFloor("claude", CLAUDE_PIN), `${CLAUDE_PIN} is below ${MIN_HOST_VERSION.claude}`);
});

test("T7: a clone without marketplace.json stops at P.4; a pi that is not linked into node_modules stops at P.5", async () => {
  const a = world({ noMarketplace: true });
  assert.equal(await a.run(), 1);
  assert.match(why(a), /STOP at P\.4/);
  const b = world({ piLink: "lrwxr-xr-x 1 u s 10 Nov 15 09:00 /usr/bin/pi -> /opt/pi/pi\n" });
  assert.equal(await b.run(), 1);
  assert.match(why(b), /STOP at P\.5/);
});

test("T1: on macOS the bootstrap installs nothing and names what the admin account must install", async () => {
  const { spawnSync } = await import("node:child_process");
  if (spawnSync("uname", ["-s"], { encoding: "utf8" }).stdout.trim() !== "Darwin") return;
  const home = mkdtempSync(join(tmpdir(), "e1boot-"));
  const script = join(dirname(fileURLToPath(import.meta.url)), "e1-bootstrap.sh");
  // A PATH with no node and no git (the system's own /usr/bin git is a stub, so use a bin folder holding only what the script needs).
  const bin = mkdtempSync(join(tmpdir(), "e1bin-"));
  for (const c of ["bash", "env", "grep", "sed", "uname", "date", "cat"]) spawnSync("ln", ["-s", spawnSync("which", [c], { encoding: "utf8" }).stdout.trim(), join(bin, c)]);
  const r = spawnSync("/bin/bash", [script], { env: { PATH: bin, HOME: home }, encoding: "utf8" });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /Ask the admin account to install, machine-wide/);
  assert.match(r.stdout, /npm install -g --ignore-scripts @earendil-works\/pi-coding-agent/);
  assert.ok(!existsSync(join(home, ".nvm")));
});
