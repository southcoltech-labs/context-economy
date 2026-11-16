#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0

// E1 driver: runs a part of the E1a or E1b procedure, writes the transcript itself and checks every
// step's assertions. Piece 1: the engine, the transcript, the scrubber and the guards. The evidence
// evaluator for host steps is piece 2 and the step data piece 3; this file runs whatever steps it is
// given.
//
//   node scripts/e1-run.mjs e1a --version 0.1.3 --platform macos-arm64
//   node scripts/e1-run.mjs e1b --part baseline --a 0.1.2 [--drill e1b-2026-11-13]
//   node scripts/e1-run.mjs scrub --attempt <attempt folder>   (rebuilds a scrubbed copy; never overwrites one)
//
// A part is a list of steps, as data:
//   { id, title, run: [argv | { label, fn }] | (ctx) => [...], cwd?,
//     expect: [{ cmd, code?, match?, notMatch? }], human?: { host, say, before? }, after: [fn(ctx, info)],
//     set?: (ctx, results) => void }
// The first failed assertion stops the part: the step, what was expected, what it got, and "send the
// transcript to the engineer". There is no retry or skip, and no later step runs.
//
// Guards: the driver refuses to start when CLAUDE_CONFIG_DIR, PI_CODING_AGENT_DIR or CE_RTK_BIN is set;
// every command and host gets the allow-listed environment only; `claude update` and `pi update` are
// refused; host versions are read at part start and around each host step (earlier stops, later is
// recorded; below the floor of claude 2.1.273 and pi 1.0.0, see MIN_HOST_VERSION, always stops); a human step needs a terminal, closes the driver's own readline before the host starts,
// and ignores SIGINT while the host runs.
//
// Two roots (E13): the gitleaks config comes from the clone under test (`--clone`), because that is
// the file CI applies to the tree being released; the proof modules come from this driver's own
// checkout, because they are the driver's tooling, and a plugin under test must not choose the code
// that judges it.
//
// Output: ~/e1-runs/<V>-<platform>/ (E1a) or ~/e1-runs/<drill>/ (E1b), mode 0700, one attempt-<n>/ per
// run, files 0600: the raw transcript, written as the run goes, and the scrubbed copy, made at the end
// from the complete raw file, only when gitleaks ran correctly (see e1-scrub.mjs).
import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, realpathSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PLATFORMS } from "./check-release-proof.mjs";
import { MIN_HOST_VERSION, allowedEnv, judgeVersion, meetsFloor, permissionMode, refuseEnvironment, refuseUpdate } from "./e1-helpers.mjs";
import { QUESTIONS, askQuestions, evaluate, evaluateAttested, ledgerCursor, ledgerWindow, validModel, validateEvidence } from "./e1-evidence.mjs";
import { hitsReport, overlaps, scrub } from "./e1-scrub.mjs";

export const HOSTS = ["claude", "pi"];
const HERE = dirname(fileURLToPath(import.meta.url));
const STOP_LINE = "Send the transcript to the engineer.";

/** A failed assertion: the part stops. */
export class StopError extends Error {
  constructor({ step, expected, got }) {
    super(`${step}: expected ${expected}; got ${got}`);
    this.step = step; this.expected = expected; this.got = got;
  }
}
/** The driver was interrupted outside a host step. */
export class AbortError extends Error {}

const clip = (s, n = 600) => (String(s).length > n ? `${String(s).slice(0, n)}…` : String(s));
const quote = (a) => (/^[A-Za-z0-9_@%+=:,./#^{}~-]+$/.test(a) ? a : `'${a.replaceAll("'", `'\\''`)}'`);
const asText = (r) => r.out ?? [r.stdout, r.stderr].filter(Boolean).join("\n");

// --- output folders ------------------------------------------------------------------------------

/** Creates `dir` with mode 0700 (and sets it, whatever the umask). */
function privateDir(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/** A new attempt-<n> folder under `folder`: an earlier attempt is never overwritten or appended to. */
export function newAttempt(folder) {
  privateDir(folder);
  const taken = readdirSync(folder).map((n) => /^attempt-(\d+)$/.exec(n)?.[1]).filter(Boolean).map(Number);
  const n = Math.max(0, ...taken) + 1;
  const dir = join(folder, `attempt-${n}`);
  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, 0o700);
  return { n, dir };
}

/** The raw transcript: appended as the run goes, kept in memory too so offsets are known. */
class Transcript {
  constructor(file) {
    this.fd = openSync(file, "wx", 0o600);
    chmodSync(file, 0o600);
    this.text = "";
  }
  append(s) {
    const at = this.text.length;
    writeSync(this.fd, s);
    this.text += s;
    return at;
  }
  close() { closeSync(this.fd); }
}

// --- host versions -------------------------------------------------------------------------------

/**
 * The versions recorded so far, per host, kept in a state file. Rule (owner, 2026-11-14): a later
 * version is recorded and the run goes on; an earlier one, or one that does not parse, is a stop.
 * After the baseline a missing or unreadable state file is a stop, not a first recording.
 */
export class HostVersions {
  constructor({ file, requireState }) {
    this.file = file;
    this.requireState = requireState;
    this.state = { claude: undefined, pi: undefined, history: [] };
    if (existsSync(file)) {
      try {
        const s = JSON.parse(readFileSync(file, "utf8"));
        if (!s || typeof s !== "object" || !Array.isArray(s.history)) throw new Error("not a state object");
        this.state = s;
      } catch (e) {
        throw new StopError({ step: "host versions", expected: `a readable state file ${file}`, got: e.message });
      }
    } else if (requireState) {
      throw new StopError({ step: "host versions", expected: `the drill state file ${file} from the baseline`, got: "missing (a part after the baseline never makes a first recording)" });
    }
  }
  /** Judges one host's reading; records it when first or later. Returns the transcript line. */
  record(host, reading, where, now) {
    const recorded = this.state[host]?.version;
    const { verdict } = judgeVersion(recorded, reading);
    if (verdict === "unreadable") throw new StopError({ step: `host version (${where})`, expected: `a version number from \`${host} --version\``, got: clip(reading) || "(nothing)" });
    if (!meetsFloor(host, reading)) throw new StopError({ step: `host version (${where})`, expected: `${host} ${MIN_HOST_VERSION[host] ?? "(no floor is defined for this host)"} or later (the lowest supported version)`, got: `${host} ${reading}` });
    if (verdict === "earlier") throw new StopError({ step: `host version (${where})`, expected: `${host} ${recorded} or later`, got: `${host} ${reading}` });
    if (verdict === "first" && this.requireState) throw new StopError({ step: `host version (${where})`, expected: `a ${host} version recorded in the state file by the baseline`, got: "none recorded" });
    if (verdict !== "same") {
      this.state[host] = { version: reading, at: now.toISOString() };
      this.state.history.push({ host, version: reading, where, at: now.toISOString(), verdict });
      this.save();
    }
    return `${host} ${reading}: ${verdict === "first" ? "first recording" : verdict === "later" ? `later than ${recorded}: recorded` : "same as recorded"}`;
  }
  save() {
    writeFileSync(this.file, JSON.stringify(this.state, null, 2) + "\n", { mode: 0o600 });
    chmodSync(this.file, 0o600);
  }
}

/** The step evidence for one `behaviour` or `uninstall` entry of a proof module (E7: the module owns the ledger folder names). */
export const evidenceFor = (module, entry, kind) => ({ kind, command: entry.command, result: entry.result, ledgerDir: module.ledgerDirs?.[entry.host], ledger: entry.ledger });

// --- proof modules -------------------------------------------------------------------------------

/**
 * Every plugin in marketplace.json needs a proof module in `dir`: a listed plugin without one is a
 * stop, never a skip. A module is `{ name, hosts, behaviour, dataLeft }`.
 */
export async function loadProofModules(marketplace, dir = join(HERE, "proof"), importModule = (f) => import(pathToFileURL(f).href)) {
  const modules = [];
  for (const { name } of marketplace.plugins ?? []) {
    if (typeof name !== "string" || !/^[a-z0-9-]+$/.test(name)) throw new StopError({ step: "proof modules", expected: "a plugin name of [a-z0-9-] only", got: JSON.stringify(name) });
    const file = join(dir, `${name}.mjs`);
    if (!existsSync(file)) throw new StopError({ step: "proof modules", expected: `scripts/proof/${name}.mjs for plugin ${name} listed in marketplace.json`, got: "no such module (a listed plugin is never skipped)" });
    const m = (await importModule(file)).default;
    const bad = !m || m.name !== name || !Array.isArray(m.hosts) || m.hosts.some((h) => !HOSTS.includes(h))
      || !m.ledgerDirs || typeof m.ledgerDirs !== "object" || m.hosts.some((h) => typeof m.ledgerDirs[h] !== "string")
      || !Array.isArray(m.behaviour) || !Array.isArray(m.uninstall)
      || !Array.isArray(m.dataLeft) || m.dataLeft.some((f) => typeof f !== "string")
      || [...m.behaviour, ...m.uninstall].some((e) => !m.hosts.includes(e?.host) || validateEvidence(evidenceFor(m, e, "proof")) !== undefined);
    if (bad) throw new StopError({ step: "proof modules", expected: `scripts/proof/${name}.mjs exporting { name: "${name}", hosts, ledgerDirs, behaviour, uninstall, dataLeft }`, got: "another shape" });
    modules.push(m);
  }
  return modules;
}

// --- default dependencies ------------------------------------------------------------------------

/** Runs a command with pipes, keeping stdout and stderr in arrival order, whole, before anything reads it. */
export function realExec(cmd, args, { cwd, env, echo = false, spawn = nodeSpawn } = {}) {
  return new Promise((resolveRun) => {
    let out = "";
    let stdout = "";
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    // One decoder per stream: a multi-byte character split across chunks stays whole (E12).
    const take = (stream, own) => {
      const dec = new StringDecoder("utf8");
      return {
        data: (chunk) => { const t = dec.write(chunk); out += t; if (own) stdout += t; if (echo) stream.write(chunk); },
        end: () => { const t = dec.end(); out += t; if (own) stdout += t; },
      };
    };
    const so = take(process.stdout, true), se = take(process.stderr, false);
    child.stdout?.on("data", so.data);
    child.stderr?.on("data", se.data);
    child.on("error", (e) => resolveRun({ code: 127, stdout, out: `${out}${cmd}: ${e.message}\n` }));
    child.on("close", (code, signal) => { so.end(); se.end(); resolveRun({ code: code ?? 128, stdout, out: signal ? `${out}[killed by ${signal}]\n` : out }); });
  });
}

/** The host as a foreground child on the driver's terminal; terminal modes are saved before and restored after. */
export function realLaunchHost(host, { cwd, env, spawn = nodeSpawn, stty = (args) => spawnSync("stty", args, { stdio: ["inherit", "pipe", "ignore"], encoding: "utf8" }) }) {
  return new Promise((resolveRun) => {
    const saved = stty(["-g"]);
    const restore = () => { if (saved.status === 0 && saved.stdout?.trim()) stty([saved.stdout.trim()]); };
    const child = spawn(host, [], { cwd, env, stdio: "inherit" });
    child.on("error", (e) => { restore(); resolveRun({ code: 127, signal: null, error: e.message }); });
    child.on("close", (code, signal) => { restore(); resolveRun({ code, signal }); });
  });
}

/** Prompts on the terminal. Each wait opens its own readline and closes it, so the host gets every keystroke. */
export function realUi({ input = process.stdin, output = process.stdout } = {}) {
  let rl;
  return {
    tty: () => ({ stdin: Boolean(input.isTTY), stdout: Boolean(output.isTTY) }),
    say: (text) => output.write(`${text}\n`),
    /** Resolves on Enter. Rejects with AbortError on Ctrl-C at the prompt (readline closes itself then, and says nothing to the process) or when the input ends. */
    waitEnter(prompt) {
      return new Promise((done, fail) => {
        rl = createInterface({ input, output });
        let answered = false;
        rl.on("SIGINT", () => { this.close(); fail(new AbortError("interrupted at the prompt")); });
        rl.on("close", () => { if (!answered) fail(new AbortError("input closed at the prompt")); });
        rl.question(`${prompt} `, () => { answered = true; this.close(); done(); });
      });
    },
    /** One question; one line back. Like waitEnter, it opens its readline and closes it, and rejects with AbortError on Ctrl-C or the end of input. */
    ask(prompt) {
      return new Promise((done, fail) => {
        rl = createInterface({ input, output });
        let answered = false;
        rl.on("SIGINT", () => { this.close(); fail(new AbortError("interrupted at a question")); });
        rl.on("close", () => { if (!answered) fail(new AbortError("input closed at a question")); });
        rl.question(prompt, (line) => { answered = true; this.close(); done(line); });
      });
    },
    close() { if (rl) { rl.close(); rl = undefined; } input.pause?.(); },
  };
}

export function defaultDeps(env = process.env) {
  return {
    env, log: console, exec: (c, a, o) => realExec(c, a, { ...o, echo: true }), launchHost: realLaunchHost, ui: realUi(),
    now: () => new Date(), signals: process, hostname: hostname(), realHome: userInfo().homedir,
  };
}

// --- the engine ----------------------------------------------------------------------------------

// --- step data validation (E1, E2) -----------------------------------------------------------------

const STEP_KEYS = ["id", "title", "run", "cwd", "expect", "human", "pause", "after", "set"];
const EXPECT_KEYS = ["cmd", "code", "match", "notMatch", "describe"];
const dataStop = (where, got) => new StopError({ step: `step data ${where}`, expected: "valid step data (an assertion that cannot run would pass silently)", got });

/** Checks a step's `expect` against the number of commands it has. Throws StopError. */
function validateExpect(step, where, ncmds) {
  if (step.expect !== undefined && !Array.isArray(step.expect)) throw dataStop(where, "expect is not a list");
  for (const [k, a] of (step.expect ?? []).entries()) {
    const at = `${where} expect[${k}]`;
    if (!a || typeof a !== "object" || Array.isArray(a)) throw dataStop(at, "not an object");
    const unknown = Object.keys(a).filter((key) => !EXPECT_KEYS.includes(key));
    if (unknown.length) throw dataStop(at, `unknown key ${unknown.join(", ")}`);
    if (!Number.isInteger(a.cmd)) throw dataStop(at, "no `cmd` (the index of the command it checks)");
    if (ncmds !== undefined && (a.cmd < 0 || a.cmd >= ncmds)) throw dataStop(at, `cmd ${a.cmd} names no command (the step has ${ncmds})`);
    if (a.code === undefined && a.match === undefined && a.notMatch === undefined) throw dataStop(at, "none of code, match, notMatch");
    if (a.code !== undefined && !Number.isInteger(a.code)) throw dataStop(at, "code is not an integer");
    if (a.match !== undefined && !(a.match instanceof RegExp) && typeof a.match !== "function") throw dataStop(at, "match is neither a RegExp nor a function");
    if (a.notMatch !== undefined && !(a.notMatch instanceof RegExp)) throw dataStop(at, "notMatch is not a RegExp");
  }
}

/** A human step needs a host and instructions (E1). */
function validateHuman(h, where) {
  if (!h || typeof h !== "object") throw dataStop(where, "human is not an object");
  if (!HOSTS.includes(h.host)) throw dataStop(where, `human.host is not ${HOSTS.join(" or ")}`);
  if (!Array.isArray(h.say) || !h.say.length || h.say.some((l) => typeof l !== "string")) throw dataStop(where, "human.say is not a non-empty list of lines");
  if (h.before !== undefined && typeof h.before !== "function") throw dataStop(where, "human.before is not a function");
  // E2: the evaluator is mandatory for every human step and step data cannot leave it out.
  const bad = validateEvidence(h.evidence);
  if (bad) throw dataStop(where, `human.evidence: ${bad}`);
}

/** A pause waits for the operator to do something the driver cannot (create an account, sign in); it judges nothing. */
function validatePause(p, where) {
  if (!p || typeof p !== "object") throw dataStop(where, "pause is not an object");
  if (!Array.isArray(p.say) || !p.say.length || p.say.some((l) => typeof l !== "string")) throw dataStop(where, "pause.say is not a non-empty list of lines");
}

/** Checks all step data before the first step runs. Throws StopError. */
export function validateSteps(steps) {
  if (!Array.isArray(steps)) throw dataStop("(all)", "steps is not a list");
  const seen = new Set();
  for (const [k, step] of steps.entries()) {
    if (!step || typeof step !== "object") throw dataStop(`#${k}`, "not an object");
    const where = typeof step.id === "string" && step.id ? step.id : `#${k}`;
    if (typeof step.id !== "string" || !step.id) throw dataStop(where, "no id");
    if (seen.has(step.id)) throw dataStop(where, "duplicate step id");
    seen.add(step.id);
    const unknown = Object.keys(step).filter((key) => !STEP_KEYS.includes(key));
    if (unknown.length) throw dataStop(where, `unknown key ${unknown.join(", ")}`);
    if (step.run !== undefined && typeof step.run !== "function") {
      if (!Array.isArray(step.run)) throw dataStop(where, "run is neither a list nor a function");
      for (const c of step.run) {
        const argv = Array.isArray(c) && c.length && c.every((x) => typeof x === "string");
        const fn = c && !Array.isArray(c) && typeof c.label === "string" && typeof c.fn === "function";
        if (!argv && !fn) throw dataStop(where, "a command is neither an argv of strings nor { label, fn }");
      }
      validateExpect(step, where, step.run.length);
    } else if (typeof step.run === "function") {
      if (step.expect !== undefined && !Array.isArray(step.expect)) throw dataStop(where, "expect is not a list");
    } else validateExpect(step, where, 0);
    if (step.after !== undefined && (!Array.isArray(step.after) || step.after.some((f) => typeof f !== "function"))) throw dataStop(where, "after is not a list of functions");
    if (step.set !== undefined && typeof step.set !== "function") throw dataStop(where, "set is not a function");
    if (step.pause !== undefined && step.human !== undefined) throw dataStop(where, "a step is a pause or a host step, not both");
    if (step.human !== undefined) {
      if (typeof step.human !== "function") validateHuman(step.human, where);
    }
    if (step.pause !== undefined && typeof step.pause !== "function") validatePause(step.pause, where);
    // R2: a step that checks nothing is the transcription error E1 is about.
    const commands = typeof step.run === "function" || (Array.isArray(step.run) && step.run.length > 0);
    if (!commands && step.human === undefined && step.pause === undefined && !(Array.isArray(step.after) && step.after.length)) throw dataStop(where, "a step with no command, no human part and no `after` checks nothing");
  }
}

/** Runs `steps`. Throws StopError at the first failed assertion and AbortError when interrupted outside a host. */
export async function runSteps(ctx, steps) {
  const { deps, transcript } = ctx;
  let hostRunning = false;
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  aborted.catch(() => {});
  const guard = (p) => Promise.race([p, aborted]);
  const onSigint = () => {
    if (hostRunning) { ctx.interrupts += 1; transcript.append(`[SIGINT while the host runs: the driver waits for it]\n`); return; }
    rejectAbort(new AbortError(`aborted at step ${ctx.step?.id ?? "(start)"}`));
  };
  // SIGTERM and SIGHUP end the part with an `aborted` line, whether or not a host is running (E12).
  const onTerm = (name) => () => rejectAbort(new AbortError(`aborted at step ${ctx.step?.id ?? "(start)"} (${name})`));
  const onSigterm = onTerm("SIGTERM"), onSighup = onTerm("SIGHUP");
  validateSteps(steps);
  deps.signals.on("SIGINT", onSigint);
  deps.signals.on("SIGTERM", onSigterm);
  deps.signals.on("SIGHUP", onSighup);
  try {
    for (const step of steps) {
      ctx.step = step;
      transcript.append(`\n=== ${step.id} ${step.title ?? ""} ===\n$ date -u +%FT%TZ\n${deps.now().toISOString().replace(/\.\d+Z$/, "Z")}\n`);
      const fail = (expected, got) => { throw new StopError({ step: `${step.id} ${step.title ?? ""}`.trim(), expected, got: clip(got) }); };
      const results = [];
      const cmds = typeof step.run === "function" ? step.run(ctx) : (step.run ?? []);
      if (typeof step.run === "function") {
        if (!Array.isArray(cmds)) throw dataStop(step.id, "run() did not return a list");
        validateExpect(step, step.id, cmds.length);
      }
      for (const [i, cmd] of cmds.entries()) {
        let r;
        if (Array.isArray(cmd)) {
          const refused = refuseUpdate(cmd[0], cmd.slice(1));
          transcript.append(`$ ${cmd.map(quote).join(" ")}\n`);
          if (refused) fail("a command the driver may run", refused);
          r = await guard(deps.exec(cmd[0], cmd.slice(1), { cwd: step.cwd ?? ctx.cwd, env: ctx.env }));
        } else {
          transcript.append(`$ ${cmd.label}\n`);
          r = await guard(Promise.resolve(cmd.fn(ctx)));
        }
        const out = asText(r);
        const offset = transcript.append(out.endsWith("\n") || out === "" ? out : `${out}\n`);
        transcript.append(`[exit ${r.code}]\n`);
        results.push({ code: r.code, out, offset });
        const mine = (step.expect ?? []).filter((a) => a.cmd === i);
        if (!mine.some((a) => a.code !== undefined) && r.code !== 0) fail(`exit code 0 from \`${Array.isArray(cmd) ? cmd.map(quote).join(" ") : cmd.label}\``, `exit code ${r.code}: ${out.trim()}`);
        for (const a of mine) checkExpect(a, results[i], ctx, fail);
      }
      if (step.pause) await pauseStep(ctx, step, { guard, fail });
      if (step.human) await humanStep(ctx, step, { guard, fail, setRunning: (v) => { hostRunning = v; } });
      for (const a of step.after ?? []) {
        const r = await guard(Promise.resolve(a(ctx, { results })));
        if (!r || typeof r !== "object") throw dataStop(step.id, "an `after` check returned no result ({ ok, expected, got })");
        if (!r.ok) fail(r.expected ?? "the step's assertion to hold", r.got ?? "it did not");
      }
      step.set?.(ctx, results);
    }
  } finally {
    deps.ui?.close?.(); // every way out: an open readline would hold stdin and the terminal in raw mode
    for (const [sig, fn] of [["SIGINT", onSigint], ["SIGTERM", onSigterm], ["SIGHUP", onSighup]]) deps.signals.off?.(sig, fn) ?? deps.signals.removeListener?.(sig, fn);
  }
}

function checkExpect(a, result, ctx, fail) {
  if (a.code !== undefined && result.code !== a.code) fail(`exit code ${a.code}`, `exit code ${result.code}: ${result.out.trim()}`);
  if (a.match instanceof RegExp) {
    const m = new RegExp(a.match.source, a.match.flags.replace("g", "")).exec(result.out);
    if (!m) fail(`output matching ${a.match}`, result.out.trim() || "(no output)");
    ctx.assertSpans.push({ step: ctx.step.id, start: result.offset + m.index, end: result.offset + m.index + m[0].length });
  } else if (typeof a.match === "function") {
    const r = a.match(result.out, ctx);
    if (r === null || r === undefined) throw dataStop(ctx.step.id, "a `match` function returned nothing (true, false or { ok, got })");
    const ok = typeof r === "object" ? r.ok : Boolean(r);
    // E11: a function has no match to point at, so the whole command output counts as its span.
    ctx.assertSpans.push({ step: ctx.step.id, start: result.offset, end: result.offset + result.out.length });
    if (!ok) fail(a.describe ?? "the output the step expects", (typeof r === "object" && r.got) || result.out.trim() || "(no output)");
  }
  if (a.notMatch instanceof RegExp) {
    const m = new RegExp(a.notMatch.source, a.notMatch.flags.replace("g", "")).exec(result.out);
    if (m) fail(`no output matching ${a.notMatch}`, m[0]);
  }
}

// A line that IS a version: an optional name, the number, an optional parenthesis. A notice such as
// "Update available: 1.5.2 (run pi update)" is not one.
const VERSION_LINE = /^(?:[A-Za-z][A-Za-z0-9_.-]*\s+)?v?(\d+\.\d+\.\d+)(?:\s+\([^()]*\))?$/;

/** The one version line in a `--version` output (stdout only), or undefined when there is none or several. */
export function parseVersionLine(stdout) {
  const found = String(stdout ?? "").split(/\r?\n/).map((l) => VERSION_LINE.exec(l.trim())).filter(Boolean);
  return found.length === 1 ? found[0][1] : undefined;
}

/** Reads both host versions; records, or stops. */
export async function readHostVersions(ctx, where) {
  const lines = [];
  for (const host of HOSTS) {
    const r = await ctx.deps.exec(host, ["--version"], { cwd: ctx.cwd, env: ctx.env });
    if (r.code !== 0) throw new StopError({ step: `host version (${where})`, expected: `\`${host} --version\` to run`, got: clip(asText(r)) || `exit ${r.code}` });
    const reading = parseVersionLine(r.stdout ?? r.out);
    if (reading === undefined) throw new StopError({ step: `host version (${where})`, expected: `exactly one version line from \`${host} --version\` on stdout`, got: clip(asText(r)) || "(nothing)" });
    lines.push(ctx.versions.record(host, reading, where, ctx.deps.now()));
  }
  ctx.transcript.append(`[host versions, ${where}: ${lines.join("; ")}]\n`);
}

/**
 * Waits for the operator. The part's clock keeps running (the transcript carries the time before and after),
 * and nothing is checked: that the operator did what was asked is theirs to say, not the driver's to verify.
 */
async function pauseStep(ctx, step, { guard, fail }) {
  const { deps, transcript } = ctx;
  const p = typeof step.pause === "function" ? step.pause(ctx) : step.pause;
  validatePause(p, step.id);
  const tty = deps.ui.tty();
  if (!tty.stdin || !tty.stdout) fail("a terminal on stdin and stdout for a pause", `stdin ${tty.stdin ? "is" : "is not"} a TTY, stdout ${tty.stdout ? "is" : "is not"} a TTY`);
  for (const l of ["", `>>> ${step.id}: do this, then come back:`, ...p.say.map((l) => `    ${l}`), ""]) deps.ui.say(l);
  transcript.append(`PAUSE (operator):\n${p.say.map((l) => `  ${l}`).join("\n")}\n`);
  try {
    await guard(deps.ui.waitEnter("Press Enter when done"));
  } catch (e) {
    deps.ui.close();
    throw e instanceof AbortError ? new AbortError(`aborted at step ${step.id}`) : e;
  }
  deps.ui.close();
  transcript.append(`[operator confirmed at ${deps.now().toISOString().replace(/\.\d+Z$/, "Z")}]\n`);
}

async function humanStep(ctx, step, { guard, fail, setRunning }) {
  const { deps, transcript } = ctx;
  const h = typeof step.human === "function" ? step.human(ctx) : step.human;
  validateHuman(h, step.id);
  const tty = deps.ui.tty();
  if (!tty.stdin || !tty.stdout) fail("a terminal on stdin and stdout for a human step", `stdin ${tty.stdin ? "is" : "is not"} a TTY, stdout ${tty.stdout ? "is" : "is not"} a TTY`);
  if (!HOSTS.includes(h.host)) fail(`host ${HOSTS.join(" or ")}`, h.host);
  if (h.host === "claude") {
    const mode = permissionMode({ home: ctx.env.HOME, cwd: ctx.cwd, ...(deps.managedSettings ? { managed: deps.managedSettings } : {}) });
    transcript.append(`[permission mode: ${mode.lines.join("; ") || "no settings file read"}]\n`);
    if (!mode.ok) fail("Claude Code in manual (default) permission mode", mode.problems.join("; "));
  }
  const say = ["", `>>> ${step.id}: do this in ${h.host}:`, ...h.say.map((l) => `    ${l}`), ""];
  for (const l of say) deps.ui.say(l);
  transcript.append(`HUMAN STEP (${h.host}):\n${h.say.map((l) => `  ${l}`).join("\n")}\n`);
  try {
    await guard(deps.ui.waitEnter(`Press Enter to start ${h.host}`));
  } catch (e) {
    deps.ui.close();
    throw e instanceof AbortError ? new AbortError(`aborted at step ${step.id}`) : e;
  }
  deps.ui.close();
  await readHostVersions(ctx, `before ${step.id}`);
  const cursor = h.before ? await h.before(ctx) : undefined;
  // The window starts here: the ledger's row counts and, when a session reader exists, its cursor.
  const ledgerBefore = ledgerCursor(ctx.env.HOME, h.evidence.ledgerDir);
  const sessionCursor = await deps.sessionReader?.cursor?.({ host: h.host, ctx });
  const launchedAt = deps.now();
  setRunning(true);
  let exit;
  try {
    exit = await deps.launchHost(h.host, { cwd: ctx.cwd, env: ctx.env });
  } finally {
    setRunning(false);
    deps.ui.restore?.();
  }
  const exitedAt = deps.now();
  transcript.append(`[${h.host} exited ${exit.code ?? exit.signal ?? "?"}${exit.error ? `: ${exit.error}` : ""}]\n`);
  if (exit.error) fail(`${h.host} to start`, `${exit.error} (exit ${exit.code ?? "?"})`);
  await readHostVersions(ctx, `after ${step.id}`);
  ctx.hostRuns.push({ step: step.id, host: h.host, cursor, launchedAt, exitedAt, exit });
  await judgeHostStep(ctx, step, h, { ledgerBefore, sessionCursor, launchedAt, exitedAt, exit }, { guard, fail });
}

/**
 * The evidence for a host step (e1-evidence.mjs). The host's exit proves nothing: with a recognised session
 * record the evaluator applies the design's rules to it; otherwise the operator is asked the fixed questions
 * and the step is marked `attested` in the transcript. The ledger is a machine check either way, and an
 * attestation never overrides it. A failed evidence check stops the part.
 */
async function judgeHostStep(ctx, step, h, window, { guard, fail }) {
  const { deps, transcript } = ctx;
  const evidence = h.evidence;
  let rows;
  try { rows = ledgerWindow(ctx.env.HOME, window.ledgerBefore); }
  catch (e) { transcript.append(`[ledger window ${evidence.ledgerDir}: ${e.message}]\n`); fail(`a readable ledger that only grew during ${step.id}`, e.message); }
  transcript.append(`[ledger window ${evidence.ledgerDir}: ${rows.length} new row${rows.length === 1 ? "" : "s"}${rows.map((r) => `; ${r.ts} rewrite=${r.rewrite} is_error=${r.is_error}`).join("")}]\n`);
  let model;
  if (deps.sessionReader) {
    try { model = await guard(Promise.resolve(deps.sessionReader.read({ host: h.host, ctx, cursor: window.sessionCursor, launchedAt: window.launchedAt, exitedAt: window.exitedAt }))); }
    catch (e) { if (e instanceof AbortError) throw e; transcript.append(`[session record not read: ${e.message}]\n`); }
    if (model !== undefined && !validModel(model)) { transcript.append("[session record not in a recognised shape]\n"); model = undefined; }
  }
  let verdict, mode, answers;
  if (model) {
    mode = "machine";
    verdict = evaluate(evidence, model, rows, { launchedAt: window.launchedAt.getTime(), exitedAt: window.exitedAt.getTime() });
  } else {
    mode = "attested";
    deps.ui.say(`\n>>> ${step.id}: ${h.host} has exited (${window.exit.code ?? window.exit.signal ?? "?"}). No machine evidence from the host's session record, so say what you saw:`);
    const log = [];
    try {
      // V1: one Enter in front, so a keystroke typed while the host was closing is taken here and not by a question.
      await guard(deps.ui.waitEnter("Press Enter to answer four questions about what you saw"));
      deps.ui.close();
      answers = await askQuestions(async (question) => { const a = await guard(deps.ui.ask(`${question} `)); log.push([question, a]); return a; });
    } catch (e) {
      deps.ui.close();
      throw e instanceof AbortError ? new AbortError(`aborted at step ${step.id}`) : e;
    }
    deps.ui.close();
    for (const [question, a] of log) transcript.append(`ATTESTED ${step.id} Q: ${question}\nATTESTED ${step.id} A: ${a}\n`);
    verdict = evaluateAttested(evidence, answers, rows, { launchedAt: window.launchedAt.getTime(), exitedAt: window.exitedAt.getTime() });
  }
  transcript.append(`[evidence ${step.id} (${h.host}, ${evidence.kind}): ${mode} ${verdict.result}${verdict.reasons.length ? `: ${verdict.reasons.join("; ")}` : ""}]\n`);
  ctx.hostResults[step.id] = { host: h.host, kind: evidence.kind, mode, result: verdict.result, reasons: verdict.reasons, answers };
  if (verdict.result !== "pass") fail(`the evidence for ${step.id}: \`${evidence.command}\`, result ${evidence.result}, ${evidence.ledger.rows} new ledger row(s) (${mode})`, verdict.reasons.join("; "));
}

// --- the command ---------------------------------------------------------------------------------

const flag = (argv, name) => {
  const k = argv.indexOf(`--${name}`);
  return k < 0 ? undefined : argv[k + 1];
};

const USAGE = `usage: e1-run.mjs e1a --version X --platform ${PLATFORMS.join("|")} [--clone DIR] [--staging owner/repo]
       e1-run.mjs e1b --part <name> [--a X] [--b X] [--drill <folder>] [--clone DIR] [--staging owner/repo]
       e1-run.mjs prepare --platform ${PLATFORMS.join("|")} [--drill <folder>] [--clone DIR] [--staging owner/repo]`;

/** The installers put `claude` in ~/.local/bin, which a fresh account's PATH may not have yet. */
const prepareEnv = (env, home) => ({ ...env, PATH: [`${home}/.local/bin`, env.PATH].filter(Boolean).join(":") });

/**
 * Runs a part and returns the exit code: 0 passed, 1 stopped, 2 refused or bad arguments, 3 the part
 * passed but no scrubbed copy could be written, 130 interrupted.
 */
export async function main(argv, deps = defaultDeps()) {
  const { env, log } = deps;
  const refused = refuseEnvironment(env);
  if (refused) { log.error(`e1-run: ${refused}`); return 2; }
  const [command] = argv;
  if (command === "scrub") return scrubAttempt(argv, deps);
  const home = env.HOME;
  if (!["e1a", "e1b", "prepare"].includes(command) || !home) { log.error(USAGE); return 2; }

  const vars = {
    command, staging: flag(argv, "staging") ?? "southcoltech-labs/context-economy-preview",
    clone: resolve(flag(argv, "clone") ?? join(home, "context-economy-preview")),
    V: flag(argv, "version"), platform: flag(argv, "platform"), part: flag(argv, "part"), a: flag(argv, "a"), b: flag(argv, "b"),
  };
  const runsDir = deps.runsDir ?? join(home, "e1-runs");
  let folderName, name, baseline = false;
  if (command === "prepare") {
    // Part 0: runs before there is a clone, a plugin or a host, in the account just created.
    if (!PLATFORMS.includes(vars.platform)) { log.error(USAGE); return 2; }
    const date = deps.now().toISOString().slice(0, 10);
    const drill = flag(argv, "drill");
    if (drill && !/^[A-Za-z0-9._-]+$/.test(drill)) { log.error("e1-run: --drill is a folder name under the runs folder"); return 2; }
    folderName = drill ?? `prepare-${date}`;
    name = `prepare-${date}`;
  } else if (command === "e1a") {
    if (!vars.V || !PLATFORMS.includes(vars.platform)) { log.error(USAGE); return 2; }
    if (!/^\d+(\.\d+)+$/.test(vars.V)) { log.error("e1-run: --version is a dotted version number such as 0.1.3"); return 2; }
    folderName = `${vars.V}-${vars.platform}`;
    name = folderName;
  } else {
    if (!vars.part) { log.error(USAGE); return 2; }
    baseline = vars.part === "baseline";
    const date = deps.now().toISOString().slice(0, 10);
    const drill = flag(argv, "drill");
    if (!baseline && !drill) { log.error("e1-run: a part after the baseline needs --drill <folder of the baseline>"); return 2; }
    if (drill && !/^[A-Za-z0-9._-]+$/.test(drill)) { log.error("e1-run: --drill is a folder name under the runs folder"); return 2; }
    folderName = drill ?? `e1b-${date}`;
    name = `e1b-${date}`;
  }
  const parts = deps.parts ?? (await import("./e1-parts.mjs")).parts;
  let steps;
  try { steps = command === "prepare" ? parts.prepare?.(vars) : command === "e1a" ? parts.e1a?.(vars) : parts.e1b?.[vars.part]?.(vars); }
  catch (e) { log.error(`e1-run: ${e.message}`); return 2; }
  if (!steps) { log.error(`e1-run: no step data for ${command}${vars.part ? ` part ${vars.part}` : ""}`); return 2; }

  privateDir(runsDir);
  const folder = join(runsDir, folderName);
  if (command === "e1b" && !baseline && !existsSync(folder)) { log.error(`e1-run: no drill folder ${folder}`); return 2; }
  const { n, dir: attemptDir } = newAttempt(folder);
  const rawFile = join(attemptDir, `${name}.raw.txt`);
  const transcript = new Transcript(rawFile);
  const versionFile = command !== "e1a" ? join(folder, "host-versions.json") : join(attemptDir, "host-versions.json");
  const ctx = {
    deps, vars, cwd: command === "prepare" ? home : vars.clone, env: command === "prepare" ? prepareEnv(allowedEnv(env), home) : allowedEnv(env), transcript, attemptDir, folder, runsDir, steps, proofs: [], step: undefined,
    assertSpans: [], hostRuns: [], hostResults: {}, interrupts: 0, results: {},
  };
  transcript.append(`# e1-run ${command} ${argv.slice(1).join(" ")}\n# attempt ${n}, started ${deps.now().toISOString()}\n`);

  let code = 0;
  try {
    ctx.versions = new HostVersions({ file: versionFile, requireState: command === "e1b" && !baseline });
    if (command !== "prepare") {
      const marketplace = JSON.parse(readFileSync(join(vars.clone, ".claude-plugin", "marketplace.json"), "utf8"));
      transcript.append("\n=== P.0 proof modules ===\n");
      ctx.proofs = await loadProofModules(marketplace, deps.proofDir);
      transcript.append(`${ctx.proofs.map((m) => m.name).join(", ")}\n`);
      await readHostVersions(ctx, "part start");
    } // prepare has no clone, plugin or host yet: its own steps read the host versions once they are installed
    await runSteps(ctx, steps);
    transcript.append("\n=== part finished: every assertion held ===\n");
    log.log(`e1-run: ${command} ${vars.part ?? vars.V} passed${hostCounts(ctx) ? ` (${hostCounts(ctx)})` : ""}. Transcript: ${rawFile}`);
  } catch (e) {
    if (e instanceof AbortError) {
      transcript.append(`\n${e.message}\n`);
      log.error(`e1-run: ${e.message}. An aborted part is a failure.`);
      code = 130;
    } else if (e instanceof StopError) {
      transcript.append(`\nSTOP at ${e.step}\n  expected: ${e.expected}\n  got: ${e.got}\n${STOP_LINE}\n`);
      log.error(`e1-run: STOP at ${e.step}\n  expected: ${e.expected}\n  got: ${e.got}\n${STOP_LINE}`);
      code = 1;
    } else {
      transcript.append(`\nSTOP: unexpected error: ${e.stack ?? e.message}\n${STOP_LINE}\n`);
      log.error(`e1-run: unexpected error: ${e.message}\n${STOP_LINE}`);
      code = 1;
    }
  }
  // V6: a run says how many host steps were attested, as the last line of the transcript.
  if (hostCounts(ctx)) transcript.append(`${hostCounts(ctx)}\n`);
  transcript.close();

  const scrubbed = scrubFile(ctx, rawFile, join(attemptDir, `${name}.txt`));
  if (!scrubbed.ok) {
    log.error(`e1-run: NO scrubbed copy written: ${scrubbed.reason}. The raw transcript stays private in ${attemptDir}.`);
    return code || 3;
  }
  log.log(`e1-run: send ${scrubbed.file} (the scrubbed copy, ${scrubbed.hits} hits listed at its end). The raw transcript and scrub-context.json stay private in ${attemptDir}.`);
  for (const note of scrubbed.notes) log.error(`e1-run: ${note}`);
  return code;
}

/**
 * `scrub --attempt <dir>` (E14): rebuilds the scrubbed copy of a finished attempt from its raw file,
 * the saved assertion spans and the saved context. It never overwrites an existing scrubbed copy.
 */
function scrubAttempt(argv, deps) {
  const { log } = deps;
  const dir = flag(argv, "attempt");
  const contextFile = dir && join(resolve(dir), "scrub-context.json");
  if (!dir || !existsSync(contextFile)) { log.error("usage: e1-run.mjs scrub --attempt <attempt folder holding scrub-context.json>"); return 2; }
  let c;
  try { c = JSON.parse(readFileSync(contextFile, "utf8")); } catch (e) { log.error(`e1-run: scrub-context.json does not parse (${e.message})`); return 2; }
  if (!c || typeof c !== "object" || Array.isArray(c) || ![c.name, c.clone, c.label, c.home, c.hostname, c.realHome].every((v) => typeof v === "string") || (c.assertSpans !== undefined && !Array.isArray(c.assertSpans))) { log.error("e1-run: scrub-context.json is not a scrub context (name, label, home, hostname, realHome, clone, assertSpans)"); return 2; }
  const attempt = resolve(dir);
  const rawFile = join(attempt, `${c.name}.raw.txt`);
  const outFile = join(attempt, `${c.name}.txt`);
  if (!/^[A-Za-z0-9._-]+$/.test(String(c.name))) { log.error("e1-run: scrub-context.json holds a bad name"); return 2; }
  if (!existsSync(rawFile)) { log.error(`e1-run: ${rawFile} is missing`); return 2; }
  if (existsSync(outFile)) { log.error(`e1-run: ${outFile} already exists; scrub does not overwrite a scrubbed copy`); return 2; }
  const config = typeof c.config === "string" ? c.config : join(c.clone, ".gitleaks.toml");
  // The saved path is trusted only when it is one the run itself could have chosen: the clone's config or this driver's own.
  if (![join(c.clone, ".gitleaks.toml"), join(HERE, "..", ".gitleaks.toml")].some((ok) => samePath(ok, config))) { log.error(`e1-run: scrub-context.json names a gitleaks config that is neither the clone's nor the driver's own: ${config}`); return 2; }
  if (!existsSync(config)) { log.error(`e1-run: ${config} is missing: the scrubber must use the project's gitleaks config`); return 2; }
  const r = scrubToFile(deps, { raw: readFileSync(rawFile, "utf8"), outFile, config, spans: c.assertSpans ?? [], label: c.label, home: c.home, hostname: c.hostname, realHome: c.realHome, tmpDir: attempt });
  if (!r.ok) { log.error(`e1-run: NO scrubbed copy written: ${r.reason}. The raw transcript stays private in ${attempt}.`); return 3; }
  log.log(`e1-run: send ${r.file} (the scrubbed copy, ${r.hits} hits listed at its end). The raw transcript and scrub-context.json stay private in ${attempt}.`);
  for (const note of r.notes) log.error(`e1-run: ${note}`);
  return 0;
}

/** `2 host steps, 1 attested`, or an empty string when no host step ran. Counts steps that reached a verdict; a step that stopped at the ledger read (V4) has none and is not counted. */
function hostCounts(ctx) {
  const all = Object.values(ctx.hostResults);
  if (!all.length) return "";
  return `${all.length} host step${all.length === 1 ? "" : "s"}, ${all.filter((r) => r.mode === "attested").length} attested`;
}

/**
 * The gitleaks config the scrub uses: the clone under test's (E13). Only `prepare` may fall back to this driver's own
 * checkout, and only when the clone has none (a run that stops before the clone exists still has a transcript to scrub);
 * nothing of the tested repo has been run by then.
 */
function gitleaksConfig(clone, command) {
  const own = join(clone, ".gitleaks.toml");
  return existsSync(own) || command !== "prepare" ? own : join(HERE, "..", ".gitleaks.toml");
}

/** Makes the scrubbed copy from the complete raw file, or says why not. Reports assertions that matched inside a scrubbed span. */
function scrubFile(ctx, rawFile, outFile) {
  const config = gitleaksConfig(ctx.vars.clone, ctx.vars.command);
  if (!existsSync(config)) return { ok: false, reason: `${config} is missing: the scrubber must use the project's gitleaks config` };
  const raw = readFileSync(rawFile, "utf8");
  const { deps } = ctx;
  const label = ctx.vars.platform?.startsWith("linux") ? "linux" : "mac";
  // E14: what a later `scrub --attempt` needs, saved before the scrub so a failed second pass can be redone.
  const contextFile = join(ctx.attemptDir, "scrub-context.json");
  writeFileSync(contextFile, JSON.stringify({ name: basename(outFile, ".txt"), label, home: ctx.env.HOME, hostname: deps.hostname, realHome: deps.realHome, clone: ctx.vars.clone, config, assertSpans: ctx.assertSpans }, null, 1), { mode: 0o600 });
  return scrubToFile(ctx.deps, { raw, rawFile, outFile, config, spans: ctx.assertSpans, label, home: ctx.env.HOME, hostname: deps.hostname, realHome: deps.realHome, tmpDir: ctx.attemptDir });
}

const samePath = (a, b) => {
  const norm = (p) => { try { return realpathSync(p); } catch { return resolve(String(p)); } };
  return norm(a) === norm(b);
};

/** The scrub itself, shared by a run's end and `scrub --attempt`. */
function scrubToFile(deps, { raw, outFile, config, spans, label, home, hostname: host, realHome, tmpDir }) {
  const homeSame = samePath(realHome, home);
  const r = scrub(raw, { config: deps.gitleaksConfig ?? config, bin: deps.gitleaksBin, run: deps.gitleaksRun, tmp: deps.tmp ?? tmpDir, hostname: host, label, realHome: homeSame ? undefined : realHome });
  if (!r.ok) return r;
  const lineOf = (offset) => raw.slice(0, offset).split("\n").length;
  const notes = spans.filter((s) => overlaps(r.spans, s.start, s.end)).map((s) => `an assertion of step ${s.step} matched inside a scrubbed span (raw line ${lineOf(s.start)}): its evidence is not visible in the scrubbed copy`);
  // E5: the account the run was made in is named on purpose; only a different OS-user home is scrubbed.
  const homeLine = homeSame ? [`home shown: ${home}, the account the run was made in`] : [];
  const body = `${r.text}\n\n--- scrub report ---\n${hitsReport(r.hits, [...homeLine, ...notes])}\n`;
  writeFileSync(outFile, body, { mode: 0o600 });
  chmodSync(outFile, 0o600);
  return { ok: true, file: outFile, hits: r.hits.length, notes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
