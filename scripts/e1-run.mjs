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
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, realpathSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { hostname, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PLATFORMS } from "./check-release-proof.mjs";
import { allowedEnv, passEnv, permissionMode, refuseEnvironment, refuseUpdate } from "./e1-helpers.mjs";
import { QUESTIONS, askQuestions, askVisual, evaluate, evaluateAttested, ledgerCursor, ledgerDirProblem, ledgerWindow, validModel, validateEvidence, validateVisual } from "./e1-evidence.mjs";
import { isEntry } from "./entry.mjs";
import { hitsReport, overlaps, scrub } from "./e1-scrub.mjs";
import { HOSTS, HostVersions, StopError, asText, clip, evidenceFor, parseVersionLine, readHostVersions } from "./e1-core.mjs";

// Moved to e1-core.mjs so that e1-parts.mjs need not import this file (an import circle stops the driver); re-exported for existing importers.
export { HOSTS, HostVersions, StopError, evidenceFor, parseVersionLine, readHostVersions };

const HERE = dirname(fileURLToPath(import.meta.url));
const STOP_LINE = "Send the transcript to the engineer.";

/** The driver was interrupted outside a host step. */
export class AbortError extends Error {}

const quote = (a) => (/^[A-Za-z0-9_@%+=:,./#^{}~-]+$/.test(a) ? a : `'${a.replaceAll("'", `'\\''`)}'`);

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

// --- proof modules -------------------------------------------------------------------------------

const ENTRY_KINDS = ["call", "visual"];
const CALL_KEYS = ["host", "kind", "command", "result", "ledger"];
const OFFSWITCH_KEYS = ["env", "checks"];
const ENV_NAME = /^CE_[A-Z0-9_]+$/;
const MAX_SAY_LINES = 8;

/** Why an off-switch environment is not acceptable, or undefined. Names are `CE_*`, values short strings. */
export function envProblem(env) {
  if (!env || typeof env !== "object" || Array.isArray(env)) return "env is not an object";
  const keys = Object.keys(env);
  if (!keys.length) return "env has no variable";
  for (const k of keys) {
    if (!ENV_NAME.test(k)) return `env name ${JSON.stringify(k)} is not CE_ followed by A-Z, 0-9 or _`;
    if (typeof env[k] !== "string" || env[k].length > 16) return `env value of ${k} is not a string of at most 16 characters`;
  }
  return undefined;
}

/** One `behaviour`, `uninstall` or off-switch `checks` entry of a module, as a reason string, or undefined when it is valid. */
function entryProblem(m, e, where) {
  if (!e || typeof e !== "object" || Array.isArray(e)) return `${where} is not an object`;
  if (!m.hosts.includes(e.host)) return `${where} names host ${JSON.stringify(e.host)}, which is not one of the module's hosts`;
  const kind = e.kind ?? "call";
  if (!ENTRY_KINDS.includes(kind)) return `${where} has unknown kind ${JSON.stringify(e.kind)}`;
  if (kind === "visual") {
    for (const k of ["ledger", "command", "result"]) if (e[k] !== undefined) return `${where} is a visual entry and has \`${k}\``;
    const bad = validateVisual(e);
    return bad ? `${where}: ${bad}` : undefined;
  }
  const unknown = Object.keys(e).filter((k) => !CALL_KEYS.includes(k));
  if (unknown.length) return `${where} has unknown field ${unknown.join(", ")} for a call entry`;
  if (typeof m.ledgerDirs[e.host] !== "string") return `${where} is a call entry for ${e.host}, which has no ledgerDirs entry`;
  const bad = validateEvidence(evidenceFor(m, e, "proof"));
  return bad ? `${where}: ${bad}` : undefined;
}

/** What is wrong with one proof module's own shape, or undefined. `name` is the marketplace's name for it. */
function moduleProblem(m, name) {
  if (!m || typeof m !== "object" || m.name !== name || !Array.isArray(m.hosts) || m.hosts.some((h) => !HOSTS.includes(h))) return "another shape";
  if (m.ledgerDirs !== undefined && (!m.ledgerDirs || typeof m.ledgerDirs !== "object" || Array.isArray(m.ledgerDirs) || Object.entries(m.ledgerDirs).some(([h, d]) => !HOSTS.includes(h) || typeof d !== "string"))) return "ledgerDirs is not { host: folder }";
  for (const [h, d] of Object.entries(m.ledgerDirs ?? {})) { const bad = ledgerDirProblem(d); if (bad) return `ledgerDirs.${h} ${bad}`; }
  if (!Array.isArray(m.behaviour) || !Array.isArray(m.uninstall) || !Array.isArray(m.dataLeft) || m.dataLeft.some((f) => typeof f !== "string")) return "another shape";
  const norm = { ...m, ledgerDirs: m.ledgerDirs ?? {} };
  const lists = { behaviour: m.behaviour, uninstall: m.uninstall };
  if (m.offSwitch !== undefined) {
    const o = m.offSwitch;
    if (!o || typeof o !== "object" || Array.isArray(o)) return "offSwitch is not an object";
    const unknown = Object.keys(o).filter((k) => !OFFSWITCH_KEYS.includes(k));
    if (unknown.length) return `offSwitch has unknown field ${unknown.join(", ")}`;
    const bad = envProblem(o.env);
    if (bad) return `offSwitch ${bad}`;
    if (!Array.isArray(o.checks) || !o.checks.length) return "offSwitch is declared with no checks (it must check every host of the module)";
    lists["offSwitch.checks"] = o.checks;
  }
  for (const [list, entries] of Object.entries(lists)) {
    for (const [i, e] of entries.entries()) {
      const bad = entryProblem(norm, e, `${list}[${i}]`);
      if (bad) return bad;
    }
    for (const h of m.hosts) {
      const mine = entries.filter((e) => e.host === h);
      if (mine.filter((e) => (e.kind ?? "call") === "call").length > 1) return `${list} has more than one call entry for ${h} (each session has at most one call entry per ledger folder)`;
      if (!mine.length) return `${list} has no entry for ${h}`;
    }
  }
  return undefined;
}

/** The lines a host session would ask the operator to do, for the size limit: each visual `say` line and one per call entry. */
const sayLines = (entries) => entries.reduce((n, e) => n + ((e.kind ?? "call") === "visual" ? e.say.length : 1), 0);

/**
 * Every plugin in marketplace.json needs a proof module in `dir`: a listed plugin without one is a
 * stop, never a skip. A module (version 2) is `{ name, hosts, ledgerDirs?, behaviour, uninstall, offSwitch?, dataLeft }`;
 * an entry is a `call` (the default: a ledger-checked command) or a `visual` (statements the operator confirms by sight).
 * The cross-module rules (one owner per ledger folder, a session of at most 8 lines) are checked here too.
 */
export async function loadProofModules(marketplace, dir = join(HERE, "proof"), importModule = (f) => import(pathToFileURL(f).href)) {
  const modules = [];
  for (const { name } of marketplace.plugins ?? []) {
    if (typeof name !== "string" || !/^[a-z0-9-]+$/.test(name)) throw new StopError({ step: "proof modules", expected: "a plugin name of [a-z0-9-] only", got: JSON.stringify(name) });
    const file = join(dir, `${name}.mjs`);
    if (!existsSync(file)) throw new StopError({ step: "proof modules", expected: `scripts/proof/${name}.mjs for plugin ${name} listed in marketplace.json`, got: "no such module (a listed plugin is never skipped)" });
    const m = (await importModule(file)).default;
    const bad = moduleProblem(m, name);
    if (bad) throw new StopError({ step: "proof modules", expected: `scripts/proof/${name}.mjs exporting { name: "${name}", hosts, ledgerDirs?, behaviour, uninstall, offSwitch?, dataLeft }`, got: bad });
    modules.push({ ...m, ledgerDirs: m.ledgerDirs ?? {} });
  }
  const stop = (m, got) => new StopError({ step: "proof modules", expected: `scripts/proof/${m.name}.mjs consistent with the other modules`, got });
  const owner = new Map();
  for (const m of modules) for (const d of new Set(Object.values(m.ledgerDirs))) {
    if (owner.has(d) && owner.get(d) !== m.name) throw stop(m, `the ledger folder ${d} is claimed by ${owner.get(d)} and ${m.name} (every ledger folder has exactly one owner)`);
    owner.set(d, m.name);
  }
  for (const m of modules) for (const h of m.hosts) {
    const others = modules.filter((o) => o !== m && o.hosts.includes(h));
    const mine = (list) => list.filter((e) => e.host === h);
    const sessions = [["behaviour", sayLines(modules.filter((o) => o.hosts.includes(h)).flatMap((o) => mine(o.behaviour)))],
      ["uninstall", sayLines(modules.filter((o) => o.hosts.includes(h)).flatMap((o) => mine(o.uninstall)))]];
    if (m.offSwitch) sessions.push(["off-switch", sayLines([...mine(m.offSwitch.checks), ...others.flatMap((o) => mine(o.behaviour))])]);
    for (const [phase, n] of sessions) if (n > MAX_SAY_LINES) throw stop(m, `the ${phase} session for ${h} would carry ${n} lines of instructions, more than ${MAX_SAY_LINES}`);
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

const STEP_KEYS = ["id", "title", "run", "cwd", "expect", "human", "pause", "after", "set", "tag", "expand"];
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

const ENTRY_KEYS = ["plugin", "kind", "evidence", "expect"];

/** A human step's `entries` (several plugins in one session): each a ledger-checked `call` or a `visual`, and no two sharing a command or a ledger folder. */
function validateEntries(h, where) {
  if (!Array.isArray(h.entries) || !h.entries.length) throw dataStop(where, "human.entries is not a non-empty list");
  const commands = new Set(), folders = new Set();
  for (const [i, e] of h.entries.entries()) {
    const at = `${where} entries[${i}]`;
    if (!e || typeof e !== "object" || Array.isArray(e)) throw dataStop(at, "not an object");
    const unknown = Object.keys(e).filter((k) => !ENTRY_KEYS.includes(k));
    if (unknown.length) throw dataStop(at, `unknown key ${unknown.join(", ")}`);
    if (typeof e.plugin !== "string" || !e.plugin) throw dataStop(at, "no plugin name");
    if (e.kind === "visual") {
      if (e.evidence !== undefined) throw dataStop(at, "a visual entry has evidence");
      const bad = validateVisual({ host: h.host, kind: "visual", say: [], expect: e.expect });
      if (bad) throw dataStop(at, bad);
    } else if (e.kind === "call") {
      if (e.expect !== undefined) throw dataStop(at, "a call entry has expect");
      const bad = validateEvidence(e.evidence);
      if (bad) throw dataStop(at, `evidence: ${bad}`);
      if (commands.has(e.evidence.command)) throw dataStop(at, `two call entries run \`${e.evidence.command}\` in one session (a call could satisfy both)`);
      if (folders.has(e.evidence.ledgerDir)) throw dataStop(at, `two call entries own the ledger folder ${e.evidence.ledgerDir} in one session`);
      commands.add(e.evidence.command);
      folders.add(e.evidence.ledgerDir);
    } else throw dataStop(at, "kind is neither call nor visual");
  }
}

/** A human step needs a host and instructions (E1). */
function validateHuman(h, where) {
  if (!h || typeof h !== "object") throw dataStop(where, "human is not an object");
  if (!HOSTS.includes(h.host)) throw dataStop(where, `human.host is not ${HOSTS.join(" or ")}`);
  if (!Array.isArray(h.say) || !h.say.length || h.say.some((l) => typeof l !== "string")) throw dataStop(where, "human.say is not a non-empty list of lines");
  if (h.before !== undefined && typeof h.before !== "function") throw dataStop(where, "human.before is not a function");
  if (h.env !== undefined) { const bad = envProblem(h.env); if (bad) throw dataStop(where, `human.${bad}`); }
  // E2: the evaluator is mandatory for every human step and step data cannot leave it out.
  if (h.entries !== undefined) {
    if (h.evidence !== undefined) throw dataStop(where, "human has both evidence and entries");
    validateEntries(h, where);
    return;
  }
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
    if (step.expand !== undefined) throw dataStop(where, "an expand() that is still there after resolution (expansion is one level: an expanded step may not itself expand)");
    if (step.run !== undefined && typeof step.run !== "function") {
      if (!Array.isArray(step.run)) throw dataStop(where, "run is neither a list nor a function");
      for (const c of step.run) {
        const argv = Array.isArray(c) && c.length && c.every((x) => typeof x === "string");
        const fn = c && !Array.isArray(c) && typeof c.label === "string" && typeof c.fn === "function";
        if (!argv && !fn) throw dataStop(where, "a command is neither an argv of strings nor { label, fn }");
      }
      if (typeof step.expect !== "function") validateExpect(step, where, step.run.length);
    } else if (typeof step.run === "function") {
      if (step.expect !== undefined && !Array.isArray(step.expect) && typeof step.expect !== "function") throw dataStop(where, "expect is not a list");
    } else if (typeof step.expect !== "function") validateExpect(step, where, 0);
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

/**
 * A step with `expand: (ctx) => [steps]` is replaced, in place, by what it returns. The steps are built before the proof
 * modules are loaded, so what depends on which plugins there are (an off-switch session per plugin) is expanded here.
 */
export function resolveSteps(ctx, steps) {
  if (!Array.isArray(steps)) return steps;
  return steps.flatMap((s) => {
    if (!s || typeof s !== "object" || typeof s.expand !== "function") return [s];
    const extra = Object.keys(s).filter((k) => !["id", "title", "expand"].includes(k));
    if (extra.length) throw dataStop(s.id ?? "(expand)", `a step with expand() also has ${extra.join(", ")} (a placeholder holds nothing else, or its checks would be dropped)`);
    const made = s.expand(ctx);
    if (!Array.isArray(made)) throw dataStop(s.id ?? "(expand)", "expand() did not return a list of steps");
    return made;
  });
}

/** Runs `steps`. Throws StopError at the first failed assertion and AbortError when interrupted outside a host. */
export async function runSteps(ctx, steps) {
  const { deps, transcript } = ctx;
  steps = resolveSteps(ctx, steps);
  ctx.steps = steps;
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
      // `expect` may be a function of ctx when the commands depend on the plugins (one install per plugin).
      const expects = typeof step.expect === "function" ? step.expect(ctx) : step.expect;
      if (typeof step.run === "function") {
        if (!Array.isArray(cmds)) throw dataStop(step.id, "run() did not return a list");
        validateExpect({ ...step, expect: expects }, step.id, cmds.length);
      } else if (typeof step.expect === "function") validateExpect({ ...step, expect: expects }, step.id, cmds.length);
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
        const mine = (expects ?? []).filter((a) => a.cmd === i);
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

/** The entries a host step judges: its `entries` (several plugins), or the one legacy `evidence`. */
const entriesOf = (h) => h.entries ?? [{ plugin: undefined, kind: "call", evidence: h.evidence }];
const entryLabel = (h, e) => (e.plugin ? `${h.host} ${e.plugin} ${e.kind}` : `${h.host} ${e.evidence.kind}`);

/**
 * Every ledger folder of every proof module in the run (installed at the moment or not), and the folders of the step's own
 * call entries: the session is checked against all of them, so a row in a folder nobody owns is seen.
 */
function monitoredDirs(ctx, entries) {
  const dirs = new Set(ctx.proofs.flatMap((m) => Object.values(m.ledgerDirs ?? {})));
  for (const e of entries) if (e.kind === "call") dirs.add(e.evidence.ledgerDir);
  return [...dirs].sort();
}

async function humanStep(ctx, step, { guard, fail, setRunning }) {
  const { deps, transcript } = ctx;
  const h = typeof step.human === "function" ? step.human(ctx) : step.human;
  validateHuman(h, step.id);
  const entries = entriesOf(h);
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
  // The checks this session is judged by are fixed before it starts: a missing one is a fail, never an omission.
  transcript.append(`[planned ${step.id}: ${entries.map((e) => entryLabel(h, e)).join("; ")}]\n`);
  try {
    await guard(deps.ui.waitEnter(`Press Enter to start ${h.host}`));
  } catch (e) {
    deps.ui.close();
    throw e instanceof AbortError ? new AbortError(`aborted at step ${step.id}`) : e;
  }
  deps.ui.close();
  await readHostVersions(ctx, `before ${step.id}`);
  const cursor = h.before ? await h.before(ctx) : undefined;
  // The window starts here: every monitored ledger folder's row counts and, when a session reader exists, its cursor.
  const ledgerBefore = monitoredDirs(ctx, entries).map((dir) => ledgerCursor(ctx.env.HOME, dir));
  const sessionCursor = await deps.sessionReader?.cursor?.({ host: h.host, ctx });
  // A fresh environment per launch: an off-switch override (and the Pi-only credentials) never reaches a later launch, a helper, the scrubber or the recorder.
  const launchEnv = { ...ctx.env, ...(h.host === "pi" ? ctx.passEnv : {}), ...(h.env ?? {}) };
  if (h.env) transcript.append(`[host env: ${Object.entries(h.env).map(([k, v]) => `${k}=${v}`).join(" ")}]\n`);
  const launchedAt = deps.now();
  setRunning(true);
  let exit;
  try {
    // --pass-env variables (a provider key) reach Pi only, never Claude Code or any other command.
    exit = await deps.launchHost(h.host, { cwd: ctx.cwd, env: launchEnv });
  } finally {
    setRunning(false);
    deps.ui.restore?.();
  }
  const exitedAt = deps.now();
  transcript.append(`[${h.host} exited ${exit.code ?? exit.signal ?? "?"}${exit.error ? `: ${exit.error}` : ""}]\n`);
  if (exit.error) fail(`${h.host} to start`, `${exit.error} (exit ${exit.code ?? "?"})`);
  await readHostVersions(ctx, `after ${step.id}`);
  ctx.hostRuns.push({ step: step.id, host: h.host, cursor, launchedAt, exitedAt, exit });
  await judgeHostStep(ctx, step, h, entries, { ledgerBefore, sessionCursor, launchedAt, exitedAt, exit }, { guard, fail });
}

/**
 * The evidence for a host step (e1-evidence.mjs), one verdict per planned entry. The host's exit proves nothing: a `call`
 * entry is judged on the host's session record when a reader recognises it, otherwise the operator is asked the fixed
 * questions and the entry is marked `attested`; a `visual` entry is always attested. The ledger is a machine check
 * either way and an attestation never overrides it. Every ledger folder of every proof module is read: a folder a `call`
 * entry owns is judged by that entry, every other must have no new row. The step passes only when every entry does, and a
 * failure names every failed entry.
 */
async function judgeHostStep(ctx, step, h, entries, window, { guard, fail }) {
  const { deps, transcript } = ctx;
  const win = { launchedAt: window.launchedAt.getTime(), exitedAt: window.exitedAt.getTime() };
  const rowsByDir = {};
  for (const cursor of window.ledgerBefore) {
    let rows;
    try { rows = ledgerWindow(ctx.env.HOME, cursor); }
    catch (e) { transcript.append(`[ledger window ${cursor.dir}: ${e.message}]\n`); fail(`a readable ledger that only grew during ${step.id}`, e.message); }
    rowsByDir[cursor.dir] = rows;
    transcript.append(`[ledger window ${cursor.dir}: ${rows.length} new row${rows.length === 1 ? "" : "s"}${rows.map((r) => `; ${r.ts} rewrite=${r.rewrite} is_error=${r.is_error}`).join("")}]\n`);
  }
  const owned = new Set(entries.filter((e) => e.kind === "call").map((e) => e.evidence.ledgerDir));
  const strays = Object.entries(rowsByDir).filter(([dir, rows]) => !owned.has(dir) && rows.length).map(([dir, rows]) => `unexpected ledger rows in ${dir}: ${rows.length} new`);

  let model;
  if (deps.sessionReader && entries.some((e) => e.kind === "call")) {
    try { model = await guard(Promise.resolve(deps.sessionReader.read({ host: h.host, ctx, cursor: window.sessionCursor, launchedAt: window.launchedAt, exitedAt: window.exitedAt }))); }
    catch (e) { if (e instanceof AbortError) throw e; transcript.append(`[session record not read: ${e.message}]\n`); }
    if (model !== undefined && !validModel(model)) { transcript.append("[session record not in a recognised shape]\n"); model = undefined; }
  }
  const results = entries.map(() => undefined);
  const attested = [];
  entries.forEach((e, i) => {
    if (e.kind === "call" && model) results[i] = { mode: "machine", ...evaluate(e.evidence, model, rowsByDir[e.evidence.ledgerDir], win) };
    else attested.push(i);
  });
  if (attested.length) {
    deps.ui.say(`\n>>> ${step.id}: ${h.host} has exited (${window.exit.code ?? window.exit.signal ?? "?"}). No machine evidence from the host's session record, so say what you saw:`);
    const several = entries.length > 1;
    const labelOf = (e) => (e.plugin && several ? `${step.id} ${e.plugin}` : step.id);
    const asked = [];
    try {
      // V1: one Enter in front, so a keystroke typed while the host was closing is taken here and not by a question.
      const onlyCall = attested.length === 1 && entries[attested[0]].kind === "call";
      await guard(deps.ui.waitEnter(onlyCall ? "Press Enter to answer four questions about what you saw" : "Press Enter to answer the questions about what you saw"));
      deps.ui.close();
      // All call entries' questions first, then each visual entry's statements; every try is kept for the transcript.
      for (const kind of ["call", "visual"]) for (const i of attested.filter((k) => entries[k].kind === kind)) {
        const e = entries[i];
        if (e.plugin && several) deps.ui.say(`--- ${e.plugin} ---`);
        const log = [];
        const ask = async (question) => { const a = await guard(deps.ui.ask(`${question} `)); log.push([question, a]); return a; };
        let answers, verdict;
        try {
          if (kind === "call") answers = await askQuestions(ask);
          else verdict = await askVisual(ask, e.expect, { onChange: (c) => noteChange(ctx, step, labelOf(e), c) });
        } finally {
          asked.push([labelOf(e), log]);
          for (const [question, a] of log) transcript.append(`ATTESTED ${labelOf(e)} Q: ${question}\nATTESTED ${labelOf(e)} A: ${a}\n`);
        }
        results[i] = kind === "call"
          ? { mode: "attested", answers, ...evaluateAttested(e.evidence, answers, rowsByDir[e.evidence.ledgerDir], win) }
          : { mode: "attested", ...verdict };
      }
    } catch (e) {
      deps.ui.close();
      throw e instanceof AbortError ? new AbortError(`aborted at step ${step.id}`) : e;
    }
    deps.ui.close();
  }
  const failures = [];
  entries.forEach((e, i) => {
    const r = results[i] ?? { mode: "attested", result: "fail", reasons: ["no result was recorded for this planned check"] };
    results[i] = r;
    transcript.append(`[evidence ${step.id} (${entryLabel(h, e).replace(`${h.host} `, `${h.host}, `)}): ${r.mode} ${r.result}${r.reasons.length ? `: ${r.reasons.join("; ")}` : ""}]\n`);
    if (r.result !== "pass") failures.push({ e, r });
  });
  if (strays.length) transcript.append(`[ledger folders nobody owns in ${step.id}: ${strays.join("; ")}]\n`);
  const result = failures.length || strays.length ? "fail" : "pass";
  const first = results.find((r) => r.answers);
  ctx.hostResults[step.id] = {
    host: h.host, kind: entries[0].kind === "call" ? entries[0].evidence.kind : "visual", mode: results.every((r) => r.mode === "machine") ? "machine" : "attested",
    result, reasons: [...results.flatMap((r) => r.reasons), ...strays], answers: first?.answers,
    entries: entries.map((e, i) => ({ plugin: e.plugin, kind: e.kind, mode: results[i].mode, result: results[i].result, reasons: results[i].reasons })),
  };
  if (result === "pass") return;
  if (entries.length === 1 && !entries[0].plugin && !strays.length) {
    const ev = entries[0].evidence, r = results[0];
    fail(`the evidence for ${step.id}: \`${ev.command}\`, result ${ev.result}, ${ev.ledger.rows} new ledger row(s) (${r.mode})`, r.reasons.join("; "));
  }
  fail(`every check of ${step.id} to pass (${entries.map((e) => entryLabel(h, e)).join("; ")})`,
    [...failures.map(({ e, r }) => `${e.plugin ?? "(unnamed)"} ${e.kind}: ${r.reasons.join("; ")}`), ...strays].join(" | "));
}

// --- the command ---------------------------------------------------------------------------------

const flag = (argv, name) => {
  const k = argv.indexOf(`--${name}`);
  return k < 0 ? undefined : argv[k + 1];
};

const USAGE = `usage: e1-run.mjs e1a --version X --platform ${PLATFORMS.join("|")} [--clone DIR] [--staging owner/repo] [--pass-env NAME]
       e1-run.mjs e1b --part <name> [--a X] [--b X] [--drill <folder>] [--clone DIR] [--staging owner/repo] [--pass-env NAME]
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
  const pass = passEnv(argv, env);
  if (pass.error) { log.error(`e1-run: ${pass.error}`); return 2; }
  // The passed variables are CONSUMED: removed from `deps.env` (which is `process.env` for the command line), so a
  // caller that reuses the object must supply them again before a later run. An injected plain object is sanitized, a
  // distinct ambient `process.env` is not.
  // The driver's own children (gitleaks, stty, installers) must not inherit the key: it is held here, and only
  // the Pi host gets it. Pi's own tool subprocesses inherit it from Pi; that reach cannot be removed.
  for (const name of Object.keys(pass.values)) delete env[name];

  const vars = {
    command, staging: flag(argv, "staging") ?? "southcoltech-labs/context-economy",
    clone: resolve(flag(argv, "clone") ?? join(home, "context-economy")),
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
    deps, vars, cwd: command === "prepare" ? home : vars.clone, env: command === "prepare" ? prepareEnv(allowedEnv(env), home) : allowedEnv(env), transcript, attemptDir, folder, runsDir, steps, proofs: [], step: undefined, passEnv: pass.values,
    assertSpans: [], hostRuns: [], hostResults: {}, changedAnswers: [], interrupts: 0, results: {},
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
  // Changed answers are listed on every exit, a stop or an interrupt included, and counted on the last line.
  if (ctx.changedAnswers.length) transcript.append(`\n${changedBlock(ctx)}\n`);
  // V6: a run says how many host steps were attested, as the last line of the transcript.
  if (hostCounts(ctx) || ctx.changedAnswers.length) transcript.append(`${hostCounts(ctx)}${changedCount(ctx)}\n`.replace(/^, /, ""));
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

/** A salted SHA-256 of a credential value: lets a rebuild confirm it was given the ORIGINAL value without saving it. */
function verifier(value, salt = randomBytes(16).toString("hex")) {
  return { salt, sha256: createHash("sha256").update(`${salt}\0${value}`).digest("hex") };
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
  // The run held credentials named with --pass-env: their names are saved (never their values), and the exact-value
  // redaction needs the values again. Without them the shareable copy cannot be made safely: fail closed.
  if (c.passEnvNames !== undefined && (!Array.isArray(c.passEnvNames) || !c.passEnvNames.every((n) => typeof n === "string"))) { log.error("e1-run: scrub-context.json holds a bad passEnvNames"); return 2; }
  const need = c.passEnvNames ?? [];
  // A context without credential names is accepted only when the COMPLETE first driver header line (anchored at the start,
  // followed by the "# attempt" line) is recognized and carries no credential option. Anything else cannot be classified: refuse.
  let rawText;
  try { rawText = readFileSync(rawFile, "utf8"); } catch (e) { log.error(`e1-run: ${rawFile} cannot be read (${e.message})`); return 2; }
  if (c.passEnvNames === undefined) {
    const head = /^(# e1-run [a-z0-9]+(?: [^\n]*)?)\n# attempt \d+, started [^\n]*\n/.exec(rawText);
    if (!head) { log.error("e1-run: this attempt's scrub-context.json has no credential metadata and its raw header is not recognized, so it cannot be shown to be free of --pass-env credentials. No scrubbed copy written."); return 2; }
    if (/pass-env/.test(head[1])) { log.error("e1-run: this attempt was run with --pass-env, but its scrub-context.json has no credential metadata (an older driver), so a scrubbed copy cannot be rebuilt safely. No scrubbed copy written."); return 2; }
  }
  const again = passEnv(need.flatMap((n) => ["--pass-env", n]), deps.env);
  if (again.error) { log.error(`e1-run: the run that made this attempt held ${need.join(", ")} (--pass-env), and the scrubbed copy must remove its value. ${again.error.replace(/^--pass-env /, "")}. No scrubbed copy written.`); return 2; }
  const ver = c.passEnvVerifiers;
  if (need.length && (!ver || typeof ver !== "object" || Array.isArray(ver) || !need.every((n) => ver[n] && typeof ver[n].salt === "string" && typeof ver[n].sha256 === "string" && /^[0-9a-f]{32}$/.test(ver[n].salt) && /^[0-9a-f]{64}$/.test(ver[n].sha256)))) { log.error("e1-run: scrub-context.json lacks a valid verifier for each credential, so the original values cannot be confirmed. No scrubbed copy written."); return 2; }
  const wrong = need.filter((n) => verifier(again.values[n], ver[n].salt).sha256 !== ver[n].sha256);
  if (wrong.length) { log.error(`e1-run: the value now in ${wrong.join(", ")} is not the one the run used (rotated or mistyped), so it cannot be removed from the transcript. Export the original value. No scrubbed copy written.`); return 2; }
  for (const n of need) delete deps.env[n]; // as in a run: the scrubber's children never inherit it
  const r = scrubToFile(deps, { raw: rawText, outFile, config, spans: c.assertSpans ?? [], label: c.label, home: c.home, hostname: c.hostname, realHome: c.realHome, tmpDir: attempt, secrets: again.values });
  if (!r.ok) { log.error(`e1-run: NO scrubbed copy written: ${r.reason}. The raw transcript stays private in ${attempt}.`); return 3; }
  log.log(`e1-run: send ${r.file} (the scrubbed copy, ${r.hits} hits listed at its end). The raw transcript and scrub-context.json stay private in ${attempt}.`);
  for (const note of r.notes) log.error(`e1-run: ${note}`);
  return 0;
}

/** A visual answer changed after the confirmation: written to the transcript at once and kept for the end-of-run block. */
function noteChange(ctx, step, label, c) {
  ctx.changedAnswers.push({ step: step.id, label, ...c });
  ctx.transcript.append(`[answer changed ${label}: "${c.statement}": ${c.first} -> ${c.second}; reason: ${c.reason}]\n`);
}
const changedCount = (ctx) => (ctx.changedAnswers.length ? `, ${ctx.changedAnswers.length} answer${ctx.changedAnswers.length === 1 ? "" : "s"} changed after confirmation` : "");
const changedBlock = (ctx) => ["=== answers changed after confirmation ===", ...ctx.changedAnswers.map((c) => `${c.label}: "${c.statement}": ${c.first} -> ${c.second}; reason: ${c.reason}`)].join("\n");

/** `2 host steps, 1 attested`, or an empty string when no host step ran. A step that holds several checks adds `(N checks)`. Counts steps that reached a verdict; a step that stopped at the ledger read (V4) has none and is not counted. */
function hostCounts(ctx) {
  const all = Object.values(ctx.hostResults);
  if (!all.length) return "";
  const checks = all.reduce((n, r) => n + (r.entries?.length ?? 1), 0);
  return `${all.length} host step${all.length === 1 ? "" : "s"}${checks === all.length ? "" : ` (${checks} checks)`}, ${all.filter((r) => r.mode === "attested").length} attested`;
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
  writeFileSync(contextFile, JSON.stringify({ name: basename(outFile, ".txt"), label, home: ctx.env.HOME, hostname: deps.hostname, realHome: deps.realHome, clone: ctx.vars.clone, config, assertSpans: ctx.assertSpans, passEnvNames: Object.keys(ctx.passEnv ?? {}), passEnvVerifiers: Object.fromEntries(Object.entries(ctx.passEnv ?? {}).map(([n, v]) => [n, verifier(v)])) }, null, 1), { mode: 0o600 });
  return scrubToFile(ctx.deps, { raw, rawFile, outFile, config, spans: ctx.assertSpans, label, home: ctx.env.HOME, hostname: deps.hostname, realHome: deps.realHome, tmpDir: ctx.attemptDir, secrets: ctx.passEnv });
}

const samePath = (a, b) => {
  const norm = (p) => { try { return realpathSync(p); } catch { return resolve(String(p)); } };
  return norm(a) === norm(b);
};

/** The scrub itself, shared by a run's end and `scrub --attempt`. */
function scrubToFile(deps, { raw, outFile, config, spans, label, home, hostname: host, realHome, tmpDir, secrets }) {
  const homeSame = samePath(realHome, home);
  const r = scrub(raw, { config: deps.gitleaksConfig ?? config, bin: deps.gitleaksBin, run: deps.gitleaksRun, tmp: deps.tmp ?? tmpDir, hostname: host, label, realHome: homeSame ? undefined : realHome, secrets });
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

// No top-level await: with one, an import of this file from a module that main() loads at run time never settles and the driver exits silently.
if (isEntry(import.meta.url)) main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
