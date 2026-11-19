// SPDX-License-Identifier: Apache-2.0

// Scrubber for the E1 driver's transcripts. It works on a complete text (never on stream chunks).
//
// Secrets come from one engine only: the `gitleaks` binary with the project's `.gitleaks.toml`
// (default rules), the same engine CI applies to the published tree. There is no fallback engine:
// the scrubbed copy is made only when gitleaks ran correctly, and it is proven clean by running
// gitleaks again on the result. Any failure means no scrubbed copy and a reason (`ok: false`):
//   - gitleaks missing, or not the pinned version;
//   - an exit code other than clean (0) or leaks found (1). Exit 1 also covers a bad config, so
//     it counts as "leaks found" only with a report that parses and holds findings;
//   - a missing report, or one that does not parse;
//   - the second pass over the scrubbed text finding anything.
// Each scan runs over the text and over a view with line breaks removed, so a token a terminal
// wrapped across lines is found too (the second pass uses both views as well).
//
// The gitleaks report holds the secret itself, and each scan copies the whole text. Both live in a 0700
// folder under `tmp` (the driver passes the attempt folder, private and as long-lived as the raw file),
// which is deleted after each scan. Only rule id and line number go on into the scrubbed transcript.
//
// The driver adds its own scrubs: the machine name (whole words, so `mac` leaves `macos-arm64`
// alone), the OS user's real home, e-mail addresses.
//
// Assertions never read the scrubbed text. `overlaps` tells whether an assertion's match falls
// inside a scrubbed span, so the run can report it.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The gitleaks version the driver accepts. CI pins the same one (`.github/workflows/ci.yml`); a test compares them. */
export const GITLEAKS_VERSION = "8.30.1";

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `text` without line breaks, and for each kept character its index in `text`. */
function unwrap(text) {
  let out = "";
  const map = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n" || text[i] === "\r") continue;
    out += text[i];
    map.push(i);
  }
  return { text: out, map };
}

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

/** `gitleaks version` must print exactly the pinned version. */
export function checkGitleaks({ bin = "gitleaks", run = spawnSync } = {}) {
  const r = run(bin, ["version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (r.error) return { ok: false, reason: `gitleaks is not installed (${r.error.code ?? r.error.message}); no scrubbed copy is written` };
  const got = String(r.stdout ?? "").trim();
  if (r.status !== 0 || got !== GITLEAKS_VERSION) {
    return { ok: false, reason: `gitleaks ${got || "(no version)"} is not the pinned ${GITLEAKS_VERSION}; no scrubbed copy is written` };
  }
  return { ok: true };
}

/**
 * One gitleaks scan of `text`. Returns `{ ok: true, findings }` (each `{ rule, secret, startLine,
 * endLine, startColumn, endColumn }`), or `{ ok: false, reason }`.
 */
export function scan(text, { bin = "gitleaks", config, run = spawnSync, tmp = tmpdir() } = {}) {
  let dir;
  try {
    dir = mkdtempSync(join(tmp, "e1-gitleaks-"));
    chmodSync(dir, 0o700);
    const input = join(dir, "input.txt");
    const report = join(dir, "report.json");
    writeFileSync(input, text, { mode: 0o600 });
    const args = ["dir", "--no-banner", "--log-level", "error", "--report-format", "json", "--report-path", report];
    if (config) args.push("--config", config);
    args.push(input);
    const r = run(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (r.error) return { ok: false, reason: `gitleaks could not run (${r.error.code ?? r.error.message})` };
    if (r.status !== 0 && r.status !== 1) return { ok: false, reason: `gitleaks exited ${r.status}` };
    if (!existsSync(report)) return { ok: false, reason: `gitleaks exited ${r.status} and wrote no report` };
    let parsed;
    try { parsed = JSON.parse(readFileSync(report, "utf8")); } catch { return { ok: false, reason: "gitleaks wrote a report that is not JSON" }; }
    if (!Array.isArray(parsed)) return { ok: false, reason: "gitleaks wrote a report that is not a list" };
    if (r.status === 0 && parsed.length) return { ok: false, reason: "gitleaks exited 0 with findings in its report" };
    if (r.status === 1 && parsed.length === 0) return { ok: false, reason: "gitleaks exited 1 with no findings (a bad config exits 1 too)" };
    return {
      ok: true,
      findings: parsed.map((f) => ({
        rule: String(f.RuleID ?? "unknown"), secret: typeof f.Secret === "string" ? f.Secret : "",
        startLine: f.StartLine, endLine: f.EndLine, startColumn: f.StartColumn, endColumn: f.EndColumn,
      })),
    };
  } catch (e) {
    return { ok: false, reason: `gitleaks scan failed (${e.message})` };
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Spans of `view` for gitleaks findings: every occurrence of the finding's secret, and the
 * reported line and columns, widened by one column each side (columns differ by one between
 * rules). The second pass is what proves the spans were enough.
 */
function findingSpans(view, findings) {
  const starts = lineStarts(view);
  const spans = [];
  // gitleaks counts columns in bytes; the view is indexed in characters (E6).
  const charCol = (line, byteCol) => {
    const from = starts[line - 1] ?? 0;
    const bytes = Buffer.from(view.slice(from, from + Math.max(byteCol, 0) * 4 + 8), "utf8");
    return from + bytes.subarray(0, Math.max(byteCol, 0)).toString("utf8").length;
  };
  for (const f of findings) {
    const rule = `gitleaks:${f.rule}`;
    let found = false;
    if (f.secret) for (let at = view.indexOf(f.secret); at >= 0; at = view.indexOf(f.secret, at + 1)) { spans.push({ rule, start: at, end: at + f.secret.length }); found = true; }
    if (found) continue; // the secret's own occurrences are exact; line and column only when the report gives none
    const start = Math.max(0, charCol(f.startLine, f.startColumn - 1) - 1);
    const end = Math.min(view.length, charCol(f.endLine, f.endColumn) + 1);
    if (end > start) spans.push({ rule, start, end });
  }
  return spans;
}

function mergeSpans(spans) {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  for (const s of sorted) {
    const last = out.at(-1);
    if (last && s.start <= last.end) {
      last.end = Math.max(last.end, s.end);
      for (const r of s.rules ?? [s.rule]) if (!last.rules.includes(r)) last.rules.push(r);
      if (!s.replacement) last.replacement = undefined; // E11: a merge with a secret or e-mail span shows [scrubbed:…]
    } else out.push({ start: s.start, end: s.end, rules: [...(s.rules ?? [s.rule])], replacement: s.replacement });
  }
  return out;
}

/**
 * Scrubs a complete text. `options`: `config` (the project's `.gitleaks.toml`), `bin`, `run`
 * (a spawnSync stand-in, for tests), `hostname` and `label` (what replaces the machine name),
 * `realHome` (the OS user's own home, `os.userInfo().homedir`), `tmp`, and `secrets` (name to value: credentials the
 * operator handed to a host with `--pass-env`; gitleaks cannot know an arbitrary value, so each exact occurrence is
 * replaced by `[scrubbed:pass-env NAME]`, and a copy that still holds one is withheld).
 * Returns `{ ok: true, text, hits, spans }` (a hit is `{ rule, line }`, never a value), or
 * `{ ok: false, reason }` with no text: the caller writes no scrubbed copy.
 */
export function scrub(raw, options = {}) {
  const { config, bin, run, tmp = tmpdir(), hostname, label = "host", realHome, secrets = {} } = options;
  const secretValues = Object.entries(secrets).filter(([, v]) => typeof v === "string" && v.length > 0);
  const gl = { bin, config, run, tmp };
  const probe = checkGitleaks({ bin, run });
  if (!probe.ok) return probe;

  const un = unwrap(raw);
  const spans = [];
  const first = scan(raw, gl);
  if (!first.ok) return first;
  spans.push(...findingSpans(raw, first.findings));
  const wrapped = scan(un.text, gl);
  if (!wrapped.ok) return wrapped;
  for (const s of findingSpans(un.text, wrapped.findings)) spans.push({ ...s, start: un.map[s.start], end: un.map[Math.min(s.end, un.map.length) - 1] + 1 });

  for (const m of raw.matchAll(EMAIL)) {
    if (/^git@/i.test(m[0])) continue;
    spans.push({ rule: "email", start: m.index, end: m.index + m[0].length });
  }
  const names = [hostname, hostname?.split(".")[0]].filter((n) => n && n.length >= 2);
  for (const name of new Set(names)) {
    for (const m of raw.matchAll(new RegExp(`(?<![A-Za-z0-9-])${escapeRe(name)}(?![A-Za-z0-9-])`, "gi"))) {
      spans.push({ rule: "machine-name", start: m.index, end: m.index + m[0].length, replacement: label });
    }
  }
  if (realHome && realHome.length > 1) {
    for (const m of raw.matchAll(new RegExp(`${escapeRe(realHome)}(?![A-Za-z0-9_.-])`, "g"))) {
      spans.push({ rule: "real-home", start: m.index, end: m.index + m[0].length });
    }
  }

  for (const [name, value] of secretValues) {
    for (const m of raw.matchAll(new RegExp(escapeRe(value), "g"))) spans.push({ rule: `pass-env ${name}`, start: m.index, end: m.index + m[0].length });
    // The value split by the transcript's own line wrapping: found in the unwrapped view, mapped back.
    for (const m of un.text.matchAll(new RegExp(escapeRe(value), "g"))) spans.push({ rule: `pass-env ${name}`, start: un.map[m.index], end: un.map[m.index + m[0].length - 1] + 1 });
  }

  const merged = mergeSpans(spans);
  const starts = lineStarts(raw);
  const lineOf = (offset) => starts.findLastIndex((s) => s <= offset) + 1;
  let text = "";
  let at = 0;
  const hits = [];
  for (const s of merged) {
    text += raw.slice(at, s.start) + (s.replacement ?? `[scrubbed:${s.rules.join("+")}]`);
    at = s.end;
    hits.push({ rule: s.rules.join("+"), line: lineOf(s.start) });
  }
  text += raw.slice(at);

  // Second pass: the result must come back clean, in both views, whatever the spans were.
  for (const view of [text, unwrap(text).text]) {
    const again = scan(view, gl);
    if (!again.ok) return { ok: false, reason: `second pass failed: ${again.reason}` };
    if (again.findings.length) return { ok: false, reason: `second pass found ${again.findings.length} finding(s) the scrub left in place; scrubbed copy deleted` };
  }
  for (const [name, value] of secretValues) {
    if (text.includes(value) || unwrap(text).text.includes(value)) return { ok: false, reason: `the value of ${name} is still in the scrubbed text; scrubbed copy deleted` };
  }
  return { ok: true, text, hits, spans: merged.map(({ start, end }) => ({ start, end })) };
}

/** Whether `[start, end)` touches a scrubbed span. */
export const overlaps = (spans, start, end) => spans.some((s) => start < s.end && end > s.start);

/** The hit list for the end of a scrubbed transcript: rule id and line only, never a value. */
export function hitsReport(hits, notes = []) {
  const lines = [`scrub engine: gitleaks ${GITLEAKS_VERSION} with .gitleaks.toml, second pass clean`, `scrub hits: ${hits.length}`];
  for (const h of hits) lines.push(`  line ${h.line}: ${h.rule}`);
  return [...lines, ...notes].join("\n");
}
