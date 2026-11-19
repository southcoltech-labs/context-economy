// SPDX-License-Identifier: Apache-2.0

// What the E1 driver's engine (e1-run.mjs) and its step data (e1-parts.mjs) both need: the stop error, the
// host names, the host-version record and the evidence shape. This module imports nothing from either of
// them, so the engine and the parts never import each other's code in a circle (a circle between an entry
// module that awaits and a module it imports at run time stops the driver silently, with no output).
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { MIN_HOST_VERSION, judgeVersion, meetsFloor } from "./e1-helpers.mjs";

export const HOSTS = ["claude", "pi"];

/** A failed assertion: the part stops. */
export class StopError extends Error {
  constructor({ step, expected, got }) {
    super(`${step}: expected ${expected}; got ${got}`);
    this.step = step; this.expected = expected; this.got = got;
  }
}

export const clip = (s, n = 600) => (String(s).length > n ? `${String(s).slice(0, n)}…` : String(s));
export const asText = (r) => r.out ?? [r.stdout, r.stderr].filter(Boolean).join("\n");

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
