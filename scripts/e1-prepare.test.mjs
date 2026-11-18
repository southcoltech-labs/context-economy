// SPDX-License-Identifier: Apache-2.0

// The `prepare` part (run sheet Part 0 after the account exists) and the engine's `pause` step, against fake
// commands in a temp HOME. The shell half (`e1-bootstrap.sh`) is tested at the end of this file, with --check-only.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { main, validateSteps } from "./e1-run.mjs";
import { MIN_HOST_VERSION, meetsFloor } from "./e1-helpers.mjs";
import { CLAUDE_PIN, listHome, parts, prepareSteps } from "./e1-parts.mjs";

const STAGING = "southcoltech-labs/context-economy";

function world(over = {}) {
  const home = mkdtempSync(join(tmpdir(), "e1prep-home-"));
  const clone = join(mkdtempSync(join(tmpdir(), "e1prep-parent-")), "context-economy");
  const w = { home, clone, execs: [], out: [], err: [], says: [], paused: 0, claude: false, pi: false, node: "v24.1.0", platform: "linux-x86_64", prefix: undefined, origin: `https://github.com/${STAGING}.git`, noMarketplace: false, piLink: "lrwxr-xr-x 1 u s 40 Nov 15 09:00 /h/.nvm/bin/pi -> ../lib/node_modules/@earendil-works/pi-coding-agent/bin/pi\n", clock: Date.parse("2026-11-15T09:00:00Z"), tty: true, ...over };
  w.uname = over.uname ?? (over.platform === "macos-arm64" ? "Darwin arm64\n" : "Linux x86_64\n");
  w.exec = async (cmd, args, o) => {
    w.execs.push({ cmd, args, cwd: o.cwd, path: o.env?.PATH });
    const ok = (out = "") => ({ code: 0, out });
    const sh = cmd === "bash" ? args[1] : "";
    if (cmd === "uname") return ok(w.uname);
    if (cmd === "node") return ok(`${w.node}\n`);
    if (cmd === "git" && args[0] === "--version") return ok("git version 2.50.0\n");
    if (cmd === "gitleaks") return w.gitleaks === null ? { code: 1, out: "" } : ok(`${w.gitleaks ?? "8.30.1"}\n`);
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

test("P.1 needs gitleaks 8.30.1 and says how to get it, before any install or sign-in", async () => {
  for (const gitleaks of [null, "8.29.0"]) {
    const w = world({ gitleaks });
    assert.equal(await w.run(), 1);
    assert.match(why(w), /STOP at P\.1/);
    assert.match(why(w), /bash scripts\/e1-bootstrap\.sh/);
    assert.ok(!w.curl && !w.claude, "nothing was installed");
    assert.equal(w.paused, 0, "no sign-in pause was reached");
  }
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
  assert.match(why(w), /not southcoltech-labs\/context-economy/);
  const ssh = world({ claude: true, pi: true, origin: `git@github.com:${STAGING}.git` });
  mkdirSync(join(ssh.clone, ".git"), { recursive: true }); mkdirSync(join(ssh.clone, ".claude-plugin"));
  writeFileSync(join(ssh.clone, ".claude-plugin", "marketplace.json"), "{}");
  assert.equal(await ssh.run(), 0, why(ssh));
  const fork = world({ claude: true, pi: true, origin: `https://github.com/${STAGING}-fork.git` });
  mkdirSync(join(fork.clone, ".git"), { recursive: true });
  mkdirSync(join(fork.clone, ".claude-plugin")); writeFileSync(join(fork.clone, ".claude-plugin", "marketplace.json"), "{}");
  // (the clone is otherwise complete, so only the origin check can stop it)
  assert.equal(await fork.run(), 1, "an origin that only starts with the staging name is another repository");
  assert.match(why(fork), /STOP at P\.4/);
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

/** Run e1-bootstrap.sh as the given system: a bin folder with only what the script needs, a fake `uname`, and node/git left out unless asked. */
async function bootstrap(system, { git = false, args = [], gitleaks = "8.30.1", prep, script: scriptOverride, env: extraEnv = {} } = {}) {
  const { spawnSync } = await import("node:child_process");
  const home = mkdtempSync(join(tmpdir(), "e1boot-"));
  const bin = mkdtempSync(join(tmpdir(), "e1bin-"));
  const link = (c) => spawnSync("ln", ["-s", spawnSync("which", [c], { encoding: "utf8" }).stdout.trim(), join(bin, c)]);
  for (const c of ["bash", "env", "grep", "sed", "date", "cat", "mktemp", "rm", ...(git ? ["git"] : [])]) link(c);
  writeFileSync(join(bin, "uname"), `#!/bin/sh\n[ "$1" = "-s" ] && echo ${system} || echo "${system} ${system === "Darwin" ? "arm64" : "x86_64"}"\n`, { mode: 0o755 });
  if (gitleaks) writeFileSync(join(bin, "gitleaks"), `#!/bin/sh\necho ${gitleaks}\n`, { mode: 0o755 });
  if (prep) prep({ home, bin });
  const script = scriptOverride ?? join(dirname(fileURLToPath(import.meta.url)), "e1-bootstrap.sh");
  const r = spawnSync("/bin/bash", [script, ...args], { env: { PATH: bin, HOME: home, ...extraEnv }, encoding: "utf8" });
  return { r, home, out: r.stdout + r.stderr };
}

test("T1: on macOS the bootstrap installs nothing and names what the admin account must install", async () => {
  const { r, home, out } = await bootstrap("Darwin");
  assert.equal(r.status, 1, out);
  assert.match(r.stdout, /Ask the admin account to install, machine-wide/);
  assert.match(r.stdout, /npm install -g --ignore-scripts @earendil-works\/pi-coding-agent/);
  assert.ok(!existsSync(join(home, ".nvm")));
});

test("U2: on Linux a missing git is an admin task; a missing Node with --check-only exits 1 and installs nothing", async () => {
  const noGit = await bootstrap("Linux");
  assert.equal(noGit.r.status, 1, noGit.out);
  assert.match(noGit.r.stdout, /Ask the admin account to install, machine-wide:\n  git/);
  const checkOnly = await bootstrap("Linux", { git: true, args: ["--check-only"] });
  assert.equal(checkOnly.r.status, 1, checkOnly.out);
  assert.match(checkOnly.r.stdout, /\(--check-only\) would install Node 24 with nvm/);
  assert.ok(!existsSync(join(checkOnly.home, ".nvm")));
  assert.doesNotMatch(checkOnly.out, /About to run/, "nothing was offered, let alone run");
});

test("gitleaks: the bootstrap needs exactly 8.30.1 before any sign-in and installs nothing it cannot verify", async () => {
  for (const [system, gitleaks] of [["Linux", null], ["Darwin", null], ["Linux", "8.29.0"]]) {
    const checkOnly = await bootstrap(system, { git: true, gitleaks, args: ["--check-only"] });
    assert.equal(checkOnly.r.status, 1, checkOnly.out);
    assert.match(checkOnly.r.stdout, /\(--check-only\) gitleaks 8\.30\.1 is missing/);
    assert.ok(!existsSync(join(checkOnly.home, ".local", "bin", "gitleaks")));
  }
  // With no curl in the bin folder the download fails and nothing is left behind.
  const noCurl = await bootstrap("Linux", { git: true, gitleaks: null });
  assert.equal(noCurl.r.status, 1, noCurl.out);
  assert.match(noCurl.out, /download failed \(stop\)/);
  assert.ok(!existsSync(join(noCurl.home, ".local", "bin", "gitleaks")));
  // A matching gitleaks passes the step (the run then goes on to the Node check).
  const fine = await bootstrap("Linux", { git: true, args: ["--check-only"] });
  assert.match(fine.r.stdout, /gitleaks: .*gitleaks is 8\.30\.1/);
});

/**
 * A fake nvm in the account. `nvm install` puts a Node 24 in front of PATH (with `loaded` it is already there when nvm.sh
 * is sourced); every call is logged to ~/.nvm/calls. `failInstall` makes `nvm install` fail; `outside` puts a Node 24 that
 * is not under ~/.nvm in front of PATH instead.
 */
function fakeNvm({ home }, { loaded = false, failInstall = false, outside = false } = {}) {
  const nodeDir = outside ? mkdtempSync(join(tmpdir(), "e1sys-")) : join(home, ".nvm", "versions", "node", "v24.0.0", "bin");
  mkdirSync(nodeDir, { recursive: true });
  mkdirSync(join(home, ".nvm"), { recursive: true });
  writeFileSync(join(nodeDir, "node"), "#!/bin/sh\necho v24.0.0\n", { mode: 0o755 });
  const put = `PATH="${nodeDir}:$PATH"; export PATH`;
  writeFileSync(join(home, ".nvm", "nvm.sh"), `nvm() { echo "$*" >> "$NVM_DIR/calls"; case "$1" in install) ${failInstall ? "return 1" : put} ;; esac; }\n${loaded ? put : ""}\n`);
}

test("Linux Node always comes from nvm: a system Node is not used, nvm is installed when it is missing, and one already there is reused", async () => {
  const systemNode = (c) => writeFileSync(join(c.bin, "node"), "#!/bin/sh\necho v26.0.0\n", { mode: 0o755 });
  // A system Node of 24 or later does not count: the plan is still nvm, and check-only installs nothing.
  const sys = await bootstrap("Linux", { git: true, args: ["--check-only"], prep: systemNode });
  assert.equal(sys.r.status, 1, sys.out);
  assert.match(sys.r.stdout, /\(--check-only\) would install Node 24 with nvm .* curl -o- https:\/\/raw\.githubusercontent\.com\/nvm-sh\/nvm\/.*install\.sh \| bash/);
  assert.ok(!existsSync(join(sys.home, ".nvm")));
  // nvm present, Node not loaded: nvm install 24 only, no download of the nvm installer.
  const reuse = await bootstrap("Linux", { git: true, args: ["--yes"], prep: (c) => fakeNvm(c, { loaded: false }) });
  assert.equal(reuse.r.status, 0, reuse.out);
  assert.match(reuse.r.stdout, /About to run: nvm install 24 \(nvm is already in /);
  assert.doesNotMatch(reuse.out, /raw\.githubusercontent\.com/);
  assert.match(reuse.r.stdout, /bootstrap: OK/);
  // nvm with Node 24 already loaded: nothing to do.
  const done = await bootstrap("Linux", { git: true, prep: (c) => fakeNvm(c, { loaded: true }) });
  assert.equal(done.r.status, 0, done.out);
  assert.match(done.r.stdout, /Node and git are fine\./);
  assert.doesNotMatch(done.out, /About to run/);
});

// --- the gitleaks download, with a fake curl and the real tar and checksum tools ---
const { createHash } = await import("node:crypto");
const { spawnSync: spawn2 } = await import("node:child_process");
const BOOTSTRAP = join(dirname(fileURLToPath(import.meta.url)), "e1-bootstrap.sh");
const HASHES = { Linux: /551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb/, Darwin: /b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5/ };

/** A gitleaks release archive holding a script that prints `version`; its sha256. */
function fakeArchive(version) {
  const d = mkdtempSync(join(tmpdir(), "e1gl-"));
  writeFileSync(join(d, "gitleaks"), `#!/bin/sh\necho ${version}\n`, { mode: 0o755 });
  writeFileSync(join(d, "extra"), "not wanted\n");
  const tgz = join(d, "gl.tgz");
  spawn2("tar", ["-czf", tgz, "-C", d, "gitleaks", "extra"]);
  return { tgz, sha: createHash("sha256").update(readFileSync(tgz)).digest("hex") };
}

/** Run the bootstrap with a fake curl that "downloads" the archive. `patchSha` puts the archive's hash into a scratch copy of the script. */
async function bootstrapDownload(system, { version = "8.30.1", patchSha = true, ...rest } = {}) {
  const a = fakeArchive(version);
  let script = readFileSync(BOOTSTRAP, "utf8");
  if (patchSha) { assert.match(script, HASHES[system]); script = script.replace(HASHES[system], a.sha); }
  const dir = mkdtempSync(join(tmpdir(), "e1scr-")); const scratch = join(dir, "e1-bootstrap.sh"); writeFileSync(scratch, script);
  const tmp = mkdtempSync(join(tmpdir(), "e1tmp-"));
  const prep = (c) => {
    for (const t of ["tar", "cut", "mkdir", "cp"]) spawn2("ln", ["-s", spawn2("which", [t], { encoding: "utf8" }).stdout.trim(), join(c.bin, t)]);
    const sum = spawn2("which", ["sha256sum"], { encoding: "utf8" }).stdout.trim() || spawn2("which", ["shasum"], { encoding: "utf8" }).stdout.trim();
    spawn2("ln", ["-s", sum, join(c.bin, sum.endsWith("shasum") ? "shasum" : "sha256sum")]);
    writeFileSync(join(c.bin, "curl"), `#!/bin/sh\n# curl -fsSL -o FILE URL\ncp "${a.tgz}" "$3"\n`, { mode: 0o755 });
    rest.prep?.(c);
  };
  const x = await bootstrap(system, { git: true, gitleaks: null, ...rest, script: scratch, env: { TMPDIR: tmp }, prep });
  return { ...x, tmp, installed: join(x.home, ".local", "bin", "gitleaks") };
}

test("C1: the gitleaks download is checked against its sha256, unpacked into ~/.local/bin, and checked for 8.30.1", async () => {
  for (const system of ["Linux", "Darwin"]) {
    const good = await bootstrapDownload(system, { prep: (c) => fakeNvm(c, { loaded: true }), args: ["--yes"] });
    assert.ok(existsSync(good.installed), `${system}: ${good.out}`);
    assert.match(good.r.stdout, /gitleaks: .*\.local\/bin\/gitleaks is 8\.30\.1/);
    assert.deepEqual(readdirSync(good.tmp), [], `${system}: the temp dir is removed`);
    assert.deepEqual(readdirSync(join(good.home, ".local", "bin")), ["gitleaks"], `${system}: only the named member is unpacked`);
    // The archive's own hash is not the pinned one: nothing is unpacked, nothing is left, and the stop says so.
    const bad = await bootstrapDownload(system, { patchSha: false });
    assert.equal(bad.r.status, 1, bad.out);
    assert.match(bad.r.stderr, /sha256 is [0-9a-f]{64}, expected [0-9a-f]{64} \(stop\)/);
    assert.ok(!existsSync(bad.installed));
    assert.deepEqual(readdirSync(bad.tmp), []);
    // A matching archive whose gitleaks reports another version is refused.
    const wrong = await bootstrapDownload(system, { version: "9.9.9" });
    assert.equal(wrong.r.status, 1, wrong.out);
    assert.match(wrong.r.stderr, /does not report 8\.30\.1 \(stop\)/);
  }
  // The Linux hash is the one the CI checks.
  const ci = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", ".github", "workflows", "ci.yml"), "utf8");
  assert.match(ci, HASHES.Linux);
});

test("--check-only reports gitleaks and still reports the Node and git state, then exits 1", async () => {
  const r = await bootstrap("Linux", { git: true, gitleaks: null, args: ["--check-only"], prep: (c) => fakeNvm(c, { loaded: true }) });
  assert.equal(r.r.status, 1, r.out);
  assert.match(r.r.stdout, /\(--check-only\) gitleaks 8\.30\.1 is missing/);
  assert.match(r.r.stdout, /Node and git are fine\./);
  assert.ok(!existsSync(join(r.home, ".local", "bin", "gitleaks")));
});

test("Linux nvm steps: install 24 then use 24 run; a failing install, or a Node that is not from nvm, stops", async () => {
  // A curl that leaves a mark: with nvm already in the account the nvm installer must not be fetched.
  const ok = await bootstrap("Linux", { git: true, args: ["--yes"], prep: (c) => { fakeNvm(c); writeFileSync(join(c.home, "curl-called"), ""); writeFileSync(join(c.bin, "curl"), `#!/bin/sh\necho called >> "${join(c.home, "curl-called")}"\n`, { mode: 0o755 }); } });
  assert.equal(ok.r.status, 0, ok.out);
  assert.equal(readFileSync(join(ok.home, "curl-called"), "utf8"), "", "nvm was present: its installer was not fetched");
  assert.deepEqual(readFileSync(join(ok.home, ".nvm", "calls"), "utf8").trim().split("\n"), ["install 24", "use 24"]);
  const failing = await bootstrap("Linux", { git: true, args: ["--yes"], prep: (c) => fakeNvm(c, { failInstall: true }) });
  assert.equal(failing.r.status, 1, failing.out);
  assert.match(failing.r.stderr, /nvm could not install Node 24 \(stop\)/);
  const outside = await bootstrap("Linux", { git: true, args: ["--yes"], prep: (c) => fakeNvm(c, { outside: true }) });
  assert.equal(outside.r.status, 1, outside.out);
  assert.match(outside.r.stderr, /node is not the one from nvm \(stop\)/);
});

// --- e1-test-run.sh, with a fake node standing in for the driver ---
const THIS = spawn2("uname", ["-sm"], { encoding: "utf8" }).stdout.trim();
const RUN_LABEL = { "Darwin arm64": "macos", "Linux x86_64": "linux" }[THIS];

function testRun({ prepareRc = 0, baselineRc = 0 } = {}) {
  const home = mkdtempSync(join(tmpdir(), "e1run-")); const bin = mkdtempSync(join(tmpdir(), "e1runbin-"));
  const log = join(home, "driver-calls");
  // The fake node answers --version and plays the driver: it writes a raw and a scrubbed transcript per run.
  const nodeBody = `#!/bin/sh
if [ "$1" = "--version" ]; then echo v24.0.0; exit 0; fi
echo "$2 $3" >> "${log}"
case "$2" in
  prepare) n=1; name=prepare-2026-11-17; rc=${prepareRc} ;;
  e1b) n=2; name=e1b-2026-11-17; rc=${baselineRc} ;;
esac
d="$HOME/e1-runs/t1/attempt-$n"; mkdir -p "$d"
echo secret > "$d/$name.raw.txt"; echo clean > "$d/$name.txt"; echo '{}' > "$d/scrub-context.json"
exit $rc
`;
  writeFileSync(join(bin, "gitleaks"), "#!/bin/sh\necho 8.30.1\n", { mode: 0o755 });
  if (RUN_LABEL === "linux") { fakeNvm({ home }, { loaded: true }); writeFileSync(join(home, ".nvm", "versions", "node", "v24.0.0", "bin", "node"), nodeBody, { mode: 0o755 }); }
  else writeFileSync(join(bin, "node"), nodeBody, { mode: 0o755 });
  const send = join(home, "out");
  const r = spawn2("/bin/bash", [join(dirname(fileURLToPath(import.meta.url)), "e1-test-run.sh"), RUN_LABEL, "--send", send], { env: { PATH: `${bin}:${process.env.PATH}`, HOME: home }, encoding: "utf8" });
  return { r, home, send, calls: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [], files: existsSync(send) ? readdirSync(send).sort() : [] };
}

test("e1-test-run.sh: bootstrap, prepare, baseline, then only the scrubbed files are collected", { skip: !RUN_LABEL }, () => {
  const t = testRun();
  assert.equal(t.r.status, 0, t.r.stdout + t.r.stderr);
  assert.deepEqual(t.calls, ["prepare --platform", "e1b --part"]);
  assert.deepEqual(t.files, ["attempt-1-prepare-2026-11-17.txt", "attempt-2-e1b-2026-11-17.txt", "e1-end.txt", "e1-start.txt"]);
  assert.match(readFileSync(join(t.send, "e1-start.txt"), "utf8"), /^\d{4}-\d\d-\d\dT[\d:]+Z\ndriver commit: /);
});

test("e1-test-run.sh: a failed prepare stops the chain, still collects, and exits with the driver's status", { skip: !RUN_LABEL }, () => {
  const t = testRun({ prepareRc: 3 });
  assert.equal(t.r.status, 3, t.r.stdout + t.r.stderr);
  assert.deepEqual(t.calls, ["prepare --platform"], "no baseline after a failed prepare");
  assert.deepEqual(t.files, ["attempt-1-prepare-2026-11-17.txt", "e1-end.txt", "e1-start.txt"]);
  const base = testRun({ baselineRc: 1 });
  assert.equal(base.r.status, 1);
  assert.ok(base.files.includes("attempt-2-e1b-2026-11-17.txt"));
});

test("e1-test-run.sh: the wrong label is refused before anything runs", () => {
  const other = RUN_LABEL === "linux" ? "macos" : "linux";
  const r = spawn2("/bin/bash", [join(dirname(fileURLToPath(import.meta.url)), "e1-test-run.sh"), other], { env: { PATH: process.env.PATH, HOME: mkdtempSync(join(tmpdir(), "e1run-")) }, encoding: "utf8" });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /use the other label/);
});
