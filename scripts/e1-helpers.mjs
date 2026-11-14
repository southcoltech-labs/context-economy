// SPDX-License-Identifier: Apache-2.0

// What the E1 driver needs besides its engine: the run sheet's five Part 0 helpers (override.sh,
// check-settings.mjs, installed.mjs, ledger.mjs, clean-b.mjs) as read-only functions with the same
// output lines, and the guards (environment, host versions, updates, permission mode). Each helper
// returns `{ code, stdout, stderr }` like a command, so the driver can write it into the
// transcript and assert on it. They read only; nothing here writes under `~/.claude` or `~/.pi`.
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MISSING = Symbol("missing");
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Host locations the driver sets itself and never inherits (changing HOME alone does not override them). */
export const REFUSED_VARIABLES = ["CLAUDE_CONFIG_DIR", "PI_CODING_AGENT_DIR", "CE_RTK_BIN"];
/** The only variables a command or a host inherits. */
export const ALLOWED_VARIABLES = ["PATH", "HOME", "TERM", "LANG", "USER", "SHELL"];

export const MANAGED_SETTINGS = [
  "/Library/Application Support/ClaudeCode/managed-settings.json",
  "/etc/claude-code/managed-settings.json",
];

/** Why the driver must not start from this environment, or undefined. A variable counts as set even when empty. */
export function refuseEnvironment(env) {
  const set = REFUSED_VARIABLES.filter((name) => Object.hasOwn(env, name));
  return set.length ? `${set.join(", ")} ${set.length === 1 ? "is" : "are"} set in this shell: unset ${set.length === 1 ? "it" : "them"} and start the driver again (the driver sets host locations itself)` : undefined;
}

/** The allow-listed environment every command and host starts with. */
export function allowedEnv(env) {
  return Object.fromEntries(ALLOWED_VARIABLES.filter((k) => env[k] !== undefined).map((k) => [k, env[k]]));
}

/**
 * Why `cmd args` must not run, or undefined. Exactly the plain host updates are refused: `claude update`
 * and `pi update` with no further arguments. `claude plugin update …` and `pi update --extensions` are
 * README §3's update and must run.
 */
export function refuseUpdate(cmd, args) {
  const name = String(cmd).split("/").pop(); // E8: `/opt/homebrew/bin/pi update` is `pi update`
  if ((name === "claude" || name === "pi") && args.length === 1 && args[0] === "update") {
    return `${name} update is not run during a drill (host versions follow the owner's rule; on the Mac, Pi's shared install would change for every account)`;
  }
  return undefined;
}

const VERSION = /(\d+)\.(\d+)\.(\d+)/;
export const versionNumbers = (text) => {
  const m = VERSION.exec(String(text ?? ""));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
};

/**
 * Owner rule, 2026-11-14: a host version later than the one recorded earlier in the run or drill is
 * recorded and the run goes on; an earlier one stops. `verdict`: first, same, later, earlier or unreadable.
 */
export function judgeVersion(recorded, now) {
  const b = versionNumbers(now);
  if (!b) return { verdict: "unreadable" };
  const a = versionNumbers(recorded);
  if (recorded === undefined) return { verdict: "first" };
  if (!a) return { verdict: "unreadable" };
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return { verdict: b[i] > a[i] ? "later" : "earlier" };
  return { verdict: "same" };
}

/**
 * Owner rule, 2026-11-14: the lowest host version a run may use. Claude Code supports plugins from
 * 2.1.273. Pi supports extensions from 0.73.1, after its package migration; 1.0.0 is the floor, to be safe.
 * A reading below the floor is a stop, even as the first recording.
 */
export const MIN_HOST_VERSION = Object.freeze({ claude: "2.1.273", pi: "1.0.0" });

/** Whether `reading` is at least the floor for `host`. A host without a floor does not meet it; an unreadable reading is judged elsewhere. */
export function meetsFloor(host, reading) {
  const floor = versionNumbers(MIN_HOST_VERSION[host]);
  if (!floor) return false; // F1: a host with no floor is a stop, never a pass
  const got = versionNumbers(reading);
  if (!got) return true; // unreadable is judged elsewhere
  for (let i = 0; i < 3; i++) if (got[i] !== floor[i]) return got[i] > floor[i];
  return true;
}

/** The first ```bash block after the README's "**RTK 0.47.0.**" paragraph, unchanged. */
export function rtkBlock(readme) {
  const from = readme.indexOf("**RTK 0.47.0.**");
  if (from < 0) throw new Error("README.md has no RTK 0.47.0 block");
  const start = readme.indexOf("```bash\n", from);
  if (start < 0) throw new Error("README.md: the RTK block is not a bash block");
  const body = start + "```bash\n".length;
  return readme.slice(body, readme.indexOf("\n```", body)) + "\n";
}

// --- reading -----------------------------------------------------------------------------------

const readJson = (f) => {
  let text;
  try { text = readFileSync(f, "utf8"); }
  catch (e) { if (e.code === "ENOENT") return MISSING; throw new Error(`${f}: ${e.message}`); }
  try { return JSON.parse(text); } catch (e) { throw new Error(`${f}: not valid JSON (${e.message})`); }
};

const exists = (p) => {
  try { lstatSync(p); return true; }
  catch (e) { if (e.code === "ENOENT") return false; throw new Error(`${p}: ${e.message}`); }
};

/** Wraps a helper body: its lines are the output; an error is `<name>: ERROR … (stop)` and code 1. */
function helper(name, body) {
  const lines = [];
  try {
    const code = body((l) => lines.push(l)) ?? 0;
    return { code, stdout: lines.join("\n"), stderr: "" };
  } catch (e) {
    return { code: 1, stdout: lines.join("\n"), stderr: `${name}: ERROR ${e.message} (stop)` };
  }
}

/** The settings files, in the order the run sheet reads them. */
const settingsFiles = (home, cwd, managed = MANAGED_SETTINGS) => [
  `${home}/.claude/settings.json`, join(cwd, ".claude/settings.json"), join(cwd, ".claude/settings.local.json"), ...managed,
];

/** check-settings.mjs: settings files that set CE_RTK_BIN; with `config`, also `rtk.path`. */
export function checkSettings({ home, cwd, config = false, managed = MANAGED_SETTINGS }) {
  return helper("settings check", (out) => {
    const present = [];
    for (const f of settingsFiles(home, cwd, managed)) {
      const s = readJson(f);
      if (s === MISSING) continue;
      if (!isObject(s)) throw new Error(`${f}: not a JSON object`);
      if ("env" in s && !isObject(s.env)) throw new Error(`${f}: env is not a JSON object`);
      const set = "env" in s && "CE_RTK_BIN" in s.env;
      out(`${f}: CE_RTK_BIN ${set ? "PRESENT" : "absent"}`);
      if (set) present.push(f);
    }
    if (config) {
      const f = `${home}/.claude/context-economy/config.json`;
      const c = readJson(f);
      if (c === MISSING) throw new Error(`${f}: missing`);
      if (!isObject(c) || !isObject(c.rtk)) throw new Error(`${f}: not {"rtk": {...}}`);
      const path = c.rtk.path;
      if (typeof path !== "string" || !path.startsWith("/")) throw new Error(`${f}: no absolute rtk.path`);
      out(`rtk.path: ${path}`);
    }
    if (present.length) throw new Error(`CE_RTK_BIN is set in ${present.join(", ")}`);
    out("settings check: OK");
  });
}

/** override.sh: the shell has no CE_RTK_BIN (the driver refuses to start otherwise), then check-settings with the config. */
export function overrideCheck({ env, home, cwd, managed }) {
  const first = Object.hasOwn(env, "CE_RTK_BIN")
    ? { code: 1, stdout: "", stderr: "settings check: ERROR CE_RTK_BIN is set in the shell (stop)" }
    : { code: 0, stdout: "shell: CE_RTK_BIN absent", stderr: "" };
  if (first.code) return first;
  const r = checkSettings({ home, cwd, config: true, ...(managed ? { managed } : {}) });
  return { ...r, stdout: `${first.stdout}\n${r.stdout}` };
}

/** installed.mjs: the installed commit of each promoted plugin on Claude Code, and the Pi clone's HEAD. */
export function installedCheck({ home, plugins, marketplace = "context-economy", staging, run }) {
  return helper("installed check", (out) => {
    const f = `${home}/.claude/plugins/installed_plugins.json`;
    const j = readJson(f);
    const shas = {};
    for (const plugin of plugins) {
      let claude = "not installed";
      if (j !== MISSING) {
        if (!isObject(j) || !isObject(j.plugins)) throw new Error(`${f}: not {"plugins": {...}}`);
        const entry = j.plugins[`${plugin}@${marketplace}`];
        if (entry !== undefined) {
          const sha = Array.isArray(entry) && isObject(entry[0]) ? entry[0].gitCommitSha : undefined;
          if (typeof sha !== "string") throw new Error(`${f}: ${plugin} entry without gitCommitSha`);
          claude = sha;
        }
      }
      shas[plugin] = claude;
      out(`claude ${plugin}: ${claude}`);
    }
    const dir = `${home}/.pi/agent/git/github.com/${staging}`;
    let pi = "not installed";
    if (exists(dir)) {
      const r = run("git", ["-C", dir, "rev-parse", "HEAD"]);
      if (r.code !== 0) throw new Error(`${dir}: git rev-parse failed (${r.stderr || r.stdout})`);
      pi = r.stdout.trim();
    }
    out(`pi: ${pi}`);
    out("installed check: OK");
  });
}

/** Every row of each ledger directory under `home`, oldest first; `absent` for a missing directory. */
export function readLedgers(home, dirs) {
  const base = `${home}/.claude/context-economy/`;
  const out = {};
  for (const d of dirs) {
    let names;
    try { names = readdirSync(base + d); }
    catch (e) { if (e.code === "ENOENT") { out[d] = { absent: true, files: {} }; continue; } throw new Error(`${base + d}: ${e.message}`); }
    const files = {};
    for (const n of names.filter((n) => n.endsWith(".jsonl")).sort()) {
      const p = `${base}${d}/${n}`;
      const rows = [];
      readFileSync(p, "utf8").split("\n").forEach((line, i) => {
        if (line === "") return;
        let row;
        try { row = JSON.parse(line); } catch { throw new Error(`${p} line ${i + 1}: not valid JSON`); }
        if (!isObject(row)) throw new Error(`${p} line ${i + 1}: not a JSON object`);
        rows.push(row);
      });
      files[n] = rows;
    }
    out[d] = { absent: false, files };
  }
  return out;
}

/** Row count per ledger directory. */
export const ledgerCounts = (ledgers) => Object.fromEntries(Object.entries(ledgers).map(([d, v]) => [d, Object.values(v.files).reduce((n, rows) => n + rows.length, 0)]));

/** ledger.mjs: row counts and the last three rows of each gateway ledger, or "absent". */
export function ledgerCheck({ home, dirs }) {
  return helper("ledger check", (out) => {
    const ledgers = readLedgers(home, dirs);
    for (const d of dirs) {
      if (ledgers[d].absent) { out(`${d}: absent`); continue; }
      const rows = Object.values(ledgers[d].files).flat().sort((a, b) => (String(a.ts) < String(b.ts) ? -1 : 1));
      out(`${d}: ${rows.length} rows`);
      for (const r of rows.slice(-3)) out(`  ${r.ts} ${r.tool} rewrite=${r.rewrite} is_error=${r.is_error}`);
    }
    out("ledger check: OK");
  });
}

/** What a marketplace source is, from an allowlist of fields only (nothing else from the entry is printed). */
const describeSource = (src) => {
  if (!isObject(src)) return "(source not shown: not an object)";
  const kind = typeof src.source === "string" && /^[a-z][a-z-]*$/.test(src.source) ? src.source : "(kind not shown)";
  if (typeof src.repo === "string") {
    return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(src.repo) ? `${kind} ${src.repo}` : `${kind} (repo not shown)`;
  }
  if (typeof src.url === "string") {
    try {
      const u = new URL(src.url);
      return `${kind} ${u.protocol}//${u.host}${u.pathname}`;
    } catch {
      const scp = src.url.match(/^(?:[A-Za-z0-9_.-]+@)?([A-Za-z0-9.-]+):([A-Za-z0-9_.\/-]+)$/);
      return scp ? `${kind} ${scp[1]}:${scp[2]}` : `${kind} (url not shown)`;
    }
  }
  return `${kind} (no repo or url)`;
};

/** clean-b.mjs: clean check (b), after sign-in. */
export function cleanB({ home }) {
  return helper("clean check (b)", (out) => {
    const fails = [];
    const ip = `${home}/.claude/plugins/installed_plugins.json`;
    const installed = readJson(ip);
    if (installed === MISSING) out("installed_plugins.json: absent");
    else {
      if (!isObject(installed) || !isObject(installed.plugins)) throw new Error(`${ip}: not {"plugins": {...}}`);
      const names = Object.keys(installed.plugins);
      out(`installed_plugins.json: ${names.length} plugins${names.length ? ": " + names.join(", ") : ""}`);
      if (names.length) fails.push("a plugin is installed");
    }
    const km = `${home}/.claude/plugins/known_marketplaces.json`;
    const markets = readJson(km);
    if (markets === MISSING) out("known_marketplaces.json: absent");
    else {
      if (!isObject(markets)) throw new Error(`${km}: not a JSON object`);
      out(`known_marketplaces.json: ${Object.keys(markets).length} marketplaces`);
      for (const [name, entry] of Object.entries(markets)) {
        if (!isObject(entry)) throw new Error(`${km}: marketplace ${name} is not a JSON object`);
        out(`  ${name} ${describeSource(entry.source)}`);
        if (name === "context-economy" || JSON.stringify(entry).toLowerCase().includes("southcoltech-labs")) fails.push(`a context-economy marketplace is added (${name})`);
      }
    }
    for (const d of [`${home}/.pi/agent/git`, `${home}/.claude/context-economy`]) {
      const found = exists(d);
      out(`${d}: ${found ? "PRESENT" : "absent"}`);
      if (found) fails.push(`${d} exists`);
    }
    const f = `${home}/.claude/settings.json`;
    const s = readJson(f);
    if (s === MISSING) out("settings.json: absent");
    else {
      if (!isObject(s)) throw new Error(`${f}: not a JSON object`);
      if ("env" in s && !isObject(s.env)) throw new Error(`${f}: env is not a JSON object`);
      const set = "env" in s && "CE_RTK_BIN" in s.env;
      out(`settings.json: CE_RTK_BIN ${set ? "PRESENT" : "absent"}`);
      if (set) fails.push("settings.json sets CE_RTK_BIN");
    }
    if (fails.length) throw new Error(fails.join("; "));
    out("clean check (b): OK");
  });
}

/** `ls` of one folder, names only, sorted; for "the data left is exactly …" checks. */
export function listNames(dir) {
  return helper("ls", (out) => {
    if (!existsSync(dir)) throw new Error(`${dir}: No such file or directory`);
    for (const n of readdirSync(dir).sort()) out(n);
  });
}

/**
 * Claude Code must run in manual (default) mode. Reads `permissions.defaultMode` from the settings
 * files where readable. A value other than unset or "default" is a problem; unset does not prove
 * manual mode (a new account may still start in auto mode), so the instruction and the ledger
 * evidence stay the guard there.
 */
export function permissionMode({ home, cwd, managed = MANAGED_SETTINGS }) {
  const problems = [];
  const lines = [];
  for (const f of settingsFiles(home, cwd, managed)) {
    let s;
    // E12: a settings file that does not parse could hold a mode we cannot see, so it is a problem, not a note.
    try { s = readJson(f); } catch (e) { lines.push(`${f}: unreadable (${e.message})`); problems.push(`${f} is unreadable (${e.message})`); continue; }
    if (s === MISSING || !isObject(s)) continue;
    const mode = isObject(s.permissions) ? s.permissions.defaultMode : undefined;
    lines.push(`${f}: defaultMode ${mode === undefined ? "unset" : JSON.stringify(mode)}`);
    if (mode !== undefined && mode !== "default") problems.push(`${f} sets defaultMode ${JSON.stringify(mode)}`);
  }
  return { ok: problems.length === 0, problems, lines };
}
