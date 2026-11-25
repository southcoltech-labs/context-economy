// SPDX-License-Identifier: Apache-2.0

// Step data for the E1 driver's parts, transcribed from the owner run sheet (`e1b-0.1.2-runsheet.md`):
// every "Expect" line is an assertion here, written once. `e1a(vars)` returns the steps of an E1a run
// (the run sheet's Parts C and D, which are the same steps on the two platforms); `e1b[<part>](vars)`
// the steps of an E1b part.
//
// The steps are built before the proof modules are loaded, so a step that depends on them (which
// plugins, which ledger folders, which behaviour call) is a function of `ctx`, and the `match`
// functions read `ctx` when they run. Nothing plugin-specific is written here: names, hosts, ledger
// folders and the behaviour calls come from `scripts/proof/<name>.mjs`. One assumption is written here: every
// ledger folder sits directly under ~/.claude/context-economy/ (the data folder); a module that keeps its
// ledger anywhere else is a stop, not a ledger read in the wrong place.
//
// One departure from the run sheet: it ends E1a with `check-release-proof.mjs`, whose only expected
// error is the other platform's missing run. With one run file per platform that check has nothing to
// read until `combine`, so the driver stops at the recorder's own "recorded from capture" line.
//
// Several plugins: every plugin in the marketplace is installed, updated and uninstalled in the same run, and each
// host session (one per host per phase) carries every plugin's instructions and is judged entry by entry
// (e1-run.mjs). A plugin with an off switch gets its own session per host as well, run with the switch on.
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { HOSTS, StopError, asText, evidenceFor, readHostVersions } from "./e1-core.mjs";
import { GITLEAKS_VERSION } from "./e1-scrub.mjs";
import { cleanB, installedCheck, ledgerCheck, ledgerCounts, listNames, overrideCheck, readLedgers, rtkBlock } from "./e1-helpers.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MARKETPLACE = "context-economy";
const RTK_VERSION = "0.47.0";
// The Claude Code release the preparation installs when `claude` is missing (owner decision, 2026-11-15). It is
// at or above the version floor in e1-helpers.mjs (a test holds it there; the owner confirmed that release 2.1.310 exists; that the installer takes it as `bash -s 2.1.310` is untried);
// the host-version guard still reads what is really installed.
export const CLAUDE_PIN = "2.1.310";
const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const SHA40 = /^[0-9a-f]{40}$/m;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const lines = (out) => String(out).split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l !== "");

/** `{ ok, got }` for a match function: every pattern must be found in the output. */
const all = (out, checks) => {
  const missing = checks.filter(([re]) => !re.test(out)).map(([, what]) => what);
  return missing.length ? { ok: false, got: `missing: ${missing.join("; ")}\n${lines(out).join("\n") || "(no output)"}` } : { ok: true };
};

const plugins = (ctx, host) => ctx.proofs.filter((m) => m.hosts.includes(host));
/** Where the ledger folders live, relative to the home. The step data reads them by name under this folder (review 120 S7). */
const DATA_FOLDER = ".claude/context-economy";
const kindOf = (e) => e.kind ?? "call";
const hasCall = (m) => [...m.behaviour, ...m.uninstall, ...(m.offSwitch?.checks ?? [])].some((e) => kindOf(e) === "call");
/** Names of the ledger folders (under ~/.claude/context-economy/) of every proof module with a call entry; a stop for a ledger kept anywhere else. */
const ledgerFolders = (ctx) => [...new Set(ctx.proofs.filter(hasCall).flatMap((m) => Object.values(m.ledgerDirs).map((d) => {
  if (dirname(d) !== DATA_FOLDER) throw new StopError({ step: ctx.step?.id ?? "ledger folders", expected: `${m.name}'s ledger folder directly under ~/${DATA_FOLDER}/ (the step data reads ledgers there)`, got: d });
  return basename(d);
})))].sort();
const dataLeft = (ctx) => [...new Set(ctx.proofs.flatMap((m) => m.dataLeft))].sort();

/** The plugins shipping to `host`, in marketplace order; a stop when there is none. */
function pluginNames(ctx, host) {
  const found = plugins(ctx, host).map((m) => m.name);
  if (!found.length) throw new StopError({ step: ctx.step?.id ?? "plugins", expected: `at least one plugin shipping to ${host}`, got: "none" });
  return found;
}

/**
 * Every entry of `list` (`behaviour` or `uninstall`) for `host` across the proof modules, in marketplace order, as
 * `{ module, entry }`; a stop when there is none.
 */
function entriesFor(ctx, host, list) {
  const found = ctx.proofs.flatMap((m) => m[list].filter((e) => e.host === host).map((entry) => ({ module: m, entry })));
  if (!found.length) throw new StopError({ step: ctx.step.id, expected: `at least one ${list} entry for ${host} across the proof modules`, got: "none" });
  return found;
}

/**
 * The entries of an off-switch session for `host` and `module`: the module's own off-switch checks, and every other module's
 * behaviour entries (the other plugins must still work with the switch on), in marketplace order.
 */
function offSwitchEntries(ctx, host, module) {
  return ctx.proofs.filter((m) => m.hosts.includes(host)).flatMap((m) => (m === module
    ? m.offSwitch.checks.filter((e) => e.host === host).map((entry) => ({ module: m, entry, as: "off-switch" }))
    : m.behaviour.filter((e) => e.host === host).map((entry) => ({ module: m, entry, as: "behaviour" }))));
}

/** The evidence of one entry for a step's `human.entries`. */
const entryOf = ({ module, entry, as }, phase) => (kindOf(entry) === "visual"
  ? { plugin: module.name, kind: "visual", expect: entry.expect }
  : { plugin: module.name, kind: "call", evidence: evidenceFor(module, entry, as ?? phase) });

/** What the operator is told to do: each entry's lines, prefixed with the plugin's name when several plugins share the session. */
function sessionLines(pairs) {
  const several = new Set(pairs.map((p) => p.module.name)).size > 1;
  return pairs.flatMap((p) => (kindOf(p.entry) === "visual" ? p.entry.say : [`Type: Run ${p.entry.command}`]).map((l) => (several ? `${p.module.name}: ${l}` : l)));
}
/** The number of leading lines of `sessionLines(pairs)` up to and including the last call entry's line: the permission prompt appears right after that call. */
function linesThroughLastCall(pairs) {
  const last = pairs.findLastIndex((p) => kindOf(p.entry) === "call");
  return last < 0 ? 0 : sessionLines(pairs.slice(0, last + 1)).length;
}
/** The commands of the session's call entries, for the lines that ask for approval. */
const callCommands = (pairs) => pairs.filter((p) => kindOf(p.entry) === "call").map((p) => `\`${p.entry.command}\``).join(" and ");

/** The `human` data of a session: `host`, the instructions and `entries`. `phase` is `behaviour` or `uninstall`. */
function sessionHuman(ctx, host, pairs, phase, { env } = {}) {
  const calls = callCommands(pairs);
  const lines = sessionLines(pairs);
  const approve = !calls ? [] : phase === "uninstall"
    ? [`Approve the permission prompt for ${calls}.`, "Expect Git's own `On branch main ...` output, with no RTK path."]
    : host === "claude" ? [`Approve the permission prompt for the RTK path and ${calls} (it shows the rewrite reached Claude Code).`] : [];
  // Claude, behaviour phase: the prompt for the RTK path comes right after the call's line, before any later visual lines.
  const afterCall = host === "claude" && phase !== "uninstall" ? linesThroughLastCall(pairs) : lines.length;
  const say = host === "claude"
    ? ["Check the footer shows no 'auto mode' (Shift+Tab until it does not).", ...lines.slice(0, afterCall), ...approve, ...lines.slice(afterCall), "Then quit with /exit."]
    : [...lines, ...(phase === "uninstall" ? approve.slice(1) : []), "Then quit Pi."];
  return { host, say, entries: pairs.map((p) => entryOf(p, phase)), ...(env ? { env } : {}) };
}

const syncRun = (ctx) => ctx.deps.runSync ?? ((cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", env: ctx.env });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
});
const installed = (ctx) => installedCheck({
  home: ctx.env.HOME, plugins: pluginNames(ctx, "claude"), marketplace: MARKETPLACE, staging: ctx.vars.staging, run: syncRun(ctx),
});
const ledgers = (ctx) => ledgerCheck({ home: ctx.env.HOME, dirs: ledgerFolders(ctx) });
const rowCounts = (ctx) => ledgerCounts(readLedgers(ctx.env.HOME, ledgerFolders(ctx)));
/** The recorder runs from this driver's checkout (it is the driver's tooling), in the clone under test (where the proof files go). */
const recorder = (ctx, command, claude, pi) => ["node", join(HERE, "e1a-record.mjs"), command, "--version", ctx.vars.V, "--sha", ctx.sha, "--platform", ctx.vars.platform, "--pi-repo", ctx.vars.staging, "--claude", claude, "--pi", pi];
/**
 * `pass` for a host only when every host step of `phases` (a tag on the step: `behaviour`, `off-switch` or `uninstall`)
 * in the assembled step list has a recorded `pass`. A planned step that is missing, aborted or failed gives `fail`;
 * the answer does not depend on one fixed step id.
 */
const hostResult = (ctx, host, phases) => {
  const ids = (ctx.steps ?? []).filter((s) => s.tag?.host === host && phases.includes(s.tag.phase)).map((s) => s.id);
  return ids.length && ids.every((id) => ctx.hostResults[id]?.result === "pass") ? "pass" : "fail";
};
const ledgersHaveRows = (out, ctx) => all(out, [...ledgerFolders(ctx).map((d) => [new RegExp(`^${esc(d)}: [1-9]\\d* rows$`, "m"), `${d}: at least 1 row`]), [/ledger check: OK/, "ledger check: OK"]]);


// --- builders shared by E1a and E1b ----------------------------------------------------------------

/**
 * A step's commands and the assertions on them, together, so the `cmd` indices cannot drift from the
 * list. Each item: `{ argv: [..] | (ctx) => [..] }` or `{ label, fn }`, and `expects` (the `expect`
 * entries without `cmd`), or `{ each: (ctx) => [item, ...] }` for a group with one item per plugin. The commands
 * are a function of `ctx`, because they name the plugins; with an `each`, so is `expect`.
 */
function seq(items) {
  const flat = (ctx) => items.flatMap((it) => (it.each ? it.each(ctx) : [it]));
  const expectOf = (list) => list.flatMap((it, cmd) => (it.expects ?? []).map((e) => ({ cmd, ...e })));
  return {
    run: (ctx) => flat(ctx).map((it) => (it.fn ? { label: it.label, fn: it.fn } : typeof it.argv === "function" ? it.argv(ctx) : it.argv)),
    expect: items.some((it) => it.each) ? (ctx) => expectOf(flat(ctx)) : expectOf(items),
  };
}

/** A match function for "every line of `checks(ctx)` is found". */
const found = (checks) => (out, ctx) => all(out, checks(ctx));

/** README section 1: the RTK install, `config.json`, and the override check (run sheet A.2/A.3 and C.2). */
function rtkStep(id, title = "Install RTK and write config.json") {
  const rtkPath = (ctx) => `${ctx.env.HOME}/.local/opt/rtk-${RTK_VERSION}/rtk`;
  return { id, title, ...seq([
    { label: "write ~/run-install.sh from the clone's README, section 1", fn: (ctx) => {
      const file = join(ctx.env.HOME, "run-install.sh");
      writeFileSync(file, rtkBlock(readFileSync(join(ctx.cwd, "README.md"), "utf8")), { mode: 0o600 });
      return { code: 0, out: `wrote ${file}` };
    } },
    { argv: ["bash", "-c", 'bash "$HOME/run-install.sh"'], expects: [{ describe: `the RTK lines \`rtk ${RTK_VERSION}\` and \`rtk.path: <home>/.local/opt/rtk-${RTK_VERSION}/rtk\``,
      match: found((ctx) => [[new RegExp(`^rtk ${esc(RTK_VERSION)}$`, "m"), `rtk ${RTK_VERSION}`], [new RegExp(`^rtk\\.path: ${esc(rtkPath(ctx))}$`, "m"), "the rtk.path line"]]) }] },
    { label: "write ~/.claude/context-economy/config.json", fn: (ctx) => {
      const dir = join(ctx.env.HOME, ".claude", "context-economy");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "config.json"), `{\n  "rtk": { "path": "${rtkPath(ctx)}" }\n}\n`);
      return { code: 0, out: "" };
    } },
    { label: "cat ~/.claude/context-economy/config.json", fn: (ctx) => ({ code: 0, out: readFileSync(join(ctx.env.HOME, ".claude", "context-economy", "config.json"), "utf8") }),
      expects: [{ describe: "config.json naming the RTK install", match: found((ctx) => [[new RegExp(`"path": "${esc(rtkPath(ctx))}"`), "rtk.path in config.json"]]) }] },
    { label: ". ~/override.sh (the settings check)", fn: (ctx) => overrideCheck({ env: ctx.env, home: ctx.env.HOME, cwd: ctx.cwd, ...(ctx.deps.managedSettings ? { managed: ctx.deps.managedSettings } : {}) }),
      expects: [{ match: /settings check: OK/ }] },
  ]) };
}

/** `installed check` with every plugin's commit and Pi's equal to `sha(ctx)`. */
const installedAt = (sha) => ({ label: "installed check (installed_plugins.json and the Pi clone)", fn: installed,
  expects: [{ describe: "every installed commit equals the expected one, then `installed check: OK`",
    match: found((ctx) => [...pluginNames(ctx, "claude").map((n) => [new RegExp(`^claude ${esc(n)}: ${sha(ctx)}$`, "m"), `${n} at ${sha(ctx)}`]), [new RegExp(`^pi: ${sha(ctx)}$`, "m"), `pi at ${sha(ctx)}`], [/installed check: OK/, "installed check: OK"]]) }] });

const installedNone = { label: "installed check", fn: installed,
  expects: [{ describe: "every plugin and Pi `not installed`, then `installed check: OK`",
    match: found((ctx) => [...pluginNames(ctx, "claude").map((n) => [new RegExp(`^claude ${esc(n)}: not installed$`, "m"), `${n} not installed`]), [/^pi: not installed$/m, "pi not installed"], [/installed check: OK/, "installed check: OK"]]) }] };

/** Install from `ref` (a tag, `release` or `promoted-v…`): marketplace add, plugin install, Pi install, installed check. */
function installStep(id, title, { ref, sha, removeFirst = false }) {
  return { id, title, ...seq([
    ...(removeFirst ? [{ argv: ["claude", "plugin", "marketplace", "remove", MARKETPLACE] }] : []),
    { argv: (ctx) => ["claude", "plugin", "marketplace", "add", `${ctx.vars.staging}#${ref(ctx)}`], expects: [{ match: /Successfully added marketplace/ }] },
    { each: (ctx) => pluginNames(ctx, "claude").map((name) => ({ argv: ["claude", "plugin", "install", `${name}@${MARKETPLACE}`],
      expects: [{ describe: `a successful install of ${name}`, match: found(() => [[new RegExp(`Successfully installed plugin: ${esc(name)}@${MARKETPLACE}`), `${name} installed`]]) }] })) },
    { argv: (ctx) => ["pi", "install", `git:github.com/${ctx.vars.staging}@${ref(ctx)}`],
      expects: [{ describe: "Pi's install line", match: found((ctx) => [[new RegExp(`Installed git:github\\.com/${esc(ctx.vars.staging)}@${esc(ref(ctx))}`), "Pi's install line"]]) }] },
    installedAt(sha),
  ]) };
}

/** README section 3's update: marketplace update, plugin update, `pi update --extensions`, then the installed check. */
function updateStep(id, title, { sha, notMention }) {
  const quiet = notMention ? [{ describe: "no output naming the other version", match: (out, ctx) => !new RegExp(`\\b${esc(notMention(ctx))}\\b`).test(out) }] : [];
  return { id, title, ...seq([
    { argv: ["claude", "plugin", "marketplace", "update", MARKETPLACE], expects: quiet },
    { each: (ctx) => pluginNames(ctx, "claude").map((name) => ({ argv: ["claude", "plugin", "update", `${name}@${MARKETPLACE}`], expects: quiet })) },
    { argv: ["pi", "update", "--extensions"], expects: quiet },
    installedAt(sha),
  ]) };
}

/** One session per host with every plugin's behaviour (a call, a visual), and the ledger check: the run sheet's A.5, C.4 and "still rewriting". */
function behaviourSteps(prefix, title) {
  return [
    { id: `${prefix}a`, title: `Claude Code: ${title}`, tag: { phase: "behaviour", host: "claude" },
      human: (ctx) => sessionHuman(ctx, "claude", entriesFor(ctx, "claude", "behaviour"), "behaviour") },
    { id: `${prefix}b`, title: `Pi: ${title}`, tag: { phase: "behaviour", host: "pi" },
      human: (ctx) => sessionHuman(ctx, "pi", entriesFor(ctx, "pi", "behaviour"), "behaviour") },
    { id: `${prefix}c`, title: "Ledgers after the behaviour test", ...seq([
      { label: "node ~/ledger.mjs", fn: ledgers, expects: [{ describe: "every ledger with a row, then `ledger check: OK`", match: ledgersHaveRows }] },
    ]) },
  ];
}

/**
 * For each plugin with an off switch, one session per host with the switch on (E1a only): the plugin's own checks, and the
 * other plugins' behaviour (they must still work). The result counts toward the host's `behavior=` in the capture.
 */
function offSwitchSteps(prefix) {
  return { id: `${prefix}s`, title: "Off-switch sessions", expand: (ctx) => ctx.proofs.filter((m) => m.offSwitch).flatMap((m) => HOSTS
    .filter((h) => m.hosts.includes(h))
    .map((host) => ({
      id: `${prefix}s.${m.name}.${host}`, title: `${host === "claude" ? "Claude Code" : "Pi"}: ${m.name} off (${Object.entries(m.offSwitch.env).map(([k, v]) => `${k}=${v}`).join(" ")})`,
      tag: { phase: "off-switch", host },
      human: (c) => sessionHuman(c, host, offSwitchEntries(c, host, m), "behaviour", { env: m.offSwitch.env }),
    }))) };
}

/** E1b "still rewriting": the override check, then one new rewritten `git status` per host with its ledger row. */
function stillRewriting(prefix) {
  return [
    { id: `${prefix}o`, title: "Override check", ...seq([
      { label: ". ~/override.sh", fn: (ctx) => overrideCheck({ env: ctx.env, home: ctx.env.HOME, cwd: ctx.cwd, ...(ctx.deps.managedSettings ? { managed: ctx.deps.managedSettings } : {}) }), expects: [{ match: /settings check: OK/ }] },
    ]) },
    ...behaviourSteps(prefix, "still rewriting"),
  ];
}

/** Uninstall, the ledgers, one plain `git status` per host, row counts unchanged, and the data left. */
function uninstallSteps(prefix) {
  return [
    { id: `${prefix}a`, title: "Uninstall and check", ...seq([
      { each: (ctx) => pluginNames(ctx, "claude").map((name) => ({ argv: ["claude", "plugin", "uninstall", `${name}@${MARKETPLACE}`],
        expects: [{ describe: `a successful uninstall of ${name}`, match: found(() => [[new RegExp(`Successfully uninstalled plugin: ${esc(name)}`), `${name} uninstalled`]]) }] })) },
      { argv: (ctx) => ["pi", "remove", `git:github.com/${ctx.vars.staging}`],
        expects: [{ describe: "Pi's remove line", match: found((ctx) => [[new RegExp(`Removed git:github\\.com/${esc(ctx.vars.staging)}`), "Pi's remove line"]]) }] },
      installedNone,
      { label: "node ~/ledger.mjs", fn: ledgers, expects: [{ describe: "every ledger with rows, then `ledger check: OK`", match: ledgersHaveRows }] },
    ]), set: (ctx) => { ctx.results.rowsBeforeUninstallRuns = rowCounts(ctx); } },
    { id: `${prefix}b`, title: "Claude Code after uninstall: plain git status", tag: { phase: "uninstall", host: "claude" },
      human: (ctx) => sessionHuman(ctx, "claude", entriesFor(ctx, "claude", "uninstall"), "uninstall") },
    { id: `${prefix}c`, title: "Pi after uninstall: plain git status", tag: { phase: "uninstall", host: "pi" },
      human: (ctx) => sessionHuman(ctx, "pi", entriesFor(ctx, "pi", "uninstall"), "uninstall") },
    { id: `${prefix}d`, title: "Ledgers unchanged, data left", ...seq([
      { label: "node ~/ledger.mjs", fn: ledgers, expects: [{ match: /ledger check: OK/ }] },
      { label: "ls ~/.claude/context-economy", fn: (ctx) => listNames(join(ctx.env.HOME, ".claude", "context-economy")),
        expects: [{ describe: "the data left (config.json and the ledger folders)", match: found((ctx) => dataLeft(ctx).map((n) => [new RegExp(`(?:^|\\s)${esc(n)}(?=\\s|$)`, "m"), n])) }] },
    ]),
    after: [
      // The row counts are the same as before the two uninstall runs.
      (ctx) => {
        const was = JSON.stringify(ctx.results.rowsBeforeUninstallRuns), now = JSON.stringify(rowCounts(ctx));
        return was === now ? { ok: true } : { ok: false, expected: `the ledger row counts to stay ${was}`, got: now };
      },
      // Exactly the data left, nothing more (a live check: the replay cannot see the disk).
      (ctx) => {
        const got = listNames(join(ctx.env.HOME, ".claude", "context-economy")).stdout.split("\n").filter(Boolean);
        const want = dataLeft(ctx);
        return JSON.stringify(got) === JSON.stringify(want) ? { ok: true } : { ok: false, expected: `exactly ${want.join(", ")} left`, got: got.join(", ") };
      },
    ] },
  ];
}

// --- E1a -----------------------------------------------------------------------------------------

export function e1aSteps(vars) {
  const { V, platform } = vars;
  return [
    { id: "E1a.0", title: "Clean check (b)", ...seq([
      { label: "node ~/clean-b.mjs", fn: (ctx) => cleanB({ home: ctx.env.HOME }), expects: [{ match: /clean check \(b\): OK/ }] },
    ]) },

    { id: "E1a.1", title: "Inputs and the clone", ...seq([
      { argv: ["git", "fetch", "--tags", "origin"] }, { argv: ["git", "checkout", "-q", "main"] }, { argv: ["git", "pull", "-q", "--ff-only"] },
      { argv: ["git", "rev-parse", `v${V}^{commit}`], expects: [{ match: SHA40 }] },
      { argv: ["git", "rev-parse", "HEAD"], expects: [{ match: SHA40 }] },
      // No proof file or capture for this version yet (the recorder would refuse a mixed state anyway).
      { argv: ["ls", "docs/release-proof/"], expects: [{ notMatch: new RegExp(`(?:^|\\s)${esc(V)}(?:-[a-z0-9-]+)?(?:\\.capture)?\\.json(?=\\s|$)`, "m") }] },
    ]),
    after: [(ctx, { results }) => {
      const sha = results[3].out.trim(), head = results[4].out.trim();
      return sha === head ? { ok: true } : { ok: false, expected: `the tag's commit (${sha}) to equal HEAD of main`, got: `HEAD is ${head}` };
    }],
    set: (ctx, results) => { ctx.sha = results[3].out.trim(); } },

    rtkStep("E1a.2"),
    installStep("E1a.3", "Install the candidate", { ref: () => `v${V}`, sha: (ctx) => ctx.sha }),
    ...behaviourSteps("E1a.4", "one rewritten Bash call"),
    offSwitchSteps("E1a.4"),

    { id: "E1a.5", title: "Capture", ...seq([
      { argv: (ctx) => recorder(ctx, "capture", `install=pass,behavior=${hostResult(ctx, "claude", ["behaviour", "off-switch"])}`, `install=pass,behavior=${hostResult(ctx, "pi", ["behaviour", "off-switch"])}`), expects: [{ match: /captured [0-9a-f-]{36} \(pass so far\)/ }] },
      { argv: ["ls", "docs/release-proof/"], expects: [{ describe: "the capture file listed", match: (out) => all(out, [[new RegExp(`(?:^|\\s)${esc(V)}-${esc(platform)}\\.capture\\.json(?=\\s|$)`, "m"), "the capture file"]]) }] },
    ]) },

    ...uninstallSteps("E1a.6"),

    { id: "E1a.7", title: "Finalize", ...seq([
      { argv: (ctx) => recorder(ctx, "finalize", `uninstall=${hostResult(ctx, "claude", ["uninstall"])}`, `uninstall=${hostResult(ctx, "pi", ["uninstall"])}`), expects: [{ match: /recorded from capture [0-9a-f-]{36} \(Claude pass, Pi pass\)/ }] },
      { label: "copy the run file into the attempt folder; print its SHA-256 and capture id", fn: (c) => {
        const file = join(c.cwd, "docs", "release-proof", `${V}-${platform}.json`);
        if (!existsSync(file)) return { code: 1, out: `${file} was not written` };
        const text = readFileSync(file, "utf8");
        copyFileSync(file, join(c.attemptDir, basename(file)));
        const run = JSON.parse(text).runs?.[0];
        return { code: 0, out: `${createHash("sha256").update(text).digest("hex")}  ${basename(file)}\n${run?.platform} ${run?.capture_id}\n` };
      }, expects: [{ describe: "the run file's hash and its platform with a capture id",
        match: (out, ctx) => all(out, [[/^[0-9a-f]{64}  /m, "a SHA-256"], [new RegExp(`^${esc(ctx.vars.platform)} [0-9a-f-]{36}$`, "m"), "platform and capture id"]]) }] },
      { argv: ["ls", "docs/release-proof/"], expects: [{ describe: "the capture consumed (no `*.capture.json` left)", notMatch: /\.capture\.json/ }] },
    ]) },
  ];
}

// --- E1b -------------------------------------------------------------------------------------------
//
// The drill's parts are run one at a time, in one account, against one drill folder; what a later part
// needs from an earlier one (the two commits, the snapshot) is kept in `drill-state.json` there.
//
//   baseline     run sheet Part A: A installed from `release`, both hosts rewriting, the data snapshot
//   undelivered  Part B: an unpromoted B is not delivered by an update
//   promoted     Part E.6: `promoted-v<B>` and `origin/release` are B (the promotion itself is read by the engineer)
//   cycle        Part F: update to B, roll back to A, pinned tag stays, return to `release`, uninstall
//
// Step numbers: E1a.N is the run sheet's C.N (and D, the same steps on Linux); `undelivered` B.N, `promoted` E.6
// and `cycle` F.N are the sheet's own. The `baseline` part is numbered by the driver and differs from the sheet:
//   driver A.0 = sheet Part 0.4 (clean check)     driver A.3 = sheet A.4 (install A from release)
//   driver A.1 = sheet A.1                         driver A.4 = sheet A.5 (use both hosts; git status only)
//   driver A.2 = sheet A.2 and A.3 (RTK, override) driver A.5 = sheet A.6 (snapshot)
// Each baseline title also names its sheet step, so a transcript read beside the sheet needs no table.
//
// One narrowing of the behaviour step (owner decision, 2026-11-14, "V3 option A"): the run sheet's A.5 had
// `Run git status` and then `Run ls docs` in each host; the driver's behaviour step is `git status` only.
// Departures from the run sheet are listed in the piece 3 report.

const stateFile = (ctx) => join(ctx.folder, "drill-state.json");
function readState(ctx) {
  try { return JSON.parse(readFileSync(stateFile(ctx), "utf8")); }
  catch (e) { if (e.code === "ENOENT") return {}; throw new StopError({ step: ctx.step?.id ?? "drill state", expected: `a readable ${stateFile(ctx)}`, got: e.message }); }
}
function writeState(ctx, patch) {
  writeFileSync(stateFile(ctx), `${JSON.stringify({ ...readState(ctx), ...patch }, null, 2)}\n`, { mode: 0o600 });
}
/** A value an earlier part recorded; a stop when this part runs without it. */
function recorded(ctx, key) {
  const v = readState(ctx)[key];
  if (v === undefined) throw new StopError({ step: ctx.step.id, expected: `\`${key}\` recorded by an earlier part in ${stateFile(ctx)}`, got: "(not recorded: run the earlier parts first, with the same --drill)" });
  return v;
}
/** The B commit this part read must equal the one an earlier part recorded for the same B (review 120 S5). */
const sameRecordedB = (b, index) => (ctx, { results }) => {
  const now = commitLines(results[index].out)[0], state = readState(ctx);
  // One drill folder is one A-to-B drill (review 123 W2): another B than the recorded one is a stop, not a replacement.
  if (state.b !== undefined && state.b !== b) return { ok: false, expected: `--b ${state.b}, the B this drill folder recorded (one folder is one drill; use a new --drill for ${b})`, got: `--b ${b}` };
  return state.shaB !== undefined && state.shaB !== now
    ? { ok: false, expected: `v${b}'s commit to equal the ${state.shaB} an earlier part recorded`, got: now }
    : { ok: true };
};
const shaA = (ctx) => recorded(ctx, "shaA");
const shaB = (ctx) => recorded(ctx, "shaB");

const DOTTED = /^\d+(\.\d+)+$/;
function needVersions(vars, ...names) {
  for (const n of names) if (!DOTTED.test(String(vars[n] ?? ""))) throw new Error(`part ${vars.part} needs --${n} <version>, such as 0.1.2`);
}

/** Lines of a `git rev-parse` of several names: each must be a commit id. */
const commitLines = (out) => lines(out).filter((l) => SHA40.test(l));
/** `{ ok, got }` for rev-parse output that must equal `want` line by line. */
const equalLines = (want) => (out, ctx) => {
  const got = commitLines(out), w = want(ctx);
  return JSON.stringify(got) === JSON.stringify(w) ? { ok: true } : { ok: false, got: `${got.join(" ") || lines(out).join(" ") || "(no output)"}\n(expected ${w.join(" ")})` };
};
const firstVersion = (out) => /"version"\s*:\s*"([^"]+)"/.exec(out)?.[1];

/** The data check: the snapshot's ledger rows and `config.json` survive. */
const dataCheck = (id, title = "Data check") => ({ id, title, ...seq([
  { argv: (ctx) => ["node", join(HERE, "e1b-data.mjs"), "check", recorded(ctx, "snapshot")],
    expects: [{ describe: "`all N ledger files and config.json survive`, N being the snapshot's", match: (out, ctx) => {
      const m = /^all (\d+) ledger files and config\.json survive$/m.exec(out);
      const want = recorded(ctx, "ledgerFiles");
      return m && Number(m[1]) === want ? { ok: true } : { ok: false, got: `${lines(out).join("\n") || "(no output)"}\n(expected all ${want} ledger files)` };
    } }] },
]) });

const fetchTags = { argv: ["git", "fetch", "--tags", "origin"] };

/**
 * The compatibility preflight (review 142). The proof modules are the clone's current ones, so a drill whose version predates
 * a plugin would ask for checks of a plugin that version does not have. Each part first compares the plugins listed in
 * `.claude-plugin/marketplace.json` at the tags it will use with the loaded proof modules; any difference stops the part
 * before any install, update, uninstall, host launch or drill-state change. `refs(ctx)` names the tags: the baseline reads
 * A's only (B's tag does not exist yet), the later parts read A's and B's.
 */
const sameAsModules = (ref) => ({ argv: ["git", "show", `${ref}:.claude-plugin/marketplace.json`], expects: [{
  describe: `the plugins listed at ${ref} to be the ones the proof modules cover`,
  match: (out, ctx) => {
    let names;
    try { names = (JSON.parse(out).plugins ?? []).map((p) => p?.name); } catch { return { ok: false, got: `${ref}:.claude-plugin/marketplace.json does not parse` }; }
    const have = [...ctx.proofs.map((m) => m.name)].sort(), listed = [...names].sort();
    return JSON.stringify(have) === JSON.stringify(listed) ? { ok: true } : { ok: false, got: `${ref} lists [${listed.join(", ")}] but the proof modules cover [${have.join(", ")}] (this drill is not compatible with the current marketplace; use a drill whose versions list the same plugins, or run it by hand)` };
  } }] });
const preflightStep = (refs) => ({ id: "PF", title: "Compatibility preflight: the plugins at each tag match the proof modules", ...seq([fetchTags, { each: (ctx) => refs(ctx).map(sameAsModules) }]) });

export function baselineSteps(vars) {
  needVersions(vars, "a");
  const { a, b } = vars;
  if (b !== undefined) needVersions(vars, "b");
  return [
    preflightStep(() => [`v${a}`]),
    { id: "A.0", title: "Clean check (b) (run sheet Part 0.4)", ...seq([{ label: "node ~/clean-b.mjs", fn: (ctx) => cleanB({ home: ctx.env.HOME }), expects: [{ match: /clean check \(b\): OK/ }] }]) },
    { id: "A.1", title: `Update the clone and check the promotion of ${a} (run sheet A.1)`, ...seq([
      fetchTags, { argv: ["git", "checkout", "-q", "main"] }, { argv: ["git", "pull", "-q", "--ff-only"] },
      { argv: ["git", "rev-parse", `promoted-v${a}^{commit}`], expects: [{ match: SHA40 }] },
      { argv: ["git", "rev-parse", "origin/release"], expects: [{ match: SHA40 }] },
      // Optional (the runbook does not require it); when it is not made, the transcript says so.
      b === undefined
        ? { label: "B is not tagged yet", fn: () => ({ code: 0, out: "not checked: no --b given, so B is unknown to this part\n" }) }
        : { argv: ["git", "ls-remote", "--tags", "origin", `refs/tags/v${b}*`], expects: [{ describe: `no tag for ${b} yet (B is not tagged)`, match: (out) => out.trim() === "" }] },
    ]),
    after: [(ctx, { results }) => {
      const promoted = results[3].out.trim(), release = results[4].out.trim();
      return promoted === release ? { ok: true } : { ok: false, expected: `\`promoted-v${a}\` (${promoted}) to equal origin/release`, got: `origin/release is ${release}` };
    }],
    set: (ctx, results) => writeState(ctx, { a, shaA: results[3].out.trim() }) },
    rtkStep("A.2", "Install RTK, write config.json and run the override check (run sheet A.2, A.3)"),
    installStep("A.3", `Install ${a} from release (run sheet A.4)`, { ref: () => "release", sha: shaA }),
    ...behaviourSteps("A.4", "both hosts rewriting (run sheet A.5)"),
    { id: "A.5", title: "Snapshot (run sheet A.6)", ...seq([
      { argv: (ctx) => ["node", join(HERE, "e1b-data.mjs"), "snapshot", join(ctx.folder, "e1b-snapshot.json")], expects: [{ describe: "the snapshot written", match: /\d+ ledger files and config\.json/ }] },
    ]), set: (ctx, results) => writeState(ctx, { snapshot: join(ctx.folder, "e1b-snapshot.json"), ledgerFiles: Number(/(\d+) ledger files and config\.json/.exec(results[0].out)[1]) }) },
  ];
}

export function undeliveredSteps(vars) {
  needVersions(vars, "a", "b");
  const { a, b } = vars;
  const versionAt = (ref, file, want) => ({ argv: ["git", "show", `${ref}:${file}`], expects: [{ describe: `\`"version": "${want}"\` in ${ref}:${file}`, match: (out) => (firstVersion(out) === want ? { ok: true } : { ok: false, got: `version ${firstVersion(out) ?? "(none)"}` }) }] });
  const manifests = (ref, want) => ({ each: (ctx) => pluginNames(ctx, "claude").map((n) => versionAt(ref, `plugins/${n}/.claude-plugin/plugin.json`, want)) });
  return [
    preflightStep(() => [`v${a}`, `v${b}`]),
    { id: "B.1", title: `Read the two versions (${b} on main, ${a} on release)`, ...seq([
      fetchTags,
      { argv: ["git", "rev-parse", `v${b}^{commit}`, "origin/main", "origin/release"],
        expects: [{ describe: `the tag's commit twice (v${b}, origin/main), then A's commit (origin/release)`, match: (out, ctx) => equalLines((c) => { const sha = commitLines(out)[0]; return [sha, sha, shaA(c)]; })(out, ctx) }] },
      versionAt("origin/main", "package.json", b), manifests("origin/main", b),
      versionAt("origin/release", "package.json", a), manifests("origin/release", a),
    ]), after: [sameRecordedB(b, 1)], set: (ctx, results) => writeState(ctx, { b, shaB: commitLines(results[1].out)[0] }) },
    // README section 3's "restart the host" (start and quit without typing) is not a step here: there is no call to give evidence for.
    updateStep("B.2", `Update: ${b} is not delivered`, { sha: shaA, notMention: () => b }),
  ];
}

export function promotedSteps(vars) {
  needVersions(vars, "b");
  const { b } = vars;
  return [
    preflightStep((ctx) => [`v${vars.a ?? recorded(ctx, "a")}`, `v${b}`]),
    { id: "E.6", title: `Record the promotion of ${b}`, ...seq([
      fetchTags,
      { argv: ["git", "rev-parse", `promoted-v${b}^{commit}`, "origin/release", `v${b}^{commit}`],
        expects: [{ describe: `\`promoted-v${b}\`, origin/release and v${b} all the same commit`, match: (out) => { const c = commitLines(out); return c.length === 3 && c.every((x) => x === c[0]) ? { ok: true } : { ok: false, got: c.join(" ") || lines(out).join(" ") || "(no output)" }; } }] },
    ]), after: [sameRecordedB(b, 1)], set: (ctx, results) => writeState(ctx, { b, shaB: commitLines(results[1].out)[0] }) },
  ];
}

export function cycleSteps(vars) {
  needVersions(vars, "a", "b");
  const { a, b } = vars;
  return [
    preflightStep(() => [`v${a}`, `v${b}`]),
    { id: "F.1", title: "Versions and the promotion", ...seq([
      fetchTags, { argv: ["git", "pull", "-q", "--ff-only"] },
      { argv: ["git", "rev-parse", `promoted-v${b}^{commit}`, "origin/release", `promoted-v${a}^{commit}`], expects: [{ describe: "B, B, then A", match: equalLines((ctx) => [shaB(ctx), shaB(ctx), shaA(ctx)]) }] },
    ]) },
    updateStep("F.2", `Update to ${b} (README section 3)`, { sha: shaB }),
    ...stillRewriting("F.2r"), dataCheck("F.2d", "Data check after the update"),
    installStep("F.3", `Roll back to ${a} (README section 4)`, { ref: () => `promoted-v${a}`, sha: shaA, removeFirst: true }),
    ...stillRewriting("F.3r"), dataCheck("F.3d", "Data check after the rollback"),
    updateStep("F.4", "A pinned tag does not move", { sha: shaA, notMention: () => b }),
    installStep("F.5", "Return to updates (release)", { ref: () => "release", sha: shaB, removeFirst: true }),
    ...stillRewriting("F.5r"), dataCheck("F.5d", "Data check after the return"),
    ...uninstallSteps("F.6"), dataCheck("F.6e", "Data check after the uninstall"),
  ];
}

// --- prepare (run sheet Part 0 after the account exists) --------------------------------------------
//
// Runs in the new account before there is a clone, a plugin or a host. Not in this part: creating the account,
// signing in to Claude Code and Pi (a pause, below), clean check (a) and Node and git (`scripts/e1-bootstrap.sh`,
// which needs no Node). UNTRIED on a real account: the installs below have only run against fakes.
//
// Install route (owner decision, review 121 T1; the published runs used this):
//   Claude Code  per-account, the pinned installer, on both platforms.
//   Pi           Linux: `npm install -g --ignore-scripts` into the account's own npm prefix (nvm, from the bootstrap),
//                and a stop when the prefix is not under the account's home (a system prefix would need root).
//                macOS: never installed here. The standard account uses the machine-wide Pi the admin account
//                installed; when it is missing the part stops and says what the admin must run.

const UNAME = { "macos-arm64": /^Darwin arm64$/m, "linux-x86_64": /^Linux x86_64$/m };

/** `find ~/.claude ~/.pi -maxdepth 3`: names only, never a file's contents (sign-in files are in there), links not followed. */
export function listHome(home) {
  const out = [];
  const walk = (dir, depth) => {
    out.push(dir.replace(home, "~"));
    if (depth >= 3) return;
    let names;
    try { if (!lstatSync(dir).isDirectory()) return; names = readdirSync(dir).sort(); } catch { return; }
    for (const n of names) walk(`${dir}/${n}`, depth + 1);
  };
  for (const d of [".claude", ".pi"]) {
    if (existsSync(join(home, d))) walk(join(home, d), 0);
    else out.push(`~/${d}: No such file or directory`);
  }
  return { code: 0, out: `${out.join("\n")}\n` };
}

const execIn = (ctx, cmd) => ctx.deps.exec("bash", ["-c", cmd], { cwd: ctx.cwd, env: ctx.env });
const text = (r) => (r.out ?? r.stdout ?? "").trim();

/** Install a CLI with `install` only when `bin` is not on PATH (a second run of the part changes nothing). */
const installIfMissing = (label, bin, install) => ({ label, fn: async (ctx) => {
  const have = await execIn(ctx, `command -v ${bin}`);
  if (have.code === 0) return { code: 0, out: `${bin} already installed: ${text(have)}\n` };
  return execIn(ctx, install);
} });

/** Pi, by platform (see the install route above). */
function piStep(platform) {
  const install = `npm install -g --ignore-scripts ${PI_PACKAGE}`;
  if (platform === "macos-arm64") {
    return { label: "pi: present, installed machine-wide by the admin account", fn: async (ctx) => {
      const have = await execIn(ctx, "command -v pi");
      if (have.code === 0) return { code: 0, out: `pi already installed: ${text(have)}\n` };
      return { code: 1, out: `pi is not installed. A standard account cannot install it: ask the admin account to run \`${install}\`, then run this part again.\n` };
    } };
  }
  return { label: `pi: ${install}, if missing (into the account's own npm prefix)`, fn: async (ctx) => {
    const have = await execIn(ctx, "command -v pi");
    if (have.code === 0) return { code: 0, out: `pi already installed: ${text(have)}\n` };
    const prefix = text(await execIn(ctx, "npm config get prefix"));
    if (!prefix.startsWith(`${ctx.env.HOME}/`)) return { code: 1, out: `npm's global prefix is ${prefix || "(unknown)"}, not under ${ctx.env.HOME}: installing Pi there needs root. Use nvm (scripts/e1-bootstrap.sh sets it up) or set a per-account prefix, then run this part again.\n` };
    return execIn(ctx, install);
  } };
}

/** The clone's `origin` must be the staging repository (an existing folder is reused only when it is). */
const sameRepo = (url, staging) => new RegExp(`(?:^|[/:@])github\\.com[/:]${esc(staging)}(?:\\.git)?/?$`, "i").test(url.trim());

export function prepareSteps(vars) {
  const { platform, clone, staging } = vars;
  if (!UNAME[platform]) throw new Error(`prepare needs --platform ${Object.keys(UNAME).join("|")}`);
  const nodeAtLeast24 = { describe: "Node 24 or later", match: (out) => (Number(/^v(\d+)\./m.exec(out)?.[1]) >= 24 ? { ok: true } : { ok: false, got: out.trim() || "(no output)" }) };
  return [
    { id: "P.1", title: "Platform, Node and git (run sheet 0.1, 0.2)", ...seq([
      { argv: ["uname", "-sm"], expects: [{ describe: `${platform}'s \`uname -sm\``, match: (out) => (UNAME[platform].test(out) ? { ok: true } : { ok: false, got: out.trim() }) }] },
      { argv: ["node", "--version"], expects: [nodeAtLeast24] },
      { argv: ["git", "--version"], expects: [{ match: /^git version /m }] },
      // The scrubbed copy needs exactly this gitleaks, and without it a run finds out only at its end, after the sign-ins.
      { label: `gitleaks ${GITLEAKS_VERSION} (the scrubbed copy needs it)`, fn: async (ctx) => {
        const r = await ctx.deps.exec("gitleaks", ["version"], { cwd: ctx.cwd, env: ctx.env });
        const out = asText(r).trim();
        return { code: 0, out: r.code === 0 && out === GITLEAKS_VERSION ? out : `${out || "gitleaks is not installed"} (exit ${r.code}). Run \`bash scripts/e1-bootstrap.sh\`: it installs gitleaks ${GITLEAKS_VERSION}.` };
      }, expects: [{ describe: `gitleaks ${GITLEAKS_VERSION}, installed by \`bash scripts/e1-bootstrap.sh\``, match: (out) => (out.trim() === GITLEAKS_VERSION ? { ok: true } : { ok: false, got: out.trim() }) }] },
    ]) },
    { id: "P.2", title: "Install Claude Code (pinned) and Pi when missing (run sheet 0.2)", ...seq([
      installIfMissing(`claude: curl -fsSL https://claude.ai/install.sh | bash -s ${CLAUDE_PIN}, if missing`, "claude", `curl -fsSL https://claude.ai/install.sh | bash -s ${CLAUDE_PIN}`),
      // Not Pi's install.sh: it runs Pi on its own bundled Node 22 (run sheet 0.2).
      piStep(platform),
    ]) },
    { id: "P.3", title: "Sign in to Claude Code and Pi (operator)",
      // Whether the sign-ins worked is the operator's to say, not the driver's to check (it never opens credential files).
      pause: { say: ["Do this in a new terminal tab: it loads the PATH the installers set up (`claude` is in ~/.local/bin; this tab is waiting for you).", "Do the sign-ins in that separate tab, not in this one: this tab is the driver's prompt.", "Sign in to Claude Code: run `claude`, sign in, then /exit.", "Sign in to Pi: run `pi`, sign in, then quit. Skip this if you started the run with --pass-env: Pi then reads its API key from that variable.", "Press Enter below only when Claude Code is signed in and Pi has its credentials (a saved sign-in, or the key you named with --pass-env; this does not check that Pi will use it)."] } },
    { id: "P.4", title: "Clone staging (run sheet 0.2)", ...seq([
      { label: `git clone https://github.com/${staging}.git ${clone}, if not cloned`, fn: async (ctx) => {
        if (!existsSync(join(clone, ".git"))) return ctx.deps.exec("git", ["clone", `https://github.com/${staging}.git`, clone], { cwd: ctx.cwd, env: ctx.env });
        const origin = await ctx.deps.exec("git", ["-C", clone, "remote", "get-url", "origin"], { cwd: ctx.cwd, env: ctx.env });
        if (origin.code !== 0 || !sameRepo(text(origin), staging)) return { code: 1, out: `${clone} exists but its origin is ${text(origin) || "(none)"}, not ${staging}: move it away or pass --clone\n` };
        return { code: 0, out: `${clone} is already a clone of ${staging}\n` };
      } },
      { label: "the clone holds .claude-plugin/marketplace.json", fn: () => (existsSync(join(clone, ".claude-plugin", "marketplace.json")) ? { code: 0, out: "marketplace.json present\n" } : { code: 1, out: "marketplace.json missing\n" }) },
    ]) },
    { id: "P.5", title: "Clean check (b) and versions (run sheet 0.4)", ...seq([
      { label: "find ~/.claude ~/.pi -maxdepth 3 (names only)", fn: (ctx) => listHome(ctx.env.HOME) },
      { label: "node ~/clean-b.mjs", fn: (ctx) => cleanB({ home: ctx.env.HOME }), expects: [{ match: /clean check \(b\): OK/ }] },
      { argv: ["claude", "--version"] }, { argv: ["pi", "--version"] },
      { argv: ["node", "--version"], expects: [nodeAtLeast24] }, { argv: ["git", "--version"] },
      { argv: ["bash", "-c", 'ls -l "$(command -v pi)"'], expects: [{ describe: "pi linked into npm's global node_modules", match: /node_modules/ }] },
      // The first recording of both host versions (and the floor), in the drill folder the later parts read.
      { label: "record the host versions", fn: async (ctx) => { await readHostVersions(ctx, "prepare"); return { code: 0, out: "recorded in the transcript\n" }; } },
    ]) },
  ];
}

export const parts = { prepare: prepareSteps, e1a: e1aSteps, e1b: { baseline: baselineSteps, undelivered: undeliveredSteps, promoted: promotedSteps, cycle: cycleSteps } };
